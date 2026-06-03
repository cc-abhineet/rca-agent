import json
import logging
import os
import queue
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from rca_agent.config import settings
from rca_agent.db import execute, execute_one, json_loads, get_conn, create_token_usage_table
from rca_agent.adapters.observability.local_db import LocalDBAdapter
from rca_agent.adapters.cicd.mock_adapter import MockCICDAdapter
from rca_agent.agent import RCAAgent
from rca_agent.report_renderer import render_rca_html
from rca_agent.token_pricing import display_name as model_display_name
from rca_agent.overlay import invalidate as invalidate_overlay_cache

logger = logging.getLogger("rca-agent")

obs_adapter = LocalDBAdapter()
cicd_adapter = MockCICDAdapter()
agent = RCAAgent(obs_adapter=obs_adapter, cicd_adapter=cicd_adapter)

# ── Pub-sub for SSE streams ───────────────────────────────────────────────────
# Keyed by error_log_id. Allows multiple browser tabs / reconnects to subscribe
# to the same running agent without starting a duplicate agent thread.
_active_jobs: dict = {}   # error_log_id -> {"queues": [Queue, ...], "done": bool}
_active_jobs_lock = threading.Lock()


def _job_broadcast(error_log_id: str, event: dict) -> None:
    """Deliver an event to every subscriber queue for this job."""
    with _active_jobs_lock:
        job = _active_jobs.get(error_log_id)
        if not job:
            return
        dead = []
        for q in job["queues"]:
            try:
                q.put_nowait(event)
            except Exception:
                dead.append(q)
        for q in dead:
            try:
                job["queues"].remove(q)
            except ValueError:
                pass


def _job_finish(error_log_id: str) -> None:
    """Signal all subscribers that the job is done (sends sentinel None)."""
    with _active_jobs_lock:
        job = _active_jobs.get(error_log_id)
        if not job:
            return
        job["done"] = True
        for q in job["queues"]:
            try:
                q.put_nowait(None)
            except Exception:
                pass

# Apollo settings override file
_APOLLO_SETTINGS_PATH = Path("/app/apollo_settings.json")

# In-memory settings overlay (loaded from file on startup)
_settings_overlay: dict = {}


def _load_settings_overlay() -> None:
    """Load settings overrides from apollo_settings.json if it exists."""
    global _settings_overlay
    path = _apollo_settings_file()
    if path.exists():
        try:
            _settings_overlay = json.loads(path.read_text())
        except Exception:
            _settings_overlay = {}


def _apollo_settings_file() -> Path:
    """Return the path to the apollo_settings.json file (Docker or local dev)."""
    if _APOLLO_SETTINGS_PATH.parent.exists():
        return _APOLLO_SETTINGS_PATH
    # Fallback for local dev: store next to pyproject.toml
    return Path(__file__).parent.parent / "apollo_settings.json"


def _get_overlay(key: str, default=None):
    return _settings_overlay.get(key, default)


def _effective_agent_settings() -> dict:
    """Return the runtime-effective values that must be passed to agent.run().
    Merges the user's Settings-UI overlay on top of env defaults."""
    raw_iters = _get_overlay("max_react_iterations") or settings.max_react_iterations
    try:
        max_iters = int(raw_iters)
    except (TypeError, ValueError):
        logger.warning("Invalid max_react_iterations value %r — using env default", raw_iters)
        max_iters = settings.max_react_iterations
    return {
        "api_key":        _get_overlay("anthropic_api_key") or settings.anthropic_api_key,
        "model":          _get_overlay("model")             or settings.model,
        "max_iterations": max_iters,
    }


_load_settings_overlay()

# Ensure token_usage table exists at startup (idempotent)
try:
    create_token_usage_table()
except Exception:
    pass

app = FastAPI(
    title="rca-agent",
    description="AI-powered Root Cause Analysis API",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model":                 _get_overlay("model")        or settings.model,
        "github_org":            _get_overlay("github_org")   or settings.github_org,
        "observability_adapter": _get_overlay("observability_adapter") or settings.observability_adapter,
        "cicd_adapter":          _get_overlay("cicd_adapter") or settings.cicd_adapter,
    }


# ── Run RCA ───────────────────────────────────────────────────────────────────

class RunRCARequest(BaseModel):
    error_log_id: str


@app.post("/rca/run")
def run_rca(req: RunRCARequest):
    execute(
        "UPDATE error_logs SET rca_status='in_progress', rca_started_at=NOW() WHERE id=%s",
        (req.error_log_id,),
    )
    try:
        report = agent.run(req.error_log_id, **_effective_agent_settings())
        execute(
            """UPDATE error_logs
               SET rca_status='completed', rca_completed_at=NOW(), rca_result=%s
               WHERE id=%s""",
            (json.dumps(report.model_dump()), req.error_log_id),
        )
        return report.model_dump()
    except Exception as e:
        execute(
            "UPDATE error_logs SET rca_status='failed', rca_error=%s WHERE id=%s",
            (str(e), req.error_log_id),
        )
        raise HTTPException(status_code=500, detail=str(e))


