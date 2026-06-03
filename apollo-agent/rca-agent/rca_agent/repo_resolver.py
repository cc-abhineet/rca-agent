import logging
from datetime import datetime, timedelta, timezone
from .config import settings
from .db import execute_one, execute
from .models import RepoMapping, DeploymentRecord
from .adapters.protocols import CICDAdapterProtocol
from .overlay import get as overlay_get

logger = logging.getLogger(__name__)


def _effective_org() -> str:
    """Return GitHub org from Settings-UI overlay, falling back to env."""
    return overlay_get("github_org") or settings.github_org


class RepoResolver:
    def __init__(self, cicd_adapter: CICDAdapterProtocol):
        self.cicd = cicd_adapter

    def resolve(self, service_name: str, environment: str, occurred_at: datetime) -> dict:
        """
        Returns: {org, repo, branch, commit_sha, deployment_record_used, discovered_via}
        """
        # Step 1: CI/CD
        since = occurred_at - timedelta(hours=48)
        deployments = self.cicd.get_recent_deployments(service_name, environment, since)
        latest = deployments[0] if deployments else None

        github_repo = latest.github_repo if latest else None
        branch = latest.branch if latest else None
        commit_sha = latest.commit_sha if latest else None
        deployment_record_used = latest is not None

        # Step 2: service_repo_map
        mapping = self._get_mapping(service_name)

        if github_repo and mapping:
            return dict(
                org=mapping.github_org, repo=github_repo, branch=branch,
                commit_sha=commit_sha, deployment_record_used=deployment_record_used,
                discovered_via="cicd+mapping",
            )

        if github_repo and not mapping:
            self._write_mapping(service_name, _effective_org(), github_repo)
            return dict(
                org=_effective_org(), repo=github_repo, branch=branch,
                commit_sha=commit_sha, deployment_record_used=deployment_record_used,
                discovered_via="cicd",
            )

        if not github_repo and mapping:
            return dict(
                org=mapping.github_org, repo=mapping.github_repo,
                branch=branch or mapping.default_branch,
                commit_sha=commit_sha, deployment_record_used=deployment_record_used,
                discovered_via="mapping",
            )

        # Step 3: sub-agent discovery
        logger.info("No repo found for %s — launching discovery sub-agent", service_name)
        from .sub_agents.repo_discovery import RepoDiscoverySubAgent
        result = RepoDiscoverySubAgent().discover(service_name)
        if "error" not in result:
            self._write_mapping(service_name, result["github_org"], result["github_repo"])
            return dict(
                org=result["github_org"], repo=result["github_repo"],
                branch=branch or "main", commit_sha=commit_sha,
                deployment_record_used=deployment_record_used,
                discovered_via="sub_agent",
            )

        raise RuntimeError(
            f"Could not resolve repo for service '{service_name}': {result}"
        )

    def _get_mapping(self, service_name: str) -> RepoMapping | None:
        row = execute_one(
            "SELECT * FROM service_repo_map WHERE service_name = %s", (service_name,)
        )
        if not row:
            return None
        return RepoMapping(
            service_name=row["service_name"],
            github_org=row["github_org"],
            github_repo=row["github_repo"],
            default_branch=row["default_branch"],
            language=row.get("language"),
        )

    def _write_mapping(self, service_name: str, org: str, repo: str) -> None:
        execute(
            """INSERT INTO service_repo_map (service_name, github_org, github_repo)
               VALUES (%s, %s, %s)
               ON DUPLICATE KEY UPDATE
                   github_org = VALUES(github_org),
                   github_repo = VALUES(github_repo)""",
            (service_name, org, repo),
        )
