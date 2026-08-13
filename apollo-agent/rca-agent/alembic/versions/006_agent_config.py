"""add agent_config table for active org tracking (no key paste needed)

Revision ID: 006
Revises: 005
Create Date: 2026-06-30

Stores key/value config for the ingestion agent, primarily 'active_ingest_org_id'
so the agent knows which org to tag errors with — without needing APOLLO_INGEST_API_KEY
set manually in .env.
"""
from alembic import op

revision = "006"
down_revision = "005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS agent_config (
            config_key   VARCHAR(100) NOT NULL PRIMARY KEY,
            config_value TEXT,
            updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS agent_config")
