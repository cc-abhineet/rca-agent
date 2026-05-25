# How to Run Locally

---

## Quick Start — Docker Compose (recommended)

Bring up all three Java services, the Datadog agent, and three log-viewer UIs
in one command:

```bash
# 1. Copy and fill in secrets (DD_API_KEY, ANTHROPIC_API_KEY, GITHUB_PAT)
cp env.example env
#    edit env

# 2. Build and start everything
docker compose up --build
```

| Service | URL | What it is |
|---------|-----|------------|
| banking-app | http://localhost:8080 | Spring Boot banking service |
| pricing-service | http://localhost:8081 | Pricing engine (v2.1.0, `discountRate` rename) |
| order-service | http://localhost:8082 | Order service (Bug A + Bug B) |
| ingestion-agent | — | Tails banking-app logs → inserts errors into MySQL |
| rca-agent | http://localhost:8000 | FastAPI + Claude RCA engine (`/demo` for UI) |
| ui-banking | http://localhost:5000 | Log viewer → banking-app |
| ui-order | http://localhost:5001 | Log viewer → order-service (single-service RCA) |
| ui-pricing-order | http://localhost:5002 | Log viewer → pricing + order (cross-service RCA demo) |

### Before you run — create the MySQL database (one-time)

MySQL runs on your **host** (not in Docker). Create the database and user once before the first `docker compose up`:

```bash
sudo mysql
```
```sql
CREATE DATABASE IF NOT EXISTS rca_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'rca'@'localhost' IDENTIFIED BY 'Rca@12345';
GRANT ALL PRIVILEGES ON rca_db.* TO 'rca'@'localhost';
-- Also grant from Docker containers (they connect via host.docker.internal)
CREATE USER IF NOT EXISTS 'rca'@'%' IDENTIFIED BY 'Rca@12345';
GRANT ALL PRIVILEGES ON rca_db.* TO 'rca'@'%';
FLUSH PRIVILEGES;
exit
```

The rca-agent container runs `alembic upgrade head` automatically on startup, creating all tables.

### How RCA runs

`docker compose up --build` starts everything — Java services, Datadog agent, ingestion-agent, rca-agent (port 8000), and the three log-viewer UIs. After an error is generated, the ingestion-agent detects it in the banking-app log, inserts a row into `error_logs`, and the rca-agent's poll loop picks it up automatically (`RCA_POLL_ENABLED=true`).

To trigger RCA manually or view a report:
```bash
# Browser UI (easiest — shows pending errors in a dropdown)
open http://localhost:8000/demo

# Or curl — get UUID first:
mysql -u rca -p'Rca@12345' rca_db -e "SELECT id, service_name, error_type FROM error_logs WHERE rca_status='pending';"

curl -s -X POST http://localhost:8000/rca/run \
  -H "Content-Type: application/json" \
  -d '{"error_log_id": "PASTE-UUID-HERE"}' | python3 -m json.tool

# HTML report:
open http://localhost:8000/rca/PASTE-UUID-HERE/report
```

---

### Trigger chaos to generate errors

```bash
# Trigger Bug A — NPE from stale discount field (pricing-service renamed discount→discountRate)
# Actual path: POST /api/v1/orders  (controller: @RequestMapping("/api/v1/orders"))
curl -s -X POST http://localhost:8082/api/v1/orders \
  -H "Content-Type: application/json" \
  -d '{"customerId":"demo-1","sku":"SKU-001","quantity":2,"customerTier":"premium"}' | python3 -m json.tool

# Trigger Bug A via chaos endpoint (no request body needed)
curl -s -X POST http://localhost:8082/chaos/cross-service-npe | python3 -m json.tool

# Trigger Bug B — off-by-one in resolveQuantity (quantity=1 → 0 → IllegalArgumentException)
curl -s -X POST http://localhost:8082/chaos/quantity-off-by-one | python3 -m json.tool

# Banking-app chaos
curl -s -X POST http://localhost:8080/chaos/null-pointer | python3 -m json.tool
```

### Register services in the rca-agent database

After running `alembic upgrade head` (see Step 2 below), register pricing-service
and order-service so the rca-agent can map them to their GitHub repos:

```bash
python add_service_map.py
# → registers banking-app, pricing-service, order-service in service_repo_map
```

To register a custom service:

```bash
python add_service_map.py \
  --service my-service \
  --org my-github-org \
  --repo my-service-repo \
  --language Java
```

### Teardown

```bash
docker compose down          # stop containers, keep volumes
docker compose down -v       # stop containers AND delete log volumes
```

---

## Manual Setup (without Docker)

### Prerequisites

| Tool | Version | Install |
|---|---|---|
| Python | ≥ 3.11 | python.org |
| MySQL | 8.0+ | dev.mysql.com or XAMPP/WAMP/Homebrew |
| Git | any | git-scm.com |

