"""
GitHub API mocks for eval suite.
Uses the `responses` library to intercept PyGithub HTTP calls.
"""
import base64
import json
import responses as resp_lib

GITHUB_BASE = "https://api.github.com"
ORG = "oscorpAI"


def _b64(text: str) -> str:
    return base64.b64encode(text.encode()).decode()


def _repo_url(repo: str) -> str:
    return f"{GITHUB_BASE}/repos/{ORG}/{repo}"


def setup_github_mocks(case: dict) -> None:
    """Register all mocked GitHub endpoints for a given eval fixture."""
    deployment = case.get("mock_deployment")
    diff = case.get("mock_commit_diff", {})
    files = case.get("mock_github_files", {})

    # Derive repo name
    repo = (
        deployment["github_repo"]
        if deployment and deployment.get("github_repo")
        else case["ground_truth"]["repo"]
    )
    commit_sha = diff.get("sha", "abc1234")

    # ── File content endpoints ─────────────────────────────────────────────
    for path, content in files.items():
        resp_lib.add(
            resp_lib.GET,
            f"{_repo_url(repo)}/contents/{path}",
            json={
                "type": "file",
                "encoding": "base64",
                "name": path.split("/")[-1],
                "path": path,
                "sha": "file-sha-" + path[:8].replace("/", "-"),
                "size": len(content),
                "content": _b64(content) + "\n",
                "html_url": f"https://github.com/{ORG}/{repo}/blob/main/{path}",
            },
            status=200,
        )
        # Also serve at commit SHA ref
        resp_lib.add(
            resp_lib.GET,
            f"{_repo_url(repo)}/contents/{path}",
            json={
                "type": "file",
                "encoding": "base64",
                "name": path.split("/")[-1],
                "path": path,
                "sha": "file-sha-" + path[:8].replace("/", "-"),
                "size": len(content),
                "content": _b64(content) + "\n",
                "html_url": f"https://github.com/{ORG}/{repo}/blob/{commit_sha}/{path}",
            },
            status=200,
        )

    # ── Commit diff endpoint ───────────────────────────────────────────────
    if diff:
        resp_lib.add(
            resp_lib.GET,
            f"{_repo_url(repo)}/commits/{commit_sha}",
            json={
                "sha": commit_sha,
                "commit": {
                    "message": diff.get("message", ""),
                    "author": {
                        "name": diff.get("author", "dev"),
                        "date": diff.get("date", "2026-05-13T10:00:00Z"),
                    },
                },
                "stats": {"additions": 5, "deletions": 5, "total": 10},
                "files": [
                    {
                        "filename": f["filename"],
                        "status": f["status"],
                        "additions": f.get("additions", 1),
                        "deletions": f.get("deletions", 0),
                        "patch": f.get("patch", ""),
                        "blob_url": f"https://github.com/{ORG}/{repo}/blob/{commit_sha}/{f['filename']}",
                    }
                    for f in diff.get("files", [])
                ],
            },
            status=200,
        )

    # ── Repo root listing ──────────────────────────────────────────────────
    resp_lib.add(
        resp_lib.GET,
        f"{_repo_url(repo)}/contents/",
        json=[
            {"type": "dir", "path": "src", "name": "src", "size": 0},
            {"type": "file", "path": "pyproject.toml", "name": "pyproject.toml", "size": 512},
            {"type": "file", "path": "README.md", "name": "README.md", "size": 256},
        ],
        status=200,
    )

    # ── Repo metadata ──────────────────────────────────────────────────────
    resp_lib.add(
        resp_lib.GET,
        f"{_repo_url(repo)}",
        json={
            "id": 12345,
            "name": repo,
            "full_name": f"{ORG}/{repo}",
            "default_branch": "main",
            "private": True,
            "language": "Python",
        },
        status=200,
    )

    # ── Commits list (for get_commits_since) ──────────────────────────────
    resp_lib.add(
        resp_lib.GET,
        f"{_repo_url(repo)}/commits",
        json=[
            {
                "sha": commit_sha,
                "commit": {
                    "message": diff.get("message", ""),
                    "author": {
                        "name": diff.get("author", "dev"),
                        "date": diff.get("date", "2026-05-13T10:00:00Z"),
                    },
                },
            }
        ],
        status=200,
    )

    # ── Code search (for sub-agent discovery, Case 3) ─────────────────────
    resp_lib.add(
        resp_lib.GET,
        f"{GITHUB_BASE}/search/code",
        json={
            "total_count": 1,
            "items": [
                {
                    "name": "pyproject.toml",
                    "path": "pyproject.toml",
                    "sha": "search-sha",
                    "html_url": f"https://github.com/{ORG}/{repo}/blob/main/pyproject.toml",
                    "repository": {
                        "name": repo,
                        "full_name": f"{ORG}/{repo}",
                    },
                }
            ],
        },
        status=200,
    )
