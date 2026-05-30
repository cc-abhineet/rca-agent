"""
Error Ingestion Agent — Entry Point

Always runs:
  - File watcher (db mode) — tails /var/log/banking-app/app.log
  - FastAPI control server on port 8001 — lets the rca-agent toggle the
    Datadog poller at runtime without restarting this container.

POST http://ingestion-agent:8001/source       {"source": "local" | "datadog"}
POST http://ingestion-agent:8001/monitoring   {"action": "stop" | "start"}
GET  http://ingestion-agent:8001/source
GET  http://ingestion-agent:8001/health
"""
import asyncio
import logging
import os
import re
import sys
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

from config.settings import settings
from db.database import ensure_table, close_pool
from agents.log_monitor.graph import process_log_entry
from utils.log_parser import is_error_line, extract_service_name

# A new log entry starts with a timestamp (Spring Boot, Python, Go) or a
# severity prefix (Python basicConfig).  Everything else is a continuation
# (exception class, stack frames, "Caused by:" lines, etc.).
_LOG_ENTRY_START_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}"   # ISO / Spring Boot
    r"|^\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}"      # Go std logger
    r"|^time=[\"'\d]"                               # Logrus / Zap Go
    r"|^(?:ERROR|WARN(?:ING)?|INFO|DEBUG|FATAL|CRITICAL):"  # Python basicConfig
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s - %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("error-ingestion-agent")

# ── Runtime state ─────────────────────────────────────────────────────────────
# "local"   — only file watcher active
# "datadog" — file watcher + Datadog poller both active
_source = {"value": "local"}
_monitoring = {"active": True}        # global pause/resume flag
_watcher_task: asyncio.Task | None = None
_dd_poller_task: asyncio.Task | None = None


# ── Watchdog file handler ─────────────────────────────────────────────────────

class LogFileHandler(FileSystemEventHandler):
    """
    Tails one log file and forwards ERROR lines to the ingestion pipeline.
    Service name is extracted from each log line; falls back to SERVICE_NAME env var.
    """

    def __init__(self, log_path: str, loop: asyncio.AbstractEventLoop):
        self.log_path = log_path
        self._loop   = loop
        self._pos    = self._get_file_size()
        self._buffer: list[str] = []
        logger.info("Watching log file: %s (starting at byte %d)", log_path, self._pos)

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

            if not new_content:
                return

            for line in new_content.splitlines():
                if not line.strip():
                    # Blank line — explicit entry separator
                    self._flush_buffer()
                elif _LOG_ENTRY_START_RE.match(line):
                    # New log entry: flush any previously accumulated entry first
                    self._flush_buffer()
                    self._buffer.append(line)
                else:
                    # Continuation: exception class, "Caused by:", stack frames, etc.
                    self._buffer.append(line)

            # Flush remaining buffer.  Java loggers write the full entry (message +
            # stack trace) in a single OS write, so by the time we reach here the
            # buffer holds the complete entry for the current batch.
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
    """Parse LOG_FILE_PATHS (comma-separated) from settings."""
    raw = settings.log_file_paths.strip()
    paths = [p.strip() for p in raw.split(",") if p.strip()]
    return paths or ["/var/log/banking-app/app.log"]


async def _wait_for_file(path: str) -> None:
    if not os.path.exists(path):
        logger.warning("Log file not found: %s — waiting…", path)
        while not os.path.exists(path):
            await asyncio.sleep(5)
        logger.info("Log file appeared: %s", path)


async def run_file_watcher():
    await ensure_table()

    log_paths = _parse_log_paths()
    logger.info("Watching %d log file(s): %s", len(log_paths), log_paths)

    for path in log_paths:
        await _wait_for_file(path)

    loop     = asyncio.get_running_loop()
    observer = Observer()

    for path in log_paths:
        handler = LogFileHandler(path, loop)
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