You need three API keys:
- `ANTHROPIC_API_KEY` — from console.anthropic.com
- `GITHUB_PAT` — GitHub → Settings → Developer settings → Personal access tokens (needs `repo` scope, read-only)
- `GEMINI_API_KEY` — from aistudio.google.com (free tier works)

---

### Step 0 — Install and Start MySQL (Ubuntu / WSL)

If you don't already have a running MySQL server, install one:

```bash
sudo apt update
sudo apt install -y mysql-server
```

Start the service. On a standard Ubuntu install:

```bash
sudo service mysql start
# or, on systems using systemd:
# sudo systemctl start mysql
```

Set a root password (the default install leaves root with auth_socket and no password):

```bash
sudo mysql_secure_installation
```

Accept the defaults; the important step is setting a root password you'll remember — you'll plug it into `DATABASE_URL` later.

Verify the server is up and you can connect:

```bash
mysql -u root -p -e "SELECT VERSION();"
# → 8.0.x
```

> If you see `ERROR 1698 (28000): Access denied for user 'root'@'localhost'`, your root account is still using `auth_socket`. Run `sudo mysql` then `ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY 'your-password'; FLUSH PRIVILEGES;` to switch it to password auth.

**macOS:** `brew install mysql && brew services start mysql`.
**Windows:** install the MySQL Installer from dev.mysql.com, or use XAMPP/WAMP.

---

### Step 1 — Create the MySQL Database

Open MySQL shell (or MySQL Workbench) and run:

```sql
CREATE DATABASE rca_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'rca'@'localhost' IDENTIFIED BY 'rca';
GRANT ALL PRIVILEGES ON rca_db.* TO 'rca'@'localhost';
FLUSH PRIVILEGES;
```

Or use root directly (simpler for local dev):
```sql
CREATE DATABASE rca_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

---

### Step 2 — Set Up the RCA Agent

```bash
cd banking-app-master/rca-agent

# Copy and fill in environment variables
cp .env.example .env
```

Edit `.env`:
```
ANTHROPIC_API_KEY=sk-ant-YOUR_KEY_HERE
GITHUB_PAT=ghp_YOUR_TOKEN_HERE
GITHUB_ORG=oscorpAI
DATABASE_URL=mysql+pymysql://root:YOUR_MYSQL_PASSWORD@localhost:3306/rca_db
MODEL=claude-sonnet-4-6
MAX_REACT_ITERATIONS=20
OBSERVABILITY_ADAPTER=local
CICD_ADAPTER=mock
```

Install dependencies and run migrations:

```bash
pip install -e ".[test]"

# Create all tables in rca_db
alembic upgrade head
```

Start the RCA Agent API:

```bash
uvicorn app.main:app --reload --port 8000
```

Verify it's running:
```bash
curl http://localhost:8000/health
# → {"status":"ok","model":"claude-sonnet-4-6",...}
```

---

### Step 3 — Seed Demo Data

```bash
# From banking-app-master/demo-repos/
cd ../demo-repos
python demo_seed_data.py --db-url "mysql+pymysql://root:YOUR_PASSWORD@localhost:3306/rca_db"
```

This will:
- Insert `payment-service` and `order-service` into `service_repo_map`
- Insert 3 realistic error logs into `error_logs`
- Write `seeded_ids.json` for the demo UI

---

### Step 4 — Trigger an RCA

**Option A — Browser (recommended):**
Open http://localhost:8000/demo

**Option B — curl:**
```bash
# Get the seeded error log IDs
cat demo-repos/seeded_ids.json

# Trigger RCA (replace UUID with one from seeded_ids.json)
curl -s -X POST http://localhost:8000/rca/run \
  -H "Content-Type: application/json" \
  -d '{"error_log_id": "PASTE-UUID-HERE"}' | python3 -m json.tool
```

**Option C — Streaming (watch Claude think in real time):**
```bash
curl -N -X POST http://localhost:8000/rca/run/stream \
  -H "Content-Type: application/json" \
  -d '{"error_log_id": "PASTE-UUID-HERE"}'
```

**View the HTML report:**
```
http://localhost:8000/rca/PASTE-UUID-HERE/report
```

---

### Step 5 (Optional) — Run the Error Ingestion Agent

This is only needed if you want to watch a real log file for errors.

```bash
cd banking-app-master/error-ingestion-agent

pip install -r requirements.txt

# Create a .env
echo "DATABASE_URL=mysql+pymysql://root:YOUR_PASSWORD@localhost:3306/rca_db" > .env
echo "GEMINI_API_KEY=YOUR_KEY" >> .env
echo "MODE=db" >> .env
echo "LOG_FILE_PATH=./test.log" >> .env
echo "SERVICE_NAME=my-service" >> .env

python main.py
```

In another terminal, write an error to the log file:
```bash
echo "2026-05-16 12:00:00 ERROR MyService - NullPointerException: order is null" >> test.log
```

The agent will detect it, classify it with Gemini, and insert it into `error_incidents`.

---

### Step 6 (Optional) — Run the Eval Suite

```bash
cd banking-app-master/rca-agent

