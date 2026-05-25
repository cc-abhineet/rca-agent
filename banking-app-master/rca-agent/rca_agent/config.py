from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    anthropic_api_key: str
    github_pat: str = ""
    github_org: str = "oscorpAI"
    database_url: str = "mysql+pymysql://root:root@localhost:3306/rca_db"
    model: str = "claude-sonnet-4-6"
    max_react_iterations: int = 20
    observability_adapter: str = "local"   # "local" | "datadog"
    cicd_adapter: str = "mock"             # "mock" | "real"

    # ── Cross-service memory ──────────────────────────────────────────────────
    # Path to the JSON file where the agent persists discovered service→repo deps.
    # Relative to CWD when the agent starts; override with env var DEPENDENCY_MEMORY_PATH.
    dependency_memory_path: str = "dependency_memory.json"

    # ── DB poll mode ──────────────────────────────────────────────────────────
    # When rca_poll_enabled=true the agent starts a background thread that scans
    # error_logs for pending rows and runs RCA automatically — no HTTP trigger
    # needed. This is the primary mode for the banking-app AWS deployment where
    # the ingestion agent writes directly to RDS and the RCA agent picks it up.
    #
    # Set via env var: RCA_POLL_ENABLED=true
    rca_poll_enabled: bool = False
    # Seconds between scans when no pending row was found.  When a row IS found
    # the loop claims it immediately and starts another scan right after, so
    # this only controls the idle sleep.
    rca_poll_interval_seconds: int = 30


settings = Settings()
