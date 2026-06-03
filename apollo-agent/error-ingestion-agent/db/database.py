"""
Error Ingestion Agent — MySQL Database Layer
Connects to the unified rca_db and writes directly to error_logs
(the same table the RCA agent reads from).
Uses aiomysql for async MySQL access.
"""
import json
import logging
import uuid
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Optional
from urllib.parse import urlparse

import aiomysql

from config.settings import settings

logger = logging.getLogger(__name__)

_pool: Optional[aiomysql.Pool] = None


def _parse_dsn(database_url: str) -> dict:
    """Parse a mysql:// or mysql+pymysql:// DSN into aiomysql kwargs."""
    url = (
        database_url
        .replace("mysql+pymysql://", "mysql://")
        .replace("mysql+aiomysql://", "mysql://")
        .replace("mysql+mysqldb://", "mysql://")
    )
    parsed = urlparse(url)
    return {
        "host": parsed.hostname or "localhost",
        "port": parsed.port or 3306,
        "user": parsed.username or "root",
        "password": parsed.password or "",
        "db": parsed.path.lstrip("/"),
        "charset": "utf8mb4",
        "autocommit": False,
    }


async def get_pool() -> aiomysql.Pool:
    global _pool
    if _pool is None:
        kwargs = _parse_dsn(settings.database_url)
        _pool = await aiomysql.create_pool(minsize=1, maxsize=5, **kwargs)
        logger.info(
            "MySQL connection pool created — %s:%s/%s",
            kwargs["host"], kwargs["port"], kwargs["db"],
        )
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool:
        _pool.close()
        await _pool.wait_closed()
        _pool = None


@asynccontextmanager
async def get_connection():
    pool = await get_pool()
    async with pool.acquire() as conn:
        yield conn


_TOKEN_TABLE_DDL = """
CREATE TABLE IF NOT EXISTS token_usage (
    id               BIGINT AUTO_INCREMENT PRIMARY KEY,
    error_log_id     VARCHAR(36)       DEFAULT NULL,
    model            VARCHAR(100)      NOT NULL,
    source           VARCHAR(50)       NOT NULL,
    input_tokens     INT               NOT NULL DEFAULT 0,
    output_tokens    INT               NOT NULL DEFAULT 0,
    cache_read_tokens     INT          NOT NULL DEFAULT 0,
    cache_creation_tokens INT          NOT NULL DEFAULT 0,
    estimated_cost_usd DECIMAL(12,8)   NOT NULL DEFAULT 0,
    iteration_num    INT               DEFAULT NULL,
    created_at       DATETIME          DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_tu_error_log (error_log_id),
    INDEX idx_tu_model     (model),
    INDEX idx_tu_created   (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
"""


async def ensure_table() -> None:
    """Verify error_logs table exists and create token_usage if needed."""
    async with get_connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SHOW TABLES LIKE 'error_logs'")
            if not await cur.fetchone():
                logger.warning(
                    "error_logs table not found — make sure rca-agent ran "
                    "'alembic upgrade head' before this service started"
                )
            else:
                logger.info("error_logs table ready")
            # Create token_usage table (idempotent)
            await cur.execute(_TOKEN_TABLE_DDL)
        await conn.commit()
        logger.info("token_usage table ready")


