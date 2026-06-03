import React, { useEffect, useState, useCallback, useRef } from 'react'
import { fetchTokenUsage, fetchTokenUsageByIncident } from '../api/client'

const AUTO_REFRESH_MS = 15000

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtTokens(n) {
  if (!n) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function fmtCost(usd) {
  if (!usd) return '$0.000000'
  if (usd < 0.000001) return '<$0.000001'
  if (usd < 0.01)    return `$${usd.toFixed(6)}`
  return `$${usd.toFixed(4)}`
}

function relTime(ts) {
  if (!ts) return ''
  const d = Date.now() - new Date(ts + 'Z').getTime()
  const s = Math.floor(d / 1000)
  if (s < 60)  return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60)  return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24)  return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

// ── Service colour palette ────────────────────────────────────────────────────

const SVC_PALETTE = [
  { color: '#818CF8', dot: '#6366F1', bg: 'rgba(99,102,241,0.12)'  },
  { color: '#06B6D4', dot: '#0891B2', bg: 'rgba(6,182,212,0.12)'   },
  { color: '#10B981', dot: '#059669', bg: 'rgba(16,185,129,0.12)'  },
  { color: '#F59E0B', dot: '#D97706', bg: 'rgba(245,158,11,0.12)'  },
  { color: '#C084FC', dot: '#9333EA', bg: 'rgba(168,85,247,0.12)'  },
  { color: '#F87171', dot: '#EF4444', bg: 'rgba(239,68,68,0.12)'   },
]

function svcColor(name = '') {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash)
  return SVC_PALETTE[Math.abs(hash) % SVC_PALETTE.length]
}

// ── Status config ─────────────────────────────────────────────────────────────

function statusCfg(status) {
  switch (status) {
    case 'completed':   return { label: 'Completed',   color: '#10B981', bg: 'rgba(16,185,129,0.15)',  icon: '✓' }
    case 'in_progress': return { label: 'In Progress', color: '#F59E0B', bg: 'rgba(245,158,11,0.15)',  icon: '⟳' }
    case 'failed':      return { label: 'Failed',      color: '#EF4444', bg: 'rgba(239,68,68,0.12)',   icon: '✗' }
    default:            return { label: 'Pending',     color: '#94A3B8', bg: 'rgba(148,163,184,0.1)',  icon: '○' }
  }
}

// ── Shared sub-components ─────────────────────────────────────────────────────

function SourceChip({ source }) {
  const isRca    = source === 'rca_agent'
  const isGemini = source === 'gemini_analysis'
  return (
    <span className={`tu-chip ${isRca ? 'tu-chip-rca' : isGemini ? 'tu-chip-gemini' : 'tu-chip-default'}`}>
      {isRca ? 'RCA Agent' : isGemini ? 'Gemini' : source}
    </span>
  )
}

function TokenBar({ input, output, cacheRead }) {
  const total = (input || 0) + (output || 0) + (cacheRead || 0)
  if (!total) return <div className="tu-bar-empty" />
  const inPct    = (input    / total) * 100
  const outPct   = (output   / total) * 100
  const cachePct = (cacheRead / total) * 100
  return (
    <div className="tu-bar">
      <div className="tu-bar-in"    style={{ width: `${inPct}%`    }} />
      <div className="tu-bar-out"   style={{ width: `${outPct}%`   }} />
      {cachePct > 0 && <div className="tu-bar-cache" style={{ width: `${cachePct}%` }} />}
    </div>
  )
}

function HeroCard({ label, value, sub, accent }) {
  return (
    <div className={`tu-hero-card glass ${accent ? `tu-accent-${accent}` : ''}`}>
      <div className="tu-hero-value">{value}</div>
      <div className="tu-hero-label">{label}</div>
      {sub && <div className="tu-hero-sub">{sub}</div>}
    </div>
  )
}

