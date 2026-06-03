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

You can use MySQL Workbench, TablePlus, DBeaver, or the CLI.

---

## Step 3 — Configure environment variables

```bash
cp env.example .env
```

Open `.env` in the **root** of the repo and fill in your values:

```env
# ── Anthropic (required for RCA agent) ───────────────────────────────────────
ANTHROPIC_API_KEY=sk-ant-...

# ── GitLab (required for code analysis in RCA) ───────────────────────────────
# Create a GitLab Personal Access Token with scopes: read_api + read_repository
GITHUB_PAT=glpat-...
GITHUB_ORG=apollo
GITLAB_URL=http://<your-gitlab-host>

# ── Google Gemini (required for error classification) ────────────────────────
GEMINI_API_KEY=AIza...

# ── Datadog (optional — only needed for Datadog mode) ────────────────────────
DD_API_KEY=...
DD_APP_KEY=...
DD_SITE=us5.datadoghq.com

# ── Database ──────────────────────────────────────────────────────────────────
DATABASE_URL=mysql+pymysql://root:<your-password>@host.docker.internal:3306/rca_db
```

> **`host.docker.internal`** resolves to your host machine from inside Docker containers. On Linux this is mapped automatically via `extra_hosts: host-gateway` in `docker-compose.yml`.

> **GitLab PAT** — This is used by the RCA agent to fetch source files from your self-hosted GitLab. The field is named `GITHUB_PAT` in `.env` for backwards compatibility but accepts a GitLab token (`glpat-...`).

---

## Step 4 — Push service code to GitLab

The RCA agent reads source files from GitLab when analysing bugs. Each service must be pushed to its own repo under the `apollo` group:

```powershell
# banking-service
cd banking-app/banking-service
git init
git remote add origin http://<your-gitlab-host>/apollo/banking-app.git
git add . && git commit -m "initial"
git push -u origin main

# pricing-service
cd ../pricing-service
git init
git remote add origin http://<your-gitlab-host>/apollo/pricing-service.git
git add . && git commit -m "initial"
git push -u origin main

# order-service
cd ../order-service
git init
git remote add origin http://<your-gitlab-host>/apollo/order-service.git
git add . && git commit -m "initial"
git push -u origin main
```

---

## Step 5 — Register services in the database

Reads `apollo-agent/projects.yaml` and writes the service → GitLab repo mapping to MySQL:

```bash
python apollo-agent/add_service_map.py
```

---

## Step 6 — Start the stack

```bash
docker compose up --build
```

First build takes 3–5 minutes (Maven + Node downloads). Subsequent builds are fast.

**What starts:**

| Service | URL | Description |
|---|---|---|
| banking-app | http://localhost:8080 | Spring Boot banking app |
| pricing-service | http://localhost:8081 | Spring Boot pricing service |
| order-service | http://localhost:8082 | Spring Boot order service |
| **Apollo UI** | **http://localhost:8000** | Main RCA dashboard |
| Error trigger UI | http://localhost:5000 | Trigger errors + live log stream |
| ingestion-agent | (internal) | Log watcher + Gemini classification pipeline |
| dd-agent | (internal) | Ships logs to Datadog (optional) |

---

## Step 7 — Open Apollo

Go to **http://localhost:8000**

Click **Enter Dashboard** on the animated intro page.

---

## Step 8 — Trigger an error

Open **http://localhost:5000** — the error trigger UI. It shows:
- **Live log stream** (left pane) — errors highlighted in red with stack traces
- **Inject Error into Business Layer** (right sidebar) — grouped by service
- **Run RCA Analysis** — paste an `error_log_id` to trigger RCA directly

Click any scenario button. Within a few seconds:
- The full stack trace appears in the live log stream
- The error shows up in Apollo's **Log Explorer** tab with Gemini risk badge + suggestions

### Available scenarios

