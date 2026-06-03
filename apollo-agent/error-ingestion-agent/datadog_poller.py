"""
Error Ingestion Agent — Datadog Poll Mode
=========================================
Polls the Datadog Logs Search API at a configurable interval for new ERROR /
EXCEPTION log events from services declared in projects.yaml.

Design decisions:
  - Cursor-based pagination (Datadog "after" cursor stored in service_context_cache).
    On restart the poller resumes from the last committed cursor, providing
    at-least-once delivery.  Duplicate events produce duplicate error_logs rows
    which the RCA agent processes independently — harmless for a demo system.
  - Service list is driven by projects.yaml (observability_mode: datadog).
    No service names are hardcoded.  Swapping the monitored application is a
    projects.yaml edit + image rebuild; credentials stay in env vars / Secrets Manager.
  - Serial processing per service per cycle; errors in one service do not block
    the next.

Run via:
    MODE=datadog_poll python main.py

Required env vars:
    DD_API_KEY      Datadog API key
    DD_APP_KEY      Datadog Application key
    DD_SITE         Datadog site (default: datadoghq.com)

Optional env vars:
    POLL_INTERVAL_SECONDS       Seconds between full sweeps (default: 30)
    DD_INITIAL_LOOKBACK_HOURS   How far back to look on first poll — no cursor
                                yet (default: 1)
    PROJECTS_YAML_PATH          Path to projects.yaml inside the container
                                (default: /app/projects.yaml)
"""

import asyncio
import json
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
import yaml

from config.settings import settings
from db.database import ensure_table, read_cursor, save_cursor
from agents.log_monitor.graph import process_log_entry
from utils.log_parser import is_error_line

logger = logging.getLogger("datadog-poller")

# Datadog Logs Search API endpoint (v2)
_DD_LOGS_URL = "https://api.{site}/api/v2/logs/events/search"

# ── Deduplication cache ───────────────────────────────────────────────────────
# Prevents the same error type from the same service flooding the DB when the
# chaos controller fires every few seconds or the initial poll pulls hours of backlog.
# Key: (service_name, error_type)  Value: epoch time last seen
_DEDUP_CACHE: dict[tuple, float] = {}
_DEDUP_TTL_SECONDS = 120   # suppress identical service+error_type within 2 minutes


def _is_duplicate(service_name: str, error_type: str) -> bool:
    """Return True if this service+error_type was seen within the dedup window."""
    key = (service_name, error_type)
    now = time.monotonic()
    last = _DEDUP_CACHE.get(key, 0.0)
    if now - last < _DEDUP_TTL_SECONDS:
        return True
    _DEDUP_CACHE[key] = now
    return False


def clear_dedup_cache() -> None:
    """Clear the dedup cache — call when restarting the poller so fresh errors flow through."""
    _DEDUP_CACHE.clear()


# ── Project loading ───────────────────────────────────────────────────────────

def _load_datadog_projects(poll_all: bool = False) -> list[dict]:
    """
    Load projects.yaml and return services to poll from Datadog.

    When poll_all=True (runtime Datadog toggle), ALL services are polled
    regardless of their observability_mode setting.
    When poll_all=False (legacy MODE=datadog_poll), only services with
    observability_mode=datadog are polled.
    """
    try:
        with open(settings.projects_yaml_path, encoding="utf-8") as fh:
            data = yaml.safe_load(fh)
        all_projects = data.get("projects", [])
        if poll_all:
            projects = all_projects
        else:
            projects = [p for p in all_projects if p.get("observability_mode") == "datadog"]

        if not projects:
            logger.warning("No projects found in %s — nothing to poll.", settings.projects_yaml_path)
        else:
            logger.info(
                "Polling %d service(s) from Datadog: %s",
                len(projects),
                [p["id"] for p in projects],
            )
        return projects
    except FileNotFoundError:
        logger.error("projects.yaml not found at %s.", settings.projects_yaml_path)
        return []
    except Exception as exc:
        logger.exception("Failed to load projects.yaml: %s", exc)
        return []


# ── Log event conversion ──────────────────────────────────────────────────────

