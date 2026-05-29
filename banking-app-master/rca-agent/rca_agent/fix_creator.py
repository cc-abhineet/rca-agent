"""
Edit-mode PR creation for the RCA demo.

Given a scenario key + an rca_id, this module:
  1. Reads the target files from the configured GitHub org via the Git Data API
  2. Applies deterministic find/replace edits in memory
  3. Creates a fresh branch off main
  4. Commits the modified files
  5. Opens a PR

Returns a structured dict the UI uses to render the PR card.  Idempotent on
branch collision: if the branch already exists, the existing PR is returned
(or one is opened against the existing branch if the original PR was closed).
"""
from __future__ import annotations

import base64
import difflib
import html
import logging
from typing import Any

import httpx

from .config import settings
from app.demo_scenarios import SCENARIO_FIXES

logger = logging.getLogger(__name__)

GITHUB_API = "https://api.github.com"


class FixCreationError(Exception):
    """Raised when PR creation fails for any reason — wraps the GitHub error."""


def _gh_headers() -> dict[str, str]:
    if not settings.github_pat:
        raise FixCreationError(
            "GITHUB_PAT is not set — Edit mode requires a token with repo write scope."
        )
    return {
        "Authorization": f"Bearer {settings.github_pat}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def _gh(method: str, url: str, *, json: dict | None = None, params: dict | None = None) -> httpx.Response:
    """Thin wrapper that raises FixCreationError with the GitHub body on failure."""
    with httpx.Client(timeout=20.0) as client:
        r = client.request(method, url, headers=_gh_headers(), json=json, params=params)
    if r.status_code >= 400:
        raise FixCreationError(
            f"GitHub {method} {url} → {r.status_code}: {r.text[:500]}"
        )
    return r


def _render_diff_html(file_path: str, original: str, modified: str) -> str:
    """Render a unified diff as syntax-highlighted HTML (no external libs)."""
    diff_lines = list(
        difflib.unified_diff(
            original.splitlines(keepends=False),
            modified.splitlines(keepends=False),
            fromfile=f"a/{file_path}",
            tofile=f"b/{file_path}",
            lineterm="",
        )
    )
    out: list[str] = []
    for line in diff_lines:
        esc = html.escape(line)
        if line.startswith("+++") or line.startswith("---"):
            cls = "diff-meta"
        elif line.startswith("@@"):
            cls = "diff-hunk"
        elif line.startswith("+"):
            cls = "diff-add"
        elif line.startswith("-"):
            cls = "diff-del"
        else:
            cls = "diff-ctx"
        out.append(f'<span class="{cls}">{esc}</span>')
    return "\n".join(out)


def create_fix_pr(scenario_key: str, rca_id: str) -> dict[str, Any]:
    """
    Apply the SCENARIO_FIXES[scenario_key] edits to oscorpAI/<repo> via the
    GitHub Git Data API and open a PR.

    Returns:
      {
        "pr_url":      "https://github.com/...",
        "pr_number":   42,
        "branch":      "claude-rca-fix-bug-a-abcd1234",
        "title":       "Align PricingResponseDto with ...",
        "files_changed": ["src/.../PricingResponseDto.java", ...],
        "diff_html":   "<span class='diff-meta'>--- ...</span>\\n...",
        "existing":    false,
      }
    """
    spec = SCENARIO_FIXES.get(scenario_key)
    if not spec:
        raise FixCreationError(f"Unknown scenario_key {scenario_key!r}")

    org = settings.github_org
    repo = spec["repo"]
    branch = f"{spec['branch_prefix']}-{rca_id[:8]}"

    # ── 1. Get main HEAD commit + tree ───────────────────────────────────────
    ref = _gh("GET", f"{GITHUB_API}/repos/{org}/{repo}/git/ref/heads/main").json()
    base_commit_sha = ref["object"]["sha"]
    base_commit = _gh(
        "GET", f"{GITHUB_API}/repos/{org}/{repo}/git/commits/{base_commit_sha}"
    ).json()
    base_tree_sha = base_commit["tree"]["sha"]

    # ── 2. Pull current contents + apply edits in memory ─────────────────────
    # Group edits by path so we apply multiple edits to the same file sequentially.
    edits_by_path: dict[str, list[dict]] = {}
    for edit in spec["edits"]:
        edits_by_path.setdefault(edit["path"], []).append(edit)

    tree_entries: list[dict[str, Any]] = []
    diff_chunks: list[str] = []
    files_changed: list[str] = []

    for path, edits in edits_by_path.items():
        file_res = _gh(
            "GET",
            f"{GITHUB_API}/repos/{org}/{repo}/contents/{path}",
            params={"ref": "main"},
        ).json()
        original = base64.b64decode(file_res["content"]).decode("utf-8")
        modified = original
        for edit in edits:
            if edit["find"] not in modified:
                raise FixCreationError(
                    f"Could not find target string in {path}.  "
                    f"The repo may not match the local source.  "
                    f"Looking for: {edit['find'][:80]!r}"
                )
            modified = modified.replace(edit["find"], edit["replace"], 1)

        if modified == original:
            continue  # no actual change — skip

        # Create a blob for the modified content
        blob = _gh(
            "POST",
            f"{GITHUB_API}/repos/{org}/{repo}/git/blobs",
            json={"content": modified, "encoding": "utf-8"},
        ).json()
        tree_entries.append(
            {"path": path, "mode": "100644", "type": "blob", "sha": blob["sha"]}
        )
        files_changed.append(path)
        diff_chunks.append(_render_diff_html(path, original, modified))

    if not tree_entries:
        raise FixCreationError("All edits produced no changes — fix definitions are stale.")

    # ── 3. Create tree + commit ──────────────────────────────────────────────
    new_tree = _gh(
        "POST",
        f"{GITHUB_API}/repos/{org}/{repo}/git/trees",
        json={"base_tree": base_tree_sha, "tree": tree_entries},
    ).json()
    commit_message = f"{spec['pr_title']}\n\nCo-Authored-By: Claude RCA Agent <noreply@anthropic.com>"
    new_commit = _gh(
        "POST",
        f"{GITHUB_API}/repos/{org}/{repo}/git/commits",
        json={
            "message": commit_message,
            "tree": new_tree["sha"],
            "parents": [base_commit_sha],
        },
    ).json()

    # ── 4. Create branch (or reuse if it already exists) ─────────────────────
    existing_branch = False
    try:
        _gh(
            "POST",
            f"{GITHUB_API}/repos/{org}/{repo}/git/refs",
            json={"ref": f"refs/heads/{branch}", "sha": new_commit["sha"]},
        )
    except FixCreationError as e:
        if "Reference already exists" in str(e):
            # Force-update the existing branch to the new commit so the PR diff is current
            logger.info("Branch %s already exists — updating to new commit", branch)
            _gh(
                "PATCH",
                f"{GITHUB_API}/repos/{org}/{repo}/git/refs/heads/{branch}",
                json={"sha": new_commit["sha"], "force": True},
            )
            existing_branch = True
        else:
            raise

    # ── 5. Open PR (or return existing open PR for this branch) ──────────────
    try:
        pr = _gh(
            "POST",
            f"{GITHUB_API}/repos/{org}/{repo}/pulls",
            json={
                "title": spec["pr_title"],
                "body": spec["pr_body"],
                "head": branch,
                "base": "main",
            },
        ).json()
    except FixCreationError as e:
        if "A pull request already exists" in str(e):
            # Look up the existing PR for this branch
            existing_prs = _gh(
                "GET",
                f"{GITHUB_API}/repos/{org}/{repo}/pulls",
                params={"head": f"{org}:{branch}", "state": "open"},
            ).json()
            if not existing_prs:
                raise FixCreationError(
                    f"Branch {branch} exists but no open PR found and GitHub "
                    f"refused to create one: {e}"
                )
            pr = existing_prs[0]
            existing_branch = True
        else:
            raise

    return {
        "pr_url": pr["html_url"],
        "pr_number": pr["number"],
        "branch": branch,
        "title": spec["pr_title"],
        "files_changed": files_changed,
        "diff_html": "\n".join(diff_chunks),
        "existing": existing_branch,
    }
