# Apollo RCA Platform — Codebase Deep Dive

## Overview

Apollo is an AI-powered Root Cause Analysis platform for a multi-service Java demo application. It automatically detects production errors, classifies them with Gemini, and runs a ReAct-style Claude agent to investigate code, commits, and deployments in a self-hosted GitLab instance to find the root cause.

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
│  └──────────────────────────────────────┘                           │
│                                                                      │
│  ┌──────────────────────────────────────┐                           │
│  │            rca-agent :8000           │  ──► MySQL (host)         │
│  │  FastAPI + Apollo React UI           │  ──► Anthropic API        │
│  │  Claude ReAct loop (up to 20 iters)  │  ──► GitLab API           │
│  └──────────────────────────────────────┘                           │
│                                                                      │
│  ┌─────────────┐   ┌────────────────────┐                           │
│  │  dd-agent   │   │  trigger-ui :5000  │                           │
│  │ (Datadog v7)│   │  (error trigger +  │                           │
│  │             │   │   live log viewer) │                           │
│  └─────────────┘   └────────────────────┘                           │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Repository Layout

```
rca-agent/
├── docker-compose.yml            # single-command stack startup
├── .env                          # secrets (never committed)
├── env.example                   # copy → .env and fill in values
├── CODEBASE_DEEP_DIVE.md
├── HOW_TO_RUN_LOCALLY.md
│
├── banking-app/                  # Java banking microservices
│   ├── banking-service/          # Spring Boot banking app (port 8080)
│   │   ├── src/main/java/com/demo/banking/
│   │   │   ├── controller/
│   │   │   │   ├── AccountController.java
│   │   │   │   └── ChaosController.java   # thin trigger only — delegates to AccountService
│   │   │   ├── service/
│   │   │   │   └── AccountService.java    # business logic + planted RCA bugs
│   │   │   └── exception/
│   │   │       └── GlobalExceptionHandler.java  # logs full stack traces for all exceptions
│   │   └── Dockerfile
│   │
│   ├── pricing-service/          # Spring Boot pricing engine (port 8081)
│   │   ├── src/main/java/com/demo/pricing/
│   │   │   ├── controller/ChaosController.java   # thin trigger → PricingService
│   │   │   └── service/PricingService.java        # business logic + planted RCA bugs
│   │   └── Dockerfile
│   │
│   ├── order-service/            # Spring Boot order service (port 8082)
│   │   ├── src/main/java/com/demo/order/
│   │   │   ├── controller/ChaosController.java   # thin trigger → OrderService
│   │   │   ├── service/OrderService.java          # Bug A (NPE) + Bug B (off-by-one)
│   │   │   ├── client/PricingClient.java          # calls pricing-service REST
│   │   │   └── dto/PricingResponseDto.java        # stale field name 'discount' (Bug A)
│   │   └── Dockerfile
│   │
│   ├── datadog/                  # Datadog agent config
│   │   ├── Dockerfile            # custom DD agent for ECS sidecar
│   │   └── conf.d/banking-app.d/conf.yaml   # log collection config (mounted in local docker)
│   └── terraform/                # AWS ECS/RDS/ALB infrastructure
│
└── apollo-agent/                 # Python AI agent platform
    ├── projects.yaml             # service registry (org, repo, log path, obs mode)
    ├── add_service_map.py        # registers services in DB from projects.yaml
    ├── setup_db.py               # one-time MySQL schema bootstrap
    ├── setup_db.sql              # raw SQL schema (alternative to setup_db.py)
    │
    ├── error-ingestion-agent/    # LangGraph pipeline: file watch → classify → store
    │   ├── main.py               # FastAPI control API + file watcher + DD poller loop
    │   ├── datadog_poller.py     # Datadog Logs API cursor-based polling
    │   ├── datadog_webhook.py    # Datadog webhook receiver (alternative ingest)
    │   ├── agents/log_monitor/
    │   │   ├── graph.py          # LangGraph graph: parse → analyze → store
    │   │   └── nodes.py          # parse_node, analyze_node (Gemini), store_node
    │   ├── db/database.py        # aiomysql async DB layer + insert_incident
    │   ├── config/settings.py    # pydantic-settings
    │   └── utils/
    │       ├── log_parser.py     # regex log line parser (Java + Python formats)
    │       └── severity_rules.py # exception type → severity classification table
    │
    ├── rca-agent/                # FastAPI + Claude RCA agent + Apollo React UI
    │   ├── app/main.py           # all /api/* endpoints, SSE pub-sub, report renderer
    │   ├── rca_agent/
    │   │   ├── agent.py          # Claude ReAct loop (13 tools, 20 iterations max)
    │   │   ├── config.py         # pydantic-settings (reads ../../.env → ../.env → .env)
    │   │   ├── db.py             # pymysql sync DB layer + token_usage logging
    │   │   ├── overlay.py        # runtime settings file reader (5s TTL cache)
    │   │   ├── token_pricing.py  # cost estimation per Claude model
    │   │   ├── github_tools.py   # python-gitlab wrappers (file, diff, search, global)
    │   │   ├── repo_resolver.py  # service name → GitLab org/repo
    │   │   ├── models.py         # RCAReport Pydantic model (schema v1.1)
    │   │   ├── report_renderer.py# self-contained HTML report template
    │   │   ├── cache.py          # DB-backed context cache
    │   │   └── dependency_memory.py  # cross-service dependency learning (JSON file)
    │   ├── alembic/              # DB migrations
    │   ├── evals/                # eval suite for agent quality
    │   └── ui/src/               # Apollo React app (Vite)
    │       ├── pages/            # Landing.jsx, Dashboard.jsx
    │       ├── components/
    │       │   ├── LogViewer.jsx       # DB log browser with risk/service/status filters
    │       │   ├── RCADashboard.jsx    # Incident cards with Run/Stream/Report buttons
    │       │   ├── RCAStreamPanel.jsx  # SSE overlay with neural bg, phase tracker, iteration groups
    │       │   ├── ReportsPage.jsx     # Completed RCA browser + inline panel + PDF download
    │       │   ├── TokenUsage.jsx      # Per-incident + per-model token/cost breakdown
    │       │   ├── Settings.jsx        # Runtime credentials + model + GitLab config
    │       │   ├── Sidebar.jsx         # Nav with Reports badge
    │       │   └── StatsBar.jsx        # Aggregate counts
    │       ├── context/AppContext.jsx
    │       └── api/client.js           # all fetch wrappers incl. fetchTokenUsageByIncident
    │
    └── trigger-ui/               # Flask error-trigger dashboard (port 5000)
        ├── app.py                # live log stream + chaos buttons + RCA trigger
        ├── Dockerfile
        └── requirements.txt
```

