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
            commit_sha="2bb8395cc16d7c7d09e4da304ac566ec405c7c67",
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
            commit_sha="d3adb33f",
            commit_message="refactor: normalise cart quantity to 0-indexed internal array",
            deployed_at=_NOW - timedelta(hours=4),
            deployer="carlos.rivera",
            pipeline_id="run-9002",
            pipeline_url="https://ci.internal/runs/9002",
            status="success",
        )
    ],
    "pricing-service": [
        DeploymentRecord(
            service_name="pricing-service",
            environment="production",
            github_repo="pricing-service",
            branch="main",
            commit_sha="abc1234f",
            commit_message="feat: rename discount to discountRate to align with pricing taxonomy v2.1.0",
            deployed_at=_NOW - timedelta(hours=6),
            deployer="alice.chen",
            pipeline_id="run-9001",
            pipeline_url="https://ci.internal/runs/9001",
            status="success",
        )
    ],
    "notification-service": [
        DeploymentRecord(
            service_name="notification-service",
            environment="staging",
            github_repo=None,  # intentionally absent — forces sub-agent discovery
            branch="main",
            commit_sha="953a44e24a07981479c3981e4ff7c49d4cb75227",
            commit_message="refactor: simplify env var access",
            deployed_at=_NOW - timedelta(hours=8, minutes=30),
            deployer="alice.chen",
            pipeline_id="run-8815",
            pipeline_url="https://ci.internal/runs/8815",
            status="success",
        )
    ],
}
