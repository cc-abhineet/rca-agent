"""initial schema

Revision ID: 001
Revises:
Create Date: 2026-05-14
"""
from alembic import op
import sqlalchemy as sa

revision = "001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    # error_logs — primary store for ingested errors
    op.execute("""
        CREATE TABLE IF NOT EXISTS error_logs (
            id               CHAR(36)     NOT NULL PRIMARY KEY,
            service_name     VARCHAR(255) NOT NULL,
            environment      VARCHAR(100) NOT NULL,
            error_type       VARCHAR(500) NOT NULL,
            error_message    TEXT         NOT NULL,
            stack_trace      JSON         NOT NULL,
            severity         VARCHAR(50)  NOT NULL,
            occurred_at      DATETIME     NOT NULL,
            request_id       VARCHAR(255),
            user_id          VARCHAR(255),
            metadata         JSON,
            rca_status       VARCHAR(50)  NOT NULL DEFAULT 'pending',
            rca_started_at   DATETIME,
            rca_completed_at DATETIME,
            rca_result       JSON,
            rca_error        TEXT
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """)

    # service_repo_map — maps service names to GitHub repos
    op.execute("""
        CREATE TABLE IF NOT EXISTS service_repo_map (
            service_name   VARCHAR(255) NOT NULL PRIMARY KEY,
            github_org     VARCHAR(255) NOT NULL,
            github_repo    VARCHAR(255) NOT NULL,
            default_branch VARCHAR(100) NOT NULL DEFAULT 'main',
            language       VARCHAR(100),
            onboarded_at   DATETIME     DEFAULT NOW(),
            onboarded_by   VARCHAR(255),
            notes          TEXT
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """)

    # service_context_cache — caches GitHub file content across RCA sessions
    op.execute("""
        CREATE TABLE IF NOT EXISTS service_context_cache (
            id             INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
            service_name   VARCHAR(255) NOT NULL,
            cache_key      VARCHAR(500) NOT NULL,
            content        JSON         NOT NULL,
            commit_sha     VARCHAR(40),
            created_at     DATETIME     DEFAULT NOW(),
            last_used_at   DATETIME     DEFAULT NOW(),
            invalidated_at DATETIME,
            UNIQUE KEY uq_cache (service_name, cache_key)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """)

    # rca_reports — completed RCA reports
    op.execute("""
        CREATE TABLE IF NOT EXISTS rca_reports (
            rca_id         VARCHAR(36)  NOT NULL PRIMARY KEY,
            error_log_id   CHAR(36),
            service_name   VARCHAR(255) NOT NULL,
            generated_at   VARCHAR(50)  NOT NULL,
            report         JSON         NOT NULL,
            created_at     DATETIME     DEFAULT NOW(),
            CONSTRAINT fk_rca_error_log
                FOREIGN KEY (error_log_id) REFERENCES error_logs(id)
                ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    """)

    # Indexes — MySQL has no CREATE INDEX IF NOT EXISTS, catch duplicate key error (1061)
    for idx_sql in [
        "CREATE INDEX idx_error_logs_service  ON error_logs(service_name)",
        "CREATE INDEX idx_error_logs_occurred ON error_logs(occurred_at DESC)",
        "CREATE INDEX idx_error_logs_status   ON error_logs(rca_status)",
        "CREATE INDEX idx_cache_service       ON service_context_cache(service_name)",
    ]:
        try:
            op.execute(idx_sql)
        except Exception as e:
            if "1061" in str(e) or "Duplicate key name" in str(e):
                pass
            else:
                raise


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS rca_reports")
    op.execute("DROP TABLE IF EXISTS service_context_cache")
    op.execute("DROP TABLE IF EXISTS service_repo_map")
    op.execute("DROP TABLE IF EXISTS error_logs")
