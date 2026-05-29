#!/usr/bin/env bash
# setup_git_history.sh
# ─────────────────────────────────────────────────────────────────────────────
# Creates git history for all 3 demo repos with:
#   commit 1: "feat: initial implementation" (GOOD version — bug NOT present)
#   commit 2: the regressing commit          (BAD version — bug introduced)
#
# After running this, the script prints the HEAD SHA for each repo.
# You MUST update demo-repos/payment-service, order-service SHAs in:
#   rca-agent/rca_agent/adapters/cicd/mock_fixtures.py
#
# Usage: cd demo-repos && bash setup_git_history.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DEMO_DIR="$(cd "$(dirname "$0")" && pwd)"

git_setup() {
    git init -b main
    git config user.email "demo@rca-agent.dev"
    git config user.name "RCA Demo"
}

# ─────────────────────────────────────────────────────────────────────────────
# 1. payment-service
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Setting up payment-service ==="
cd "$DEMO_DIR/payment-service"
git_setup

# GOOD version: null guard present
cat > src/payments/processor.py << 'PYEOF'
"""Payment processor — charge card and record transaction."""
import logging
from .models import Order, PaymentResult, PaymentStatus
from .exceptions import PaymentError

logger = logging.getLogger(__name__)
STRIPE_MULTIPLIER = 100  # convert dollars to cents


def charge_card(order: Order, payment_method_id: str) -> PaymentResult:
    """Charge the customer card for the given order."""
    if order is None:
        raise PaymentError("Order not found or session expired")
    if order.total <= 0:
        raise PaymentError(f"Invalid order total: {order.total}")
    amount_cents = order.total * STRIPE_MULTIPLIER
    try:
        import stripe
        intent = stripe.PaymentIntent.create(
            amount=int(amount_cents),
            currency="usd",
            payment_method=payment_method_id,
            confirm=True,
        )
        logger.info("Charged %s cents for order %s", int(amount_cents), order.id)
        return PaymentResult(
            status=PaymentStatus.SUCCESS,
            transaction_id=intent.id,
            amount_cents=int(amount_cents),
        )
    except Exception as e:
        raise PaymentError(str(e)) from e
PYEOF

git add .
git commit -m "feat: initial payment processor implementation"

# BAD version: null guard removed
cat > src/payments/processor.py << 'PYEOF'
"""Payment processor — charge card and record transaction."""
import logging
from .models import Order, PaymentResult, PaymentStatus
from .exceptions import PaymentError

logger = logging.getLogger(__name__)
STRIPE_MULTIPLIER = 100  # convert dollars to cents


def charge_card(order: Order, payment_method_id: str) -> PaymentResult:
    """Charge the customer card for the given order."""
    # PERF: removed null guard to streamline hot path
    amount_cents = order.total * STRIPE_MULTIPLIER  # AttributeError if order is None
    if amount_cents <= 0:
        raise PaymentError(f"Invalid order total: {order.total}")
    try:
        import stripe
        intent = stripe.PaymentIntent.create(
            amount=int(amount_cents),
            currency="usd",
            payment_method=payment_method_id,
            confirm=True,
        )
        logger.info("Charged %s cents for order %s", int(amount_cents), order.id)
        return PaymentResult(
            status=PaymentStatus.SUCCESS,
            transaction_id=intent.id,
            amount_cents=int(amount_cents),
        )
    except Exception as e:
        raise PaymentError(str(e)) from e
PYEOF

git add .
git commit -m "perf: streamline charge_card hot path"
PAYMENT_SHA=$(git rev-parse HEAD)
echo "payment-service HEAD SHA: $PAYMENT_SHA"

# ─────────────────────────────────────────────────────────────────────────────
# 2. order-service
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Setting up order-service ==="
cd "$DEMO_DIR/order-service"
git_setup

# GOOD version: pydantic v1 style with pydantic < 2 pinned
cat > src/orders/schema.py << 'PYEOF'
"""Order request/response schemas — Pydantic models (v1 compatible)."""
from pydantic import BaseModel, field_validator


class OrderItemSchema(BaseModel):
    product_id: str
    quantity: int
    unit_price: float

    @field_validator("quantity")
    @classmethod
    def quantity_must_be_positive(cls, v):
        if v <= 0:
            raise ValueError("Quantity must be positive")
        return v

    @field_validator("unit_price")
    @classmethod
    def price_must_be_positive(cls, v):
        if v <= 0:
            raise ValueError("Unit price must be positive")
        return v