function ModelCard({ model }) {
  const isRca  = model.source === 'rca_agent'
  const accent = isRca ? 'indigo' : 'cyan'
  return (
    <div className={`tu-model-card glass tu-model-${accent}`}>
      <div className="tu-model-header">
        <div className="tu-model-icon">{isRca ? '⚡' : '✦'}</div>
        <div>
          <div className="tu-model-name">{model.display_name}</div>
          <SourceChip source={model.source} />
        </div>
        <div className="tu-model-calls">{model.call_count} calls</div>
      </div>
      <TokenBar input={model.input_tokens} output={model.output_tokens} cacheRead={model.cache_read_tokens} />
      <div className="tu-bar-legend">
        <span className="tu-legend-dot tu-dot-in" />Input
        <span className="tu-legend-dot tu-dot-out" />Output
        {model.cache_read_tokens > 0 && <><span className="tu-legend-dot tu-dot-cache" />Cache</>}
      </div>
      <div className="tu-model-grid">
        <div className="tu-model-stat">
          <div className="tu-model-stat-val">{fmtTokens(model.input_tokens)}</div>
          <div className="tu-model-stat-lbl">Input</div>
        </div>
        <div className="tu-model-stat">
          <div className="tu-model-stat-val">{fmtTokens(model.output_tokens)}</div>
          <div className="tu-model-stat-lbl">Output</div>
        </div>
        {model.cache_read_tokens > 0 && (
          <div className="tu-model-stat">
            <div className="tu-model-stat-val">{fmtTokens(model.cache_read_tokens)}</div>
            <div className="tu-model-stat-lbl">Cache</div>
          </div>
        )}
        <div className="tu-model-stat">
          <div className="tu-model-stat-val tu-cost">{fmtCost(model.estimated_cost_usd)}</div>
          <div className="tu-model-stat-lbl">Est. cost</div>
        </div>
      </div>
    </div>
  )
}

// ── Incident card (accordion) ─────────────────────────────────────────────────