# ── SSE Streaming RCA ─────────────────────────────────────────────────────────

class StreamRCARequest(BaseModel):
    error_log_id: str


@app.post("/rca/run/stream")
def run_rca_stream(req: StreamRCARequest):
    """
    Run the RCA agent and stream trace events as Server-Sent Events.
    Each event is: data: <json>\\n\\n
    On completion: data: {"type": "done", "report": <full_rca_json>}\\n\\n
    """
    event_queue: queue.Queue = queue.Queue()

    def trace_callback(event: dict) -> None:
        event_queue.put(event)

    def agent_thread():
        try:
            execute(
                "UPDATE error_logs SET rca_status='in_progress', rca_started_at=NOW() WHERE id=%s",
                (req.error_log_id,),
            )
            eff = _effective_agent_settings()
            report = agent.run(req.error_log_id, trace_callback=trace_callback, **eff)
            execute(
                """UPDATE error_logs
                   SET rca_status='completed', rca_completed_at=NOW(), rca_result=%s
                   WHERE id=%s""",
                (json.dumps(report.model_dump()), req.error_log_id),
            )
            event_queue.put({
                "type": "done",
                "report": report.model_dump(),
                "ts": datetime.now(timezone.utc).isoformat(),
            })
        except Exception as exc:
            execute(
                "UPDATE error_logs SET rca_status='failed', rca_error=%s WHERE id=%s",
                (str(exc), req.error_log_id),
            )
            event_queue.put({
                "type": "error",
                "message": str(exc),
                "ts": datetime.now(timezone.utc).isoformat(),
            })
        finally:
            event_queue.put(None)

    thread = threading.Thread(target=agent_thread, daemon=True)
    thread.start()

    def sse_generator():
        while True:
            try:
                event = event_queue.get(timeout=120)
            except queue.Empty:
                yield "data: {\"type\": \"error\", \"message\": \"Timed out waiting for agent\"}\n\n"
                break
            if event is None:
                break
            yield f"data: {json.dumps(event, default=str)}\n\n"

    return StreamingResponse(
        sse_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ── HTML RCA Report ──────────────────────────────────────────────────────────

@app.get("/rca/{error_log_id}/report", response_class=HTMLResponse)
def get_rca_report(error_log_id: str):
    """Return a human-readable HTML RCA report."""
    row = execute_one(
        "SELECT rca_result, rca_status FROM error_logs WHERE id = %s",
        (error_log_id,)
    )
    if not row:
        raise HTTPException(status_code=404, detail="Error log not found")
    if row["rca_status"] != "completed" or not row["rca_result"]:
        return HTMLResponse(
            content=f"<html><body><h2>RCA {row['rca_status']}</h2><p>No report available yet.</p></body></html>",
            status_code=202,
        )
    report_dict = json_loads(row["rca_result"])
    return HTMLResponse(content=render_rca_html(report_dict))


# ── Demo UI ──────────────────────────────────────────────────────────────────

@app.get("/demo", response_class=HTMLResponse)
def demo_ui():
    """Serve the self-contained demo UI."""
    demo_path = Path(__file__).parent / "demo_ui.html"
    if not demo_path.exists():
        raise HTTPException(status_code=404, detail="demo_ui.html not found")
    return HTMLResponse(content=demo_path.read_text())


@app.get("/demo/scenarios")
def demo_scenarios():
    """Return all error log IDs for the demo dropdown (all statuses)."""
    rows = execute(
        """SELECT id, service_name, error_type, occurred_at, rca_status
           FROM error_logs
           ORDER BY occurred_at DESC
           LIMIT 100"""
    )
    scenarios = {}
    for row in rows:
        svc = row["service_name"]
        err = row.get("error_type") or "UnknownError"
        ts = str(row["occurred_at"])[:16]
        status = (row.get("rca_status") or "pending").upper()
        label = f"[{status}] {svc} — {err} ({ts})"
        scenarios[label] = str(row["id"])
    return {"scenarios": scenarios}


@app.get("/demo/errors")
def demo_errors():
    """Return all recent errors for the live error dashboard."""
    rows = execute(
        """SELECT id, service_name, error_type, severity, rca_status,
                  occurred_at, rca_completed_at, rca_error
           FROM error_logs
           ORDER BY occurred_at DESC
           LIMIT 100"""
    )
    result = []
    for row in rows:
        result.append({
            "id":              str(row["id"]),
            "service_name":    row["service_name"],
            "error_type":      row.get("error_type") or "UnknownError",
            "severity":        row.get("severity") or "ERROR",
            "rca_status":      row.get("rca_status") or "pending",
            "occurred_at":     str(row["occurred_at"])[:19] if row.get("occurred_at") else "",
            "rca_completed_at":str(row["rca_completed_at"])[:19] if row.get("rca_completed_at") else "",
            "rca_error":       (row.get("rca_error") or "")[:200],
        })
    return {"errors": result}


# ═══════════════════════════════════════════════════════════════════════════════
# Apollo API routes — /api prefix
# ═══════════════════════════════════════════════════════════════════════════════

@app.get("/api/stats")
def api_stats():
    """Aggregate counts for the Apollo dashboard stats bar."""
    rows = execute(
        """SELECT
               COUNT(*) AS total,
               SUM(rca_status = 'pending')     AS pending,
               SUM(rca_status = 'in_progress') AS in_progress,
               SUM(rca_status = 'completed')   AS completed,
               SUM(rca_status = 'failed')      AS failed,
               SUM(LOWER(COALESCE(severity, risk_level, '')) = 'critical') AS critical,
               SUM(LOWER(COALESCE(severity, risk_level, '')) = 'high')     AS high,
               SUM(LOWER(COALESCE(severity, risk_level, '')) = 'medium')   AS medium,
               SUM(LOWER(COALESCE(severity, risk_level, '')) = 'low')      AS low
           FROM error_logs"""
    )
    if not rows:
        return {"total": 0, "pending": 0, "in_progress": 0, "completed": 0,
                "failed": 0, "critical": 0, "high": 0, "medium": 0, "low": 0}
    r = rows[0]
    return {k: int(v or 0) for k, v in r.items()}


@app.get("/api/logs")
def api_logs(
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=200),
    service: str = Query(""),
    severity: str = Query(""),
    risk_level: str = Query(""),
    status: str = Query(""),
):
    """Paginated error_logs with optional filters."""
    conditions = []
    params = []
    if service:
        conditions.append("service_name = %s")
        params.append(service)
    if severity:
        conditions.append("LOWER(severity) = %s")
        params.append(severity.lower())
    if risk_level:
        conditions.append("LOWER(risk_level) = %s")
        params.append(risk_level.lower())
    if status:
        conditions.append("rca_status = %s")
        params.append(status)

    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    offset = (page - 1) * limit

    count_rows = execute(f"SELECT COUNT(*) AS cnt FROM error_logs {where}", params or None)
    total = int((count_rows[0]["cnt"] if count_rows else 0) or 0)

    rows = execute(
        f"""SELECT id, service_name, environment, error_type, error_message,
                   stack_trace, severity, occurred_at, metadata, rca_status,
                   rca_started_at, rca_completed_at, rca_result, rca_error,
                   gemini_category, gemini_analysis, gemini_suggestions, risk_level
            FROM error_logs {where}
            ORDER BY occurred_at DESC
            LIMIT %s OFFSET %s""",
        (params + [limit, offset]) or [limit, offset],
    )

    items = []
    for row in rows:
        items.append({
            "id": str(row["id"]),
            "service_name": row.get("service_name") or "",
            "environment": row.get("environment") or "",
            "error_type": row.get("error_type") or "UnknownError",
            "error_message": row.get("error_message") or "",
            "stack_trace": json_loads(row.get("stack_trace")) or [],
            "severity": row.get("severity") or "ERROR",
            "occurred_at": str(row["occurred_at"])[:19] if row.get("occurred_at") else "",
            "metadata": json_loads(row.get("metadata")) or {},
            "rca_status": row.get("rca_status") or "pending",
            "rca_started_at": str(row["rca_started_at"])[:19] if row.get("rca_started_at") else None,
            "rca_completed_at": str(row["rca_completed_at"])[:19] if row.get("rca_completed_at") else None,
            "rca_result": json_loads(row.get("rca_result")),
            "rca_error": row.get("rca_error") or "",
            "gemini_category": row.get("gemini_category") or "",
            "gemini_analysis": row.get("gemini_analysis") or "",
            "gemini_suggestions": row.get("gemini_suggestions") or "",
            "risk_level": row.get("risk_level") or "",
        })

    return {
        "items": items,
        "total": total,
        "page": page,
        "limit": limit,
        "pages": max(1, (total + limit - 1) // limit),
    }


@app.get("/api/logs/{log_id}")
def api_log_detail(log_id: str):
    """Full single error_log row."""
    row = execute_one(
        """SELECT id, service_name, environment, error_type, error_message,
                  stack_trace, severity, occurred_at, metadata, rca_status,
                  rca_started_at, rca_completed_at, rca_result, rca_error,
                  gemini_category, gemini_analysis, gemini_suggestions, risk_level
           FROM error_logs WHERE id = %s""",
        (log_id,),
    )
    if not row:
        raise HTTPException(status_code=404, detail="Log not found")
    return {
        "id": str(row["id"]),
        "service_name": row.get("service_name") or "",
        "environment": row.get("environment") or "",
        "error_type": row.get("error_type") or "UnknownError",
        "error_message": row.get("error_message") or "",
        "stack_trace": json_loads(row.get("stack_trace")) or [],
        "severity": row.get("severity") or "ERROR",
        "occurred_at": str(row["occurred_at"])[:19] if row.get("occurred_at") else "",
        "metadata": json_loads(row.get("metadata")) or {},
        "rca_status": row.get("rca_status") or "pending",
        "rca_started_at": str(row["rca_started_at"])[:19] if row.get("rca_started_at") else None,
        "rca_completed_at": str(row["rca_completed_at"])[:19] if row.get("rca_completed_at") else None,
        "rca_result": json_loads(row.get("rca_result")),
        "rca_error": row.get("rca_error") or "",
        "gemini_category": row.get("gemini_category") or "",
        "gemini_analysis": row.get("gemini_analysis") or "",
        "gemini_suggestions": row.get("gemini_suggestions") or "",
        "risk_level": row.get("risk_level") or "",
    }


def _mask(value: str, show_last: int = 4) -> str:
    """Mask a secret, showing only the last N chars."""
    if not value:
        return ""
    if len(value) <= show_last:
        return "****"
    return "****" + value[-show_last:]


@app.get("/api/settings")
def api_get_settings():
    """Return current runtime settings (env + overlay file). Secrets are masked."""
    db_url = _get_overlay("database_url") or settings.database_url
    # Mask password in DB URL
    masked_db = db_url
    try:
        from urllib.parse import urlparse, urlunparse
        parsed = urlparse(db_url)
        if parsed.password:
            masked_db = db_url.replace(parsed.password, "****")
    except Exception:
        pass

    return {
        "anthropic_api_key": _mask(_get_overlay("anthropic_api_key") or settings.anthropic_api_key),
        "github_pat": _mask(_get_overlay("github_pat") or settings.github_pat),
        "github_org": _get_overlay("github_org") or settings.github_org,
        "model": _get_overlay("model") or settings.model,
        "max_react_iterations": int(_get_overlay("max_react_iterations") or settings.max_react_iterations),
        "dd_api_key": _mask(_get_overlay("dd_api_key") or os.environ.get("DD_API_KEY", "")),
        "dd_app_key": _mask(_get_overlay("dd_app_key") or os.environ.get("DD_APP_KEY", "")),
        "dd_site": _get_overlay("dd_site") or os.environ.get("DD_SITE", "us5.datadoghq.com"),
        "observability_adapter": _get_overlay("observability_adapter") or settings.observability_adapter,
        "cicd_adapter": _get_overlay("cicd_adapter") or settings.cicd_adapter,
        "database_url": masked_db,
    }


class SettingsUpdate(BaseModel):
    anthropic_api_key: Optional[str] = None
    github_pat: Optional[str] = None
    github_org: Optional[str] = None
    model: Optional[str] = None
    max_react_iterations: Optional[int] = None
    dd_api_key: Optional[str] = None
    dd_app_key: Optional[str] = None
    dd_site: Optional[str] = None
    observability_adapter: Optional[str] = None
    cicd_adapter: Optional[str] = None
    database_url: Optional[str] = None


@app.post("/api/settings")
def api_post_settings(body: SettingsUpdate):
    """Save settings overrides to apollo_settings.json and update in-memory state."""
    global _settings_overlay
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    _settings_overlay.update(updates)
    settings_file = _apollo_settings_file()
    settings_file.parent.mkdir(parents=True, exist_ok=True)
    settings_file.write_text(json.dumps(_settings_overlay, indent=2))
    invalidate_overlay_cache()   # force next DB/github/resolver call to re-read the file
    return {"status": "saved", "keys": list(updates.keys())}


# ── Credential validation ─────────────────────────────────────────────────────

class CredentialTestRequest(BaseModel):
    key_type: str           # 'anthropic' | 'github' | 'datadog'
    api_key:  Optional[str] = None   # key to test; falls back to current effective value
    app_key:  Optional[str] = None   # Datadog app key
    org:      Optional[str] = None   # GitHub org (for context, not validated)


@app.post("/api/settings/test")
async def api_test_credential(body: CredentialTestRequest):
    """
    Test a credential without saving it.
    Returns {valid: bool, message: str}.
    """
    key_type = body.key_type

    # ── Anthropic ────────────────────────────────────────────────────────────
    if key_type == "anthropic":
        import anthropic as _anthropic
        api_key = body.api_key or _get_overlay("anthropic_api_key") or settings.anthropic_api_key
        if not api_key:
            return {"valid": False, "message": "No Anthropic API key configured."}
        try:
            client = _anthropic.Anthropic(api_key=api_key)
            client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=1,
                messages=[{"role": "user", "content": "ping"}],
            )
            return {"valid": True, "message": "Anthropic API key is valid ✓"}
        except _anthropic.AuthenticationError:
            return {"valid": False, "message": "Invalid Anthropic API key. Check it at console.anthropic.com → API Keys."}
        except _anthropic.PermissionDeniedError:
            return {"valid": False, "message": "Anthropic key lacks permission. Verify scopes at console.anthropic.com."}
        except _anthropic.RateLimitError:
            return {"valid": True, "message": "Key is valid but rate-limited — you've hit your usage cap. Increase it at console.anthropic.com → Billing → Limits."}
        except _anthropic.BadRequestError as e:
            msg = str(e)
            if "usage limits" in msg.lower() or "regain access" in msg.lower():
                return {"valid": True, "message": "Key is valid but monthly usage limit reached. Increase it at console.anthropic.com → Billing → Limits."}
            return {"valid": False, "message": f"Anthropic error: {msg}"}
        except Exception as e:
            return {"valid": False, "message": f"Could not reach Anthropic: {e}"}

    # ── GitHub ───────────────────────────────────────────────────────────────
    elif key_type == "github":
        from github import Github, GithubException
        pat = body.api_key or _get_overlay("github_pat") or settings.github_pat
        if not pat:
            return {"valid": False, "message": "No GitHub PAT configured."}
        try:
            gh = Github(pat)
            user = gh.get_user()
            login = user.login   # triggers actual API call
            rate = gh.get_rate_limit().core
            return {"valid": True, "message": f"GitHub PAT valid — authenticated as @{login} (API: {rate.remaining}/{rate.limit} remaining) ✓"}
        except GithubException as e:
            if e.status == 401:
                return {"valid": False, "message": "Invalid or expired GitHub PAT. Generate a new one at github.com/settings/tokens."}
            if e.status == 403:
                return {"valid": False, "message": "GitHub PAT lacks required permissions. Ensure it has repo:read scope."}
            return {"valid": False, "message": f"GitHub API error {e.status}: {e.data.get('message', str(e))}"}
        except Exception as e:
            return {"valid": False, "message": f"Could not reach GitHub: {e}"}

    # ── Datadog ──────────────────────────────────────────────────────────────
    elif key_type == "datadog":
        dd_api_key = body.api_key or _get_overlay("dd_api_key") or os.environ.get("DD_API_KEY", "")
        dd_app_key = body.app_key or _get_overlay("dd_app_key") or os.environ.get("DD_APP_KEY", "")
        dd_site    = _get_overlay("dd_site") or os.environ.get("DD_SITE", "us5.datadoghq.com")
        if not dd_api_key:
            return {"valid": False, "message": "No Datadog API key configured."}
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                # /api/v1/validate is purpose-built for key validation, free to call
                resp = await client.get(
                    f"https://api.{dd_site}/api/v1/validate",
                    headers={"DD-API-KEY": dd_api_key},
                )
            if resp.status_code == 200:
                # Also test app key if provided
                if dd_app_key:
                    async with httpx.AsyncClient(timeout=10.0) as client2:
                        resp2 = await client2.get(
                            f"https://api.{dd_site}/api/v1/validate",
                            headers={"DD-API-KEY": dd_api_key, "DD-APPLICATION-KEY": dd_app_key},
                        )
                    if resp2.status_code != 200:
                        return {"valid": False, "message": "API key is valid but Application key is invalid. Check it at app.datadoghq.com → Organization Settings → Application Keys."}
                return {"valid": True, "message": f"Datadog credentials valid (site: {dd_site}) ✓"}
            elif resp.status_code == 403:
                return {"valid": False, "message": "Invalid Datadog API key. Check it at app.datadoghq.com → Organization Settings → API Keys."}
            else:
                return {"valid": False, "message": f"Datadog returned HTTP {resp.status_code}. Check your site setting ({dd_site})."}
        except Exception as e:
            return {"valid": False, "message": f"Could not reach Datadog ({dd_site}): {e}"}

    return {"valid": False, "message": f"Unknown key_type: {key_type}"}