---

## Data Flow — Local Mode

```
Java service throws exception (triggered by ChaosController → business service method)
        │
        ▼
GlobalExceptionHandler catches it → log.error("...", ex)  ← full stack trace
        │
        ▼
Logback writes to /var/log/banking-app/app.log  (shared Docker volume)
        │
        ▼
LogFileHandler (watchdog) detects new lines, buffers multi-line entries
        │
        ▼
is_error_line() filters — only ERROR-level lines with stack traces continue
        │
        ▼
LangGraph pipeline (async):
  parse_node   → log_parser.py extracts timestamp, level, error_type, stack_trace
  analyze_node → Gemini gemini-2.5-flash:
                   • SUMMARY   — one sentence what broke and where
                   • CATEGORY  — code_defect | config_error | dependency_failure
                                 | resource_exhaustion | external_api | unknown
                   • SEVERITY  — critical | high | medium | low
                   • ANALYSIS  — ≤40-word root cause analysis
                   • SUGGESTIONS — 3 × ≤12-word fix suggestions (semicolon-separated)
  store_node   → INSERT into MySQL error_logs with all Gemini fields
        │
        ▼
Apollo LogViewer shows the incident with risk badge, category badge, suggestions
```

## Data Flow — Datadog Mode

```
User: Stop Monitoring → select Datadog → Start Monitoring
        │
        ▼
ingestion-agent: _run_dd_poller_loop(start_from=_monitoring_stopped_at)
        │  every 30s
        ▼
Datadog Logs API v2 /logs/events/search (cursor-based, at-least-once delivery)
        │
        ▼
Same LangGraph pipeline → MySQL
```

## RCA Agent — ReAct Loop

