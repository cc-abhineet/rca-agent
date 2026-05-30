"""
Error Ingestion Agent — Multi-language Log Parser

Detects and parses log entries from Java/Spring Boot, Python, Node.js, Go,
and generic text formats.  Returns a normalised ParsedLogEntry regardless of
the source language.
"""
import json
import re
import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

logger = logging.getLogger(__name__)


# ── Shared patterns ───────────────────────────────────────────────────────────

_ISO_TS_RE = re.compile(
    r"(?P<ts>\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)"
)

_LEVEL_RE = re.compile(
    r"\b(?P<level>TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|CRITICAL|SEVERE)\b",
    re.IGNORECASE,
)

_SEVERITY_MAP = {
    "TRACE": "DEBUG", "DEBUG": "DEBUG", "INFO": "INFO",
    "WARN": "WARN", "WARNING": "WARN",
    "ERROR": "ERROR", "FATAL": "FATAL",
    "CRITICAL": "FATAL", "SEVERE": "ERROR",
}


# ── Java / Spring Boot ────────────────────────────────────────────────────────

_SPRING_RE = re.compile(
    r"(?P<timestamp>\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?)"
    r"\s+(?P<severity>TRACE|DEBUG|INFO|WARN|ERROR|FATAL)"
    r"(?:\s+\d+\s+---\s+\[.*?\]\s+[\w.$]+\s+:\s+)?"
    r"\s*(?P<message>.+)"
)

_JAVA_EXCEPTION_RE = re.compile(
    r"^(?P<exception>(?:[\w$]+\.)+[\w$]*(?:Exception|Error))"
    r"(?::\s*(?P<exc_msg>.+))?$"
)

_JAVA_FRAME_RE = re.compile(r"^\s+at\s+[\w.$]+\(")

_JAVA_SHORT_EXCEPTION_RE = re.compile(
    r"(?:^|[\s:])"
    r"(NullPointerException|IllegalArgumentException|IllegalStateException|"
    r"RuntimeException|IndexOutOfBoundsException|ClassCastException|"
    r"UnsupportedOperationException|ArithmeticException|NumberFormatException|"
    r"TimeoutException|IOException|SQLException|"
    r"InsufficientFundsException|AccountNotFoundException|ChaosException|"
    r"HikariPool\$PoolInitializationException)"
)


# ── Python ────────────────────────────────────────────────────────────────────

# Standard library logging: "2024-01-15 10:30:01,123 ERROR django.request: msg"
_PYTHON_LOGGING_RE = re.compile(
    r"(?P<timestamp>\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[,.]?\d*)"
    r"\s+(?P<severity>DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL|FATAL)"
    r"(?:\s+[\w.]+)?"
    r":\s*(?P<message>.+)"
)

# logging.basicConfig default: "ERROR:root:Something went wrong"
_PYTHON_BASIC_RE = re.compile(
    r"^(?P<severity>DEBUG|INFO|WARNING|ERROR|CRITICAL):(?P<logger>\S+):(?P<message>.+)"
)

_PYTHON_EXCEPTION_RE = re.compile(
    r"^(?P<exception>[\w.]*(?:Error|Exception|Warning))"
    r"(?::\s*(?P<exc_msg>.+))?$"
)

_PYTHON_SHORT_EXCEPTION_RE = re.compile(
    r"\b(AttributeError|TypeError|ValueError|KeyError|IndexError|ImportError|"
    r"RuntimeError|NotImplementedError|OSError|IOError|FileNotFoundError|"
    r"PermissionError|TimeoutError|ConnectionError|HTTPError|"
    r"ValidationError|IntegrityError|OperationalError)\b"
)


# ── Node.js ───────────────────────────────────────────────────────────────────

# ISO 8601 timestamp (common in Node): "2024-01-15T10:30:01.123Z ERROR [module] msg"
_NODE_RE = re.compile(
    r"(?P<timestamp>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)"
    r"\s+(?P<severity>DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL)"
    r"(?:\s+\[[\w./:-]+\])?"
    r"\s*:?\s*(?P<message>.+)"
)

# Winston JSON: {"level":"error","message":"...","timestamp":"..."}
_NODE_JSON_RE = re.compile(r'^\s*\{.*"level"\s*:\s*"(?P<level>\w+)".*\}')

_NODE_ERROR_RE = re.compile(r"\b(Error|Exception|TypeError|ReferenceError|SyntaxError)\b")


# ── Go ────────────────────────────────────────────────────────────────────────

# Standard log: "2024/01/15 10:30:01 ERROR: Something went wrong"
_GO_STD_RE = re.compile(
    r"(?P<timestamp>\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2})"
    r"\s+(?P<severity>DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL)"
    r":?\s+(?P<message>.+)"
)