**Banking Service** (errors originate in `AccountService`):
| Button | What fires | Exception |
|---|---|---|
| NPE — AccountService | `getAccountEnrichment(1)` — cache miss | `NullPointerException` |
| InsufficientFunds | `withdraw(1, $9,999,999.99)` | `InsufficientFundsException` |
| DB Pool Exhausted | `processBatchStatement(...)` | `RuntimeException` |
| Account Not Found | `getAccountById(999999999)` | `AccountNotFoundException` |

**Pricing Service** (errors originate in `PricingService`):
| Button | What fires | Exception |
|---|---|---|
| NPE — PricingService | `computeDynamicPricing(null, ...)` | `NullPointerException` |
| Invalid SKU | `calculatePrice(SKU-CHAOS-999)` | `InvalidSkuException` |
| Divide by Zero | `computeDiscountedVolume("SKU-001", 1)` | `ArithmeticException` |

**Order Service** (errors originate in `OrderService`):
| Button | What fires | Exception |
|---|---|---|
| Cross-service NPE | `createOrder(...)` — `PricingResponseDto.getDiscount()` is null (field renamed in v2.1.0) | `NullPointerException` |
| Off-by-one Qty | `createOrder(qty=1)` — `resolveQuantity(1)→0` | `IllegalArgumentException` |

> All exceptions are caught by `GlobalExceptionHandler` which logs `log.error(..., ex)` — full stack trace written to the shared log file.

---

## Running an RCA

### From the RCA Dashboard tab

1. Go to the **RCA** tab in Apollo
2. Click a stat card to filter (e.g. `Pending`)
3. Click **▶ Run RCA** on an incident
4. The RCA stream panel opens automatically

### From the Log Explorer tab

1. Find an incident with status `pending`
2. Click **Run RCA →** on its card

### Watching the stream

- **Phase tracker**: Initialize → Repository → Analysis → Complete
- **Iteration groups**: each reasoning step + its tool calls grouped under `Iteration N`
- **Live stats**: iteration count / 20, elapsed time, progress bar
- **Filter bar**: All / Reasoning / Tools / System with counts

When analysis completes:
- A green **Root Cause Identified!** overlay appears for 3 seconds
- A **Reports** badge appears on the sidebar
- Click **📊 Report** to open the full HTML report

> **Reconnecting**: closing and re-opening the stream panel for the same incident reconnects to the running agent — no duplicate agent is started and no state is lost.

---

## Viewing Reports

Go to the **Reports** tab to browse all completed RCAs:
- **Search** by service name or error type
- **Filter** by confidence (High / Medium / Low)
- Click any card to open the **inline detail panel** with root cause, timeline, solutions, evidence

### Downloading as PDF
1. **📥 PDF** — downloads the report as `.html`, open in browser and print to PDF
2. **🔗 Open** — opens in new tab with a floating **🖨 Print / Save PDF** button

---

## Token Consumption Tab

Shows cost and token usage broken down two ways:
- **Per-incident**: each error_log_id gets its own card showing total tokens, cost, call count, and expandable per-call table
- **Per-model**: breakdown across Claude model versions
- **Hero stats**: total input/output/cache tokens and total cost

---

## Switching to Datadog Mode

> Requires `DD_API_KEY` and `DD_APP_KEY` in `.env` or Settings.

1. Click **Stop Monitoring** in the Apollo header
2. The **Local DB ↔ Datadog** toggle becomes active — click **Datadog**
3. Click **Start Monitoring**

The ingestion agent pulls errors from Datadog Logs API, resuming from the exact timestamp when you clicked Stop — no gap, no backlog flood. Switch back the same way.

---

## Runtime Settings

Update credentials and settings at runtime without restarting:

1. Go to **Settings** in Apollo
2. Update any field (API keys, model, GitLab PAT, GitLab URL, max iterations)
3. Click **⚡ Test Credentials** to verify
4. Click **Save Changes** — takes effect on the next RCA run

Settings are stored in `/app/apollo_settings.json` inside the rca-agent container with a 5-second TTL cache.

---

## Key Environment Variables (docker-compose.yml)

The `rca-agent` service uses:

