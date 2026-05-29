import json
import logging
import os
import queue
import threading
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel

from rca_agent.config import settings
from rca_agent.db import execute, execute_one, execute_update, json_loads
from rca_agent.adapters.observability.local_db import LocalDBAdapter
from rca_agent.adapters.cicd.mock_adapter import MockCICDAdapter
from rca_agent.agent import RCAAgent
from rca_agent.report_renderer import render_rca_html
from app.demo_scenarios import SCENARIO_KEY, DEMO_SERVICE_REPO_MAP
from rca_agent.dependency_memory import write_dependency_memory
from rca_agent.fix_creator import create_fix_pr, FixCreationError

ORDER_SERVICE_URL = os.environ.get("ORDER_SERVICE_URL", "http://order-service:8082")

CHAOS_ENDPOINTS = {
    "single_service": "/chaos/quantity-off-by-one",
    "cross_service": "/chaos/cross-service-npe",
}

logger = logging.getLogger("rca-agent")

obs_adapter = LocalDBAdapter()
cicd_adapter = MockCICDAdapter()
agent = RCAAgent(obs_adapter=obs_adapter, cicd_adapter=cicd_adapter)

# ── DB poll loop ──────────────────────────────────────────────────────────────

_stop_poll = threading.Event()


def _run_rca_safe(error_log_id: str) -> None:
    """
    Run the full RCA pipeline for one error log row, updating rca_status
    throughout.  Swallows all exceptions so a single bad row never kills the
    poll thread.
    """
    try:
        logger.info("Poll loop: starting RCA for error_log_id=%s", error_log_id)
        report = agent.run(error_log_id)
        execute(
            """UPDATE error_logs
               SET rca_status='completed', rca_completed_at=NOW(), rca_result=%s
               WHERE id=%s""",
            (json.dumps(report.model_dump()), error_log_id),
        )
        logger.info("Poll loop: RCA completed for error_log_id=%s", error_log_id)
    except Exception as exc:
        logger.exception("Poll loop: RCA failed for error_log_id=%s: %s", error_log_id, exc)
        execute(
            "UPDATE error_logs SET rca_status='failed', rca_error=%s WHERE id=%s",
            (str(exc), error_log_id),
        )


