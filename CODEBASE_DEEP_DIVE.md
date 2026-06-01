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
│  │  Claude ReAct loop (up to 20 iters)  │  ──► GitHub API           │
│  └──────────────────────────────────────┘                           │
│                                                                      │
│  ┌─────────────┐   ┌────────────────────┐                           │
│  │  dd-agent   │   │  demo-ui :5000     │                           │
│  │ (Datadog v7)│   │  (chaos trigger +  │                           │
│  │             │   │   live log viewer) │                           │
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
│   └── app.py                    # Flask server: live log stream + chaos buttons
│
└── banking-app-master/
    ├── projects.yaml             # single source of truth for all services
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
        ├── app/main.py           # FastAPI API (all /api/* endpoints + SSE pub-sub)
        ├── rca_agent/
        │   ├── agent.py          # Claude ReAct loop (main logic, 20 iterations)
        │   ├── config.py         # pydantic-settings
        │   ├── db.py             # pymysql sync DB layer + token_usage logging
        │   ├── overlay.py        # runtime settings file reader (5s TTL cache)
        │   ├── token_pricing.py  # cost estimation per model
        │   ├── github_tools.py   # PyGitHub wrappers (file, diff, search, global)
        │   ├── repo_resolver.py  # service name → GitHub repo (fixed recursion bug)
        │   ├── models.py         # RCAReport Pydantic model (schema v1.1)
        │   ├── report_renderer.py# HTML report template + print/PDF button
        │   ├── cache.py          # DB-backed context cache
        │   └── dependency_memory.py  # cross-service dependency learning
        └── ui/                   # Apollo React app (Vite)
            └── src/
                ├── pages/        # Landing.jsx, Dashboard.jsx
                ├── components/
                │   ├── LogViewer.jsx       # DB log browser with filters
                │   ├── RCADashboard.jsx    # Incident cards with inline run/stream/report
                │   ├── RCAStreamPanel.jsx  # SSE overlay: neural bg, timeline, iteration groups
                │   ├── ReportsPage.jsx     # Completed RCA report browser + PDF download
                │   ├── TokenUsage.jsx      # Token/cost breakdown
                │   ├── Settings.jsx        # Runtime credentials + model config
                │   ├── Sidebar.jsx         # Nav with new Reports badge
                │   └── StatsBar.jsx        # Aggregate counts
                ├── context/      # AppContext (stream state, newReportCount, monitoring)
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
is_error_line() filters — only ERROR-level lines continue
Note: WARN messages are demoted to INFO in ChaosController so they don't
      create false incidents. Only real errors from GlobalExceptionHandler
      generate DB entries.
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
User clicks "Run RCA" or "▶ Run RCA" on an incident card
        │
        ▼
GET /api/rca/stream/{id}  (SSE stream — pub-sub, no duplicate agents)
        │
        ▼  Pub-sub check:
        │  If job already running → subscribe only (no new agent thread)
        │  If new job → start agent + subscribe
        │  If completed/failed → subscribe; agent broadcasts done immediately
        ▼
RCAAgent.run(error_log_id, api_key, model, max_iterations)
  1. Load error_log from DB
  2. RepoResolver: service_name → GitHub org/repo
        CI/CD deployments → service_repo_map → sub-agent discovery
        (fixed: _effective_org() no longer recurses infinitely)
  3. ReAct loop (max 20 iterations, configurable via Settings or env):
     │
     ├─ Claude claude-haiku-4-5-20251001 (4096 max_tokens)
     │   reads: error log context + all previous tool results
     │
     ├─ Tools available (13 total):
     │   read_dependency_memory    check known upstream causes (always first)
     │   get_recent_deployments    what changed in last 48h
     │   read_context_cache        DB cache — avoids redundant GitHub calls
     │   get_repo_file             fetch file content (truncated at 4000 chars)
     │   list_repo_files           explore repo structure
     │   search_code_in_repo       find symbol in one repo
     │   search_github_global      find symbol across all repos in org
     │   get_commit_diff           what changed in a specific commit (patches at 2000 chars)
     │   get_commits_since         list all commits since a timestamp
     │   get_service_metadata      from observability adapter
     │   write_context_cache       persist GitHub fetch to DB cache
     │   write_dependency_memory   record cross-service dependency (staged; flushed post-loop)
     │   finish_rca                submit final report (exits loop)
     │
     └─ Token usage logged to token_usage table after each API call
        │
        ▼
  4. Force-report at iteration 20 if finish_rca not called:
     Claude is given one final "call finish_rca NOW" prompt with low-confidence defaults
     Pydantic fallbacks ensure report always validates even with incomplete data
        │
        ▼
  5. RCAReport v1.1 (Pydantic):
       root_cause (with required code_reference), timeline, evidence,
       suggested_solutions, impact_assessment, analysis_metadata
  6. UPDATE error_logs SET rca_status='completed', rca_result=<json>
  7. Completion event broadcast to ALL subscribers (reconnected tabs included)
