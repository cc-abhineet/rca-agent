import React, { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchLogs } from '../api/client'
import { useApp } from '../context/AppContext'

function fmtAge(ts) {
  if (!ts) return '—'
  try {
    const diff = Date.now() - new Date(ts + (ts.includes('Z') || ts.includes('+') ? '' : 'Z')).getTime()
    const m = Math.floor(diff / 60000)
    if (m < 1) return 'just now'
    if (m < 60) return `${m}m ago`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h ago`
    return `${Math.floor(h / 24)}d ago`
  } catch { return '—' }
}

function fmtTime(ts) {
  if (!ts) return '—'
  try {
    return new Date(ts + (ts.includes('Z') || ts.includes('+') ? '' : 'Z'))
      .toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch { return ts }
}

const SEV_COLOR = {
  critical: 'var(--critical)', high: 'var(--high)',
  medium: 'var(--medium)', low: 'var(--low)', error: 'var(--critical)',
}

const CONF_COLOR = { high: '#10B981', medium: '#F59E0B', low: '#F97316' }

function ConfBadge({ conf }) {
  if (!conf) return null
  const c = CONF_COLOR[conf] || 'var(--text-muted)'
  return (
    <span style={{ fontSize: 11, fontWeight: 700, color: c, background: `${c}18`, border: `1px solid ${c}30`, borderRadius: 'var(--r-full)', padding: '2px 8px' }}>
      {conf.toUpperCase()}
    </span>
  )
}

export default function InvestigationsPage() {
  const navigate = useNavigate()
  const { activeOrg } = useApp()
  const [logs, setLogs]     = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')   // all | completed | in_progress | failed

  const load = useCallback(() => {
    setLoading(true)
    const orgId = activeOrg?.id || null
    fetchLogs({ limit: 200, org_id: orgId })
      .then(l => {
        const all = l?.items || l || []
        setLogs(all.filter(log => ['completed', 'in_progress', 'failed'].includes(log.rca_status)))
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [activeOrg?.id])

  useEffect(() => { load() }, [load])

  const filtered = logs.filter(log => {
    const q = search.toLowerCase()
    const matchSearch = !q ||
      (log.error_type || '').toLowerCase().includes(q) ||
      (log.service_name || log.service || '').toLowerCase().includes(q) ||
      (log.error_message || '').toLowerCase().includes(q)
    const matchFilter = filter === 'all' || log.rca_status === filter
    return matchSearch && matchFilter
  })

  const counts = {
    all: logs.length,
    completed: logs.filter(l => l.rca_status === 'completed').length,
    in_progress: logs.filter(l => l.rca_status === 'in_progress').length,
    failed: logs.filter(l => l.rca_status === 'failed').length,
  }

  return (
    <div className="ap-page" style={{ gap: 20 }}>
      <div className="ap-page-header">
        <div>
          <h1 className="ap-page-title">Investigations</h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>
            Completed and active RCA analyses. Click any row to open the chat workspace.
          </p>
        </div>
        <button className="ap-btn-ghost btn" onClick={load} style={{ fontSize: 12 }}>↻ Refresh</button>
      </div>

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', borderBottom: '1px solid var(--border)', paddingBottom: 0 }}>
        {[
          { key: 'all',         label: 'All' },
          { key: 'completed',   label: 'Completed' },
          { key: 'in_progress', label: 'In Progress' },
          { key: 'failed',      label: 'Failed' },
        ].map(tab => (
          <button
            key={tab.key}
            onClick={() => setFilter(tab.key)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '8px 14px', fontSize: 13, fontWeight: filter === tab.key ? 700 : 400,
              color: filter === tab.key ? 'var(--indigo)' : 'var(--text-muted)',
              borderBottom: filter === tab.key ? '2px solid var(--indigo)' : '2px solid transparent',
              marginBottom: -1, transition: 'all 0.15s ease',
            }}
          >
            {tab.label}
            <span style={{
              marginLeft: 6, fontSize: 11, fontWeight: 600,
              background: filter === tab.key ? 'var(--indigo-tint)' : 'var(--bg-2)',
              color: filter === tab.key ? 'var(--indigo)' : 'var(--text-muted)',
              borderRadius: 'var(--r-full)', padding: '1px 6px',
            }}>
              {counts[tab.key]}
            </span>
          </button>
        ))}

        <div className="filter-search-wrap" style={{ marginLeft: 'auto', minWidth: 220 }}>
          <svg className="filter-search-icon" width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            className="filter-search"
            placeholder="Search investigations…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Investigation cards */}
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {[1, 2, 3].map(i => (
            <div key={i} className="ap-card ap-card-body" style={{ height: 100 }}>
              <div className="skeleton skeleton-line" style={{ width: '40%', marginBottom: 12 }} />
              <div className="skeleton skeleton-line" style={{ width: '70%', marginBottom: 8 }} />
              <div className="skeleton skeleton-line" style={{ width: '30%' }} />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">🔍</div>
          <div className="empty-state-title">No investigations found</div>
          <div className="empty-state-desc">
            {search ? 'Try adjusting your search' : 'Run an RCA from the Incidents page to see results here'}
          </div>
          <button className="ap-btn-accent btn" style={{ marginTop: 16, fontSize: 13 }} onClick={() => navigate('/incidents')}>
            Go to Incidents →
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filtered.map((log, i) => {
            const sev = (log.severity || 'low').toLowerCase()
            const sevColor = SEV_COLOR[sev] || 'var(--text-muted)'
            const isDone = log.rca_status === 'completed'
            const isFailed = log.rca_status === 'failed'
            const isRunning = log.rca_status === 'in_progress'
            const conf = log.rca_result && (() => { try { return JSON.parse(log.rca_result)?.root_cause?.confidence } catch { return null } })()

            return (
              <div
                key={log.id || i}
                onClick={() => navigate(`/workspace/${log.id}`)}
                className="inv-card"
                style={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--r-lg)',
                  padding: '16px 20px',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                  display: 'flex',
                  gap: 16,
                  alignItems: 'flex-start',
                  borderLeft: `3px solid ${isDone ? '#10B981' : isFailed ? '#EF4444' : 'var(--indigo)'}`,
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.background = 'var(--bg-hover)'
                  e.currentTarget.style.transform = 'translateY(-1px)'
                  e.currentTarget.style.boxShadow = 'var(--shadow-md)'
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.background = 'var(--bg-card)'
                  e.currentTarget.style.transform = 'none'
                  e.currentTarget.style.boxShadow = 'none'
                }}
              >
                {/* Status icon */}
                <div style={{
                  width: 36, height: 36, borderRadius: 10,
                  background: isDone ? '#10B98118' : isFailed ? '#EF444418' : 'var(--indigo-tint)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 16, flexShrink: 0,
                  color: isDone ? '#10B981' : isFailed ? '#EF4444' : 'var(--indigo)',
                }}>
                  {isDone ? '✓' : isFailed ? '✗' : isRunning ? '⟳' : '○'}
                </div>

                {/* Main info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {log.error_type || log.title || 'Unnamed incident'}
                    </span>
                    {conf && <ConfBadge conf={conf} />}
                    {log.is_duplicate && (
                      <span style={{ fontSize: 11, color: '#7C3AED', fontWeight: 600, background: '#7C3AED18', padding: '1px 7px', borderRadius: 'var(--r-full)' }}>
                        duplicate
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                    <span style={{ color: sevColor, fontWeight: 600 }}>{sev.toUpperCase()}</span>
                    <span style={{ margin: '0 6px' }}>·</span>
                    {log.service_name || log.service}
                    {log.error_message && (
                      <><span style={{ margin: '0 6px' }}>·</span>
                      <span style={{ opacity: 0.8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 300, display: 'inline-block', verticalAlign: 'middle' }}>
                        {log.error_message.slice(0, 80)}{log.error_message.length > 80 ? '…' : ''}
                      </span></>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--text-muted)' }}>
                    {log.timestamp && <span>Started: {fmtTime(log.timestamp)}</span>}
                    {log.rca_completed_at && <span>Completed: {fmtTime(log.rca_completed_at)}</span>}
                    {isRunning && <span style={{ color: 'var(--indigo)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}><span className="ws-live-dot" style={{ width: 6, height: 6, flexShrink: 0 }} /> Running</span>}
                  </div>
                </div>

                {/* Actions */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end', flexShrink: 0 }}>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmtAge(log.rca_completed_at || log.timestamp)}</span>
                  <button
                    className="ap-btn-accent btn"
                    style={{ fontSize: 11, padding: '4px 12px', opacity: 0.9 }}
                    onClick={e => { e.stopPropagation(); navigate(`/workspace/${log.id}`) }}
                  >
                    {isDone ? 'View & Chat →' : isRunning ? 'Watch Live →' : 'Open →'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
