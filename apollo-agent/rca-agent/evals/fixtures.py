"""
Eval fixtures for rca-agent.
Each fixture has:
  - name: unique identifier
  - error_log: dict matching error_logs schema
  - mock_deployment: dict or None
  - mock_github_files: {path: content}
  - mock_commit_diff: dict (files with patches)
  - ground_truth: {repo, file, root_cause_keywords, fix_area}
"""
from datetime import datetime, timezone

# ── Helper ────────────────────────────────────────────────────────────────────

def _ts(y, mo, d, h=12, mi=0):
    return datetime(y, mo, d, h, mi, tzinfo=timezone.utc).isoformat()


# ── Case 1: NullPointerError — payment-service ────────────────────────────────

PAYMENT_PROCESSOR_BUGGY = '''\
"""Payment processor — charge card and record transaction."""
import stripe
from .models import Order, PaymentResult, PaymentStatus
from .exceptions import PaymentError

STRIPE_MULTIPLIER = 100  # convert dollars to cents


def charge_card(order: Order, payment_method_id: str) -> PaymentResult:
    """Charge the customer card for the given order."""
    # PERF: removed null guard to streamline hot path (commit: perf/streamline)
    amount_cents = order.total * STRIPE_MULTIPLIER  # line 12 — AttributeError if order is None
    try:
        intent = stripe.PaymentIntent.create(
            amount=int(amount_cents),
            currency="usd",
            payment_method=payment_method_id,
            confirm=True,
        )
        return PaymentResult(
            status=PaymentStatus.SUCCESS,
            transaction_id=intent.id,
            amount_cents=int(amount_cents),
        )
    except stripe.error.CardError as e:
        raise PaymentError(str(e)) from e
'''

PAYMENT_HANDLER_CODE = '''\
"""Order payment handler."""
import logging
from .processor import charge_card
from .exceptions import PaymentError

logger = logging.getLogger(__name__)


def _fetch_order(order_id: str):
    """Fetch order from DB. Returns None for expired/missing sessions."""
    from .models import Order
    # Simulates DB lookup — returns None for expired session orders
    if order_id.startswith("EXP"):
        return None
    return Order(id=order_id, total=99.99, customer_id="cust_123")


def process_order(order_id: str, payment_method_id: str):
    order = _fetch_order(order_id)
    # BUG: order may be None — charge_card has no null guard
    return charge_card(order, payment_method_id)
'''

CASE_1 = {
    "name": "payment-service-null-order",
    "error_log": {
        "id": "err-pay-001",
        "service_name": "payment-service",
        "environment": "production",
        "error_type": "AttributeError",
        "error_message": "'NoneType' object has no attribute 'total'",
        "stack_trace": [
            {"file": "src/payments/handler.py", "line": 18, "function": "process_order",
             "text": "return charge_card(order, payment_method_id)"},
            {"file": "src/payments/processor.py", "line": 12, "function": "charge_card",
             "text": "amount_cents = order.total * STRIPE_MULTIPLIER"},
        ],
        "severity": "critical",
        "occurred_at": _ts(2026, 5, 13, 10, 45),
        "metadata": {"order_id": "EXP-9921", "payment_method": "pm_test_visa"},
    },
    "mock_deployment": {
        "service_name": "payment-service",
        "environment": "production",
        "github_repo": "payment-service",
        "branch": "main",
        "commit_sha": "abc1234",
        "commit_message": "perf: streamline charge_card hot path",
        "deployed_at": _ts(2026, 5, 13, 10, 32),
        "deployer": "jane.doe",
        "pipeline_id": "run-8821",
        "status": "success",
    },
    "mock_github_files": {
        "src/payments/processor.py": PAYMENT_PROCESSOR_BUGGY,
        "src/payments/handler.py": PAYMENT_HANDLER_CODE,
    },
    "mock_commit_diff": {
        "sha": "abc1234",
        "message": "perf: streamline charge_card hot path",
        "author": "jane.doe",
        "date": _ts(2026, 5, 13, 10, 20),
        "files": [
            {
                "filename": "src/payments/processor.py",
                "status": "modified",
                "additions": 1,
                "deletions": 3,
                "patch": (
                    "@@ -10,9 +10,7 @@ STRIPE_MULTIPLIER = 100\n"
                    " def charge_card(order: Order, payment_method_id: str) -> PaymentResult:\n"
                    '     """Charge the customer card for the given order."""\n'
                    "-     if order is None:\n"
                    '-         raise PaymentError("Order not found or session expired")\n'
                    "-     if order.total <= 0:\n"
                    '-         raise PaymentError(f"Invalid order total: {order.total}")\n'
                    "+     # PERF: removed null guard to streamline hot path\n"
                    "     amount_cents = order.total * STRIPE_MULTIPLIER\n"
                ),
            }
        ],
    },
    "ground_truth": {
        "repo": "payment-service",
        "file": "src/payments/processor.py",
        "root_cause_keywords": ["null guard", "none check", "order is None", "NoneType", "null order"],
        "fix_area": "null guard",
    },
}