```
User clicks "▶ Run RCA" on an incident card
        │
        ▼
GET /api/rca/stream/{id}  (SSE — pub-sub, no duplicate agents on reconnect)
        │
        ▼
RCAAgent.run(error_log_id)
  1. Load error_log from DB
  2. RepoResolver: service_name → GitLab org/repo  (via service_repo_map)
  3. ReAct loop (max 20 iterations):
     │
     ├─ Claude claude-haiku-4-5-20251001 (4096 max_tokens)
     │
     ├─ 13 tools available:
     │   read_dependency_memory    check known upstream causes (always first)
     │   get_recent_deployments    what changed in last 48h
     │   read_context_cache        DB cache — avoids redundant GitLab calls
     │   get_repo_file             fetch file (line-numbered, 150-line limit)
     │   list_repo_files           explore repo structure (chaos files filtered out)
     │   search_code_in_repo       find symbol in one repo
     │   search_github_global      find symbol across all repos in GitLab group
     │   get_commit_diff           what changed in a specific commit
     │   get_commits_since         list all commits since a timestamp
     │   get_service_metadata      from observability adapter
     │   write_context_cache       persist GitLab fetch to DB cache
     │   write_dependency_memory   record cross-service dependency (staged; flushed post-loop)
     │   finish_rca                submit final report (exits loop)
     │
     └─ Token usage logged to token_usage table after each API call
        │
        ▼
  4. Force-report at iteration 20 if finish_rca not called
        │
        ▼
  5. _persist():
       UPDATE error_logs SET rca_status='completed', rca_result=<json>
       INSERT INTO rca_reports (rca_id, error_log_id, service_name, report)
  6. Completion broadcast to all SSE subscribers
```

---

## Chaos Controller Design

Each service has a `ChaosController` that is a **thin HTTP trigger only** — it contains zero business logic and immediately delegates to the real service layer. This ensures all exceptions and stack traces originate in business code, not in test scaffolding.

```
POST /chaos/<scenario>
  └─► ChaosController.trigger<Scenario>()     ← just constructs input + calls service
        └─► AccountService.getAccountEnrichment()    ← NullPointerException here
              OR AccountService.withdraw()            ← InsufficientFundsException here
              OR PricingService.computeDynamicPricing()  ← NullPointerException here
              OR OrderService.createOrder()           ← NPE or IllegalArgumentException here
```

### Planted bugs per service

| Service | Scenario | Bug location | Exception |
|---|---|---|---|
| banking-app | `null-pointer` | `AccountService.getAccountEnrichment` — ENRICHMENT_CACHE miss → `.get()` on null | `NullPointerException` |
| banking-app | `insufficient-funds` | `AccountService.withdraw` — amount > balance | `InsufficientFundsException` |
| banking-app | `db-connection` | `AccountService.processBatchStatement` — secondary JDBC pool exhausted | `RuntimeException` |
| banking-app | `account-not-found` | `AccountService.findAccountById(999999999L)` | `AccountNotFoundException` |
| pricing-service | `null-pointer` | `PricingService.computeDynamicPricing(null, ...)` — `Map.of().get(null)` forbidden | `NullPointerException` |
| pricing-service | `invalid-sku` | `PricingService.calculatePrice(SKU-CHAOS-999)` — not in catalogue | `InvalidSkuException` |
| pricing-service | `arithmetic` | `PricingService.computeDiscountedVolume("SKU-001", 1)` — `10/(1-1)` | `ArithmeticException` |
| order-service | `cross-service-npe` | `OrderService.calculateTotal` — `PricingResponseDto.getDiscount()` is null (field renamed `discountRate` in v2.1.0) | `NullPointerException` |
| order-service | `quantity-off-by-one` | `OrderService.resolveQuantity(1)` — `quantity-1=0` after off-by-one bug | `IllegalArgumentException` |

### Why the agent won't blame ChaosController

The RCA agent has three layers of chaos avoidance:
1. **System prompt rule**: "ChaosController is a trigger, not the root cause — skip it"
2. **`get_repo_file` dispatch**: chaos file paths return an advisory message instead of file content
3. **`list_repo_files` dispatch**: chaos files stripped from directory listings

---

## GitLab Integration

The platform uses a self-hosted GitLab instance for code analysis. `github_tools.py` (name kept for historical reasons) uses the `python-gitlab` library.

```
Settings UI → GitHub PAT field → stores a GitLab Personal Access Token (glpat-...)
                                  Required scopes: read_api + read_repository
```

Key environment variables:
```env
GITHUB_PAT=glpat-...                        # GitLab PAT (read_api + read_repository)
GITHUB_ORG=apollo                           # GitLab group name
GITLAB_URL=http://<your-gitlab-host>        # self-hosted GitLab base URL
```

