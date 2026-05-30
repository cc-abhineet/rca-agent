# Apollo RCA Platform — Codebase Deep Dive

## Overview

Apollo is an AI-powered Root Cause Analysis platform for a multi-service Java demo application. It automatically detects production errors, classifies them with Gemini, and runs a ReAct-style Claude agent to investigate code, commits, and deployments in GitHub to find the root cause.

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Docker Compose Stack                         │
│                                                                      │
│  ┌──────────────┐  ┌─────────────────┐  ┌──────────────────┐       │
│  │ banking-app  │  │ pricing-service  │  │  order-service   │       │
│  │  :8080       │  │   :8081          │  │   :8082          │       │
│  │ Spring Boot  │  │  Spring Boot     │  │  Spring Boot     │       │
│  └──────┬───────┘  └────────┬────────┘  └────────┬─────────┘       │
│         │                   │                     │                  │
│         └─────────────── app-logs ────────────────┘                 │
│                    (shared Docker volume)                            │
│                    /var/log/banking-app/app.log                      │
│                                                                      │
│  ┌──────────────────────────────────────┐                           │
│  │       error-ingestion-agent          │  ──► MySQL (host)         │
│  │  File watcher → Gemini → error_logs  │                           │
│  │  OR Datadog Logs API → Gemini → DB   │                           │
│  │  Control API on :8001                │                           │
│  └──────────────────────────────────────┘                           │
│                                                                      │
│  ┌──────────────────────────────────────┐                           │
│  │            rca-agent :8000           │  ──► MySQL (host)         │
│  │  FastAPI + Apollo React UI           │  ──► Anthropic API        │
│  │  Claude ReAct loop (8 iterations)    │  ──► GitHub API           │
│  └──────────────────────────────────────┘                           │
│                                                                      │
│  ┌─────────────┐   ┌────────────────────┐                           │
│  │  dd-agent   │   │   demo-ui :5000    │                           │
│  │ (Datadog v7)│   │  (chaos trigger)   │                           │
│  └─────────────┘   └────────────────────┘                           │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Repository Layout

```
rca-agent/
├── docker-compose.yml
├── .env                          # secrets (never committed)
├── env.example                   # copy → .env
├── datadog/conf.d/               # Datadog agent log collection config
├── add_service_map.py            # helper: register new service in DB
├── setup_db.sql                  # MySQL schema bootstrap
│
├── ui/                           # demo chaos-trigger Flask UI (port 5000)
│
└── banking-app-master/
    ├── projects.yaml             # ← single source of truth for all services
    │
    ├── src/                      # banking-app (Spring Boot)
    ├── pricing-service/          # pricing-service (Spring Boot)
    ├── order-service/            # order-service (Spring Boot)
    │
    ├── error-ingestion-agent/    # Python — watches logs, classifies, stores
    │   ├── main.py               # FastAPI control server + file watcher + DD poller
    │   ├── datadog_poller.py     # Datadog Logs API cursor-based polling
    │   ├── agents/log_monitor/
    │   │   ├── graph.py          # LangGraph pipeline definition
    │   │   └── nodes.py          # parse → analyze (Gemini) → store
    │   ├── db/database.py        # aiomysql async DB layer
    │   ├── config/settings.py    # pydantic-settings
    │   └── utils/
    │       ├── log_parser.py     # regex log line parser
    │       └── severity_rules.py # pre-defined exception → severity map
    │
    └── rca-agent/                # Python — Claude RCA agent + Apollo UI
        ├── app/main.py           # FastAPI API (all /api/* endpoints)
        ├── rca_agent/
        │   ├── agent.py          # Claude ReAct loop (main logic)
        │   ├── config.py         # pydantic-settings
        │   ├── db.py             # pymysql sync DB layer
        │   ├── overlay.py        # runtime settings file reader (TTL cache)
        │   ├── token_pricing.py  # cost estimation per model
        │   ├── github_tools.py   # PyGitHub wrappers (file, diff, search)
        │   ├── repo_resolver.py  # service name → GitHub repo
        │   ├── models.py         # RCAReport Pydantic model
        │   ├── report_renderer.py# HTML report template
        │   ├── cache.py          # DB-backed context cache
        │   └── dependency_memory.py  # cross-service dep learning
        └── ui/                   # Apollo React app (Vite)
            └── src/
                ├── pages/        # Landing.jsx, Dashboard.jsx
                ├── components/   # LogViewer, RCADashboard, TokenUsage, Settings, …
                ├── context/      # AppContext (monitoring state, source toggle)
                └── api/client.js # all fetch wrappers
```

