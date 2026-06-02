#!/usr/bin/env python3
"""
add_service_map.py — Register services in the rca-agent's service_repo_map table.

By default reads ALL services from banking-app-master/projects.yaml and
registers them.  To add a new service to the platform, add it to projects.yaml
and re-run this script — no code changes needed.

Run this once after `alembic upgrade head`.  Idempotent: re-running updates
existing rows instead of inserting duplicates.

Usage
-----
  # Register all services defined in projects.yaml (default):
  python add_service_map.py

  # Register a single custom service without editing projects.yaml:
  python add_service_map.py \\
      --service   my-service \\
      --org       my-github-org \\
      --repo      my-service-repo \\
      --branch    main \\
      --language  Python \\
      --notes     "Payments microservice"

  # Override the DB URL:
  python add_service_map.py --db-url "mysql+pymysql://root:pass@localhost:3306/rca_db"

Dependencies (already in rca-agent requirements):
  pip install pymysql python-dotenv sqlalchemy pyyaml
"""

import argparse
import os
import sys
from pathlib import Path

# ── Load .env — check root first, then banking-app-master/rca-agent/.env ─────
from dotenv import load_dotenv

_ENV_CANDIDATES = [
    Path(__file__).parent / ".env",                              # root (preferred)
    Path(__file__).parent / "banking-app-master" / "rca-agent" / ".env",  # legacy
]
for _env_path in _ENV_CANDIDATES:
    if _env_path.exists():
        load_dotenv(_env_path)
        break


def _get_engine(db_url: str | None):
    """Return a SQLAlchemy engine for the given (or env-configured) DATABASE_URL."""
    try:
        from sqlalchemy import create_engine
    except ImportError:
        print("ERROR: sqlalchemy not found. Install it: pip install sqlalchemy pymysql")
        sys.exit(1)

    url = db_url or os.getenv("DATABASE_URL")
    if not url:
        print(
            "ERROR: DATABASE_URL is not set.\n"
            "  Set it in banking-app-master/rca-agent/.env, or pass --db-url."
        )
        sys.exit(1)

    return create_engine(url)


def upsert_service(
    engine,
    service_name: str,
    github_org: str,
    github_repo: str,
    default_branch: str = "main",
    language: str | None = None,
    onboarded_by: str = "add_service_map.py",
    notes: str | None = None,
) -> None:
    """Insert or update one row in service_repo_map."""
    sql = """
        INSERT INTO service_repo_map
            (service_name, github_org, github_repo, default_branch, language, onboarded_by, notes)
        VALUES
            (:service_name, :github_org, :github_repo, :default_branch, :language, :onboarded_by, :notes)
        ON DUPLICATE KEY UPDATE
            github_org     = VALUES(github_org),
            github_repo    = VALUES(github_repo),
            default_branch = VALUES(default_branch),
            language       = VALUES(language),
            onboarded_by   = VALUES(onboarded_by),
            notes          = VALUES(notes)
    """
    from sqlalchemy import text
    with engine.begin() as conn:
        conn.execute(
            text(sql),
            {
                "service_name":   service_name,
                "github_org":     github_org,
                "github_repo":    github_repo,
                "default_branch": default_branch,
                "language":       language,
                "onboarded_by":   onboarded_by,
                "notes":          notes,
            },
        )
    print(f"  ✓ {service_name} → {github_org}/{github_repo} ({default_branch})")


# ── Load services from projects.yaml ─────────────────────────────────────────

_PROJECTS_YAML = Path(__file__).parent / "banking-app-master" / "projects.yaml"


def _load_from_projects_yaml() -> list[dict]:
    """
    Read banking-app-master/projects.yaml and return a list of service dicts
    ready for upsert_service().  Every project entry in the yaml becomes a row.
    """
    try:
        import yaml
    except ImportError:
        print("WARNING: pyyaml not installed — skipping projects.yaml load.")
        print("         Install with: pip install pyyaml")
        return []

    if not _PROJECTS_YAML.exists():
        print(f"WARNING: projects.yaml not found at {_PROJECTS_YAML}")
        return []

    with open(_PROJECTS_YAML, encoding="utf-8") as fh:
        data = yaml.safe_load(fh)

    services = []
    for p in data.get("projects", []):
        svc_id = p.get("id") or p.get("name")
        if not svc_id:
            continue
        services.append({
            "service_name":   svc_id,
            "github_org":     p.get("github_org", ""),
            "github_repo":    p.get("github_repo", svc_id),
            "default_branch": p.get("default_branch", "main"),
            "language":       (p.get("language") or "unknown").capitalize(),
            "notes":          p.get("description", ""),
        })
    return services


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Register services in the rca-agent service_repo_map table.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--db-url",   help="SQLAlchemy DATABASE_URL (overrides env var)")
    parser.add_argument("--service",  help="Service name to register (custom mode)")
    parser.add_argument("--org",      help="GitHub organisation")
    parser.add_argument("--repo",     help="GitHub repository name")
    parser.add_argument("--branch",   default="main", help="Default branch (default: main)")
    parser.add_argument("--language", default=None,   help="Programming language")
    parser.add_argument("--notes",    default=None,   help="Free-text notes")
    args = parser.parse_args()

    engine = _get_engine(args.db_url)

    if args.service:
        # Custom single-service registration
        if not args.org or not args.repo:
            print("ERROR: --org and --repo are required when using --service")
            sys.exit(1)
        print(f"\nRegistering {args.service}…")
        upsert_service(
            engine,
            service_name=args.service,
            github_org=args.org,
            github_repo=args.repo,
            default_branch=args.branch,
            language=args.language,
            notes=args.notes,
        )
    else:
        # Default: register all services from projects.yaml
        services = _load_from_projects_yaml()
        if not services:
            print("ERROR: No services found in projects.yaml and no --service flag given.")
            sys.exit(1)
        print(f"\nRegistering {len(services)} service(s) from projects.yaml…")
        for svc in services:
            upsert_service(engine, **svc)

    print("\nDone. The rca-agent will now resolve these services to their GitHub repos.")
    print("Next: seed error logs with  python banking-app-master/demo-repos/demo_seed_data.py")


if __name__ == "__main__":
    main()
