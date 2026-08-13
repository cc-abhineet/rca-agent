"""
Symmetric encryption for org integration credentials stored in DB.

Uses Fernet (AES-128-CBC + HMAC-SHA256) from the `cryptography` package.

Key priority:
  1. APOLLO_SECRETS_KEY env var  (base64url Fernet key)
  2. .apollo_secrets_key file next to pyproject.toml (auto-generated on first use)

Call `get_key()` once at startup to surface any key errors early.
"""

import base64
import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)

_SECRETS_KEY_FILE = Path(__file__).parent.parent / ".apollo_secrets_key"
_cached_fernet = None


def _key_file_path() -> Path:
    """Return the secrets key file path (Docker vs local dev)."""
    docker_path = Path("/app/.apollo_secrets_key")
    return docker_path if docker_path.parent.exists() else _SECRETS_KEY_FILE


def get_key() -> bytes:
    """Return the Fernet key bytes.

    Priority:
      1. APOLLO_SECRETS_KEY env var — set this in .env (local) or cloud secrets manager (prod)
      2. .apollo_secrets_key file — legacy fallback, not reliable across container rebuilds
    """
    env_key = os.environ.get("APOLLO_SECRETS_KEY", "").strip()
    if env_key:
        return env_key.encode()

    key_file = _key_file_path()
    if key_file.exists():
        return key_file.read_bytes().strip()

    # No key configured — raise clearly rather than auto-generating an ephemeral key
    # that will be lost on the next container restart, corrupting all stored credentials.
    raise RuntimeError(
        "APOLLO_SECRETS_KEY is not set. "
        "Generate a key with: python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\" "
        "and add it to your .env file as APOLLO_SECRETS_KEY=<value>."
    )


def _fernet():
    """Return a cached Fernet instance."""
    global _cached_fernet
    if _cached_fernet is None:
        from cryptography.fernet import Fernet
        _cached_fernet = Fernet(get_key())
    return _cached_fernet


# ── Public API ────────────────────────────────────────────────────────────────

def encrypt_secret(plaintext: str) -> str:
    """Encrypt a plaintext string with the deployment Fernet key."""
    if not plaintext:
        return plaintext
    token = _fernet().encrypt(plaintext.encode("utf-8"))
    return token.decode("ascii")


def decrypt_secret(token: str) -> str:
    """Decrypt a Fernet token back to plaintext."""
    if not token:
        return token
    try:
        return _fernet().decrypt(token.encode("ascii")).decode("utf-8")
    except Exception:
        # Value was stored before encryption was enabled — return as-is
        return token


def mask_secret(value: str, show: int = 4) -> str:
    """Return a masked version for display: 'sk-ant-••••abcd'."""
    if not value or len(value) <= show:
        return "••••••••"
    return "••••" + value[-show:]


# Fields that contain secrets and must be encrypted / masked
_SECRET_FIELDS = {
    "datadog_api_key", "datadog_app_key",
    "github_token", "gitlab_token",
    "anthropic_api_key", "api_key",
    "service_account_token", "access_token",
    "password", "secret", "token",
}


def is_secret_field(key: str) -> bool:
    """Return True if a config key holds a secret value that must be encrypted."""
    k = key.lower()
    return k in _SECRET_FIELDS or k.endswith("_key") or k.endswith("_token") or k.endswith("_secret")


def encrypt_config(config: dict) -> dict:
    """Return a copy of config with secret fields encrypted."""
    return {
        k: (encrypt_secret(v) if is_secret_field(k) and isinstance(v, str) and v else v)
        for k, v in config.items()
    }


def decrypt_config(config: dict) -> dict:
    """Return a copy of config with secret fields decrypted."""
    return {
        k: (decrypt_secret(v) if is_secret_field(k) and isinstance(v, str) and v else v)
        for k, v in config.items()
    }


def mask_config(config: dict) -> dict:
    """Return a copy of config with secret fields masked for UI display."""
    return {
        k: (mask_secret(v) if is_secret_field(k) and isinstance(v, str) and v else v)
        for k, v in config.items()
    }
