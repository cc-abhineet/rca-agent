"""
RCA agent eval suite.
Runs 10 test cases, each scored on 4 axes (total 100 points).
Passing threshold: ≥ 80 points.

Usage:
    pytest evals/ -v
    pytest evals/ -v -k "payment-service"
"""
import pytest
import responses as resp_lib
from rca_agent.agent import RCAAgent
from rca_agent.adapters.cicd.mock_adapter import MockCICDAdapter
from rca_agent.adapters.cicd.mock_fixtures import MOCK_DEPLOYMENTS
from rca_agent.models import DeploymentRecord
from .fixtures import EVAL_FIXTURES
from .github_mocks import setup_github_mocks
from .mock_obs_adapter import MockObsAdapter


class _SingleDeploymentCICDAdapter:
    """Wraps a single DeploymentRecord dict for eval cases."""

    def __init__(self, deployment_dict: dict | None):
        self._records = []
        if deployment_dict:
            from datetime import datetime, timezone
            dep_at = deployment_dict.get("deployed_at")
            if isinstance(dep_at, str):
                dep_at = datetime.fromisoformat(dep_at.replace("Z", "+00:00"))
            self._records = [
                DeploymentRecord(
                    service_name=deployment_dict["service_name"],
                    environment=deployment_dict["environment"],
                    branch=deployment_dict.get("branch", "main"),
                    commit_sha=deployment_dict.get("commit_sha", ""),
                    deployed_at=dep_at,
                    status=deployment_dict.get("status", "success"),
                    github_repo=deployment_dict.get("github_repo"),
                    commit_message=deployment_dict.get("commit_message"),
                    deployer=deployment_dict.get("deployer"),
                    pipeline_id=deployment_dict.get("pipeline_id"),
                    pipeline_url=deployment_dict.get("pipeline_url"),
                )
            ]

    def get_recent_deployments(self, service_name, environment, since, limit=5):
        return [
            r for r in self._records
            if r.service_name == service_name
            and r.environment == environment
            and r.status == "success"
        ][:limit]


@pytest.mark.parametrize("case", EVAL_FIXTURES, ids=[f["name"] for f in EVAL_FIXTURES])
@resp_lib.activate
def test_eval_case(case, tmp_path, monkeypatch):
    """Run a single eval case end-to-end with mocked GitHub + CI/CD."""

    # Patch the DB cache so it doesn't need a real PostgreSQL connection
    monkeypatch.setattr(
        "rca_agent.agent.read_cache", lambda svc, key: None
    )
    monkeypatch.setattr(
        "rca_agent.agent.write_cache", lambda svc, key, content, commit_sha=None: None
    )
    monkeypatch.setattr(
        "rca_agent.agent.append_rca_history", lambda svc, summary: None
    )
    monkeypatch.setattr(
        "rca_agent.agent.RCAAgent._persist", lambda self, report, error_log_id: None
    )
    monkeypatch.setattr(
        "rca_agent.repo_resolver.RepoResolver._get_mapping", lambda self, svc: None
    )
    monkeypatch.setattr(
        "rca_agent.repo_resolver.RepoResolver._write_mapping",
        lambda self, svc, org, repo: None,
    )

    # Setup mocked GitHub HTTP calls
    setup_github_mocks(case)

    # Build adapters
    obs_adapter = MockObsAdapter(case["error_log"])
    cicd_adapter = _SingleDeploymentCICDAdapter(case.get("mock_deployment"))

    agent = RCAAgent(obs_adapter=obs_adapter, cicd_adapter=cicd_adapter)
    report = agent.run(case["error_log"]["id"])

    gt = case["ground_truth"]
    score = 0
    details = []

    # Axis 1 — correct repo (20 pts)
    if gt["repo"].lower() in report.root_cause.code_reference.repo.lower():
        score += 20
        details.append("✓ repo (20)")
    else:
        details.append(
            f"✗ repo: expected '{gt['repo']}', got '{report.root_cause.code_reference.repo}'"
        )

    # Axis 2 — correct file (25 pts)
    if gt["file"].lower() in report.root_cause.code_reference.file.lower():
        score += 25
        details.append("✓ file (25)")
    else:
        details.append(
            f"✗ file: expected '{gt['file']}', got '{report.root_cause.code_reference.file}'"
        )

    # Axis 3 — root cause keywords (30 pts)
    summary_lower = report.root_cause.summary.lower()
    matched_kw = [kw for kw in gt["root_cause_keywords"] if kw.lower() in summary_lower]
    if matched_kw:
        score += 30
        details.append(f"✓ keyword matched: {matched_kw[0]} (30)")
    else:
        details.append(f"✗ keywords: none of {gt['root_cause_keywords']} in summary")

    # Axis 4 — fix area in suggestion (25 pts)
    if report.suggested_solutions:
        sol_text = " ".join(
            s.title + " " + s.description for s in report.suggested_solutions
        ).lower()
        if gt["fix_area"].lower() in sol_text:
            score += 25
            details.append(f"✓ fix area '{gt['fix_area']}' (25)")
        else:
            details.append(f"✗ fix area: '{gt['fix_area']}' not in solutions")
    else:
        details.append("✗ no suggested solutions")

    print(f"\n{'='*60}")
    print(f"Case: {case['name']} — Score: {score}/100")
    for d in details:
        print(f"  {d}")
    print(f"  Root cause: {report.root_cause.summary[:120]}...")
    print(f"  Confidence: {report.root_cause.confidence}")
    print(f"  Iterations: {report.analysis_metadata.react_iterations}")

    assert score >= 80, (
        f"Case '{case['name']}' scored {score}/100 (need ≥80)\n"
        + "\n".join(details)
    )