```

---

## SSE Streaming — Pub-Sub Architecture

`/api/rca/stream/{error_log_id}` uses a module-level `_active_jobs` dict:

```
_active_jobs = {
  "<error_log_id>": {
    "queues": [Queue, Queue, ...],   # one per connected browser tab
    "done": bool
  }
}
```

- **First request for an ID**: starts agent thread, registers subscriber queue
- **Subsequent requests** (reconnect / second tab): subscribes only — no new agent
- **Agent broadcasts**: `_job_broadcast()` puts events into all subscriber queues
- **Agent finishes**: `_job_finish()` sends sentinel `None` to all queues; slot kept 60s for late reconnectors
- **Browser disconnects**: subscriber queue removed from list by SSE generator's `finally` block

**SSE event shapes emitted by the agent:**

| type | fields | meaning |
|---|---|---|
| `start` | `service`, `error_type` | agent initialized |
| `reasoning` | `text` | Claude's thinking text |
| `tool_call` | `tool`, `input` | tool about to be invoked |
| `tool_result` | `tool`, `summary` | tool result (human-readable) |
| `cache_hit` | `key` | DB cache used instead of GitHub API |
| `sub_agent` | `action` | repo discovery sub-agent launched |
| `complete` | `confidence`, `iterations`, `cross_service` | RCA done |
| `done` | `report` | full RCAReport JSON (from main.py after agent exits) |
| `error` | `message` | agent or API error |

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
| rca_result | JSON | full RCAReport v1.1 JSON |
| metadata | JSON | `{source: "db_watcher"\|"datadog_poll"}` |

### `token_usage`
Stores every Anthropic API call with real token counts (input, output, cache_read, cache_creation) and estimated cost in USD. Used by the Token Consumption tab. Columns include `model`, `source`, `error_log_id`, `iteration_num`, `estimated_cost_usd`.

### `service_context_cache`
DB-backed cache for GitHub file fetches and Datadog polling cursors. Prevents redundant API calls across RCA runs. Key format: `file:<path>` for files, `repo_tree` for directory listings.

### `service_repo_map`
Maps service names to GitHub org/repo. Populated by `add_service_map.py` and auto-discovered by the sub-agent.

---

## Apollo UI — Pages & Components

| Component | Purpose |
|---|---|
| `Landing.jsx` | Animated star-field intro page |
| `Dashboard.jsx` | Main shell: sidebar + header + page routing |
| `Sidebar.jsx` | Nav: Logs / RCA / **Reports** / Tokens / Settings; Reports badge shows new count |
| `StatsBar.jsx` | Aggregate counts (total / pending / critical / high / …) |
| `LogViewer.jsx` | Reads from DB; filter by service/risk/status; 10s auto-refresh |
| `RCADashboard.jsx` | Clickable stat cards (filter by status); incident list with colored left border; inline Run/Live/Report/Re-run buttons; auto-refresh |
| `RCAStreamPanel.jsx` | Full-screen SSE overlay with neural background canvas, phase tracker (4 steps), iteration groups (reasoning + tools grouped), SVG confidence gauge, filter bar with counts, expand/collapse all, completion celebration animation, stop animation, session-level event cache (re-open shows correct state) |
| `ReportsPage.jsx` | **New** — browse all completed RCAs; search + confidence filter + sort; inline detail panel with all report sections; PDF download (HTML blob + print button) |
| `TokenUsage.jsx` | Hero stats, per-model breakdown, recent API calls table |
| `Settings.jsx` | 5 sections; ⚡ Test Credentials button; instant vs restart badges |

### RCA Stream Panel Features
- **Neural background**: animated node-network canvas, speeds up while agent is running
- **Phase tracker**: Initialize → Repository → Analysis → Complete with checkmarks
- **Iteration groups**: each reasoning step + its tool calls/results collapsed under `Iteration N`
- **Confidence gauge**: SVG circular gauge (high=92%, medium=65%, low=38%) shown on `complete` event
- **Filter bar**: All / Reasoning / Tools / System with live event counts; Expand/Collapse All
- **Session cache**: closing and re-opening the panel restores all events without starting a new agent
- **Completion celebration**: 3-second green checkmark overlay with confidence + iterations
- **Stop animation**: 2.5-second red stop overlay when user cancels RCA

### Header Controls
- **Stop Monitoring / Start Monitoring** — stops/starts the ingestion pipeline
- **Local DB ↔ Datadog toggle** — enabled only when monitoring is stopped

---

## Chaos Controller — Clean Error Generation

All three services have a `ChaosController` that generates errors for demo purposes. Key design:

- Chaos trigger endpoints log at `INFO` (not WARN/ERROR) before throwing
- The single exception is caught by `GlobalExceptionHandler` which logs at `ERROR` once
- This prevents double-logging and false incidents from WARN messages containing "Exception" in their text
- Affected files: `banking-app/ChaosController.java`, `pricing-service/ChaosController.java`, `order-service/ChaosController.java`, `order-service/OrderService.java`

---

## Settings — What Takes Effect When

| Setting | Effect |
|---|---|
| Anthropic API Key | Instant — new client created per RCA run |
| Model | Instant — read at start of every RCA run |
| Max Iterations | Instant — read at start of every RCA run (default: 20) |
| GitHub PAT | Instant — PyGitHub client recreated when PAT changes |
| GitHub Org | Instant — read from overlay on every repo resolution |
| Database URL | Instant — read from overlay on every new connection |
| DD API Key / App Key / Site | Instant for Log Explorer; forwarded to ingestion agent on next Start |
| Observability Adapter | **Container restart required** |
| CI/CD Adapter | **Container restart required** |

Runtime overrides are stored in `/app/apollo_settings.json` (Docker) and read with a 5-second TTL cache by `overlay.py`. Docker env vars (e.g. `MAX_REACT_ITERATIONS=20`) take precedence over Python defaults but are overridden by the Settings UI overlay.

---

## RCA Reports — PDF Export

Every completed RCA has an HTML report at `/rca/{id}/report` (rendered by `report_renderer.py`):
- Self-contained HTML (no external dependencies)
- Floating **🖨 Print / Save PDF** button (hidden in `@media print`)
- All styling is inline — safe to save and open offline

From the **Reports** tab in Apollo:
- **📥 PDF** button fetches the HTML, creates a Blob, and downloads as `rca-report-{service}-{date}.html`
- **🔗 Open** opens the report in a new tab where users can print to PDF

---

## Key Design Decisions

**Single shared log volume** — all three Java services write to one file. The ingestion agent tails it and uses `DD_LOGS_INJECTION` fields (`dd.service`) to attribute each line to the right service.

**DB as display source of truth** — the Apollo LogViewer always reads from MySQL regardless of whether local or Datadog mode is active. The toggle only controls where new errors are ingested from.

**Cursor-based Datadog polling** — the poller saves a Datadog pagination cursor after each batch so it resumes exactly where it left off after a restart (at-least-once delivery).

**Gapless monitoring resume** — Stop records `_monitoring_stopped_at` + file byte positions. Start passes the stop timestamp to the Datadog poller and restores file positions to the file watcher.

**Token tracking** — every Claude API call stores real `input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens` from the API response. Cost computed from published pricing via `token_pricing.py`.

**Pub-sub SSE** — reconnecting a closed stream panel subscribes to the ongoing agent instead of spawning a duplicate. The module-level `_active_jobs` dict maps error log IDs to lists of subscriber queues. Broadcast is fire-and-forget; dead queues are pruned.

**Force-report fallback** — if Claude reaches max iterations without calling `finish_rca`, a final one-shot prompt is sent. Pydantic field defaults guarantee the report always validates. The `analysis_metadata` block is filled first so the `root_cause` fallback can reference iteration count without a `KeyError`.

**Cross-service dependency memory** — when an RCA finds that service A's error was caused by service B's breaking change, `write_dependency_memory` is called before `finish_rca`. The actual write is staged and flushed after the loop exits (since `finish_rca` exits via exception). On subsequent RCAs for service A, `read_dependency_memory` is called first to check known upstreams.

---

## Adding a New Service

1. Add an entry to `banking-app-master/projects.yaml`
2. Run `python add_service_map.py` to register the GitHub repo in DB
3. Mount the service's log file in `docker-compose.yml` under `ingestion-agent` volumes
4. Run `docker compose up --build`

No Python or Java code changes required.

---

## Security Constraints

- `.env` is in `.gitignore` — never committed (contains real API keys)
- `env.example` contains only placeholder strings, never real credentials
- `apollo_settings.json` is in `.gitignore` (runtime key overrides, stays in container)
- DB passwords are masked in API responses via `_mask()` in `main.py`
- Settings UI shows secrets as `****` + last 4 characters only
