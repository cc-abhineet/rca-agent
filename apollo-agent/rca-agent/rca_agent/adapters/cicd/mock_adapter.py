from datetime import datetime
from ...models import DeploymentRecord
from .mock_fixtures import MOCK_DEPLOYMENTS


class MockCICDAdapter:
    def get_recent_deployments(
        self,
        service_name: str,
        environment: str,
        since: datetime,
        limit: int = 5,
    ) -> list[DeploymentRecord]:
        records = MOCK_DEPLOYMENTS.get(service_name, [])
        filtered = [
            r for r in records
            if r.environment == environment
            and r.deployed_at >= since
            and r.status == "success"
        ]
        return sorted(filtered, key=lambda r: r.deployed_at, reverse=True)[:limit]
