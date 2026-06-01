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
| Demo chaos UI | http://localhost:5000 | Trigger errors + live log stream |
| ingestion-agent | (internal :8001) | Log watcher + Gemini classification pipeline |
| dd-agent | (internal) | Ships logs to Datadog (optional) |

---

## Step 6 — Open Apollo

Go to **http://localhost:8000**

You'll land on the animated intro page. Click **Enter Dashboard** to see the main UI.

---

## Step 7 — Trigger some errors

Open **http://localhost:5000** — the demo chaos UI. It shows:
- **Live log stream** (left pane) with filter buttons (All / Errors / Warnings / Clear)
- **Chaos Scenarios** (right sidebar) — grouped by service with colored buttons
- **Run RCA Analysis** — paste an `error_log_id` UUID to trigger RCA directly
- **Quick Links** — RCA Dashboard, Error Logs API, Datadog Logs

Click any chaos button (e.g. `💥 NullPointerException` under Banking App). Within a few seconds:
- The error appears in the live log stream on the left
- It shows up in Apollo's **Log Explorer** tab, classified by Gemini with risk level and suggestions

---

## Running an RCA

### From the RCA Dashboard tab

1. Go to the **RCA** tab in Apollo
2. Click the stat cards to filter by status (Pending / Running / Completed / Failed)
3. Find an incident with status `Pending` and click **▶ Run RCA**
4. The RCA stream panel opens automatically

### From the Log Explorer tab

1. Find an incident card with status `pending`
2. Click **Run RCA →** on that card

### Watching the stream

The RCA stream panel shows:
- **Phase tracker**: Initialize → Repository → Analysis → Complete
- **Iteration groups**: each reasoning step + its tool calls grouped under `Iteration N`
- **Live stats**: iteration count / 20, total events, elapsed time, progress bar
- **Filter bar**: All / Reasoning / Tools / System with counts; Expand/Collapse All
- **Footer buttons**: ■ Stop (red), ↓ Bottom (cyan), Close (gray → red on hover)

When analysis finishes:
- A **green celebration overlay** appears for 3 seconds ("Root Cause Identified!")
- A **Reports** badge appears on the sidebar nav
- Click **📊 Report** to open the full HTML report in a new tab

If you click **■ Stop**, a **red stop overlay** appears confirming the cancellation.

> **Re-opening a running stream**: closing the panel and re-opening it for the same incident reconnects to the ongoing agent — no new agent is started, no state is lost. Previously collected events are restored from the session cache.

---

## Viewing Reports

Go to the **Reports** tab in Apollo to browse all completed RCAs:

- **Search** by service name or error type
- **Filter** by confidence level (High / Medium / Low)
- **Sort** by newest or oldest
- Click any card to open the **inline detail panel** showing:
  - Incident summary, root cause, code reference
  - Timeline, suggested solutions, prevention recommendations
  - Analysis metadata (model, iterations, files fetched)

### Downloading as PDF

Two options:
1. **📥 PDF** button on any report card — downloads the report as an `.html` file you can open and print to PDF from your browser
2. **🔗 Open** button — opens the report in a new tab, which has a floating **🖨 Print / Save PDF** button in the bottom-right corner

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
2. Update any field (API keys, model, max iterations, GitHub org, etc.)
3. Click **⚡ Test Credentials** to verify before saving
4. Click **Save Changes** — takes effect on the next RCA run immediately

All settings are stored in `/app/apollo_settings.json` inside the rca-agent container and take effect with a 5-second cache TTL. **Docker env vars in `docker-compose.yml` take precedence over Python defaults** but are overridden by the Settings UI.

---

## Docker Compose Environment Variables

The `rca-agent` service in `docker-compose.yml` has these key environment variables:

```yaml
environment:
  DATABASE_URL: mysql+pymysql://root:varun@host.docker.internal:3306/rca_db
  OBSERVABILITY_ADAPTER: "local"
  CICD_ADAPTER: "mock"
  GITHUB_ORG: "oscorpAI"
  MODEL: "claude-haiku-4-5-20251001"
  MAX_REACT_ITERATIONS: "20"      # max Claude iterations per RCA run
```

To change the model or iteration count permanently, edit `docker-compose.yml` and run:
```bash
docker compose build rca-agent && docker compose up -d rca-agent
```

Or change them at runtime via **Settings** in the Apollo UI (no restart needed).

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

**RCA stops early or shows "Analysis Failed"**

1. Check `MAX_REACT_ITERATIONS` in `docker-compose.yml` — must be `"20"` not `"8"`
2. Verify your GitHub PAT has `repo:read` scope
3. Check: `docker compose logs rca-agent --tail=50` for specific errors

**localhost:5000 shows "Waiting for logs…"**

- The log file may not have any entries yet — trigger an error from the chaos buttons
- Check: `docker compose logs ui` to confirm the ui container is running
- Ensure the `app-logs` Docker volume is mounted: `docker exec rca-agent-ui-1 sh -c "ls /var/log/banking-app/"`

---

## Rebuilding after code changes

```bash
# Rebuild and restart a single service (fastest)
docker compose build rca-agent && docker compose up -d rca-agent

# Rebuild the chaos-trigger UI (port 5000)
docker compose build ui && docker compose up -d ui

# Rebuild everything
docker compose up --build
```

---

## Stopping the stack

```bash
docker compose down
```

Data in MySQL persists (it's on the host). The Docker log volume (`app-logs`) is preserved between restarts.

---

## Adding a New Service to Monitor

1. Add an entry to `banking-app-master/projects.yaml` with `id`, `github_org`, `github_repo`, `log_path`
2. Run `python add_service_map.py`
3. Add the log volume mount in `docker-compose.yml` under `ingestion-agent`
4. Run `docker compose up --build`

No Python or Java code changes required.

---

## Port Reference

| Port | Service | URL |
|---|---|---|
| 8000 | rca-agent (Apollo UI + API) | http://localhost:8000 |
| 5000 | demo chaos UI (Flask) | http://localhost:5000 |
| 8080 | banking-app | http://localhost:8080 |
| 8081 | pricing-service | http://localhost:8081 |
| 8082 | order-service | http://localhost:8082 |
| 8001 | ingestion-agent control API | internal only |
| 3306 | MySQL | host machine |