File content returned by `get_repo_file` is line-numbered before being sent to Claude:
```
    1 | package com.demo.banking.service;
    2 |
    3 | // planted bug below
    4 | public class AccountService {
```
This ensures the agent reads the `N |` prefix instead of counting lines itself, eliminating off-by-N errors in code references.

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

- **First request**: starts agent thread, registers subscriber queue
- **Reconnect / second tab**: subscribes only — no new agent started
- **Agent broadcasts**: `_job_broadcast()` puts events into all subscriber queues
- **Agent finishes**: `_job_finish()` sends sentinel `None`; slot kept 60s for late reconnectors

**SSE event shapes:**

| type | key fields | meaning |
|---|---|---|
| `start` | `service`, `error_type` | agent initialized |
| `reasoning` | `text` | Claude's thinking text |
| `tool_call` | `tool`, `input` | tool about to be invoked |
| `tool_result` | `tool`, `summary` | human-readable result summary |
| `cache_hit` | `key` | DB cache used instead of GitLab API |
| `sub_agent` | `action` | repo discovery sub-agent launched |
| `complete` | `confidence`, `iterations`, `cross_service` | RCA done |
| `done` | `report` | full RCAReport JSON |
| `error` | `message` | agent or API error |

---

## Database Schema (MySQL `rca_db`)

### `error_logs`
| Column | Type | Description |
|---|---|---|
| id | VARCHAR(36) | UUID primary key |
| service_name | VARCHAR | e.g. `banking-app` |
| error_type | VARCHAR | e.g. `NullPointerException` |
| error_message | TEXT | Gemini summary (or raw message if Gemini skipped) |
| stack_trace | JSON | array of `{text}` objects |
| severity | VARCHAR | ERROR / WARN |
| risk_level | VARCHAR | critical / high / medium / low (from Gemini) |
| gemini_category | VARCHAR | code_defect / config_error / dependency_failure / … |
| gemini_analysis | TEXT | ≤40-word root cause from Gemini |
| gemini_suggestions | TEXT | 3 fix suggestions separated by `;` |
| rca_status | VARCHAR | pending / in_progress / completed / failed |
| rca_result | JSON | full RCAReport v1.1 JSON |
| metadata | JSON | `{source: "db_watcher"\|"datadog_poll", raw_log: "..."}` |

### `rca_reports`
Dedicated completed-RCA table. Written by `agent._persist()` after every successful RCA.

| Column | Type | Description |
|---|---|---|
| rca_id | VARCHAR(36) | UUID primary key (same as report.rca_id) |
| error_log_id | CHAR(36) | FK → error_logs.id |
| service_name | VARCHAR(255) | service that had the error |
| generated_at | VARCHAR(50) | ISO 8601 timestamp |
| report | JSON | full RCAReport v1.1 JSON |
| created_at | DATETIME | row insertion time |

### `token_usage`
Every Anthropic API call with real token counts and cost. Supports two API endpoints:
- `/api/token-usage` — totals + per-model breakdown + recent calls
- `/api/token-usage/by-incident` — per-incident aggregation (two-query Python merge, avoids collation JOIN)

### `service_context_cache`
DB-backed cache for GitLab file fetches and Datadog polling cursors.

### `service_repo_map`
Maps service names → GitLab org/repo. Populated by `add_service_map.py`.

---

## Apollo UI — Pages & Components

| Component | Purpose |
|---|---|
| `Landing.jsx` | Animated star-field intro page |
| `Dashboard.jsx` | Main shell: sidebar + header + page routing |
| `Sidebar.jsx` | Nav: Logs / RCA / Reports / Tokens / Settings; Reports badge |
| `StatsBar.jsx` | Aggregate counts (total / pending / critical / high / …) |
| `LogViewer.jsx` | DB log browser; filter by service / risk / status; 10s auto-refresh; shows Gemini analysis + suggestions per card |
| `RCADashboard.jsx` | Incident cards filtered by status; inline Run / Live / Report / Re-run buttons |
| `RCAStreamPanel.jsx` | Full-screen SSE overlay: neural canvas, phase tracker, iteration groups, confidence gauge, filter bar, session cache |
| `ReportsPage.jsx` | Browse all completed RCAs; search + confidence filter + sort; inline detail panel; PDF download |
| `TokenUsage.jsx` | Hero totals, per-model breakdown, per-incident cards (IncidentCard + AllCallsSection) |
| `Settings.jsx` | 5 sections; ⚡ Test Credentials; instant vs restart badges; GitLab URL field |

