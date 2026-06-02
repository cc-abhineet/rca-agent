import base64
import logging
from datetime import datetime

import gitlab
from gitlab.exceptions import GitlabError, GitlabAuthenticationError, GitlabGetError

from .config import settings
from .overlay import get as overlay_get

logger = logging.getLogger(__name__)

_gl: gitlab.Gitlab | None = None
_gl_token: str | None = None


def _client() -> gitlab.Gitlab:
    global _gl, _gl_token
    effective_pat = overlay_get("github_pat") or settings.github_pat
    effective_url = overlay_get("gitlab_url") or settings.gitlab_url
    if _gl is None or _gl_token != effective_pat:
        _gl_token = effective_pat
        _gl = gitlab.Gitlab(effective_url, private_token=effective_pat)
        logger.debug("GitLab client (re)created for %s with PAT ending …%s", effective_url, (effective_pat or "")[-4:])
    return _gl


def _get_project(gl: gitlab.Gitlab, org: str, repo: str):
    """Return a GitLab project object for org/repo."""
    return gl.projects.get(f"{org}/{repo}")


def _friendly_gitlab_error(e: GitlabError, context: str = "") -> str:
    if isinstance(e, GitlabAuthenticationError):
        return f"GitLab token is invalid or expired. Update it in Settings → GitHub PAT. ({context})"
    if hasattr(e, "response_code"):
        if e.response_code == 403:
            return f"GitLab token lacks permission for {context}. Ensure it has read_api + read_repository scope."
        if e.response_code == 404:
            return f"Not found: {context}"
    return f"GitLab error: {e} ({context})"


def get_repo_file(org: str, repo: str, path: str, ref: str = "main") -> dict:
    """Fetch file content from GitLab at a specific ref (branch or commit SHA)."""
    try:
        gl = _client()
        project = _get_project(gl, org, repo)
        f = project.files.get(file_path=path, ref=ref)
        content = base64.b64decode(f.content).decode("utf-8")
        return {"path": path, "content": content, "sha": f.blob_id}
    except GitlabGetError as e:
        if e.response_code == 404:
            # Try 'master' branch as fallback if 'main' not found
            if ref == "main":
                try:
                    gl = _client()
                    project = _get_project(gl, org, repo)
                    f = project.files.get(file_path=path, ref="master")
                    content = base64.b64decode(f.content).decode("utf-8")
                    return {"path": path, "content": content, "sha": f.blob_id}
                except Exception:
                    pass
        msg = _friendly_gitlab_error(e, f"{org}/{repo}/{path}@{ref}")
        logger.warning("get_repo_file: %s", msg)
        return {"error": msg, "path": path}
    except GitlabError as e:
        msg = _friendly_gitlab_error(e, f"{org}/{repo}/{path}@{ref}")
        logger.warning("get_repo_file: %s", msg)
        return {"error": msg, "path": path}


def list_repo_files(org: str, repo: str, directory: str = "", ref: str = "main") -> dict:
    """List files and directories at a path in a GitLab repo."""
    try:
        gl = _client()
        project = _get_project(gl, org, repo)
        items = project.repository_tree(path=directory or "", ref=ref, get_all=False, per_page=100)
        files = [{"path": item["path"], "type": item["type"], "size": 0} for item in items]
        return {"directory": directory or "/", "files": files}
    except GitlabGetError as e:
        if e.response_code == 404 and ref == "main":
            try:
                gl = _client()
                project = _get_project(gl, org, repo)
                items = project.repository_tree(path=directory or "", ref="master", get_all=False, per_page=100)
                files = [{"path": item["path"], "type": item["type"], "size": 0} for item in items]
                return {"directory": directory or "/", "files": files}
            except Exception:
                pass
        msg = _friendly_gitlab_error(e, f"{org}/{repo}/{directory or '/'}")
        logger.warning("list_repo_files: %s", msg)
        return {"error": msg}
    except GitlabError as e:
        msg = _friendly_gitlab_error(e, f"{org}/{repo}/{directory or '/'}")
        logger.warning("list_repo_files: %s", msg)
        return {"error": msg}