# ── Case 2: Pydantic v2 migration — order-service ─────────────────────────────

ORDER_SCHEMA_BUGGY = '''\
"""Order schema — Pydantic model definitions."""
from pydantic import BaseModel, validator  # validator removed in pydantic v2


class OrderItem(BaseModel):
    product_id: str
    quantity: int
    unit_price: float

    @validator("quantity")  # Pydantic v1 style — raises AttributeError in v2
    def quantity_must_be_positive(cls, v):
        if v <= 0:
            raise ValueError("Quantity must be positive")
        return v

    @validator("unit_price")
    def price_must_be_positive(cls, v):
        if v <= 0:
            raise ValueError("Unit price must be positive")
        return v


class CreateOrderRequest(BaseModel):
    customer_id: str
    items: list[OrderItem]
    shipping_address: str
    coupon_code: str | None = None
'''

CASE_2 = {
    "name": "order-service-pydantic-v2",
    "error_log": {
        "id": "err-ord-001",
        "service_name": "order-service",
        "environment": "production",
        "error_type": "PydanticUserError",
        "error_message": (
            "In Pydantic V2, `@validator` has been removed. "
            "You should use `@field_validator` instead."
        ),
        "stack_trace": [
            {"file": "src/orders/schema.py", "line": 8, "function": "<module>",
             "text": "@validator('quantity')"},
            {"file": "pydantic/_internal/_decorators.py", "line": 342,
             "function": "check_validator_fields_against_field_name",
             "text": "raise PydanticUserError(...)"},
        ],
        "severity": "critical",
        "occurred_at": _ts(2026, 5, 13, 9, 20),
        "metadata": {"pydantic_version": "2.6.4"},
    },
    "mock_deployment": {
        "service_name": "order-service",
        "environment": "production",
        "github_repo": "order-service",
        "branch": "main",
        "commit_sha": "def5678",
        "commit_message": "chore: upgrade dependencies, pydantic to v2",
        "deployed_at": _ts(2026, 5, 13, 9, 15),
        "deployer": "bob.smith",
        "pipeline_id": "run-8819",
        "status": "success",
    },
    "mock_github_files": {
        "src/orders/schema.py": ORDER_SCHEMA_BUGGY,
    },
    "mock_commit_diff": {
        "sha": "def5678",
        "message": "chore: upgrade dependencies, pydantic to v2",
        "author": "bob.smith",
        "date": _ts(2026, 5, 13, 9, 0),
        "files": [
            {
                "filename": "pyproject.toml",
                "status": "modified",
                "additions": 1,
                "deletions": 1,
                "patch": (
                    "@@ -5,7 +5,7 @@\n"
                    ' dependencies = [\n'
                    '-    "pydantic>=1.10,<2",\n'
                    '+    "pydantic>=2.6.0",\n'
                    " ]\n"
                ),
            }
        ],
    },
    "ground_truth": {
        "repo": "order-service",
        "file": "src/orders/schema.py",
        "root_cause_keywords": ["pydantic v2", "validator", "field_validator", "deprecated", "migration"],
        "fix_area": "field_validator",
    },
}


# ── Case 3: Missing env var — notification-service ────────────────────────────

NOTIFICATION_EMAIL_BUGGY = '''\
"""Email dispatcher using SendGrid."""
import os
import sendgrid
from sendgrid.helpers.mail import Mail


def send_email(to: str, subject: str, body: str) -> dict:
    """Send a transactional email via SendGrid."""
    api_key = os.environ["SENDGRID_API_KEY"]  # KeyError if env var not set
    sg = sendgrid.SendGridAPIClient(api_key=api_key)
    message = Mail(
        from_email="noreply@example.com",
        to_emails=to,
        subject=subject,
        plain_text_content=body,
    )
    response = sg.send(message)
    return {"status_code": response.status_code, "to": to}
'''