# Logrus/Zap structured: time="2024-01-15T10:30:01Z" level=error msg="..."
_GO_STRUCT_RE = re.compile(
    r'time="(?P<timestamp>[^"]+)"\s+level=(?P<severity>\w+)\s+msg="(?P<message>[^"]+)"'
)

_GO_PANIC_RE = re.compile(r"\bpanic\b", re.IGNORECASE)


# ── Result dataclass ──────────────────────────────────────────────────────────

@dataclass
class ParsedLogEntry:
    timestamp: Optional[datetime]
    severity: str
    message: str
    error_type: Optional[str]
    stack_trace: Optional[str]
    raw_log: str
    language: str = "unknown"


# ── Language detection ────────────────────────────────────────────────────────

def detect_language(raw_log: str) -> str:
    """
    Heuristic language detection from log content.
    Returns one of: java | python | nodejs | go | generic
    """
    first = raw_log.splitlines()[0] if raw_log.strip() else ""

    # Python traceback is very distinctive
    if "Traceback (most recent call last):" in raw_log:
        return "python"
    if _PYTHON_BASIC_RE.match(first):
        return "python"
    if _PYTHON_LOGGING_RE.match(first):
        return "python"

    # Node.js ISO timestamp
    if re.match(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", first):
        if _LEVEL_RE.search(first):
            return "nodejs"

    # Go formats
    if re.match(r"\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}", first):
        return "go"
    if first.startswith('time="') or first.startswith("time="):
        return "go"

    # Java/Spring Boot
    if "---" in first and _LEVEL_RE.search(first):
        return "java"
    if _JAVA_EXCEPTION_RE.match(first.strip()):
        return "java"
    if _JAVA_FRAME_RE.match(first):
        return "java"

    # Check subsequent lines for Java stack frames
    for line in raw_log.splitlines()[1:4]:
        if _JAVA_FRAME_RE.match(line):
            return "java"

    return "generic"


# ── Per-language parsers ──────────────────────────────────────────────────────

def _parse_timestamp(ts_str: str) -> Optional[datetime]:
    ts_str = ts_str.replace("T", " ").replace("Z", "").replace(",", ".")
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S"):
        try:
            return datetime.strptime(ts_str[:26], fmt)
        except ValueError:
            continue
    return None


def _normalise_level(raw: str) -> str:
    return _SEVERITY_MAP.get(raw.upper(), "ERROR")


def _parse_java(raw_log: str, lines: list[str]) -> ParsedLogEntry:
    first = lines[0]
    timestamp, severity, message = None, "ERROR", first.strip()

    m = _SPRING_RE.match(first)
    if m:
        timestamp = _parse_timestamp(m.group("timestamp"))
        severity  = m.group("severity")
        message   = m.group("message").strip()

    error_type  = _extract_java_error_type(message, lines)
    stack_trace = _extract_java_stack(lines)
    return ParsedLogEntry(timestamp=timestamp, severity=severity, message=message,
                          error_type=error_type, stack_trace=stack_trace,
                          raw_log=raw_log, language="java")


def _extract_java_error_type(message: str, lines: list[str]) -> Optional[str]:
    m = _JAVA_SHORT_EXCEPTION_RE.search(message)
    if m:
        return m.group(1)
    for line in lines[1:]:
        em = _JAVA_EXCEPTION_RE.match(line.strip())
        if em:
            return em.group("exception").split(".")[-1]
    return None


def _extract_java_stack(lines: list[str]) -> Optional[str]:
    start = None
    for i, line in enumerate(lines[1:], 1):
        stripped = line.strip()
        if _JAVA_EXCEPTION_RE.match(stripped) or _JAVA_FRAME_RE.match(line):
            start = i
            break
    if start is None:
        return None
    frames = lines[start:]
    return "\n".join(frames).strip() if frames else None


def _parse_python(raw_log: str, lines: list[str]) -> ParsedLogEntry:
    first = lines[0]
    timestamp, severity, message = None, "ERROR", first.strip()

    m = _PYTHON_LOGGING_RE.match(first)
    if m:
        timestamp = _parse_timestamp(m.group("timestamp"))
        severity  = _normalise_level(m.group("severity"))
        message   = m.group("message").strip()
    else:
        mb = _PYTHON_BASIC_RE.match(first)
        if mb:
            severity = _normalise_level(mb.group("severity"))
            message  = mb.group("message").strip()

    # Extract exception type
    error_type = None
    m2 = _PYTHON_SHORT_EXCEPTION_RE.search(raw_log)
    if m2:
        error_type = m2.group(1)
    if not error_type:
        for line in lines:
            em = _PYTHON_EXCEPTION_RE.match(line.strip())
            if em:
                error_type = em.group("exception").split(".")[-1]
                break

    # Extract traceback
    stack_trace = None
    tb_start = None
    for i, line in enumerate(lines):
        if "Traceback (most recent call last):" in line:
            tb_start = i
            break
    if tb_start is not None:
        stack_trace = "\n".join(lines[tb_start:]).strip()

    return ParsedLogEntry(timestamp=timestamp, severity=severity, message=message,
                          error_type=error_type, stack_trace=stack_trace,
                          raw_log=raw_log, language="python")


def _parse_nodejs(raw_log: str, lines: list[str]) -> ParsedLogEntry:
    first = lines[0]
    timestamp, severity, message = None, "ERROR", first.strip()

    # Try JSON log line (Winston etc.)
    try:
        obj = json.loads(first)
        level = obj.get("level", "error")
        severity  = _normalise_level(level)
        message   = str(obj.get("message", first))
        ts_str    = obj.get("timestamp") or obj.get("time") or ""
        if ts_str:
            timestamp = _parse_timestamp(ts_str)
    except (json.JSONDecodeError, ValueError):
        m = _NODE_RE.match(first)
        if m:
            timestamp = _parse_timestamp(m.group("timestamp"))
            severity  = _normalise_level(m.group("severity"))
            message   = m.group("message").strip()

    error_type = None
    m2 = _NODE_ERROR_RE.search(raw_log)
    if m2:
        error_type = m2.group(1)

    # Node stack frames start with "    at "
    stack_lines = [l for l in lines[1:] if l.strip().startswith("at ")]
    stack_trace = "\n".join(stack_lines) if stack_lines else None

    return ParsedLogEntry(timestamp=timestamp, severity=severity, message=message,
                          error_type=error_type, stack_trace=stack_trace,
                          raw_log=raw_log, language="nodejs")


def _parse_go(raw_log: str, lines: list[str]) -> ParsedLogEntry:
    first = lines[0]
    timestamp, severity, message = None, "ERROR", first.strip()

    m = _GO_STD_RE.match(first)
    if m:
        timestamp = _parse_timestamp(m.group("timestamp"))
        severity  = _normalise_level(m.group("severity"))
        message   = m.group("message").strip()
    else:
        ms = _GO_STRUCT_RE.match(first)
        if ms:
            timestamp = _parse_timestamp(ms.group("timestamp"))
            severity  = _normalise_level(ms.group("severity"))
            message   = ms.group("message").strip()

    error_type = None
    if _GO_PANIC_RE.search(raw_log):
        error_type = "PanicError"
    if not error_type:
        m2 = _LEVEL_RE.search(message)
        if m2 and m2.group("level").upper() in ("ERROR", "FATAL"):
            error_type = "ApplicationError"

    return ParsedLogEntry(timestamp=timestamp, severity=severity, message=message,
                          error_type=error_type, stack_trace=None,
                          raw_log=raw_log, language="go")


def _parse_generic(raw_log: str, lines: list[str]) -> ParsedLogEntry:
    """Last-resort parser for unknown log formats."""
    first = lines[0]
    timestamp, severity, message = None, "ERROR", first.strip()

    ts_m = _ISO_TS_RE.search(first)
    if ts_m:
        timestamp = _parse_timestamp(ts_m.group("ts"))

    lv_m = _LEVEL_RE.search(first)
    if lv_m:
        severity = _normalise_level(lv_m.group("level"))
        # message = everything after the level keyword
        idx = lv_m.end()
        message = first[idx:].lstrip(": ").strip() or first.strip()

    return ParsedLogEntry(timestamp=timestamp, severity=severity, message=message,
                          error_type=None, stack_trace=None,
                          raw_log=raw_log, language="generic")


# ── Service name extraction ───────────────────────────────────────────────────
#
# In a microservices architecture all services write to ONE shared log file.
# Each log line carries the originating service name in one of several formats.
# These patterns are tried in order; first match wins.

# Patterns safe to apply on ANY line (explicit tags, no risk of matching JDK classes)
_SERVICE_PATTERNS_EXACT = [
    re.compile(r'\[dd\.service=([a-zA-Z0-9_.-]+)'),                   # [dd.service=svc ...]
    re.compile(r'dd\.service=([a-zA-Z0-9_.-]+)'),                      # dd.service=svc
    re.compile(r'service[_-]?name[=:]([a-zA-Z0-9_.-]+)', re.IGNORECASE),
    re.compile(r'\bservice[=:]([a-zA-Z0-9_.-]+)', re.IGNORECASE),
    re.compile(r'^\[([a-zA-Z][a-zA-Z0-9_.-]{1,60})\]'),               # [my-service] ...
    re.compile(r'\bapp[=:]([a-zA-Z0-9_.-]+)', re.IGNORECASE),
]

# Logger-path patterns — apply ONLY to the first line of each entry.
# Results are filtered through _PACKAGE_TO_SERVICE to avoid matching
# JDK / framework package names that appear in stack traces.
_SERVICE_PATTERNS_LOGGER = [
    # Spring Boot abbreviated (Logback %logger{36}): c.d.pricing.service.PricingService
    re.compile(r'\bc\.d\.([a-z]+)\.'),
    # Spring Boot full package (class name short enough → not abbreviated):
    # com.demo.order.service.OrderService  →  "order"
    re.compile(r'\bcom\.(?:\w+)\.([a-z][a-z0-9]+)\.'),
]

# Stack-trace scan: "at com.<org>.<pkg>.ClassName" — only return if the captured
# segment maps to a known service (prevents false positives from third-party libs).
_STACK_PKG_RE = re.compile(r'\bat\s+com\.(?:\w+)\.([a-z][a-z0-9]+)\.')

# Map partial package names (from Spring Boot logger class) to service names
_PACKAGE_TO_SERVICE = {
    "banking": "banking-app",
    "order":   "order-service",
    "pricing": "pricing-service",
}


def extract_service_name(raw_log: str) -> Optional[str]:
    """
    Extract the originating service name from a log line or multi-line entry.

    Search order:
      1. Exact tag patterns (dd.service, service=, app=) on every line.
      2. Spring Boot logger-path patterns on the first line only (filtered to
         known services — prevents JDK class names from matching).
      3. Stack-trace package scan on all lines (filtered to known services).

    Returns None when no pattern matches; callers should fall back to the
    SERVICE_NAME environment variable default.
    """
    lines = [l for l in raw_log.splitlines() if l.strip()]
    if not lines:
        return None

    # Step 1: exact tags — safe on any line
    for line in lines:
        for pattern in _SERVICE_PATTERNS_EXACT:
            m = pattern.search(line)
            if m:
                name = m.group(1).strip()
                if 1 < len(name) < 64:
                    return name

    # Step 2: logger-path patterns on first line only; map to canonical service name
    first_line = lines[0]
    for pattern in _SERVICE_PATTERNS_LOGGER:
        m = pattern.search(first_line)
        if m:
            name = _PACKAGE_TO_SERVICE.get(m.group(1).strip())
            if name:
                return name

    # Step 3: stack-trace fallback — only accept known service packages
    for line in lines:
        m = _STACK_PKG_RE.search(line)
        if m:
            name = _PACKAGE_TO_SERVICE.get(m.group(1))
            if name:
                return name

    return None


# ── Public API ────────────────────────────────────────────────────────────────

def parse_log_entry(raw_log: str, language: Optional[str] = None) -> ParsedLogEntry:
    """
    Parse a raw log entry into a ParsedLogEntry.

    Args:
        raw_log:  Raw log text (single or multi-line).
        language: Hint from projects.yaml ('java', 'python', 'nodejs', 'go').
                  Auto-detected when None.
    """
    lines = raw_log.strip().splitlines()
    if not lines:
        return ParsedLogEntry(timestamp=None, severity="ERROR", message=raw_log,
                              error_type=None, stack_trace=None, raw_log=raw_log)

    lang = language or detect_language(raw_log)

    if lang == "python":
        return _parse_python(raw_log, lines)
    if lang == "nodejs":
        return _parse_nodejs(raw_log, lines)
    if lang == "go":
        return _parse_go(raw_log, lines)
    if lang == "java":
        return _parse_java(raw_log, lines)
    return _parse_generic(raw_log, lines)


def is_error_line(raw_log: str) -> bool:
    """
    Quick check: does this log entry indicate an error worth ingesting?

    WARN is intentionally excluded — it's a notification level used for expected
    operational events (e.g. "CHAOS TRIGGER") that are not incidents.  Only
    ERROR, FATAL, unhandled exceptions, and equivalent severity levels qualify.
    """
    upper = raw_log.upper()
    return (
        " ERROR " in upper or "ERROR]" in upper or "] ERROR" in upper
        or "EXCEPTION" in upper
        or "TRACEBACK" in upper          # Python
        or " FATAL " in upper
        or " PANIC" in upper             # Go
        or ":ERROR:" in upper            # Python basicConfig
        or ":CRITICAL:" in upper
    )
