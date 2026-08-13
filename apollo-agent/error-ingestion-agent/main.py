"""
Error Ingestion Agent — Entry Point

Always runs:
  - File watcher (db mode) — tails /var/log/banking-app/app.log
  - FastAPI control server on port 8001

POST http://ingestion-agent:8001/source       {"source": "local" | "datadog"}
POST http://ingestion-agent:8001/monitoring   {"action": "stop" | "start"}
GET  http://ingestion-agent:8001/source
GET  http://ingestion-agent:8001/health

Resume behaviour
----------------
When monitoring is STOPPED the agent records:
  - _monitoring_stopped_at  : exact UTC timestamp
  - _saved_file_positions   : byte-position for every watched log file

When monitoring is STARTED again:
  - File watcher resumes from saved byte-positions (reads lines written while paused)
  - Datadog poller uses _monitoring_stopped_at as the 'from' time so no events are
    missed and no backlog flood occurs
"""
import asyncio
import logging
import os
import re
import sys
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Optional

import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

from config.settings import settings
from db.database import ensure_table, close_pool, resolve_org_id, get_org_id, set_org_id, load_org_config, get_org_config
from agents.log_monitor.graph import process_log_entry
from utils.log_parser import is_error_line, extract_service_name

_LOG_ENTRY_START_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}"
    r"|^\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}"
    r"|^time=[\"'\d]"
    r"|^(?:ERROR|WARN(?:ING)?|INFO|DEBUG|FATAL|CRITICAL):"
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s - %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("error-ingestion-agent")


# ── Runtime state ─────────────────────────────────────────────────────────────

_source = {"value": "local"}
_monitoring = {"active": True}
_watcher_task: asyncio.Task | None = None
_dd_poller_task: asyncio.Task | None = None
_dd_runtime_creds: dict = {}

# Resume state — populated on Stop, consumed on Start
_monitoring_stopped_at: Optional[datetime] = None   # UTC timestamp of last Stop
_saved_file_positions:  dict[str, int] = {}         # path → byte offset at Stop time

# Live file positions updated by handlers so Stop can snapshot them
_live_file_positions: dict[str, int] = {}


# ── Watchdog file handler ─────────────────────────────────────────────────────

class LogFileHandler(FileSystemEventHandler):
    """
    Tails one log file and forwards ERROR lines to the ingestion pipeline.
    Accepts an optional resume_pos to continue from a saved byte offset.
    """

    def __init__(
        self,
        log_path: str,
        loop: asyncio.AbstractEventLoop,
        resume_pos: Optional[int] = None,
    ):
        self.log_path = log_path
        self._loop   = loop
        self._buffer: list[str] = []

        if resume_pos is not None:
            self._pos = resume_pos
            logger.info("Resuming %s from byte %d", log_path, resume_pos)
        else:
            self._pos = self._get_file_size()
            logger.info("Watching %s (starting at byte %d)", log_path, self._pos)

        # Register in live-positions so Stop can snapshot them
        _live_file_positions[log_path] = self._pos

    def _get_file_size(self) -> int:
        try:
            return os.path.getsize(self.log_path)
        except FileNotFoundError:
            return 0

    def on_modified(self, event):
        if event.src_path != self.log_path:
            return
        self._read_new_lines()

    def _read_new_lines(self):
        try:
            with open(self.log_path, "r", encoding="utf-8", errors="replace") as f:
                f.seek(self._pos)
                new_content = f.read()
                self._pos = f.tell()

            # Keep live-positions dict up to date
            _live_file_positions[self.log_path] = self._pos

            if not new_content:
                return

            for line in new_content.splitlines():
                if not line.strip():
                    self._flush_buffer()
                elif _LOG_ENTRY_START_RE.match(line):
                    self._flush_buffer()
                    self._buffer.append(line)
                else:
                    self._buffer.append(line)

            self._flush_buffer()

        except Exception as exc:
            logger.error("Error reading log file %s: %s", self.log_path, exc)

    def _flush_buffer(self):
        if not self._buffer:
            return
        raw_log = "\n".join(self._buffer)
        self._buffer.clear()
        if is_error_line(raw_log):
            asyncio.run_coroutine_threadsafe(self._process(raw_log), self._loop)

    async def _process(self, raw_log: str):
        svc = extract_service_name(raw_log) or settings.service_name
        logger.info("Error detected — service=%s (%d chars)", svc, len(raw_log))

        state = await process_log_entry(
            raw_log,
            source="db_watcher",
            service_name=svc,
            environment=settings.environment,
        )
        if state.get("stored"):
            logger.info("Incident %s stored (service=%s)", state["incident_id"], svc)
        else:
            logger.error("Failed to store incident for %s: %s", svc, state.get("error"))