---

## Data Flow — Local Mode

```
Java app throws exception
        │
        ▼
logback writes → /var/log/banking-app/app.log  (shared Docker volume)
        │
        ▼
LogFileHandler (watchdog) detects file change, buffers multi-line entry
        │
        ▼
is_error_line() filters WARN/INFO — only ERROR lines continue
        │
        ▼
LangGraph pipeline (async):
  parse_node  → log_parser.py extracts timestamp, level, error_type, stack_trace
  analyze_node→ Gemini gemini-2.5-flash:
                  • classifies category (code_defect | config_error | …)
                  • assigns risk_level (critical/high/medium/low)
                  • writes gemini_analysis (≤40 words)
                  • writes gemini_suggestions (3 × ≤12 words)
  store_node  → INSERT into MySQL error_logs
        │
        ▼
Apollo dashboard (LogViewer) auto-refreshes every 10s from DB
```

## Data Flow — Datadog Mode

```
User: Stop Monitoring → select Datadog → Start Monitoring
        │
        ▼
POST /api/monitoring {action:start, dd_api_key, dd_app_key}
        │  RCA agent forwards effective credentials
        ▼
ingestion-agent: _run_dd_poller_loop(start_from=_monitoring_stopped_at)
        │
        ▼  every 30s
Datadog Logs API v2 /logs/events/search
  • Cursor-based pagination (at-least-once delivery)
  • start_from = exact UTC timestamp when Stop was pressed (no gap, no flood)
  • 2-minute dedup cache: same service+error_type skipped within window
        │
        ▼
_build_raw_log() reconstructs full log string including error.stack
        │
        ▼
Same LangGraph pipeline as local mode → MySQL
```

## RCA Agent — ReAct Loop

```
User clicks "Run RCA" on an incident card
        │
        ▼
GET /api/rca/stream/{id}  (SSE stream)
        │
        ▼
RCAAgent.run(error_log_id, api_key, model, max_iterations)
  1. Load error_log from DB
  2. RepoResolver: service_name → GitHub org/repo
        CI/CD deployments → service_repo_map → sub-agent discovery
  3. ReAct loop (max 8 iterations):
     │
     ├─ Claude claude-haiku-4-5-20251001 (4096 max_tokens)
     │   reads: error log context + all previous tool results
     │
     ├─ Tools available (13 total):
     │   read_dependency_memory    check known upstream causes
     │   get_recent_deployments    what changed in last 48h
     │   read_context_cache        DB cache — avoids redundant GitHub calls
     │   get_repo_file             fetch file content (truncated at 4000 chars)
     │   list_repo_files           explore repo structure
     │   search_code_in_repo       find symbol in one repo
     │   search_github_global      find symbol across all repos in org
     │   get_commit_diff           what changed in a specific commit
     │   get_commits_since         list all commits since a timestamp
     │   get_service_metadata      from observability adapter
     │   write_context_cache       persist GitHub fetch to DB cache
     │   write_dependency_memory   record cross-service dependency
     │   finish_rca                submit final report (exits loop)
     │
     └─ Token usage logged to token_usage table after each API call
        │
        ▼
  4. RCAReport (Pydantic): root_cause, timeline, evidence, suggestions
  5. UPDATE error_logs SET rca_status='completed', rca_result=<json>
```

---

## Database Schema (MySQL `rca_db`)