def _build_raw_log(log_event: dict, service_name: str) -> str:
    """
    Convert a Datadog log event into a rich raw log string that includes
    the full stack trace so the parse → analyze pipeline has the same
    context as a locally-tailed log entry.

    Datadog log event structure (after our logback fix):
        {
          "attributes": {
            "timestamp": "...",
            "status":    "error",
            "message":   "NullPointerException: null",
            "service":   "banking-app",
            "attributes": {
              "logger":  {"name": "c.d.banking.ChaosController"},
              "error":   {
                "kind":    "NullPointerException",
                "message": "null",
                "stack":   "java.lang.NullPointerException\n\tat com.demo..."
              }
            }
          }
        }
    """
    attrs  = log_event.get("attributes", {})
    timestamp = attrs.get("timestamp", datetime.now(timezone.utc).isoformat())
    status    = attrs.get("status", "error").upper()
    message   = attrs.get("message", "Unknown error")

    # Nested app-level attributes written by LogstashEncoder
    nested = attrs.get("attributes", {})

    # Logger name
    logger_field = nested.get("logger", {})
    if isinstance(logger_field, dict):
        logger_name = logger_field.get("name", service_name)
    elif isinstance(logger_field, str):
        logger_name = logger_field
    else:
        logger_name = service_name

    # error.* fields — set via <fieldNames><stackTrace>error.stack</stackTrace></fieldNames>
    error_obj  = nested.get("error", {})
    error_kind  = error_obj.get("kind", "")
    error_msg   = error_obj.get("message", "")
    error_stack = error_obj.get("stack", "")

    # Build synthetic Spring Boot-style log line
    parts = [f"{timestamp} {status} {logger_name} - {message}"]

    # Append exception header (e.g. "NullPointerException: null") if not already
    # present in the message so the parser can identify error_type
    if error_kind and error_kind not in message:
        exc_header = f"{error_kind}: {error_msg}" if error_msg else error_kind
        parts.append(exc_header)

    # Append full stack trace — gives the analyzer the same depth as local mode
    if error_stack:
        parts.append(error_stack)

    return "\n".join(parts)


# ── Per-service poll ──────────────────────────────────────────────────────────

async def _poll_service(
    session: httpx.AsyncClient,
    service_name: str,
    environment: str,
    dd_service_tag: str,
    creds: dict,
    start_from: Optional[datetime] = None,
) -> None:
    """
    Poll Datadog for one service/environment and process any new error events.

    Uses cursor-based pagination:
      - If a cursor is stored  → use it (normal incremental fetch)
      - If no cursor (first poll):
          - start_from is set  → use that exact timestamp (resume from monitoring stop)
          - start_from is None → start from now-1min (fresh start, no backlog flood)

    The cursor is saved AFTER processing each batch (at-least-once delivery).
    """
    cursor: Optional[str] = await read_cursor(service_name)

    query = (
        f"service:{dd_service_tag} "
        f"status:(error OR exception) "
        f"env:{environment}"
    )

    payload: dict = {
        "filter": {
            "query": query,
            "to":    "now",
        },
        "page": {"limit": 100},
        "sort": "timestamp",
    }

    if cursor:
        payload["page"]["cursor"] = cursor
    else:
        if start_from is not None:
            # Resume from exact timestamp when monitoring was paused
            lookback_from = start_from
            logger.info(
                "Resuming %s from stop time %s",
                service_name, lookback_from.isoformat(),
            )
        else:
            # Fresh start — use 1 minute to avoid backlog flood
            lookback_from = datetime.now(timezone.utc) - timedelta(minutes=1)
            logger.info(
                "Fresh start for %s — polling from %s",
                service_name, lookback_from.isoformat(),
            )
        payload["filter"]["from"] = lookback_from.isoformat()

    # Use runtime-override creds first (forwarded from Settings UI), then env vars
    effective_api_key = creds.get("dd_api_key") or settings.dd_api_key
    effective_app_key = creds.get("dd_app_key") or settings.dd_app_key
    effective_site    = creds.get("dd_site")    or settings.dd_site

    url = _DD_LOGS_URL.format(site=effective_site)
    headers = {
        "DD-API-KEY":         effective_api_key,
        "DD-APPLICATION-KEY": effective_app_key,
        "Content-Type":       "application/json",
    }

    try:
        resp = await session.post(url, json=payload, headers=headers, timeout=30.0)
        resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code
        if status == 403:
            logger.error(
                "Datadog API key is invalid or lacks permission (HTTP 403). "
                "Update DD_API_KEY / DD_APP_KEY in your environment or Settings."
            )
        elif status == 401:
            logger.error(
                "Datadog authentication failed (HTTP 401). "
                "Check DD_API_KEY and DD_APP_KEY are correct."
            )
        else:
            logger.error(
                "Datadog API HTTP %s for service=%s: %s",
                status, service_name, exc.response.text[:400],
            )
        return
    except Exception as exc:
        logger.error("Datadog API request failed for service=%s: %s", service_name, exc)
        return

    data = resp.json()
    log_events: list = data.get("data", [])
    next_cursor: Optional[str] = (
        data.get("meta", {}).get("page", {}).get("after")
    )

    if not log_events:
        logger.debug("No new logs for service=%s env=%s", service_name, environment)
        # Still save the cursor if Datadog returned one (advances the position)
        if next_cursor:
            await save_cursor(service_name, next_cursor)
        return

    logger.info(
        "Polled Datadog: service=%s env=%s → %d log event(s)",
        service_name, environment, len(log_events),
    )

    stored_count = 0
    skipped_dedup = 0
    for log_event in log_events:
        raw_log = _build_raw_log(log_event, service_name)

        # Secondary filter: skip events that are not genuinely errors
        if not is_error_line(raw_log):
            logger.debug("Skipping non-error log from Datadog: %.120s", raw_log)
            continue

        # Deduplication: extract error type from the event before running the full pipeline
        attrs  = log_event.get("attributes", {})
        nested = attrs.get("attributes", {})
        error_type = nested.get("error", {}).get("kind", "") or attrs.get("message", "")[:60]

        if _is_duplicate(service_name, error_type):
            skipped_dedup += 1
            logger.debug(
                "Dedup: skipping %s/%s (same error within %ds window)",
                service_name, error_type, _DEDUP_TTL_SECONDS,
            )
            continue

        try:
            state = await process_log_entry(
                raw_log=raw_log,
                source="datadog_poll",
                service_name=service_name,
                environment=environment,
            )
            if state.get("stored"):
                stored_count += 1
                logger.info(
                    "Stored incident %s (service=%s)",
                    state["incident_id"], service_name,
                )
            elif state.get("error"):
                logger.error(
                    "Pipeline error for service=%s: %s",
                    service_name, state["error"],
                )
        except Exception as exc:
            logger.exception(
                "Unhandled error processing Datadog log for service=%s: %s",
                service_name, exc,
            )

    if stored_count or skipped_dedup:
        logger.info(
            "Cycle for service=%s: %d stored, %d deduplicated",
            service_name, stored_count, skipped_dedup,
        )

    # Save cursor AFTER processing the batch (at-least-once delivery)
    if next_cursor:
        await save_cursor(service_name, next_cursor)