class CreateOrderRequest(BaseModel):
    customer_id: str
    items: list[OrderItemSchema]
    shipping_address: str
    coupon_code: str | None = None


class OrderResponse(BaseModel):
    id: str
    customer_id: str
    status: str
    total: float
    created_at: str
PYEOF

git add .
git commit -m "feat: initial order schema with field validators"

# BAD version: downgraded to @validator (pydantic v1 style) after v2 upgrade
cat > src/orders/schema.py << 'PYEOF'
"""Order request/response schemas — Pydantic models."""
from pydantic import BaseModel, validator  # @validator removed in pydantic v2!


class OrderItemSchema(BaseModel):
    product_id: str
    quantity: int
    unit_price: float

    @validator("quantity")  # Pydantic v1 style — PydanticUserError in v2
    @classmethod
    def quantity_must_be_positive(cls, v):
        if v <= 0:
            raise ValueError("Quantity must be positive")
        return v

    @validator("unit_price")
    @classmethod
    def price_must_be_positive(cls, v):
        if v <= 0:
            raise ValueError("Unit price must be positive")
        return v


class CreateOrderRequest(BaseModel):
    customer_id: str
    items: list[OrderItemSchema]
    shipping_address: str
    coupon_code: str | None = None


class OrderResponse(BaseModel):
    id: str
    customer_id: str
    status: str
    total: float
    created_at: str
PYEOF

# Also bump pydantic version in pyproject.toml
sed -i 's/pydantic>=1.10,<2/pydantic>=2.6.0/' pyproject.toml 2>/dev/null || true

git add .
git commit -m "chore: upgrade dependencies, pydantic to v2"
ORDER_SHA=$(git rev-parse HEAD)
echo "order-service HEAD SHA: $ORDER_SHA"

# ─────────────────────────────────────────────────────────────────────────────
# 3. notification-service
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Setting up notification-service ==="
cd "$DEMO_DIR/notification-service"
git_setup

# GOOD version: safe env var access with .get()
cat > src/notifications/email.py << 'PYEOF'
"""Email dispatcher using SendGrid."""
import os
import logging

logger = logging.getLogger(__name__)


def send_email(to: str, subject: str, body: str) -> dict:
    """Send a transactional email via SendGrid."""
    api_key = os.environ.get("SENDGRID_API_KEY", "")
    if not api_key:
        raise EnvironmentError("SENDGRID_API_KEY environment variable is not set")
    try:
        import sendgrid
        from sendgrid.helpers.mail import Mail

        sg = sendgrid.SendGridAPIClient(api_key=api_key)
        message = Mail(
            from_email="noreply@example.com",
            to_emails=to,
            subject=subject,
            plain_text_content=body,
        )
        response = sg.send(message)
        logger.info("Email sent to %s, status=%s", to, response.status_code)
        return {"status_code": response.status_code, "to": to, "subject": subject}
    except Exception as e:
        logger.error("Failed to send email to %s: %s", to, e)
        raise
PYEOF

git add .
git commit -m "feat: initial email dispatcher with safe env var access"

# BAD version: direct dict access causes KeyError
cat > src/notifications/email.py << 'PYEOF'
"""Email dispatcher using SendGrid."""
import os
import logging

logger = logging.getLogger(__name__)


def send_email(to: str, subject: str, body: str) -> dict:
    """Send a transactional email via SendGrid."""
    api_key = os.environ["SENDGRID_API_KEY"]  # KeyError if env var not set!
    try:
        import sendgrid
        from sendgrid.helpers.mail import Mail

        sg = sendgrid.SendGridAPIClient(api_key=api_key)
        message = Mail(
            from_email="noreply@example.com",
            to_emails=to,
            subject=subject,
            plain_text_content=body,
        )
        response = sg.send(message)
        logger.info("Email sent to %s, status=%s", to, response.status_code)
        return {"status_code": response.status_code, "to": to, "subject": subject}
    except Exception as e:
        logger.error("Failed to send email to %s: %s", to, e)
        raise
PYEOF

git add .
git commit -m "refactor: simplify env var access"
NOTIF_SHA=$(git rev-parse HEAD)
echo "notification-service HEAD SHA: $NOTIF_SHA"

