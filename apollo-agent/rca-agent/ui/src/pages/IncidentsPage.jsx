import React, { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchLogs, fetchStats, triggerRCA } from '../api/client'
import { useApp } from '../context/AppContext'

function fmtAge(ts) {
  if (!ts) return '—'
  try {
    const diff = Date.now() - new Date(ts + (ts.includes('Z') || ts.includes('+') ? '' : 'Z')).getTime()
    const m = Math.floor(diff / 60000)
    if (m < 1) return 'just now'
    if (m < 60) return `${m}m`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h`
    return `${Math.floor(h / 24)}d`
  } catch { return '—' }
}

function fmtDatetime(ts) {
  if (!ts) return '—'
  try {
    return new Date(ts + (ts.includes('Z') || ts.includes('+') ? '' : 'Z'))
      .toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch { return '—' }
}

const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3 }

function StatCard({ icon, label, value, accent, trend, trendDir, trendLabel }) {
  const TC = { up: '#10B981', down: '#EF4444', warn: '#F59E0B', info: '#5B5BD6' }
  const tc = TC[trendDir] || TC.info
  const numVal = typeof value === 'number' ? (value < 100 ? String(value).padStart(2, '0') : value) : (value ?? '—')

  return (
    <div className="ap-stat-card" style={{
      position: 'relative', overflow: 'hidden',
      display: 'flex', flexDirection: 'column', minHeight: 150, padding: '18px 20px 16px',
      border: '1px solid var(--border)', borderRadius: 16,
    }}>
      <div style={{
        position: 'absolute', bottom: -24, left: -24, width: 180, height: 180,
        background: `radial-gradient(circle, ${accent || '#5B5BD6'}22 0%, transparent 65%)`,
        pointerEvents: 'none',
      }} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'auto', position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          {icon}
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '.01em' }}>{label}</span>
        </div>
        <span style={{ color: 'var(--text-muted)', cursor: 'default', fontSize: 18, lineHeight: 1, padding: '0 2px', userSelect: 'none' }}>⋮</span>
      </div>
      <div style={{
        fontSize: 40, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1,
        color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums',
        margin: '14px 0 14px', position: 'relative',
      }}>{numVal}</div>
      {trend != null && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, position: 'relative' }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            fontSize: 11.5, fontWeight: 700, color: tc,
            background: `${tc}1a`, border: `1px solid ${tc}30`,
            borderRadius: 6, padding: '3px 8px',
          }}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              {trendDir === 'up'   ? <path d="M7 17L17 7M17 7H7M17 7v10"/> :
               trendDir === 'down' ? <path d="M7 7l10 10M17 17H7M17 17V7"/> :
                                     <path d="M5 12h14"/>}
            </svg>
            {trend}
          </span>
          {trendLabel && <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{trendLabel}</span>}
        </div>
      )}
    </div>
  )
}

function SeverityBadge({ severity }) {
  const s = (severity || 'low').toLowerCase()
  const cls = s === 'error' ? 'critical' : s
  const label = cls.charAt(0).toUpperCase() + cls.slice(1)
  return <span className={`badge badge-${cls}`}>{label}</span>
}

function StatusBadge({ status }) {
  const map = {
    in_progress: { label: 'Investigating', cls: 'badge-indigo' },
    completed:   { label: 'Resolved',      cls: 'badge-success' },
    pending:     { label: 'Queued',        cls: 'badge-gray' },
    failed:      { label: 'Failed',        cls: 'badge-error' },
    duplicate:   { label: 'Duplicate',     cls: 'badge-gray' },
  }
  const m = map[status] || { label: status || 'Unknown', cls: 'badge-gray' }
  return <span className={`badge ${m.cls}`}>{m.label}</span>
}

export default function IncidentsPage() {
  const navigate = useNavigate()
  const { showToast, activeOrg } = useApp()

  const [logs,    setLogs]    = useState([])
  const [stats,   setStats]   = useState(null)
  const [loading, setLoading] = useState(true)
  const [search,  setSearch]  = useState('')
  const [sevFilter, setSevFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [runningId, setRunningId] = useState(null)
  const [page, setPage]  = useState(1)
  const PER_PAGE = 20

  const load = useCallback(() => {
    const orgId = activeOrg?.id || null
    Promise.all([
      fetchLogs({ limit: 200, org_id: orgId }).catch(() => ({ items: [] })),
      fetchStats(orgId).catch(() => null),
    ]).then(([l, s]) => {
      setLogs(l?.items || l || [])
      setStats(s)
      setLoading(false)
    })
  }, [activeOrg?.id])

  useEffect(() => { load() }, [load])

  // Filter
  const filtered = logs.filter(log => {
    const q = search.toLowerCase()
    const matchSearch = !q ||
      (log.error_type || '').toLowerCase().includes(q) ||
      (log.service || '').toLowerCase().includes(q) ||
      (log.message || '').toLowerCase().includes(q)
    const sev = (log.severity || 'low').toLowerCase()
    const matchSev = sevFilter === 'all' || sev === sevFilter || (sevFilter === 'critical' && sev === 'error')
    const matchStatus = statusFilter === 'all' || log.rca_status === statusFilter
    return matchSearch && matchSev && matchStatus
  }).sort((a, b) => {
    const sa = SEV_ORDER[(a.severity || 'low').toLowerCase()] ?? 4
    const sb = SEV_ORDER[(b.severity || 'low').toLowerCase()] ?? 4
    if (sa !== sb) return sa - sb
    return new Date(b.occurred_at || b.timestamp || 0) - new Date(a.occurred_at || a.timestamp || 0)
  })

  const pages     = Math.max(1, Math.ceil(filtered.length / PER_PAGE))
  const pageItems = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE)

  const handleRunRCA = async (e, id) => {
    e.stopPropagation()
    setRunningId(id)
    try {
      await triggerRCA(id, activeOrg?.id ?? null)
      showToast('RCA started', 'success')
      navigate(`/workspace/${id}`)
    } catch (err) {
      showToast(err.message || 'Failed to start RCA', 'error')
    } finally {
      setRunningId(null)
    }
  }

  const resolvedToday = logs.filter(l => {
    if (l.rca_status !== 'completed') return false
    const d = new Date(l.rca_completed_at || '')
    return d.toDateString() === new Date().toDateString()
  }).length

  const totalResolved  = logs.filter(l => l.rca_status === 'completed').length
  const successRate    = logs.length > 0 ? Math.round((totalResolved / logs.length) * 100) : 0

  return (
    <div className="ap-page">
      {/* Header */}
      <div className="ap-page-header">
        <h1 className="ap-page-title">Incidents</h1>
        <button className="ap-btn-accent btn" onClick={() => navigate('/incidents')}>
          + New investigation
        </button>
      </div>

      {/* Stats */}
      <div className="ap-stat-grid" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
        <StatCard
          label="Total Alerts"
          value={stats?.total ?? logs.length}
          accent="#EF4444"
          icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#EF4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>}
          trend={stats?.pending != null ? `+${stats.pending}` : null}
          trendDir="down"
          trendLabel="open now"
        />
        <StatCard
          label="Critical Issues"
          value={stats?.in_progress ?? '—'}
          accent="#5B5BD6"
          icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5B5BD6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>}
          trend={stats?.in_progress != null ? `+${stats.in_progress}` : null}
          trendDir="warn"
          trendLabel="investigating"
        />
        <StatCard
          label="Resolved Today"
          value={resolvedToday}
          accent="#10B981"
          icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>}
          trend={`${successRate}%`}
          trendDir="up"
          trendLabel="success rate"
        />
        <StatCard
          label="Median TTRC"
          value={stats?.median_ttrc_seconds ? `${Math.round(stats.median_ttrc_seconds / 60)}m` : '—'}
          accent="#F59E0B"
          icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>}
          trend={stats?.median_ttrc_seconds ? `${Math.round(stats.median_ttrc_seconds / 60)}m` : null}
          trendDir="info"
          trendLabel="to root cause"
        />
      </div>

      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="filter-search-wrap" style={{ flex: 1, minWidth: 240 }}>
          <svg className="filter-search-icon" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            className="filter-search"
            placeholder="Search incidents…"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1) }}
          />
        </div>

        <select
          className="form-select"
          style={{ width: 'auto', minWidth: 130 }}
          value={sevFilter}
          onChange={e => { setSevFilter(e.target.value); setPage(1) }}
        >
          <option value="all">All severities</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>

        <select
          className="form-select"
          style={{ width: 'auto', minWidth: 130 }}
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1) }}
        >
          <option value="all">All statuses</option>
          <option value="pending">Queued</option>
          <option value="in_progress">Investigating</option>
          <option value="completed">Resolved</option>
          <option value="failed">Failed</option>
        </select>

        <button className="ap-btn-ghost btn" onClick={load} style={{ flexShrink: 0 }}>
          ↻ Refresh
        </button>
      </div>

      {/* Table */}
      <div className="ap-table-wrap">
        {loading ? (
          <div style={{ padding: 32 }}>
            {[1,2,3,4,5].map(i => (
              <div key={i} className="skeleton skeleton-line" style={{ marginBottom: 16, height: 20 }} />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">🎉</div>
            <div className="empty-state-title">No incidents found</div>
            <div className="empty-state-desc">
              {search || sevFilter !== 'all' || statusFilter !== 'all'
                ? 'Try adjusting your filters'
                : 'No incidents have been recorded yet'}
            </div>
          </div>
        ) : (
          <table className="ap-table">
            <thead>
              <tr>
                <th>Sev</th>
                <th>Incident</th>
                <th>Service</th>
                <th>Error Occurred</th>
                <th>Status</th>
                <th>Age</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {pageItems.map((log, i) => (
                <tr key={log.id || i} onClick={() => navigate(`/workspace/${log.id}`)}>
                  <td><SeverityBadge severity={log.severity} /></td>
                  <td>
                    <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }}>
                      {log.error_type || log.title || 'Unnamed incident'}
                    </div>
                    {log.error_message && (
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }}>
                        {log.error_message.slice(0, 80)}{log.error_message.length > 80 ? '…' : ''}
                      </div>
                    )}
                    {log.is_duplicate && <span style={{ marginLeft: 0, color: '#7C3AED', fontWeight: 600, fontSize: 11 }}>duplicate</span>}
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                    {log.service_name || log.service || '—'}
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                    {fmtDatetime(log.occurred_at || log.timestamp)}
                  </td>
                  <td><StatusBadge status={log.rca_status} /></td>
                  <td style={{ color: 'var(--text-muted)', fontSize: 12, whiteSpace: 'nowrap' }}>
                    {fmtAge(log.occurred_at || log.timestamp)}
                  </td>
                  <td onClick={e => e.stopPropagation()}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {log.rca_status !== 'completed' && (
                        <button
                          className="btn ap-btn-accent"
                          style={{ padding: '4px 10px', fontSize: 12 }}
                          disabled={runningId === log.id}
                          onClick={e => handleRunRCA(e, log.id)}
                        >
                          {runningId === log.id ? '…' : 'Run RCA'}
                        </button>
                      )}
                      <button
                        className="ap-btn-ghost btn"
                        style={{ padding: '4px 10px', fontSize: 12 }}
                        onClick={() => navigate(`/workspace/${log.id}`)}
                      >
                        Chat →
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {pages > 1 && (
        <div className="log-pagination">
          <button className="page-btn" disabled={page === 1} onClick={() => setPage(p => p - 1)}>‹</button>
          {Array.from({ length: Math.min(pages, 7) }, (_, i) => {
            const n = i + 1
            return (
              <button key={n} className={`page-btn${page === n ? ' active' : ''}`} onClick={() => setPage(n)}>{n}</button>
            )
          })}
          <button className="page-btn" disabled={page === pages} onClick={() => setPage(p => p + 1)}>›</button>
          <span className="page-info">{filtered.length} total</span>
        </div>
      )}
    </div>
  )
}
