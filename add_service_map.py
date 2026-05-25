#!/usr/bin/env python3
"""
add_service_map.py — Register services in the rca-agent's service_repo_map table.

Run this once after `alembic upgrade head` to tell the rca-agent which GitHub
repos back each service.  Idempotent: re-running it updates existing rows
rather than inserting duplicates.

Usage
-----
  # Register the default cross-service demo (pricing-service + order-service):
  python add_service_map.py

  # Register a custom service:
  python add_service_map.py \\
      --service   my-service \\
      --org       my-github-org \\
      --repo      my-service-repo \\
      --branch    main \\
      --language  Python \\
      --notes     "Payments microservice"

  # Override the DB URL (defaults to DATABASE_URL env var or banking-app-master/.env):
  python add_service_map.py --db-url "mysql+pymysql://root:pass@localhost:3306/rca_db"

Dependencies (already in rca-agent requirements):
  pip install pymysql python-dotenv sqlalchemy
"""

import argparse
import os
import sys
from pathlib import Path

# ── Load .env from rca-agent directory so DATABASE_URL is available ──────────
_ENV_PATH = Path(__file__).parent / "banking-app-master" / "rca-agent" / ".env"
if _ENV_PATH.exists():
    from dotenv import load_dotenv
    load_dotenv(_ENV_PATH)


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


# ── Default entries for the cross-service demo ───────────────────────────────

DEFAULT_SERVICES = [
    {
        "service_name":   "banking-app",
        "github_org":     "oscorpAI",
        "github_repo":    "banking-app",
        "default_branch": "main",
        "language":       "Java",
        "notes":          "Spring Boot banking application (port 8080)",
    },
    {
        "service_name":   "pricing-service",
        "github_org":     "oscorpAI",
        "github_repo":    "pricing-service",
        "default_branch": "main",
        "language":       "Java",
        "notes":          (
            "Spring Boot pricing service (port 8081). "
            "v2.1.0 renamed 'discount' field to 'discountRate' — "
            "order-service has not been updated (Bug A)."
        ),
    },
    {
        "service_name":   "order-service",
        "github_org":     "oscorpAI",
        "github_repo":    "order-service",
        "default_branch": "main",
        "language":       "Java",
        "notes":          (
            "Spring Boot order service (port 8082). "
            "Calls pricing-service. "
            "Bug A: NPE from stale 'discount' field. "
            "Bug B: off-by-one in resolveQuantity (commit d3adb33f)."
        ),
    },
]


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
        # Default: register all cross-service demo services
        print("\nRegistering default cross-service demo services…")
        for svc in DEFAULT_SERVICES:
            upsert_service(engine, **svc)

    print("\nDone. The rca-agent will now resolve these services to their GitHub repos.")
    print("Next: seed error logs with  python banking-app-master/demo-repos/demo_seed_data.py")


if __name__ == "__main__":
    main()
