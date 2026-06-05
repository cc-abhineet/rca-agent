"""
Error Ingestion Agent — Error Fingerprinting

Computes a deterministic fingerprint for an error so identical errors can be
de-duplicated at ingestion time, before any expensive analysis runs.

Strategy: sha256(service_name + error_type + top 3 stack frames). Fast, zero
external calls — a pure hash of the most stable parts of an error.
"""
import hashlib
import re
from typing import Optional

_WS_RE = re.compile(r"\s+")


def extract_top_frames(stack_trace: Optional[str], n: int = 3) -> list[str]:
    """
    Return up to ``n`` normalised stack frames from a raw stack trace string.

    Recognises the frame conventions the log parser emits:
      - Java / Node.js frames start with "at "
      - Python traceback frames start with 'File "'
    Falls back to the first ``n`` non-empty lines when no frame markers are found
    (e.g. Go panics, generic logs). Each frame has its whitespace collapsed so
    cosmetic indentation differences do not change the fingerprint.
    """
    if not stack_trace:
        return []

    lines = [ln.strip() for ln in stack_trace.splitlines() if ln.strip()]

    frames = [
        ln for ln in lines
        if ln.startswith("at ") or ln.startswith('File "')
    ]
    if not frames:
        frames = lines

    return [_WS_RE.sub(" ", f) for f in frames[:n]]


def compute_fingerprint(
    service_name: Optional[str],
    error_type: Optional[str],
    stack_trace: Optional[str],
) -> str:
    """
    Compute a 64-char hex sha256 fingerprint for an error.

    Combines the service, the error type, and the top 3 stack frames. When no
    stack trace is available the fingerprint reduces to service + error_type,
    matching the legacy (service, error_type) de-duplication key.
    """
    parts = [
        (service_name or "").strip().lower(),
        (error_type or "UnknownError").strip(),
        *extract_top_frames(stack_trace, 3),
    ]
    joined = "\n".join(parts)
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()
