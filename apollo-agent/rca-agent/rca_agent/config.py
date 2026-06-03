from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        # Search repo root → apollo-agent → local .env (for local dev outside Docker).
        # In Docker, env vars are injected by docker-compose and take precedence.
        env_file=("../../.env", "../.env", ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    anthropic_api_key: str
    github_pat: str = ""
    github_org: str = "apollo"
    gitlab_url: str = "http://devopstools-1761743684.us-east-2.elb.amazonaws.com"
    database_url: str = "mysql+pymysql://root:root@localhost:3306/rca_db"
    model: str = "claude-haiku-4-5-20251001"
    max_react_iterations: int = 20
    observability_adapter: str = "local"   # "local" | "datadog"
    cicd_adapter: str = "mock"             # "mock" | "real"

    # ── Cross-service memory ──────────────────────────────────────────────────
    # Path to the JSON file where the agent persists discovered service→repo deps.
    # Relative to CWD when the agent starts; override with env var DEPENDENCY_MEMORY_PATH.
    dependency_memory_path: str = "dependency_memory.json"



settings = Settings()