CASE_3 = {
    "name": "notification-service-missing-env",
    "error_log": {
        "id": "err-not-001",
        "service_name": "notification-service",
        "environment": "staging",
        "error_type": "KeyError",
        "error_message": "'SENDGRID_API_KEY'",
        "stack_trace": [
            {"file": "src/notifications/email.py", "line": 9, "function": "send_email",
             "text": "api_key = os.environ['SENDGRID_API_KEY']"},
            {"file": "src/notifications/dispatcher.py", "line": 24,
             "function": "dispatch_welcome_email",
             "text": "send_email(user.email, subject, body)"},
        ],
        "severity": "high",
        "occurred_at": _ts(2026, 5, 13, 8, 10),
        "metadata": {"user_id": "usr_4421", "email_type": "welcome"},
    },
    "mock_deployment": None,  # No CI/CD record — forces sub-agent discovery
    "mock_github_files": {
        "src/notifications/email.py": NOTIFICATION_EMAIL_BUGGY,
        "pyproject.toml": '[project]\nname = "notification-service"\n',
    },
    "mock_commit_diff": {
        "sha": "ghi9012",
        "message": "refactor: simplify env var access",
        "author": "alice.chen",
        "date": _ts(2026, 5, 13, 7, 50),
        "files": [
            {
                "filename": "src/notifications/email.py",
                "status": "modified",
                "additions": 1,
                "deletions": 1,
                "patch": (
                    "@@ -8,7 +8,7 @@\n"
                    " def send_email(to: str, subject: str, body: str) -> dict:\n"
                    '-    api_key = os.environ.get("SENDGRID_API_KEY", "")\n'
                    '+    api_key = os.environ["SENDGRID_API_KEY"]\n'
                ),
            }
        ],
    },
    "ground_truth": {
        "repo": "notification-service",
        "file": "src/notifications/email.py",
        "root_cause_keywords": ["KeyError", "env var", "SENDGRID_API_KEY", "environ.get", "missing environment"],
        "fix_area": "environ.get",
    },
}


# ── Case 4: Division by zero — analytics-service ─────────────────────────────

ANALYTICS_CALCULATOR_BUGGY = '''\
"""Conversion rate calculator."""


def calculate_conversion_rate(conversions: int, impressions: int) -> float:
    """Return conversion rate as percentage."""
    return (conversions / impressions) * 100  # ZeroDivisionError if impressions=0
'''

CASE_4 = {
    "name": "analytics-service-division-by-zero",
    "error_log": {
        "id": "err-ana-001",
        "service_name": "analytics-service",
        "environment": "production",
        "error_type": "ZeroDivisionError",
        "error_message": "division by zero",
        "stack_trace": [
            {"file": "src/analytics/calculator.py", "line": 6,
             "function": "calculate_conversion_rate",
             "text": "return (conversions / impressions) * 100"},
            {"file": "src/analytics/reports.py", "line": 42,
             "function": "generate_daily_report",
             "text": "rate = calculate_conversion_rate(conv, imp)"},
        ],
        "severity": "high",
        "occurred_at": _ts(2026, 5, 13, 6, 0),
        "metadata": {"report_date": "2026-05-13", "campaign_id": "camp_9981"},
    },
    "mock_deployment": {
        "service_name": "analytics-service",
        "environment": "production",
        "github_repo": "analytics-service",
        "branch": "main",
        "commit_sha": "jkl3456",
        "commit_message": "feat: add conversion rate to daily reports",
        "deployed_at": _ts(2026, 5, 12, 23, 0),
        "deployer": "charlie.dev",
        "pipeline_id": "run-8810",
        "status": "success",
    },
    "mock_github_files": {
        "src/analytics/calculator.py": ANALYTICS_CALCULATOR_BUGGY,
    },
    "mock_commit_diff": {
        "sha": "jkl3456",
        "message": "feat: add conversion rate to daily reports",
        "author": "charlie.dev",
        "date": _ts(2026, 5, 12, 22, 30),
        "files": [
            {
                "filename": "src/analytics/calculator.py",
                "status": "added",
                "additions": 6,
                "deletions": 0,
                "patch": (
                    "@@ -0,0 +1,6 @@\n"
                    '+"""Conversion rate calculator."""\n'
                    "+\n"
                    "+\n"
                    "+def calculate_conversion_rate(conversions: int, impressions: int) -> float:\n"
                    '+    """Return conversion rate as percentage."""\n'
                    "+    return (conversions / impressions) * 100\n"
                ),
            }
        ],
    },
    "ground_truth": {
        "repo": "analytics-service",
        "file": "src/analytics/calculator.py",
        "root_cause_keywords": ["division by zero", "impressions", "zero check", "guard", "ZeroDivisionError"],
        "fix_area": "zero check",
    },
}


