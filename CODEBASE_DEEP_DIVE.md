# Codebase Deep Dive — RCA Agent System

## Table of Contents

1. [System Overview](#1-system-overview)
2. [High-Level Architecture](#2-high-level-architecture)
3. [Component Breakdown](#3-component-breakdown)
   - [Banking App (Java/Spring Boot)](#31-banking-app-javaspring-boot)
   - [Error Ingestion Agent](#32-error-ingestion-agent)
   - [RCA Agent](#33-rca-agent)
4. [Complete File-by-File Reference](#4-complete-file-by-file-reference)
   - [Error Ingestion Agent Files](#41-error-ingestion-agent-files)
   - [RCA Agent Files](#42-rca-agent-files)
5. [Database Schema](#5-database-schema)
6. [End-to-End Flow](#6-end-to-end-flow)
7. [Adapter System (Pluggable Design)](#7-adapter-system-pluggable-design)
8. [The ReAct Loop (How Claude Thinks)](#8-the-react-loop-how-claude-thinks)
9. [Repo Discovery Strategy](#9-repo-discovery-strategy)
10. [Caching System](#10-caching-system)
11. [HTML Report Rendering](#11-html-report-rendering)
12. [API Endpoints](#12-api-endpoints)
13. [Eval/Test Suite](#13-evaltest-suite)
14. [Docker Compose Stack](#14-docker-compose-stack)
15. [Configuration & Environment Variables](#15-configuration--environment-variables)
16. [Data Models](#16-data-models)
17. [Technology Stack Summary](#17-technology-stack-summary)

---

## 1. System Overview

This repo implements a **two-service AI pipeline** that automatically monitors a banking application for errors and produces structured Root Cause Analysis (RCA) reports — with zero human intervention.

The pipeline has three layers:

| Layer | Service | Technology |
|---|---|---|
| **Source** | Banking App | Java / Spring Boot |
| **Ingestion** | Error Ingestion Agent | Python / LangGraph / Google Gemini |
| **Analysis** | RCA Agent | Python / FastAPI / Anthropic Claude |

**What it does end-to-end:**
1. The banking app (or any service) writes error logs to a file.
2. The **Error Ingestion Agent** watches the file, detects ERROR/WARN lines, classifies them using Google Gemini, and stores them in a MySQL table.
3. The **RCA Agent** receives a trigger, loads the error from MySQL, uses Claude in a **ReAct (Reason + Act) loop** with 10 GitHub tools to read code, inspect diffs, and query deployments — then writes a full structured RCA report back to the database and serves it as a rendered HTML page.

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        DOCKER-COMPOSE STACK                         │
│                                                                     │
│  ┌──────────────┐   logs    ┌───────────────────────────────────┐   │
│  │  Banking App │──────────▶│       Error Ingestion Agent        │   │
│  │  (Java :8080)│  /var/log │  LangGraph: parse→analyze→store    │   │
│  └──────────────┘           │  Gemini: classify error category   │   │
│                             └──────────────┬─────────────────────┘   │
│                                            │ INSERT error_logs       │
│                                            ▼                         │
│                              ┌─────────────────────┐                 │
│                              │     MySQL rca_db    │                 │
│                              │  - error_logs        │                 │
│                              │  - service_repo_map  │                 │
│                              │  - service_context_  │                 │
│                              │    cache             │                 │
│                              │  - rca_reports       │                 │
│                              └──────────┬──────────┘                 │
│                                         │ SELECT / UPDATE             │
│                                         ▼                             │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │                      RCA Agent (:8000)                        │    │
│  │  FastAPI → RCAAgent.run()                                     │    │
│  │    1. Load error from DB (LocalDBAdapter)                     │    │
│  │    2. Resolve GitHub repo (RepoResolver)                      │    │
│  │    3. ReAct Loop with Claude (claude-sonnet-4-6)              │    │
│  │         ├─ get_repo_file       → GitHub API (PyGithub)        │    │
│  │         ├─ list_repo_files     → GitHub API                   │    │
│  │         ├─ search_code_in_repo → GitHub Search API            │    │
│  │         ├─ get_commit_diff     → GitHub API                   │    │
│  │         ├─ get_commits_since   → GitHub API                   │    │
│  │         ├─ get_recent_deployments → CICD Adapter (mock/real)  │    │
│  │         ├─ get_service_metadata   → Obs Adapter               │    │
│  │         ├─ read_context_cache  → MySQL                   │    │
│  │         ├─ write_context_cache → MySQL                   │    │
│  │         └─ finish_rca          → END (writes RCAReport)       │    │
│  │    4. Persist RCA result → MySQL                         │    │
│  │    5. Serve HTML report at /rca/{id}/report                   │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌───────────────────┐                                               │
│  │  Demo UI (:3000)  │  nginx static server, calls RCA Agent API    │
│  └───────────────────┘                                               │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. Component Breakdown

### 3.1 Banking App (Java/Spring Boot)

**Location:** `banking-app-master/` (root Dockerfile + `pom.xml`)

The banking app is the **error source** — a standard Spring Boot service that writes structured logs to `/var/log/banking-app/app.log`. It connects to MySQL via JDBC. For this demo it deliberately contains (or can produce) buggy behavior in services like `AccountService`, `PaymentService`, etc.

Key points:
- Runs on port `8080`
- Exposes `/actuator/health` for Docker health checks
- Logs are in standard Spring Boot format: `2024-01-15 10:30:01.123 ERROR 12345 --- [main] c.d.b.service.AccountService : message`
- The banking logs volume is shared read-only with the Error Ingestion Agent

### 3.2 Error Ingestion Agent

**Location:** `banking-app-master/error-ingestion-agent/`

**Purpose:** Bridges raw log files (or Datadog webhooks) into structured database records ready for RCA.

**Two operating modes:**

| Mode | Trigger | How |
|---|---|---|
| `db` | New log lines appear in a file | `watchdog` library tails the log file, detects errors |
| `datadog` | Datadog monitor fires a webhook | FastAPI server at `:8001` receives POST `/webhook/datadog` |

Both modes feed into the same **LangGraph pipeline**.

**LangGraph Pipeline (`parse → analyze → store`):**

```
raw_log (str)
    │
    ▼
[parse_node]
    - Regex-extract: timestamp, severity, message, error_type, stack_trace
    - Supports Spring Boot and simple log formats
    │
    ▼
[analyze_node]
    - Calls Google Gemini (gemini-1.5-flash)
    - Produces: one-sentence summary + error category
    - Categories: code_defect | config_error | dependency_failure |
                  resource_exhaustion | external_api | unknown
    │
    ▼
[store_node]
    - INSERT INTO error_logs (aiomysql) — the same unified table the RCA
      agent reads from
    - Returns the new error_logs.id (UUID4 string)
```

### 3.3 RCA Agent

**Location:** `banking-app-master/rca-agent/`

**Purpose:** The main AI reasoning engine. Given an `error_log_id`, it performs a full automated Root Cause Analysis using Claude in a ReAct loop.

**Stack:** FastAPI + Anthropic Python SDK + PyGithub + PyMySQL + MySQL

---

## 4. Complete File-by-File Reference

### 4.1 Error Ingestion Agent Files

#### `error-ingestion-agent/main.py`
Entry point. Reads the `MODE` env var:
- `MODE=db` → starts `asyncio` event loop with `watchdog` file observer
- `MODE=datadog` → starts `uvicorn` serving `datadog_webhook.app`

The `LogFileHandler` class (extends `watchdog.FileSystemEventHandler`) tails the log file byte-by-byte from its last known position (`self._pos`). It buffers lines to reconstruct multi-line stack traces, then calls `process_log_entry()` for any line containing ERROR/WARN/EXCEPTION.

#### `error-ingestion-agent/datadog_webhook.py`
FastAPI app for the Datadog mode. Exposes:
- `POST /webhook/datadog` — receives Datadog monitor alert JSON, builds a synthetic raw log string from it, processes it via LangGraph in the background (returns 202 immediately).
- `GET /health` — liveness check.

The `DatadogAlertPayload` Pydantic model maps to the custom payload configured in Terraform/Datadog.

#### `error-ingestion-agent/agents/log_monitor/graph.py`
Defines the **LangGraph StateGraph**. Wires three nodes together:
```python
parse → analyze → store → END
```
Compiles to `incident_graph` singleton. The `process_log_entry()` async function is the public interface — takes `raw_log: str` and returns the final `IncidentState` dict.

#### `error-ingestion-agent/agents/log_monitor/nodes.py`
Implements the three graph nodes. Each node receives the full `IncidentState` TypedDict and returns an updated copy.

- **`parse_node`**: Calls `parse_log_entry()` from `utils/log_parser.py`. Fills in `error_type`, `message`, `severity`, `stack_trace`, `timestamp`.
- **`analyze_node`**: Creates a `ChatGoogleGenerativeAI` (Gemini 1.5 Flash) with temperature 0.1. Sends a structured prompt. Parses `SUMMARY:` and `CATEGORY:` lines from the response. Falls back gracefully if Gemini is unavailable.
- **`store_node`**: Calls `insert_incident()` async function. Stores the record in the unified `error_logs` table (the same table the RCA agent reads from — there is no separate `error_incidents` table in this codebase).

`IncidentState` TypedDict fields:
```
raw_log, source, parsed, error_type, message, severity, stack_trace,
timestamp, gemini_summary, gemini_category, incident_id, stored, error
```

#### `error-ingestion-agent/utils/log_parser.py`
Pure regex-based log parser. No AI.

Regex patterns:
- `_SPRING_LOG_RE` — matches full Spring Boot log prefix with PID, thread, class
- `_SIMPLE_LOG_RE` — matches simpler `TIMESTAMP LEVEL ServiceName - message` format
- `_EXCEPTION_LINE_RE` — matches Java exception class names like `java.lang.NullPointerException`
- `_STACK_FRAME_RE` — matches `at com.example.Class.method(File.java:123)` lines
- `_EXCEPTION_SHORT_RE` — matches well-known short exception names in message text

`ParsedLogEntry` dataclass: `timestamp, severity, message, error_type, stack_trace, raw_log`

`is_error_line(raw_log)` — quick check used by the file watcher before committing to full parse.

#### `error-ingestion-agent/db/database.py`
Async MySQL layer using `aiomysql`. Manages a connection pool (`_pool` singleton, min=1, max=5).

Key functions:
- `ensure_table()` — verifies the `error_logs` table exists (created by the
  rca-agent's Alembic migration `001_initial.py`; the ingestion agent does
  not own the schema).
- `insert_incident(...)` — inserts one row into `error_logs` with a freshly
  generated UUID4 string as `id`, `rca_status='pending'`, and the raw log
  embedded in `metadata`. Returns the new row's UUID.
- `get_pool()`, `close_pool()`, `get_connection()` async context manager.

The ingestion agent writes directly into the **same `error_logs` table** the
RCA agent reads from — they share the row's lifecycle (`pending` →
`in_progress` → `completed` / `failed`). There is no separate
`error_incidents` table.

**Datetime note:** `insert_incident()` defaults `occurred_at` to
`datetime.utcnow()`, which returns a **naive** datetime. MySQL stores it
verbatim; `LocalDBAdapter` promotes it to tz-aware UTC on read (see the
"Datetime handling contract" in §4.2). New writers should ideally use
`datetime.now(timezone.utc)` since `utcnow()` is deprecated in Python 3.12+.

#### `error-ingestion-agent/config/settings.py`
`pydantic-settings` class. Reads from `.env` or environment variables (case-insensitive).

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `mysql+pymysql://root:root@localhost:3306/rca_db` | MySQL DSN (accepts `mysql+pymysql://`, `mysql+aiomysql://`, or `mysql://`) |
| `GEMINI_API_KEY` | `""` | Google Gemini auth |
| `MODE` | `db` | `db` or `datadog` |
| `LOG_FILE_PATH` | `/var/log/banking-app/app.log` | Log file to tail |
| `SERVICE_NAME` | `banking-app` | Written to every incident |
| `ENVIRONMENT` | `production` | Written to every incident |
| `WEBHOOK_PORT` | `8001` | Datadog webhook server port |

---

### 4.2 RCA Agent Files

#### `rca-agent/app/main.py`
The FastAPI application entry point.

On startup, creates three singletons:
```python
obs_adapter = LocalDBAdapter()      # reads error_logs from MySQL
cicd_adapter = MockCICDAdapter()    # returns hardcoded deployment records
agent = RCAAgent(obs_adapter, cicd_adapter)
```

**Endpoints:**

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Returns model name, org, adapter config |
| `POST` | `/rca/run` | Blocking RCA — runs agent and returns full report JSON |
| `POST` | `/rca/run/stream` | Streaming RCA via Server-Sent Events (SSE) |
| `GET` | `/rca/{error_log_id}/report` | Renders completed RCA as HTML page |
| `GET` | `/demo` | Serves `demo_ui.html` |
| `GET` | `/demo/scenarios` | Returns pre-seeded error_log IDs from `seeded_ids.json` |

**SSE Streaming:** `/rca/run/stream` runs the agent in a background thread and streams JSON events via a `queue.Queue`. Event types: `start`, `reasoning`, `tool_call`, `tool_result`, `cache_hit`, `sub_agent`, `complete`, `done`, `error`.

#### `rca-agent/rca_agent/agent.py`
The core of the system. Defines `RCAAgent` class and all Claude tool definitions.

**System Prompt:** Instructs Claude to act as an expert SRE performing RCA. Defines the exact JSON schema Claude must produce when calling `finish_rca`. Lists strict rules (always check cache first, never speculate, only call `finish_rca` to end).

**10 Tools Registered with Claude:**

| Tool | Purpose |
|---|---|
| `get_repo_file` | Fetch file content at a branch or commit SHA |
| `list_repo_files` | List directory contents |
| `search_code_in_repo` | GitHub code search |
| `get_commit_diff` | Get unified diff for a commit SHA |
| `get_commits_since` | List commits on a branch since a timestamp |
| `get_recent_deployments` | Query CICD adapter for recent deploys |
| `get_service_metadata` | Query observability adapter for service info |
| `read_context_cache` | Read from `service_context_cache` MySQL table |
| `write_context_cache` | Write to `service_context_cache` MySQL table |
| `finish_rca` | Submit completed report — ENDS THE LOOP |

**`RCAAgent.run()` method steps:**
1. Load `ErrorLogEntry` from observability adapter
2. Emit `start` trace event
3. Check if service is in `service_repo_map` (to decide if sub-agent will be needed)
4. Call `RepoResolver.resolve()` → get `{org, repo, branch, commit_sha, discovered_via}`
5. Build initial user message with full error context JSON
6. **ReAct Loop** (max `settings.max_react_iterations = 20`):
   - Call `client.messages.create()` with `SYSTEM_PROMPT + TOOLS + messages`
   - Emit `reasoning` events for any text blocks
   - Break if `stop_reason == "end_turn"` (error) or `"tool_use"`
   - For each tool call: dispatch to `_dispatch()`, collect results
   - If `finish_rca` is called: catch `_FinishRCA` exception, set `final_report`, break
7. Validate `final_report` is not None
8. Update metadata fields (iterations, files fetched, cache hits)
9. Emit `complete` trace event
10. Call `_persist()` → UPDATE `error_logs`, append to RCA history cache

**`_dispatch()` method:** Routes tool names to implementations. Handles org/repo fallback from `repo_info`. Tracks `github_files_fetched` and `cache_hits` lists.

**`_summarize_result()` method:** Produces short human-readable summaries for the trace stream (e.g. "Fetched 42 lines from processor.py").

#### `rca-agent/rca_agent/config.py`
`pydantic-settings` `Settings` class.

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | required | Claude auth |
| `GITHUB_PAT` | `""` | GitHub Personal Access Token |
| `GITHUB_ORG` | `oscorpAI` | Default GitHub org |
| `DATABASE_URL` | required | MySQL DSN |
| `MODEL` | `claude-sonnet-4-6` | Which Claude model to use |
| `MAX_REACT_ITERATIONS` | `20` | Max ReAct loop iterations |
| `OBSERVABILITY_ADAPTER` | `local` | `local` or `datadog` |
| `CICD_ADAPTER` | `mock` | `mock` or `real` |

#### `rca-agent/rca_agent/models.py`
All data models for the system, in two categories:

**Dataclasses (simple, mutable):**
- `ErrorLogEntry` — one error event loaded from DB
- `DeploymentRecord` — one CI/CD deployment record
- `RepoMapping` — service_name ↔ github_org/github_repo mapping

**Pydantic BaseModels (validated, serializable) — the RCA report schema:**
```
RCAReport
├── IncidentSummary (what, when, environment, severity, estimated_impact)
├── list[TimelineEvent] (timestamp, event)
├── RootCause
│   ├── summary, confidence, confidence_reason
│   ├── CodeReference (file, line, function, repo, commit_sha, github_url)
│   └── RegressionInfo (commit_sha, message, author, deployed_at)
├── list[str] contributing_factors
├── list[Evidence] (type: code|diff|deployment|log, description, value)
├── ImpactAssessment (service, environment, functionality, error_rate, duration)
├── list[SuggestedSolution] (priority, effort, title, description, code_suggestion)
├── list[str] prevention_recommendations
└── AnalysisMetadata (model, react_iterations, github_files_fetched, cache_hits, ...)
```

#### `rca-agent/rca_agent/github_tools.py`
Five functions that wrap the PyGithub library. All return plain dicts. All catch `GithubException` and return `{"error": str(e)}`.

- `get_repo_file(org, repo, path, ref)` — `repo.get_contents(path, ref=ref)`, returns decoded UTF-8 content + SHA
- `list_repo_files(org, repo, directory, ref)` — `repo.get_contents(directory, ref=ref)`, returns list of `{path, type, size}`
- `search_code_in_repo(org, repo, query)` — GitHub code search, returns top 10 `{path, url}` results
- `get_commit_diff(org, repo, commit_sha)` — `repo.get_commit(sha)`, returns files with patches
- `get_commits_since(org, repo, branch, since)` — `repo.get_commits(sha=branch, since=dt)`, returns last 20 commits

Uses a lazy-initialized `_gh` singleton (`Github(settings.github_pat)`).

#### `rca-agent/rca_agent/cache.py`
MySQL-backed key-value cache for GitHub file contents. The cache avoids redundant GitHub API calls within and across RCA sessions.

- `read_cache(service_name, cache_key)` — reads from `service_context_cache`. Returns `None` if missing or `invalidated_at IS NOT NULL`. Updates `last_used_at` on hit.
- `write_cache(service_name, cache_key, content, commit_sha)` — UPSERT (ON CONFLICT DO UPDATE). Resets `invalidated_at = NULL`.
- `invalidate_service_cache(service_name, new_commit_sha)` — marks file/tree caches as invalidated when a new deployment is detected. Only invalidates entries tied to different commit SHAs.
- `append_rca_history(service_name, summary)` — stores last 10 RCA summaries per service in the cache under key `rca_history`.

**Cache key conventions:**
- `file:<path>` — for file content (e.g. `file:src/payments/processor.py`)
- `repo_tree` — for directory listing
- `rca_history` — for the rolling RCA history list

#### `rca-agent/rca_agent/db.py`
Synchronous MySQL layer using `PyMySQL`. Thin wrapper with a context manager:

```python
@contextmanager
def get_conn():
    conn = pymysql.connect(**_conn_kwargs())   # DictCursor + utf8mb4
    yield conn                                  # commit or rollback on exit
    conn.close()

execute(sql, params) → list[dict]     # uses PyMySQL DictCursor
execute_one(sql, params) → dict|None  # returns first row or None
json_loads(v)                          # safely parse a JSON column value
```

`_conn_kwargs()` parses any `mysql+pymysql://`, `mysql+mysqldb://`, or
`mysql://` DSN into PyMySQL connect kwargs (host/port/user/password/database
+ `charset="utf8mb4"`, `DictCursor`, `autocommit=False`).

Every query opens a new connection (no pool). This is fine for low-frequency
RCA workloads.

**JSON quirk:** PyMySQL returns `JSON` columns as **strings**, not dicts/lists.
All read sites in this codebase wrap results with `json_loads()` from
`rca_agent.db`. If you add a new query that reads a JSON column, do the same.

#### `rca-agent/rca_agent/repo_resolver.py`
Determines which GitHub repo corresponds to a given service name. This is crucial because the error log only knows the service name, not the repo URL.

**Resolution strategy (4 paths, tried in order):**

```
1. Query CICD adapter for recent deployments → extracts github_repo
2. Query service_repo_map table in MySQL

   ┌─ Both found → "cicd+mapping" (uses CI/CD commit SHA, mapping org)
   ├─ CI/CD only → "cicd" (auto-writes new mapping entry)
   ├─ Mapping only → "mapping" (uses mapping, no commit SHA)
   └─ Neither found → launch RepoDiscoverySubAgent

3. RepoDiscoverySubAgent searches GitHub → "sub_agent"
4. If all fail → raise RuntimeError
```

Returns `dict`: `{org, repo, branch, commit_sha, deployment_record_used, discovered_via}`

Writes new mappings back to `service_repo_map` automatically so future lookups are instant.

#### `rca-agent/rca_agent/report.py`
One function: `validate_report(data: dict) → RCAReport`. Calls `RCAReport(**data)`. Pydantic validates the structure and raises `ValidationError` if the schema is wrong.

#### `rca-agent/rca_agent/report_renderer.py`
Renders an `RCAReport` dict into a fully self-contained HTML page (dark theme, no external CSS/JS).

**Section renderers (each returns an HTML string):**
- `_render_header()` — service name, environment, severity badge, RCA ID, generated timestamp
- `_render_incident_summary()` — table of what/when/environment/severity/impact
- `_render_timeline()` — numbered event timeline with connectors
- `_render_root_cause()` — confidence badge, summary, code reference box, regression commit box
- `_render_evidence()` — code/diff blocks per evidence item (diffs get green/red line coloring)
- `_render_impact()` — grid of impact cards
- `_render_contributing_factors()` — bulleted list
- `_render_solutions()` — prioritized solution cards with effort badges
- `_render_prevention()` — checkmark list
- `_render_metadata()` — stat cards (iterations, files fetched, cache hits), file/key listings

**Color system:** severity (critical=red, high=orange, medium=yellow, low=green), confidence (high=green, medium=yellow, low=red), effort (quick-fix=green, medium=blue, large=purple).

`_diff_block()` renders unified diffs with per-line `+`/`-`/`@@` coloring.

#### `rca-agent/rca_agent/adapters/protocols.py`
Two `Protocol` classes (structural typing, like interfaces):

```python
class ObservabilityAdapterProtocol(Protocol):
    def get_error_log(self, error_id: str) -> ErrorLogEntry: ...
    def get_service_metadata(self, service_name: str) -> dict: ...

class CICDAdapterProtocol(Protocol):
    def get_recent_deployments(
        self, service_name, environment, since, limit=5
    ) -> list[DeploymentRecord]: ...
```

Any class implementing these methods works — no inheritance needed.

#### `rca-agent/rca_agent/adapters/observability/local_db.py`
`LocalDBAdapter` — reads from the `error_logs` MySQL table. This is the production adapter for non-Datadog deployments.

`get_error_log(error_id)` — `SELECT * FROM error_logs WHERE id = %s`, maps row to `ErrorLogEntry`.

##### Datetime handling contract

MySQL `DATETIME` columns come back from PyMySQL as **naive** Python datetimes
(no `tzinfo`), but the rest of the codebase — mock CI/CD fixtures, JSON
serialization, ISO 8601 timestamps in the Claude prompt — operates on
**tz-aware UTC** datetimes. To prevent `TypeError: can't compare offset-naive
and offset-aware datetimes` deep in `RepoResolver.resolve()` /
`MockCICDAdapter.get_recent_deployments()`, `LocalDBAdapter.get_error_log()`
**normalizes `occurred_at` to tz-aware UTC at the adapter boundary**:

```python
occurred_at = row["occurred_at"]
if occurred_at is not None and occurred_at.tzinfo is None:
    occurred_at = occurred_at.replace(tzinfo=timezone.utc)
```

Every downstream consumer can assume `ErrorLogEntry.occurred_at` is tz-aware
UTC. **Any new observability adapter (Datadog, OpenSearch, etc.) must do the
same promotion before returning the `ErrorLogEntry`.**

#### `rca-agent/rca_agent/adapters/observability/datadog.py`
`DatadogAdapter` — stub. Both methods raise `NotImplementedError`. Intended to be filled with Datadog API calls:
- `GET https://api.datadoghq.com/api/v2/logs/events/{error_id}`
- `GET https://api.datadoghq.com/api/v2/services/{service_name}`

#### `rca-agent/rca_agent/adapters/cicd/mock_adapter.py`
`MockCICDAdapter` — reads from `MOCK_DEPLOYMENTS` dict (in-memory). Filters by `service_name`, `environment`, `deployed_at >= since`, `status == "success"`. Returns sorted by `deployed_at` descending.

#### `rca-agent/rca_agent/adapters/cicd/mock_fixtures.py`
Three hardcoded `DeploymentRecord` objects:
- `payment-service` — production, commit `perf: streamline charge_card hot path` (has `github_repo`)
- `order-service` — production, commit `chore: upgrade dependencies, pydantic to v2` (has `github_repo`)
- `notification-service` — staging, `github_repo=None` — **intentionally missing** to force sub-agent discovery

#### `rca-agent/rca_agent/adapters/cicd/real_adapter.py`
`RealCICDAdapter` — stub. `get_recent_deployments` raises `NotImplementedError`. Comment instructs: call your CI/CD system's API here.

#### `rca-agent/rca_agent/sub_agents/repo_discovery.py`
`RepoDiscoverySubAgent` — a **separate Claude agent** whose only job is finding which GitHub repo belongs to a given service name.

It has its own ReAct loop (max 5 iterations) with one tool: `search_github`. The tool calls `search_code_in_repo()` from `github_tools.py`.

**System prompt:** Instructs Claude to search systematically (exact name → fuzzy name → code search in pyproject.toml/package.json/build.gradle). Demands JSON-only output.

When successful, returns `{"github_org": "...", "github_repo": "..."}`. On failure returns `{"error": "no_match", "candidates": [...]}`.

Called only when both CI/CD deployment data and `service_repo_map` lookup fail.

---

## 5. Database Schema

All tables live in MySQL database `rca_db` (engine=InnoDB, charset=utf8mb4).
Created by Alembic migration `001_initial.py`. MySQL `DATETIME` is timezone-
*naive* on the wire — see the "Datetime handling contract" in §4.2 for how
the read path normalizes to UTC.

### `error_logs`
Stores one row per error event that needs RCA. Written by both the Error
Ingestion Agent (on new log lines) and the RCA Agent (state updates during
analysis). This is the unified table — there is no separate `error_incidents`
table.

| Column | Type | Notes |
|---|---|---|
| `id` | CHAR(36) (PK) | UUID4 string, generated by the writer |
| `service_name` | VARCHAR(255) | e.g. `payment-service` |
| `environment` | VARCHAR(100) | e.g. `production` |
| `error_type` | VARCHAR(500) | e.g. `AttributeError` |
| `error_message` | TEXT | Human-readable message |
| `stack_trace` | JSON | Array of frame objects |
| `severity` | VARCHAR(50) | `critical/high/medium/low` |
| `occurred_at` | DATETIME | When the error happened (UTC, naive) |
| `request_id` | VARCHAR(255) | Optional |
| `user_id` | VARCHAR(255) | Optional |
| `metadata` | JSON | Extra context (ingestion agent stashes `raw_log` here) |
| `rca_status` | VARCHAR(50) | `pending/in_progress/completed/failed`, default `pending` |
| `rca_started_at` | DATETIME | |
| `rca_completed_at` | DATETIME | |
| `rca_result` | JSON | Full RCA report |
| `rca_error` | TEXT | Error message if failed |

Indexes: `service_name`, `occurred_at DESC`, `rca_status`.

### `service_repo_map`
Maps service names to GitHub repos. Written by `RepoResolver._write_mapping()`
via `INSERT ... ON DUPLICATE KEY UPDATE`.

| Column | Type | Notes |
|---|---|---|
| `service_name` | VARCHAR(255) (PK) | |
| `github_org` | VARCHAR(255) | |
| `github_repo` | VARCHAR(255) | |
| `default_branch` | VARCHAR(100) | Default `main` |
| `language` | VARCHAR(100) | Optional |
| `onboarded_at` | DATETIME | Default `NOW()` |
| `onboarded_by` | VARCHAR(255) | Optional |
| `notes` | TEXT | Optional |

### `service_context_cache`
Caches GitHub file content to avoid redundant API calls.

| Column | Type | Notes |
|---|---|---|
| `id` | INT AUTO_INCREMENT (PK) | |
| `service_name` | VARCHAR(255) | |
| `cache_key` | VARCHAR(500) | `file:<path>` or `repo_tree` or `rca_history` |
| `content` | JSON | Arbitrary content object |
| `commit_sha` | VARCHAR(40) | Optional SHA to track cache validity |
| `created_at` | DATETIME | Default `NOW()` |
| `last_used_at` | DATETIME | Updated on every read |
| `invalidated_at` | DATETIME | Non-null means cache miss |

Unique constraint: `(service_name, cache_key)`.

### `rca_reports`
Stores finalized RCA reports (separate from `error_logs.rca_result` JSON).

| Column | Type | Notes |
|---|---|---|
| `rca_id` | VARCHAR(36) (PK) | UUID string (matches `RCAReport.rca_id`) |
| `error_log_id` | CHAR(36) | FK → `error_logs.id` (ON DELETE SET NULL) |
| `service_name` | VARCHAR(255) | |
| `generated_at` | VARCHAR(50) | ISO 8601 string |
| `report` | JSON | Full report JSON |
| `created_at` | DATETIME | Default `NOW()` |

---

## 6. End-to-End Flow

### Flow 1: DB/File Watcher Mode

```
1. Banking App writes to /var/log/banking-app/app.log
2. watchdog.Observer detects file modification
3. LogFileHandler._read_new_lines() reads new bytes from last known position
4. Lines are buffered to reconstruct multi-line stack traces
5. is_error_line() checks for ERROR/WARN/EXCEPTION keywords
6. _flush_buffer() calls process_log_entry(raw_log)
7. LangGraph: parse_node → analyze_node (Gemini) → store_node (aiomysql INSERT)
8. error_logs row created with rca_status='pending'
```

### Flow 2: RCA Agent Trigger

```
1. POST /rca/run {"error_log_id": "uuid"}
   OR
   POST /rca/run/stream {"error_log_id": "uuid"}

2. DB: UPDATE error_logs SET rca_status='in_progress'

3. agent.run(error_log_id):

   a) obs_adapter.get_error_log(id)
      → SELECT * FROM error_logs WHERE id = ?
      → ErrorLogEntry dataclass

   b) RepoResolver.resolve(service_name, environment, occurred_at):
      → cicd.get_recent_deployments() → MockCICDAdapter → MOCK_DEPLOYMENTS
      → execute_one("SELECT * FROM service_repo_map WHERE service_name=?")
      → (if both missing) → RepoDiscoverySubAgent.discover()
      → returns {org, repo, branch, commit_sha, discovered_via}

   c) Build user message with error context JSON

   d) ReAct Loop (up to 20 iterations):
      ┌─────────────────────────────────────────────────────────────┐
      │ client.messages.create(                                     │
      │   model="claude-sonnet-4-6",                               │
      │   max_tokens=4096,                                          │
      │   system=SYSTEM_PROMPT,                                     │
      │   tools=TOOLS,    # 10 tools                               │
      │   messages=messages                                         │
      │ )                                                           │
      │                                                             │
      │ Claude reasons about the error, calls tools:               │
      │  1. read_context_cache → cache miss                        │
      │  2. get_recent_deployments → {deployment data}             │
      │  3. get_commit_diff(commit_sha) → {files changed, patches} │
      │  4. read_context_cache → miss                              │
      │  5. get_repo_file(processor.py) → {file content}          │
      │  6. write_context_cache → cached                           │
      │  7. finish_rca({full report JSON})                         │
      └─────────────────────────────────────────────────────────────┘

   e) finish_rca caught → RCAReport Pydantic model created
   f) _persist():
      UPDATE error_logs SET rca_status='completed', rca_result=<json>
      append_rca_history() → write_cache("rca_history", ...)

4. Return report JSON (or SSE done event with full report)

5. GET /rca/{id}/report
   → SELECT rca_result FROM error_logs WHERE id = ?
   → render_rca_html(report_dict) → HTML string → HTMLResponse
```

---

## 7. Adapter System (Pluggable Design)

The system is designed to swap out data sources without changing the core agent logic.

### Observability Adapters

```
ObservabilityAdapterProtocol
├── LocalDBAdapter     ← DEFAULT (reads error_logs table)
└── DatadogAdapter     ← STUB (implement with Datadog API)
```

Set via `OBSERVABILITY_ADAPTER=local|datadog`.

### CI/CD Adapters

```
CICDAdapterProtocol
├── MockCICDAdapter    ← DEFAULT (in-memory MOCK_DEPLOYMENTS)
└── RealCICDAdapter    ← STUB (implement with your CI/CD API)
```

Set via `CICD_ADAPTER=mock|real`.

To add a new adapter: implement the protocol methods, register it in `app/main.py` selection logic.

---

## 8. The ReAct Loop (How Claude Thinks)

ReAct = **Re**asoning + **Act**ion. Claude alternates between:
1. **Reasoning:** Producing `text` blocks explaining its current thinking
2. **Acting:** Emitting `tool_use` blocks to call specific tools

The loop in `agent.py` works like this:

```
messages = [user: "Analyze this error: ..."]

LOOP (max 20 iterations):
  response = claude.messages.create(...)

  if stop_reason == "end_turn":
    # Claude gave up without calling finish_rca — error
    break

  for block in response.content:
    if block.type == "text":
      emit trace event (shown in demo UI)
    if block.type == "tool_use":
      result = _dispatch(block.name, block.input, ...)
      if name == "finish_rca":
        raise _FinishRCA(report)  # caught above the tool loop

  messages.append(assistant: response.content)
  messages.append(user: [tool_results])

# After loop: final_report is set
```

**Why `_FinishRCA` exception?** Because `finish_rca` is not a real function call — it signals the end of the loop. Raising an exception is the cleanest way to break out of nested loops without introducing flags.

**Message accumulation:** The `messages` list grows with each iteration, giving Claude full conversation memory across tool calls.

**Tool call guidance in system prompt:**
- Always check cache before GitHub API calls
- Write to cache after every successful fetch
- Never speculate — only report what is directly visible in code/diffs
- `finish_rca` is mandatory — Claude cannot end without calling it

---

## 9. Repo Discovery Strategy

`RepoResolver.resolve()` implements a **4-level waterfall**:

```
Level 1: CI/CD Adapter
  → get_recent_deployments() for the service/environment
  → If found: extracts github_repo field from deployment record

Level 2: service_repo_map table
  → SELECT from DB for pre-registered mappings

Decision matrix:
  ┌──────────┬─────────┬──────────────────────────────────────┐
  │ CI/CD    │ Mapping │ Action                               │
  ├──────────┼─────────┼──────────────────────────────────────┤
  │ ✓        │ ✓       │ discovered_via="cicd+mapping"        │
  │ ✓        │ ✗       │ auto-write mapping, "cicd"           │
  │ ✗        │ ✓       │ discovered_via="mapping"             │
  │ ✗        │ ✗       │ → Level 3                            │
  └──────────┴─────────┴──────────────────────────────────────┘

Level 3: RepoDiscoverySubAgent (separate Claude agent)
  → Searches GitHub org with search_github tool (up to 5 iterations)
  → If found: auto-writes mapping, discovered_via="sub_agent"

Level 4: RuntimeError
  → If everything fails, the RCA cannot proceed
```

**Demo scenario:** The `notification-service` fixture has `github_repo=None` in its deployment record AND no mapping pre-loaded — specifically to exercise the sub-agent path.

---

## 10. Caching System

The cache prevents redundant GitHub API calls (rate limits, latency).

**Cache lifecycle:**
```
RCA starts
  │
  ├─ read_context_cache("payment-service", "file:src/payments/processor.py")
  │     → cache miss (invalidated_at IS NOT NULL, or no row)
  │
  ├─ get_repo_file() → actual GitHub API call
  │
  ├─ write_context_cache("payment-service", "file:src/payments/processor.py", content)
  │     → UPSERT with invalidated_at=NULL
  │
  └─ Next time same file is fetched in same or different RCA:
       read_context_cache() → cache HIT, no GitHub API call
```

**Cache invalidation:** `invalidate_service_cache(service_name, new_commit_sha)` is called when a new deployment is detected. It marks all `file:*` and `repo_tree` entries as invalid where `commit_sha != new_commit_sha`. This ensures stale file content is not used after a deployment.

**`rca_history` key:** Stores the last 10 RCA summaries per service (summary, confidence, generated_at) for context in future analyses.

---

## 11. HTML Report Rendering

`report_renderer.py` builds a single, fully self-contained HTML page with inline CSS. No JavaScript, no external dependencies — can be saved and opened offline.

**Visual sections:**
1. Header — gradient banner with service name, severity badge, env, RCA ID
2. Incident Summary — key-value table
3. Timeline — numbered events with vertical connector lines
4. Root Cause — confidence badge, code reference box (file/line/function + GitHub link), regression commit box (red background)
5. Evidence — collapsible code/diff blocks (diffs are syntax-highlighted: green=added, red=removed, blue=context headers)
6. Impact Assessment — responsive card grid
7. Contributing Factors — bulleted list
8. Suggested Solutions — priority-numbered cards with effort badges
9. Prevention Recommendations — checkmark list
10. Analysis Metadata — stat cards (iterations, files fetched, cache hits)

**Dark theme colors:**
- Background: `#0f1117`, Card: `#1e2030`, Secondary: `#12131f`
- Primary text: `#e2e8f0`, Muted: `#94a3b8`, Dimmed: `#64748b`
- Accent (purple): `#a5b4fc`, Links: `#60a5fa`

---

## 12. API Endpoints

### ID conventions

Two UUIDs appear in the API and they are **not interchangeable**:

| ID | Where it comes from | Where it's used |
|---|---|---|
| `error_log_id` | `error_logs.id` (DB primary key, written by ingestion or seed) | Request bodies to `/rca/run` and `/rca/run/stream`; path parameter in `GET /rca/{error_log_id}/report` |
| `rca_id` | Generated by Claude inside `finish_rca` (UUID4) | A field inside the `RCAReport` JSON; also stored on `rca_reports.rca_id` |

The report-rendering endpoint is keyed on `error_log_id`. If you build a URL
or DB lookup using `rca_id` where `error_log_id` is expected, the
`SELECT … FROM error_logs WHERE id = …` returns nothing and the route 404s
with `{"detail": "Error log not found"}`. The demo UI's `showReport()` uses
`reportDict.error_log_id` for exactly this reason.

### RCA Agent (`http://localhost:8000`)

```
GET  /health
     Response: {status, model, github_org, observability_adapter, cicd_adapter}

POST /rca/run
     Body:     {"error_log_id": "uuid"}
     Response: Full RCAReport JSON (blocks until complete)

POST /rca/run/stream
     Body:     {"error_log_id": "uuid"}
     Response: text/event-stream
               data: {"type":"start","service":"payment-service",...}
               data: {"type":"reasoning","text":"The error is..."}
               data: {"type":"tool_call","tool":"get_commit_diff",...}
               data: {"type":"tool_result","tool":"get_commit_diff","summary":"..."}
               data: {"type":"complete","confidence":"high","iterations":7}
               data: {"type":"done","report":{...}}

GET  /rca/{error_log_id}/report
     Response: HTML page (rendered RCA report)
              or 202 HTML if still in_progress/pending

GET  /demo
     Response: demo_ui.html (self-contained interactive demo page)

GET  /demo/scenarios
     Response: {"payment-service":"uuid","order-service":"uuid",...}
```

### Error Ingestion Agent (`http://localhost:8001`, Datadog mode only)

```
POST /webhook/datadog
     Body:     DatadogAlertPayload JSON
     Response: {"status":"accepted","service":"...","message":"Incident queued"}
               (always 202 — processing is async)

GET  /health
     Response: {"status":"ok","mode":"datadog_webhook","service":"banking-app"}
```

---

## 13. Eval/Test Suite

**Location:** `rca-agent/evals/`

**Run:** `pytest evals/ -v`

### 10 Test Cases

| Case | Service | Error Type | Special |
|---|---|---|---|
| 1 | payment-service | AttributeError — NullPointerException | Regression in recent commit |
| 2 | order-service | PydanticUserError — @validator removed in v2 | Dependency upgrade bug |
| 3 | notification-service | KeyError — missing env var | Forces sub-agent discovery (no github_repo) |
| 4 | analytics-service | ZeroDivisionError | New feature missing guard |
| 5 | recommendation-service | IndexError | Empty list access |
| 6 | inventory-service | QueryTimeout | Missing DB index, full table scan |
| 7 | user-service | ImportError | Circular import |
| 8 | email-service | RateLimitError | Retry storm, no backoff |
| 9 | reporting-service | OperationalError | Connection leak |
| 10 | search-service | TimeoutError | ReDoS regex catastrophic backtracking |

### Scoring Rubric (100 points per case, must pass ≥ 80)

| Axis | Points | What is Checked |
|---|---|---|
| Correct repo | 20 | `ground_truth.repo` in `report.root_cause.code_reference.repo` |
| Correct file | 25 | `ground_truth.file` in `report.root_cause.code_reference.file` |
| Root cause keywords | 30 | At least one keyword from list appears in `root_cause.summary` |
| Fix area in solutions | 25 | `ground_truth.fix_area` appears in suggested solutions text |

### Mocking Strategy

- **GitHub API:** `responses` library intercepts HTTP calls. `setup_github_mocks(case)` registers mock responses for file content, commit diff, repo listing, code search, commit history.
- **Database cache:** `monkeypatch` replaces `read_cache`, `write_cache`, `append_rca_history`, `_persist` with no-ops.
- **DB mapping:** `monkeypatch` replaces `_get_mapping` and `_write_mapping` with no-ops.
- **CICD:** `_SingleDeploymentCICDAdapter` wraps the fixture's `mock_deployment` dict.
- **Observability:** `MockObsAdapter` returns `ErrorLogEntry` from the fixture dict.

---

## 14. Docker Compose Stack

**File:** `banking-app-master/docker-compose.yml`

5 services, all in one `docker-compose up`:

```
Service           Port   Depends On    Key Volume
─────────────────────────────────────────────────────────
mysql             3306   —             mysql_data (persistent)
banking-app       8080   mysql         banking_logs (writes)
error-ingestion   8001   mysql         banking_logs (read-only)
rca-agent         8000   mysql         —
demo-ui           3000   banking-app,  ./demo-ui (nginx static)
                         rca-agent
```

**Shared volume `banking_logs`:** Both `banking-app` (writes) and `error-ingestion-agent` (reads with `:ro`) mount `/var/log/banking-app`. This is how log file tailing works across containers.

**Health checks:**
- `mysql`: `mysqladmin ping` every 5s, 10 retries
- `banking-app`: `curl /actuator/health` every 10s, 30s start period
- `rca-agent`: `curl /health` every 10s

### 14.1 AWS topology — one EC2 per service

The Docker Compose stack above is the **local** topology: a single host, shared `banking_logs` volume, services talking over the compose bridge network. The **AWS** topology (Terraform in `banking-app-master/terraform/aws/`) deliberately differs:

- **Three EC2 container instances**, one per service: `host_monitored_app`, `host_ingestion_agent`, `host_rca_agent`. Each is right-sized to its task's memory needs (defaults: t3.small / t3.micro / t3.small).
- Each instance advertises a `module` attribute via `ECS_INSTANCE_ATTRIBUTES` in user_data; each ECS service uses a `memberOf(attribute:module == ...)` placement constraint to pin its task to the matching host. One ECS cluster, three pinned tasks.
- **No shared log volume.** On AWS the ingestion path is `MODE=datadog_poll` — the dd-agent sidecar on the monitored-app host ships logs to Datadog, and the ingestion-agent on its own host pulls them back via the Datadog Logs API. There is no equivalent of compose's `banking_logs:ro` mount across EC2 instances; switching back to `MODE=db` (file tailing) is not supported on the per-host AWS topology.
- The **monitored-app slot is fully parameterized** via `var.monitored_app` (object: `service_name`, `image_repo_name`, `image_tag`, `port`, `task_cpu`, `task_memory`, `instance_type`, `needs_dd_sidecar`, `extra_env`). Swapping banking-app for a different application is a tfvars edit plus a `terraform apply`; the ingestion-agent and rca-agent hosts are untouched.

See `AWS_DEPLOYMENT.md` for the full deployment guide and the "Swapping the Monitored Application" section.

---

## 15. Configuration & Environment Variables

### `banking-app-master/.env.example` (top-level for docker-compose)

| Variable | Purpose |
|---|---|
| `MYSQL_ROOT_PASSWORD` | MySQL root password |
| `MYSQL_DATABASE` | MySQL database name (defaults to `rca_db`) |
| `ANTHROPIC_API_KEY` | Claude API key |
| `GITHUB_TOKEN` | GitHub PAT (read-only access) |
| `GITHUB_ORG` | GitHub org to search in |
| `GEMINI_API_KEY` | Google Gemini key (for ingestion agent) |
| `DATADOG_API_KEY` | Optional — Datadog metrics export |
| `INGESTION_MODE` | `db` or `datadog` |
| `APP_ENV` | `production` or `staging` |

### `rca-agent/.env.example`

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | required | |
| `GITHUB_PAT` | required | |
| `GITHUB_ORG` | `oscorpAI` | |
| `DATABASE_URL` | `mysql+pymysql://root:root@localhost:3306/rca_db` | PyMySQL DSN |
| `MODEL` | `claude-sonnet-4-6` | |
| `MAX_REACT_ITERATIONS` | `20` | |
| `OBSERVABILITY_ADAPTER` | `local` | |
| `CICD_ADAPTER` | `mock` | |

---

## 16. Data Models

### `ErrorLogEntry` (input to RCA)
```python
@dataclass
class ErrorLogEntry:
    id: str
    service_name: str
    environment: str
    error_type: str          # e.g. "AttributeError"
    error_message: str       # e.g. "'NoneType' has no attribute 'total'"
    stack_trace: list[dict]  # [{file, line, function, text}, ...]
    severity: str            # "critical" | "high" | "medium" | "low"
    occurred_at: datetime
    request_id: str | None
    metadata: dict           # e.g. {"order_id": "EXP-9921"}
```

### `DeploymentRecord` (from CI/CD adapter)
```python
@dataclass
class DeploymentRecord:
    service_name: str
    environment: str
    branch: str
    commit_sha: str
    deployed_at: datetime
    status: str              # "success" | "failed"
    github_repo: str | None  # None = forces sub-agent discovery
    commit_message: str | None
    deployer: str | None
    pipeline_id: str | None
    pipeline_url: str | None
```

### `RCAReport` (output — Pydantic validated)
Full nested Pydantic model. Key fields:
- `rca_id` — UUID string
- `error_log_id` — links back to input
- `root_cause.confidence` — `"high"` | `"medium"` | `"low"`
- `root_cause.code_reference.file` — the exact file where the bug lives
- `root_cause.regression_introduced_by` — the commit that introduced the bug (if detected)
- `suggested_solutions[].priority` — 1 = most urgent
- `analysis_metadata.react_iterations` — how many Claude turns it took
- `analysis_metadata.repo_discovered_via` — how the repo was found

---

## 17. Technology Stack Summary

### RCA Agent

| Technology | Version | Role |
|---|---|---|
| Python | ≥ 3.11 | Language |
| FastAPI | ≥ 0.110 | HTTP API server |
| Uvicorn | ≥ 0.29 | ASGI server |
| Anthropic SDK | ≥ 0.25 | Claude API client (ReAct loop) |
| PyGithub | ≥ 2.3 | GitHub REST API wrapper |
| PyMySQL | ≥ 1.1 | MySQL driver (sync) |
| Pydantic | ≥ 2.6 | Data validation (RCAReport schema) |
| pydantic-settings | ≥ 2.2 | Environment variable config |
| Alembic | ≥ 1.13 | Database migrations |
| SQLAlchemy | ≥ 2.0 | Used by Alembic (not for queries) |

### Error Ingestion Agent

| Technology | Version | Role |
|---|---|---|
| Python | ≥ 3.11 | Language |
| LangGraph | ≥ 0.2 | StateGraph pipeline (parse→analyze→store) |
| LangChain | ≥ 0.3 | Message abstractions |
| langchain-google-genai | ≥ 2.0 | Gemini LLM integration |
| aiomysql | ≥ 0.2 | Async MySQL driver |
| watchdog | ≥ 4.0 | File system event monitoring |
| FastAPI + Uvicorn | same | Datadog webhook server |
| pydantic-settings | ≥ 2.0 | Config |

### Infrastructure

| Technology | Role |
|---|---|
| MySQL 8.0+ | Single database (`rca_db`) shared by all services |
| Docker Compose | Local orchestration of all 5 services |
| nginx (alpine) | Serves demo UI static files |
| Google Gemini 1.5 Flash | Error classification in ingestion agent |
| Anthropic Claude Sonnet 4.6 | Root cause analysis reasoning |
| GitHub REST API | Source code and commit history access |

---

*Generated by deep static analysis of all source files in `banking-app-master/`.*
