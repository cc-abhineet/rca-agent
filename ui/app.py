"""
ui/app.py — Minimal log-viewer Flask dashboard for the rca-agent demo.

Each UI container instance is pointed at a different service's log file and
Datadog query via environment variables:

  LOG_FILE_PATH   Path to the log file to tail (inside the container)
  DD_QUERY        Datadog log search query (e.g. "service:order-service")
  DD_SITE         Datadog site (e.g. datadoghq.com)
  DD_API_KEY      Datadog API key (read from env file)
  DD_APP_KEY      Datadog Application key (read from env file)
  SERVICE_LABEL   Human-readable label shown in the dashboard header
  RCA_AGENT_URL   Base URL of the rca-agent FastAPI (default: http://localhost:8000)

Start:
  python app.py
"""

import os
import time
import queue
import threading
import json
import requests
from pathlib import Path

from flask import Flask, Response, jsonify, render_template_string, stream_with_context, request as flask_request

app = Flask(__name__)

# ── Config ────────────────────────────────────────────────────────────────────

LOG_FILE_PATH   = os.getenv("LOG_FILE_PATH",   "/var/log/banking-app/app.log")
DD_QUERY        = os.getenv("DD_QUERY",        "service:banking-app")
DD_SITE         = os.getenv("DD_SITE",         "datadoghq.com")
DD_API_KEY      = os.getenv("DD_API_KEY",      "")
DD_APP_KEY      = os.getenv("DD_APP_KEY",      "")
SERVICE_LABEL   = os.getenv("SERVICE_LABEL",   "banking-app")
RCA_AGENT_URL   = os.getenv("RCA_AGENT_URL",   "http://localhost:8000")

# Internal service hostnames — overridden per-container in docker-compose so
# the Flask proxy reaches services via Docker DNS instead of localhost.
BANKING_APP_HOST = os.getenv("BANKING_APP_HOST", "localhost")
PRICING_HOST     = os.getenv("PRICING_HOST",     "localhost")
ORDER_HOST       = os.getenv("ORDER_HOST",        "localhost")

# ── SSE broadcast ─────────────────────────────────────────────────────────────

_subscribers: list[queue.Queue] = []
_sub_lock = threading.Lock()


def _broadcast(msg: dict) -> None:
    with _sub_lock:
        dead = []
        for q in _subscribers:
            try:
                q.put_nowait(msg)
            except queue.Full:
                dead.append(q)
        for q in dead:
            _subscribers.remove(q)


def _subscribe() -> queue.Queue:
    q: queue.Queue = queue.Queue(maxsize=500)
    with _sub_lock:
        _subscribers.append(q)
    return q


def _unsubscribe(q: queue.Queue) -> None:
    with _sub_lock:
        if q in _subscribers:
            _subscribers.remove(q)


# ── Log file tailer ──────────────────────────────────────────────────────────

_log_lines: list[str] = []          # rolling buffer of last 200 lines
_log_lock = threading.Lock()
MAX_BUFFER = 200


def _classify(line: str) -> str:
    """Return a CSS class name based on log level keywords."""
    u = line.upper()
    if " ERROR " in u or "ERROR]" in u:
        return "error"
    if " WARN " in u or "WARN]" in u:
        return "warn"
    if "EXCEPTION" in u or "at com." in line or "at org." in line or "at java." in line:
        return "error"
    return "info"


def _tail_loop() -> None:
    """Background thread: tail LOG_FILE_PATH and broadcast each new line."""
    log_path = Path(LOG_FILE_PATH)
    # Wait up to 60 s for the file to appear (container may start before the app)
    for _ in range(60):
        if log_path.exists():
            break
        time.sleep(1)

    if not log_path.exists():
        _broadcast({"type": "status", "text": f"Log file not found: {LOG_FILE_PATH}"})
        return

    with open(log_path, "r", errors="replace") as fh:
        # Seek to the last 8 KB so we replay recent history on connect
        fh.seek(0, 2)
        size = fh.tell()
        fh.seek(max(0, size - 8192))
        fh.read()   # discard partial first line

        while True:
            line = fh.readline()
            if not line:
                time.sleep(0.25)
                continue
            line = line.rstrip()
            if not line:
                continue
            level = _classify(line)
            with _log_lock:
                _log_lines.append(line)
                if len(_log_lines) > MAX_BUFFER:
                    _log_lines.pop(0)
            _broadcast({"type": "log", "level": level, "text": line})


