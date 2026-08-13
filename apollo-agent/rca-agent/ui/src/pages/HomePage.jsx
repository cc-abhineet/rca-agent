import React, { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchStats, fetchLogs, fetchOrgIntegrations, fetchSettings, getUsername } from '../api/client'
import { useApp } from '../context/AppContext'

function fmtAge(ts) {
  if (!ts) return '—'
  try {
    const diff = Date.now() - new Date(ts + (ts.includes('Z') || ts.includes('+') ? '' : 'Z')).getTime()
    const m = Math.floor(diff / 60000)
    if (m < 60) return `${m}m ago`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h ago`
    return `${Math.floor(h / 24)}d ago`
  } catch { return '—' }
}

function fmtTTRC(seconds) {
  if (!seconds) return '—'
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

const INTEGRATIONS_CONFIG = [
  { id: 'datadog',    name: 'Datadog',     color: '#7C5CFC', glyph: '◐' },
  { id: 'gitlab',     name: 'GitHub',      color: '#E2502B', glyph: '⌥' },
  { id: 'kubernetes', name: 'Kubernetes',  color: '#326CE5', glyph: '⎈' },
  { id: 'cicd',       name: 'CI/CD',       color: '#1F8A5B', glyph: '⟲' },
  { id: 'config',     name: 'Config',      color: '#5B616E', glyph: '⚙' },
  { id: 'aws',        name: 'AWS',         color: '#C2780C', glyph: '☁' },
]

const SEV_COLOR = {
  critical: 'var(--critical)', high: 'var(--high)',
  medium: 'var(--medium)', low: 'var(--low)', error: 'var(--error)',
}

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
      {/* Radial glow */}
      <div style={{
        position: 'absolute', bottom: -24, left: -24, width: 180, height: 180,
        background: `radial-gradient(circle, ${accent || '#5B5BD6'}22 0%, transparent 65%)`,
        pointerEvents: 'none',
      }} />

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'auto', position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          {icon}
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '.01em' }}>{label}</span>
        </div>
        <span style={{ color: 'var(--text-muted)', cursor: 'default', fontSize: 18, lineHeight: 1, padding: '0 2px', userSelect: 'none' }}>⋮</span>
      </div>

      {/* Number */}
      <div style={{
        fontSize: 40, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1,
        color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums',
        margin: '14px 0 14px', position: 'relative',
      }}>{numVal}</div>

      {/* Trend badge */}
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

export default function HomePage() {
  const navigate  = useNavigate()
  const { activeOrg } = useApp()
  const username  = getUsername() || 'User'
  const hour      = new Date().getHours()
  const greeting  = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'

  const [stats,  setStats]  = useState(null)
  const [logs,   setLogs]   = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [lastRefreshed, setLastRefreshed] = useState(null)
  const [orgIntegrations, setOrgIntegrations] = useState([])
  const [globalSettings,  setGlobalSettings]  = useState({})

  const load = useCallback((manual = false) => {
    const orgId = activeOrg?.id || null
    if (manual) setRefreshing(true)
    Promise.all([
      fetchStats(orgId).catch(() => null),
      fetchLogs({ limit: 50, org_id: orgId }).catch(() => ({ items: [] })),
      fetchSettings().catch(() => ({})),
    ]).then(([s, l, cfg]) => {
      setStats(s)
      const all = l?.items || l || []
      setLogs(all.filter(log => log.rca_status === 'in_progress').slice(0, 5))
      setGlobalSettings(cfg || {})
      setLoading(false)
      setRefreshing(false)
      setLastRefreshed(new Date())
    })
  }, [activeOrg?.id])

  useEffect(() => { load() }, [load])

  // Auto-refresh every 15 seconds
  useEffect(() => {
    const id = setInterval(() => load(false), 15000)
    return () => clearInterval(id)
  }, [load])

  useEffect(() => {
    if (!activeOrg?.id) return
    fetchOrgIntegrations(activeOrg.id)
      .then(data => setOrgIntegrations(Array.isArray(data) ? data : []))
      .catch(() => {})
  }, [activeOrg?.id])

  const GIT_TYPES = ['github', 'gitlab', 'gitlab_self', 'code']

  const isConnected = (id) => {
    if (id === 'gitlab') {
      const orgIntg = orgIntegrations.find(i => GIT_TYPES.includes(i.integration_type) && i.is_connected)
      if (orgIntg) return true
      return !!(globalSettings.github_token || globalSettings.gitlab_token)
    }
    const orgIntg = orgIntegrations.find(i => i.integration_type === id && i.is_connected)
    if (orgIntg) return true
    if (id === 'datadog') return !!globalSettings.datadog_api_key
    return false
  }

  const active   = stats?.in_progress || 0
  const pending  = stats?.pending || 0
  const ttrc     = stats?.median_ttrc_seconds || null
  const subtitle = active > 0
    ? `${active} active investigation${active > 1 ? 's' : ''} in progress`
    : 'All systems nominal'

  const refreshLabel = lastRefreshed
    ? `Updated ${fmtAge(lastRefreshed.toISOString())}`
    : ''

  return (
    <div className="ap-page" style={{ gap: 24 }}>
      {/* Header */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 'var(--r-full)', padding: '2px 10px' }}>
            {activeOrg?.name || 'No org selected'} · {activeOrg?.environment || 'production'}
          </span>
        </div>
        <h1 style={{ fontSize: 26, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em', marginBottom: 4 }}>
          {greeting}, {username}
        </h1>
        <p style={{ fontSize: 14, color: 'var(--text-secondary)' }}>{subtitle}</p>
      </div>

      {/* Hero card */}
      <div style={{
        background: 'linear-gradient(135deg,#16181D,#23253A)',
        borderRadius: 'var(--r-xl)',
        padding: '28px 32px',
        color: '#fff',
        position: 'relative',
        overflow: 'hidden',
      }}>
        <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at 70% 50%,rgba(91,91,214,.18),transparent 60%)', pointerEvents: 'none' }} />
        <div style={{ position: 'relative' }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'rgba(255,255,255,.5)', marginBottom: 8 }}>Launch Apollo</div>
          <h2 style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', marginBottom: 8 }}>Start a root-cause investigation</h2>
          <p style={{ fontSize: 13, color: 'rgba(255,255,255,.6)', marginBottom: 24, maxWidth: 480, lineHeight: 1.6 }}>
            Select a service below, paste an alert payload, or browse open incidents to launch an AI-powered investigation.
          </p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              className="btn"
              style={{ background: 'rgba(255,255,255,.12)', color: '#fff', border: '1px solid rgba(255,255,255,.18)', fontSize: 13 }}
              onClick={() => navigate('/incidents')}
            >
              Browse open incidents
            </button>
            <button
              className="ap-btn-accent btn"
              style={{ fontSize: 13 }}
              onClick={() => navigate('/incidents')}
            >
              Launch investigation →
            </button>
          </div>
        </div>
      </div>

      {/* Stat cards */}
      <div className="ap-stat-grid" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
        <StatCard
          label="Total Alerts"
          value={loading ? '…' : (stats?.total ?? active)}
          accent="#EF4444"
          icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#EF4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>}
          trend={active > 0 ? `+${active}` : '0'}
          trendDir={active > 0 ? 'down' : 'info'}
          trendLabel="open now"
        />
        <StatCard
          label="Investigating"
          value={loading ? '…' : (stats?.in_progress || 0)}
          accent="#5B5BD6"
          icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5B5BD6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>}
          trend={pending > 0 ? `+${pending}` : '0'}
          trendDir={pending > 0 ? 'warn' : 'info'}
          trendLabel={pending > 0 ? 'queued' : 'nothing queued'}
        />
        <StatCard
          label="Avg. Resolution"
          value={loading ? '…' : fmtTTRC(ttrc)}
          accent="#10B981"
          icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>}
          trend={ttrc ? `${Math.round(ttrc / 60)}m` : '—'}
          trendDir="up"
          trendLabel="time to root cause"
        />
      </div>

      {/* Two-column grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* Active investigations */}
        <div className="ap-card">
          <div className="ap-card-header">
            <span className="ap-card-title">Active investigations</span>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {refreshLabel && (
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{refreshLabel}</span>
              )}
              <button
                className="ap-btn-ghost btn"
                style={{ fontSize: 13, padding: '4px 8px', lineHeight: 1 }}
                onClick={() => load(true)}
                disabled={refreshing}
                title="Refresh"
              >
                {refreshing ? '…' : '↻'}
              </button>
              <button
                className="ap-btn-ghost btn"
                style={{ fontSize: 12, padding: '4px 10px' }}
                onClick={() => navigate('/incidents')}
              >
                View all
              </button>
            </div>
          </div>
          <div style={{ padding: logs.length ? 0 : 20 }}>
            {loading ? (
              <div style={{ padding: 20 }}>
                {[1,2,3].map(i => <div key={i} className="skeleton skeleton-line" style={{ marginBottom: 12 }} />)}
              </div>
            ) : logs.length === 0 ? (
              <div className="empty-state" style={{ padding: '32px 20px' }}>
                <div className="empty-state-icon">✓</div>
                <div className="empty-state-title">No running investigations</div>
                <div className="empty-state-desc">Start one from the Incidents tab.</div>
              </div>
            ) : logs.map((log, i) => (
              <div
                key={log.id || i}
                onClick={() => navigate(`/workspace/${log.id}`)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '12px 20px',
                  borderBottom: i < logs.length - 1 ? '1px solid var(--hairline)' : 'none',
                  cursor: 'pointer', transition: 'background var(--t-fast)',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: SEV_COLOR[log.severity] || 'var(--text-muted)', flexShrink: 0, animation: 'pulseDot 1.5s ease infinite' }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {log.error_type || log.title || 'Unnamed incident'}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    {log.service} · {fmtAge(log.timestamp || log.created_at)}
                  </div>
                </div>
                <span style={{ fontSize: 11 }}>›</span>
              </div>
            ))}
          </div>
        </div>

        {/* Connected stack */}
        <div className="ap-card">
          <div className="ap-card-header">
            <span className="ap-card-title">Connected stack</span>
            <button
              className="ap-btn-ghost btn"
              style={{ fontSize: 12, padding: '4px 10px' }}
              onClick={() => navigate('/integrations')}
            >
              Manage
            </button>
          </div>
          <div style={{ padding: '4px 0' }}>
            {INTEGRATIONS_CONFIG.map((intg, i) => {
              const connected = isConnected(intg.id)
              return (
                <div
                  key={intg.name}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '10px 20px',
                    borderBottom: i < INTEGRATIONS_CONFIG.length - 1 ? '1px solid var(--hairline)' : 'none',
                  }}
                >
                  <div style={{ width: 32, height: 32, borderRadius: 8, background: connected ? `${intg.color}18` : 'var(--bg-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, color: connected ? intg.color : 'var(--text-muted)', flexShrink: 0, border: `1px solid ${connected ? intg.color + '30' : 'var(--border)'}` }}>
                    {intg.glyph}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{intg.name}</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <div style={{ width: 7, height: 7, borderRadius: '50%', background: connected ? 'var(--success)' : 'var(--text-muted)' }} />
                    <span style={{ fontSize: 11, color: connected ? 'var(--success)' : 'var(--text-muted)', fontWeight: 500 }}>
                      {connected ? 'Connected' : 'Not connected'}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