@app.get("/api/datadog/logs")
async def api_datadog_logs(limit: int = Query(50, ge=1, le=500)):
    """Query Datadog Logs API and return normalized events."""
    dd_api_key = _get_overlay("dd_api_key") or os.environ.get("DD_API_KEY", "")
    dd_app_key = _get_overlay("dd_app_key") or os.environ.get("DD_APP_KEY", "")
    dd_site = _get_overlay("dd_site") or os.environ.get("DD_SITE", "us5.datadoghq.com")

    if not dd_api_key or not dd_app_key:
        raise HTTPException(status_code=422, detail="Datadog credentials not configured. Set dd_api_key and dd_app_key in Settings.")

    url = f"https://api.{dd_site}/api/v2/logs/events/search"
    payload = {
        "filter": {
            "query": "status:(error OR warn)",
            "from": "now-1h",
            "to": "now",
        },
        "page": {"limit": limit},
        "sort": "-timestamp",
    }
    headers = {
        "DD-API-KEY": dd_api_key,
        "DD-APPLICATION-KEY": dd_app_key,
        "Content-Type": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(url, json=payload, headers=headers)
        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code, detail=f"Datadog API error: {resp.text[:300]}")
        data = resp.json()
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=f"Failed to reach Datadog: {e}")

    events = data.get("data", [])
    normalized = []
    for ev in events:
        attrs = ev.get("attributes", {})
        # tags is a list ["service:banking-app", "env:dev"] — extract service tag
        tags: list = attrs.get("tags") or []
        svc = attrs.get("service") or next(
            (t.split(":", 1)[1] for t in tags if isinstance(t, str) and t.startswith("service:")),
            "unknown",
        )
        normalized.append({
            "id": ev.get("id", ""),
            "service": svc,
            "timestamp": attrs.get("timestamp", ""),
            "level": attrs.get("status", "error"),
            "message": attrs.get("message", "")[:500],
            "source": attrs.get("source", "datadog"),
        })
    return {"items": normalized, "total": len(normalized)}


