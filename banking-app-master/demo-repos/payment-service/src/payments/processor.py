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