async def _run_dd_poller_loop():
    """Wrapper that runs the Datadog poller continuously until cancelled."""
    from datadog_poller import run_datadog_poller
    try:
        logger.info("Datadog poller started")
        await run_datadog_poller(poll_all=True)
    except asyncio.CancelledError:
        logger.info("Datadog poller stopped")


# ── FastAPI control server ────────────────────────────────────────────────────

class SourceRequest(BaseModel):
    source: str  # "local" | "datadog"


class MonitoringRequest(BaseModel):
    action: str  # "stop" | "start"


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _watcher_task
    _watcher_task = asyncio.create_task(run_file_watcher())
    _monitoring["active"] = True
    logger.info("Ingestion agent control server ready on port 8001")
    yield
    # Shutdown: cancel all tasks
    if _watcher_task and not _watcher_task.done():
        _watcher_task.cancel()
    global _dd_poller_task
    if _dd_poller_task and not _dd_poller_task.done():
        _dd_poller_task.cancel()


control_app = FastAPI(title="ingestion-agent-control", lifespan=lifespan)


@control_app.get("/source")
def get_source():
    return {
        "source": _source["value"],
        "monitoring_active": _monitoring["active"],
        "dd_poller_active": _dd_poller_task is not None and not _dd_poller_task.done(),
    }


@control_app.post("/source")
async def set_source(req: SourceRequest):
    global _dd_poller_task
    new_source = req.source

    if new_source == "datadog" and _source["value"] != "datadog":
        if not settings.dd_api_key or not settings.dd_app_key:
            return {"error": "DD_API_KEY and DD_APP_KEY must be set to use Datadog source"}
        _source["value"] = "datadog"
        # Only start poller if monitoring is active
        if _monitoring["active"] and (_dd_poller_task is None or _dd_poller_task.done()):
            _dd_poller_task = asyncio.create_task(_run_dd_poller_loop())
        logger.info("Source switched to datadog")

    elif new_source == "local" and _source["value"] != "local":
        _source["value"] = "local"
        if _dd_poller_task and not _dd_poller_task.done():
            _dd_poller_task.cancel()
            _dd_poller_task = None
        logger.info("Source switched to local — poller stopped")

    return {
        "source": _source["value"],
        "monitoring_active": _monitoring["active"],
    }


@control_app.post("/monitoring")
async def set_monitoring(req: MonitoringRequest):
    """Stop or start all monitoring (file watcher + dd poller)."""
    global _watcher_task, _dd_poller_task

    if req.action == "stop":
        # Cancel file watcher
        if _watcher_task and not _watcher_task.done():
            _watcher_task.cancel()
            _watcher_task = None
        # Cancel DD poller
        if _dd_poller_task and not _dd_poller_task.done():
            _dd_poller_task.cancel()
            _dd_poller_task = None
        _monitoring["active"] = False
        logger.info("Monitoring stopped by user")

    elif req.action == "start":
        # Restart file watcher if not running
        if _watcher_task is None or _watcher_task.done():
            _watcher_task = asyncio.create_task(run_file_watcher())
        # Restart DD poller if source is datadog
        if _source["value"] == "datadog" and (_dd_poller_task is None or _dd_poller_task.done()):
            _dd_poller_task = asyncio.create_task(_run_dd_poller_loop())
        _monitoring["active"] = True
        logger.info("Monitoring started by user (source=%s)", _source["value"])

    return {
        "monitoring_active": _monitoring["active"],
        "source": _source["value"],
    }


@control_app.get("/health")
def health():
    return {
        "status": "ok",
        "source": _source["value"],
        "monitoring_active": _monitoring["active"],
        "dd_poller_active": _dd_poller_task is not None and not _dd_poller_task.done(),
        "watcher_active": _watcher_task is not None and not _watcher_task.done(),
    }


def main():
    uvicorn.run(control_app, host="0.0.0.0", port=8001, log_level="info")


if __name__ == "__main__":
    main()
