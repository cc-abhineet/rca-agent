# DEMO_GUIDE.md — Running the RCA Platform

This guide covers two demo modes:

- **demo profile** — Local demo with synthetic error logs from the three demo-repo services (payment-service, order-service, notification-service). No Datadog credentials required.
- **banking profile** — Full banking-app stack where errors flow from the live banking-app → Datadog → ingestion agent → RDS → RCA agent. Requires real Datadog credentials.

---

## Prerequisites

All modes require:

- Docker + Docker Compose v2
- Python 3.11+ (for running the seed script)
- `ANTHROPIC_API_KEY` — get from https://console.anthropic.com
- `GITHUB_PAT` — GitHub Personal Access Token with `repo:read` scope
- `GEMINI_API_KEY` — Google Gemini API key from https://aistudio.google.com/app/apikey

Banking profile additionally requires:
- `DD_API_KEY` — from https://app.datadoghq.com/organization-settings/api-keys
- `DD_APP_KEY` — from https://app.datadoghq.com/organization-settings/application-keys

---

## Setup (both modes)

```bash
# 1. Clone and enter the repo
cd banking-app-master

# 2. Create your .env from the template
cp .env.example .env
# Edit .env and fill in real values for ANTHROPIC_API_KEY, GITHUB_PAT, GEMINI_API_KEY
# For banking profile also fill in DD_API_KEY, DD_APP_KEY
```

---

## Demo Mode — Synthetic Errors (no Datadog needed)

This mode uses the file-watcher to ingest errors and the demo-repos error scenarios. The RCA agent is triggered manually via the UI.

```bash
# Start MySQL + rca-agent (manual trigger mode) + ingestion-agent (file watcher)
docker compose --profile demo up --build -d

# Wait for MySQL and services to be healthy (check with):
docker compose --profile demo ps

# Seed the database — inserts service_repo_map entries and 3 synthetic error logs
python demo-repos/demo_seed_data.py

# Open the demo UI
open http://localhost:8000/demo
```

**What you'll see in the demo UI:**

1. A dropdown with three error scenarios: payment-service AttributeError, order-service PydanticUserError, notification-service KeyError.
2. Select one and click "Run RCA" — watch the agent trace in real-time.
3. A full HTML report is generated with root cause, fix recommendation, and affected code lines.

**Notable demo moments:**
- The `notification-service` scenario has no repo mapping seeded — watch the sub-agent discover its GitHub repo by searching the org.
- The `payment-service` scenario shows the agent reading actual source files from GitHub to identify the null dereference.

---

## Banking Profile — Live Errors via Datadog

This mode runs the full pipeline: banking-app generates errors → Datadog captures logs → ingestion agent polls Datadog Logs API → RDS → RCA agent auto-processes.

```bash
# Ensure DD_API_KEY and DD_APP_KEY are set in .env

# Start all banking-app services
docker compose --profile banking up --build -d

# Wait for all services to be healthy
docker compose --profile banking ps

# Seed service_repo_map (banking-app entry)
python demo-repos/demo_seed_data.py

# Open the RCA demo UI (shows auto-processed reports as they arrive)
open http://localhost:8000/demo

# Open the banking-app API
open http://localhost:8080/chaos/scenarios
```

**Triggering errors:**

```bash
# Trigger a NullPointerException
curl -X POST http://localhost:8080/chaos/null-pointer

# Trigger a database connection failure simulation
curl -X POST http://localhost:8080/chaos/db-connection

# Trigger a timeout (waits 35 seconds)
curl -X POST http://localhost:8080/chaos/timeout
```

**What happens end-to-end:**

