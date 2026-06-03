"""
Runtime settings overlay reader.

app/main.py writes apollo_settings.json when the user saves settings via the UI.
This module reads that file so that github_tools, db, and repo_resolver can pick up
runtime key changes without a container restart.

The file is cached in-process for 5 seconds to avoid a disk read on every DB
connection — _conn_kwargs() is called on each query, so without caching a busy
system would stat/read the file hundreds of times per second.
"""
import json
import logging
import time
from pathlib import Path

logger = logging.getLogger(__name__)

_OVERLAY_PATHS = [
    Path("/app/apollo_settings.json"),                           # Docker runtime path
    Path(__file__).parent.parent / "apollo_settings.json",      # rca-agent dev root
    Path("apollo_settings.json"),                                # CWD fallback
]

_CACHE_TTL = 5.0          # seconds before re-reading from disk
_cache: dict = {}
_cache_ts: float = 0.0    # epoch when cache was last populated


def load() -> dict:
    """Return overlay dict, refreshing from disk at most once per TTL window."""
    global _cache, _cache_ts
    now = time.monotonic()
    if now - _cache_ts < _CACHE_TTL:
        return _cache

    for path in _OVERLAY_PATHS:
        if path.exists():
            try:
                _cache = json.loads(path.read_text())
                _cache_ts = now
                return _cache
            except json.JSONDecodeError as exc:
                # Corrupt mid-write — keep old cache rather than returning {}
                logger.debug("Overlay JSON error at %s (keeping cached): %s", path, exc)
                _cache_ts = now   # still advance TTL so we don't re-read every call
                return _cache
            except Exception as exc:
                logger.debug("Overlay read error at %s: %s", path, exc)

    # No file found — reset cache to empty and advance TTL
    _cache = {}
    _cache_ts = now
    return _cache


def get(key: str, default=None):
    """Return a single overlay value, or default if not set."""
    return load().get(key, default)


def invalidate():
    """Force the next read to go to disk (call after writing the overlay file)."""
    global _cache_ts
    _cache_ts = 0.0
