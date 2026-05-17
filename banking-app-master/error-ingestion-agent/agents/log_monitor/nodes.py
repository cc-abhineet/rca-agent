"""
Error Ingestion Agent — LangGraph Nodes
Implements the three-node pipeline: parse → analyze → store.

Each node receives and returns the shared graph state dict.
"""
import logging
from datetime import datetime
from typing import Any, TypedDict, Optional

from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.messages import HumanMessage

from config.settings import settings
from db.database import insert_incident
from utils.log_parser import parse_log_entry, ParsedLogEntry

logger = logging.getLogger(__name__)


# ── Shared graph state ──────────────────────────────────────────────────────

class IncidentState(TypedDict):
    # Input
    raw_log: str
    source: str                     # 'db_watcher' | 'datadog_webhook' | 'datadog_poll'

    # Service context — overrides settings.service_name / settings.environment when set.
    # Empty string means "use the env-var default" (preserves mode=db / mode=datadog behaviour).
    service_name: str
    environment: str

    # After parse node
    parsed: Optional[ParsedLogEntry]
    error_type: Optional[str]
    message: str
    severity: str
    stack_trace: Optional[str]
    timestamp: Optional[datetime]

    # After analyze node
    gemini_summary: Optional[str]
    gemini_category: Optional[str]

    # After store node
    incident_id: Optional[str]      # UUID string (was int in earlier version)
    stored: bool

    # Error tracking
    error: Optional[str]


# ── Node: parse ─────────────────────────────────────────────────────────────

def parse_node(state: IncidentState) -> IncidentState:
    """
    Parse the raw log entry into structured fields.
    Extracts: timestamp, severity, message, error_type, stack_trace.
    """
    raw_log = state["raw_log"]
    logger.info("parse_node: processing %d chars of raw log", len(raw_log))

    try:
        parsed = parse_log_entry(raw_log)

        return {
            **state,
            "parsed":      parsed,
            "error_type":  parsed.error_type,
            "message":     parsed.message or raw_log[:500],
            "severity":    parsed.severity,
            "stack_trace": parsed.stack_trace,
            "timestamp":   parsed.timestamp,
            "error":       None,
        }
    except Exception as exc:
        logger.exception("parse_node failed")
        return {
            **state,
            "parsed":      None,
            "error_type":  None,
            "message":     raw_log[:500],
            "severity":    "ERROR",
            "stack_trace": None,
            "timestamp":   None,
            "error":       str(exc),
        }


# ── Node: analyze ───────────────────────────────────────────────────────────

def analyze_node(state: IncidentState) -> IncidentState:
    """
    Use Gemini to produce a concise incident summary and error category.
    Falls back gracefully if the API call fails.
    """
    logger.info("analyze_node: calling Gemini for incident analysis")

    # Use state-level overrides (set by datadog_poll mode) or fall back to env-var defaults
    svc = state.get("service_name") or settings.service_name
    env = state.get("environment") or settings.environment

    prompt = f"""You are an incident analysis assistant. Given this log entry from a production service,
provide:
1. A one-sentence summary of what went wrong (for incident tracking)
2. An error category (one of: code_defect, config_error, dependency_failure, resource_exhaustion, external_api, unknown)

Service: {svc}
Environment: {env}
Severity: {state.get('severity', 'ERROR')}
Error Type: {state.get('error_type') or 'Unknown'}
Message: {state.get('message', '')}
Stack Trace (first 500 chars): {(state.get('stack_trace') or '')[:500]}

Respond in exactly this format:
SUMMARY: <one sentence>
CATEGORY: <category>"""

    try:
        llm = ChatGoogleGenerativeAI(
            model="gemini-2.5-flash",
            google_api_key=settings.gemini_api_key,
            temperature=0.1,
        )
        response = llm.invoke([HumanMessage(content=prompt)])
        content = response.content.strip()

        summary = ""
        category = "unknown"
        for line in content.splitlines():
            if line.startswith("SUMMARY:"):
                summary = line.removeprefix("SUMMARY:").strip()
            elif line.startswith("CATEGORY:"):
                category = line.removeprefix("CATEGORY:").strip().lower()

        logger.info("Gemini analysis: category=%s", category)
        return {
            **state,
            "gemini_summary":  summary or state.get("message", ""),
            "gemini_category": category,
        }

    except Exception as exc:
        logger.warning("analyze_node: Gemini call failed (%s), using fallback", exc)
        return {
            **state,
            "gemini_summary":  state.get("message", ""),
            "gemini_category": "unknown",
        }


# ── Node: store ─────────────────────────────────────────────────────────────

async def store_node(state: IncidentState) -> IncidentState:
    """
    Persist the parsed + analyzed incident to the unified error_logs table.

    service_name and environment are read from state first (set by datadog_poll mode
    from the Datadog log event), falling back to env-var settings for mode=db / mode=datadog.
    """
    logger.info("store_node: writing incident to MySQL")

    svc = state.get("service_name") or settings.service_name
    env = state.get("environment") or settings.environment

    try:
        incident_id = await insert_incident(
            service_name=svc,
            environment=env,
            error_type=state.get("error_type"),
            message=state.get("gemini_summary") or state.get("message", ""),
            severity=state.get("severity", "ERROR"),
            stack_trace=state.get("stack_trace"),
            raw_log=state["raw_log"],
            source=state.get("source", "db_watcher"),
            occurred_at=state.get("timestamp"),
        )
        logger.info("store_node: incident %s stored successfully", incident_id)
        return {
            **state,
            "incident_id": incident_id,
            "stored":      True,
        }

    except Exception as exc:
        logger.exception("store_node: failed to insert incident")
        return {
            **state,
            "incident_id": None,
            "stored":      False,
            "error":       str(exc),
        }
