"""
Error Ingestion Agent — Entry Point

Supports three operating modes, selected via the MODE environment variable:

  MODE=db (default)
      Tails LOG_FILE_PATH for new lines and feeds errors through the
      LangGraph incident processing pipeline (file-watcher mode).
      Run: MODE=db LOG_FILE_PATH=/var/log/banking-app/app.log python main.py

  MODE=datadog
      Starts a FastAPI server that receives Datadog monitor alert webhooks
      on WEBHOOK_PORT (default 8001).
      Run: MODE=datadog python main.py

  MODE=datadog_poll
      Polls the Datadog Logs Search API at POLL_INTERVAL_SECONDS (default 30)
      for new ERROR/EXCEPTION log events from services declared in projects.yaml.
      Service list is driven by projects.yaml (observability_mode: datadog).
      Credentials: DD_API_KEY, DD_APP_KEY (required); DD_SITE (default datadoghq.com).
      Run: MODE=datadog_poll DD_API_KEY=... DD_APP_KEY=... python main.py
"""
import asyncio
import logging
import os
import sys

from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

from config.settings import settings
from db.database import ensure_table, close_pool
from agents.log_monitor.graph import process_log_entry
from utils.log_parser import is_error_line

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s - %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("error-ingestion-agent")


class LogFileHandler(FileSystemEventHandler):
    """Watchdog handler that tails a log file for new error lines.

    Watchdog calls on_modified from a background thread, so we hold a
    reference to the main event loop and submit coroutines with
    run_coroutine_threadsafe — the only safe way to schedule async work
    from a non-async thread.
    """

    def __init__(self, log_path: str, loop: asyncio.AbstractEventLoop):
        self.log_path = log_path
        self._loop = loop
        self._pos = self._get_file_size()
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
                if line.strip():
                    self._buffer.append(line)
                    if not line.startswith("\t") and not line.startswith("    at "):
                        if len(self._buffer) > 1:
                            self._flush_buffer()
                        elif is_error_line(line):
                            self._flush_buffer()
                        else:
                            self._buffer.clear()
                else:
                    if self._buffer:
                        self._flush_buffer()

        except Exception as exc:
            logger.error("Error reading log file: %s", exc)

    def _flush_buffer(self):
        if not self._buffer:
            return
        raw_log = "\n".join(self._buffer)
        self._buffer.clear()
        if is_error_line(raw_log):
            # Schedule the coroutine on the main async event loop from this thread
            asyncio.run_coroutine_threadsafe(self._process(raw_log), self._loop)

    async def _process(self, raw_log: str):
        logger.info("Processing error log entry (%d chars)", len(raw_log))
        state = await process_log_entry(raw_log, source="db_watcher")
        if state.get("stored"):
            logger.info("Incident %s stored", state["incident_id"])
        else:
            logger.error("Failed to store incident: %s", state.get("error"))


async def run_file_watcher():
    """Main file watcher loop."""
    await ensure_table()

    log_path = settings.log_file_path
    if not os.path.exists(log_path):
        logger.warning("Log file not found: %s -- waiting for banking-app to create it...", log_path)
        while not os.path.exists(log_path):
            await asyncio.sleep(5)
        logger.info("Log file appeared: %s", log_path)

    # Capture the running loop and pass it to the handler so watchdog's
    # background thread can submit coroutines safely.
    loop = asyncio.get_running_loop()
    handler = LogFileHandler(log_path, loop)

    observer = Observer()
    observer.schedule(handler, path=os.path.dirname(log_path) or ".", recursive=False)
    observer.start()
    logger.info("Error Ingestion Agent started in DB/file-watcher mode")

    try:
        while True:
            await asyncio.sleep(1)
    except (KeyboardInterrupt, asyncio.CancelledError):
        logger.info("Shutting down file watcher...")
        observer.stop()
        observer.join()
        await close_pool()


def main():
    if settings.mode == "db":
        asyncio.run(run_file_watcher())
    elif settings.mode == "datadog":
        import uvicorn
        from datadog_webhook import app
        logger.info("Starting Datadog webhook mode on port %d", settings.webhook_port)
        uvicorn.run(app, host="0.0.0.0", port=settings.webhook_port)
    elif settings.mode == "datadog_poll":
        from datadog_poller import run_datadog_poller
        logger.info("Starting Datadog poll mode (site=%s, interval=%ds)", settings.dd_site, settings.poll_interval_seconds)
        asyncio.run(run_datadog_poller())
    else:
        logger.error(
            "Unknown MODE: %s -- must be 'db', 'datadog', or 'datadog_poll'",
            settings.mode,
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