# ── Case 5: Index out of range — recommendation-service ──────────────────────

RECO_RANKER_BUGGY = '''\
"""Recommendation ranker."""
from typing import Any


def top_n_recommendations(items: list[Any], n: int = 5) -> list[Any]:
    """Return top-N items. Assumes list has at least N elements."""
    return items[:n] if len(items) >= n else items[0:n]  # IndexError for empty list
    # Actually this is fine for slices, but forced access is the bug:


def get_top_recommendation(items: list[Any]) -> Any:
    """Return the single best recommendation."""
    return items[0]  # IndexError if items is empty
'''

CASE_5 = {
    "name": "recommendation-service-index-error",
    "error_log": {
        "id": "err-rec-001",
        "service_name": "recommendation-service",
        "environment": "production",
        "error_type": "IndexError",
        "error_message": "list index out of range",
        "stack_trace": [
            {"file": "src/recommendations/ranker.py", "line": 11,
             "function": "get_top_recommendation",
             "text": "return items[0]"},
            {"file": "src/recommendations/api.py", "line": 38,
             "function": "get_personalized_recommendations",
             "text": "top = get_top_recommendation(ranked)"},
        ],
        "severity": "medium",
        "occurred_at": _ts(2026, 5, 12, 15, 30),
        "metadata": {"user_id": "usr_0001", "algorithm": "collaborative-filter"},
    },
    "mock_deployment": {
        "service_name": "recommendation-service",
        "environment": "production",
        "github_repo": "recommendation-service",
        "branch": "main",
        "commit_sha": "mno7890",
        "commit_message": "feat: add single top recommendation endpoint",
        "deployed_at": _ts(2026, 5, 12, 15, 0),
        "deployer": "dev.team",
        "pipeline_id": "run-8808",
        "status": "success",
    },
    "mock_github_files": {
        "src/recommendations/ranker.py": RECO_RANKER_BUGGY,
    },
    "mock_commit_diff": {
        "sha": "mno7890",
        "message": "feat: add single top recommendation endpoint",
        "author": "dev.team",
        "date": _ts(2026, 5, 12, 14, 45),
        "files": [
            {
                "filename": "src/recommendations/ranker.py",
                "status": "modified",
                "additions": 4,
                "deletions": 0,
                "patch": (
                    "@@ -8,3 +8,7 @@\n"
                    " \n"
                    "+\n"
                    "+def get_top_recommendation(items: list[Any]) -> Any:\n"
                    '+    """Return the single best recommendation."""\n'
                    "+    return items[0]  # IndexError if items is empty\n"
                ),
            }
        ],
    },
    "ground_truth": {
        "repo": "recommendation-service",
        "file": "src/recommendations/ranker.py",
        "root_cause_keywords": ["IndexError", "empty list", "index out of range", "items[0]", "empty check"],
        "fix_area": "empty check",
    },
}


# ── Case 6: Timeout / slow query — inventory-service ─────────────────────────

INVENTORY_QUERY_BUGGY = '''\
"""Inventory query helpers."""
import psycopg2


def get_low_stock_items(conn, threshold: int = 10) -> list[dict]:
    """Return all items with stock below threshold — no index, full table scan."""
    with conn.cursor() as cur:
        # Missing index on stock_level — causes full table scan on 10M row table
        cur.execute(
            "SELECT id, sku, name, stock_level FROM inventory WHERE stock_level < %s",
            (threshold,),
        )
        return cur.fetchall()
'''

