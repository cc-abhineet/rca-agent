"""
app/chat_agent.py
─────────────────
Claude-powered chat agent for post-RCA follow-up questions.

Provides stream_rca_chat() — a generator that yields SSE data lines.
The agent has the full RCA report as context and can call two GitLab
tools for in-depth follow-up analysis.
"""

import json
import logging

import anthropic

from rca_agent.db import execute_one, json_loads, log_token_usage
from rca_agent.github_tools import get_repo_file, search_code_in_repo
from rca_agent.token_pricing import compute_cost
from rca_agent.config import settings
from rca_agent.overlay import get as overlay_get

logger = logging.getLogger(__name__)

# ── Tool definitions for Claude ───────────────────────────────────────────────

_TOOLS = [
    {
        "name": "search_code",
        "description": (
            "Search for code patterns, functions, or classes in the service repository. "
            "Use this when the user asks about specific code that may not be in the RCA report."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search pattern — function name, class, variable, or code snippet",
                },
                "repo_name": {
                    "type": "string",
                    "description": "Repository name to search in (defaults to the incident service name)",
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "read_file",
        "description": (
            "Read the full content of a specific file from the repository. "
            "Use when the user asks about a particular file or class mentioned in the RCA."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "repo_name": {
                    "type": "string",
                    "description": "Repository / service name",
                },
                "file_path": {
                    "type": "string",
                    "description": "Path to the file within the repository (e.g. src/main/java/…/Service.java)",
                },
                "ref": {
                    "type": "string",
                    "description": "Git branch or commit ref (default: main)",
                    "default": "main",
                },
            },
            "required": ["repo_name", "file_path"],
        },
    },
]


def _exec_tool(name: str, inp: dict, fallback_repo: str) -> str:
    """Execute a tool call and return the result as a string (max 5 000 chars)."""
    try:
        org = overlay_get("github_org") or settings.github_org

        if name == "search_code":
            repo = inp.get("repo_name") or fallback_repo
            results = search_code_in_repo(org=org, repo=repo, query=inp["query"])
            return json.dumps(results, default=str)[:5000]

        elif name == "read_file":
            repo = inp.get("repo_name") or fallback_repo
            content = get_repo_file(
                org=org,
                repo=repo,
                path=inp["file_path"],
                ref=inp.get("ref", "main"),
            )
            return str(content)[:5000]

        else:
            return f"Unknown tool: {name}"

    except Exception as exc:
        logger.warning("Chat tool %s failed: %s", name, exc)
        return f"Tool error: {exc}"


def _build_system_prompt(log_row: dict, report: dict | None) -> str:
    """Build a rich system prompt embedding incident + RCA context."""
    service  = log_row.get("service_name") or "unknown"
    error    = log_row.get("error_type")   or "unknown"
    message  = (log_row.get("error_message") or "")[:800]
    severity = log_row.get("severity") or ""

    lines = [
        "You are Apollo — an expert Site Reliability Engineer and AI assistant.",
        "A Root Cause Analysis (RCA) has just been performed for a production incident.",
        "Your job is to answer follow-up questions, explain the findings clearly, and",
        "perform additional code analysis when the user requests deeper investigation.",
        "",
        "══════════════════════════════════════════════════════",
        "INCIDENT",
        "══════════════════════════════════════════════════════",
        f"Service:  {service}",
        f"Error:    {error}",
        f"Severity: {severity}",
        f"Message:  {message}",
    ]

    if report:
        lines += [
            "",
            "══════════════════════════════════════════════════════",
            "RCA REPORT",
            "══════════════════════════════════════════════════════",
        ]

        inc = report.get("incident_summary") or {}
        if inc.get("description"):
            lines.append(f"Summary: {inc['description']}")
        if inc.get("user_impact"):
            lines.append(f"Impact:  {inc['user_impact']}")

        rc = report.get("root_cause") or {}
        if rc:
            lines += [
                "",
                "ROOT CAUSE:",
                f"  Summary:    {rc.get('summary', '')}",
                f"  Confidence: {rc.get('confidence', '')}",
                f"  Category:   {rc.get('category', '')}",
            ]
            cr = rc.get("code_reference") or {}
            if cr.get("file"):
                lines.append(f"  File:       {cr['file']}:{cr.get('line', '')}")
            if cr.get("snippet"):
                lines.append(f"  Snippet:    {cr['snippet'][:300]}")

        evidence = report.get("evidence") or []
        if evidence:
            lines.append("\nEVIDENCE:")
            for ev in evidence[:6]:
                desc = ev.get("description") if isinstance(ev, dict) else str(ev)
                lines.append(f"  - {desc}")

        sols = report.get("suggested_solutions") or []
        if sols:
            lines.append("\nSUGGESTED SOLUTIONS:")
            for sol in sols:
                p = sol.get("priority", "?")
                a = sol.get("action", "")
                r = sol.get("rationale", "")
                lines.append(f"  {p}. {a}")
                if r:
                    lines.append(f"     ↳ {r}")
    else:
        lines += [
            "",
            "Note: The RCA has not completed yet or no report is available.",
            "Answer based on the incident context above.",
        ]

    lines += [
        "",
        "══════════════════════════════════════════════════════",
        "INSTRUCTIONS",
        "══════════════════════════════════════════════════════",
        "- Answer questions about this incident concisely and accurately.",
        "- When the user asks about code details not fully covered in the report,",
        "  use search_code or read_file to retrieve them, then explain clearly.",
        "- Always ground answers in facts from the report or code — no speculation.",
        "- Use markdown with fenced code blocks (```language) for code snippets.",
        "- Keep responses focused and engineering-oriented.",
    ]

    return "\n".join(lines)