# ─────────────────────────────────────────────────────────────────────────────
# 4. pricing-service (Java Spring Boot — cross-service demo)
#
# Commit history shows the breaking rename:
#   commit 1 (initial): PricingDto.Response has field 'discount'
#   commit 2 (abc1234f, Alice Chen): rename 'discount' → 'discountRate'
#
# order-service was never updated → NullPointerException (Bug A)
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Setting up pricing-service (Java) ==="
PRICING_JAVA_DIR="$DEMO_DIR/../pricing-service"

if [ ! -d "$PRICING_JAVA_DIR" ]; then
    echo "  ERROR: $PRICING_JAVA_DIR not found. Run from banking-app-master/demo-repos/"
    exit 1
fi

cd "$PRICING_JAVA_DIR"

# Only init if not already a git repo
if [ ! -d ".git" ]; then
    git init -b main
fi
git config user.email "demo@rca-agent.dev"
git config user.name "RCA Demo"

PRICING_DTO="src/main/java/com/demo/pricing/dto/PricingDto.java"

# Write the GOOD version of PricingDto (field name is 'discount')
cat > "$PRICING_DTO" << 'JEOF'
package com.demo.pricing.dto;

import lombok.*;

public class PricingDto {

    @Getter @Setter @NoArgsConstructor @AllArgsConstructor @Builder
    public static class Request {
        private String sku;
        private int    quantity;
        private String customerTier;
    }

    /**
     * Pricing response DTO.
     *
     * Field 'discount' (fractional, e.g. 0.10 = 10% off) is applied to basePrice.
     */
    @Getter @Setter @NoArgsConstructor @AllArgsConstructor @Builder
    public static class Response {
        private String sku;
        private double basePrice;
        /** Fractional discount to apply (0.0 = no discount, 0.10 = 10% off). */
        private double discount;
        private double finalPrice;
        private String customerTier;
        private String currency;
    }
}
JEOF

git add .
git commit -m "feat: initial pricing-service implementation"
echo "  pricing-service initial commit done"

# Write the BREAKING version of PricingDto (rename discount → discountRate)
cat > "$PRICING_DTO" << 'JEOF'
package com.demo.pricing.dto;

import lombok.*;

public class PricingDto {

    @Getter @Setter @NoArgsConstructor @AllArgsConstructor @Builder
    public static class Request {
        private String sku;
        private int    quantity;
        private String customerTier;
    }

    /**
     * Pricing response DTO — v2.1.0.
     *
     * BREAKING CHANGE (commit abc1234f, 2025-01-10, Alice Chen):
     * Field renamed from 'discount' to 'discountRate' to align with the
     * internal pricing taxonomy.  Consumers must update their DTOs accordingly.
     *
     * Was:  "discount": 0.10
     * Now:  "discountRate": 0.10
     */
    @Getter @Setter @NoArgsConstructor @AllArgsConstructor @Builder
    public static class Response {
        private String sku;
        private double basePrice;
        /** Fractional discount rate (0.0 = no discount, 0.10 = 10% off).
         *  Renamed from 'discount' in v2.1.0. */
        private double discountRate;
        private double finalPrice;
        private String customerTier;
        private String currency;
    }
}
JEOF

# Also update PricingService.java to use discountRate in builder
PRICING_SVC="src/main/java/com/demo/pricing/service/PricingService.java"
if [ -f "$PRICING_SVC" ]; then
    sed -i 's/\.discount(discountRate)/.discountRate(discountRate)/' "$PRICING_SVC" 2>/dev/null || true
fi

GIT_AUTHOR_NAME="Alice Chen" \
GIT_AUTHOR_EMAIL="alice.chen@demo.dev" \
GIT_AUTHOR_DATE="2025-01-10T14:30:00+00:00" \
GIT_COMMITTER_NAME="Alice Chen" \
GIT_COMMITTER_EMAIL="alice.chen@demo.dev" \
GIT_COMMITTER_DATE="2025-01-10T14:30:00+00:00" \
git add .
GIT_AUTHOR_NAME="Alice Chen" \
GIT_AUTHOR_EMAIL="alice.chen@demo.dev" \
GIT_AUTHOR_DATE="2025-01-10T14:30:00+00:00" \
GIT_COMMITTER_NAME="Alice Chen" \
GIT_COMMITTER_EMAIL="alice.chen@demo.dev" \
GIT_COMMITTER_DATE="2025-01-10T14:30:00+00:00" \
git commit -m "refactor: rename discount field to discountRate in PricingDto

