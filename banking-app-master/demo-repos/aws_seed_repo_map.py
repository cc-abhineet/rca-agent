#!/usr/bin/env python3
"""
aws_seed_repo_map.py
────────────────────
Seeds service_repo_map in RDS for the AWS deployment.
Run this once after terraform apply via ECS Exec into the rca-agent container.

Usage:
    python aws_seed_repo_map.py [--org GITHUB_ORG]

The DATABASE_URL is read from the environment (already injected by ECS from SSM).

ECS Exec command:
    TASK_ID=$(aws ecs list-tasks --cluster banking-app-cluster \\
      --service-name rca-agent --query 'taskArns[0]' --output text | awk -F'/' '{print $NF}')

    aws ecs execute-command \\
      --cluster banking-app-cluster \\
      --task $TASK_ID \\
      --container rca-agent \\
      --interactive \\
      --command "python /app/demo-repos/aws_seed_repo_map.py --org <your-github-org>"
"""
import argparse
import os
import sys
from urllib.parse import urlparse


def main():
    parser = argparse.ArgumentParser(description="Seed service_repo_map for AWS deployment")
    parser.add_argument("--org", default=os.environ.get("GITHUB_ORG", "oscorpAI"),
                        help="GitHub org that owns the service repos")
    parser.add_argument("--db-url", default=os.environ.get("DATABASE_URL"),
                        help="MySQL connection URL (defaults to DATABASE_URL env var)")
    args = parser.parse_args()

    if not args.db_url:
        print("ERROR: DATABASE_URL env var not set and --db-url not provided.")
        sys.exit(1)

    try:
        import pymysql
        import pymysql.cursors
    except ImportError:
        print("ERROR: PyMySQL not installed. Run: pip install PyMySQL")
        sys.exit(1)

    raw = args.db_url.replace("mysql+pymysql://", "mysql://").replace("mysql+mysqldb://", "mysql://")
    parsed = urlparse(raw)
    conn = pymysql.connect(
        host=parsed.hostname or "localhost",
        port=parsed.port or 3306,
        user=parsed.username or "root",
        password=parsed.password or "",
        database=parsed.path.lstrip("/"),
        charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
        autocommit=False,
    )
    cur = conn.cursor()

    services = [
        # banking-app: the live service monitored via Datadog — must match the repo
        # name under your GitHub org exactly.
        ("banking-app",        args.org, "banking-app",        "main"),
        # payment-service and order-service: demo repos for sub-agent testing.
        ("payment-service",    args.org, "payment-service",    "main"),
        ("order-service",      args.org, "order-service",      "main"),
        # notification-service intentionally excluded — sub-agent discovers it automatically.
    ]

    print(f"\nSeeding service_repo_map (org={args.org})...\n")
    for svc, org, repo, branch in services:
        cur.execute(
            """INSERT INTO service_repo_map (service_name, github_org, github_repo, default_branch)
               VALUES (%s, %s, %s, %s)
               ON DUPLICATE KEY UPDATE
                   github_org     = VALUES(github_org),
                   github_repo    = VALUES(github_repo),
                   default_branch = VALUES(default_branch)""",
            (svc, org, repo, branch),
        )
        print(f"  ✓ {svc} → github.com/{org}/{repo}")

    conn.commit()
    cur.close()
    conn.close()
    print("\nDone. service_repo_map is ready.")


if __name__ == "__main__":
    main()