```yaml
environment:
  DATABASE_URL:         mysql+pymysql://root:varun@host.docker.internal:3306/rca_db
  OBSERVABILITY_ADAPTER: "local"
  CICD_ADAPTER:         "mock"
  GITHUB_ORG:           "apollo"
  GITLAB_URL:           "http://<your-gitlab-host>"
  MODEL:                "claude-haiku-4-5-20251001"
  MAX_REACT_ITERATIONS: "20"
```

To change model or iterations permanently:
```bash
docker compose build rca-agent && docker compose up -d rca-agent
```

Or change at runtime via **Settings** (no restart needed).

---

## Common Issues

**`Connection refused` to MySQL from containers**
- MySQL must be running on the host (`mysql -u root -p` works)
- `DATABASE_URL` must use `host.docker.internal` (not `localhost`)
- Check `bind-address` in `my.cnf` allows connections from `127.0.0.1`

**`rca-agent` exits immediately**
```bash
docker compose logs rca-agent
```
Usually a missing `ANTHROPIC_API_KEY` in `.env`.

**Errors not appearing in Apollo**
```bash
docker compose logs ingestion-agent
```
- The `app-logs` Docker volume must be shared — all Java services write to `/var/log/banking-app/app.log`
- Trigger an error from http://localhost:5000 and watch the ingestion-agent logs

**RCA agent says "GitLab token is invalid"**
- Check `GITHUB_PAT` in `.env` — must be a GitLab PAT (`glpat-...`) not a GitHub token
- Token needs `read_api` + `read_repository` scopes
- Verify the repo exists: `http://<gitlab-host>/apollo/banking-app`

**`rca_reports` table is empty**
- Ensure the container was rebuilt after the `_persist()` fix: `docker compose build rca-agent && docker compose up -d rca-agent`
- Check: `docker compose logs rca-agent | grep "rca_reports"`

**"Monthly usage limit reached" from Anthropic**
Go to [console.anthropic.com](https://console.anthropic.com) → Settings → Limits → raise the monthly spend cap.

**RCA stops early or shows "Analysis Failed"**
1. Check `MAX_REACT_ITERATIONS` — must be `"20"`
2. Verify GitLab PAT has correct scopes
3. Check: `docker compose logs rca-agent --tail=50`

**localhost:5000 shows "Waiting for logs…"**
- Trigger an error first — the log file only exists after a service writes to it
- Check: `docker compose logs ui`

---

## Rebuilding After Code Changes

```bash
# Python code change (rca-agent or ingestion-agent) — must rebuild, not just restart
docker compose build rca-agent && docker compose up -d rca-agent
docker compose build ingestion-agent && docker compose up -d ingestion-agent

# Java code change — rebuild the affected service
docker compose build banking-app && docker compose up -d banking-app

# Trigger UI change
docker compose build ui && docker compose up -d ui

# Rebuild everything
docker compose up --build
```

> `docker compose restart` does NOT pick up Python code changes — the source is baked into the image at build time. Always use `build` after editing `.py` files.

---

## Stopping the Stack

```bash
docker compose down
```

Data in MySQL persists (it's on the host). The `app-logs` Docker volume is preserved between restarts.

---

## Adding a New Service to Monitor

1. Add an entry to `apollo-agent/projects.yaml`:
   ```yaml
   - id: my-service
     github_org: apollo
     github_repo: my-service
     default_branch: main
     language: java        # java | python | nodejs | go
     environment: dev
     observability_mode: db
     log_path: /var/log/banking-app/app.log
   ```
2. Push the service source to `apollo/my-service` on GitLab
3. Run `python apollo-agent/add_service_map.py`
4. Mount the service log in `docker-compose.yml` under `ingestion-agent` volumes
5. Run `docker compose up --build`

No Python or Java code changes required.

---

## Port Reference

| Port | Service | URL |
|---|---|---|
| 8000 | rca-agent (Apollo UI + API) | http://localhost:8000 |
| 5000 | error trigger UI (Flask) | http://localhost:5000 |
| 8080 | banking-app | http://localhost:8080 |
| 8081 | pricing-service | http://localhost:8081 |
| 8082 | order-service | http://localhost:8082 |
| 3306 | MySQL | host machine only |
