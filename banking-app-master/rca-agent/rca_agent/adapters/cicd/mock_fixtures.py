from datetime import datetime, timedelta, timezone
from ...models import DeploymentRecord

# Use relative timestamps so the demo works regardless of when it's run.
# The RepoResolver looks back 48 hours from occurred_at — since demo_seed_data.py
# seeds occurred_at = NOW(), keeping deployments a few hours in the past
# ensures they always fall inside that window.
_NOW = datetime.now(timezone.utc)

MOCK_DEPLOYMENTS: dict[str, list[DeploymentRecord]] = {
    "payment-service": [
        DeploymentRecord(
            service_name="payment-service",
            environment="production",
            github_repo="payment-service",
            branch="main",
            commit_sha="1d3bcda3f0f36d0cf39dfa6a6734ad91468b31c1",
            commit_message="perf: streamline charge_card hot path",
            deployed_at=_NOW - timedelta(hours=6),
            deployer="jane.doe",
            pipeline_id="run-8821",
            pipeline_url="https://ci.internal/runs/8821",
            status="success",
        )
    ],
    "order-service": [
        DeploymentRecord(
            service_name="order-service",
            environment="production",
            github_repo="order-service",
            branch="main",
            commit_sha="7f036bbf7c0159f0e5a631a0e2bb0ce51c6435be",
            commit_message="chore: upgrade dependencies, pydantic to v2",
            deployed_at=_NOW - timedelta(hours=7, minutes=15),
            deployer="bob.smith",
            pipeline_id="run-8819",
            pipeline_url="https://ci.internal/runs/8819",
            status="success",
        )
    ],
    "notification-service": [
        DeploymentRecord(
            service_name="notification-service",
            environment="staging",
            github_repo=None,  # intentionally absent — forces sub-agent discovery
            branch="main",
            commit_sha="a3ec7a9227917cc776ff0d6c7d69f694cb920490",
            commit_message="refactor: simplify env var access",
            deployed_at=_NOW - timedelta(hours=8, minutes=30),
            deployer="alice.chen",
            pipeline_id="run-8815",
            pipeline_url="https://ci.internal/runs/8815",
            status="success",
        )
    ],
}
