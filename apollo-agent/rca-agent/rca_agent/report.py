from .models import RCAReport


def validate_report(data: dict) -> RCAReport:
    """Validate and parse RCA report dict into RCAReport model."""
    return RCAReport(**data)
