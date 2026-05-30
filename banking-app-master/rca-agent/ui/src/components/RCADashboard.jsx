import React, { useEffect, useState, useCallback } from 'react'
import { fetchLogs, fetchStats } from '../api/client'
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

function StatusBadge({ status }) {
  return (
    <span className={`status-badge status-${status}`}>
      <span className="dot" />
      {(status || 'pending').replace('_', ' ')}
    </span>
  )
}

function RCAIncidentRow({ log, onStream }) {
  const borderCls = log.rca_status || 'pending'
  const canRun    = log.rca_status === 'pending' || log.rca_status === 'failed'
  const canStream = log.rca_status === 'in_progress'
  const isDone    = log.rca_status === 'completed'

  return (
    <div className="glass rca-incident">
      <div className={`rca-incident-border ${borderCls}`} />
      <div className="rca-incident-inner">
        <div className="rca-incident-info">
          <div className="rca-incident-service">
            <span className="log-service-badge">{log.service_name}</span>
            <span style={{ fontWeight: 600, fontSize: 13 }}>{log.error_type}</span>
          </div>
          <div className="rca-incident-meta">
            <span>{relativeTime(log.occurred_at)}</span>
            {log.environment && <span style={{ color: 'var(--text-muted)' }}>·</span>}
            {log.environment && <span>{log.environment}</span>}
          </div>
        </div>

        <div className="rca-incident-badges">
          {log.risk_level && (() => {
            const v = log.risk_level.toLowerCase()
            const cls = v === 'critical' ? 'badge-critical'
                      : v === 'high'     ? 'badge-high'
                      : v === 'medium'   ? 'badge-medium'
                      : v === 'low'      ? 'badge-low'
                      : 'badge-gray'
            return <span className={`badge ${cls}`}>{log.risk_level}</span>
          })()}
          {log.gemini_category && (
            <span className="badge badge-indigo">{log.gemini_category}</span>
          )}
          <StatusBadge status={log.rca_status} />
        </div>

        <div className="rca-incident-actions">
          {canRun && (
            <button
              className="btn btn-primary"
              style={{ fontSize: 12 }}
              onClick={() => onStream(log.id, log.service_name, log.error_type)}
            >
              ▶ Run RCA
            </button>
          )}
          {canStream && (
            <button
              className="btn btn-secondary"
              style={{ fontSize: 12, color: 'var(--cyan)' }}
              onClick={() => onStream(log.id, log.service_name, log.error_type)}
            >
              ⚡ Stream
            </button>
          )}
          {isDone && (
            <a
              href={`/rca/${log.id}/report`}
              target="_blank"
              rel="noreferrer"
              className="btn btn-secondary"
              style={{ fontSize: 12 }}
            >
              View Report
            </a>
          )}
          {log.rca_error && (
            <span
              title={log.rca_error}
              style={{ fontSize: 11, color: 'var(--error)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {log.rca_error.slice(0, 60)}...
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

const STATUS_CARDS = [
  { key: 'pending',     label: 'Pending',    cls: 'pending',    icon: '⏳' },
  { key: 'in_progress', label: 'Running',    cls: 'running',    icon: '⚡' },
  { key: 'completed',   label: 'Completed',  cls: 'completed',  icon: '✓' },
  { key: 'failed',      label: 'Failed',     cls: 'failed',     icon: '✕' },
]

export default function RCADashboard() {
  const { openStream } = useApp()
  const [logs, setLogs]       = useState([])
  const [stats, setStats]     = useState({})
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    Promise.all([
      fetchLogs({ limit: 200 }),
      fetchStats(),
    ]).then(([logData, statsData]) => {
      setLogs(logData.items || [])
      setStats(statsData)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, 5000)
    return () => clearInterval(id)
  }, [load])

  if (loading) {
    return (
      <div>
        <div className="rca-status-cards">
          {STATUS_CARDS.map(c => (
            <div key={c.key} className={`glass rca-status-card ${c.cls}`}>
              <div className="skeleton" style={{ width: 40, height: 40, borderRadius: 8 }} />
              <div>
                <div className="skeleton skeleton-line" style={{ height: 28, width: 48, marginBottom: 4 }} />
                <div className="skeleton skeleton-line short" style={{ height: 12 }} />
              </div>
            </div>
          ))}
        </div>
        <div className="rca-incidents">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="glass" style={{ height: 80, borderRadius: 14, marginBottom: 8 }}>
              <div className="skeleton" style={{ width: '100%', height: '100%', borderRadius: 14 }} />
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="rca-dashboard">
      {/* Status cards */}
      <div className="rca-status-cards">
        {STATUS_CARDS.map(c => (
          <div key={c.key} className={`glass rca-status-card ${c.cls}`}>
            <div className={`rca-status-card-icon ${c.cls}`}>
              <span style={{ fontSize: 18 }}>{c.icon}</span>
            </div>
            <div>
              <div className="rca-status-card-num">{stats[c.key] || 0}</div>
              <div className="rca-status-card-label">{c.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Section header */}
      <div className="section-header">
        <h2 className="section-title">
          <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
          All Incidents
        </h2>
        <span className="text-muted text-sm">{logs.length} total</span>
      </div>

      {/* Incident list */}
      {logs.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">
            <svg width="26" height="26" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div className="empty-state-title">No incidents</div>
          <div className="empty-state-desc">No error logs have been ingested yet.</div>
        </div>
      ) : (
        <div className="rca-incidents">
          {logs.map(log => (
            <RCAIncidentRow
              key={log.id}
              log={log}
              onStream={openStream}
            />
          ))}
        </div>
      )}
    </div>
  )
}