# ── File watcher coroutine ────────────────────────────────────────────────────

def _parse_log_paths() -> list[str]:
    raw = settings.log_file_paths.strip()
    paths = [p.strip() for p in raw.split(",") if p.strip()]
    return paths or ["/var/log/banking-app/app.log"]


async def _wait_for_file(path: str) -> None:
    if not os.path.exists(path):
        logger.warning("Log file not found: %s — waiting…", path)
        while not os.path.exists(path):
            await asyncio.sleep(5)
        logger.info("Log file appeared: %s", path)


async def run_file_watcher(resume_positions: Optional[dict] = None):
    """
    Watch log files for new ERROR lines.
    resume_positions: {path: byte_offset} — pass to continue from a saved position.
    """
    await ensure_table()

    log_paths = _parse_log_paths()
    if resume_positions:
        logger.info("Resuming file watcher with saved positions: %s", resume_positions)
    else:
        logger.info("Starting file watcher on %d file(s): %s", len(log_paths), log_paths)

    for path in log_paths:
        await _wait_for_file(path)

    loop     = asyncio.get_running_loop()
    observer = Observer()

    for path in log_paths:
        resume_pos = (resume_positions or {}).get(path)
        handler = LogFileHandler(path, loop, resume_pos=resume_pos)
        watch_dir = os.path.dirname(path) or "."
        observer.schedule(handler, path=watch_dir, recursive=False)

    observer.start()
    logger.info("File watcher started")

    try:
        while True:
            await asyncio.sleep(1)
    except asyncio.CancelledError:
        logger.info("File watcher shutting down…")
        observer.stop()
        observer.join()
        await close_pool()


# ── Datadog poller coroutine ──────────────────────────────────────────────────

async def _run_dd_poller_loop(start_from: Optional[datetime] = None):
    """
    Wrapper that runs the Datadog poller until cancelled.
    start_from: if provided, used as the initial 'from' time for the first poll
                so the poller picks up exactly where monitoring was paused.
    """
    from datadog_poller import run_datadog_poller
    try:
        logger.info(
            "Datadog poller started (key=%s, start_from=%s)",
            "runtime-override" if _dd_runtime_creds.get("dd_api_key") else "env-var",
            start_from.isoformat() if start_from else "now-1min",
        )
        await run_datadog_poller(
            poll_all=True,
            creds=_dd_runtime_creds.copy(),
            start_from=start_from,
        )
    except asyncio.CancelledError:
        logger.info("Datadog poller stopped")


# ── FastAPI control server ────────────────────────────────────────────────────

class SourceRequest(BaseModel):
    source:     str
    dd_api_key: str | None = None
    dd_app_key: str | None = None
    dd_site:    str | None = None


class MonitoringRequest(BaseModel):
    action:     str
    dd_api_key: str | None = None
    dd_app_key: str | None = None
    dd_site:    str | None = None


async def _apply_org_config():
    """Load ingestion credentials from DB and apply to runtime state."""
    global _dd_runtime_creds
    cfg = await load_org_config()
    if cfg.get("dd_api_key"):
        _dd_runtime_creds.update({
            k: cfg[k] for k in ("dd_api_key", "dd_app_key", "dd_site") if cfg.get(k)
        })
        logger.info("Datadog credentials loaded from org config")


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _watcher_task
    _watcher_task = asyncio.create_task(run_file_watcher())
    _monitoring["active"] = True

    logger.info("Ingestion agent control server ready on port 8001")
    yield
    if _watcher_task and not _watcher_task.done():
        _watcher_task.cancel()
    global _dd_poller_task
    if _dd_poller_task and not _dd_poller_task.done():
        _dd_poller_task.cancel()


control_app = FastAPI(title="ingestion-agent-control", lifespan=lifespan)


@control_app.get("/source")
def get_source():
    return {
        "source":             _source["value"],
        "monitoring_active":  _monitoring["active"],
        "dd_poller_active":   _dd_poller_task is not None and not _dd_poller_task.done(),
        "stopped_at":         _monitoring_stopped_at.isoformat() if _monitoring_stopped_at else None,
    }


