"""
Error Ingestion Agent — Configuration
Reads all settings from environment variables (12-factor style).

Responsibility: watch log files, detect errors, run Gemini analysis, store to MySQL.
Datadog log shipping is handled by the dedicated dd-agent service — not here.
"""
from pydantic_settings import BaseSettings
from typing import Literal


class Settings(BaseSettings):
    # MySQL (unified rca_db)
    database_url: str = "mysql+pymysql://root:root@localhost:3306/rca_db"

    # Google Gemini
    gemini_api_key: str = ""

    # Operating mode (startup default — overrideable at runtime via control API)
    mode: Literal["db", "datadog", "datadog_poll"] = "db"

    # Log files to watch (comma-separated paths)
    log_file_paths: str = "/var/log/banking-app/app.log"

    # Fallback service name when a log line has no embedded service identifier
    service_name: str = "banking-app"
    environment: str = "production"

    # ── Datadog credentials (used by datadog_poll mode) ───────────────────────
    dd_api_key: str = ""
    dd_app_key: str = ""
    dd_site: str = "us5.datadoghq.com"

    # ── Org isolation ─────────────────────────────────────────────────────────
    # Set this to the ingest API key shown in Apollo → Integrations.
    # The agent will look up the matching org_id and stamp all errors with it.
    apollo_ingest_api_key: str = ""

    # ── Datadog poller tuning ─────────────────────────────────────────────────
    poll_interval_seconds: int = 30
    # How far back to fetch on first poll (no cursor stored yet)
    dd_initial_lookback_hours: int = 1
    # Path to projects.yaml inside the container
    projects_yaml_path: str = "/app/projects.yaml"

    class Config:
        # Search root → banking-app-master → local .env (for local dev outside Docker).
        # In Docker, env vars are injected by docker-compose and take precedence.
        env_file = ("../../.env", "../.env", ".env")
        env_file_encoding = "utf-8"
        case_sensitive = False


settings = Settings()
