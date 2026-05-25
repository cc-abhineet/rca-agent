# CODEBASE_DEEP_DIVE.md — Architecture & Implementation Reference

This document is the primary technical reference for the banking-app RCA platform. It covers architecture, data flow, database schema, key code patterns, and how all pieces fit together.

> **Last updated:** reflects Batch 1-4 changes. For deployment instructions see `AWS_DEPLOYMENT.md`. For demo instructions see `DEMO_GUIDE.md`.

---

## System Overview

The platform is a two-service AI pipeline that monitors a Spring Boot banking application and automatically performs root cause analysis on errors.

```
Banking App  →  Datadog Agent (sidecar)  →  Datadog Logs
                                                  │
                                    Polls Logs API (every 30s)
                                                  │
                                      Error Ingestion Agent
                                    (LangGraph: parse → analyze → store)
                                                  │
                                          MySQL: error_logs
                                                  │
                                    Polls DB (every 30s)
                                                  │
                                           RCA Agent
                                    (Claude ReAct loop, up to 20 steps)
                                                  │
                                    rca_result stored in error_logs
                                                  │
                                           Demo UI / API
```

All connections between services are **polling-based** (no direct service-to-service HTTP calls). The ingestion agent writes to MySQL and stops. The RCA agent polls MySQL independently. This decoupling means services can be scaled, restarted, or replaced without affecting each other.

---

## Services

### 1. banking-app

**Language:** Java 17 / Spring Boot 3.2  
**DB:** H2 in-memory (accounts and transactions — not shared with RCA pipeline)  
**Port:** 8080  
**Purpose:** Demo Spring Boot application that generates realistic error logs

Key endpoints:
- `GET/POST /api/v1/accounts` — CRUD operations on bank accounts
- `POST /api/v1/accounts/{id}/deposit|withdraw|transfer` — transactions
- `GET /chaos/scenarios` — list available error injection scenarios
- `POST /chaos/{scenario}` — trigger a specific error (null-pointer, db-connection, timeout, validation, insufficient-funds)
- `GET /actuator/health` — health check (used by ALB)

Logging: `logback-spring.xml` writes structured logs to `/var/log/banking-app/app.log` (shared Docker volume) AND to stdout in JSON format for Datadog APM correlation.

### 2. error-ingestion-agent

**Language:** Python 3.11  
**Framework:** LangGraph (StateGraph pipeline)  
**DB:** MySQL rca_db (writes error_logs, reads/writes service_context_cache for Datadog cursor)  
**Purpose:** Ingest errors from Datadog and store them for the RCA agent

Three operating modes (selected via `MODE` env var):

- `MODE=db` — File-watcher (watchdog library): tails a log file for new error lines. Used by the demo profile.
- `MODE=datadog` — FastAPI webhook receiver on port 8001. Receives Datadog monitor alerts. Not used in the primary banking-app flow.
- `MODE=datadog_poll` — Polls the Datadog Logs Search API (v2) every 30s. **Primary mode for banking-app.**

LangGraph pipeline (3 nodes):
1. **parse_node** — Extracts timestamp, severity, error type, message, stack trace from raw log string
2. **analyze_node** — Calls Google Gemini (gemini-2.5-flash) for a one-sentence summary and error category
3. **store_node** — Inserts a row into `error_logs` with `rca_status='pending'`

Service identity in `MODE=datadog_poll`: service_name and environment are read from `projects.yaml` and passed through the LangGraph state, overriding the `SERVICE_NAME` env var. This allows a single ingestion agent instance to monitor multiple services.

### 3. rca-agent

**Language:** Python 3.11  
**Framework:** FastAPI + LangChain (Claude ReAct)  
**DB:** MySQL rca_db (reads error_logs, writes rca_result back)  
**Port:** 8000  
**Purpose:** Run AI-powered root cause analysis on ingested errors

Poll loop (`RCA_POLL_ENABLED=true`):
- Background daemon thread started by the FastAPI lifespan context manager
- Scans `error_logs` for `rca_status='pending'` rows (oldest first)
- Atomically claims a row: `UPDATE ... WHERE rca_status='pending'` → checks `rowcount == 1`
- Calls `agent.run(error_log_id)` in the same thread
- Updates `rca_status` to `'completed'` or `'failed'`

Claude ReAct loop:
- Up to 20 iterations
- 10 tools: `get_error_log`, `get_service_info`, `get_recent_errors`, `search_repo_for_file`, `get_file_from_repo`, `get_recent_commits`, `get_blame_for_file`, `get_cicd_status`, `get_deployment_history`, `finish_rca`
- Must call `finish_rca` to terminate — produces a structured `RCAReport`

HTTP API (also available alongside the poll loop):
- `GET /health` — health check
- `POST /rca/run` — trigger RCA for a specific error log ID (manual/demo mode)
- `POST /rca/run/stream` — same but Server-Sent Events for real-time trace
- `GET /rca/{id}/report` — HTML report for a completed RCA
- `GET /demo` — self-contained demo UI
- `GET /demo/scenarios` — list pending errors for the demo dropdown

---

## Database Schema

