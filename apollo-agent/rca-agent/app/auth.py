"""
app/auth.py  —  JWT-based authentication utilities for Apollo RCA.

Tables:
    users (id, username, password_hash, created_at, last_login)

Tokens:
    HS256 JWT, 7-day expiry, signed with JWT_SECRET_KEY env var.
"""
from __future__ import annotations

import os
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

import bcrypt
import jwt

from rca_agent.db import get_conn

logger = logging.getLogger("rca-agent.auth")

# ── Config ────────────────────────────────────────────────────────────────────
_SECRET = os.environ.get("JWT_SECRET_KEY", "apollo-super-secret-change-in-production")
_ALGO   = "HS256"
_EXPIRE_DAYS = 7


# ── Users table ───────────────────────────────────────────────────────────────
def create_users_table() -> None:
    """Idempotent — safe to call on every startup."""
    sql = """
    CREATE TABLE IF NOT EXISTS users (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        username      VARCHAR(80)  NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_login    DATETIME     NULL,
        INDEX idx_username (username)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql)
        conn.commit()


# ── Password helpers ──────────────────────────────────────────────────────────
def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt(12)).decode()


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode(), hashed.encode())
    except Exception:
        return False


# ── User DB operations ────────────────────────────────────────────────────────
def get_user_by_username(username: str) -> Optional[dict]:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, username, password_hash, created_at, last_login "
                "FROM users WHERE username = %s LIMIT 1",
                (username,),
            )
            row = cur.fetchone()
    return dict(row) if row else None


def create_user(username: str, plain_password: str) -> dict:
    """Insert new user and return their record. Raises ValueError if taken."""
    if get_user_by_username(username):
        raise ValueError("Username already taken")
    hashed = hash_password(plain_password)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO users (username, password_hash) VALUES (%s, %s)",
                (username, hashed),
            )
            user_id = cur.lastrowid
        conn.commit()
    return {"id": user_id, "username": username}


def touch_last_login(user_id: int) -> None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE users SET last_login = %s WHERE id = %s",
                (datetime.now(timezone.utc).replace(tzinfo=None), user_id),
            )
        conn.commit()


# ── JWT helpers ───────────────────────────────────────────────────────────────
def create_token(user_id: int, username: str) -> str:
    payload = {
        "sub":      str(user_id),
        "username": username,
        "exp":      datetime.now(timezone.utc) + timedelta(days=_EXPIRE_DAYS),
        "iat":      datetime.now(timezone.utc),
    }
    return jwt.encode(payload, _SECRET, algorithm=_ALGO)


def decode_token(token: str) -> Optional[dict]:
    try:
        return jwt.decode(token, _SECRET, algorithms=[_ALGO])
    except jwt.ExpiredSignatureError:
        logger.debug("Token expired")
    except jwt.InvalidTokenError as e:
        logger.debug("Invalid token: %s", e)
    return None