def _poll_loop() -> None:
    """
    Background thread: scan error_logs for pending rows, atomically claim one,
    and run RCA on it.

    Claim is atomic: UPDATE ... WHERE rca_status='pending' — if rowcount == 1
    this process owns the row; rowcount == 0 means another worker (or a
    concurrent HTTP request) got there first.  This keeps the poll loop safe
    even when multiple replicas run (future horizontal scale).

    The loop sleeps rca_poll_interval_seconds only when no pending row is found.
    When a row IS found it processes it and immediately checks for the next one,
    draining the backlog without an artificial delay.
    """
    logger.info(
        "RCA poll loop started — interval=%ds", settings.rca_poll_interval_seconds
    )
    while not _stop_poll.is_set():
        row = execute_one(
            """SELECT id FROM error_logs
               WHERE rca_status = 'pending'
               ORDER BY occurred_at ASC
               LIMIT 1"""
        )
        if not row:
            _stop_poll.wait(timeout=settings.rca_poll_interval_seconds)
            continue

        error_log_id = str(row["id"])
        claimed = execute_update(
            """UPDATE error_logs
               SET rca_status='in_progress', rca_started_at=NOW()
               WHERE id=%s AND rca_status='pending'""",
            (error_log_id,),
        )
        if claimed == 1:
            _run_rca_safe(error_log_id)
        # else: another worker claimed it — loop immediately to pick up next row

    logger.info("RCA poll loop stopped")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    FastAPI lifespan: start the DB poll thread on startup when
    RCA_POLL_ENABLED=true, stop it cleanly on shutdown.

    The poll thread is a daemon so it won't block process exit if something
    goes wrong during shutdown.
    """
    poll_thread: threading.Thread | None = None
    if settings.rca_poll_enabled:
        logger.info("RCA_POLL_ENABLED=true — starting background poll thread")
        poll_thread = threading.Thread(target=_poll_loop, daemon=True, name="rca-poll")
        poll_thread.start()
    else:
        logger.info(
            "RCA_POLL_ENABLED=false — poll loop disabled; use POST /rca/run to trigger manually"
        )

    yield  # ── application running ──

    if poll_thread is not None:
        logger.info("Shutdown: stopping RCA poll thread…")
        _stop_poll.set()
        poll_thread.join(timeout=10)


app = FastAPI(
    title="rca-agent",
    description="AI-powered Root Cause Analysis API",
    version="0.1.0",
    lifespan=lifespan,
)

# Path to the seeded IDs file (written by demo_seed_data.py)
_SEEDED_IDS_PATH = Path(__file__).parent.parent.parent / "demo-repos" / "seeded_ids.json"
# Also check next to the script itself (for flexibility)
_SEEDED_IDS_ALT = Path(__file__).parent.parent / "seeded_ids.json"


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": settings.model,
        "github_org": settings.github_org,
        "observability_adapter": settings.observability_adapter,
        "cicd_adapter": settings.cicd_adapter,
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
        report = agent.run(req.error_log_id)
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
            report = agent.run(req.error_log_id, trace_callback=trace_callback)
            execute(
                """UPDATE error_logs
                   SET rca_status='completed', rca_completed_at=NOW(), rca_result=%s
                   WHERE id=%s""",
                (json.dumps(report.model_dump()), req.error_log_id),
            )
            # Push final done event with full report
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
            event_queue.put(None)  # Sentinel to end the stream

    thread = threading.Thread(target=agent_thread, daemon=True)
    thread.start()

    def sse_generator():
        while True:
            try:
                event = event_queue.get(timeout=120)  # 2-minute timeout per event
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
    # MySQL returns JSON columns as strings — parse before rendering
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
    """Return all pending error log IDs for the demo dropdown."""
    rows = execute(
        """SELECT service_name, id, error_type, occurred_at
           FROM error_logs
           WHERE rca_status IN ('pending', 'failed')
           ORDER BY occurred_at DESC
           LIMIT 50"""
    )
    # Build label -> id map; label = "service — ErrorType (date)"
    scenarios = {}
    for row in rows:
        svc = row["service_name"]
        err = row.get("error_type") or "UnknownError"
        ts = str(row["occurred_at"])[:16]  # "2026-05-16 15:04"
        label = f"{svc} — {err} ({ts})"
        scenarios[label] = str(row["id"])
    return {"scenarios": scenarios}


@app.post("/demo/seed")
def demo_seed():
    """
    Idempotent: upsert service_repo_map entries and insert pre-crafted error
    logs for both demo scenarios.  Safe to call on every page load.
    """
    for svc, org, repo, branch, lang in DEMO_SERVICE_REPO_MAP:
        execute(
            """INSERT INTO service_repo_map
                   (service_name, github_org, github_repo, default_branch, language)
               VALUES (%s, %s, %s, %s, %s)
               ON DUPLICATE KEY UPDATE
                   github_org=VALUES(github_org),
                   github_repo=VALUES(github_repo),
                   default_branch=VALUES(default_branch),
                   language=VALUES(language)""",
            (svc, org, repo, branch, lang),
        )

    # Pre-seed cross-service dependency so Claude skips the discovery phase
    write_dependency_memory(
        downstream_service="order-service",
        upstream_service="pricing-service",
        upstream_repo="pricing-service",
        evidence="OrderService calls pricing-service POST /api/v1/pricing via PricingClient; "
                 "PricingResponseDto.getDiscount() returns null after v2.1.0 deploy",
        breaking_change="pricing-service v2.1.0 renamed field 'discount' to 'discountRate' "
                        "in PricingResponseDto; order-service still calls getDiscount() → null NPE",
        upstream_branch="main",
    )

    ids: dict[str, str] = {}
    incidents: list[dict] = []
    for key, scenario in SCENARIO_KEY.items():
        execute(
            """INSERT IGNORE INTO error_logs
                   (id, service_name, environment, error_type, error_message,
                    stack_trace, severity, occurred_at, metadata)
               VALUES (%s, %s, %s, %s, %s, %s, %s, NOW(), %s)""",
            (
                scenario["id"],
                scenario["service_name"],
                scenario["environment"],
                scenario["error_type"],
                scenario["error_message"],
                json.dumps(scenario["stack_trace"]),
                scenario["severity"],
                json.dumps(scenario["metadata"]),
            ),
        )
        ids[key] = scenario["id"]

        # Pull the row back so we get the actual occurred_at (in case the row
        # already existed from a prior seed).
        row = execute_one(
            "SELECT occurred_at FROM error_logs WHERE id=%s",
            (scenario["id"],),
        )
        incidents.append({
            "id": scenario["id"],
            "scenario_key": key,
            "service": scenario["service_name"],
            "environment": scenario["environment"],
            "error_type": scenario["error_type"],
            "error_message": scenario["error_message"],
            "severity": scenario["severity"],
            "stack_trace": scenario["stack_trace"],
            "occurred_at": str(row["occurred_at"]) if row else None,
        })

    return {"seeded": True, "error_log_ids": ids, "incidents": incidents}


@app.post("/demo/trigger/{scenario}")
def demo_trigger(scenario: str):
    """
    Trigger a chaos endpoint on the order-service AND insert a fresh error log
    so the RCA agent always sees a pending row to analyze.
    """
    if scenario not in CHAOS_ENDPOINTS:
        raise HTTPException(status_code=400, detail=f"Unknown scenario: {scenario!r}")

    chaos_url = f"{ORDER_SERVICE_URL}{CHAOS_ENDPOINTS[scenario]}"
    try:
        r = httpx.post(chaos_url, timeout=10.0)
        chaos_status = r.status_code
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=f"order-service unreachable at {chaos_url}: {exc}",
        )

    template = SCENARIO_KEY[scenario]
    new_id = str(uuid.uuid4())
    execute(
        """INSERT INTO error_logs
               (id, service_name, environment, error_type, error_message,
                stack_trace, severity, occurred_at, metadata)
           VALUES (%s, %s, %s, %s, %s, %s, %s, NOW(), %s)""",
        (
            new_id,
            template["service_name"],
            template["environment"],
            template["error_type"],
            template["error_message"],
            json.dumps(template["stack_trace"]),
            template["severity"],
            json.dumps(template["metadata"]),
        ),
    )

    return {"triggered": True, "scenario": scenario, "error_log_id": new_id, "chaos_status": chaos_status}


# ── Edit-mode: create a real GitHub PR with the fix ──────────────────────────

@app.post("/rca/{error_log_id}/create_pr")
def create_pr(error_log_id: str):
    """
    Apply the deterministic fix for this incident's scenario and open a real
    PR on oscorpAI/<repo>.  Requires RCA to have completed first (we need the
    rca_id from the saved report).
    """
    row = execute_one(
        "SELECT rca_result, metadata FROM error_logs WHERE id=%s",
        (error_log_id,),
    )
    if not row:
        raise HTTPException(status_code=404, detail="Error log not found")
    if not row["rca_result"]:
        raise HTTPException(
            status_code=409,
            detail="RCA has not completed for this incident yet — run RCA first.",
        )

    report = json_loads(row["rca_result"])
    rca_id = report.get("rca_id")
    if not rca_id:
        raise HTTPException(status_code=500, detail="RCA report is missing rca_id")

    metadata = json_loads(row["metadata"]) if row["metadata"] else {}
    chaos_trigger = metadata.get("chaos_trigger", "")
    scenario_key = {
        "quantity-off-by-one": "single_service",
        "cross-service-npe": "cross_service",
    }.get(chaos_trigger)
    if not scenario_key:
        raise HTTPException(
            status_code=422,
            detail=(
                f"This incident has no known fix recipe "
                f"(metadata.chaos_trigger={chaos_trigger!r}). "
                f"Edit mode is only wired for the two demo scenarios."
            ),
        )

    try:
        result = create_fix_pr(scenario_key, rca_id)
    except FixCreationError as exc:
        logger.exception("PR creation failed for %s: %s", error_log_id, exc)
        raise HTTPException(status_code=422, detail=str(exc))

    return result
