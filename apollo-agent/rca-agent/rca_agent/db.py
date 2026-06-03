import json
import pymysql
import pymysql.cursors
from contextlib import contextmanager
from urllib.parse import urlparse
from .config import settings
from .overlay import get as overlay_get


def _conn_kwargs() -> dict:
    # Settings-UI overlay wins over env so the user can change DB URL at runtime
    url = overlay_get("database_url") or settings.database_url
    # Accept mysql+pymysql:// or mysql://
    url = url.replace("mysql+pymysql://", "mysql://").replace("mysql+mysqldb://", "mysql://")
    parsed = urlparse(url)
    return {
        "host": parsed.hostname or "localhost",
        "port": parsed.port or 3306,
        "user": parsed.username or "root",
        "password": parsed.password or "",
        "database": parsed.path.lstrip("/"),
        "charset": "utf8mb4",
        "cursorclass": pymysql.cursors.DictCursor,
        "autocommit": False,
    }


@contextmanager
def get_conn():
    conn = pymysql.connect(**_conn_kwargs())
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def execute(sql: str, params=None) -> list[dict]:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            try:
                rows = cur.fetchall()
                return [dict(r) for r in rows] if rows else []
            except Exception:
                return []


def execute_one(sql: str, params=None) -> dict | None:
    rows = execute(sql, params)
    return rows[0] if rows else None


def execute_update(sql: str, params=None) -> int:
    """
    Execute a write statement (INSERT / UPDATE / DELETE) and return the number
    of affected rows.

    Used by the RCA poll loop to atomically claim a pending error log:
        claimed = execute_update(
            "UPDATE error_logs SET rca_status='in_progress' WHERE id=%s AND rca_status='pending'",
            (error_log_id,),
        )
    A return value of 1 means this worker successfully claimed the row;
    0 means another worker got there first (safe to skip).
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.rowcount


def json_loads(v):
    """Safely parse a JSON value that may already be a dict/list (from ORM) or a string."""
    if v is None:
        return None
    if isinstance(v, (dict, list)):
        return v
    return json.loads(v)


_TOKEN_TABLE_DDL = """
CREATE TABLE IF NOT EXISTS token_usage (
    id               BIGINT AUTO_INCREMENT PRIMARY KEY,
    error_log_id     VARCHAR(36)      DEFAULT NULL,
    model            VARCHAR(100)     NOT NULL,
    source           VARCHAR(50)      NOT NULL,
    input_tokens     INT              NOT NULL DEFAULT 0,
    output_tokens    INT              NOT NULL DEFAULT 0,
    cache_read_tokens      INT        NOT NULL DEFAULT 0,
    cache_creation_tokens  INT        NOT NULL DEFAULT 0,
    estimated_cost_usd  DECIMAL(12,8) NOT NULL DEFAULT 0,
    iteration_num    INT              DEFAULT NULL,
    created_at       DATETIME         DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_tu_error_log (error_log_id),
    INDEX idx_tu_model     (model),
    INDEX idx_tu_created   (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
"""


def create_token_usage_table() -> None:
    """Idempotent: create token_usage table if it does not already exist."""
    execute(_TOKEN_TABLE_DDL)


def log_token_usage(
    model: str,
    source: str,
    input_tokens: int,
    output_tokens: int,
    error_log_id: str | None = None,
    cache_read_tokens: int = 0,
    cache_creation_tokens: int = 0,
    estimated_cost_usd: float = 0.0,
    iteration_num: int | None = None,
) -> None:
    """Insert one token-usage row.  Best-effort — caller should swallow exceptions."""
    execute(
        """INSERT INTO token_usage
               (error_log_id, model, source, input_tokens, output_tokens,
                cache_read_tokens, cache_creation_tokens,
                estimated_cost_usd, iteration_num)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
        (
            error_log_id, model, source,
            input_tokens, output_tokens,
            cache_read_tokens, cache_creation_tokens,
            estimated_cost_usd, iteration_num,
        ),
    )
