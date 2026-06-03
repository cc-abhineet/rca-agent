"""
trigger-ui/app.py — Error Trigger Dashboard for Apollo RCA Platform

Provides a live log stream and one-click error injection buttons that call
the real business service layer (NOT chaos scaffolding directly) so that
every stack trace points to actual business code for realistic RCA testing.

Environment variables:
  LOG_FILE_PATH     Shared log file path   (default: /var/log/banking-app/app.log)
  BANKING_APP_HOST  banking-app hostname   (default: banking-app)
  PRICING_HOST      pricing-service host   (default: pricing-service)
  ORDER_HOST        order-service host     (default: order-service)
  RCA_AGENT_URL     rca-agent base URL     (default: http://rca-agent:8000)
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
RCA_AGENT_URL    = os.getenv("RCA_AGENT_URL",    "http://rca-agent:8000")
BANKING_APP_HOST = os.getenv("BANKING_APP_HOST", "banking-app")
PRICING_HOST     = os.getenv("PRICING_HOST",     "pricing-service")
ORDER_HOST       = os.getenv("ORDER_HOST",       "order-service")

# ── Scenario catalogue ────────────────────────────────────────────────────────
# Each URL maps to a ChaosController endpoint that immediately delegates to the
# real business service — the error and stack trace originate in service code.

CHAOS_GROUPS = [
    {
        "id": "banking-app",
        "label": "Banking Service",
        "color": "#7c3aed",
        "scenarios": [
            {
                "icon": "💥",
                "label": "NPE — AccountService",
                "detail": "AccountService.getAccountEnrichment → NullPointerException (enrichment cache miss)",
                "url": f"http://{BANKING_APP_HOST}:8080/chaos/null-pointer",
            },
            {
                "icon": "💸",
                "label": "InsufficientFunds",
                "detail": "AccountService.withdraw($9,999,999.99) → InsufficientFundsException",
                "url": f"http://{BANKING_APP_HOST}:8080/chaos/insufficient-funds",
            },
            {
                "icon": "🗄",
                "label": "DB Pool Exhausted",
                "detail": "AccountService.processBatchStatement → RuntimeException (JDBC pool timeout)",
                "url": f"http://{BANKING_APP_HOST}:8080/chaos/db-connection",
            },
            {
                "icon": "🔍",
                "label": "Account Not Found",
                "detail": "AccountService.getAccountById(999999999) → AccountNotFoundException",
                "url": f"http://{BANKING_APP_HOST}:8080/chaos/account-not-found",
            },
        ],
    },
    {
        "id": "pricing-service",
        "label": "Pricing Service",
        "color": "#0891b2",
        "scenarios": [
            {
                "icon": "💥",
                "label": "NPE — PricingService",
                "detail": "PricingService.computeDynamicPricing(null) → NullPointerException (Map.of null key)",
                "url": f"http://{PRICING_HOST}:8081/chaos/null-pointer",
            },
            {
                "icon": "📦",
                "label": "Invalid SKU",
                "detail": "PricingService.calculatePrice(SKU-CHAOS-999) → InvalidSkuException",
                "url": f"http://{PRICING_HOST}:8081/chaos/invalid-sku",
            },
            {
                "icon": "➗",
                "label": "Divide by Zero",
                "detail": "PricingService.computeDiscountedVolume(qty=1) → ArithmeticException (10/(1-1))",
                "url": f"http://{PRICING_HOST}:8081/chaos/arithmetic",
            },
        ],
    },
    {
        "id": "order-service",
        "label": "Order Service",
        "color": "#be123c",
        "scenarios": [
            {
                "icon": "🔗",
                "label": "Cross-service NPE",
                "detail": "OrderService.calculateTotal → NPE (PricingResponseDto.discount is null; pricing-service renamed field to discountRate)",
                "url": f"http://{ORDER_HOST}:8082/chaos/cross-service-npe",
            },
            {
                "icon": "🔢",
                "label": "Off-by-one Qty",
                "detail": "OrderService.resolveQuantity(1) → IllegalArgumentException (quantity=0 after -1 normalisation bug)",
                "url": f"http://{ORDER_HOST}:8082/chaos/quantity-off-by-one",
            },
        ],
    },
]

_SVC_COLOR = {
    "banking-app":     "#a78bfa",
    "pricing-service": "#22d3ee",
    "order-service":   "#fb7185",
}

# ── Log buffer ────────────────────────────────────────────────────────────────

_log_lines: list[dict] = []
_log_lock  = threading.Lock()
MAX_BUFFER = 800

_SVC_RE = [
    re.compile(r'dd\.service=([^\s,\]"]+)'),
    re.compile(r'"service"\s*:\s*"([^"]+)"'),
]


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
    while not os.path.exists(LOG_FILE_PATH):
        _push(f"[ui] waiting for log file: {LOG_FILE_PATH}")
        time.sleep(3)

    while True:
        try:
            with open(LOG_FILE_PATH, "r", errors="replace") as fh:
                fh.seek(0, 2)
                size = fh.tell()
                fh.seek(max(0, size - 51200))
                if size > 51200:
                    fh.readline()
                for raw in fh.read().splitlines():
                    raw = raw.rstrip()
                    if raw:
                        _push(raw)
                while True:
                    raw = fh.readline()
                    if not raw:
                        try:
                            if os.path.getsize(LOG_FILE_PATH) < fh.tell():
                                break
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

_HTML = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Apollo — Error Trigger Dashboard</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#070d1a;--bg2:#0b1120;--surface:#0f1729;--surface2:#131d30;
  --border:#1a2440;--border2:#22304a;
  --text:#e2e8f0;--text2:#94a3b8;--muted:#475569;
  --indigo:#6366f1;--indigo2:#818cf8;
  --green:#10b981;--amber:#f59e0b;--red:#ef4444;--purple:#a855f7;
}
body{font-family:'Segoe UI',system-ui,-apple-system,sans-serif;
     background:var(--bg);color:var(--text);height:100vh;
     display:flex;flex-direction:column;overflow:hidden;
     -webkit-font-smoothing:antialiased}
::-webkit-scrollbar{width:4px;height:4px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.1);border-radius:4px}
::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,0.2)}

/* header */
header{
  display:flex;align-items:center;gap:10px;
  padding:0 18px;height:52px;
  background:linear-gradient(180deg,rgba(99,102,241,0.08) 0%,transparent 100%);
  border-bottom:1px solid var(--border);flex-shrink:0;
}
.hdr-logo{display:flex;align-items:center;gap:8px;font-size:1rem;font-weight:800;color:var(--text);letter-spacing:-.02em}
.hdr-logo-icon{width:28px;height:28px;border-radius:7px;background:linear-gradient(135deg,var(--indigo),var(--purple));
               display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;
               box-shadow:0 0 12px rgba(99,102,241,0.4)}
.hdr-sep{width:1px;height:20px;background:var(--border2);flex-shrink:0}
.hdr-svc-badges{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.svc-badge{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:20px;
           font-size:.68rem;font-weight:700;letter-spacing:.02em}
.hdr-right{margin-left:auto;display:flex;align-items:center;gap:10px}
.err-counter{display:flex;align-items:center;gap:6px;padding:4px 12px;border-radius:20px;
             background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.25);
             font-size:.75rem;font-weight:700;color:#fca5a5}
.live-dot{width:7px;height:7px;border-radius:50%;background:#374151;flex-shrink:0;transition:all .3s}
.live-dot.active{background:var(--green);box-shadow:0 0 8px rgba(16,185,129,0.6);animation:ldPulse 1.5s ease infinite}
@keyframes ldPulse{0%,100%{opacity:1}50%{opacity:.5}}
.hdr-link{font-size:.75rem;color:var(--indigo2);text-decoration:none;padding:5px 12px;
          border:1px solid rgba(99,102,241,0.3);border-radius:7px;font-weight:600;transition:all .15s;white-space:nowrap}
.hdr-link:hover{background:rgba(99,102,241,0.12);color:#c7d2fe}
.log-filter-btn{padding:3px 9px;border-radius:5px;font-size:.68rem;font-weight:600;
                border:1px solid var(--border2);background:transparent;color:var(--muted);
                cursor:pointer;transition:all .12s;font-family:inherit;flex-shrink:0}
.log-filter-btn:hover{color:var(--text2);border-color:rgba(255,255,255,0.2)}
.log-filter-btn.active-all  {background:rgba(99,102,241,0.15);border-color:rgba(99,102,241,0.4);color:var(--indigo2)}
.log-filter-btn.active-error{background:rgba(239,68,68,0.12);border-color:rgba(239,68,68,0.4);color:#fca5a5}
.log-filter-btn.active-warn {background:rgba(245,158,11,0.12);border-color:rgba(245,158,11,0.35);color:#fcd34d}
.log-clear-btn{padding:3px 9px;border-radius:5px;font-size:.68rem;font-weight:600;
               border:1px solid var(--border2);background:transparent;color:var(--muted);
               cursor:pointer;font-family:inherit;transition:all .12s;flex-shrink:0}
.log-clear-btn:hover{color:var(--text2);border-color:rgba(255,255,255,0.18)}

/* layout */
main{display:flex;flex:1;overflow:hidden}

/* log pane */
.log-pane{flex:1;overflow-y:auto;overflow-x:hidden;padding:6px 10px;
          font-family:'Cascadia Code','JetBrains Mono','Fira Code',monospace;
          font-size:.73rem;line-height:1.58;
          border-right:1px solid var(--border);background:var(--bg)}
.log-line{display:flex;align-items:baseline;gap:6px;padding:1px 0 1px 4px;border-left:2px solid transparent}
.log-line.error{border-color:var(--red);background:rgba(239,68,68,.05)}
.log-line.warn {border-color:var(--amber);background:rgba(245,158,11,.03)}
.log-line.trace{color:var(--muted)}
.log-line.info {color:#94a3b8}
.log-line.error .ll-text{color:#fca5a5}
.log-line.warn  .ll-text{color:#fcd34d}
.ll-svc{flex-shrink:0;font-size:.63rem;font-weight:700;padding:1px 5px;border-radius:3px}
.ll-text{word-break:break-all}
.log-placeholder{height:100%;display:flex;align-items:center;justify-content:center;
                 color:var(--muted);flex-direction:column;gap:10px;font-size:.85rem}
.spinner{width:20px;height:20px;border:2px solid rgba(99,102,241,0.15);
         border-top-color:var(--indigo);border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

/* sidebar */
.sidebar{width:360px;flex-shrink:0;overflow-y:auto;background:var(--surface);display:flex;flex-direction:column}

/* section */
.section{border-bottom:1px solid var(--border);padding:14px 16px}
.section-title{font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;
               color:var(--muted);margin-bottom:12px;display:flex;align-items:center;gap:6px}
.section-title::after{content:'';flex:1;height:1px;background:var(--border2)}

/* service group */
.svc-group{margin-bottom:14px}
.svc-group:last-child{margin-bottom:0}
.svc-group-header{display:flex;align-items:center;gap:7px;margin-bottom:8px}
.svc-group-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}
.svc-group-label{font-size:.72rem;font-weight:700;color:var(--text2)}
.chaos-grid{display:grid;grid-template-columns:1fr 1fr;gap:5px}
.cbtn{padding:8px 9px;border-radius:7px;border:1px solid var(--border2);background:var(--surface2);
      color:var(--text2);font-size:.72rem;font-weight:600;cursor:pointer;text-align:left;
      transition:all .14s;display:flex;flex-direction:column;gap:2px;font-family:inherit}
.cbtn:hover{background:rgba(255,255,255,0.07);border-color:rgba(255,255,255,0.18);color:var(--text);transform:translateY(-1px)}
.cbtn:active{transform:none;opacity:.85}
.cbtn-top{display:flex;align-items:center;gap:5px}
.cbtn-icon{font-size:.9em;flex-shrink:0}
.cbtn-detail{font-size:.6rem;color:var(--muted);line-height:1.3;font-weight:400}

/* chaos status */
.chaos-status{margin-top:10px;padding:8px 10px;border-radius:7px;font-size:.72rem;font-weight:600;
              min-height:34px;display:flex;align-items:center;gap:7px;
              background:rgba(255,255,255,0.03);border:1px solid var(--border);color:var(--muted);transition:all .2s}
.chaos-status.ok {background:rgba(16,185,129,0.08);border-color:rgba(16,185,129,0.3);color:#6ee7b7}
.chaos-status.err{background:rgba(239,68,68,0.08);border-color:rgba(239,68,68,0.3);color:#fca5a5}
.chaos-status-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0;background:currentColor}

/* rca panel */
.rca-input{width:100%;background:var(--bg);border:1px solid var(--border2);border-radius:7px;
           color:var(--text);font-size:.75rem;padding:8px 10px;
           font-family:'Cascadia Code','JetBrains Mono',monospace;transition:border-color .15s;margin-bottom:8px}
.rca-input:focus{outline:none;border-color:var(--indigo);box-shadow:0 0 0 2px rgba(99,102,241,0.15)}
.rca-input::placeholder{color:var(--muted)}
.btn-rca{width:100%;padding:9px;border:none;border-radius:7px;
         background:linear-gradient(135deg,var(--indigo),var(--purple));color:#fff;
         font-size:.8rem;font-weight:700;cursor:pointer;display:flex;align-items:center;
         justify-content:center;gap:7px;font-family:inherit;transition:opacity .15s,transform .1s;
         box-shadow:0 4px 16px rgba(99,102,241,0.35)}
.btn-rca:hover{opacity:.9;transform:translateY(-1px)}
.btn-rca:active{transform:none;opacity:.85}
#rca-out{margin-top:8px;background:var(--bg);border:1px solid var(--border);border-radius:7px;
         padding:8px 10px;font-size:.68rem;color:var(--muted);min-height:44px;max-height:160px;
         overflow-y:auto;white-space:pre-wrap;font-family:'Cascadia Code','JetBrains Mono',monospace;
         word-break:break-word;line-height:1.55}
#rca-out.ok {color:#6ee7b7}
#rca-out.err{color:#fca5a5}

/* links */
.link-card{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;
           border:1px solid var(--border2);background:var(--surface2);text-decoration:none;
           color:var(--text2);font-size:.78rem;font-weight:600;transition:all .14s;margin-bottom:7px}
.link-card:last-child{margin-bottom:0}
.link-card:hover{border-color:rgba(255,255,255,0.2);background:rgba(255,255,255,0.06);color:var(--text)}
.link-card-icon{font-size:1em;flex-shrink:0}
.link-card-arrow{margin-left:auto;font-size:.7em;color:var(--muted)}
</style>
</head>
<body>

<header>
  <div class="hdr-logo">
    <div class="hdr-logo-icon">⚡</div>
    Apollo Error Trigger
  </div>
  <div class="hdr-sep"></div>
  <div class="hdr-svc-badges">
    {% for g in groups %}
    <span class="svc-badge" style="background:{{g.color}}18;color:{{g.color}};border:1px solid {{g.color}}35">
      {{g.label}}
    </span>
    {% endfor %}
  </div>
  <div class="hdr-right">
    <button class="log-filter-btn active-all" id="f-all"   onclick="setFilter('all')">All</button>
    <button class="log-filter-btn"            id="f-error" onclick="setFilter('error')">Errors</button>
    <button class="log-filter-btn"            id="f-warn"  onclick="setFilter('warn')">Warn</button>
    <button class="log-clear-btn" onclick="clearLogs()">Clear</button>
    <div class="hdr-sep"></div>
    <div class="err-counter">
      <span>Errors</span>
      <span id="errcnt" style="font-size:.9rem">0</span>
    </div>
    <div id="live-dot" class="live-dot"></div>
    <a class="hdr-link" href="{{rca_url}}" target="_blank">RCA Dashboard ↗</a>
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

    <div class="section">
      <div class="section-title">Inject Error into Business Layer</div>
      {% for g in groups %}
      <div class="svc-group">
        <div class="svc-group-header">
          <div class="svc-group-dot" style="background:{{g.color}};box-shadow:0 0 6px {{g.color}}88"></div>
          <span class="svc-group-label">{{g.label}}</span>
        </div>
        <div class="chaos-grid">
          {% for s in g.scenarios %}
          <button class="cbtn" onclick="chaos('{{s.url}}')">
            <div class="cbtn-top">
              <span class="cbtn-icon">{{s.icon}}</span>
              <span>{{s.label}}</span>
            </div>
            <div class="cbtn-detail">{{s.detail}}</div>
          </button>
          {% endfor %}
        </div>
      </div>
      {% endfor %}
      <div class="chaos-status" id="chaos-status">
        <span class="chaos-status-dot" style="opacity:.3"></span>
        Click a scenario — error originates in service layer, not chaos code.
      </div>
    </div>

    <div class="section">
      <div class="section-title">Run RCA Analysis</div>
      <input class="rca-input" id="eid" placeholder="Paste error_log_id UUID…" autocomplete="off" spellcheck="false">
      <button class="btn-rca" onclick="runRca()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        Run RCA Analysis
      </button>
      <div id="rca-out">Paste an error_log_id from the RCA dashboard and click Run.</div>
    </div>

    <div class="section">
      <div class="section-title">Quick Links</div>
      <a class="link-card" href="{{rca_url}}" target="_blank">
        <span class="link-card-icon">📊</span> RCA Dashboard
        <span class="link-card-arrow">↗</span>
      </a>
      <a class="link-card" href="{{rca_url}}/api/logs" target="_blank">
        <span class="link-card-icon">🗃</span> Error Logs API
        <span class="link-card-arrow">↗</span>
      </a>
    </div>

  </div>
</main>

<script>
const RCA_URL   = {{ rca_url|tojson }};
const SVC_COLOR = {{ svc_color|tojson }};
const pane      = document.getElementById("pane");
const liveDot   = document.getElementById("live-dot");
let errcnt = 0, nextIdx = 0, firstLog = true, activeFilter = 'all';

function setFilter(f) {
  activeFilter = f;
  ['all','error','warn'].forEach(id => {
    const btn = document.getElementById('f-' + id);
    if (btn) btn.className = 'log-filter-btn' + (f === id ? ' active-' + f : '');
  });
  const rows = pane.getElementsByClassName('log-line');
  for (let i = 0; i < rows.length; i++) {
    const lvl = rows[i].dataset.level || 'info';
    rows[i].style.display = (f === 'all' || lvl === f) ? '' : 'none';
  }
}

function clearLogs() {
  const rows = pane.getElementsByClassName('log-line');
  while (rows.length) rows[0].remove();
  errcnt = 0;
  document.getElementById('errcnt').textContent = 0;
}

function pollLogs() {
  fetch("/api/logs?since=" + nextIdx)
    .then(r => { liveDot.classList.toggle("active", r.ok); return r.json(); })
    .then(d => { d.lines.forEach(addLine); nextIdx = d.next; })
    .catch(() => liveDot.classList.remove("active"));
}
setInterval(pollLogs, 2000);
pollLogs();

function addLine(e) {
  if (firstLog) {
    const ph = document.getElementById("placeholder");
    if (ph) ph.remove();
    firstLog = false;
  }
  const row = document.createElement("div");
  const lvl = e.level || "info";
  row.className = "log-line " + lvl;
  row.dataset.level = lvl;
  if (activeFilter !== 'all' && lvl !== activeFilter) row.style.display = 'none';
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
  while (pane.children.length > 1200) pane.removeChild(pane.firstChild);
}

function chaos(url) {
  const box = document.getElementById("chaos-status");
  box.className = "chaos-status";
  box.innerHTML = '<span class="chaos-status-dot" style="opacity:.4"></span> Triggering…';
  fetch("/proxy/chaos", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({url})
  })
  .then(r => r.json())
  .then(d => {
    if (d.status >= 400 || d.status === 0) {
      box.className = "chaos-status ok";
      const svc = new URL(url).hostname;
      box.innerHTML = '<span class="chaos-status-dot"></span> ✓ Error injected into ' + svc +
                      ' (HTTP ' + d.status + ') — check log stream for stack trace';
    } else {
      box.className = "chaos-status";
      box.innerHTML = '<span class="chaos-status-dot" style="opacity:.4"></span> HTTP ' +
                      d.status + ' — ' + (d.body || '').slice(0, 120);
    }
  })
  .catch(e => {
    box.className = "chaos-status err";
    box.innerHTML = '<span class="chaos-status-dot"></span> ✗ ' + e;
  });
}

function runRca() {
  const id  = document.getElementById("eid").value.trim();
  const out = document.getElementById("rca-out");
  if (!id) { out.className = 'err'; out.textContent = "⚠ Paste an error_log_id first."; return; }
  out.className = ''; out.textContent = "Sending to RCA agent…";
  fetch(RCA_URL + "/rca/run", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({error_log_id: id})
  })
  .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
  .then(d => {
    out.className = 'ok';
    out.textContent = "✓ RCA started — " + JSON.stringify(d).slice(0, 200);
    window.open(RCA_URL, "_blank");
  })
  .catch(e => { out.className = 'err'; out.textContent = "✗ " + e; });
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
    )


@app.get("/api/logs")
def api_logs():
    since = flask_request.args.get("since", 0, type=int)
    with _log_lock:
        start  = max(0, since)
        slice_ = _log_lines[start:]
        total  = len(_log_lines)
    return jsonify({"lines": slice_, "next": start + len(slice_), "total": total})


@app.post("/proxy/chaos")
def proxy_chaos():
    data = flask_request.get_json(silent=True) or {}
    url  = data.get("url", "")
    if not url:
        return jsonify({"status": 0, "body": "missing url"}), 400
    try:
        resp = requests.post(url, timeout=10)
        return jsonify({"status": resp.status_code, "body": resp.text[:500]})
    except requests.exceptions.Timeout:
        return jsonify({"status": 408, "body": "timeout — error may still be logged by service"})
    except requests.exceptions.ConnectionError:
        return jsonify({"status": 0, "body": "connection refused — is the service running?"})
    except Exception as exc:
        return jsonify({"status": 0, "body": str(exc)})


@app.get("/health")
def health():
    return jsonify({
        "status": "ok",
        "log_file": LOG_FILE_PATH,
        "log_file_exists": os.path.exists(LOG_FILE_PATH),
        "lines_buffered": len(_log_lines),
    })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
