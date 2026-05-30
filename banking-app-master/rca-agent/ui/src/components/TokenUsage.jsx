import React, { useEffect, useState, useCallback, useRef } from 'react'
import { fetchTokenUsage } from '../api/client'

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
  return `${Math.floor(m / 60)}h ago`
}

// ── Source label ──────────────────────────────────────────────────────────────

function SourceChip({ source }) {
  const isRca    = source === 'rca_agent'
  const isGemini = source === 'gemini_analysis'
  return (
    <span className={`tu-chip ${isRca ? 'tu-chip-rca' : isGemini ? 'tu-chip-gemini' : 'tu-chip-default'}`}>
      {isRca ? 'RCA Agent' : isGemini ? 'Gemini' : source}
    </span>
  )
}

// ── Hero stat card ────────────────────────────────────────────────────────────

function HeroCard({ label, value, sub, accent }) {
  return (
    <div className={`tu-hero-card glass ${accent ? `tu-accent-${accent}` : ''}`}>
      <div className="tu-hero-value">{value}</div>
      <div className="tu-hero-label">{label}</div>
      {sub && <div className="tu-hero-sub">{sub}</div>}
    </div>
  )
}

// ── Token split bar ───────────────────────────────────────────────────────────

function TokenBar({ input, output, cacheRead }) {
  const total = input + output + cacheRead
  if (!total) return <div className="tu-bar-empty" />
  const inPct    = (input    / total) * 100
  const outPct   = (output   / total) * 100
  const cachePct = (cacheRead / total) * 100
  return (
    <div className="tu-bar" title={`Input: ${fmtTokens(input)} | Output: ${fmtTokens(output)} | Cache: ${fmtTokens(cacheRead)}`}>
      <div className="tu-bar-in"    style={{ width: `${inPct}%` }} />
      <div className="tu-bar-out"   style={{ width: `${outPct}%` }} />
      <div className="tu-bar-cache" style={{ width: `${cachePct}%` }} />
    </div>
  )
}

// ── Model breakdown card ──────────────────────────────────────────────────────

function ModelCard({ model }) {
  const isRca    = model.source === 'rca_agent'
  const accent   = isRca ? 'indigo' : 'cyan'
  const pct      = (model.total_tokens === 0) ? 0 : 100

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

      <TokenBar
        input={model.input_tokens}
        output={model.output_tokens}
        cacheRead={model.cache_read_tokens}
      />

      <div className="tu-bar-legend">
        <span className="tu-legend-dot tu-dot-in" />Input
        <span className="tu-legend-dot tu-dot-out" />Output
        {model.cache_read_tokens > 0 && <><span className="tu-legend-dot tu-dot-cache" />Cache read</>}
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
            <div className="tu-model-stat-lbl">Cache read</div>
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

// ── Recent calls table ────────────────────────────────────────────────────────

function RecentTable({ rows }) {
  if (!rows.length) {
    return (
      <div className="empty-state" style={{ padding: '32px 0' }}>
        <div className="empty-state-icon">
          <svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M3 14h18m-9-4v8m-7 0h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        </div>
        <div className="empty-state-title">No API calls recorded yet</div>
        <div className="empty-state-desc">Run an RCA or trigger an incident to see token usage here.</div>
      </div>
    )
  }

  return (
    <div className="tu-table-wrap">
      <table className="tu-table">
        <thead>
          <tr>
            <th>Time</th>
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
                <span className="tu-model-label">{row.display_name}</span>
              </td>
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
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function TokenUsage() {
  const [data, setData]           = useState(null)
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState(null)
  const [countdown, setCountdown] = useState(AUTO_REFRESH_MS / 1000)
  const [refreshing, setRefreshing] = useState(false)
  const timerRef = useRef(null)
  const countRef = useRef(null)

  const load = useCallback((manual = false) => {
    if (manual) setRefreshing(true)
    fetchTokenUsage(100)
      .then(d => {
        setData(d)
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
        {[...Array(4)].map((_, i) => (
          <div key={i} className="skeleton" style={{ height: 80, borderRadius: 12, marginBottom: 12 }} />
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

  const savedCache = s.total_cache_read || 0

  return (
    <div className="tu-page">

      {/* ── Header ── */}
      <div className="tu-header">
        <div>
          <h2 className="tu-title">Token Consumption</h2>
          <p className="tu-subtitle">
            Real values captured from API responses.
            Costs are estimated based on published pricing.
          </p>
        </div>
        <div className="refresh-controls">
          <button
            className="btn btn-secondary refresh-btn"
            onClick={() => load(true)}
            disabled={refreshing}
          >
            <svg
              width="13" height="13" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2.5"
              strokeLinecap="round" strokeLinejoin="round"
              style={{ animation: refreshing ? 'spin 0.7s linear infinite' : 'none' }}
            >
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
          label="Cache Read Tokens"
          value={fmtTokens(savedCache)}
          sub={savedCache ? 'Served from prompt cache' : 'No cache hits yet'}
          accent={savedCache ? 'amber' : 'default'}
        />
      </div>

      {/* ── Model breakdown ── */}
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

      {/* ── Recent calls ── */}
      <section className="tu-section">
        <div className="tu-section-header">
          <h3 className="tu-section-title">Recent API Calls</h3>
          <span className="tu-section-count">{recent?.length || 0} rows</span>
        </div>
        <RecentTable rows={recent || []} />
      </section>

      {/* ── Pricing note ── */}
      <div className="tu-pricing-note">
        Pricing reference (per 1M tokens): Claude Haiku 4.5 — $0.80 in / $4.00 out &nbsp;·&nbsp;
        Claude Sonnet 4.6 — $3.00 in / $15.00 out &nbsp;·&nbsp;
        Gemini 2.5 Flash — $0.15 in / $0.60 out
      </div>
    </div>
  )
}