def stream_rca_chat(
    error_log_id: str,
    messages: list[dict],
    api_key: str,
    model: str,
):
    """
    Generator that streams SSE lines for a post-RCA chat turn.

    Emits:
      data: {"type": "chunk",       "text": "..."}
      data: {"type": "tool_call",   "tool": "search_code", "input": {...}}
      data: {"type": "tool_result", "tool": "search_code", "preview": "..."}
      data: {"type": "done"}
      data: {"type": "error",       "message": "..."}
    """
    try:
        log_row    = execute_one("SELECT * FROM error_logs WHERE id = %s", (error_log_id,)) or {}
        report_row = execute_one(
            "SELECT report FROM rca_reports WHERE error_log_id = %s ORDER BY generated_at DESC LIMIT 1",
            (error_log_id,),
        )
    except Exception as exc:
        yield f"data: {json.dumps({'type': 'error', 'message': f'DB error: {exc}'})}\n\n"
        return

    report = None
    if report_row and report_row.get("report"):
        raw = report_row["report"]
        try:
            report = json_loads(raw) if isinstance(raw, str) else raw
        except Exception:
            report = None

    service = log_row.get("service_name") or ""
    system_prompt = _build_system_prompt(log_row, report)

    try:
        client = anthropic.Anthropic(api_key=api_key)
        claude_msgs = list(messages)

        # ReAct loop — up to 5 rounds of tool calls before forcing end_turn
        for _round in range(6):
            with client.messages.stream(
                model=model,
                system=system_prompt,
                messages=claude_msgs,
                tools=_TOOLS,
                max_tokens=4096,
            ) as stream:
                for text in stream.text_stream:
                    yield f"data: {json.dumps({'type': 'chunk', 'text': text})}\n\n"

                final_msg = stream.get_final_message()

            # Log token usage for this round
            try:
                u = final_msg.usage
                cache_r = getattr(u, "cache_read_input_tokens", 0) or 0
                cache_w = getattr(u, "cache_creation_input_tokens", 0) or 0
                log_token_usage(
                    model=model,
                    source="chat_agent",
                    input_tokens=u.input_tokens,
                    output_tokens=u.output_tokens,
                    error_log_id=error_log_id,
                    cache_read_tokens=cache_r,
                    cache_creation_tokens=cache_w,
                    estimated_cost_usd=compute_cost(
                        model, u.input_tokens, u.output_tokens, cache_r, cache_w
                    ),
                )
            except Exception:
                pass

            if final_msg.stop_reason != "tool_use":
                break

            # Handle tool calls
            claude_msgs.append({"role": "assistant", "content": final_msg.content})
            tool_results = []

            for block in final_msg.content:
                if block.type != "tool_use":
                    continue

                yield f"data: {json.dumps({'type': 'tool_call', 'tool': block.name, 'input': block.input})}\n\n"

                result = _exec_tool(block.name, block.input, fallback_repo=service)

                yield f"data: {json.dumps({'type': 'tool_result', 'tool': block.name, 'preview': result[:400]})}\n\n"

                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": result,
                })

            claude_msgs.append({"role": "user", "content": tool_results})

    except anthropic.APIError as exc:
        yield f"data: {json.dumps({'type': 'error', 'message': str(exc)})}\n\n"
        return

    yield f"data: {json.dumps({'type': 'done'})}\n\n"