1. `POST /chaos/null-pointer` → exception thrown → logged to `/var/log/banking-app/app.log`
2. Datadog agent (sidecar) tails the log file and ships the event to Datadog Logs
3. `ingestion-agent` (MODE=datadog_poll) polls Datadog Logs API every 30s
4. New ERROR events are processed through the LangGraph pipeline (parse → Gemini analyze → store)
5. `rca-agent` poll loop (`RCA_POLL_ENABLED=true`) picks up the new `pending` row in `error_logs`
6. Claude ReAct loop runs: fetches source from GitHub, analyzes the stack trace, generates fix
7. Report visible at `http://localhost:8000/demo`

**Polling delay:** up to 60 seconds end-to-end (30s Datadog poll + 30s RCA poll). Tune `POLL_INTERVAL_SECONDS` in `.env` to reduce latency for demos.

---

## Useful Docker Compose Commands

```bash
# View logs for all services
docker compose --profile demo logs -f

# View logs for a specific service
docker compose --profile banking logs -f ingestion-agent-banking

# Restart a single service
docker compose --profile banking restart rca-agent-banking

# Stop everything and remove containers (keeps MySQL volume)
docker compose --profile demo down

# Wipe everything including MySQL data (full reset)
docker compose --profile demo down -v

# Run a one-off command in a service container
docker compose --profile banking exec rca-agent-banking python -c "from rca_agent.db import execute; print(execute('SELECT * FROM error_logs LIMIT 3'))"
```

---

## Resetting Between Demos

```bash
# Wipe all RCA data and re-seed
docker compose --profile demo down -v
docker compose --profile demo up --build -d
python demo-repos/demo_seed_data.py
```

---

## Architecture Diagram

```
┌────────────────────────────────────────────────────────┐
│                    banking-app                          │
│  POST /chaos/null-pointer → NullPointerException       │
│  Logback → /var/log/banking-app/app.log (shared vol)  │
└───────────────────┬────────────────────────────────────┘
                    │ (shared Docker volume)
                    ▼
┌────────────────────────────────────────────────────────┐
│               Datadog Agent (sidecar)                   │
│  Tails app.log → ships logs to Datadog Logs            │
└───────────────────┬────────────────────────────────────┘
                    │ (Datadog Logs API)
                    ▼
┌────────────────────────────────────────────────────────┐
│             error-ingestion-agent                       │
│  MODE=datadog_poll: polls Datadog Logs API every 30s   │
│  parse → Gemini analyze → store in error_logs (MySQL)  │
└───────────────────┬────────────────────────────────────┘
                    │ (MySQL rca_db.error_logs)
                    ▼
┌────────────────────────────────────────────────────────┐
│                  rca-agent                              │
│  RCA_POLL_ENABLED=true: scans for pending rows every   │
│  30s → Claude ReAct loop (up to 20 iterations)         │
│  → fetches GitHub source → root cause + fix            │
└───────────────────┬────────────────────────────────────┘
                    │ (rca_result JSON in error_logs)
                    ▼
               Demo UI at /demo
```

---

## Troubleshooting

**No errors appearing in the demo UI after triggering chaos:**

1. Check ingestion-agent logs: `docker compose --profile banking logs ingestion-agent-banking`
2. Verify Datadog credentials are set and valid
3. Check if the Datadog agent is shipping logs: look for your events at https://app.datadoghq.com/logs
4. Confirm `DD_INITIAL_LOOKBACK_HOURS` covers the time since you triggered the chaos

**RCA reports stuck at "pending":**

1. Check rca-agent logs: `docker compose --profile banking logs rca-agent-banking`
2. Confirm `RCA_POLL_ENABLED=true` in the rca-agent container env
3. Verify `ANTHROPIC_API_KEY` and `GITHUB_PAT` are set correctly

**MySQL connection failures:**

1. Ensure MySQL is healthy: `docker compose --profile banking ps mysql`
2. MySQL takes ~30 seconds to initialize on first start — the other services will retry

**banking-app not starting:**

1. Check JVM logs: `docker compose --profile banking logs banking-app`
2. The H2 in-memory DB doesn't require any external DB — failures here are usually config or image build issues