@control_app.post("/source")
async def set_source(req: SourceRequest):
    global _dd_poller_task, _dd_runtime_creds

    incoming = {
        k: v for k, v in {
            "dd_api_key": req.dd_api_key,
            "dd_app_key": req.dd_app_key,
            "dd_site":    req.dd_site,
        }.items() if v is not None
    }
    _dd_runtime_creds.update(incoming)

    effective_api_key = _dd_runtime_creds.get("dd_api_key") or settings.dd_api_key
    effective_app_key = _dd_runtime_creds.get("dd_app_key") or settings.dd_app_key

    if new_source := req.source:
        if new_source == "datadog" and _source["value"] != "datadog":
            if not effective_api_key or not effective_app_key:
                return {"error": "DD_API_KEY and DD_APP_KEY must be set. Configure them in Settings → Datadog."}
            _source["value"] = "datadog"
            # Start poller if monitoring is active; no start_from here (source switch mid-run)
            if _monitoring["active"] and (_dd_poller_task is None or _dd_poller_task.done()):
                _dd_poller_task = asyncio.create_task(_run_dd_poller_loop(start_from=None))
            logger.info("Source switched to datadog")

        elif new_source == "local" and _source["value"] != "local":
            _source["value"] = "local"
            if _dd_poller_task and not _dd_poller_task.done():
                _dd_poller_task.cancel()
                _dd_poller_task = None
            logger.info("Source switched to local — poller stopped")

    return {
        "source":            _source["value"],
        "monitoring_active": _monitoring["active"],
    }


@control_app.post("/monitoring")
async def set_monitoring(req: MonitoringRequest):
    """Stop or start all monitoring, resuming from the exact stop timestamp."""
    global _watcher_task, _dd_poller_task
    global _monitoring_stopped_at, _saved_file_positions

    if req.action == "stop":
        # ── Snapshot state BEFORE cancelling tasks ────────────────────────────
        _monitoring_stopped_at = datetime.now(timezone.utc)
        _saved_file_positions  = dict(_live_file_positions)  # byte-positions per file

        # Cancel file watcher
        if _watcher_task and not _watcher_task.done():
            _watcher_task.cancel()
            _watcher_task = None
        # Cancel DD poller
        if _dd_poller_task and not _dd_poller_task.done():
            _dd_poller_task.cancel()
            _dd_poller_task = None

        _monitoring["active"] = False
        logger.info(
            "Monitoring stopped at %s — file positions: %s",
            _monitoring_stopped_at.isoformat(), _saved_file_positions,
        )

    elif req.action == "start":
        # Update DD creds if forwarded
        incoming = {
            k: v for k, v in {
                "dd_api_key": req.dd_api_key,
                "dd_app_key": req.dd_app_key,
                "dd_site":    req.dd_site,
            }.items() if v is not None
        }
        _dd_runtime_creds.update(incoming)

        # Restart file watcher — resume from saved byte positions (catches up on missed lines)
        if _watcher_task is None or _watcher_task.done():
            positions = _saved_file_positions.copy() if _saved_file_positions else None
            _watcher_task = asyncio.create_task(
                run_file_watcher(resume_positions=positions)
            )

        # Restart DD poller — resume from exact stop timestamp (no gap, no flood)
        if _source["value"] == "datadog" and (_dd_poller_task is None or _dd_poller_task.done()):
            _dd_poller_task = asyncio.create_task(
                _run_dd_poller_loop(start_from=_monitoring_stopped_at)
            )

        _monitoring["active"] = True

        if _monitoring_stopped_at:
            logger.info(
                "Monitoring started — resuming from %s (source=%s)",
                _monitoring_stopped_at.isoformat(), _source["value"],
            )
        else:
            logger.info("Monitoring started (source=%s)", _source["value"])

        # Clear stop state — consumed
        _monitoring_stopped_at = None
        _saved_file_positions  = {}

    return {
        "monitoring_active": _monitoring["active"],
        "source":            _source["value"],
    }


class OrgSwitchRequest(BaseModel):
    org_id: str


@control_app.post("/org")
async def switch_org(req: OrgSwitchRequest):
    """Called by the rca-agent when the user switches the active org in the UI.
    Reloads ingestion credentials from agent_config immediately so the running
    agent uses the new org's Gemini key and Datadog credentials without restart."""
    set_org_id(req.org_id)
    logger.info("Active org switched via API to org_id=%s", req.org_id)
    asyncio.create_task(_apply_org_config())
    return {"org_id": req.org_id, "switched": True}


@control_app.get("/health")
def health():
    return {
        "status":            "ok",
        "source":            _source["value"],
        "monitoring_active": _monitoring["active"],
        "dd_poller_active":  _dd_poller_task is not None and not _dd_poller_task.done(),
        "watcher_active":    _watcher_task is not None and not _watcher_task.done(),
        "active_org_id":     get_org_id(),
        "stopped_at":        _monitoring_stopped_at.isoformat() if _monitoring_stopped_at else None,
    }


def main():
    uvicorn.run(control_app, host="0.0.0.0", port=8001, log_level="info")


if __name__ == "__main__":
    main()
