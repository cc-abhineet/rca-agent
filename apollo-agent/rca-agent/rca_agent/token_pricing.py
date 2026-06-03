"""
Token cost estimation based on published Anthropic and Google AI pricing (mid-2025).
Costs shown in the UI are labeled "estimated" — actual billing may vary.
"""

_PRICING_PER_M: dict[str, dict[str, float]] = {
    "claude-haiku-4-5-20251001": {
        "input": 0.80, "output": 4.00,
        "cache_read": 0.08, "cache_write": 1.00,
    },
    "claude-haiku-4-5": {
        "input": 0.80, "output": 4.00,
        "cache_read": 0.08, "cache_write": 1.00,
    },
    "claude-sonnet-4-6": {
        "input": 3.00, "output": 15.00,
        "cache_read": 0.30, "cache_write": 3.75,
    },
    "claude-opus-4-8": {
        "input": 15.00, "output": 75.00,
        "cache_read": 1.50, "cache_write": 18.75,
    },
    "gemini-2.5-flash": {
        "input": 0.15, "output": 0.60,
        "cache_read": 0.0, "cache_write": 0.0,
    },
    "gemini-2.5-flash-preview-04-17": {
        "input": 0.15, "output": 0.60,
        "cache_read": 0.0, "cache_write": 0.0,
    },
    "gemini-1.5-flash": {
        "input": 0.075, "output": 0.30,
        "cache_read": 0.0, "cache_write": 0.0,
    },
}

_DISPLAY_NAMES: dict[str, str] = {
    "claude-haiku-4-5-20251001":      "Claude Haiku 4.5",
    "claude-haiku-4-5":               "Claude Haiku 4.5",
    "claude-sonnet-4-6":              "Claude Sonnet 4.6",
    "claude-opus-4-8":                "Claude Opus 4.8",
    "gemini-2.5-flash":               "Gemini 2.5 Flash",
    "gemini-2.5-flash-preview-04-17": "Gemini 2.5 Flash",
    "gemini-1.5-flash":               "Gemini 1.5 Flash",
}


def compute_cost(
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int = 0,
    cache_creation_tokens: int = 0,
) -> float:
    # Try exact match first, then strip date suffix (e.g. -20251001)
    p = _PRICING_PER_M.get(model)
    if p is None:
        base = model.rsplit("-", 1)[0]
        p = _PRICING_PER_M.get(base)
    if p is None:
        return 0.0
    return round(
        (input_tokens          / 1_000_000) * p["input"]  +
        (output_tokens         / 1_000_000) * p["output"] +
        (cache_read_tokens     / 1_000_000) * p.get("cache_read", 0) +
        (cache_creation_tokens / 1_000_000) * p.get("cache_write", 0),
        8,
    )


def display_name(model: str) -> str:
    return _DISPLAY_NAMES.get(model, model)
