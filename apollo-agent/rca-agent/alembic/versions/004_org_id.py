"""add org_id to error_logs and ingest_api_key to organisations

Revision ID: 004
Revises: 003
Create Date: 2026-06-30
"""
from alembic import op

revision = "004"
down_revision = "003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Create organisations table (idempotent — app startup also does this,
    # but Alembic runs before the app so we must create it here too)
    op.execute("""
        CREATE TABLE IF NOT EXISTS organisations (
            id VARCHAR(36) NOT NULL PRIMARY KEY,
            owner_user_id INT NOT NULL,
            name VARCHAR(255) NOT NULL,
            environment VARCHAR(50) DEFAULT 'production',
            ingest_api_key VARCHAR(64) NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_org_owner (owner_user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    # Create org_integrations table (idempotent)
    op.execute("""
        CREATE TABLE IF NOT EXISTS org_integrations (
            id VARCHAR(36) NOT NULL PRIMARY KEY,
            org_id VARCHAR(36) NOT NULL,
            user_id INT NOT NULL,
            integration_type VARCHAR(50) NOT NULL,
            config_json TEXT NOT NULL,
            is_connected TINYINT(1) NOT NULL DEFAULT 0,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uk_oi_org_type (org_id, integration_type)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    # If organisations already existed without ingest_api_key, add it
    try:
        op.execute("ALTER TABLE organisations ADD COLUMN ingest_api_key VARCHAR(64) NULL")
    except Exception as e:
        if "1060" in str(e) or "Duplicate column" in str(e):
            pass   # column already there from the CREATE TABLE above
        else:
            raise

    # Add org_id to error_logs
    try:
        op.execute("ALTER TABLE error_logs ADD COLUMN org_id VARCHAR(36) NULL")
    except Exception as e:
        if "1060" in str(e) or "Duplicate column" in str(e):
            pass
        else:
            raise

    # Index for fast per-org queries
    try:
        op.execute("CREATE INDEX idx_error_logs_org ON error_logs(org_id)")
    except Exception as e:
        if "1061" in str(e) or "Duplicate key name" in str(e):
            pass
        else:
            raise


def downgrade() -> None:
    try:
        op.execute("DROP INDEX idx_error_logs_org ON error_logs")
    except Exception:
        pass
    try:
        op.execute("ALTER TABLE error_logs DROP COLUMN org_id")
    except Exception:
        pass
    try:
        op.execute("ALTER TABLE organisations DROP COLUMN ingest_api_key")
    except Exception:
        pass