# ── Ingestion source control ──────────────────────────────────────────────────
# Proxies to the ingestion-agent control server (port 8001, internal network).

_INGESTION_AGENT_URL = "http://ingestion-agent:8001"


@app.get("/api/source")
async def api_get_source():
    """Return the current ingestion source (local | datadog)."""
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(f"{_INGESTION_AGENT_URL}/source")
            return resp.json()
    except Exception:
        return {"source": "local", "error": "ingestion-agent unreachable"}


class SourceRequest(BaseModel):
    source: str  # "local" | "datadog"


@app.post("/api/source")
async def api_set_source(req: SourceRequest):
    """Switch ingestion agent source, forwarding effective DD credentials."""
    # Always forward the effective DD creds so the ingestion agent uses the
    # Settings-UI values rather than only its own env vars.
    payload = {
        "source":     req.source,
        "dd_api_key": _get_overlay("dd_api_key") or os.environ.get("DD_API_KEY", ""),
        "dd_app_key": _get_overlay("dd_app_key") or os.environ.get("DD_APP_KEY", ""),
        "dd_site":    _get_overlay("dd_site")    or os.environ.get("DD_SITE", "us5.datadoghq.com"),
    }
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(f"{_INGESTION_AGENT_URL}/source", json=payload)
            return resp.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"ingestion-agent unreachable: {exc}")


