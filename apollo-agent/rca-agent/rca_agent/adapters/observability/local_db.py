import json
from datetime import datetime, timezone
from ...db import execute_one, json_loads
from ...models import ErrorLogEntry


class LocalDBAdapter:
    def get_error_log(self, error_id: str) -> ErrorLogEntry:
        row = execute_one("SELECT * FROM error_logs WHERE id = %s", (error_id,))
        if not row:
            raise ValueError(f"Error log {error_id} not found")

        # MySQL returns JSON columns as strings — parse them explicitly
        stack_trace = json_loads(row["stack_trace"]) or []
        metadata = json_loads(row.get("metadata")) or {}

        # MySQL DATETIME columns come back from PyMySQL as naive datetimes.
        # The rest of the codebase (mock deployments, etc.) uses tz-aware UTC,
        # so we normalize here at the adapter boundary. We assume stored timestamps
        # are UTC, which matches NOW() on a UTC-configured MySQL server.
        occurred_at = row["occurred_at"]
        if occurred_at is not None and occurred_at.tzinfo is None:
            occurred_at = occurred_at.replace(tzinfo=timezone.utc)

        return ErrorLogEntry(
            id=str(row["id"]),
            service_name=row["service_name"],
            environment=row["environment"],
            error_type=row["error_type"],
            error_message=row["error_message"],
            stack_trace=stack_trace,
            severity=row["severity"],
            occurred_at=occurred_at,
            request_id=row.get("request_id"),
            metadata=metadata,
        )

    def get_service_metadata(self, service_name: str) -> dict:
        return {"service_name": service_name}
