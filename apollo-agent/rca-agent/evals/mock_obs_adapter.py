"""
In-memory observability adapter for evals.
Returns fixture error log data without hitting the database.
"""
from datetime import datetime, timezone
from rca_agent.models import ErrorLogEntry


class MockObsAdapter:
    def __init__(self, error_log_dict: dict):
        self._data = error_log_dict

    def get_error_log(self, error_id: str) -> ErrorLogEntry:
        d = self._data
        occurred_at = d.get("occurred_at")
        if isinstance(occurred_at, str):
            occurred_at = datetime.fromisoformat(
                occurred_at.replace("Z", "+00:00")
            )
        return ErrorLogEntry(
            id=d["id"],
            service_name=d["service_name"],
            environment=d["environment"],
            error_type=d["error_type"],
            error_message=d["error_message"],
            stack_trace=d["stack_trace"],
            severity=d["severity"],
            occurred_at=occurred_at,
            request_id=d.get("request_id"),
            metadata=d.get("metadata", {}),
        )

    def get_service_metadata(self, service_name: str) -> dict:
        return {"service_name": service_name}