# ── Monitoring control ────────────────────────────────────────────────────────

class MonitoringRequest(BaseModel):
    action: str  # "stop" | "start"


@app.get("/api/monitoring")
async def api_get_monitoring():
    """Return current monitoring state from the ingestion agent."""
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(f"{_INGESTION_AGENT_URL}/source")
            return resp.json()
    except Exception:
        return {"monitoring_active": True, "source": "local", "error": "ingestion-agent unreachable"}


@app.post("/api/monitoring")
async def api_set_monitoring(req: MonitoringRequest):
    """Stop or start monitoring, forwarding effective DD credentials on start."""
    payload: dict = {"action": req.action}
    if req.action == "start":
        payload["dd_api_key"] = _get_overlay("dd_api_key") or os.environ.get("DD_API_KEY", "")
        payload["dd_app_key"] = _get_overlay("dd_app_key") or os.environ.get("DD_APP_KEY", "")
        payload["dd_site"]    = _get_overlay("dd_site")    or os.environ.get("DD_SITE", "us5.datadoghq.com")
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(f"{_INGESTION_AGENT_URL}/monitoring", json=payload)
            return resp.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"ingestion-agent unreachable: {exc}")


# ── RCA cancel ────────────────────────────────────────────────────────────────

@app.post("/api/rca/cancel/{error_log_id}")
def api_cancel_rca(error_log_id: str):
    """Mark an in-progress RCA as cancelled (client-side stream should also be closed)."""
    execute(
        """UPDATE error_logs
           SET rca_status = 'failed', rca_error = 'Cancelled by user'
           WHERE id = %s AND rca_status = 'in_progress'""",
        (error_log_id,),
    )
    return {"status": "cancelled", "error_log_id": error_log_id}