### RCA Stream Panel Features
- **Neural background**: animated node-network canvas, speeds up while agent is running
- **Phase tracker**: Initialize → Repository → Analysis → Complete
- **Iteration groups**: reasoning + tool calls collapsed under `Iteration N`
- **Confidence gauge**: SVG circular gauge (high=92%, medium=65%, low=38%)
- **Session cache**: re-opening the panel restores all events without restarting the agent
- **Completion celebration**: 3-second green overlay with confidence + iterations
- **Stop animation**: 2.5-second red overlay on cancel

---

## Settings — What Takes Effect When

| Setting | Effect |
|---|---|
| Anthropic API Key | Instant — new client per RCA run |
| Model | Instant — read at start of every RCA run |
| Max Iterations | Instant — default: 20 |
| GitHub PAT (GitLab token) | Instant — python-gitlab client recreated when token changes |
| GitHub Org (GitLab group) | Instant — read on every repo resolution |
| GitLab URL | Instant — read on every GitLab client creation |
| Database URL | Instant — read from overlay on every new connection |
| DD API Key / App Key / Site | Instant for Log Explorer; forwarded to ingestion agent on Start |
| Observability Adapter | **Container restart required** |
| CI/CD Adapter | **Container restart required** |

Runtime overrides stored in `/app/apollo_settings.json` (inside rca-agent container), read with 5s TTL by `overlay.py`.

---

## Key Design Decisions

**Single shared log volume** — all three Java services write to `/var/log/banking-app/app.log`. The ingestion agent uses `DD_LOGS_INJECTION` fields (`dd.service`) to attribute lines to the correct service.

**Errors originate in business code** — ChaosController is a thin HTTP trigger only. Every planted bug lives in the real service layer (AccountService, PricingService, OrderService) so RCA stack traces point to actual code the agent can analyse.

**Line-numbered file content** — `get_repo_file` prepends `N |` to every line before sending to Claude. The agent reads the prefix instead of counting lines, eliminating off-by-N errors. Truncation is at 150 lines (not 4000 characters) so line numbers are never broken mid-file.

**Chaos file blocking** — chaos/fault-injection files are blocked at the dispatch layer. `get_repo_file` returns an advisory message; `list_repo_files` filters them from results. The system prompt also has an explicit rule.

**DB as display source of truth** — LogViewer always reads from MySQL regardless of ingest mode. The toggle only controls the ingest source.

**Two-query token-by-incident** — the `by-incident` endpoint does two single-table queries merged in Python instead of a cross-table JOIN, avoiding MySQL collation mismatch between `token_usage` (`utf8mb4_unicode_ci`) and `error_logs` (`utf8mb4_0900_ai_ci`).

**rca_reports populated on every completion** — `_persist()` writes both `UPDATE error_logs` and `INSERT INTO rca_reports` after every successful RCA. `ON DUPLICATE KEY UPDATE` makes it safe to re-run.

**Cursor-based Datadog polling** — saves pagination cursor after each batch so it resumes exactly where it left off after a restart (at-least-once delivery).

**Cross-service dependency memory** — when RCA finds that service A's error was caused by service B's breaking change, `write_dependency_memory` stages the write before `finish_rca`. Flushed after the loop exits. Subsequent RCAs for service A check known upstreams first.

---

## Adding a New Service

1. Add an entry to `apollo-agent/projects.yaml` with `id`, `github_org`, `github_repo`, `observability_mode: db`, `log_path`
2. Push the service source code to `apollo/your-repo` on GitLab
3. Run `python apollo-agent/add_service_map.py` to register the repo in DB
4. Mount the service log volume in `docker-compose.yml` under `ingestion-agent`
5. Run `docker compose up --build`

No Python or Java code changes required.

---

## Security Constraints

- `.env` is in `.gitignore` — never committed (contains real API keys and DB credentials)
- `env.example` contains only placeholder strings
- `apollo_settings.json` is in `.gitignore` (runtime key overrides, stays inside container)
- DB passwords masked in API responses via `_mask()` in `main.py`
- Settings UI shows secrets as `****` + last 4 characters only