CASE_6 = {
    "name": "inventory-service-slow-query",
    "error_log": {
        "id": "err-inv-001",
        "service_name": "inventory-service",
        "environment": "production",
        "error_type": "QueryTimeout",
        "error_message": "canceling statement due to statement timeout (30000ms)",
        "stack_trace": [
            {"file": "src/inventory/queries.py", "line": 9,
             "function": "get_low_stock_items",
             "text": "cur.execute('SELECT ... WHERE stock_level < %s', (threshold,))"},
            {"file": "src/inventory/service.py", "line": 55,
             "function": "generate_restock_report",
             "text": "items = get_low_stock_items(conn)"},
        ],
        "severity": "high",
        "occurred_at": _ts(2026, 5, 11, 8, 0),
        "metadata": {"table": "inventory", "row_count_estimate": 10000000},
    },
    "mock_deployment": {
        "service_name": "inventory-service",
        "environment": "production",
        "github_repo": "inventory-service",
        "branch": "main",
        "commit_sha": "pqr1122",
        "commit_message": "feat: restock report generation",
        "deployed_at": _ts(2026, 5, 10, 16, 0),
        "deployer": "ops.team",
        "pipeline_id": "run-8790",
        "status": "success",
    },
    "mock_github_files": {
        "src/inventory/queries.py": INVENTORY_QUERY_BUGGY,
    },
    "mock_commit_diff": {
        "sha": "pqr1122",
        "message": "feat: restock report generation",
        "author": "ops.team",
        "date": _ts(2026, 5, 10, 15, 30),
        "files": [
            {
                "filename": "src/inventory/queries.py",
                "status": "added",
                "additions": 12,
                "deletions": 0,
                "patch": "+def get_low_stock_items(conn, threshold: int = 10):\n+    ...\n",
            }
        ],
    },
    "ground_truth": {
        "repo": "inventory-service",
        "file": "src/inventory/queries.py",
        "root_cause_keywords": ["missing index", "full table scan", "stock_level", "slow query", "timeout"],
        "fix_area": "index",
    },
}


# ── Case 7: Circular import — user-service ────────────────────────────────────

USER_MODELS_BUGGY = '''\
"""User models."""
from .permissions import UserPermissions  # circular: permissions imports models


class User:
    def __init__(self, id: str, email: str):
        self.id = id
        self.email = email
        self.permissions = UserPermissions(user_id=id)
'''

CASE_7 = {
    "name": "user-service-circular-import",
    "error_log": {
        "id": "err-usr-001",
        "service_name": "user-service",
        "environment": "production",
        "error_type": "ImportError",
        "error_message": "cannot import name 'User' from partially initialized module 'src.users.models' (most likely due to a circular import)",
        "stack_trace": [
            {"file": "src/users/models.py", "line": 2, "function": "<module>",
             "text": "from .permissions import UserPermissions"},
            {"file": "src/users/permissions.py", "line": 1, "function": "<module>",
             "text": "from .models import User"},
        ],
        "severity": "critical",
        "occurred_at": _ts(2026, 5, 10, 14, 0),
        "metadata": {},
    },
    "mock_deployment": {
        "service_name": "user-service",
        "environment": "production",
        "github_repo": "user-service",
        "branch": "main",
        "commit_sha": "stu3344",
        "commit_message": "feat: add UserPermissions to User model",
        "deployed_at": _ts(2026, 5, 10, 13, 45),
        "deployer": "alice.chen",
        "pipeline_id": "run-8785",
        "status": "success",
    },
    "mock_github_files": {
        "src/users/models.py": USER_MODELS_BUGGY,
    },
    "mock_commit_diff": {
        "sha": "stu3344",
        "message": "feat: add UserPermissions to User model",
        "author": "alice.chen",
        "date": _ts(2026, 5, 10, 13, 30),
        "files": [
            {
                "filename": "src/users/models.py",
                "status": "modified",
                "additions": 2,
                "deletions": 0,
                "patch": (
                    "@@ -1,4 +1,6 @@\n"
                    ' """User models."""\n'
                    "+from .permissions import UserPermissions  # circular import!\n"
                    "+\n"
                    " class User:\n"
                    "     def __init__(self, id, email):\n"
                    "+        self.permissions = UserPermissions(user_id=id)\n"
                ),
            }
        ],
    },
    "ground_truth": {
        "repo": "user-service",
        "file": "src/users/models.py",
        "root_cause_keywords": ["circular import", "ImportError", "permissions", "partially initialized"],
        "fix_area": "circular import",
    },
}


