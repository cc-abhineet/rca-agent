import React, { useEffect, useState, useCallback, useMemo } from 'react'
import { fetchLogs, fetchDatadogLogs } from '../api/client'
import { useApp } from '../context/AppContext'

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
  const text = Array.isArray(content) ? content.join('\n') : String(content || '')

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

function LogCard({ log, isDatadog, onRunRCA }) {
  const [expanded, setExpanded] = useState(false)
  const isDuplicate = !!log.duplicate_of || log.rca_status === 'duplicate'
  const borderCls = riskClass(log.risk_level || log.level)
  const text = log.gemini_analysis || log.message || log.error_message || ''
  const suggestions = (log.gemini_suggestions || '').split(';').map(s => s.trim()).filter(Boolean)
  const stackLines = Array.isArray(log.stack_trace)
    ? log.stack_trace
    : (log.stack_trace ? [log.stack_trace] : [])

  return (
    <div className="glass log-card">
      <div className={`log-card-border ${borderCls}`} />
      <div className="log-card-inner">
        {/* Top row */}
        <div className="log-card-top">
          <span className="log-service-badge">{log.service_name || log.service || 'unknown'}</span>
          <span className="log-error-type">{log.error_type || log.level || 'Error'}</span>
          {isDatadog && <span className="dd-badge">DD</span>}
          <span className="log-time">{relativeTime(log.occurred_at || log.timestamp)}</span>
          <SeverityBadge value={log.severity || log.level} />
          <RiskBadge value={log.risk_level} />
        </div>

        {/* Body */}
        <div className="log-card-body">{text}</div>

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
          {log.rca_status && (
            <span className={`status-badge status-${log.rca_status}`}>
              <span className="dot" />
              {log.rca_status.replace('_', ' ')}
            </span>
          )}
          <div className="log-card-actions">
            {!isDatadog && !isDuplicate && (
              <button
                className="btn btn-primary"
                style={{ fontSize: 12, padding: '4px 10px' }}
                onClick={() => onRunRCA(log.id, log.service_name, log.error_type)}
              >
                Run RCA →
              </button>
            )}
            {isDuplicate && (
              <a
                className="btn btn-secondary"
                style={{ fontSize: 12, padding: '4px 10px' }}
                href={`/rca/${log.id}/report`}
                target="_blank"
                rel="noreferrer"
              >
                View Report
              </a>
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

        {/* Expanded */}
        {expanded && (
          <div className="log-expand">
            {text && text !== (log.error_message || '') && (
              <div className="log-analysis-full">{text}</div>
            )}
            {log.error_message && log.error_message !== text && (
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 8 }}>
                {log.error_message}
              </p>
            )}
            {suggestions.length > 0 && (
              <div className="log-suggestions">
                {suggestions.map((s, i) => (
                  <div key={i} className="log-suggestion">{s}</div>
                ))}
              </div>
            )}
            {(stackLines.length > 0 || log.source) && (
              <CodeBlock content={stackLines.length ? stackLines : log.message} />
            )}
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
        <div key={i} className="glass" style={{ borderRadius: 14, padding: '16px 16px 16px 22px', marginBottom: 0 }}>
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

const RISK_FILTERS = ['All', 'Critical', 'High', 'Medium', 'Low']

export default function LogViewer() {
  const { logSource, openStream } = useApp()

  const [logs, setLogs]         = useState([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState(null)

  // Filters
  const [search, setSearch]       = useState('')
  const [riskFilter, setRisk]     = useState('All')
  const [serviceFilter, setService] = useState('')

  // Pagination (local only)
  const [page, setPage]           = useState(1)
  const [totalPages, setTotalPages] = useState(1)

  const LIMIT = 50

  const loadLocal = useCallback(() => {
    const params = { page, limit: LIMIT }
    if (serviceFilter) params.service = serviceFilter
    if (riskFilter !== 'All') params.risk_level = riskFilter.toLowerCase()
    fetchLogs(params)
      .then(data => {
        setLogs(data.items || [])
        setTotalPages(data.pages || 1)
        setError(null)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [page, serviceFilter, riskFilter])

  const loadDatadog = useCallback(() => {
    fetchDatadogLogs(50)
      .then(data => {
        setLogs(data.items || [])
        setTotalPages(1)
        setError(null)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    setLoading(true)
    setPage(1)
  }, [logSource, riskFilter, serviceFilter])

  useEffect(() => {
    if (logSource === 'local') {
      loadLocal()
      const id = setInterval(loadLocal, 8000)
      return () => clearInterval(id)
    } else {
      loadDatadog()
    }
  }, [logSource, loadLocal, loadDatadog])

  // Client-side search filter
  const filtered = useMemo(() => {
    if (!search.trim()) return logs
    const q = search.toLowerCase()
    return logs.filter(l =>
      (l.service_name || l.service || '').toLowerCase().includes(q) ||
      (l.error_type || l.level || '').toLowerCase().includes(q) ||
      (l.error_message || l.message || '').toLowerCase().includes(q) ||
      (l.gemini_analysis || '').toLowerCase().includes(q)
    )
  }, [logs, search])

  // Unique services for dropdown (local mode)
  const services = useMemo(() => {
    const s = new Set(logs.map(l => l.service_name || l.service).filter(Boolean))
    return Array.from(s).sort()
  }, [logs])

  return (
    <div className="log-viewer">
      {/* Filter bar */}
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
            placeholder="Search logs..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        {logSource === 'local' && (
          <select
            className="filter-service-select"
            value={serviceFilter}
            onChange={e => setService(e.target.value)}
          >
            <option value="">All Services</option>
            {services.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        )}

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
      </div>

      {/* Content */}
      {loading ? (
        <div className="log-list"><SkeletonCards /></div>
      ) : error ? (
        <div className="empty-state">
          <div className="empty-state-icon">!</div>
          <div className="empty-state-title">Failed to load logs</div>
          <div className="empty-state-desc">{error}</div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">
            <svg width="26" height="26" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div className="empty-state-title">No incidents detected</div>
          <div className="empty-state-desc">
            {logSource === 'datadog'
              ? 'No Datadog logs found. Check your credentials in Settings.'
              : 'System is nominal. All clear.'}
          </div>
        </div>
      ) : (
        <div className="log-list">
          {filtered.map(log => (
            <LogCard
              key={log.id}
              log={log}
              isDatadog={logSource === 'datadog'}
              onRunRCA={openStream}
            />
          ))}
        </div>
      )}

      {/* Pagination (local only) */}
      {logSource === 'local' && !loading && !error && totalPages > 1 && (
        <div className="log-pagination">
          <button
            className="page-btn"
            disabled={page <= 1}
            onClick={() => setPage(p => p - 1)}
          >
            ‹
          </button>
          {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
            const p = i + 1
            return (
              <button
                key={p}
                className={`page-btn${page === p ? ' active' : ''}`}
                onClick={() => setPage(p)}
              >
                {p}
              </button>
            )
          })}
          <button
            className="page-btn"
            disabled={page >= totalPages}
            onClick={() => setPage(p => p + 1)}
          >
            ›
          </button>
          <span className="page-info">Page {page} of {totalPages}</span>
        </div>
      )}
    </div>
  )
}
