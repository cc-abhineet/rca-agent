import logging
from github import Github, GithubException
from .config import settings

logger = logging.getLogger(__name__)
_gh = None


def _client() -> Github:
    global _gh
    if _gh is None:
        _gh = Github(settings.github_pat)
    return _gh


def get_repo_file(org: str, repo: str, path: str, ref: str = "main") -> dict:
    """Fetch file content from GitHub at a specific ref (branch or commit SHA)."""
    try:
        r = _client().get_repo(f"{org}/{repo}")
        f = r.get_contents(path, ref=ref)
        return {"path": path, "content": f.decoded_content.decode("utf-8"), "sha": f.sha}
    except GithubException as e:
        logger.warning("get_repo_file failed: %s/%s/%s@%s — %s", org, repo, path, ref, e)
        return {"error": str(e), "path": path}


def list_repo_files(org: str, repo: str, directory: str = "", ref: str = "main") -> dict:
    """List files in a directory (flat, not recursive)."""
    try:
        r = _client().get_repo(f"{org}/{repo}")
        contents = r.get_contents(directory or "", ref=ref)
        if not isinstance(contents, list):
            contents = [contents]
        files = [{"path": c.path, "type": c.type, "size": c.size} for c in contents]
        return {"directory": directory or "/", "files": files}
    except GithubException as e:
        logger.warning("list_repo_files failed: %s/%s/%s — %s", org, repo, directory, e)
        return {"error": str(e)}


def search_code_in_repo(org: str, repo: str, query: str) -> dict:
    """Search for a string or symbol within a repo."""
    try:
        full_query = f"{query} repo:{org}/{repo}" if repo else f"{query} org:{org}"
        results = _client().search_code(full_query)
        items = [{"path": r.path, "url": r.html_url} for r in list(results)[:10]]
        return {"query": query, "results": items}
    except GithubException as e:
        logger.warning("search_code_in_repo failed: %s — %s", query, e)
        return {"error": str(e), "results": []}


def get_commit_diff(org: str, repo: str, commit_sha: str) -> dict:
    """Get the diff for a specific commit."""
    try:
        r = _client().get_repo(f"{org}/{repo}")
        commit = r.get_commit(commit_sha)
        files = []
        for f in commit.files:
            files.append({
                "filename": f.filename,
                "status": f.status,
                "additions": f.additions,
                "deletions": f.deletions,
                "patch": f.patch or "",
            })
        return {
            "sha": commit_sha,
            "message": commit.commit.message,
            "author": commit.commit.author.name,
            "date": commit.commit.author.date.isoformat(),
            "files": files,
        }
    except GithubException as e:
        logger.warning("get_commit_diff failed: %s@%s — %s", repo, commit_sha, e)
        return {"error": str(e)}


def get_commits_since(org: str, repo: str, branch: str, since: str) -> dict:
    """List commits on a branch since a given ISO timestamp."""
    try:
        from datetime import datetime
        r = _client().get_repo(f"{org}/{repo}")
        since_dt = datetime.fromisoformat(since.replace("Z", "+00:00"))
        commits = r.get_commits(sha=branch, since=since_dt)
        items = [
            {
                "sha": c.sha,
                "message": c.commit.message,
                "author": c.commit.author.name,
                "date": c.commit.author.date.isoformat(),
            }
            for c in list(commits)[:20]
        ]
        return {"branch": branch, "commits": items}
    except GithubException as e:
        logger.warning("get_commits_since failed: %s/%s — %s", repo, branch, e)
        return {"error": str(e), "commits": []}


def search_github_global(
    query: str,
    org: str | None = None,
    max_results: int = 15,
) -> dict:
    """Search code across all repos in an org (or GitHub-wide if org is None).

    Useful for cross-service investigation: find which other repos reference a
    class, field name, or HTTP endpoint that may be the source of a breakage.

    Args:
        query:       Code search term (e.g. 'PricingResponseDto discount').
        org:         GitHub organisation to scope the search (recommended).
                     If None, searches across all of GitHub.
        max_results: Maximum number of results to return (default: 15).

    Returns:
        {
            "results": [{"repo", "path", "html_url", "score"}],
            "count": int,
            "query_used": str,
        }
    """
    try:
        qualifier = f" org:{org}" if org else ""
        full_query = f"{query}{qualifier}"
        logger.info("search_github_global: %s", full_query)
        raw = _client().search_code(full_query)
        results = []
        for item in list(raw)[:max_results]:
            entry: dict = {
                "repo": item.repository.full_name,
                "path": item.path,
                "html_url": item.html_url,
                "score": getattr(item, "score", None),
            }
            # Include text_matches if available (requires Accept header — best effort)
            try:
                if item.text_matches:
                    entry["text_matches"] = [
                        {"fragment": m.get("fragment", ""), "object_type": m.get("object_type", "")}
                        for m in item.text_matches
                    ]
            except Exception:
                pass
            results.append(entry)
        return {"results": results, "count": len(results), "query_used": full_query}
    except GithubException as e:
        logger.warning("search_github_global failed: %s — %s", query, e)
        return {"error": str(e), "results": [], "count": 0, "query_used": query}