def search_code_in_repo(org: str, repo: str, query: str) -> dict:
    """Search for a string or symbol within a single GitLab repo."""
    try:
        gl = _client()
        project = _get_project(gl, org, repo)
        results = project.search(scope="blobs", search=query)
        items = [
            {
                "path": r["filename"],
                "url": f"{settings.gitlab_url}/{org}/{repo}/-/blob/{r.get('ref', 'main')}/{r['filename']}",
            }
            for r in results[:10]
        ]
        return {"query": query, "results": items}
    except GitlabError as e:
        msg = _friendly_gitlab_error(e, f"search:{query} in {org}/{repo}")
        logger.warning("search_code_in_repo: %s", msg)
        return {"error": msg, "results": []}


def get_commit_diff(org: str, repo: str, commit_sha: str) -> dict:
    """Get the diff for a specific commit."""
    try:
        gl = _client()
        project = _get_project(gl, org, repo)
        commit = project.commits.get(commit_sha)
        diff_list = commit.diff()
        files = []
        for d in diff_list:
            files.append({
                "filename": d.get("new_path") or d.get("old_path", ""),
                "status": "added" if d.get("new_file") else "deleted" if d.get("deleted_file") else "modified",
                "additions": d.get("diff", "").count("\n+"),
                "deletions": d.get("diff", "").count("\n-"),
                "patch": d.get("diff", ""),
            })
        return {
            "sha": commit_sha,
            "message": commit.message,
            "author": commit.author_name,
            "date": commit.authored_date,
            "files": files,
        }
    except GitlabError as e:
        msg = _friendly_gitlab_error(e, f"{org}/{repo}@{commit_sha}")
        logger.warning("get_commit_diff: %s", msg)
        return {"error": msg}


def get_commits_since(org: str, repo: str, branch: str, since: str) -> dict:
    """List commits on a branch since a given ISO timestamp."""
    try:
        gl = _client()
        project = _get_project(gl, org, repo)
        # GitLab expects ISO 8601 with timezone
        since_clean = since.replace("Z", "+00:00") if since.endswith("Z") else since
        commits = project.commits.list(ref_name=branch, since=since_clean, get_all=False, per_page=20)
        items = [
            {
                "sha": c.id,
                "message": c.message,
                "author": c.author_name,
                "date": c.authored_date,
            }
            for c in commits[:20]
        ]
        return {"branch": branch, "commits": items}
    except GitlabError as e:
        msg = _friendly_gitlab_error(e, f"{org}/{repo}@{branch}")
        logger.warning("get_commits_since: %s", msg)
        return {"error": msg, "commits": []}


def search_github_global(query: str, org: str | None = None, max_results: int = 15) -> dict:
    """Search code across all repos in a GitLab group (or instance-wide)."""
    try:
        gl = _client()
        if org:
            group = gl.groups.get(org)
            results = group.search(scope="blobs", search=query)
        else:
            results = gl.search(scope="blobs", search=query)

        items = []
        for r in results[:max_results]:
            project_id = r.get("project_id", "")
            filename = r.get("filename", "")
            ref = r.get("ref", "main")
            try:
                proj = gl.projects.get(project_id)
                repo_path = proj.path_with_namespace
                url = f"{settings.gitlab_url}/{repo_path}/-/blob/{ref}/{filename}"
            except Exception:
                repo_path = str(project_id)
                url = ""
            items.append({
                "repo": repo_path,
                "path": filename,
                "html_url": url,
                "score": None,
            })
        return {"results": items, "count": len(items), "query_used": query}
    except GitlabError as e:
        msg = _friendly_gitlab_error(e, f"global search: {query}")
        logger.warning("search_github_global: %s", msg)
        return {"error": msg, "results": [], "count": 0, "query_used": query}
