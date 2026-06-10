import React, { useEffect, useState, useCallback, useRef } from 'react'
import { fetchLogs, fetchStats } from '../api/client'
import { clearStreamCache } from './RCAStreamPanel'
import { useApp } from '../context/AppContext'

// ── Helpers ───────────────────────────────────────────────────
function relTime(ts) {
  if (!ts) return ''
  const diff = Date.now() - new Date(ts + (ts.includes('Z') || ts.includes('+') ? '' : 'Z')).getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60)  return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60)  return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24)  return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function fmtTime(ts) {
  if (!ts) return '—'
  try {
    return new Date(ts + (ts.includes('Z') || ts.includes('+') ? '' : 'Z'))
      .toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch { return ts }
}

const SEV_STYLE = {
  critical: { bg: 'rgba(239,68,68,0.12)',  border: 'rgba(239,68,68,0.3)',  color: '#FCA5A5' },
  high:     { bg: 'rgba(249,115,22,0.12)', border: 'rgba(249,115,22,0.3)', color: '#FDBA74' },
  medium:   { bg: 'rgba(234,179,8,0.12)',  border: 'rgba(234,179,8,0.3)',  color: '#FDE047' },
  low:      { bg: 'rgba(59,130,246,0.12)', border: 'rgba(59,130,246,0.3)', color: '#93C5FD' },
  error:    { bg: 'rgba(239,68,68,0.12)',  border: 'rgba(239,68,68,0.3)',  color: '#FCA5A5' },
}
function sevStyle(s) { return SEV_STYLE[(s||'').toLowerCase()] || { bg:'rgba(255,255,255,0.05)', border:'rgba(255,255,255,0.1)', color:'#94A3B8' } }

const STATUS_LEFT_COLOR = {
  pending:     '#6366F1',
  in_progress: '#06B6D4',
  completed:   '#10B981',
  failed:      '#EF4444',
  duplicate:   '#A855F7',
}

// ── Stat cards ────────────────────────────────────────────────
const STAT_CARDS = [
  { key: 'pending',     label: 'Pending',   icon: '⏳', color: '#818CF8', dim: 'rgba(99,102,241,0.1)',  border: 'rgba(99,102,241,0.2)'  },
  { key: 'in_progress', label: 'Running',   icon: '⚡', color: '#22D3EE', dim: 'rgba(6,182,212,0.1)',   border: 'rgba(6,182,212,0.25)'  },
  { key: 'completed',   label: 'Completed', icon: '✓',  color: '#34D399', dim: 'rgba(16,185,129,0.1)',  border: 'rgba(16,185,129,0.22)' },
  { key: 'failed',      label: 'Failed',    icon: '✕',  color: '#F87171', dim: 'rgba(239,68,68,0.1)',   border: 'rgba(239,68,68,0.22)'  },
]

function StatCard({ card, value, isActive, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: isActive ? card.dim : 'rgba(255,255,255,0.025)',
        border: `1px solid ${isActive ? card.border : 'rgba(255,255,255,0.07)'}`,
        borderRadius: 12, padding: '16px 20px',
        display: 'flex', alignItems: 'center', gap: 14,
        cursor: 'pointer', transition: 'all 0.18s ease', textAlign: 'left',
        fontFamily: 'inherit', flex: 1,
        boxShadow: isActive ? `0 0 20px ${card.dim}` : 'none',
      }}
      onMouseEnter={e => { if (!isActive) { e.currentTarget.style.background = card.dim; e.currentTarget.style.borderColor = card.border } }}
      onMouseLeave={e => { if (!isActive) { e.currentTarget.style.background = 'rgba(255,255,255,0.025)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)' } }}
    >
      <div style={{
        width: 44, height: 44, borderRadius: 10,
        background: card.dim, border: `1px solid ${card.border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 20, flexShrink: 0, color: card.color,
        filter: `drop-shadow(0 0 8px ${card.color}55)`,
      }}>
        {card.icon}
      </div>
      <div>
        <div style={{ fontSize: 26, fontWeight: 800, color: isActive ? card.color : '#F1F5F9', lineHeight: 1, fontFamily: 'var(--font-mono)' }}>
          {value ?? 0}
        </div>
        <div style={{ fontSize: 11, color: isActive ? card.color : '#64748B', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 3 }}>
          {card.label}
        </div>
      </div>
      {isActive && (
        <div style={{ marginLeft: 'auto', width: 6, height: 6, borderRadius: '50%', background: card.color, boxShadow: `0 0 8px ${card.color}` }} />
      )}
    </button>
  )
}

// ── Incident card ─────────────────────────────────────────────
function IncidentCard({ log, onAction, loading }) {
  const status    = log.rca_status || 'pending'
  const accentColor = STATUS_LEFT_COLOR[status] || '#6366F1'
  const sev       = sevStyle(log.severity)
  const rca       = typeof log.rca_result === 'object' ? log.rca_result : null
  const conf      = rca?.root_cause?.confidence
  const confStyle = conf === 'high' ? { color: '#34D399', bg: 'rgba(16,185,129,0.1)', border: 'rgba(16,185,129,0.25)' }
                  : conf === 'medium' ? { color: '#FBBF24', bg: 'rgba(245,158,11,0.1)', border: 'rgba(245,158,11,0.25)' }
                  : conf ? { color: '#F87171', bg: 'rgba(239,68,68,0.1)', border: 'rgba(239,68,68,0.25)' } : null

  const isDuplicate = !!log.duplicate_of || status === 'duplicate'
  const canRun    = !isDuplicate && (status === 'pending' || status === 'failed')
  const canStream = !isDuplicate && status === 'in_progress'
  const isDone    = status === 'completed'

  return (
    <div style={{
      display: 'flex', borderRadius: 12, overflow: 'hidden',
      background: 'rgba(11,17,32,0.8)', border: '1px solid rgba(255,255,255,0.07)',
      transition: 'border-color 0.15s, box-shadow 0.15s',
      marginBottom: 8,
    }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.14)'; e.currentTarget.style.boxShadow = '0 2px 16px rgba(0,0,0,0.4)' }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)'; e.currentTarget.style.boxShadow = 'none' }}
    >
      {/* Left accent */}
      <div style={{ width: 3, flexShrink: 0, background: accentColor, opacity: status === 'in_progress' ? 1 : 0.7 }} />

      <div style={{ flex: 1, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', minWidth: 0 }}>

        {/* Main info */}
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
            {/* Service */}
            <span style={{
              padding: '2px 9px', borderRadius: 20, fontSize: 11, fontWeight: 700,
              background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.25)', color: '#818CF8',
              textTransform: 'uppercase', letterSpacing: '0.04em', flexShrink: 0,
            }}>
              {log.service_name || '—'}
            </span>
            {/* Error type */}
            <span style={{ fontSize: 13, fontWeight: 600, color: '#E2E8F0', fontFamily: 'var(--font-mono)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {log.error_type || 'Unknown Error'}
            </span>
          </div>
          {/* Error message preview */}
          {log.error_message && (
            <div style={{ fontSize: 12, color: '#64748B', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 420 }}>
              {log.error_message}
            </div>
          )}
          {/* Root cause snippet if completed */}
          {isDone && rca?.root_cause?.summary && (
            <div style={{ fontSize: 11.5, color: '#6EE7B7', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 420 }}>
              ↳ {rca.root_cause.summary}
            </div>
          )}
        </div>

        {/* Badges */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', flexShrink: 0 }}>
          {/* Severity */}
          {log.severity && (
            <span style={{ padding: '2px 8px', borderRadius: 6, fontSize: 10.5, fontWeight: 700, background: sev.bg, border: `1px solid ${sev.border}`, color: sev.color, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {log.severity}
            </span>
          )}
          {/* Confidence (completed only) */}
          {confStyle && (
            <span style={{ padding: '2px 8px', borderRadius: 6, fontSize: 10.5, fontWeight: 700, background: confStyle.bg, border: `1px solid ${confStyle.border}`, color: confStyle.color, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {conf} conf
            </span>
          )}
          {/* Duplicate flag */}
          {isDuplicate && (
            <span
              title={`Duplicate of incident ${(log.duplicate_of || '').slice(0, 8)}`}
              style={{ padding: '2px 8px', borderRadius: 6, fontSize: 10.5, fontWeight: 700, background: 'rgba(168,85,247,0.12)', border: '1px solid rgba(168,85,247,0.35)', color: '#C4B5FD', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              ⧉ Duplicate
            </span>
          )}
          {/* Recurrence count on the original */}
          {!isDuplicate && log.occurrence_count > 1 && (
            <span
              title="Times this error has recurred"
              style={{ padding: '2px 8px', borderRadius: 6, fontSize: 10.5, fontWeight: 700, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', color: '#94A3B8', letterSpacing: '0.05em' }}>
              ×{log.occurrence_count}
            </span>
          )}
          {/* Status */}
          <StatusPill status={status} />
          {/* Time */}
          <span style={{ fontSize: 11, color: '#475569', flexShrink: 0 }}>{relTime(log.occurred_at)}</span>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {canRun && (
            <ActionBtn
              label="▶ Run RCA"
              color="#818CF8" dimColor="rgba(99,102,241,0.14)" borderColor="rgba(99,102,241,0.35)"
              hoverColor="rgba(99,102,241,0.28)"
              disabled={loading === log.id}
              onClick={() => onAction('run', log)}
            />
          )}
          {canStream && (
            <ActionBtn
              label="⚡ Live"
              color="#22D3EE" dimColor="rgba(6,182,212,0.12)" borderColor="rgba(6,182,212,0.35)"
              hoverColor="rgba(6,182,212,0.25)"
              onClick={() => onAction('stream', log)}
            />
          )}
          {isDone && (
            <ActionBtn
              label="📊 Report"
              color="#34D399" dimColor="rgba(16,185,129,0.1)" borderColor="rgba(16,185,129,0.3)"
              hoverColor="rgba(16,185,129,0.22)"
              onClick={() => onAction('report', log)}
            />
          )}
          {isDone && (
            <ActionBtn
              label="▶ Re-run"
              color="#818CF8" dimColor="rgba(99,102,241,0.08)" borderColor="rgba(99,102,241,0.22)"
              hoverColor="rgba(99,102,241,0.2)"
              onClick={() => onAction('run', log)}
            />
          )}
          {isDuplicate && (
            <ActionBtn
              label="📊 Report"
              color="#C4B5FD" dimColor="rgba(168,85,247,0.1)" borderColor="rgba(168,85,247,0.3)"
              hoverColor="rgba(168,85,247,0.22)"
              onClick={() => onAction('report', log)}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function StatusPill({ status }) {
  const map = {
    pending:     { label: 'Pending',     color: '#818CF8', bg: 'rgba(99,102,241,0.1)',  border: 'rgba(99,102,241,0.25)',  dot: true },
    in_progress: { label: 'Running',     color: '#22D3EE', bg: 'rgba(6,182,212,0.1)',   border: 'rgba(6,182,212,0.3)',    dot: true, pulse: true },
    completed:   { label: 'Completed',   color: '#34D399', bg: 'rgba(16,185,129,0.1)',  border: 'rgba(16,185,129,0.25)',  dot: false },
    failed:      { label: 'Failed',      color: '#F87171', bg: 'rgba(239,68,68,0.1)',   border: 'rgba(239,68,68,0.25)',   dot: false },
    duplicate:   { label: 'Duplicate',   color: '#C4B5FD', bg: 'rgba(168,85,247,0.1)',  border: 'rgba(168,85,247,0.25)',  dot: false },
  }
  const s = map[status] || map.pending
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 9px', borderRadius: 20, fontSize: 10.5, fontWeight: 700, background: s.bg, border: `1px solid ${s.border}`, color: s.color }}>
      {s.dot && (
        <span style={{ width: 5, height: 5, borderRadius: '50%', background: s.color, flexShrink: 0, ...(s.pulse ? { animation: 'pulseDot 1.2s ease infinite' } : {}) }} />
      )}
      {!s.dot && status === 'completed' && '✓ '}
      {!s.dot && status === 'failed'    && '✕ '}
      {!s.dot && status === 'duplicate' && '⧉ '}
      {s.label}
    </span>
  )
}

function ActionBtn({ label, color, dimColor, borderColor, hoverColor, onClick, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '5px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600,
        fontFamily: 'inherit', cursor: disabled ? 'not-allowed' : 'pointer',
        background: dimColor, border: `1px solid ${borderColor}`, color,
        transition: 'all 0.14s ease', opacity: disabled ? 0.5 : 1,
        display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap',
      }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = hoverColor }}
      onMouseLeave={e => { if (!disabled) e.currentTarget.style.background = dimColor }}
    >
      {disabled ? <span style={{ width: 10, height: 10, border: `1.5px solid ${color}44`, borderTopColor: color, borderRadius: '50%', animation: 'spin 0.7s linear infinite', display: 'inline-block' }} /> : null}
      {label}
    </button>
  )
}

// ── Status filter tabs ────────────────────────────────────────
const FILTERS = [
  { id: 'all',         label: 'All' },
  { id: 'pending',     label: 'Pending' },
  { id: 'in_progress', label: 'Running' },
  { id: 'completed',   label: 'Completed' },
  { id: 'failed',      label: 'Failed' },
]

// ── Main dashboard ────────────────────────────────────────────
export default function RCADashboard() {
  const { openStream } = useApp()
  const [logs,        setLogs]        = useState([])
  const [stats,       setStats]       = useState({})
  const [loading,     setLoading]     = useState(true)
  const [filter,      setFilter]      = useState('all')
  const [search,      setSearch]      = useState('')
  const [actionLoading] = useState(null)   // kept for ActionBtn disabled prop; no longer set
  const [lastRefresh, setLastRefresh] = useState(Date.now())
  const refreshRef    = useRef(null)

  const load = useCallback(() => {
    Promise.all([fetchLogs({ limit: 200 }), fetchStats()])
      .then(([ld, sd]) => {
        setLogs(ld.items || [])
        setStats(sd)
        setLoading(false)
        setLastRefresh(Date.now())
      })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
    refreshRef.current = setInterval(load, 5000)
    return () => clearInterval(refreshRef.current)
  }, [load])

  const handleAction = useCallback(async (action, log) => {
    if (action === 'stream') {
      openStream(log.id, log.service_name, log.error_type)
      return
    }
    if (action === 'report') {
      const reportId = log.duplicate_of || log.id
      window.open(`/rca/${reportId}/report`, '_blank')
      return
    }
    if (action === 'run') {
      // Clear any stale cache for this incident so the panel always starts fresh,
      // whether this is a first run or a re-run of a completed/failed incident.
      clearStreamCache(log.id)
      // Open the SSE stream immediately — the stream endpoint starts the agent thread.
      // Do NOT await a synchronous trigger call; that would block the UI for the full
      // RCA duration (~2 min) before the panel opens.
      openStream(log.id, log.service_name, log.error_type)
    }
  }, [openStream, load])

  // Filter + search
  const visible = logs.filter(log => {
    if (filter !== 'all' && log.rca_status !== filter) return false
    if (search) {
      const q = search.toLowerCase()
      return (log.service_name || '').toLowerCase().includes(q) ||
             (log.error_type   || '').toLowerCase().includes(q) ||
             (log.error_message|| '').toLowerCase().includes(q)
    }
    return true
  })

  const secSince = Math.floor((Date.now() - lastRefresh) / 1000)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* ── Stat cards ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        {STAT_CARDS.map(card => (
          <StatCard
            key={card.key}
            card={card}
            value={stats[card.key]}
            isActive={filter === card.key}
            onClick={() => setFilter(f => f === card.key ? 'all' : card.key)}
          />
        ))}
      </div>

      {/* ── Toolbar ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {/* Search */}
        <div style={{ position: 'relative', flex: '1 1 220px', maxWidth: 320 }}>
          <svg style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#475569', pointerEvents: 'none' }}
            width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35" strokeLinecap="round"/>
          </svg>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search service, error…"
            style={{
              width: '100%', paddingLeft: 32, paddingRight: 10, paddingTop: 7, paddingBottom: 7,
              background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)',
              borderRadius: 8, fontSize: 12.5, color: '#E2E8F0', fontFamily: 'inherit', outline: 'none',
              transition: 'border-color 0.15s',
            }}
            onFocus={e => e.target.style.borderColor = 'rgba(99,102,241,0.5)'}
            onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.09)'}
          />
        </div>

        {/* Filter pills */}
        <div style={{ display: 'flex', gap: 4 }}>
          {FILTERS.map(f => {
            const card = STAT_CARDS.find(c => c.key === f.id)
            const active = filter === f.id
            return (
              <button key={f.id}
                onClick={() => setFilter(f.id)}
                style={{
                  padding: '5px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600,
                  fontFamily: 'inherit', cursor: 'pointer',
                  background: active ? (card?.dim || 'rgba(99,102,241,0.15)') : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${active ? (card?.border || 'rgba(99,102,241,0.35)') : 'rgba(255,255,255,0.08)'}`,
                  color: active ? (card?.color || '#818CF8') : '#64748B',
                  transition: 'all 0.14s',
                }}
              >
                {f.label}
                {f.id !== 'all' && stats[f.id] != null && (
                  <span style={{ marginLeft: 5, fontSize: 10, opacity: 0.7 }}>{stats[f.id]}</span>
                )}
              </button>
            )
          })}
        </div>

        {/* Right side */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 11, color: '#334155' }}>
            {visible.length} incident{visible.length !== 1 ? 's' : ''} · refreshed {secSince}s ago
          </span>
          <button
            onClick={load}
            style={{
              width: 30, height: 30, borderRadius: 7, border: '1px solid rgba(255,255,255,0.08)',
              background: 'rgba(255,255,255,0.04)', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748B',
              transition: 'all 0.14s',
            }}
            title="Refresh"
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; e.currentTarget.style.color = '#94A3B8' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.color = '#64748B' }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>
      </div>

      {/* ── Incident list ── */}
      {loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="skeleton" style={{ height: 72, borderRadius: 12 }} />
          ))}
        </div>
      )}

      {!loading && visible.length === 0 && (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          padding: '60px 20px', gap: 14, textAlign: 'center',
        }}>
          <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24 }}>
            {filter === 'all' ? '🔍' : filter === 'completed' ? '✓' : filter === 'failed' ? '✕' : '⏳'}
          </div>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#94A3B8' }}>
            {filter === 'all' && !search ? 'No incidents yet' : 'No matching incidents'}
          </div>
          <div style={{ fontSize: 13, color: '#475569' }}>
            {filter !== 'all' || search ? 'Try clearing your filters.' : 'Error logs will appear here once ingested.'}
          </div>
        </div>
      )}

      {!loading && visible.length > 0 && (
        <div>
          {visible.map(log => (
            <IncidentCard
              key={log.id}
              log={log}
              onAction={handleAction}
              loading={actionLoading}
            />
          ))}
        </div>
      )}

      {/* Keyframe for spinner (also used by ActionBtn) */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