All tables live in the `rca_db` MySQL database. Schema is managed by Alembic migrations in `rca-agent/alembic/versions/`.

### error_logs
Primary shared table. Written by ingestion-agent, read + updated by rca-agent.

| Column | Type | Description |
|---|---|---|
| id | CHAR(36) PK | UUID generated by ingestion-agent |
| service_name | VARCHAR(255) | e.g. `banking-app` |
| environment | VARCHAR(100) | e.g. `production` |
| error_type | VARCHAR(500) | e.g. `NullPointerException` |
| error_message | TEXT | Gemini-analyzed summary |
| stack_trace | JSON | Array of `{text: "..."}` frame objects |
| severity | VARCHAR(50) | `ERROR` / `WARN` / `critical` |
| occurred_at | DATETIME | Parsed from log or NOW() |
| metadata | JSON | `{source, raw_log}` |
| rca_status | VARCHAR(50) | `pending` → `in_progress` → `completed` / `failed` |
| rca_started_at | DATETIME | Set when poll loop claims the row |
| rca_completed_at | DATETIME | Set when Claude finishes |
| rca_result | JSON | Full `RCAReport` dict |
| rca_error | TEXT | Error message if rca_status=failed |

### service_repo_map
Maps service names to GitHub repos. Seeded by `demo-repos/demo_seed_data.py`.

| Column | Type | Description |
|---|---|---|
| service_name | VARCHAR(255) PK | e.g. `banking-app` |
| github_org | VARCHAR(255) | GitHub org/user |
| github_repo | VARCHAR(255) | Repository name |
| default_branch | VARCHAR(100) | e.g. `main` |

### service_context_cache
Dual purpose:
1. Caches GitHub file contents between RCA sessions (avoids re-fetching unchanged files)
2. Stores Datadog Logs API pagination cursors for `MODE=datadog_poll` (key=`dd_cursor`)

| Column | Type | Description |
|---|---|---|
| id | INT AUTO_INCREMENT PK | |
| service_name | VARCHAR(255) | |
| cache_key | VARCHAR(500) | File path OR `dd_cursor` |
| content | JSON | File content OR `{cursor, last_polled_at}` |
| invalidated_at | DATETIME | NULL = valid; set when cache is stale |
| UNIQUE(service_name, cache_key) | | Allows ON DUPLICATE KEY UPDATE |

### rca_reports
Completed RCA reports (redundant with `error_logs.rca_result` — kept for historical querying).

---

## Configuration

### error-ingestion-agent (pydantic-settings)

All settings read from env vars (or `.env` file). Key settings:

| Setting | Env Var | Default | Description |
|---|---|---|---|
| mode | MODE | db | `db` / `datadog` / `datadog_poll` |
| database_url | DATABASE_URL | mysql+pymysql://root:root@localhost:3306/rca_db | |
| gemini_api_key | GEMINI_API_KEY | | Google Gemini key |
| dd_api_key | DD_API_KEY | | Datadog API key |
| dd_app_key | DD_APP_KEY | | Datadog App key |
| dd_site | DD_SITE | datadoghq.com | |
| poll_interval_seconds | POLL_INTERVAL_SECONDS | 30 | |
| projects_yaml_path | PROJECTS_YAML_PATH | /app/projects.yaml | |

### rca-agent (pydantic-settings)

| Setting | Env Var | Default | Description |
|---|---|---|---|
| anthropic_api_key | ANTHROPIC_API_KEY | | Required |
| github_pat | GITHUB_PAT | | GitHub read access |
| github_org | GITHUB_ORG | oscorpAI | |
| database_url | DATABASE_URL | mysql+pymysql://root:root@localhost:3306/rca_db | |
| rca_poll_enabled | RCA_POLL_ENABLED | false | Enables background poll thread |
| rca_poll_interval_seconds | RCA_POLL_INTERVAL_SECONDS | 30 | Idle sleep between scans |
| model | MODEL | claude-sonnet-4-6 | Claude model |
| max_react_iterations | MAX_REACT_ITERATIONS | 20 | ReAct loop cap |

---

## projects.yaml

Service registry for the ingestion agent. Controls which services are monitored in `MODE=datadog_poll`. Baked into the ingestion-agent container image at build time.

```yaml
projects:
  - id: banking-app                   # canonical service_name written to error_logs
    observability_mode: datadog       # required for datadog_poll mode
    environment: production
    github_org: oscorpAI
    github_repo: banking-app
    datadog:
      service_name: banking-app       # Datadog service tag (may differ from id)
      env: production
```

To monitor a different application: edit `projects.yaml`, rebuild the ingestion-agent image, push to ECR, force a new ECS deployment. No code changes required.

---

## Datadog Integration

**Log collection path:**
1. `logback-spring.xml` writes to `/var/log/banking-app/app.log` (Docker shared volume)
2. Datadog agent sidecar (custom image `datadog/Dockerfile`) tails `app.log` using `conf.d/banking-app.d/conf.yaml`
3. Logs appear in Datadog with `service:banking-app`, `source:java`, `env:production`

