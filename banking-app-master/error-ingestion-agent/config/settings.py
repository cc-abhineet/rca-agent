"""
Error Ingestion Agent — Configuration
Reads all settings from environment variables (12-factor style).

Modes:
  db             — File-watcher: tails LOG_FILE_PATH for new error lines.
  datadog        — Webhook receiver: FastAPI on WEBHOOK_PORT, receives Datadog
                   monitor alerts via POST /webhook/datadog (or /rca/ingest/datadog).
  datadog_poll   — Datadog Logs API poller: polls for new error events on a
                   configurable interval. Service list is driven by projects.yaml.
                   Requires DD_API_KEY, DD_APP_KEY. Stateless except for the
                   cursor stored in service_context_cache.
"""
from pydantic_settings import BaseSettings
from typing import Literal


class Settings(BaseSettings):
    # MySQL (unified rca_db)
    database_url: str = "mysql+pymysql://root:root@localhost:3306/rca_db"

    # Google Gemini
    gemini_api_key: str = ""

    # Operating mode
    mode: Literal["db", "datadog", "datadog_poll"] = "db"

    # Log file path (mode=db only)
    log_file_path: str = "/var/log/banking-app/app.log"

    # Service identification (used by mode=db and mode=datadog only).
    # mode=datadog_poll reads service names from projects.yaml instead.
    service_name: str = "banking-app"
    environment: str = "production"

    # Polling interval (mode=db file-check cadence; mode=datadog_poll API call cadence)
    poll_interval_seconds: int = 30
    webhook_port: int = 8001

    # ── Datadog poll mode ─────────────────────────────────────────────────────
    dd_api_key: str = ""
    dd_app_key: str = ""
    # Datadog site: datadoghq.com (US1), datadoghq.eu (EU1), us3.datadoghq.com (US3)
    dd_site: str = "datadoghq.com"
    # On first poll (no cursor stored), look back this many hours to avoid
    # replaying all historical logs on fresh deploy.
    dd_initial_lookback_hours: int = 1
    # Path to projects.yaml inside the container (baked in via Dockerfile COPY).
    # Override for local development: PROJECTS_YAML_PATH=../projects.yaml
    projects_yaml_path: str = "/app/projects.yaml"

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        case_sensitive = False


settings = Settings()
