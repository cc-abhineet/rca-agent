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
    parser.add_argument(
        "--scenario",
        choices=["python", "cross-service", "all"],
        default="python",
        help=(
            "Which error scenarios to seed. "
            "'python' = original 3 Python demo scenarios (default). "
            "'cross-service' = Java pricing+order-service cross-service NPE + off-by-one. "
            "'all' = seed everything."
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

    # Java cross-service repos are seeded for all scenarios (they're always useful)
    java_services = [
        # pricing-service and order-service Java repos
        # github_repo names match what push_to_github.sh creates
        ("pricing-service", args.org, "pricing-service", "main"),
        # order-service-java maps the Java Spring Boot order-service
        # (the Python demo-repos/order-service maps to "order-service" above)
        ("order-service-java", args.org, "order-service-java", "main"),
    ]

    if args.scenario in ("cross-service", "all"):
        services = services + java_services
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

    # Python demo scenarios
    python_error_logs = [
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

    # Java cross-service scenarios (pricing-service + order-service)
    cross_service_error_logs = [
        # Scenario A: order-service NPE from stale discount field (cross-service)
        {
            "id": str(uuid.uuid4()),
            "service_name": "order-service-java",
            "environment": "production",
            "error_type": "NullPointerException",
            "error_message": (
                'Cannot invoke "java.lang.Double.doubleValue()" because the return value '
                'of "com.demo.order.dto.PricingResponseDto.getDiscount()" is null'
            ),
            "stack_trace": [
                {
                    "file": "com/demo/order/service/OrderService.java",
                    "line": 139,
                    "function": "calculateTotal",
                    "text": "double discountedUnit = unitPrice * (1.0 - discount.doubleValue());",
                },
                {
                    "file": "com/demo/order/service/OrderService.java",
                    "line": 58,
                    "function": "createOrder",
                    "text": "double totalPrice = calculateTotal(pricing.getBasePrice(), pricing.getDiscount(), resolvedQty);",
                },
                {
                    "file": "com/demo/order/controller/OrderController.java",
                    "line": 40,
                    "function": "createOrder",
                    "text": "OrderDto.Response response = orderService.createOrder(request);",
                },
            ],
            "severity": "critical",
            "metadata": {
                "customerId": "CHAOS-CUSTOMER",
                "sku": "SKU-001",
                "quantity": 2,
                "customerTier": "premium",
                "upstream_service": "pricing-service",
                "upstream_version": "2.1.0",
            },
        },
        # Scenario B: order-service off-by-one in resolveQuantity (single-service)
        {
            "id": str(uuid.uuid4()),
            "service_name": "order-service-java",
            "environment": "production",
            "error_type": "IllegalArgumentException",
            "error_message": "Order quantity 0 is invalid",
            "stack_trace": [
                {
                    "file": "com/demo/order/service/OrderService.java",
                    "line": 111,
                    "function": "resolveQuantity",
                    "text": 'throw new IllegalArgumentException("Order quantity " + resolved + " is invalid");',
                },
                {
                    "file": "com/demo/order/service/OrderService.java",
                    "line": 52,
                    "function": "createOrder",
                    "text": "int resolvedQty = resolveQuantity(req.getQuantity());",
                },
                {
                    "file": "com/demo/order/controller/OrderController.java",
                    "line": 40,
                    "function": "createOrder",
                    "text": "OrderDto.Response response = orderService.createOrder(request);",
                },
            ],
            "severity": "high",
            "metadata": {
                "customerId": "CHAOS-CUSTOMER",
                "sku": "SKU-002",
                "quantity": 1,
                "customerTier": "standard",
                "commit": "d3adb33f",
                "author": "Carlos Rivera",
            },
        },
    ]

    # Decide which error logs to seed
    if args.scenario == "python":
        error_logs = python_error_logs
    elif args.scenario == "cross-service":
        error_logs = cross_service_error_logs
    else:  # all
        error_logs = python_error_logs + cross_service_error_logs

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
