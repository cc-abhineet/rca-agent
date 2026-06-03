from typing import Protocol
from datetime import datetime
from ..models import ErrorLogEntry, DeploymentRecord


class ObservabilityAdapterProtocol(Protocol):
    def get_error_log(self, error_id: str) -> ErrorLogEntry: ...
    def get_service_metadata(self, service_name: str) -> dict: ...


class CICDAdapterProtocol(Protocol):
    def get_recent_deployments(
        self,
        service_name: str,
        environment: str,
        since: datetime,
        limit: int = 5,
    ) -> list[DeploymentRecord]: ...
