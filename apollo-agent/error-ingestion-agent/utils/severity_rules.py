"""
Pre-defined exception-to-severity classification rules.

These are injected verbatim into the Gemini prompt so the model uses them
as a ground-truth lookup before applying its own judgment.  If the exception
type in a log entry matches a name in this table, Gemini is instructed to
use that severity.  If there is no match, Gemini classifies freely.

Severity levels (lowest → highest impact):
  low      — operational noise; no user impact expected
  medium   — degraded experience or business logic violation; monitor closely
  high     — significant user impact or data risk; page on-call
  critical — system down or data loss risk; immediate action required
"""

SEVERITY_RULES: dict[str, list[str]] = {
    "critical": [
        # JVM / runtime collapse
        "OutOfMemoryError",
        "StackOverflowError",
        "VirtualMachineError",
        "InternalError",
        # Database connection pool failure — all requests will fail
        "HikariPool$PoolInitializationException",
        "PoolInitializationException",
        "CannotGetJdbcConnectionException",
        "JDBCConnectionException",
        # Broad data-access failure (table missing, schema mismatch, DB down)
        "DataAccessException",
        # EJB / transaction infrastructure
        "SystemException",
        "EJBException",
    ],
    "high": [
        # Null dereference — almost always a code defect in a hot path
        "NullPointerException",
        # Illegal runtime state — indicates a sequencing or concurrency bug
        "IllegalStateException",
        # Raw SQL / DB errors
        "SQLException",
        "DataIntegrityViolationException",
        "TransactionSystemException",
        # Network / timeout
        "ConnectionError",
        "TimeoutException",
        "SocketTimeoutException",
        "ConnectTimeoutException",
        "ReadTimeoutException",
        # Spring HTTP client — upstream 5xx
        "HttpServerErrorException",
        "ServiceUnavailableException",
        "ResourceAccessException",
        # Messaging infrastructure
        "KafkaException",
        "AmqpException",
    ],
    "medium": [
        # Bad caller input or contract violation
        "IllegalArgumentException",
        "ValidationException",
        "ConstraintViolationException",
        "MethodArgumentNotValidException",
        "BindException",
        # Business logic exceptions
        "AccountNotFoundException",
        "InsufficientFundsException",
        "InvalidSkuException",
        "EntityNotFoundException",
        "NoSuchElementException",
        # Chaos / demo-injected exceptions
        "ChaosException",
        # Spring HTTP client — upstream 4xx (bad request to downstream)
        "HttpClientErrorException",
        # Spring data
        "ObjectOptimisticLockingFailureException",
    ],
    "low": [
        # Numeric / type coercion errors — usually bad input, low blast radius
        "NumberFormatException",
        "ClassCastException",
        "ArithmeticException",
        # Array / string bounds — typically code defects in non-critical paths
        "IndexOutOfBoundsException",
        "ArrayIndexOutOfBoundsException",
        "StringIndexOutOfBoundsException",
        "NegativeArraySizeException",
        # Unsupported operations — usually feature flags or stub code
        "UnsupportedOperationException",
    ],
}

# Flat reverse lookup:  exception name → severity level
_EXCEPTION_TO_SEVERITY: dict[str, str] = {
    exc: level
    for level, exceptions in SEVERITY_RULES.items()
    for exc in exceptions
}


def get_known_severity(error_type: str | None) -> str | None:
    """
    Return the pre-classified severity for a known exception type, or None.
    Tries exact match first, then substring match (handles qualified names like
    'com.zaxxer.hikari.pool.HikariPool$PoolInitializationException').
    """
    if not error_type:
        return None
    # Exact match
    if error_type in _EXCEPTION_TO_SEVERITY:
        return _EXCEPTION_TO_SEVERITY[error_type]
    # Substring: check if any known exception name appears in the error_type string
    for exc, level in _EXCEPTION_TO_SEVERITY.items():
        if exc in error_type:
            return level
    return None


def format_rules_for_prompt() -> str:
    """Return the classification table as a formatted string for the Gemini prompt."""
    lines = []
    for level in ("critical", "high", "medium", "low"):
        exceptions = ", ".join(SEVERITY_RULES[level])
        lines.append(f"  {level.upper()}: {exceptions}")
    return "\n".join(lines)