# ── RCA trigger ───────────────────────────────────────────────────────────────

class TriggerRCARequest(BaseModel):
    error_log_id: str


@app.post("/api/rca/trigger")
def api_trigger_rca(req: TriggerRCARequest):
    """Alias for /rca/run — returns {job_id, status}."""
    execute(
        "UPDATE error_logs SET rca_status='in_progress', rca_started_at=NOW() WHERE id=%s",
        (req.error_log_id,),
    )
    try:
        report = agent.run(req.error_log_id, **_effective_agent_settings())
        execute(
            """UPDATE error_logs
               SET rca_status='completed', rca_completed_at=NOW(), rca_result=%s
               WHERE id=%s""",
            (json.dumps(report.model_dump()), req.error_log_id),
        )
        return {"job_id": req.error_log_id, "status": "completed", "report": report.model_dump()}
    except Exception as e:
        execute(
            "UPDATE error_logs SET rca_status='failed', rca_error=%s WHERE id=%s",
            (str(e), req.error_log_id),
        )
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/rca/stream/{error_log_id}")
def api_rca_stream(error_log_id: str):
    """
    SSE stream — GET version for EventSource compatibility.

    Uses a pub-sub model so reconnecting browsers subscribe to the SAME
    running agent instead of starting a duplicate agent thread.
    """
    sub_queue: queue.Queue = queue.Queue(maxsize=512)

    with _active_jobs_lock:
        job = _active_jobs.get(error_log_id)
        already_running = job is not None and not job.get("done", False)
        if already_running:
            # Just attach — no new agent
            job["queues"].append(sub_queue)
        else:
            # Register a fresh job slot
            _active_jobs[error_log_id] = {"queues": [sub_queue], "done": False}

    if not already_running:
        def agent_thread():
            try:
                execute(
                    "UPDATE error_logs SET rca_status='in_progress', rca_started_at=NOW() WHERE id=%s",
                    (error_log_id,),
                )
                report = agent.run(
                    error_log_id,
                    trace_callback=lambda ev: _job_broadcast(error_log_id, ev),
                    **_effective_agent_settings(),
                )
                execute(
                    """UPDATE error_logs
                       SET rca_status='completed', rca_completed_at=NOW(), rca_result=%s
                       WHERE id=%s""",
                    (json.dumps(report.model_dump()), error_log_id),
                )
                _job_broadcast(error_log_id, {
                    "type": "done",
                    "report": report.model_dump(),
                    "ts": datetime.now(timezone.utc).isoformat(),
                })
            except Exception as exc:
                execute(
                    "UPDATE error_logs SET rca_status='failed', rca_error=%s WHERE id=%s",
                    (str(exc), error_log_id),
                )
                _job_broadcast(error_log_id, {
                    "type": "error",
                    "message": str(exc),
                    "ts": datetime.now(timezone.utc).isoformat(),
                })
            finally:
                _job_finish(error_log_id)
                # Keep the slot for 60s so late reconnectors get the done signal
                def _cleanup():
                    import time as _time
                    _time.sleep(60)
                    with _active_jobs_lock:
                        _active_jobs.pop(error_log_id, None)
                threading.Thread(target=_cleanup, daemon=True).start()

        threading.Thread(target=agent_thread, daemon=True).start()

    def sse_generator():
        try:
            while True:
                try:
                    event = sub_queue.get(timeout=120)
                except queue.Empty:
                    yield "data: {\"type\": \"error\", \"message\": \"Timed out waiting for agent\"}\n\n"
                    break
                if event is None:
                    break
                yield f"data: {json.dumps(event, default=str)}\n\n"
        finally:
            # Unsubscribe this client when it disconnects
            with _active_jobs_lock:
                j = _active_jobs.get(error_log_id)
                if j and sub_queue in j.get("queues", []):
                    j["queues"].remove(sub_queue)

    return StreamingResponse(
        sse_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Token Usage ──────────────────────────────────────────────────────────────

@app.get("/api/token-usage")
def api_token_usage(recent_limit: int = Query(50, ge=1, le=200)):
    """
    Aggregate token consumption stats from the token_usage table.
    Returns summary totals, per-model breakdown, and recent call log.
    All counts are real values captured from API responses.
    """
    # Summary row
    summary_rows = execute(
        """SELECT
               COUNT(*)                              AS total_calls,
               SUM(input_tokens)                    AS total_input,
               SUM(output_tokens)                   AS total_output,
               SUM(cache_read_tokens)               AS total_cache_read,
               SUM(cache_creation_tokens)           AS total_cache_write,
               SUM(input_tokens + output_tokens)    AS total_tokens,
               SUM(estimated_cost_usd)              AS total_cost,
               SUM(source = 'rca_agent')            AS rca_calls,
               SUM(source = 'gemini_analysis')      AS gemini_calls
           FROM token_usage"""
    )
    s = summary_rows[0] if summary_rows else {}

    summary = {
        "total_calls":       int(s.get("total_calls") or 0),
        "total_input":       int(s.get("total_input") or 0),
        "total_output":      int(s.get("total_output") or 0),
        "total_cache_read":  int(s.get("total_cache_read") or 0),
        "total_cache_write": int(s.get("total_cache_write") or 0),
        "total_tokens":      int(s.get("total_tokens") or 0),
        "total_cost":        float(s.get("total_cost") or 0),
        "rca_calls":         int(s.get("rca_calls") or 0),
        "gemini_calls":      int(s.get("gemini_calls") or 0),
    }

    # Per-model breakdown
    model_rows = execute(
        """SELECT
               model,
               source,
               COUNT(*)                              AS call_count,
               SUM(input_tokens)                    AS input_tokens,
               SUM(output_tokens)                   AS output_tokens,
               SUM(cache_read_tokens)               AS cache_read_tokens,
               SUM(cache_creation_tokens)           AS cache_creation_tokens,
               SUM(input_tokens + output_tokens)    AS total_tokens,
               SUM(estimated_cost_usd)              AS estimated_cost_usd
           FROM token_usage
           GROUP BY model, source
           ORDER BY SUM(estimated_cost_usd) DESC"""
    )
    by_model = []
    for row in model_rows:
        by_model.append({
            "model":                row["model"],
            "display_name":         model_display_name(row["model"]),
            "source":               row["source"],
            "call_count":           int(row.get("call_count") or 0),
            "input_tokens":         int(row.get("input_tokens") or 0),
            "output_tokens":        int(row.get("output_tokens") or 0),
            "cache_read_tokens":    int(row.get("cache_read_tokens") or 0),
            "cache_creation_tokens":int(row.get("cache_creation_tokens") or 0),
            "total_tokens":         int(row.get("total_tokens") or 0),
            "estimated_cost_usd":   float(row.get("estimated_cost_usd") or 0),
        })

    # Recent calls
    recent_rows = execute(
        """SELECT id, error_log_id, model, source,
                  input_tokens, output_tokens,
                  cache_read_tokens, cache_creation_tokens,
                  estimated_cost_usd, iteration_num, created_at
           FROM token_usage
           ORDER BY created_at DESC
           LIMIT %s""",
        (recent_limit,),
    )
    recent = []
    for row in recent_rows:
        recent.append({
            "id":                   int(row["id"]),
            "error_log_id":         row.get("error_log_id") or "",
            "model":                row["model"],
            "display_name":         model_display_name(row["model"]),
            "source":               row["source"],
            "input_tokens":         int(row.get("input_tokens") or 0),
            "output_tokens":        int(row.get("output_tokens") or 0),
            "cache_read_tokens":    int(row.get("cache_read_tokens") or 0),
            "cache_creation_tokens":int(row.get("cache_creation_tokens") or 0),
            "estimated_cost_usd":   float(row.get("estimated_cost_usd") or 0),
            "iteration_num":        row.get("iteration_num"),
            "created_at":           str(row["created_at"])[:19] if row.get("created_at") else "",
        })

    return {"summary": summary, "by_model": by_model, "recent": recent}


# ── Token Usage by Incident ──────────────────────────────────────────────────

@app.get("/api/token-usage/by-incident")
def api_token_usage_by_incident(limit: int = Query(50, ge=1, le=200)):
    """Token usage grouped by error_log_id. No cross-table JOIN to avoid collation issues."""
    # Step 1 — aggregate token_usage only (single table, no collation conflict)
    tu_rows = execute(
        """SELECT
               error_log_id,
               COUNT(*)                           AS call_count,
               SUM(input_tokens)                 AS input_tokens,
               SUM(output_tokens)                AS output_tokens,
               SUM(cache_read_tokens)            AS cache_read_tokens,
               SUM(cache_creation_tokens)        AS cache_creation_tokens,
               SUM(input_tokens + output_tokens) AS total_tokens,
               SUM(estimated_cost_usd)           AS total_cost,
               MAX(iteration_num)                AS max_iteration,
               MIN(created_at)                   AS started_at
           FROM token_usage
           WHERE error_log_id IS NOT NULL
           GROUP BY error_log_id
           ORDER BY MIN(created_at) DESC
           LIMIT %s""",
        (limit,),
    )

    if not tu_rows:
        return {"incidents": []}

    # Step 2 — fetch error_log metadata for those IDs (single table, no join)
    ids = [str(r["error_log_id"]) for r in tu_rows]
    placeholders = ",".join(["%s"] * len(ids))
    el_rows = execute(
        f"SELECT id, service_name, error_type, occurred_at, rca_status "
        f"FROM error_logs WHERE id IN ({placeholders})",
        ids,
    )
    el_map = {str(r["id"]): r for r in el_rows}

    # Step 3 — merge in Python (zero DB collation risk)
    incidents = []
    for row in tu_rows:
        eid = str(row["error_log_id"])
        el  = el_map.get(eid, {})
        incidents.append({
            "error_log_id":         eid,
            "service_name":         el.get("service_name") or "unknown",
            "error_type":           el.get("error_type")   or "UnknownError",
            "occurred_at":          str(el["occurred_at"])[:19] if el.get("occurred_at") else "",
            "rca_status":           el.get("rca_status")   or "pending",
            "call_count":           int(row.get("call_count")           or 0),
            "input_tokens":         int(row.get("input_tokens")         or 0),
            "output_tokens":        int(row.get("output_tokens")        or 0),
            "cache_read_tokens":    int(row.get("cache_read_tokens")    or 0),
            "cache_creation_tokens":int(row.get("cache_creation_tokens")or 0),
            "total_tokens":         int(row.get("total_tokens")         or 0),
            "total_cost":           float(row.get("total_cost")         or 0),
            "max_iteration":        row.get("max_iteration"),
            "started_at":           str(row["started_at"])[:19] if row.get("started_at") else "",
        })
    return {"incidents": incidents}


# ── Serve React UI (MUST be last) ────────────────────────────────────────────

_UI_DIST = Path(__file__).parent.parent / "ui" / "dist"
if _UI_DIST.exists():
    app.mount("/", StaticFiles(directory=str(_UI_DIST), html=True), name="ui")
