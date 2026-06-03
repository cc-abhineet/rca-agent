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
from db.database import insert_incident, log_token_usage_sync
from utils.log_parser import parse_log_entry, ParsedLogEntry
from utils.severity_rules import get_known_severity, format_rules_for_prompt

_GEMINI_MODEL = "gemini-2.5-flash"
_GEMINI_INPUT_PRICE_PER_M  = 0.15   # USD per 1M input tokens (non-thinking)
_GEMINI_OUTPUT_PRICE_PER_M = 0.60   # USD per 1M output tokens (non-thinking)

logger = logging.getLogger(__name__)


# ── Shared graph state ──────────────────────────────────────────────────────

class IncidentState(TypedDict):
    # Input
    raw_log: str
    source: str                      # 'db_watcher' | 'datadog_webhook' | 'datadog_poll'

    # Service context — overrides settings.service_name / settings.environment when set.
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
    gemini_analysis: Optional[str]
    gemini_suggestions: Optional[str]
    risk_level: Optional[str]        # critical | high | medium | low

    # After store node
    incident_id: Optional[str]
    stored: bool

    # Error tracking
    error: Optional[str]


# ── Node: parse ─────────────────────────────────────────────────────────────

def _infer_error_type(raw_log: str, parsed_error_type: str | None) -> str:
    """Return a non-null error_type, inferring from raw log text when parser finds nothing."""
    if parsed_error_type:
        return parsed_error_type
    upper = raw_log.upper()
    if "NULLPOINTER" in upper or "NPE" in upper:
        return "NullPointerException"
    if "ILLEGALARGUMENT" in upper:
        return "IllegalArgumentException"
    if "ILLEGALSTATE" in upper:
        return "IllegalStateException"
    if "TIMEOUT" in upper or "TIMED OUT" in upper:
        return "TimeoutException"
    if "CONNECTION" in upper and ("REFUSED" in upper or "FAILED" in upper):
        return "ConnectionError"
    if "OUTOFMEMORY" in upper or "OUT OF MEMORY" in upper:
        return "OutOfMemoryError"
    if "STACKOVERFLOW" in upper:
        return "StackOverflowError"
    if "EXCEPTION" in upper:
        return "UnhandledException"
    if "ERROR" in upper:
        return "ApplicationError"
    return "UnknownError"


def parse_node(state: IncidentState) -> IncidentState:
    """Parse the raw log entry into structured fields."""
    raw_log = state["raw_log"]
    logger.info("parse_node: processing %d chars of raw log", len(raw_log))

    try:
        parsed = parse_log_entry(raw_log)
        error_type = _infer_error_type(raw_log, parsed.error_type)
        message = parsed.message or raw_log[:500]

        return {
            **state,
            "parsed":      parsed,
            "error_type":  error_type,
            "message":     message,
            "severity":    parsed.severity or "ERROR",
            "stack_trace": parsed.stack_trace,
            "timestamp":   parsed.timestamp,
            "error":       None,
        }
    except Exception as exc:
        logger.exception("parse_node failed")
        error_type = _infer_error_type(raw_log, None)
        return {
            **state,
            "parsed":      None,
            "error_type":  error_type,
            "message":     raw_log[:500],
            "severity":    "ERROR",
            "stack_trace": None,
            "timestamp":   None,
            "error":       str(exc),
        }


# ── Node: analyze ───────────────────────────────────────────────────────────

