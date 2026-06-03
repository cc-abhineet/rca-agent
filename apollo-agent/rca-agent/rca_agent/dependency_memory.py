"""
rca_agent/dependency_memory.py
───────────────────────────────
Persistent JSON memory layer for discovered cross-service dependencies.

The agent writes here when it first discovers that service A calls service B.
On subsequent runs, it reads this memory before doing GitHub searches —
saving API calls and time.

File format:
{
    "order-service": {
        "upstream": "pricing-service",
        "upstream_repo": "pricing-service",
        "evidence": "PricingClient calls POST /api/v1/pricing",
        "breaking_change": "discountRate field rename in v2.1.0",
        "upstream_branch": "main",
        "recorded_at": "2026-01-10T14:30:00+00:00"
    },
    ...
}

Functions are safe to call concurrently from multiple threads — writes are
atomic (write to temp file then rename).
"""

import json
import logging
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import settings

logger = logging.getLogger(__name__)


def _memory_path() -> Path:
    """Return the resolved path to the dependency memory JSON file."""
    p = getattr(settings, "dependency_memory_path", None)
    if p:
        return Path(p)
    return Path(__file__).parent / "dependency_memory.json"


def _load() -> dict[str, Any]:
    """Load the memory file, returning empty dict if missing or corrupt."""
    path = _memory_path()
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning("dependency_memory: could not load %s: %s", path, exc)
        return {}


def _save(data: dict[str, Any]) -> None:
    """Atomically write the memory dict to disk."""
    path = _memory_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        # Write to a temp file in the same directory, then rename (atomic on POSIX)
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            delete=False,
            suffix=".tmp",
        ) as tmp:
            json.dump(data, tmp, indent=2, default=str)
            tmp_path = tmp.name
        os.replace(tmp_path, path)
    except Exception as exc:
        logger.warning("dependency_memory: could not save %s: %s", path, exc)


def read_dependency_memory(downstream_service: str | None = None) -> dict:
    """
    Read known dependencies from persistent memory.

    Args:
        downstream_service: If provided, return only the entry for this service.
                            If None, return all known dependencies.

    Returns:
        {
            "found": bool,
            "dependencies": {service_name: {upstream, upstream_repo, evidence, ...}},
            "total_known": int,
        }
    """
    data = _load()
    if downstream_service:
        entry = data.get(downstream_service)
        return {
            "found": entry is not None,
            "dependencies": {downstream_service: entry} if entry else {},
            "total_known": len(data),
        }
    return {
        "found": bool(data),
        "dependencies": data,
        "total_known": len(data),
    }


def write_dependency_memory(
    downstream_service: str,
    upstream_service: str,
    upstream_repo: str,
    evidence: str,
    breaking_change: str | None = None,
    upstream_branch: str = "main",
) -> dict:
    """
    Persist a newly discovered service dependency.

    Upserts: if the downstream_service already has an entry, it is overwritten
    with the new information.

    Args:
        downstream_service: The service that has the bug / calls upstream.
        upstream_service:   The upstream service whose change caused the issue.
        upstream_repo:      GitHub repo name for the upstream service.
        evidence:           Short description of how the dependency was discovered.
        breaking_change:    Optional description of the breaking change found.
        upstream_branch:    Branch to use when fetching upstream source (default: main).

    Returns:
        {"status": "ok", "downstream": ..., "upstream": ..., "path": ...}
    """
    data = _load()
    data[downstream_service] = {
        "upstream": upstream_service,
        "upstream_repo": upstream_repo,
        "evidence": evidence,
        "breaking_change": breaking_change,
        "upstream_branch": upstream_branch,
        "recorded_at": datetime.now(timezone.utc).isoformat(),
    }
    _save(data)
    logger.info(
        "dependency_memory: recorded %s → %s (repo: %s)",
        downstream_service,
        upstream_service,
        upstream_repo,
    )
    return {
        "status": "ok",
        "downstream": downstream_service,
        "upstream": upstream_service,
        "path": str(_memory_path()),
    }
