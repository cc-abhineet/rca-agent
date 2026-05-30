# How to Run Apollo RCA Platform Locally

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Docker Desktop | 4.x+ | Must be running |
| Docker Compose | v2.x | Bundled with Docker Desktop |
| MySQL | 8.x | Running on host (not in Docker) |
| Git | any | To clone the repo |

---

## Step 1 — Clone the repo

```bash
git clone <repo-url>
cd rca-agent
```

---

## Step 2 — Create the MySQL database

Connect to your local MySQL instance and run:

```sql
CREATE DATABASE rca_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

You can use any MySQL client (MySQL Workbench, TablePlus, DBeaver, or the CLI).

---

## Step 3 — Configure environment variables

```bash
cp env.example .env
```

Open `.env` and fill in your values:

```env
# ── Anthropic (required for RCA) ─────────────────────────────────────────────
ANTHROPIC_API_KEY=sk-ant-...

# ── GitHub (required for repo analysis in RCA) ───────────────────────────────
GITHUB_PAT=ghp_...

# ── Google Gemini (required for error classification) ────────────────────────
GEMINI_API_KEY=AIza...

# ── Datadog (optional — only needed for Datadog mode) ────────────────────────
DD_API_KEY=...
DD_APP_KEY=...
DD_SITE=us5.datadoghq.com

# ── Database ──────────────────────────────────────────────────────────────────
DATABASE_URL=mysql+pymysql://root:<your-password>@host.docker.internal:3306/rca_db
```

> **`host.docker.internal`** resolves to your host machine from inside Docker containers. On Linux, this is mapped automatically via `extra_hosts: host-gateway` in `docker-compose.yml`.

---

## Step 4 — Register services in the database

This writes the GitHub repo mappings so the RCA agent knows which org/repo to investigate for each service:

```bash
python add_service_map.py
```

---

## Step 5 — Start the stack

```bash
docker compose up --build
```

First build takes 3–5 minutes (downloads Maven/Node dependencies). Subsequent builds are fast.

**What starts:**

| Service | URL | Description |
|---|---|---|
| banking-app | http://localhost:8080 | Spring Boot banking app |
| pricing-service | http://localhost:8081 | Spring Boot pricing service |
| order-service | http://localhost:8082 | Spring Boot order service |
| **Apollo UI** | **http://localhost:8000** | Main RCA dashboard |
| Demo chaos UI | http://localhost:5000 | Trigger errors manually |
| ingestion-agent | (internal :8001) | Log watcher + Gemini pipeline |
| dd-agent | (internal) | Ships logs to Datadog (optional) |

---

## Step 6 — Open Apollo

Go to **http://localhost:8000**

You'll land on the animated intro page. Click **Enter Dashboard** to see the main UI.

---

## Step 7 — Trigger some errors

Open **http://localhost:5000** (the demo chaos UI) and click any of the error trigger buttons — NullPointerException, DB connection failure, etc.

Within a few seconds you'll see the errors appear in Apollo's **Log Explorer** tab, already classified by Gemini with risk level and suggestions.

---

## Running an RCA

1. In the Log Explorer, find an incident card with status `pending`
2. Click **Run RCA →**
3. Watch the live stream in the panel that opens — you'll see Claude reasoning through the error, calling GitHub tools, and building the report
4. When done, click **View Full Report** for the HTML RCA report

---

## Switching to Datadog Mode

> Requires `DD_API_KEY` and `DD_APP_KEY` to be set in `.env` or Settings.

1. In the Apollo header, click **Stop Monitoring**
2. The **Local DB ↔ Datadog** toggle becomes active — click **Datadog**
3. Click **Start Monitoring**

The ingestion agent will now pull errors from the Datadog Logs API instead of the local log file. It resumes from the exact timestamp when you clicked Stop — no gap, no backlog flood.

To switch back, repeat the same Stop → Local DB → Start sequence.

---

## Runtime Settings

You can update all credentials and settings at runtime without restarting containers:

1. Go to **Apollo → Settings**
2. Update any field (API keys, model, max iterations, etc.)
3. Click **⚡ Test Credentials** to verify before saving
4. Click **Save Changes** — takes effect on the next RCA run immediately

---

## Common Issues

**`Connection refused` to MySQL from containers**

Containers reach host MySQL via `host.docker.internal`. Make sure:
- MySQL is running on the host (`mysql -u root -p` works)
- The `DATABASE_URL` in `.env` uses `host.docker.internal` (not `localhost`)
- MySQL allows connections from `127.0.0.1` (check `bind-address` in `my.cnf`)

**`rca-agent` exits immediately**

Check logs:
```bash
docker compose logs rca-agent
```
Usually a missing `ANTHROPIC_API_KEY` in `.env`.

**Errors not appearing in Apollo**

- Check ingestion-agent is running: `docker compose logs ingestion-agent`
- The log volume must be shared — all Java services write to `/var/log/banking-app/app.log`
- Trigger an error from the demo UI at http://localhost:5000 to confirm the pipeline

**"Monthly usage limit reached" from Anthropic**

Go to [console.anthropic.com](https://console.anthropic.com) → Settings → Limits → raise the monthly spend cap. The key itself is valid — you've just hit a self-imposed ceiling.

---

## Rebuilding after code changes

```bash
# Rebuild and restart a single service
docker compose build rca-agent && docker compose up -d rca-agent

# Rebuild everything
docker compose up --build
```

---

## Stopping the stack

```bash
docker compose down
```

Data in MySQL persists (it's on the host). The Docker log volume (`app-logs`) is cleared on next `up --build`.

---

## Adding a New Service to Monitor

1. Add an entry to `banking-app-master/projects.yaml` with `id`, `github_org`, `github_repo`, `log_path`
2. Run `python add_service_map.py`
3. Add the log volume mount in `docker-compose.yml` under `ingestion-agent`
4. Run `docker compose up --build`

No Python or Java code changes required.
