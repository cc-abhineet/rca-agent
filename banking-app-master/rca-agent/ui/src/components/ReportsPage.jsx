import React, { useEffect, useState, useCallback } from 'react'
import { fetchLogs, fetchLog } from '../api/client'

// ── Helpers ─────────────────────────────────────────────────────────────────

function fmtDate(ts) {
  if (!ts) return '—'
  try {
    return new Date(ts).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  } catch { return ts }
}

function confidenceColor(conf) {
  if (!conf) return 'gray'
  const c = conf.toLowerCase()
  if (c === 'high')   return 'high'
  if (c === 'medium') return 'medium'
  return 'low'
}

function downloadHtmlReport(id, service, date) {
  fetch(`/rca/${id}/report`)
    .then(r => r.text())
    .then(html => {
      const blob = new Blob([html], { type: 'text/html' })
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      const d    = date ? new Date(date).toISOString().split('T')[0] : 'report'
      a.href     = url
      a.download = `rca-report-${(service || 'unknown').replace(/\s+/g, '-')}-${d}.html`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    })
    .catch(() => window.open(`/rca/${id}/report`, '_blank'))
}

// ── Report Detail Panel ──────────────────────────────────────────────────────

function TimelinePanel({ timeline }) {
  if (!timeline?.length) return <div className="rdp-empty">No timeline events</div>
  return (
    <div className="rdp-timeline">
      {timeline.map((ev, i) => (
        <div key={i} className="rdp-tl-item">
          <div className="rdp-tl-dot" />
          <div className="rdp-tl-content">
            <div className="rdp-tl-ts">{fmtDate(ev.timestamp)}</div>
            <div className="rdp-tl-event">{ev.event}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

function SolutionsPanel({ solutions }) {
  if (!solutions?.length) return <div className="rdp-empty">No solutions</div>
  const sorted = [...solutions].sort((a, b) => (a.priority || 99) - (b.priority || 99))
  return (
    <div className="rdp-solutions">
      {sorted.map((s, i) => (
        <div key={i} className="rdp-sol-card">
          <div className="rdp-sol-header">
            <span className="rdp-sol-num">{s.priority || i + 1}</span>
            <span className="rdp-sol-title">{s.title}</span>
            {s.effort && <span className={`rdp-effort-badge rdp-effort-${(s.effort || '').replace(/\s+/g, '-').toLowerCase()}`}>{s.effort}</span>}
          </div>
          <div className="rdp-sol-desc">{s.description}</div>
        </div>
      ))}
    </div>
  )
}

function ReportDetailPanel({ report, item, onClose }) {
  if (!report) {
    return (
      <div className="report-detail-panel report-detail-panel--open">
        <div className="rdp-header">
          <button className="rdp-close" onClick={onClose}>✕</button>
        </div>
        <div className="rdp-loading">
          <div className="rv2-spinner-sm" style={{ width: 24, height: 24 }} />
          <span>Loading report…</span>
        </div>
      </div>
    )
  }

  const rc      = report.rca_result || {}
  const summary = rc.incident_summary || {}
  const root    = rc.root_cause || {}
  const meta    = rc.analysis_metadata || {}
  const conf    = root.confidence || 'N/A'
  const confCls = confidenceColor(conf)

  return (
    <div className="report-detail-panel report-detail-panel--open">
      {/* Header */}
      <div className="rdp-header">
        <div className="rdp-header-left">
          <div className="rdp-service">{report.service_name || rc.service_name || '—'}</div>
          {report.severity && (
            <span className={`badge badge-${(report.severity || '').toLowerCase()}`}>{report.severity}</span>
          )}
        </div>
        <div className="rdp-header-right">
          <button
            className="btn btn-secondary sm rdp-dl-btn"
            onClick={() => downloadHtmlReport(report.id, report.service_name, report.rca_completed_at)}
            title="Download as HTML / Print as PDF"
          >
            📥 PDF
          </button>
          <a
            href={`/rca/${report.id}/report`}
            target="_blank"
            rel="noreferrer"
            className="btn btn-secondary sm rdp-dl-btn"
            style={{ textDecoration: 'none' }}
          >
            🔗 Open
          </a>
          <button className="rdp-close" onClick={onClose}>✕</button>
        </div>
      </div>

      {/* Confidence */}
      <div className="rdp-conf-row">
        <span className={`rdp-conf-badge rdp-conf-${confCls}`}>
          {conf.toUpperCase()} CONFIDENCE
        </span>
        <span className="rdp-date">{fmtDate(report.rca_completed_at)}</span>
      </div>

      <div className="rdp-body">
        {/* Incident Summary */}
        <div className="rdp-section">
          <div className="rdp-section-title">📋 Incident Summary</div>
          <table className="rdp-table">
            <tbody>
              {[
                ['What',        summary.what],
                ['When',        fmtDate(summary.when)],
                ['Environment', summary.environment],
                ['Severity',    summary.severity],
              ].filter(([, v]) => v).map(([k, v]) => (
                <tr key={k}>
                  <td className="rdp-td-key">{k}</td>
                  <td className="rdp-td-val">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Root Cause */}
        <div className="rdp-section">
          <div className="rdp-section-title">🎯 Root Cause</div>
          <p className="rdp-root-summary">{root.summary || '—'}</p>
          {root.code_reference && (root.code_reference.file || root.code_reference.repo) && (
            <div className="rdp-code-ref">
              <div className="rdp-code-ref-label">Code Reference</div>
              {root.code_reference.file && (
                <code className="rdp-code-ref-file">{root.code_reference.file}</code>
              )}
              {root.code_reference.repo && (
                <div className="rdp-code-ref-repo">repo: {root.code_reference.repo}</div>
              )}
            </div>
          )}
        </div>

        {/* Timeline */}
        {rc.timeline?.length > 0 && (
          <div className="rdp-section">
            <div className="rdp-section-title">⏱️ Timeline</div>
            <TimelinePanel timeline={rc.timeline} />
          </div>
        )}

        {/* Suggested Solutions */}
        {rc.suggested_solutions?.length > 0 && (
          <div className="rdp-section">
            <div className="rdp-section-title">💡 Suggested Solutions</div>
            <SolutionsPanel solutions={rc.suggested_solutions} />
          </div>
        )}

        {/* Prevention */}
        {rc.prevention_recommendations?.length > 0 && (
          <div className="rdp-section">
            <div className="rdp-section-title">🛡️ Prevention Recommendations</div>
            <ul className="rdp-prevention-list">
              {rc.prevention_recommendations.map((r, i) => (
                <li key={i} className="rdp-prevention-item">
                  <span className="rdp-prevention-check">✓</span>
                  {r}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Analysis Metadata */}
        {Object.keys(meta).length > 0 && (
          <div className="rdp-section">
            <div className="rdp-section-title">⚙️ Analysis Metadata</div>
            <div className="rdp-meta-grid">
              <div className="rdp-meta-item">
                <div className="rdp-meta-val">{meta.react_iterations ?? '—'}</div>
                <div className="rdp-meta-lbl">Iterations</div>
              </div>
              <div className="rdp-meta-item">
                <div className="rdp-meta-val">{meta.github_files_fetched?.length ?? 0}</div>
                <div className="rdp-meta-lbl">Files Fetched</div>
              </div>
              {meta.model && (
                <div className="rdp-meta-item rdp-meta-item--wide">
                  <div className="rdp-meta-lbl">Model</div>
                  <code className="rdp-meta-model">{meta.model}</code>
                </div>
              )}
            </div>
            {meta.github_files_fetched?.length > 0 && (
              <div className="rdp-meta-files">
                <div className="rdp-meta-files-label">Files analyzed</div>
                {meta.github_files_fetched.map((f, i) => (
                  <code key={i} className="rdp-meta-file-pill">{f}</code>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Report Card ──────────────────────────────────────────────────────────────

function ReportCard({ item, onSelect, selected }) {
  const rc   = item.rca_result || {}
  const root = rc.root_cause || {}
  const meta = rc.analysis_metadata || {}
  const conf = root.confidence || ''
  const confCls = confidenceColor(conf)
  const codeFile = root.code_reference?.file || ''
  const iters    = meta.react_iterations ?? '—'

  return (
    <div
      className={`report-card report-card--${confCls}${selected ? ' report-card--selected' : ''}`}
      onClick={() => onSelect(item)}
    >
      {/* Top row */}
      <div className="report-card-top">
        <span className="log-service-badge">{item.service_name || '—'}</span>
        <span className="report-card-error-type">{item.error_type || '—'}</span>
        {item.severity && (
          <span className={`badge badge-${(item.severity || '').toLowerCase()}`}>{item.severity}</span>
        )}
        {conf && (
          <span className={`report-conf-badge report-conf-badge--${confCls}`}>
            {conf.toUpperCase()}
          </span>
        )}
        <span className="report-card-date">{fmtDate(item.rca_completed_at || item.occurred_at)}</span>
      </div>

      {/* Root cause summary */}
      <div className="report-card-summary">{root.summary || 'No root cause summary available.'}</div>

      {/* Bottom row */}
      <div className="report-card-footer">
        {codeFile && <code className="report-card-file">{codeFile}</code>}
        <span className="report-card-iters">{iters} iter{iters !== 1 ? 's' : ''}</span>
        <div className="report-card-actions">
          <button
            className="btn btn-secondary sm"
            onClick={e => { e.stopPropagation(); onSelect(item) }}
          >
            View Report
          </button>
          <button
            className="btn btn-secondary sm"
            onClick={e => {
              e.stopPropagation()
              downloadHtmlReport(item.id, item.service_name, item.rca_completed_at)
            }}
            title="Download HTML / Print as PDF"
          >
            📥 PDF
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main ReportsPage ─────────────────────────────────────────────────────────

const CONF_FILTERS = [
  { id: 'all',    label: 'All' },
  { id: 'high',   label: 'High Confidence' },
  { id: 'medium', label: 'Medium' },
  { id: 'low',    label: 'Low' },
]

export default function ReportsPage() {
  const [items,        setItems]        = useState([])
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState(null)
  const [search,       setSearch]       = useState('')
  const [confFilter,   setConfFilter]   = useState('all')
  const [sortOrder,    setSortOrder]    = useState('newest')
  const [selectedItem, setSelectedItem] = useState(null)
  const [detailReport, setDetailReport] = useState(null)
  const [detailLoading,setDetailLoading]= useState(false)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    fetchLogs({ status: 'completed', limit: 200 })
      .then(data => {
        const raw = data.items || []
        // Parse rca_result if it's a string
        const parsed = raw.map(it => ({
          ...it,
          rca_result: typeof it.rca_result === 'string'
            ? (() => { try { return JSON.parse(it.rca_result) } catch { return {} } })()
            : (it.rca_result || {}),
        }))
        setItems(parsed)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  const handleSelect = useCallback((item) => {
    if (selectedItem?.id === item.id) {
      setSelectedItem(null)
      setDetailReport(null)
      return
    }
    setSelectedItem(item)
    setDetailReport(null)
    setDetailLoading(true)
    fetchLog(item.id)
      .then(full => {
        const rca_result = typeof full.rca_result === 'string'
          ? (() => { try { return JSON.parse(full.rca_result) } catch { return {} } })()
          : (full.rca_result || {})
        setDetailReport({ ...full, rca_result })
      })
      .catch(() => setDetailReport(item))
      .finally(() => setDetailLoading(false))
  }, [selectedItem])

  // Filter + sort
  const visible = items
    .filter(it => {
      const q = search.toLowerCase()
      if (q && !((it.service_name || '').toLowerCase().includes(q) ||
                  (it.error_type  || '').toLowerCase().includes(q))) return false
      if (confFilter !== 'all') {
        const conf = (it.rca_result?.root_cause?.confidence || '').toLowerCase()
        if (conf !== confFilter) return false
      }
      return true
    })
    .sort((a, b) => {
      const da = new Date(a.rca_completed_at || a.occurred_at || 0)
      const db = new Date(b.rca_completed_at || b.occurred_at || 0)
      return sortOrder === 'newest' ? db - da : da - db
    })

  return (
    <div className="reports-page">
      {/* Header */}
      <div className="reports-header">
        <div className="reports-header-left">
          <h2 className="reports-title">RCA Reports</h2>
          {!loading && (
            <span className="reports-count-badge">{visible.length}</span>
          )}
        </div>
        <button className="btn btn-secondary sm refresh-btn" onClick={load} disabled={loading}>
          {loading
            ? <span className="rv2-spinner-sm" />
            : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" strokeLinecap="round" strokeLinejoin="round"/></svg>
          }
          Refresh
        </button>
      </div>

      {/* Filter row */}
      <div className="reports-filter-row">
        <div className="filter-search-wrap" style={{ maxWidth: 280 }}>
          <svg className="filter-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35" strokeLinecap="round"/>
          </svg>
          <input
            className="filter-search"
            placeholder="Search service or error type…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div className="filter-pills">
          {CONF_FILTERS.map(f => (
            <button
              key={f.id}
              className={`filter-pill${confFilter === f.id ? ` active-${f.id === 'all' ? 'all' : f.id}` : ''}`}
              onClick={() => setConfFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <select
          className="filter-service-select"
          value={sortOrder}
          onChange={e => setSortOrder(e.target.value)}
          style={{ minWidth: 120 }}
        >
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
        </select>
      </div>

      {/* Content area */}
      <div className={`reports-content${selectedItem ? ' reports-content--split' : ''}`}>
        {/* List */}
        <div className="reports-list">
          {loading && (
            <div className="reports-loading">
              <span className="rv2-spinner-sm" style={{ width: 20, height: 20 }} />
              Loading reports…
            </div>
          )}
          {error && !loading && (
            <div className="reports-error">
              <span>⊗ {error}</span>
              <button className="btn btn-secondary sm" onClick={load}>Retry</button>
            </div>
          )}
          {!loading && !error && visible.length === 0 && (
            <div className="reports-empty">
              <div className="reports-empty-icon">📄</div>
              <div>No completed reports found</div>
              {(search || confFilter !== 'all') && (
                <button className="btn btn-secondary sm" onClick={() => { setSearch(''); setConfFilter('all') }}>
                  Clear filters
                </button>
              )}
            </div>
          )}
          {!loading && !error && visible.map(item => (
            <ReportCard
              key={item.id}
              item={item}
              selected={selectedItem?.id === item.id}
              onSelect={handleSelect}
            />
          ))}
        </div>

        {/* Detail panel */}
        {selectedItem && (
          <ReportDetailPanel
            report={detailLoading ? null : detailReport}
            item={selectedItem}
            onClose={() => { setSelectedItem(null); setDetailReport(null) }}
          />
        )}
      </div>
    </div>
  )
}