### `error_logs`
| Column | Type | Description |
|---|---|---|
| id | VARCHAR(36) | UUID primary key |
| service_name | VARCHAR | e.g. `banking-app` |
| error_type | VARCHAR | e.g. `NullPointerException` |
| error_message | TEXT | human-readable message |
| stack_trace | JSON | array of `{text}` objects |
| severity | VARCHAR | ERROR / WARN |
| risk_level | VARCHAR | critical / high / medium / low |
| gemini_category | VARCHAR | code_defect / config_error / … |
| gemini_analysis | TEXT | ≤40 word root cause summary |
| gemini_suggestions | TEXT | 3 suggestions separated by `;` |
| rca_status | VARCHAR | pending / in_progress / completed / failed |
| rca_result | JSON | full RCAReport JSON |
| metadata | JSON | `{source: "db_watcher"|"datadog_poll"}` |

### `token_usage`
Stores every Anthropic + Gemini API call with real token counts and estimated cost. Used by the Token Consumption tab.

### `service_context_cache`
DB-backed cache for GitHub file fetches and Datadog polling cursors. Prevents redundant API calls across RCA runs.

### `service_repo_map`
Maps service names to GitHub org/repo. Populated by `add_service_map.py` and auto-discovered by the sub-agent.

---

## Apollo UI — Pages & Components

| Component | Purpose |
|---|---|
| `Landing.jsx` | Animated star-field intro page |
| `Dashboard.jsx` | Main shell: sidebar + header + page routing |
| `Sidebar.jsx` | Nav: Logs / RCA / Tokens / Settings |
| `StatsBar.jsx` | 6-card count-up grid (total / pending / critical / high / …) |
| `LogViewer.jsx` | Always reads from DB; filter by service/risk; 10s auto-refresh; Stop RCA button on in-progress cards |
| `RCADashboard.jsx` | Incident list with status; Run/Stream/Report actions |
| `RCAStreamPanel.jsx` | SSE overlay: phase tracker, typewriter reasoning, tool call accordion, Stop RCA |
| `TokenUsage.jsx` | Hero stats, per-model breakdown bars, recent API calls table |
| `Settings.jsx` | 5 sections; ⚡ Test Credentials button; instant vs restart badges |

### Header Controls
- **Stop Monitoring / Start Monitoring** — stops/starts the ingestion pipeline; records stop timestamp for gapless resume
- **Local DB ↔ Datadog toggle** — enabled only when monitoring is stopped; switches ingestion source on next Start

---

## Settings — What Takes Effect When

| Setting | Effect |
|---|---|
| Anthropic API Key | Instant — new client created per RCA run |
| Model | Instant — read at start of every RCA run |
| Max Iterations | Instant — read at start of every RCA run |
| GitHub PAT | Instant — PyGitHub client recreated when PAT changes |
| GitHub Org | Instant — read from overlay on every repo resolution |
| Database URL | Instant — read from overlay on every new connection |
| DD API Key / App Key / Site | Instant for Log Explorer; forwarded to ingestion agent on next Start |
| Observability Adapter | **Container restart required** |
| CI/CD Adapter | **Container restart required** |

Runtime overrides are stored in `/app/apollo_settings.json` (Docker) and read with a 5-second TTL cache by `overlay.py`.

---

## Adding a New Service

1. Add an entry to `banking-app-master/projects.yaml`
2. Run `python add_service_map.py` to register the GitHub repo in DB
3. Mount the service's log file in `docker-compose.yml` under `ingestion-agent` volumes
4. Run `docker compose up --build`

No Python or Java code changes required.

---

## Key Design Decisions

**Single shared log volume** — all three Java services write to one file. The ingestion agent tails it and uses `DD_LOGS_INJECTION` fields (`dd.service`) to attribute each line to the right service.

**DB as display source of truth** — the Apollo LogViewer always reads from MySQL regardless of whether local or Datadog mode is active. The toggle only controls where new errors are ingested from.

**Cursor-based Datadog polling** — the poller saves a Datadog pagination cursor after each batch so it resumes exactly where it left off after a restart (at-least-once delivery).

**Gapless monitoring resume** — Stop records `_monitoring_stopped_at` + file byte positions. Start passes the stop timestamp to the Datadog poller and restores file positions to the file watcher.

**Token tracking** — every Claude and Gemini API call stores real `input_tokens` / `output_tokens` from the API response (not estimated). Cost is computed client-side from published pricing.