**Ingestion agent polling:**
- Queries `POST https://api.{DD_SITE}/api/v2/logs/events/search`
- Filter: `service:banking-app status:(error OR exception) env:production`
- Cursor-based pagination: cursor stored in `service_context_cache` with `cache_key='dd_cursor'`
- At-least-once semantics: cursor saved AFTER processing the batch (safe for duplicates)

**Datadog monitor (terraform/datadog_monitor.tf):**
- Fires on `trace.servlet.request.errors > 5 in 5m` (APM metric)
- Historical: pointed at the webhook endpoint. Now superseded by polling mode which doesn't need monitors. Kept for reference/fallback.

---

## Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Ingestion → RCA coupling | Pure DB polling (no HTTP) | Services fully decoupled; each can restart independently |
| Datadog integration mode | Logs API polling (not webhook) | No public endpoint needed; cursor-based, resumable on restart |
| Banking-app DB | H2 in-memory | Simplicity for demo; no external DB needed for the banking app itself |
| RCA agent trigger | Background poll thread | No HTTP trigger from ingestion needed; simpler ops |
| Secrets management | AWS SSM Parameter Store | No secrets in images or files; ECS injects at task start; free tier |
| projects.yaml | Baked into image | Service list stable at deploy time; swap by rebuilding image |
| Error deduplication | Not implemented | At-least-once + separate UUID per row is acceptable for demo |
| AWS topology | One EC2 host per service (pinned via ECS placement constraints) | Per-service failure domain; right-size RAM per task; monitored-app slot is fully parameterized via `var.monitored_app` so banking-app can be swapped for any other service without touching the ingestion-agent / rca-agent hosts |
| Cross-host log ingestion (AWS) | `MODE=datadog_poll` | No shared volume across EC2 instances — dd-agent ships logs to Datadog from the monitored-app host, ingestion-agent pulls them back via the Logs API |

---

## File Map

```
banking-app-master/
├── src/                            Spring Boot banking app
│   └── main/resources/
│       ├── application.yml         H2 DB config, actuator, Datadog metrics
│       ├── logback-spring.xml      Writes logs to /var/log/banking-app/app.log
│       └── data.sql                H2 seed data (5 accounts incl. CHAOS-001)
├── Dockerfile                      Banking app container (Maven + JRE)
│
├── error-ingestion-agent/
│   ├── main.py                     Entry point — dispatches by MODE env var
│   ├── datadog_poller.py           MODE=datadog_poll implementation
│   ├── datadog_webhook.py          MODE=datadog webhook receiver
│   ├── config/settings.py          pydantic-settings config
│   ├── db/database.py              MySQL layer (pool, cursor ops, insert_incident)
│   ├── agents/log_monitor/
│   │   ├── graph.py                LangGraph compiled graph + process_log_entry()
│   │   └── nodes.py                parse_node, analyze_node, store_node
│   ├── utils/log_parser.py         Parses raw Spring Boot log lines
│   ├── requirements.txt            Python dependencies (includes pyyaml)
│   ├── Dockerfile                  Context = repo root (to bake projects.yaml)
│   └── .env.example
│
├── rca-agent/
│   ├── app/main.py                 FastAPI app + lifespan + poll loop
│   ├── rca_agent/
│   │   ├── config.py               Settings incl. rca_poll_enabled
│   │   ├── db.py                   execute(), execute_one(), execute_update()
│   │   ├── agent.py                Claude ReAct loop
│   │   └── adapters/               observability (local_db) + cicd (mock)
│   ├── alembic/versions/001_*.py   DB schema migration
│   ├── Dockerfile                  runs alembic upgrade head + uvicorn
│   └── .env.example
│
├── demo-repos/
│   └── demo_seed_data.py           Seeds service_repo_map + 3 error_logs
│
├── datadog/
│   ├── Dockerfile                  Custom DD agent with conf.yaml baked in
│   └── conf.d/banking-app.d/conf.yaml   Log collection config (path: app.log)
│
├── terraform/
│   ├── datadog_monitor.tf          Datadog APM monitor + webhook (optional)
│   └── aws/                        Full AWS infrastructure (ECS, RDS, ALB, etc.)
│       ├── main.tf                 Provider + backend
│       ├── variables.tf            All input variables
│       ├── network.tf              VPC, subnets, NAT, security groups
│       ├── secrets.tf              Secrets Manager secret resources
│       ├── rds.tf                  RDS MySQL instance
│       ├── ecr.tf                  ECR repositories (4 images)
│       ├── iam.tf                  ECS task roles + CloudWatch log groups
│       ├── alb.tf                  ALB + target groups + listener rules
│       ├── ecs.tf                  Task definitions + ECS services
│       └── outputs.tf              ALB URL, ECR URIs, secret ARNs, checklist
│
├── projects.yaml                   Service registry (read by ingestion-agent)
├── docker-compose.yml              Local development (demo + banking profiles)
├── .env.example                    Root env template
├── DEMO_GUIDE.md                   How to run both demo modes locally
├── AWS_DEPLOYMENT.md               How to deploy to AWS
└── CODEBASE_DEEP_DIVE.md           This file
```