function IncidentCard({ incident, callRows }) {
  const [open, setOpen] = useState(false)
  const svc = svcColor(incident.service_name)
  const st  = statusCfg(incident.rca_status)

  const relatedCalls = callRows.filter(r => r.error_log_id === incident.error_log_id)
  const totalAll     = (incident.input_tokens || 0) + (incident.output_tokens || 0)

  return (
    <div className="tu-incident-card glass">

      {/* Coloured left accent bar */}
      <div className="tu-incident-accent" style={{ background: svc.dot }} />

      <div className="tu-incident-body">
        {/* ── Top row: identity + status ── */}
        <div
          className="tu-inc-header"
          onClick={() => relatedCalls.length > 0 && setOpen(o => !o)}
          style={{ cursor: relatedCalls.length > 0 ? 'pointer' : 'default' }}
        >
          <div className="tu-inc-identity">
            <span className="tu-inc-dot" style={{ background: svc.dot }} />
            <div className="tu-inc-names">
              <span className="tu-inc-service" style={{ color: svc.color }}>
                {incident.service_name}
              </span>
              <span className="tu-inc-error">{incident.error_type}</span>
            </div>
            <span className="tu-inc-time">{relTime(incident.started_at)}</span>
          </div>

          <div className="tu-inc-meta">
            <span className="tu-inc-status-badge" style={{ color: st.color, background: st.bg }}>
              {st.icon} {st.label}
            </span>
            {incident.max_iteration != null && (
              <span className="tu-inc-pill">{incident.max_iteration} iters</span>
            )}
            <span className="tu-inc-pill tu-inc-calls-count">{incident.call_count} calls</span>
            <span className="tu-inc-cost-val">{fmtCost(incident.total_cost)}</span>
            <span className="tu-inc-tokens-val">{fmtTokens(incident.total_tokens)}</span>
            {relatedCalls.length > 0 && (
              <button className="tu-inc-toggle" aria-label="expand">
                {open ? '▲' : '▼'}
              </button>
            )}
          </div>
        </div>

        {/* ── Token bar ── */}
        <div className="tu-inc-bar-section">
          <TokenBar
            input={incident.input_tokens}
            output={incident.output_tokens}
            cacheRead={incident.cache_read_tokens}
          />
          <div className="tu-inc-bar-labels">
            <span><span className="tu-inc-bar-dot tu-dot-in" />{fmtTokens(incident.input_tokens)} in</span>
            <span><span className="tu-inc-bar-dot tu-dot-out" />{fmtTokens(incident.output_tokens)} out</span>
            {incident.cache_read_tokens > 0 && (
              <span><span className="tu-inc-bar-dot tu-dot-cache" />{fmtTokens(incident.cache_read_tokens)} cache</span>
            )}
            {incident.occurred_at && (
              <span className="tu-inc-occurred">Occurred: {incident.occurred_at.replace('T', ' ')}</span>
            )}
          </div>
        </div>

        {/* ── Expanded: per-call table ── */}
        {open && relatedCalls.length > 0 && (
          <div className="tu-inc-calls-wrap">
            <div className="tu-inc-calls-title">API Calls for this incident</div>
            <div className="tu-table-wrap">
              <table className="tu-table tu-inc-inner-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Model</th>
                    <th>Source</th>
                    <th className="tu-num">Input</th>
                    <th className="tu-num">Output</th>
                    <th className="tu-num">Cache</th>
                    <th className="tu-num">Cost</th>
                    <th className="tu-num">Iter</th>
                  </tr>
                </thead>
                <tbody>
                  {relatedCalls.map(row => (
                    <tr key={row.id}>
                      <td className="tu-time">{relTime(row.created_at)}</td>
                      <td><span className="tu-model-label">{row.display_name}</span></td>
                      <td><SourceChip source={row.source} /></td>
                      <td className="tu-num">{fmtTokens(row.input_tokens)}</td>
                      <td className="tu-num tu-out">{fmtTokens(row.output_tokens)}</td>
                      <td className="tu-num tu-cache">{fmtTokens(row.cache_read_tokens)}</td>
                      <td className="tu-num tu-cost">{fmtCost(row.estimated_cost_usd)}</td>
                      <td className="tu-num tu-iter">{row.iteration_num ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="tu-inc-foot">
                    <td colSpan={3} style={{ fontWeight: 600, color: 'var(--text-secondary)', fontSize: 11 }}>Total</td>
                    <td className="tu-num" style={{ fontWeight: 700 }}>{fmtTokens(relatedCalls.reduce((s, r) => s + r.input_tokens, 0))}</td>
                    <td className="tu-num tu-out" style={{ fontWeight: 700 }}>{fmtTokens(relatedCalls.reduce((s, r) => s + r.output_tokens, 0))}</td>
                    <td className="tu-num tu-cache" style={{ fontWeight: 700 }}>{fmtTokens(relatedCalls.reduce((s, r) => s + r.cache_read_tokens, 0))}</td>
                    <td className="tu-num tu-cost" style={{ fontWeight: 700 }}>{fmtCost(relatedCalls.reduce((s, r) => s + r.estimated_cost_usd, 0))}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── All-calls table (collapsible) ─────────────────────────────────────────────

function AllCallsSection({ rows }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="tu-section">
      <div className="tu-section-header" style={{ cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
        <h3 className="tu-section-title">All API Calls</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="tu-section-count">{rows.length} rows</span>
          <button className="tu-collapse-btn">{open ? '▲ Hide' : '▼ Show'}</button>
        </div>
      </div>
      {open && (
        <div className="tu-table-wrap">
          <table className="tu-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Incident</th>
                <th>Model</th>
                <th>Source</th>
                <th className="tu-num">Input</th>
                <th className="tu-num">Output</th>
                <th className="tu-num">Cache</th>
                <th className="tu-num">Total</th>
                <th className="tu-num">Est. Cost</th>
                <th className="tu-num">Iter</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.id}>
                  <td className="tu-time">{relTime(row.created_at)}</td>
                  <td>
                    {row.error_log_id
                      ? <span className="tu-inc-id-chip">{row.error_log_id.slice(0, 8)}…</span>
                      : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                  </td>
                  <td><span className="tu-model-label">{row.display_name}</span></td>
                  <td><SourceChip source={row.source} /></td>
                  <td className="tu-num">{fmtTokens(row.input_tokens)}</td>
                  <td className="tu-num tu-out">{fmtTokens(row.output_tokens)}</td>
                  <td className="tu-num tu-cache">{fmtTokens(row.cache_read_tokens)}</td>
                  <td className="tu-num tu-total">{fmtTokens(row.input_tokens + row.output_tokens)}</td>
                  <td className="tu-num tu-cost">{fmtCost(row.estimated_cost_usd)}</td>
                  <td className="tu-num tu-iter">{row.iteration_num ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function TokenUsage() {
  const [data,       setData]       = useState(null)
  const [incidents,  setIncidents]  = useState([])
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState(null)
  const [countdown,  setCountdown]  = useState(AUTO_REFRESH_MS / 1000)
  const [refreshing, setRefreshing] = useState(false)
  const timerRef = useRef(null)
  const countRef = useRef(null)

  const load = useCallback((manual = false) => {
    if (manual) setRefreshing(true)
    Promise.all([
      fetchTokenUsage(200),
      fetchTokenUsageByIncident(50),
    ])
      .then(([usage, byInc]) => {
        setData(usage)
        setIncidents(byInc.incidents || [])
        setError(null)
        setCountdown(AUTO_REFRESH_MS / 1000)
      })
      .catch(e => setError(e.message))
      .finally(() => {
        setLoading(false)
        setRefreshing(false)
      })
  }, [])

  useEffect(() => {
    load()
    timerRef.current = setInterval(() => load(), AUTO_REFRESH_MS)
    countRef.current = setInterval(
      () => setCountdown(c => (c <= 1 ? AUTO_REFRESH_MS / 1000 : c - 1)),
      1000,
    )
    return () => {
      clearInterval(timerRef.current)
      clearInterval(countRef.current)
    }
  }, [load])

  if (loading) {
    return (
      <div className="tu-page">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="skeleton" style={{ height: i === 0 ? 80 : 120, borderRadius: 12, marginBottom: 12 }} />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="tu-page">
        <div className="empty-state">
          <div className="empty-state-icon">!</div>
          <div className="empty-state-title">Failed to load token usage</div>
          <div className="empty-state-desc">{error}</div>
          <button className="btn btn-primary mt-3" onClick={() => load(true)}>Retry</button>
        </div>
      </div>
    )
  }

  const { summary, by_model, recent } = data || {}
  const s = summary || {}
  const callRows = recent || []

  return (
    <div className="tu-page">

      {/* ── Header ── */}
      <div className="tu-header">
        <div>
          <h2 className="tu-title">Token Consumption</h2>
          <p className="tu-subtitle">
            Real values captured from API responses · Costs estimated from published pricing
          </p>
        </div>
        <div className="refresh-controls">
          <button className="btn btn-secondary refresh-btn" onClick={() => load(true)} disabled={refreshing}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
              strokeLinecap="round" strokeLinejoin="round"
              style={{ animation: refreshing ? 'spin 0.7s linear infinite' : 'none' }}>
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
              <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
              <path d="M8 16H3v5" />
            </svg>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          <span className="refresh-countdown">{countdown}s</span>
        </div>
      </div>

      {/* ── Hero stats ── */}
      <div className="tu-hero-row">
        <HeroCard
          label="Total Tokens"
          value={fmtTokens(s.total_tokens)}
          sub={`${fmtTokens(s.total_input)} in · ${fmtTokens(s.total_output)} out`}
          accent="indigo"
        />
        <HeroCard
          label="Estimated Cost"
          value={fmtCost(s.total_cost)}
          sub="Based on published pricing"
          accent="emerald"
        />
        <HeroCard
          label="Total API Calls"
          value={s.total_calls || 0}
          sub={`${s.rca_calls || 0} RCA · ${s.gemini_calls || 0} Gemini`}
          accent="cyan"
        />
        <HeroCard
          label="Cache Read"
          value={fmtTokens(s.total_cache_read || 0)}
          sub={s.total_cache_read ? 'Served from prompt cache' : 'No cache hits yet'}
          accent={s.total_cache_read ? 'amber' : 'default'}
        />
      </div>

      {/* ── By Incident ── */}
      <section className="tu-section">
        <div className="tu-section-header">
          <div>
            <h3 className="tu-section-title">By Incident</h3>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              Token consumption mapped to each RCA incident
            </p>
          </div>
          <span className="tu-section-count">{incidents.length} incidents</span>
        </div>

        {incidents.length === 0 ? (
          <div className="empty-state" style={{ padding: '32px 0' }}>
            <div className="empty-state-icon">
              <svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <div className="empty-state-title">No incident data yet</div>
            <div className="empty-state-desc">Run an RCA to see per-incident token breakdown here.</div>
          </div>
        ) : (
          <div className="tu-incident-list">
            {incidents.map(inc => (
              <IncidentCard
                key={inc.error_log_id}
                incident={inc}
                callRows={callRows}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── Model Breakdown ── */}
      {by_model && by_model.length > 0 && (
        <section className="tu-section">
          <h3 className="tu-section-title">Model Breakdown</h3>
          <div className="tu-model-grid-outer">
            {by_model.map(m => (
              <ModelCard key={`${m.model}-${m.source}`} model={m} />
            ))}
          </div>
        </section>
      )}

      {/* ── All Calls (collapsible) ── */}
      <AllCallsSection rows={callRows} />

      {/* ── Pricing note ── */}
      <div className="tu-pricing-note">
        Pricing reference (per 1M tokens): Claude Haiku 4.5 — $0.80 in / $4.00 out &nbsp;·&nbsp;
        Claude Sonnet 4.6 — $3.00 in / $15.00 out &nbsp;·&nbsp;
        Gemini 2.5 Flash — $0.15 in / $0.60 out
      </div>

    </div>
  )
}
