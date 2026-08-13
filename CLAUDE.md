# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## What This Repo Is

**Apollo** — an AI-powered Root Cause Analysis platform. Three Spring Boot Java services generate intentional bugs; an `error-ingestion-agent` watches their shared log file (or polls Datadog), classifies errors with Gemini, and writes them to MySQL. The `rca-agent` (FastAPI + React) lets users run a Claude ReAct loop against those incidents to find the root cause using GitLab source code, commits, and diffs.

---

## Key Commands

### Full stack (Docker)

```bash
# First run
cp env.example .env          # fill in ANTHROPIC_API_KEY, DB_PASSWORD, GITHUB_PAT, GITLAB_URL, GEMINI_API_KEY
docker compose up --build    # 3-5 min first time

# Rebuild a single Python service after code change
# (docker compose restart does NOT pick up .py changes — always rebuild)
docker compose build rca-agent && docker compose up -d rca-agent
docker compose build ingestion-agent && docker compose up -d ingestion-agent

# Rebuild Java service
docker compose build banking-app && docker compose up -d banking-app

# Tear down
docker compose down          # MySQL data persists on host; app-logs volume preserved
```

### Database

```sql
-- create once before first start
CREATE DATABASE rca_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

Alembic runs automatically on container start (`alembic upgrade head` in the Dockerfile CMD). To run migrations manually:

```bash
cd apollo-agent/rca-agent
alembic upgrade head
alembic revision -m "describe_change"   # create new migration in alembic/versions/
```

### Register services after projects.yaml changes

```bash
python apollo-agent/add_service_map.py
```

### React UI (local dev without Docker)

```bash
cd apollo-agent/rca-agent/ui
npm install
npm run dev      # Vite dev server (proxies /api/* to localhost:8000)
npm run build    # outputs to ui/dist/ — baked into Docker image at build time
```

### Run rca-agent locally (outside Docker)

```bash
cd apollo-agent/rca-agent
pip install -e .
uvicorn app.main:app --reload --port 8000
```

### Evals

```bash
cd apollo-agent/rca-agent
pytest evals/ -v
pytest evals/test_specific.py::test_name   # single test
```

---

## Service Ports

| Port | Service | Notes |
|---|---|---|
| 8000 | `rca-agent` — Apollo UI + all `/api/*` | Main app |
| 8001 | `ingestion-agent` control API | Internal; `POST /org`, `POST /source`, `GET /health` |
| 5000 | `trigger-ui` (Flask) | Error trigger + live log viewer — **do not modify** |
| 8080–8082 | Java banking/pricing/order services | Demo services |

---

## Architecture

### Services

```
docker-compose stack:
  Java services (8080/8081/8082) → shared log volume (/var/log/banking-app/app.log)
      ↓
  error-ingestion-agent (internal)
    • file watcher (watchdog) OR Datadog Logs API poller
    • LangGraph: parse_node → analyze_node (Gemini gemini-2.5-flash) → store_node
    • writes to MySQL error_logs with risk_level, category, fingerprint (SHA-256 dedup)
    • control API on :8001 — /source, /monitoring, /org, /health
      ↓
  MySQL on host (rca_db)  ← containers connect via host.docker.internal:3306
      ↑
  rca-agent (8000)
    • FastAPI serving all /api/* endpoints + React static files
    • Claude ReAct loop: up to 20 iterations, 13 tools, SSE streaming to browser
    • Auth: JWT (HS256, 7-day expiry) — all /api/* routes require Bearer token
    • Alembic migrations run at startup
```

### Multi-tenant org model

Every resource (incidents, credentials, ingestion config) is scoped to an `organisations` row:

- `organisations`: id, owner_user_id, name, environment, ingest_api_key
- `org_integrations`: per-org credentials (claude, datadog, github, gitlab, ingestion) — UNIQUE KEY `(org_id, integration_type)`
- `agent_config`: key/value table; `active_ingest_org_id` tells the ingestion agent which org to tag errors with — written by Apollo UI on org create/switch, read by ingestion agent every 30s
- Credentials are AES-256 encrypted via `rca_agent/secrets.py` before storage; `encrypt_config` / `decrypt_config` wrap the dict

When adding a new API endpoint involving org data, always filter by `owner_user_id` from the JWT, and save/read credentials through `saveOrgIntegration` / `fetchOrgIntegrations`.

### RCA agent loop (`rca_agent/agent.py`)

Claude claude-haiku-4-5-20251001 (configurable via MODEL env / Settings UI) runs a ReAct loop with these 13 tools: `read_dependency_memory`, `get_recent_deployments`, `read_context_cache`, `get_repo_file`, `list_repo_files`, `search_code_in_repo`, `search_github_global`, `get_commit_diff`, `get_commits_since`, `get_service_metadata`, `write_context_cache`, `write_dependency_memory`, `finish_rca`.

Chaos file blocking happens at the tool dispatch layer — chaos paths return an advisory message from `get_repo_file` and are stripped from `list_repo_files` / search results. The system prompt also has an explicit constraint. Never remove this protection.

`get_repo_file` line-numbers every line (`N | content`) before sending to Claude to eliminate off-by-N errors. Max 150 lines per fetch.

### SSE pub-sub (`app/main.py`)

`_active_jobs` dict keyed by `error_log_id`. First browser request starts the agent thread and registers a subscriber queue. Reconnects/second tabs subscribe to the existing job — no duplicate agents. `_job_broadcast` delivers events to all queues; `_job_finish` sends sentinel `None` and keeps the slot for 60s for late reconnectors.

### Settings overlay (`rca_agent/overlay.py`)

Runtime settings (API keys, model, etc.) are stored in `/app/apollo_settings.json` inside the rca-agent container and read with a 5s TTL cache. Most settings take effect on the next RCA run — no restart needed. **Gemini API key** and adapter selections require a container restart (ingestion-agent reads from env, not overlay).

### Ingestion agent org resolution (`error-ingestion-agent/db/database.py`)

`resolve_org_id()` checks in priority order:
1. `agent_config.active_ingest_org_id` (set by Apollo UI on org create/switch) — normal path
2. `APOLLO_INGEST_API_KEY` env var — advanced multi-agent override
3. Single-org auto-discovery — last resort for brand-new installs

Background loop retries every 30s until an org is found. When Apollo UI switches org, it also calls `POST ingestion-agent:8001/org` for an immediate in-process update.

---

## Database Migrations

Migrations live in `apollo-agent/rca-agent/alembic/versions/`. Current head: `006_agent_config`. Each migration is self-contained (includes `CREATE TABLE IF NOT EXISTS` for safety on fresh DBs) and uses try/except to catch MySQL error codes for idempotency:
- `1060` — duplicate column
- `1061` — duplicate key name
- `1091` — can't drop key (doesn't exist)

Always make new migrations self-contained — don't assume the app startup has run first.

---

## Frontend

React 18 + React Router v6 + Vite. No component library — all styles in `ui/src/index.css` using CSS custom properties (`--indigo`, `--bg-card`, `--text-primary`, etc.). Dark/light theme via `@media (prefers-color-scheme: dark)`.

`ui/src/api/client.js` is the single source of truth for all API calls. `request()` injects the `Authorization: Bearer` header automatically and redirects to `/login` on 401.

`AppContext.jsx` holds: `activeOrg`, `orgs`, monitoring state, toast, stream target. Pages read `activeOrg` to scope their data fetches — always pass `org_id` to backend endpoints that need it.

The React build is baked into the Docker image (`ui/dist/`) and served as static files by FastAPI. In local dev, Vite proxies `/api/*` to `:8000`.

---

## Critical Invariants

- **Never touch `trigger-ui` (port 5000)** — it is a read-only demo UI; all changes go to `apollo-agent/rca-agent` (port 8000) and `apollo-agent/error-ingestion-agent`.
- **`docker compose restart` does not apply Python code changes** — always `build` after editing `.py` files.
- `org_integrations` UNIQUE KEY is `(org_id, integration_type)` — one credential set per org per type. Never change this to `(user_id, …)`.
- The two-query pattern in `/api/token-usage/by-incident` exists intentionally to avoid a MySQL collation JOIN mismatch between `token_usage` (`utf8mb4_unicode_ci`) and `error_logs` (`utf8mb4_0900_ai_ci`).
- `GITHUB_PAT` in `.env` accepts a **GitLab** token (`glpat-…`) — the field name is a historical artefact.
- `DATABASE_URL` in `.env` uses `localhost` (for running locally). `docker-compose.yml` overrides it with `host.docker.internal` for container→host MySQL connectivity.
