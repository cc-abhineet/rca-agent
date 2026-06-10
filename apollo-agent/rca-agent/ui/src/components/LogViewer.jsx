import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { fetchLogs, cancelRCA } from '../api/client'
import { useApp } from '../context/AppContext'

const AUTO_REFRESH_MS = 10000

function relativeTime(ts) {
  if (!ts) return ''
  const diff = Date.now() - new Date(ts + 'Z').getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60)  return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60)  return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24)  return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function riskClass(v) {
  const r = (v || '').toLowerCase()
  if (r === 'critical') return 'critical'
  if (r === 'high')     return 'high'
  if (r === 'medium')   return 'medium'
  if (r === 'low')      return 'low'
  return 'default'
}

function SeverityBadge({ value }) {
  const v = (value || '').toLowerCase()
  const cls = v === 'critical' ? 'badge-critical'
            : v === 'error'    ? 'badge-error'
            : v === 'warning' || v === 'warn' ? 'badge-warning'
            : v === 'high'     ? 'badge-high'
            : 'badge-gray'
  return <span className={`badge ${cls}`}>{value || 'ERROR'}</span>
}

function RiskBadge({ value }) {
  if (!value) return null
  const v = value.toLowerCase()
  const cls = v === 'critical' ? 'badge-critical'
            : v === 'high'     ? 'badge-high'
            : v === 'medium'   ? 'badge-medium'
            : v === 'low'      ? 'badge-low'
            : 'badge-gray'
  return <span className={`badge ${cls}`}>{value}</span>
}

function CodeBlock({ content }) {
  const [copied, setCopied] = useState(false)
  const text = Array.isArray(content)
    ? content.map(f => (typeof f === 'object' ? f.text || '' : f)).join('\n')
    : String(content || '')

  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="code-block">
      <button className={`copy-btn${copied ? ' copied' : ''}`} onClick={copy}>
        {copied ? 'Copied!' : 'Copy'}
      </button>
      <pre>{text}</pre>
    </div>
  )
}

function SourceTag({ metadata }) {
  const src = typeof metadata === 'object' ? metadata?.source : null
  if (!src || src === 'db_watcher') return null
  return <span className="dd-badge">DD</span>
}

function LogCard({ log, onRunRCA, onCancel }) {
  const [expanded, setExpanded] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const isDuplicate = !!log.duplicate_of || log.rca_status === 'duplicate'
  const borderCls = riskClass(log.risk_level)
  const bodyText  = log.gemini_analysis || log.error_message || ''
  const suggestions = (log.gemini_suggestions || '').split(';').map(s => s.trim()).filter(Boolean)

  const stackTrace = Array.isArray(log.stack_trace)
    ? log.stack_trace
    : log.stack_trace ? [{ text: String(log.stack_trace) }] : []

  return (
    <div className="glass log-card">
      <div className={`log-card-border ${borderCls}`} />
      <div className="log-card-inner">
        {/* Top row */}
        <div className="log-card-top">
          <span className="log-service-badge">{log.service_name || 'unknown'}</span>
          <span className="log-error-type">{log.error_type || 'Error'}</span>
          <SourceTag metadata={log.metadata} />
          <span className="log-time">{relativeTime(log.occurred_at)}</span>
          <SeverityBadge value={log.severity} />
          <RiskBadge value={log.risk_level} />
        </div>

        {/* Body */}
        {bodyText && <div className="log-card-body">{bodyText}</div>}

        {/* Footer */}
        <div className="log-card-footer">
          {log.gemini_category && (
            <span className="badge badge-indigo">{log.gemini_category}</span>
          )}
          {isDuplicate && (
            <span className="badge badge-purple" title={`Duplicate of incident ${(log.duplicate_of || '').slice(0, 8)}`}>
              ⧉ Duplicate
            </span>
          )}
          {log.rca_status && !isDuplicate && (
            <span className={`status-badge status-${log.rca_status}`}>
              <span className="dot" />
              {log.rca_status.replace('_', ' ')}
            </span>
          )}
          <div className="log-card-actions">
            {!isDuplicate && log.rca_status === 'pending' && (
              <button
                className="btn btn-primary"
                style={{ fontSize: 12, padding: '4px 10px' }}
                onClick={() => onRunRCA(log.id, log.service_name, log.error_type)}
              >
                Run RCA →
              </button>
            )}
            {isDuplicate && (
              <button
                className="btn btn-secondary"
                style={{ fontSize: 12, padding: '4px 10px' }}
                onClick={() => window.open(`/rca/${log.duplicate_of || log.id}/report`, '_blank')}
              >
                View Report
              </button>
            )}
            {log.rca_status === 'in_progress' && (
              <button
                className="btn btn-danger"
                style={{ fontSize: 12, padding: '4px 10px' }}
                disabled={cancelling}
                onClick={async () => {
                  setCancelling(true)
                  try { await onCancel(log.id) } finally { setCancelling(false) }
                }}
              >
                {cancelling ? 'Cancelling…' : '⏹ Stop RCA'}
              </button>
            )}
            {log.rca_status === 'completed' && (
              <button
                className="btn btn-secondary"
                style={{ fontSize: 12, padding: '4px 10px' }}
                onClick={() => window.open(`/rca/${log.id}/report`, '_blank')}
              >
                View Report
              </button>
            )}
            <button
              className="btn btn-secondary"
              style={{ fontSize: 12, padding: '4px 10px' }}
              onClick={() => setExpanded(e => !e)}
            >
              {expanded ? 'Collapse' : 'Details'}
            </button>
          </div>
        </div>

        {/* Expanded detail */}
        {expanded && (
          <div className="log-expand">
            {log.error_message && (
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>
                {log.error_message}
              </p>
            )}
            {suggestions.length > 0 && (
              <div className="log-suggestions">
                {suggestions.map((s, i) => (
                  <div key={i} className="log-suggestion">
                    <span style={{ color: 'var(--indigo)', marginRight: 6 }}>▸</span>{s}
                  </div>
                ))}
              </div>
            )}
            {stackTrace.length > 0 && <CodeBlock content={stackTrace} />}
          </div>
        )}
      </div>
    </div>
  )
}