def log_token_usage_sync(
    model: str,
    source: str,
    input_tokens: int,
    output_tokens: int,
    estimated_cost_usd: float = 0.0,
    cache_read_tokens: int = 0,
    cache_creation_tokens: int = 0,
    iteration_num: int | None = None,
) -> None:
    """Sync PyMySQL token logging — called from synchronous analyze_node."""
    try:
        import pymysql
        dsn = _parse_dsn(settings.database_url)
        conn = pymysql.connect(
            host=dsn["host"],
            port=dsn["port"],
            user=dsn["user"],
            password=dsn["password"],
            database=dsn["db"],
            charset="utf8mb4",
            connect_timeout=5,
        )
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    """INSERT INTO token_usage
                           (model, source, input_tokens, output_tokens,
                            cache_read_tokens, cache_creation_tokens,
                            estimated_cost_usd, iteration_num)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
                    (model, source, input_tokens, output_tokens,
                     cache_read_tokens, cache_creation_tokens,
                     estimated_cost_usd, iteration_num),
                )
            conn.commit()
    except Exception as exc:
        logger.debug("Gemini token log failed (non-critical): %s", exc)


async def read_cursor(service_name: str) -> Optional[str]:
    """
    Read the stored Datadog Logs API pagination cursor for a service.

    The cursor is persisted in service_context_cache so the poller can resume
    exactly where it left off after a restart (at-least-once delivery guarantee).

    Returns None when no cursor exists (first ever poll for this service).
    """
    async with get_connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """SELECT content FROM service_context_cache
                   WHERE service_name = %s
                     AND cache_key    = 'dd_cursor'
                     AND invalidated_at IS NULL""",
                (service_name,),
            )
            row = await cur.fetchone()
    if not row:
        return None
    content = row[0]
    if isinstance(content, str):
        content = json.loads(content)
    return content.get("cursor")


async def save_cursor(service_name: str, cursor: str) -> None:
    """
    Upsert the Datadog Logs API pagination cursor for a service.

    Called AFTER successfully processing a batch of log events so that a
    mid-batch crash re-processes at most one batch (at-least-once semantics).
    Duplicate events that result from a retry are harmless — each gets its own
    UUID in error_logs and generates a separate RCA report.
    """
    content = json.dumps({
        "cursor":         cursor,
        "last_polled_at": datetime.utcnow().isoformat(),
    })
    async with get_connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """INSERT INTO service_context_cache
                       (service_name, cache_key, content)
                   VALUES (%s, 'dd_cursor', %s)
                   ON DUPLICATE KEY UPDATE
                       content        = VALUES(content),
                       last_used_at   = NOW(),
                       invalidated_at = NULL""",
                (service_name, content),
            )
        await conn.commit()
    logger.debug("Cursor saved for %s", service_name)


async def insert_incident(
    service_name: str,
    environment: str,
    error_type: Optional[str],
    message: str,
    severity: str,
    stack_trace: Optional[str],
    raw_log: str,
    source: str,
    occurred_at: Optional[datetime] = None,
    gemini_category: Optional[str] = None,
    gemini_analysis: Optional[str] = None,
    gemini_suggestions: Optional[str] = None,
    risk_level: Optional[str] = None,
) -> str:
    """
    Insert a new error into error_logs (the unified table read by the RCA agent).
    Returns the new row's UUID string.
    """
    row_id = str(uuid.uuid4())

    # stack_trace column is JSON in error_logs — wrap plain text into a list
    stack_trace_json: list = []
    if stack_trace:
        frames = [line.strip() for line in stack_trace.splitlines() if line.strip()]
        stack_trace_json = [{"text": f} for f in frames] if frames else [{"text": stack_trace}]

    metadata = {"source": source, "raw_log": raw_log[:2000]}

    async with get_connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO error_logs
                    (id, service_name, environment, error_type, error_message,
                     stack_trace, severity, occurred_at, metadata, rca_status,
                     gemini_category, gemini_analysis, gemini_suggestions, risk_level)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 'pending', %s, %s, %s, %s)
                """,
                (
                    row_id,
                    service_name,
                    environment,
                    error_type or "UnknownError",
                    message,
                    json.dumps(stack_trace_json),
                    severity,
                    occurred_at or datetime.utcnow(),
                    json.dumps(metadata),
                    gemini_category,
                    gemini_analysis,
                    gemini_suggestions,
                    risk_level,
                ),
            )
        await conn.commit()

    logger.info(
        "Incident #%s inserted — service=%s risk_level=%s source=%s",
        row_id[:8], service_name, risk_level or "?", source,
    )
    return row_id
