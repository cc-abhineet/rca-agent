"""fix org_integrations unique key to (org_id, integration_type) for true per-org isolation

Revision ID: 005
Revises: 004
Create Date: 2026-06-30

The old unique key was (user_id, integration_type) which means one user can only
have ONE 'datadog' integration across ALL their orgs — the second org's Datadog
creds would silently overwrite the first org's. The correct key is (org_id, integration_type)
so each org can have its own independent credentials.
"""
from alembic import op

revision = "005"
down_revision = "004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Drop old per-user unique key if it exists
    try:
        op.execute("ALTER TABLE org_integrations DROP INDEX uk_oi_user_type")
    except Exception as e:
        if "1091" in str(e) or "Can't DROP" in str(e) or "check that it exists" in str(e):
            pass   # key never existed (fresh install already has correct key)
        else:
            raise

    # Add correct per-org unique key if it doesn't already exist
    try:
        op.execute("ALTER TABLE org_integrations ADD UNIQUE KEY uk_oi_org_type (org_id, integration_type)")
    except Exception as e:
        if "1061" in str(e) or "Duplicate key name" in str(e):
            pass   # already added (fresh install from 004 already has it)
        else:
            raise


def downgrade() -> None:
    try:
        op.execute("ALTER TABLE org_integrations DROP INDEX uk_oi_org_type")
    except Exception:
        pass
    try:
        op.execute("ALTER TABLE org_integrations ADD UNIQUE KEY uk_oi_user_type (user_id, integration_type)")
    except Exception:
        pass
