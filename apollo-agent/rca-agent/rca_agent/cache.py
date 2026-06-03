import json
import logging
from datetime import datetime, timezone
from .db import execute, execute_one, json_loads

logger = logging.getLogger(__name__)


def read_cache(service_name: str, cache_key: str) -> dict | None:
    row = execute_one(
        """SELECT content, invalidated_at FROM service_context_cache
           WHERE service_name = %s AND cache_key = %s""",
        (service_name, cache_key)
    )
    if not row or row["invalidated_at"] is not None:
        return None
    logger.debug("Cache HIT: %s / %s", service_name, cache_key)
    execute(
        "UPDATE service_context_cache SET last_used_at = NOW() WHERE service_name = %s AND cache_key = %s",
        (service_name, cache_key)
    )
    return json_loads(row["content"])


def write_cache(service_name: str, cache_key: str, content: dict, commit_sha: str | None = None) -> None:
    execute(
        """INSERT INTO service_context_cache (service_name, cache_key, content, commit_sha)
           VALUES (%s, %s, %s, %s)
           ON DUPLICATE KEY UPDATE
               content = VALUES(content),
               commit_sha = VALUES(commit_sha),
               created_at = NOW(),
               last_used_at = NOW(),
               invalidated_at = NULL""",
        (service_name, cache_key, json.dumps(content), commit_sha)
    )
    logger.debug("Cache WRITE: %s / %s", service_name, cache_key)


def invalidate_service_cache(service_name: str, new_commit_sha: str) -> None:
    """Invalidate file and tree caches when a new deployment is detected."""
    execute(
        """UPDATE service_context_cache
           SET invalidated_at = NOW()
           WHERE service_name = %s
             AND (cache_key LIKE 'file:%%' OR cache_key = 'repo_tree')
             AND (commit_sha IS NULL OR commit_sha != %s)""",
        (service_name, new_commit_sha)
    )


def append_rca_history(service_name: str, summary: dict) -> None:
    existing = read_cache(service_name, "rca_history") or {"entries": []}
    entries = existing.get("entries", [])
    entries.append(summary)
    entries = entries[-10:]  # keep last 10
    write_cache(service_name, "rca_history", {"entries": entries})