Aligns with internal pricing taxonomy v2.  The JSON key 'discount' is
now emitted as 'discountRate'.  All pricing-service consumers must update
their response DTOs to use the new field name.

Refs: PLAT-1847"

PRICING_JAVA_SHA=$(git rev-parse HEAD)
echo "  pricing-service (Java) HEAD SHA: $PRICING_JAVA_SHA"
echo "  Breaking-change commit: abc1234f-like — use 'git log --oneline' to see real SHA"

# ─────────────────────────────────────────────────────────────────────────────
# 5. order-service (Java Spring Boot — cross-service + single-service demo)
#
# Commit history shows the off-by-one bug (Bug B):
#   commit 1 (initial): resolveQuantity returns quantity directly
#   commit 2 (d3adb33f, Carlos Rivera, 2025-01-10): quantity - 1 introduced
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Setting up order-service (Java) ==="
ORDER_JAVA_DIR="$DEMO_DIR/../order-service"

if [ ! -d "$ORDER_JAVA_DIR" ]; then
    echo "  ERROR: $ORDER_JAVA_DIR not found."
    exit 1
fi

cd "$ORDER_JAVA_DIR"

if [ ! -d ".git" ]; then
    git init -b main
fi
git config user.email "demo@rca-agent.dev"
git config user.name "RCA Demo"

ORDER_SVC="src/main/java/com/demo/order/service/OrderService.java"

# GOOD version: resolveQuantity returns quantity (no off-by-one)
sed -i 's/int resolved = quantity - 1;/int resolved = quantity; \/\/ correct: no decrement/' "$ORDER_SVC" 2>/dev/null || true
# Also remove the error log that references the bug
sed -i '/This is a bug introduced in commit d3adb33f/d' "$ORDER_SVC" 2>/dev/null || true

git add .
git commit -m "feat: initial order-service implementation with resolveQuantity"
echo "  order-service initial (good) commit done"

# BAD version: introduce off-by-one (Carlos Rivera's regression)
sed -i 's/int resolved = quantity; \/\/ correct: no decrement/int resolved = quantity - 1;   \/\/ ← off-by-one; should be: int resolved = quantity;/' "$ORDER_SVC" 2>/dev/null || true

GIT_AUTHOR_NAME="Carlos Rivera" \
GIT_AUTHOR_EMAIL="carlos.rivera@demo.dev" \
GIT_AUTHOR_DATE="2025-01-10T11:15:00+00:00" \
GIT_COMMITTER_NAME="Carlos Rivera" \
GIT_COMMITTER_EMAIL="carlos.rivera@demo.dev" \
GIT_COMMITTER_DATE="2025-01-10T11:15:00+00:00" \
git add .
GIT_AUTHOR_NAME="Carlos Rivera" \
GIT_AUTHOR_EMAIL="carlos.rivera@demo.dev" \
GIT_AUTHOR_DATE="2025-01-10T11:15:00+00:00" \
GIT_COMMITTER_NAME="Carlos Rivera" \
GIT_COMMITTER_EMAIL="carlos.rivera@demo.dev" \
GIT_COMMITTER_DATE="2025-01-10T11:15:00+00:00" \
git commit -m "refactor: normalise cart quantity to 0-indexed internal array

Convert user-facing 1-indexed quantity to 0-indexed representation
used by the internal inventory array lookup.

Refs: ORD-2241"

ORDER_JAVA_SHA=$(git rev-parse HEAD)
echo "  order-service (Java) HEAD SHA: $ORDER_JAVA_SHA"

# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "========================================================"
echo "Git history created. Next steps:"
echo ""
echo "1. Update mock_fixtures.py with these SHAs (Python demo repos):"
echo "   payment-service:      $PAYMENT_SHA"
echo "   order-service:        $ORDER_SHA"
echo "   notification-service: $NOTIF_SHA"
echo ""
echo "2. Java service SHAs (for reference / GitHub push):"
echo "   pricing-service (Java): $PRICING_JAVA_SHA"
echo "   order-service (Java):   $ORDER_JAVA_SHA"
echo ""
echo "3. Push repos to GitHub (see push_to_github.sh)"
echo ""
echo "4. Seed data:"
echo "   python demo_seed_data.py                     # Python demo scenarios"
echo "   python demo_seed_data.py --scenario cross-service  # Java cross-service"
echo "========================================================"
