"""add gemini analysis columns to error_logs

Revision ID: 002
Revises: 001
Create Date: 2026-05-30
"""
from alembic import op

revision = "002"
down_revision = "001"
branch_labels = None
depends_on = None

_NEW_COLUMNS = [
    ("gemini_category",   "VARCHAR(100)"),
    ("gemini_analysis",   "TEXT"),
    ("gemini_suggestions","TEXT"),
    ("risk_level",        "VARCHAR(20)"),
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


def downgrade() -> None:
    for col, _ in _NEW_COLUMNS:
        try:
            op.execute(f"ALTER TABLE error_logs DROP COLUMN {col}")
        except Exception as e:
            if "1091" in str(e) or "Can't DROP" in str(e):
                pass
            else:
                raise