# ── Case 8: Rate limit / retry storm — email-service ─────────────────────────

EMAIL_CLIENT_BUGGY = '''\
"""SendGrid client with aggressive retry."""
import time
import sendgrid


def send_with_retry(to: str, subject: str, body: str, retries: int = 10) -> dict:
    """Send email with retry — no backoff, causes rate-limit storm."""
    sg = sendgrid.SendGridAPIClient(api_key="...")
    for attempt in range(retries):
        resp = sg.send(...)
        if resp.status_code == 429:
            time.sleep(0)  # no backoff — hammers API immediately
            continue
        return {"status": resp.status_code}
    raise Exception("Max retries exceeded")
'''

CASE_8 = {
    "name": "email-service-rate-limit-storm",
    "error_log": {
        "id": "err-eml-001",
        "service_name": "email-service",
        "environment": "production",
        "error_type": "RateLimitError",
        "error_message": "429 Too Many Requests from SendGrid API after 10 retries",
        "stack_trace": [
            {"file": "src/email/client.py", "line": 11, "function": "send_with_retry",
             "text": "time.sleep(0)  # no backoff"},
            {"file": "src/email/worker.py", "line": 30, "function": "process_queue",
             "text": "send_with_retry(msg.to, msg.subject, msg.body)"},
        ],
        "severity": "high",
        "occurred_at": _ts(2026, 5, 9, 18, 0),
        "metadata": {"queue_depth": 5000, "sendgrid_plan": "free"},
    },
    "mock_deployment": {
        "service_name": "email-service",
        "environment": "production",
        "github_repo": "email-service",
        "branch": "main",
        "commit_sha": "vwx5566",
        "commit_message": "feat: add retry logic to email sending",
        "deployed_at": _ts(2026, 5, 9, 17, 30),
        "deployer": "dev.team",
        "pipeline_id": "run-8775",
        "status": "success",
    },
    "mock_github_files": {
        "src/email/client.py": EMAIL_CLIENT_BUGGY,
    },
    "mock_commit_diff": {
        "sha": "vwx5566",
        "message": "feat: add retry logic to email sending",
        "author": "dev.team",
        "date": _ts(2026, 5, 9, 17, 0),
        "files": [
            {
                "filename": "src/email/client.py",
                "status": "modified",
                "additions": 8,
                "deletions": 2,
                "patch": (
                    "+    for attempt in range(retries):\n"
                    "+        resp = sg.send(...)\n"
                    "+        if resp.status_code == 429:\n"
                    "+            time.sleep(0)  # no backoff\n"
                ),
            }
        ],
    },
    "ground_truth": {
        "repo": "email-service",
        "file": "src/email/client.py",
        "root_cause_keywords": ["no backoff", "rate limit", "429", "retry storm", "exponential backoff"],
        "fix_area": "backoff",
    },
}


# ── Case 9: Unclosed DB connection — reporting-service ────────────────────────

REPORTING_DB_BUGGY = '''\
"""Reporting DB helpers — unclosed connection leak."""
import psycopg2


def get_report_data(report_id: str) -> dict:
    conn = psycopg2.connect("postgresql://localhost/reports")
    cur = conn.cursor()
    cur.execute("SELECT * FROM reports WHERE id = %s", (report_id,))
    row = cur.fetchone()
    # Missing conn.close() — connection leak on every call
    return dict(row) if row else {}
'''

