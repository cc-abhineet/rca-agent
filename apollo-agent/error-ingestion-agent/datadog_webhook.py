"""
Error Ingestion Agent — Datadog Webhook Mode
Receives Datadog monitor alert webhooks and writes them to error_incidents.

Run:
    MODE=datadog python main.py
    (or: uvicorn datadog_webhook:app --host 0.0.0.0 --port 8001)
"""
import logging
from datetime import datetime
from typing import Optional

from fastapi import FastAPI, HTTPException, BackgroundTasks, Request
from pydantic import BaseModel

from config.settings import settings
from db.database import ensure_table, insert_incident
from agents.log_monitor.graph import process_log_entry

logger = logging.getLogger(__name__)

app = FastAPI(
    title="Error Ingestion Agent — Webhook Receiver",
    description="Receives Datadog monitor webhooks and ingests them into error_incidents",
    version="0.3.0",
)


@app.on_event("startup")
async def startup():
    await ensure_table()
    logger.info("Error Ingestion Agent (webhook mode) ready")


# ── Datadog webhook payload model ───────────────────────────────────────────

class DatadogAlertPayload(BaseModel):
    """
    Maps to the custom payload configured in terraform/datadog_monitor.tf.
    All fields are optional since Datadog payload format can vary.
    """
    service:     str = "unknown"
    environment: str = "production"
    alert_id:    Optional[str] = None
    alert_title: Optional[str] = None
    metric:      Optional[str] = None
    value:       Optional[str] = None
    timestamp:   Optional[str] = None
    tags:        Optional[str] = None
    # Raw Datadog fields (fallback)
    hostname:    Optional[str] = None
    event_type:  Optional[str] = None
    body:        Optional[str] = None


# ── Webhook endpoint ────────────────────────────────────────────────────────

@app.post("/webhook/datadog", status_code=202)
async def receive_datadog_webhook(
    payload: DatadogAlertPayload,
    background_tasks: BackgroundTasks,
):
    """
    Receive a Datadog monitor alert webhook.
    Immediately acknowledges (202) and processes asynchronously.
    """
    logger.info(
        "Datadog webhook received: service=%s alert=%s value=%s",
        payload.service, payload.alert_title, payload.value,
    )

    # Build a synthetic raw log from the webhook payload
    raw_log = _build_raw_log(payload)

    # Process asynchronously
    background_tasks.add_task(_process_webhook, payload, raw_log)

    return {
        "status":  "accepted",
        "service": payload.service,
        "message": "Incident queued for ingestion",
    }


@app.get("/health")
async def health():
    return {"status": "ok", "mode": "datadog_webhook", "service": settings.service_name}


# ── Internal helpers ────────────────────────────────────────────────────────

def _build_raw_log(payload: DatadogAlertPayload) -> str:
    """Construct a structured log string from the Datadog alert payload."""
    ts = payload.timestamp or datetime.utcnow().isoformat()
    title = payload.alert_title or "Datadog Monitor Alert"
    metric = payload.metric or "unknown.metric"
    value = payload.value or "N/A"
    tags = payload.tags or ""

    return (
        f"{ts} ERROR {payload.service} - {title}\n"
        f"  metric={metric} value={value} environment={payload.environment}\n"
        f"  tags={tags}\n"
        f"  alert_id={payload.alert_id}"
    )


async def _process_webhook(payload: DatadogAlertPayload, raw_log: str):
    """
    Run the LangGraph pipeline for a Datadog webhook event.
    Stores result with source='datadog_webhook'.
    """
    try:
        state = await process_log_entry(raw_log, source="datadog_webhook")
        if state.get("stored"):
            logger.info(
                "✓ Datadog webhook → Incident #%d stored (service=%s)",
                state["incident_id"], payload.service,
            )
        else:
            logger.error(
                "✗ Failed to store Datadog webhook incident: %s", state.get("error")
            )
    except Exception as exc:
        logger.exception("_process_webhook failed: %s", exc)
