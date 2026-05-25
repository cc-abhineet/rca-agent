# HOW_TO_RUN_LOCALLY.md — Local Development Setup

This guide covers running the full RCA pipeline locally. For Docker Compose one-liners see `DEMO_GUIDE.md`. For AWS deployment see `AWS_DEPLOYMENT.md`.

---

## Prerequisites

- Java 17 + Maven 3.9 (for banking-app without Docker)
- Python 3.11+
- MySQL 8.0 (or run via Docker — see below)
- Docker + Docker Compose v2 (recommended)

---

## Option A — Docker Compose (recommended)

The fastest way to run everything. See `DEMO_GUIDE.md` for full instructions.

```bash
# Demo mode (no Datadog credentials needed)
cp .env.example .env        # fill in ANTHROPIC_API_KEY, GITHUB_PAT, GEMINI_API_KEY
docker compose --profile demo up --build -d
python demo-repos/demo_seed_data.py
open http://localhost:8000/demo

# Banking mode (requires DD_API_KEY, DD_APP_KEY)
docker compose --profile banking up --build -d
python demo-repos/demo_seed_data.py
open http://localhost:8000/demo
```

---

## Option B — Run Services Individually

### Step 1 — Start MySQL

```bash
docker run -d --name rca-mysql \
  -e MYSQL_ROOT_PASSWORD=root \
  -e MYSQL_DATABASE=rca_db \
  -p 3306:3306 \
  mysql:8.0

# Wait ~30 seconds for MySQL to initialize
```

### Step 2 — Run rca-agent (apply schema + start API)

```bash
cd banking-app-master/rca-agent

# Install dependencies
pip install -e ".[test]"

# Configure
cp .env.example .env
# Edit .env: fill in ANTHROPIC_API_KEY, GITHUB_PAT
# For banking-app polling: set RCA_POLL_ENABLED=true

# Apply schema migrations (creates error_logs, service_repo_map, etc.)
alembic upgrade head

# Start the API
uvicorn app.main:app --reload --port 8000
```

### Step 3 — Seed service_repo_map and demo errors

```bash
# From banking-app-master/
python demo-repos/demo_seed_data.py

# This inserts:
#   service_repo_map: payment-service, order-service, banking-app
#   error_logs:       3 synthetic errors (payment, order, notification services)
#   seeded_ids.json:  written next to demo_seed_data.py for the demo UI
```

### Step 4 — Run error-ingestion-agent

```bash
cd banking-app-master/error-ingestion-agent

pip install -r requirements.txt

cp .env.example .env
# Edit .env:
#   DATABASE_URL=mysql+pymysql://root:root@localhost:3306/rca_db
#   GEMINI_API_KEY=...
#   MODE=db                    # for file watcher
#   # or
#   MODE=datadog_poll          # requires DD_API_KEY, DD_APP_KEY
#   DD_API_KEY=...
#   DD_APP_KEY=...

python main.py
```

### Step 5 — Run banking-app (optional, needed for MODE=datadog_poll)

```bash
cd banking-app-master

# Without Docker (requires Java 17 + Maven)
mvn spring-boot:run

# Or with Docker
docker build -t banking-app .
docker run -p 8080:8080 \
  -v $(pwd)/logs:/var/log/banking-app \
  banking-app
```

Banking-app starts with H2 in-memory. No external DB required.

Verify it's running:
```bash
curl http://localhost:8080/actuator/health
curl http://localhost:8080/chaos/scenarios
```

### Step 6 — Trigger errors and view RCA reports

Open the demo UI: http://localhost:8000/demo

Or trigger via curl:
```bash
# Trigger a chaos scenario (banking-app must be running)
curl -X POST http://localhost:8080/chaos/null-pointer
curl -X POST http://localhost:8080/chaos/db-connection

# Manually trigger RCA for a specific error log
# (get the ID from demo_seed_data.py output or the demo UI)
curl -s -X POST http://localhost:8000/rca/run \
  -H "Content-Type: application/json" \
  -d '{"error_log_id": "<uuid>"}' | python3 -m json.tool
```

---

## Useful Database Queries

```sql
-- Check what's in error_logs
SELECT id, service_name, error_type, rca_status, occurred_at
FROM error_logs
ORDER BY occurred_at DESC
LIMIT 10;

-- Check service_repo_map
SELECT * FROM service_repo_map;

-- Check Datadog cursor for banking-app
SELECT service_name, content, last_used_at
FROM service_context_cache
WHERE cache_key = 'dd_cursor';

-- Reset a failed RCA to retry it
UPDATE error_logs
SET rca_status = 'pending', rca_error = NULL
WHERE id = '<uuid>';
```

Connect to local MySQL:
```bash
mysql -u root -proot rca_db
# or
docker exec -it rca-mysql mysql -u root -proot rca_db
```

---

## Developing the RCA Agent

```bash
cd rca-agent

# Run with auto-reload
uvicorn app.main:app --reload

# Run evals
pytest evals/ -v

# Check ReAct loop for a specific error
curl -s -X POST http://localhost:8000/rca/run/stream \
  -H "Content-Type: application/json" \
  -d '{"error_log_id": "<uuid>"}' \
  --no-buffer
```

---

## Common Issues

**`error_logs` table not found when starting ingestion-agent:**  
Run `alembic upgrade head` in the rca-agent directory first. The ingestion-agent writes to error_logs but does not create it — the rca-agent's Alembic migrations own the schema.

**MySQL connection refused:**  
Wait ~30 seconds after starting the MySQL container before running other services. MySQL takes time to initialize on first boot.

**`GEMINI_API_KEY` not set warning:**  
The analyze_node will fall back gracefully — incidents are still stored but without a Gemini summary. The field `error_message` will be the raw parsed message instead.

**RCA stuck in `in_progress` forever:**  
The Claude ReAct loop hit the `MAX_REACT_ITERATIONS` cap (default 20) without calling `finish_rca`. Check rca-agent logs. Reset with:
```sql
UPDATE error_logs SET rca_status='pending' WHERE id='<uuid>';
```

**banking-app healthcheck failing in Docker Compose:**  
The Spring Boot actuator starts after JVM initialization (~20-30 seconds). The healthcheck has `start_period: 60s` to handle this. If it still fails, check `docker compose --profile banking logs banking-app`.