# Requires ANTHROPIC_API_KEY and GITHUB_PAT in .env
pytest evals/ -v

# Run a single case
pytest evals/ -v -k "payment-service"
```

---

### Troubleshooting

### `pymysql.err.OperationalError: Can't connect to MySQL server`
- MySQL isn't running. Start it: `net start mysql` (Windows) or `brew services start mysql` (Mac)
- Check host/port in DATABASE_URL

### `alembic.util.exc.CommandError: Can't locate revision`
- Run `alembic upgrade head` from inside `banking-app-master/rca-agent/`

### `anthropic.AuthenticationError`
- ANTHROPIC_API_KEY is wrong or missing in `.env`

### `github.GithubException.UnknownObjectException: 404`
- The GitHub repo `oscorpAI/<service>` doesn't exist, or GITHUB_PAT lacks read access
- For the eval suite this is fine — GitHub is mocked via `responses` library

### RCA returns `RuntimeError: RCA agent did not call finish_rca`
- Claude hit MAX_REACT_ITERATIONS (20) without concluding
- Try setting `MAX_REACT_ITERATIONS=30` in `.env`
- Check that GitHub PAT has access to the repo so tool calls succeed

### JSON columns return strings instead of dicts
- This is expected behaviour with PyMySQL — all JSON reads in this codebase
  already call `json_loads()` from `rca_agent.db`. If you add new queries that
  read JSON columns, wrap the result with `json_loads(row["column"])`.

### `TypeError: can't compare offset-naive and offset-aware datetimes` from `/rca/run`
- Root cause: MySQL `DATETIME` columns come back from PyMySQL as **naive** Python
  datetimes, but the mock CI/CD fixtures store **tz-aware UTC** datetimes. When
  `RepoResolver` computes `since = occurred_at - timedelta(hours=48)` and the
  mock adapter does `r.deployed_at >= since`, the comparison raises.
- Fix: `LocalDBAdapter.get_error_log` (in
  `rca_agent/adapters/observability/local_db.py`) normalizes `occurred_at` to
  tz-aware UTC at the adapter boundary. Every downstream consumer can then
  assume tz-aware. **If you add a new observability adapter, do the same
  normalization before returning the `ErrorLogEntry`.**

### Demo UI shows `{"detail": "Error log not found"}` after a successful RCA
- The streaming endpoint returns a final `done` event whose payload includes
  *two* UUIDs:
  - `error_log_id` — the row's primary key in `error_logs` (the value you
    passed in the request).
  - `rca_id` — a separate UUID4 generated by Claude inside `finish_rca` to
    identify the report itself.
- The route `GET /rca/{error_log_id}/report` is keyed on `error_log_id`, not
  `rca_id`. If you build the URL with `rca_id`, you'll get a 404 because the
  `SELECT … FROM error_logs WHERE id = …` returns no row.
- Fix: in `app/demo_ui.html`, `showReport()` uses `reportDict.error_log_id` when
  constructing the iframe `src`. Anything you build on top of the API should do
  the same.

---

### Directory Quick Reference

```
rca-agent/                       ← repo root
├── docker-compose.yml           ← One-command local stack (all services + UIs)
├── env.example                  ← Copy to `env`, fill DD_API_KEY + secrets
├── add_service_map.py           ← Seeds service_repo_map in MySQL
│
├── datadog/conf.d/              ← Datadog log collection configs
│   ├── banking-app.d/conf.yaml
│   ├── pricing-service.d/conf.yaml
│   └── order-service.d/conf.yaml
│
├── ui/                          ← Minimal Flask log-viewer (3 instances in compose)
│   ├── app.py
│   ├── Dockerfile
│   └── requirements.txt
│
└── banking-app-master/
    ├── rca-agent/               ← Main AI service (FastAPI + Claude)
    │   ├── .env.example         ← RCA-agent-specific env vars
    │   ├── alembic/             ← Database migrations (run: alembic upgrade head)
    │   ├── app/main.py          ← FastAPI routes (port 8000)
    │   └── rca_agent/           ← Core agent logic
    │       ├── agent.py         ← ReAct loop + 13 tools (multi-service aware)
    │       ├── config.py        ← Settings (reads .env)
    │       ├── db.py            ← PyMySQL sync wrapper
    │       ├── dependency_memory.py  ← Cross-service dependency store (JSON)
    │       ├── github_tools.py  ← GitHub API wrappers + global search
    │       └── repo_resolver.py ← Service → GitHub repo mapping
    │
    ├── pricing-service/         ← Spring Boot 3.2.3, port 8081
    │   └── src/…                ← v2.1.0 — renamed discount→discountRate
    │
    ├── order-service/           ← Spring Boot 3.2.3, port 8082
    │   └── src/…                ← Bug A (NPE) + Bug B (off-by-one)
    │
    ├── error-ingestion-agent/   ← Log watcher / Datadog webhook
    │   └── main.py
    │
    └── demo-repos/
        └── demo_seed_data.py    ← Seeds MySQL with error_logs for demo
```
