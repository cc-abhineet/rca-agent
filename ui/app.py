"""
ui/app.py — Combined multi-service error-trigger + live log dashboard.

Log stream uses polling (/api/logs?since=N) every 2 s — simpler and more
reliable than SSE with Flask's dev server.

Environment variables:
  LOG_FILE_PATH     Unified log file  (default: /var/log/banking-app/app.log)
  BANKING_APP_HOST  Docker hostname for banking-app   (default: localhost)
  PRICING_HOST      Docker hostname for pricing-service (default: localhost)
  ORDER_HOST        Docker hostname for order-service  (default: localhost)
  RCA_AGENT_URL     rca-agent base URL  (default: http://localhost:8000)
  DD_SITE           Datadog site        (default: datadoghq.com)
"""

import os
import re
import threading
import time

import requests
from flask import Flask, jsonify, render_template_string, request as flask_request

app = Flask(__name__)

# ── Config ────────────────────────────────────────────────────────────────────

LOG_FILE_PATH    = os.getenv("LOG_FILE_PATH",    "/var/log/banking-app/app.log")
RCA_AGENT_URL    = os.getenv("RCA_AGENT_URL",    "http://localhost:8000")
BANKING_APP_HOST = os.getenv("BANKING_APP_HOST", "localhost")
PRICING_HOST     = os.getenv("PRICING_HOST",     "localhost")
ORDER_HOST       = os.getenv("ORDER_HOST",       "localhost")
DD_SITE          = os.getenv("DD_SITE",          "datadoghq.com")

# ── Chaos catalogue ───────────────────────────────────────────────────────────

CHAOS_GROUPS = [
    {
        "id": "banking-app", "label": "Banking App", "color": "#7c3aed",
        "scenarios": [
            {"icon": "💥", "label": "NullPointerException",
             "url": f"http://{BANKING_APP_HOST}:8080/chaos/null-pointer"},
            {"icon": "💸", "label": "InsufficientFunds",
             "url": f"http://{BANKING_APP_HOST}:8080/chaos/insufficient-funds"},
            {"icon": "🔗", "label": "DB Connection Error",
             "url": f"http://{BANKING_APP_HOST}:8080/chaos/db-connection"},
            {"icon": "⏱",  "label": "Request Timeout",
             "url": f"http://{BANKING_APP_HOST}:8080/chaos/timeout"},
        ],
    },
    {
        "id": "pricing-service", "label": "Pricing Service", "color": "#0891b2",
        "scenarios": [
            {"icon": "💥", "label": "NPE in getPricing",
             "url": f"http://{PRICING_HOST}:8081/chaos/null-pointer"},
            {"icon": "📦", "label": "Invalid SKU",
             "url": f"http://{PRICING_HOST}:8081/chaos/invalid-sku"},
            {"icon": "🔢", "label": "Arithmetic Error",
             "url": f"http://{PRICING_HOST}:8081/chaos/arithmetic"},
        ],
    },
    {
        "id": "order-service", "label": "Order Service", "color": "#be123c",
        "scenarios": [
            {"icon": "💥", "label": "Cross-service NPE",
             "url": f"http://{ORDER_HOST}:8082/chaos/cross-service-npe"},
            {"icon": "🔢", "label": "Qty Off-by-one",
             "url": f"http://{ORDER_HOST}:8082/chaos/quantity-off-by-one"},
        ],
    },
]

# ── Log buffer ────────────────────────────────────────────────────────────────

_log_lines: list[dict] = []          # [{level, svc, text}, ...]
_log_lock  = threading.Lock()
MAX_BUFFER = 600

_SVC_RE = [
    re.compile(r'dd\.service=([^\s,\]"]+)'),
    re.compile(r'"service"\s*:\s*"([^"]+)"'),
]
_SVC_COLOR = {
    "banking-app":     "#a78bfa",
    "pricing-service": "#22d3ee",
    "order-service":   "#fb7185",
}


def _svc(line: str) -> str:
    for pat in _SVC_RE:
        m = pat.search(line)
        if m:
            return m.group(1)
    u = line.upper()
    if "PRICING" in u:  return "pricing-service"
    if "ORDER"   in u:  return "order-service"
    return "banking-app"


def _level(line: str) -> str:
    u = line.upper()
    if " ERROR " in u or "ERROR]" in u or "EXCEPTION" in u: return "error"
    if " WARN "  in u or "WARN]"  in u:                     return "warn"
    if line.startswith(("\t", "    at ")):                   return "trace"
    return "info"


