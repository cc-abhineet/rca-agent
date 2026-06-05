"""add fingerprint + duplicate de-duplication columns to error_logs

Revision ID: 003
Revises: 002
Create Date: 2026-06-04
"""
from alembic import op

revision = "003"
down_revision = "002"
branch_labels = None
depends_on = None

_NEW_COLUMNS = [
    ("fingerprint",      "CHAR(64)"),
    ("duplicate_of",     "CHAR(36)"),
    ("occurrence_count", "INT NOT NULL DEFAULT 1"),
    ("last_seen_at",     "DATETIME"),
]


def upgrade() -> None:
    for col, col_type in _NEW_COLUMNS:
        try:
            op.execute(f"ALTER TABLE error_logs ADD COLUMN {col} {col_type}")
        except Exception as e:
            # 1060 = Duplicate column name — column already exists, safe to skip
            if "1060" in str(e) or "Duplicate column" in str(e):
                pass
            else:
                raise

    # Non-unique index: duplicates intentionally share a fingerprint with their original.
    try:
        op.execute("CREATE INDEX idx_error_logs_fp ON error_logs(fingerprint)")
    except Exception as e:
        if "1061" in str(e) or "Duplicate key name" in str(e):
            pass
        else:
            raise


def downgrade() -> None:
    try:
        op.execute("DROP INDEX idx_error_logs_fp ON error_logs")
    except Exception as e:
        if "1091" in str(e) or "check that column/key exists" in str(e):
            pass
        else:
            raise

    for col, _ in _NEW_COLUMNS:
        try:
            op.execute(f"ALTER TABLE error_logs DROP COLUMN {col}")
        except Exception as e:
            if "1091" in str(e) or "Can't DROP" in str(e):
                pass
            else:
                raise