threading.Thread(target=_tail_loop, daemon=True, name="log-tailer").start()


# ── HTML template ─────────────────────────────────────────────────────────────

_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{{ service_label }} — rca-agent demo</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0f1117; color: #e0e0e0; }
  header { background: #1a1d2e; border-bottom: 1px solid #2d3154; padding: 14px 20px;
           display: flex; align-items: center; gap: 16px; }
  header h1 { font-size: 1.1rem; font-weight: 600; color: #a78bfa; }
  header .meta { font-size: .8rem; color: #888; margin-left: auto; }
  .badge { background: #2d3154; border-radius: 4px; padding: 2px 8px;
           font-size: .75rem; color: #a78bfa; }
  main { display: flex; height: calc(100vh - 53px); }
  .logs { flex: 1; overflow-y: auto; padding: 12px; font-family: monospace;
          font-size: .8rem; line-height: 1.6; }
  .log-line { padding: 1px 4px; border-left: 2px solid transparent; word-break: break-all; }
  .log-line.error { border-color: #ef4444; color: #fca5a5; background: rgba(239,68,68,.05); }
  .log-line.warn  { border-color: #f59e0b; color: #fcd34d; }
  .log-line.info  { color: #94a3b8; }
  .sidebar { width: 320px; background: #1a1d2e; border-left: 1px solid #2d3154;
             padding: 16px; display: flex; flex-direction: column; gap: 12px;
             overflow-y: auto; }
  .sidebar h2 { font-size: .85rem; font-weight: 600; color: #a78bfa; text-transform: uppercase;
                letter-spacing: .06em; margin-bottom: 4px; }
  .info-row { font-size: .78rem; color: #888; }
  .info-row span { color: #d1d5db; }
  textarea { width: 100%; background: #0f1117; border: 1px solid #2d3154; border-radius: 4px;
             color: #e0e0e0; font-size: .78rem; padding: 8px; resize: vertical;
             font-family: monospace; min-height: 80px; }
  button { width: 100%; padding: 8px; border: none; border-radius: 5px; cursor: pointer;
           font-size: .85rem; font-weight: 600; transition: opacity .15s; }
  button:hover { opacity: .85; }
  #btn-rca  { background: #7c3aed; color: #fff; }
  #btn-dd   { background: #1d4ed8; color: #fff; margin-top: 4px; }
  #rca-out  { background: #0f1117; border: 1px solid #2d3154; border-radius: 4px;
              padding: 8px; font-size: .76rem; white-space: pre-wrap; min-height: 60px;
              color: #94a3b8; max-height: 300px; overflow-y: auto; }
  .chaos { display: flex; flex-direction: column; gap: 6px; }
  .chaos button { background: #7f1d1d; color: #fca5a5; }
  #conn-dot { width: 8px; height: 8px; border-radius: 50%; background: #888; display: inline-block; }
  #conn-dot.live { background: #22c55e; }
</style>
</head>
<body>
<header>
  <span id="conn-dot"></span>
  <h1>{{ service_label }}</h1>
  <span class="badge">LOG_FILE_PATH: {{ log_file_path }}</span>
  <span class="meta">rca-agent demo ui</span>
</header>
<main>
  <div class="logs" id="log-pane"></div>
  <div class="sidebar">
    <div>
      <h2>Service info</h2>
      <div class="info-row">DD query: <span>{{ dd_query }}</span></div>
      <div class="info-row">rca-agent: <span><a href="{{ rca_agent_url }}/demo" target="_blank"
          style="color:#a78bfa">{{ rca_agent_url }}/demo</a></span></div>
    </div>

    <div>
      <h2>Trigger RCA</h2>
      <textarea id="err-id-input" placeholder="error_log_id (UUID from the rca-agent DB)"></textarea>
      <button id="btn-rca" onclick="triggerRCA()">▶ Run RCA</button>
      <div id="rca-out">Paste an error_log_id above and click Run RCA.</div>
    </div>

    <div>
      <h2>View in Datadog</h2>
      <button id="btn-dd" onclick="openDD()">Open Datadog Logs</button>
    </div>

    <div class="chaos">
      <h2>Chaos scenarios</h2>
      {% for label, url in chaos_urls.items() %}
      <button onclick="triggerChaos('{{ url }}')">{{ label }}</button>
      {% endfor %}
      <div id="chaos-out" style="font-size:.75rem;color:#888;margin-top:4px;"></div>
    </div>
  </div>
</main>
<script>
const RCA_URL = "{{ rca_agent_url }}";
const DD_QUERY = {{ dd_query_json }};
const DD_SITE  = "{{ dd_site }}";
const logPane  = document.getElementById("log-pane");
const connDot  = document.getElementById("conn-dot");

// ── SSE log stream ────────────────────────────────────────────────────────────
const es = new EventSource("/stream");
es.onopen = () => connDot.classList.add("live");
es.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === "log") appendLine(msg.level, msg.text);
  if (msg.type === "status") appendLine("warn", "[status] " + msg.text);
};
es.onerror = () => connDot.classList.remove("live");

function appendLine(level, text) {
  const div = document.createElement("div");
  div.className = "log-line " + level;
  div.textContent = text;
  logPane.appendChild(div);
  // Auto-scroll if near bottom
  if (logPane.scrollHeight - logPane.scrollTop < logPane.clientHeight + 60) {
    logPane.scrollTop = logPane.scrollHeight;
  }
  // Cap DOM lines
  while (logPane.children.length > 500) logPane.removeChild(logPane.firstChild);
}

// ── RCA trigger ───────────────────────────────────────────────────────────────
// Requires: rca-agent running on host port 8000 (started separately via uvicorn).
// The browser calls RCA_URL directly — no proxy needed because the rca-agent
// is on the host and port 8000 is accessible from the browser.
function triggerRCA() {
  const id = document.getElementById("err-id-input").value.trim();
  if (!id) { alert("Enter an error_log_id (UUID) from the rca-agent DB first."); return; }
  const out = document.getElementById("rca-out");
  out.textContent = "POSTing to " + RCA_URL + "/rca/run …";

  fetch(`${RCA_URL}/rca/run`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({error_log_id: id}),
  })
  .then(r => {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  })
  .then(data => {
    out.textContent = JSON.stringify(data, null, 2);
  })
  .catch(err => {
    out.textContent = "Error: " + err + "\n\nIs the rca-agent running at " + RCA_URL + "?";
  });
}

// ── Datadog link ──────────────────────────────────────────────────────────────
function openDD() {
  const q = encodeURIComponent(DD_QUERY);
  window.open(`https://app.${DD_SITE}/logs?query=${q}`, "_blank");
}

// ── Chaos ────────────────────────────────────────────────────────────────────
// Chaos requests are routed through /proxy/chaos on the Flask backend so the
// browser never makes a cross-origin request (avoids CORS blocks).
// The Flask container reaches services via Docker-internal DNS.
function triggerChaos(url) {
  const out = document.getElementById("chaos-out");
  if (url === "__order__") { triggerOrder(); return; }
  out.textContent = "Sending → " + url;
  fetch("/proxy/chaos", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({url: url}),
  })
  .then(r => r.json())
  .then(d => { out.textContent = "chaos → HTTP " + d.status + (d.body ? "\n" + d.body : ""); })
  .catch(e => { out.textContent = "Error: " + e; });
}

function triggerOrder() {
  const out = document.getElementById("chaos-out");
  out.textContent = "Creating demo order via /proxy/order …";
  fetch("/proxy/order", {method: "POST"})
  .then(r => r.json())
  .then(d => { out.textContent = "order → HTTP " + d.status + "\n" + JSON.stringify(d.body, null, 2); })
  .catch(e => { out.textContent = "Error: " + e; });
}
</script>
</body>
</html>
"""

# ── Chaos endpoint map ────────────────────────────────────────────────────────
# URLs here are resolved server-side by the Flask /proxy/chaos route, so they
# use Docker-internal service hostnames (set via BANKING_APP_HOST / PRICING_HOST
# / ORDER_HOST env vars in docker-compose).  Paths must match the actual
# @RequestMapping annotations in each Spring Boot ChaosController.

def _chaos_urls() -> dict[str, dict]:
    return {
        "banking-app": {
            "💥 NullPointerException": f"http://{BANKING_APP_HOST}:8080/chaos/null-pointer",
            "💸 InsufficientFunds":    f"http://{BANKING_APP_HOST}:8080/chaos/insufficient-funds",
            "🔗 DB Connection Error":  f"http://{BANKING_APP_HOST}:8080/chaos/db-error",
        },
        "pricing-service": {
            "💥 NPE in getPricing":    f"http://{PRICING_HOST}:8081/chaos/null-pointer",
            "⚠️  Rate-limit error":    f"http://{PRICING_HOST}:8081/chaos/rate-limit",
        },
        "order-service": {
            # Actual endpoints from ChaosController @PostMapping annotations:
            "💥 Bug A — cross-service NPE":  f"http://{ORDER_HOST}:8082/chaos/cross-service-npe",
            "🔢 Bug B — qty off-by-one":     f"http://{ORDER_HOST}:8082/chaos/quantity-off-by-one",
        },
        "order-service (single-service RCA)": {
            "💥 Bug A — cross-service NPE":  f"http://{ORDER_HOST}:8082/chaos/cross-service-npe",
            "🔢 Bug B — qty off-by-one":     f"http://{ORDER_HOST}:8082/chaos/quantity-off-by-one",
        },
        "pricing-service + order-service (cross-service RCA demo)": {
            "💥 Bug A — cross-service NPE":  f"http://{ORDER_HOST}:8082/chaos/cross-service-npe",
            "🔢 Bug B — qty off-by-one":     f"http://{ORDER_HOST}:8082/chaos/quantity-off-by-one",
            # Correct order API path + body — handled by /proxy/order
            "💲 Create demo order (Bug A)":  "__order__",
        },
    }


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/")
def index():
    chaos = _chaos_urls().get(SERVICE_LABEL, {})
    return render_template_string(
        _TEMPLATE,
        service_label=SERVICE_LABEL,
        log_file_path=LOG_FILE_PATH,
        dd_query=DD_QUERY,
        dd_query_json=json.dumps(DD_QUERY),
        dd_site=DD_SITE,
        rca_agent_url=RCA_AGENT_URL,
        chaos_urls=chaos,
    )


@app.get("/stream")
def stream():
    """SSE endpoint — streams log lines to the browser."""
    q = _subscribe()

    def generate():
        # Replay recent buffer on connect
        with _log_lock:
            history = list(_log_lines)
        for line in history:
            level = _classify(line)
            yield f"data: {json.dumps({'type': 'log', 'level': level, 'text': line})}\n\n"

        try:
            while True:
                try:
                    msg = q.get(timeout=15)
                    yield f"data: {json.dumps(msg)}\n\n"
                except queue.Empty:
                    yield ": keepalive\n\n"  # SSE comment keeps connection alive
        finally:
            _unsubscribe(q)

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/health")
def health():
    return jsonify({"status": "ok", "service": SERVICE_LABEL, "log_file": LOG_FILE_PATH})


@app.get("/api/recent-logs")
def recent_logs():
    with _log_lock:
        return jsonify({"lines": list(_log_lines)})


# ── Server-side chaos proxy ───────────────────────────────────────────────────
# Chaos buttons in the browser call these routes instead of hitting the Java
# services directly, which avoids cross-origin (CORS) blocks.  The Flask
# container is on rca-net and resolves service hostnames via Docker DNS.

@app.post("/proxy/chaos")
def proxy_chaos():
    data = flask_request.get_json(silent=True) or {}
    url = data.get("url", "")
    if not url:
        return jsonify({"error": "missing url"}), 400
    try:
        resp = requests.post(url, timeout=5)
        body = ""
        try:
            body = resp.text[:500]
        except Exception:
            pass
        return jsonify({"status": resp.status_code, "body": body})
    except requests.exceptions.ConnectionError as e:
        return jsonify({"status": 0, "body": f"Connection refused: {e}"}), 502
    except Exception as e:
        return jsonify({"status": 0, "body": str(e)}), 502


@app.post("/proxy/order")
def proxy_order():
    """Create a demo order against order-service — triggers Bug A (NPE)."""
    url = f"http://{ORDER_HOST}:8082/api/v1/orders"
    payload = {
        "customerId":   "DEMO-CUSTOMER",
        "sku":          "SKU-001",
        "quantity":     2,          # > 1 so resolveQuantity passes Bug-B check
        "customerTier": "premium",  # non-null so only Bug A fires
    }
    try:
        resp = requests.post(url, json=payload, timeout=5)
        body = None
        try:
            body = resp.json()
        except Exception:
            body = resp.text[:500]
        return jsonify({"status": resp.status_code, "body": body})
    except requests.exceptions.ConnectionError as e:
        return jsonify({"status": 0, "body": f"Connection refused — is order-service running? {e}"}), 502
    except Exception as e:
        return jsonify({"status": 0, "body": str(e)}), 502


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