CASE_9 = {
    "name": "reporting-service-connection-leak",
    "error_log": {
        "id": "err-rpt-001",
        "service_name": "reporting-service",
        "environment": "production",
        "error_type": "OperationalError",
        "error_message": "FATAL: remaining connection slots are reserved for non-replication superuser connections",
        "stack_trace": [
            {"file": "src/reporting/db.py", "line": 5, "function": "get_report_data",
             "text": "conn = psycopg2.connect(...)"},
            {"file": "src/reporting/service.py", "line": 20,
             "function": "fetch_report",
             "text": "data = get_report_data(report_id)"},
        ],
        "severity": "critical",
        "occurred_at": _ts(2026, 5, 8, 9, 0),
        "metadata": {"pg_max_connections": 100},
    },
    "mock_deployment": {
        "service_name": "reporting-service",
        "environment": "production",
        "github_repo": "reporting-service",
        "branch": "main",
        "commit_sha": "yza7788",
        "commit_message": "refactor: extract DB helpers to separate module",
        "deployed_at": _ts(2026, 5, 8, 8, 30),
        "deployer": "eng.team",
        "pipeline_id": "run-8760",
        "status": "success",
    },
    "mock_github_files": {
        "src/reporting/db.py": REPORTING_DB_BUGGY,
    },
    "mock_commit_diff": {
        "sha": "yza7788",
        "message": "refactor: extract DB helpers to separate module",
        "author": "eng.team",
        "date": _ts(2026, 5, 8, 8, 0),
        "files": [
            {
                "filename": "src/reporting/db.py",
                "status": "added",
                "additions": 10,
                "deletions": 0,
                "patch": "+def get_report_data(report_id):\n+    conn = psycopg2.connect(...)\n+    # no conn.close()\n",
            }
        ],
    },
    "ground_truth": {
        "repo": "reporting-service",
        "file": "src/reporting/db.py",
        "root_cause_keywords": ["connection leak", "conn.close", "unclosed", "context manager", "with statement"],
        "fix_area": "connection close",
    },
}


# ── Case 10: Regex ReDoS — search-service ─────────────────────────────────────

SEARCH_REGEX_BUGGY = '''\
"""Search query validator."""
import re

# Catastrophic backtracking regex — ReDoS vulnerability
QUERY_PATTERN = re.compile(r"^(a+)+$")


def validate_search_query(query: str) -> bool:
    """Validate that search query matches expected pattern."""
    match = QUERY_PATTERN.match(query)  # hangs for inputs like "aaaaaaaaaaaaaaaaX"
    return match is not None
'''

CASE_10 = {
    "name": "search-service-redos",
    "error_log": {
        "id": "err-srch-001",
        "service_name": "search-service",
        "environment": "production",
        "error_type": "TimeoutError",
        "error_message": "Request timed out after 30s — suspected ReDoS in query validation",
        "stack_trace": [
            {"file": "src/search/validator.py", "line": 9, "function": "validate_search_query",
             "text": "match = QUERY_PATTERN.match(query)"},
            {"file": "src/search/api.py", "line": 15, "function": "search",
             "text": "if not validate_search_query(q):"},
        ],
        "severity": "critical",
        "occurred_at": _ts(2026, 5, 7, 11, 0),
        "metadata": {"query_length": 25, "input_pattern": "aaa...X"},
    },
    "mock_deployment": {
        "service_name": "search-service",
        "environment": "production",
        "github_repo": "search-service",
        "branch": "main",
        "commit_sha": "bcd9900",
        "commit_message": "feat: add query validation to search endpoint",
        "deployed_at": _ts(2026, 5, 7, 10, 30),
        "deployer": "security.team",
        "pipeline_id": "run-8750",
        "status": "success",
    },
    "mock_github_files": {
        "src/search/validator.py": SEARCH_REGEX_BUGGY,
    },
    "mock_commit_diff": {
        "sha": "bcd9900",
        "message": "feat: add query validation to search endpoint",
        "author": "security.team",
        "date": _ts(2026, 5, 7, 10, 0),
        "files": [
            {
                "filename": "src/search/validator.py",
                "status": "added",
                "additions": 10,
                "deletions": 0,
                "patch": (
                    '+QUERY_PATTERN = re.compile(r"^(a+)+$")\n'
                    "+\n"
                    "+def validate_search_query(query: str) -> bool:\n"
                    "+    match = QUERY_PATTERN.match(query)\n"
                ),
            }
        ],
    },
    "ground_truth": {
        "repo": "search-service",
        "file": "src/search/validator.py",
        "root_cause_keywords": ["ReDoS", "catastrophic backtracking", "regex", "timeout", "polynomial"],
        "fix_area": "regex",
    },
}


# ── Master list ───────────────────────────────────────────────────────────────

EVAL_FIXTURES = [
    CASE_1, CASE_2, CASE_3, CASE_4, CASE_5,
    CASE_6, CASE_7, CASE_8, CASE_9, CASE_10,
]