def _push(line: str) -> None:
    entry = {"level": _level(line), "svc": _svc(line), "text": line}
    with _log_lock:
        _log_lines.append(entry)
        if len(_log_lines) > MAX_BUFFER:
            _log_lines.pop(0)


def _tail() -> None:
    """Tail LOG_FILE_PATH forever; wait for file to appear; restart on truncation."""
    while not os.path.exists(LOG_FILE_PATH):
        _push(f"[ui] waiting for log file: {LOG_FILE_PATH}")
        time.sleep(3)

    while True:
        try:
            with open(LOG_FILE_PATH, "r", errors="replace") as fh:
                # Pre-load last 50 KB of history
                fh.seek(0, 2)
                size = fh.tell()
                fh.seek(max(0, size - 51200))
                if size > 51200:
                    fh.readline()           # skip potentially partial first line
                for raw in fh.read().splitlines():
                    raw = raw.rstrip()
                    if raw:
                        _push(raw)

                # Tail new lines
                while True:
                    raw = fh.readline()
                    if not raw:
                        try:
                            if os.path.getsize(LOG_FILE_PATH) < fh.tell():
                                break       # file truncated / rotated — reopen
                        except OSError:
                            break
                        time.sleep(0.25)
                        continue
                    raw = raw.rstrip()
                    if raw:
                        _push(raw)
        except OSError:
            time.sleep(2)


threading.Thread(target=_tail, daemon=True, name="log-tailer").start()

# ── HTML ──────────────────────────────────────────────────────────────────────

_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Error Trigger Dashboard</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0d0f1a;--surface:#151929;--border:#1e2440;
  --text:#cbd5e1;--muted:#64748b;--purple:#7c3aed;
}
body{font-family:'Segoe UI',system-ui,sans-serif;background:var(--bg);
     color:var(--text);height:100vh;display:flex;flex-direction:column;overflow:hidden}

/* header */
header{display:flex;align-items:center;gap:12px;padding:9px 16px;
       background:var(--surface);border-bottom:1px solid var(--border);flex-shrink:0;flex-wrap:wrap}