# ── Main polling loop ─────────────────────────────────────────────────────────

async def run_datadog_poller(
    poll_all: bool = False,
    creds: dict | None = None,
    start_from: Optional[datetime] = None,
) -> None:
    """
    Poll Datadog for new error logs and process them through Gemini → DB.

    poll_all=True  — poll every service in projects.yaml (used by runtime toggle)
    poll_all=False — only services with observability_mode=datadog (legacy mode)

    Only NEW logs are processed — the cursor stored in service_context_cache
    ensures we resume exactly where the last poll left off.
    """
    await ensure_table()

    effective_creds = creds or {}
    effective_api_key = effective_creds.get("dd_api_key") or settings.dd_api_key
    effective_app_key = effective_creds.get("dd_app_key") or settings.dd_app_key
    effective_site    = effective_creds.get("dd_site")    or settings.dd_site

    if not effective_api_key or not effective_app_key:
        logger.error(
            "DD_API_KEY and DD_APP_KEY must be set for Datadog polling. "
            "Set them in Settings → Datadog or as environment variables."
        )
        return

    projects = _load_datadog_projects(poll_all=poll_all)
    if not projects:
        logger.error("No Datadog-monitored projects found — poller exiting.")
        return

    logger.info(
        "Datadog poller started — %d service(s), interval=%ds, site=%s, key=%s",
        len(projects),
        settings.poll_interval_seconds,
        effective_site,
        "runtime-override" if effective_creds.get("dd_api_key") else "env-var",
    )

    # Clear dedup cache on start so genuinely new errors aren't suppressed
    clear_dedup_cache()

    async with httpx.AsyncClient() as session:
        first_cycle = True
        while True:
            for project in projects:
                dd_config = project.get("datadog") or {}
                service_name = project["id"]
                dd_service_tag = dd_config.get("service_name", service_name)
                environment = project.get("environment", "production")

                try:
                    await _poll_service(
                        session=session,
                        service_name=service_name,
                        environment=environment,
                        dd_service_tag=dd_service_tag,
                        creds=effective_creds,
                        # start_from only applies on the first sweep; after that the cursor drives
                        start_from=start_from if first_cycle else None,
                    )
                except Exception as exc:
                    # Per-service errors must not crash the loop
                    logger.error(
                        "Unexpected error polling service=%s: %s — will retry next cycle",
                        service_name, exc,
                    )

            first_cycle = False   # cursor-based pagination takes over from the second cycle
            logger.debug(
                "Poll cycle complete — sleeping %ds", settings.poll_interval_seconds
            )
            await asyncio.sleep(settings.poll_interval_seconds)