def analyze_node(state: IncidentState) -> IncidentState:
    """
    Use Gemini to produce a concise incident summary, root-cause analysis,
    suggested fixes, error category, and risk level.

    Severity is determined by matching the exception type against a pre-defined
    classification table embedded in the prompt.  If no match is found, Gemini
    classifies the severity itself.
    """
    logger.info("analyze_node: calling Gemini for incident analysis")

    svc = state.get("service_name") or settings.service_name
    env = state.get("environment") or settings.environment
    error_type = state.get("error_type") or "Unknown"
    stack_preview = (state.get("stack_trace") or "")[:500]

    # Check if exception maps to a pre-defined severity
    known_severity = get_known_severity(error_type)
    if known_severity:
        severity_instruction = (
            f'The exception "{error_type}" is in the classification table above '
            f'and maps to: {known_severity.upper()}. Use this severity.'
        )
    else:
        severity_instruction = (
            f'The exception "{error_type}" is NOT in the classification table. '
            f'Use your judgment to assign low, medium, high, or critical based on the log context.'
        )

    prompt = f"""You are a production incident analysis assistant.

## Severity Classification Table
Use this table to determine SEVERITY. If the exception type matches, use that level exactly.
{format_rules_for_prompt()}

## Incident Details
Service:     {svc}
Environment: {env}
Log Level:   {state.get('severity', 'ERROR')}
Error Type:  {error_type}
Message:     {state.get('message', '')}
Stack Trace (first 500 chars):
{stack_preview}

## Severity Instruction
{severity_instruction}

## Required Response Format
Respond using EXACTLY these five labelled lines — no extra text, no bullet points, no markdown.
Keep ANALYSIS under 40 words. Keep each SUGGESTION under 12 words.

SUMMARY: <one sentence — what broke and where>
CATEGORY: <one of: code_defect | config_error | dependency_failure | resource_exhaustion | external_api | unknown>
SEVERITY: <one of: critical | high | medium | low>
ANALYSIS: <max 40 words — probable root cause and blast radius>
SUGGESTIONS: <fix 1, max 12 words>; <fix 2, max 12 words>; <fix 3, max 12 words>"""

    if not settings.gemini_api_key:
        logger.warning("analyze_node: GEMINI_API_KEY not set — skipping Gemini analysis")
        return {
            **state,
            "gemini_summary":     state.get("message", ""),
            "gemini_category":    "unknown",
            "gemini_analysis":    "",
            "gemini_suggestions": "",
            "risk_level":         known_severity or "medium",
        }

    try:
        llm = ChatGoogleGenerativeAI(
            model=_GEMINI_MODEL,
            google_api_key=settings.gemini_api_key,
            temperature=0.1,
        )
        response = llm.invoke([HumanMessage(content=prompt)])
        content = response.content.strip()

        # Log real token counts from the API response
        try:
            meta = getattr(response, "usage_metadata", {}) or {}
            in_tok  = int(meta.get("input_tokens", 0)  or 0)
            out_tok = int(meta.get("output_tokens", 0) or 0)
            if in_tok or out_tok:
                cost = round(
                    (in_tok  / 1_000_000) * _GEMINI_INPUT_PRICE_PER_M +
                    (out_tok / 1_000_000) * _GEMINI_OUTPUT_PRICE_PER_M,
                    8,
                )
                log_token_usage_sync(_GEMINI_MODEL, "gemini_analysis", in_tok, out_tok, cost)
        except Exception:
            pass

        summary = ""
        category = "unknown"
        risk_level = known_severity or "medium"
        analysis = ""
        suggestions = ""

        for line in content.splitlines():
            if line.startswith("SUMMARY:"):
                summary = line.removeprefix("SUMMARY:").strip()
            elif line.startswith("CATEGORY:"):
                category = line.removeprefix("CATEGORY:").strip().lower()
            elif line.startswith("SEVERITY:"):
                val = line.removeprefix("SEVERITY:").strip().lower()
                if val in ("critical", "high", "medium", "low"):
                    # Only allow Gemini to override if no pre-defined rule applies
                    risk_level = known_severity or val
            elif line.startswith("ANALYSIS:"):
                analysis = line.removeprefix("ANALYSIS:").strip()
            elif line.startswith("SUGGESTIONS:"):
                suggestions = line.removeprefix("SUGGESTIONS:").strip()

        logger.info(
            "Gemini analysis: category=%s risk_level=%s", category, risk_level
        )
        return {
            **state,
            "gemini_summary":     summary or state.get("message", ""),
            "gemini_category":    category,
            "gemini_analysis":    analysis,
            "gemini_suggestions": suggestions,
            "risk_level":         risk_level,
        }

    except Exception as exc:
        logger.warning("analyze_node: Gemini call failed (%s), using fallback", exc)
        return {
            **state,
            "gemini_summary":     state.get("message", ""),
            "gemini_category":    "unknown",
            "gemini_analysis":    "",
            "gemini_suggestions": "",
            "risk_level":         known_severity or "medium",
        }


# ── Node: store ─────────────────────────────────────────────────────────────

async def store_node(state: IncidentState) -> IncidentState:
    """
    Persist the parsed + analyzed incident to the unified error_logs table.
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
            gemini_category=state.get("gemini_category"),
            gemini_analysis=state.get("gemini_analysis"),
            gemini_suggestions=state.get("gemini_suggestions"),
            risk_level=state.get("risk_level"),
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