header h1{font-size:.95rem;font-weight:700;color:#e2e8f0;white-space:nowrap}
.badge{display:inline-flex;align-items:center;gap:5px;border-radius:5px;
       padding:3px 9px;font-size:.7rem;font-weight:700}
.dot{width:8px;height:8px;border-radius:50%;background:#374151;display:inline-block;flex-shrink:0}
.dot.live{background:#22c55e;box-shadow:0 0 6px #22c55e88}
.hdr-right{margin-left:auto;display:flex;align-items:center;gap:8px}
.err-chip{font-size:.75rem;color:#f87171;font-weight:700}
.ext-link{font-size:.73rem;color:#818cf8;text-decoration:none;padding:4px 10px;
          border:1px solid #3730a3;border-radius:5px;white-space:nowrap}
.ext-link:hover{background:#3730a3;color:#e0e7ff}

/* layout */
main{display:flex;flex:1;overflow:hidden}

/* log pane */
.log-pane{flex:1;overflow-y:auto;padding:8px 12px;
          font-family:'Cascadia Code','Fira Code',monospace;font-size:.74rem;
          line-height:1.55;border-right:1px solid var(--border)}
.log-line{display:flex;align-items:baseline;gap:6px;padding:1px 0 1px 4px;
          border-left:2px solid transparent}
.log-line.error{border-color:#ef4444;background:rgba(239,68,68,.05)}
.log-line.warn {border-color:#f59e0b;background:rgba(245,158,11,.03)}
.log-line.trace{color:#374151}
.log-line.info {color:#94a3b8}
.log-line.error .ll-text{color:#fca5a5}
.log-line.warn  .ll-text{color:#fcd34d}
.ll-svc{flex-shrink:0;font-size:.65rem;font-weight:700;padding:1px 5px;border-radius:3px}
.ll-text{word-break:break-all}
.log-placeholder{height:100%;display:flex;align-items:center;justify-content:center;
                 color:var(--muted);flex-direction:column;gap:10px;font-size:.85rem}
.spinner{width:20px;height:20px;border:2px solid var(--border);
         border-top-color:var(--purple);border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

/* sidebar */
.sidebar{width:330px;flex-shrink:0;overflow-y:auto;background:var(--surface);
         display:flex;flex-direction:column}
.panel{border-bottom:1px solid var(--border);padding:12px 14px}
.ptitle{font-size:.68rem;font-weight:700;text-transform:uppercase;
        letter-spacing:.08em;color:var(--muted);margin-bottom:8px}

/* chaos */
.grp-hdr{font-size:.7rem;font-weight:700;color:#fff;border-radius:4px;
         padding:2px 8px;display:inline-block;margin-bottom:6px}
.chaos-btns{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px}
.cbtn{flex:1 1 calc(50% - 2px);padding:6px 7px;border:1px solid #2d3f58;border-radius:5px;
      background:#1a2235;color:#cbd5e1;font-size:.7rem;font-weight:600;cursor:pointer;
      text-align:left;transition:background .12s,transform .1s}
.cbtn:hover{background:#223050;transform:translateY(-1px)}
.cbtn:active{transform:none}
#chaos-msg{font-size:.72rem;min-height:16px;margin-top:4px;word-break:break-word}
#chaos-msg.ok  {color:#4ade80}
#chaos-msg.err {color:#f87171}
#chaos-msg.inf {color:#94a3b8}

/* rca */
input{width:100%;background:var(--bg);border:1px solid var(--border);border-radius:5px;
      color:var(--text);font-size:.76rem;padding:7px 9px;margin-bottom:6px;font-family:monospace}
input:focus{outline:none;border-color:var(--purple)}
.btn-rca{width:100%;padding:8px;border:none;border-radius:5px;background:var(--purple);
         color:#fff;font-size:.82rem;font-weight:700;cursor:pointer}
.btn-rca:hover{opacity:.88}
#rca-out{margin-top:6px;background:var(--bg);border:1px solid var(--border);border-radius:5px;
         padding:7px;font-size:.7rem;color:var(--muted);min-height:40px;max-height:180px;
         overflow-y:auto;white-space:pre-wrap;font-family:monospace;word-break:break-word}

::-webkit-scrollbar{width:4px}
::-webkit-scrollbar-thumb{background:#1e2440;border-radius:2px}
</style>
</head>
<body>
<header>
  <span id="dot" class="dot"></span>
  <h1>⚡ Error Trigger Dashboard</h1>
  {% for g in groups %}
  <span class="badge" style="background:{{g.color}}22;color:{{g.color}}">
    {{g.label}}
  </span>
  {% endfor %}
  <div class="hdr-right">
    <span class="err-chip">Errors: <span id="errcnt">0</span></span>
    <a class="ext-link" href="{{rca_url}}/demo" target="_blank">RCA Dashboard ↗</a>
  </div>
</header>

<main>
  <div class="log-pane" id="pane">
    <div class="log-placeholder" id="placeholder">
      <div class="spinner"></div>
      <span>Waiting for logs…</span>
    </div>
  </div>

  <div class="sidebar">

    <div class="panel">
      <div class="ptitle">Chaos Scenarios</div>
      {% for g in groups %}
      <span class="grp-hdr" style="background:{{g.color}}">{{g.label}}</span>
      <div class="chaos-btns">
        {% for s in g.scenarios %}
        <button class="cbtn" onclick="chaos('{{s.url}}')">{{s.icon}} {{s.label}}</button>
        {% endfor %}
      </div>
      {% endfor %}
      <div id="chaos-msg" class="inf">Click a scenario to trigger an error.</div>
    </div>

    <div class="panel">
      <div class="ptitle">Run RCA</div>
      <input id="eid" placeholder="error_log_id UUID from DB">
      <button class="btn-rca" onclick="runRca()">▶ Run RCA Analysis</button>
      <div id="rca-out">Paste an error_log_id and click Run RCA.</div>
    </div>

    <div class="panel">
      <div class="ptitle">Links</div>
      <div style="display:flex;flex-direction:column;gap:6px">
        <a class="ext-link" style="text-align:center"
           href="{{rca_url}}/demo" target="_blank">📊 RCA Dashboard (port 8000)</a>
        <a class="ext-link" style="text-align:center;border-color:#1e3a5f;color:#38bdf8"
           href="https://app.{{dd_site}}/logs" target="_blank">🐶 Open Datadog Logs ↗</a>
      </div>
    </div>

  </div>
</main>

<script>
const RCA_URL   = {{ rca_url|tojson }};
const SVC_COLOR = {{ svc_color|tojson }};
const pane      = document.getElementById("pane");
const dot       = document.getElementById("dot");
let errcnt = 0, nextIdx = 0, firstLog = true;

/* ── poll logs every 2 s ─────────────────────────────────────────────────── */
function pollLogs() {
  fetch("/api/logs?since=" + nextIdx)
    .then(r => { dot.classList.toggle("live", r.ok); return r.json(); })
    .then(d => {
      d.lines.forEach(addLine);
      nextIdx = d.next;
    })
    .catch(() => dot.classList.remove("live"));
}
setInterval(pollLogs, 2000);
pollLogs();   // immediate first call

function addLine(e) {
  if (firstLog) {
    const ph = document.getElementById("placeholder");
    if (ph) ph.remove();
    firstLog = false;
  }
  const row = document.createElement("div");
  row.className = "log-line " + (e.level || "info");
  if (e.svc) {
    const b = document.createElement("span");
    b.className = "ll-svc";
    const c = SVC_COLOR[e.svc] || "#64748b";
    b.style.cssText = "background:" + c + "22;color:" + c;
    b.textContent = e.svc;
    row.appendChild(b);
  }
  const t = document.createElement("span");
  t.className = "ll-text";
  t.textContent = e.text;
  row.appendChild(t);
  pane.appendChild(row);
  if (e.level === "error") {
    errcnt++;
    document.getElementById("errcnt").textContent = errcnt;
  }
  if (pane.scrollHeight - pane.scrollTop < pane.clientHeight + 150)
    pane.scrollTop = pane.scrollHeight;
  while (pane.children.length > 1000) pane.removeChild(pane.firstChild);
}

/* ── chaos ───────────────────────────────────────────────────────────────── */
function chaos(url) {
  const msg = document.getElementById("chaos-msg");
  msg.className = "inf";
  msg.textContent = "Sending…";
  fetch("/proxy/chaos", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({url})
  })
  .then(r => r.json())
  .then(d => {
    if (d.status >= 400) {
      msg.className = "ok";
      msg.textContent = "✓ Error triggered! (HTTP " + d.status + ") — watch the log stream.";
    } else if (d.status === 0) {
      msg.className = "err";
      msg.textContent = "✗ Service unreachable — is it running? Check docker compose ps.";
    } else {
      msg.className = "inf";
      msg.textContent = "HTTP " + d.status + " — " + (d.body || "").slice(0, 120);
    }
  })
  .catch(e => { msg.className = "err"; msg.textContent = "✗ " + e; });
}

/* ── RCA trigger ─────────────────────────────────────────────────────────── */
function runRca() {
  const id  = document.getElementById("eid").value.trim();
  const out = document.getElementById("rca-out");
  if (!id) { out.textContent = "⚠ Paste an error_log_id first."; return; }
  out.textContent = "Posting to rca-agent…";
  fetch(RCA_URL + "/rca/run", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({error_log_id: id})
  })
  .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
  .then(d => { out.textContent = JSON.stringify(d, null, 2); window.open(RCA_URL + "/demo", "_blank"); })
  .catch(e => { out.textContent = "Error: " + e; });
}
</script>
</body>
</html>
"""

# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/")
def index():
    return render_template_string(
        _HTML,
        groups=CHAOS_GROUPS,
        rca_url=RCA_AGENT_URL,
        svc_color=_SVC_COLOR,
        dd_site=DD_SITE,
    )


@app.get("/api/logs")
def api_logs():
    """Return log lines from index `since` onward."""
    since = flask_request.args.get("since", 0, type=int)
    with _log_lock:
        total = len(_log_lines)
        # clamp: if caller asks for an index beyond current buffer start, reset to 0
        start = max(0, since)
        slice_ = _log_lines[start:]
    return jsonify({"lines": slice_, "next": start + len(slice_), "total": total})


@app.post("/proxy/chaos")
def proxy_chaos():
    data = flask_request.get_json(silent=True) or {}
    url  = data.get("url", "")
    if not url:
        return jsonify({"status": 0, "body": "missing url"}), 400
    try:
        resp = requests.post(url, timeout=8)
        return jsonify({"status": resp.status_code, "body": resp.text[:400]})
    except requests.exceptions.Timeout:
        return jsonify({"status": 408, "body": "timeout — error may still be logged by service"})
    except requests.exceptions.ConnectionError:
        return jsonify({"status": 0, "body": "connection refused"})
    except Exception as exc:
        return jsonify({"status": 0, "body": str(exc)})


@app.get("/health")
def health():
    return jsonify({
        "status": "ok",
        "log_file": LOG_FILE_PATH,
        "log_file_exists": os.path.exists(LOG_FILE_PATH),
        "lines_buffered": len(_log_lines),
        "banking_app_host": BANKING_APP_HOST,
        "pricing_host": PRICING_HOST,
        "order_host": ORDER_HOST,
    })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