function SkeletonCards() {
  return (
    <>
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="glass" style={{ borderRadius: 14, padding: '16px 16px 16px 22px' }}>
          <div className="flex gap-2 items-center mb-3">
            <div className="skeleton" style={{ width: 64, height: 20 }} />
            <div className="skeleton" style={{ width: 140, height: 18 }} />
            <div className="skeleton" style={{ width: 50, height: 16, marginLeft: 'auto' }} />
          </div>
          <div className="skeleton skeleton-line full" />
          <div className="skeleton skeleton-line med mt-2" />
        </div>
      ))}
    </>
  )
}

function RefreshIcon({ spinning }) {
  return (
    <svg
      width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.5"
      strokeLinecap="round" strokeLinejoin="round"
      style={{ animation: spinning ? 'spin 0.7s linear infinite' : 'none' }}
    >
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  )
}

const RISK_FILTERS = ['All', 'Critical', 'High', 'Medium', 'Low']

export default function LogViewer() {
  const { openStream, showToast } = useApp()
  const loadLogsRef = useRef(null)  // allows handleCancel to call loadLogs without stale closure

  const handleCancel = useCallback(async (id) => {
    await cancelRCA(id)
    showToast('RCA cancelled', 'info')
    if (loadLogsRef.current) loadLogsRef.current(true)
  }, [showToast])

  const [logs, setLogs]             = useState([])
  const [loading, setLoading]       = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError]           = useState(null)
  const [lastRefreshed, setLastRefreshed] = useState(null)

  // Countdown to next auto-refresh
  const [countdown, setCountdown]   = useState(AUTO_REFRESH_MS / 1000)

  // Filters
  const [search, setSearch]           = useState('')
  const [riskFilter, setRisk]         = useState('All')
  const [serviceFilter, setService]   = useState('')

  // Pagination
  const [page, setPage]               = useState(1)
  const [totalPages, setTotalPages]   = useState(1)
  const [total, setTotal]             = useState(0)

  const LIMIT = 50
  const timerRef = useRef(null)
  const countRef = useRef(null)

  const loadLogs = useCallback((isManual = false) => {
    if (isManual) setRefreshing(true)
    const params = { page, limit: LIMIT }
    if (serviceFilter) params.service = serviceFilter
    if (riskFilter !== 'All') params.risk_level = riskFilter.toLowerCase()

    fetchLogs(params)
      .then(data => {
        setLogs(data.items || [])
        setTotalPages(data.pages || 1)
        setTotal(data.total || 0)
        setError(null)
        setLastRefreshed(new Date())
        setCountdown(AUTO_REFRESH_MS / 1000)
      })
      .catch(e => setError(e.message))
      .finally(() => {
        setLoading(false)
        setRefreshing(false)
      })
  }, [page, serviceFilter, riskFilter])

  // Keep ref current so handleCancel can call loadLogs without a stale closure
  useEffect(() => { loadLogsRef.current = loadLogs }, [loadLogs])

  // Initial load + auto-refresh timer
  useEffect(() => {
    setLoading(true)
    loadLogs()

    // Auto-refresh every AUTO_REFRESH_MS
    timerRef.current = setInterval(() => loadLogs(), AUTO_REFRESH_MS)

    // Countdown ticker
    countRef.current = setInterval(() => {
      setCountdown(c => (c <= 1 ? AUTO_REFRESH_MS / 1000 : c - 1))
    }, 1000)

    return () => {
      clearInterval(timerRef.current)
      clearInterval(countRef.current)
    }
  }, [loadLogs])

  // Reset page when filters change
  useEffect(() => {
    setPage(1)
  }, [riskFilter, serviceFilter])

  // Client-side search
  const filtered = useMemo(() => {
    if (!search.trim()) return logs
    const q = search.toLowerCase()
    return logs.filter(l =>
      (l.service_name || '').toLowerCase().includes(q) ||
      (l.error_type || '').toLowerCase().includes(q) ||
      (l.error_message || '').toLowerCase().includes(q) ||
      (l.gemini_analysis || '').toLowerCase().includes(q)
    )
  }, [logs, search])

  // Unique services for dropdown
  const services = useMemo(() => {
    const s = new Set(logs.map(l => l.service_name).filter(Boolean))
    return Array.from(s).sort()
  }, [logs])

  return (
    <div className="log-viewer">
      {/* Filter + refresh bar */}
      <div className="glass log-filter-bar">
        <div className="filter-search-wrap">
          <span className="filter-search-icon">
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </span>
          <input
            type="text"
            className="filter-search"
            placeholder="Search service, error type, analysis…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        <select
          className="filter-service-select"
          value={serviceFilter}
          onChange={e => setService(e.target.value)}
        >
          <option value="">All Services</option>
          {services.map(s => <option key={s} value={s}>{s}</option>)}
        </select>

        <div className="filter-pills">
          {RISK_FILTERS.map(r => (
            <button
              key={r}
              className={`filter-pill${riskFilter === r ? ` active-${r.toLowerCase()}` : ''}`}
              onClick={() => setRisk(r)}
            >
              {r}
            </button>
          ))}
        </div>

        {/* Refresh controls */}
        <div className="refresh-controls">
          <button
            className="btn btn-secondary refresh-btn"
            onClick={() => loadLogs(true)}
            disabled={refreshing}
            title="Refresh now"
          >
            <RefreshIcon spinning={refreshing} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          <span className="refresh-countdown" title="Auto-refreshes every 10s">
            {countdown}s
          </span>
        </div>
      </div>

      {/* Row count */}
      {!loading && !error && (
        <div className="log-meta-row">
          <span className="log-count">
            {filtered.length} of {total} incident{total !== 1 ? 's' : ''}
          </span>
          {lastRefreshed && (
            <span className="log-refreshed">
              Updated {relativeTime(lastRefreshed.toISOString().replace('Z', ''))}
            </span>
          )}
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="log-list"><SkeletonCards /></div>
      ) : error ? (
        <div className="empty-state">
          <div className="empty-state-icon">!</div>
          <div className="empty-state-title">Failed to load logs</div>
          <div className="empty-state-desc">{error}</div>
          <button className="btn btn-primary mt-3" onClick={() => loadLogs(true)}>
            Retry
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">
            <svg width="26" height="26" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div className="empty-state-title">No incidents detected</div>
          <div className="empty-state-desc">System is nominal. Trigger an error to see it here.</div>
        </div>
      ) : (
        <div className="log-list">
          {filtered.map(log => (
            <LogCard key={log.id} log={log} onRunRCA={openStream} onCancel={handleCancel} />
          ))}
        </div>
      )}

      {/* Pagination */}
      {!loading && !error && totalPages > 1 && (
        <div className="log-pagination">
          <button className="page-btn" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>‹</button>
          {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
            const p = i + 1
            return (
              <button
                key={p}
                className={`page-btn${page === p ? ' active' : ''}`}
                onClick={() => setPage(p)}
              >{p}</button>
            )
          })}
          <button className="page-btn" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>›</button>
          <span className="page-info">Page {page} / {totalPages}</span>
        </div>
      )}
    </div>
  )
}
