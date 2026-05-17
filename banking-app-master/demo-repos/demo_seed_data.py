#!/usr/bin/env python3
"""
demo_seed_data.py
─────────────────
Inserts demo data into the rca_db MySQL database:
  1. service_repo_map: payment-service and order-service
     (notification-service intentionally excluded — sub-agent will discover it)
  2. error_logs: 3 error logs matching the planted bugs
  3. Writes seeded_ids.json next to this script for the demo UI

Usage:
    python demo_seed_data.py [--org GITHUB_ORG] [--db-url DATABASE_URL]

Env vars (fallback):
    GITHUB_ORG=oscorpAI
    DATABASE_URL=mysql+pymysql://root:root@localhost:3306/rca_db
"""
import argparse
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description="Seed demo data for rca-agent")
    parser.add_argument("--org", default=os.environ.get("GITHUB_ORG", "oscorpAI"))
    parser.add_argument(
        "--db-url",
        default=os.environ.get(
            "DATABASE_URL", "mysql+pymysql://root:root@localhost:3306/rca_db"
        ),
    )
    args = parser.parse_args()

    try:
        import pymysql
        import pymysql.cursors
    except ImportError:
        print("ERROR: PyMySQL not installed. Run: pip install PyMySQL")
        sys.exit(1)

    # Parse DSN
    from urllib.parse import urlparse
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

    # ── 1. service_repo_map ───────────────────────────────────────────────
    print("\n── Seeding service_repo_map ──")
    services = [
        ("payment-service", args.org, "payment-service", "main"),
        ("order-service", args.org, "order-service", "main"),
        # notification-service intentionally excluded (sub-agent demo)
        # banking-app: the live AWS service monitored via Datadog poll mode.
        # Added here so the RCA agent can find its repo when an incident
        # arrives from the ingestion agent.  The github_repo must match the
        # repository name under GITHUB_ORG in your GitHub account.
        ("banking-app", args.org, "banking-app", "main"),
    ]
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

    # ── 2. error_logs ─────────────────────────────────────────────────────
    print("\n── Seeding error_logs ──")

    error_logs = [
        # Case 1: payment-service AttributeError
        {
            "id": str(uuid.uuid4()),
            "service_name": "payment-service",
            "environment": "production",
            "error_type": "AttributeError",
            "error_message": "'NoneType' object has no attribute 'total'",
            "stack_trace": [
                {
                    "file": "src/payments/handler.py",
                    "line": 18,
                    "function": "process_order",
                    "text": "return charge_card(order, payment_method_id)",
                },
                {
                    "file": "src/payments/processor.py",
                    "line": 12,
                    "function": "charge_card",
                    "text": "amount_cents = order.total * STRIPE_MULTIPLIER",
                },
            ],
            "severity": "critical",
            "metadata": {"order_id": "EXP-9921", "payment_method": "pm_test_visa"},
        },
        # Case 2: order-service PydanticUserError
        {
            "id": str(uuid.uuid4()),
            "service_name": "order-service",
            "environment": "production",
            "error_type": "PydanticUserError",
            "error_message": (
                "In Pydantic V2, `@validator` has been removed. "
                "You should use `@field_validator` instead."
            ),
            "stack_trace": [
                {
                    "file": "src/orders/schema.py",
                    "line": 8,
                    "function": "<module>",
                    "text": "@validator('quantity')",
                },
                {
                    "file": "pydantic/_internal/_decorators.py",
                    "line": 342,
                    "function": "check_validator_fields_against_field_name",
                    "text": "raise PydanticUserError(...)",
                },
            ],
            "severity": "critical",
            "metadata": {"pydantic_version": "2.6.4"},
        },
        # Case 3: notification-service KeyError (sub-agent repo discovery)
        {
            "id": str(uuid.uuid4()),
            "service_name": "notification-service",
            "environment": "staging",
            "error_type": "KeyError",
            "error_message": "'SENDGRID_API_KEY'",
            "stack_trace": [
                {
                    "file": "src/notifications/email.py",
                    "line": 9,
                    "function": "send_email",
                    "text": "api_key = os.environ['SENDGRID_API_KEY']",
                },
                {
                    "file": "src/notifications/dispatcher.py",
                    "line": 24,
                    "function": "dispatch_welcome_email",
                    "text": "send_email(user.email, subject, body)",
                },
            ],
            "severity": "high",
            "metadata": {"user_id": "usr_4421", "email_type": "welcome"},
        },
    ]

    log_ids = []
    for log in error_logs:
        # MySQL has no RETURNING — use INSERT IGNORE with pre-generated UUID
        cur.execute(
            """INSERT IGNORE INTO error_logs
                   (id, service_name, environment, error_type, error_message,
                    stack_trace, severity, occurred_at, metadata)
               VALUES (%s, %s, %s, %s, %s, %s, %s, NOW(), %s)""",
            (
                log["id"],
                log["service_name"],
                log["environment"],
                log["error_type"],
                log["error_message"],
                json.dumps(log["stack_trace"]),
                log["severity"],
                json.dumps(log["metadata"]),
            ),
        )
        log_ids.append((log["id"], log["service_name"]))
        print(f"  ✓ {log['service_name']} ({log['error_type']}) → {log['id']}")

    conn.commit()
    cur.close()
    conn.close()

    # ── 3. Write seeded_ids.json ───────────────────────────────────────────
    seeded_ids: dict[str, str] = {}
    for log_id, svc in log_ids:
        seeded_ids[svc] = log_id

    ids_path = Path(__file__).parent / "seeded_ids.json"
    ids_path.write_text(json.dumps(seeded_ids, indent=2), encoding="utf-8")
    print(f"\n  ✓ seeded_ids.json written to {ids_path}")

    # ── 4. Print curl commands ─────────────────────────────────────────────
    print("\n── Demo UI (recommended): ──\n")
    print("  Open http://localhost:8000/demo in your browser\n")

    print("── Or use curl: ──\n")
    for log_id, svc in log_ids:
        print(f"# {svc}")
        print(f"curl -s -X POST http://localhost:8000/rca/run \\")
        print(f'  -H "Content-Type: application/json" \\')
        print(f'  -d \'{{"error_log_id": "{log_id}"}}\' | python3 -m json.tool')
        print()


if __name__ == "__main__":
    main()
