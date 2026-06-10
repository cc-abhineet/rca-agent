import React, { useEffect, useState, useCallback } from 'react'
import { fetchHealth } from '../api/client'
import { useApp } from '../context/AppContext'
import Sidebar from '../components/Sidebar'
import StatsBar from '../components/StatsBar'
import LogViewer from '../components/LogViewer'
import RCADashboard from '../components/RCADashboard'
import RCAStreamPanel from '../components/RCAStreamPanel'
import Settings from '../components/Settings'
import TokenUsage from '../components/TokenUsage'
import ReportsPage from '../components/ReportsPage'

const PAGE_TITLES = {
  logs:     'Log Explorer',
  rca:      'RCA Dashboard',
  reports:  'RCA Reports',
  tokens:   'Token Consumption',
  settings: 'Settings',
}

function Toast({ toast }) {
  if (!toast) return null
  return (
    <div className="toast-container">
      <div className={`toast toast-${toast.type}`}>
        {toast.type === 'success' && '✓'}
        {toast.type === 'error'   && '✕'}
        {toast.type === 'info'    && 'ℹ'}
        {toast.message}
      </div>
    </div>
  )
}

// ── Datadog active popup ───────────────────────────────────────────────────────

function DatadogActivePopup({ onClose }) {
  const [progress, setProgress] = useState(100)

  useEffect(() => {
    const DURATION = 5000
    const TICK = 50
    const step = (TICK / DURATION) * 100
    const iv = setInterval(() => {
      setProgress(p => {
        if (p - step <= 0) { clearInterval(iv); onClose(); return 0 }
        return p - step
      })
    }, TICK)
    return () => clearInterval(iv)
  }, [onClose])

  return (
    <>
      {/* Toast card */}
      <div style={{
        position: 'fixed', top: 72, right: 20,
        zIndex: 1101,
        width: 320,
        borderRadius: 14,
        background: 'linear-gradient(145deg, rgba(15,20,40,0.97) 0%, rgba(10,14,30,0.98) 100%)',
        border: '1px solid rgba(99,102,241,0.35)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.04), inset 0 1px 0 rgba(255,255,255,0.06)',
        overflow: 'hidden',
        animation: 'ddSlideIn 0.35s cubic-bezier(0.34,1.56,0.64,1)',
      }}>

        {/* Auto-dismiss progress bar */}
        <div style={{ height: 3, background: 'rgba(255,255,255,0.06)' }}>
          <div style={{
            height: '100%',
            width: `${progress}%`,
            background: 'linear-gradient(90deg, #6366F1, #06B6D4)',
            transition: 'width 0.05s linear',
          }} />
        </div>

        <div style={{ padding: '14px 16px 16px' }}>

          {/* Header row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 9, flexShrink: 0,
              background: 'linear-gradient(135deg, rgba(99,102,241,0.25) 0%, rgba(6,182,212,0.18) 100%)',
              border: '1px solid rgba(99,102,241,0.3)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 18,
            }}>📊</div>

            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: '#F1F5F9' }}>
                Datadog Monitoring Active
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 2 }}>
                <span style={{
                  width: 6, height: 6, borderRadius: '50%', background: '#10B981',
                  boxShadow: '0 0 5px #10B981', display: 'inline-block', flexShrink: 0,
                  animation: 'ddPulse 1.4s ease infinite',
                }} />
                <span style={{ fontSize: 11, color: '#10B981', fontWeight: 600, letterSpacing: '0.04em' }}>LIVE</span>
              </div>
            </div>

            <button
              onClick={onClose}
              style={{
                width: 24, height: 24, borderRadius: 6, border: '1px solid rgba(255,255,255,0.08)',
                background: 'transparent', cursor: 'pointer', color: '#475569',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12,
                flexShrink: 0, transition: 'all 0.14s', fontFamily: 'inherit',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(239,68,68,0.1)'; e.currentTarget.style.color = '#F87171' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#475569' }}
            >✕</button>
          </div>

          {/* Message */}
          <div style={{ fontSize: 12.5, color: '#94A3B8', lineHeight: 1.55, marginBottom: 12 }}>
            Logs are now being{' '}
            <span style={{ color: '#67E8F9', fontWeight: 600 }}>extracted from Datadog</span>
            {' '}and written to the database in real time.
          </div>

          {/* Info chips */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[
              { icon: '⚡', value: 'Datadog Logs API' },
              { icon: '🔄', value: 'Real-time polling' },
              { icon: '🗄', value: 'MySQL rca_db' },
            ].map(chip => (
              <div key={chip.value} style={{
                display: 'flex', alignItems: 'center', gap: 5,
                padding: '3px 8px', borderRadius: 6,
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.07)',
                fontSize: 11, color: '#64748B',
              }}>
                <span>{chip.icon}</span>
                <span>{chip.value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes ddSlideIn { from { opacity: 0; transform: translateX(24px) } to { opacity: 1; transform: translateX(0) } }
        @keyframes ddPulse   { 0%,100% { opacity: 1; transform: scale(1) } 50% { opacity: 0.5; transform: scale(1.5) } }
      `}</style>
    </>
  )
}

// ── Monitoring pill ────────────────────────────────────────────────────────────

function MonitoringControl() {
  const { logSource, setLogSource, monitoringActive, monitoringLoading, toggleMonitoring } = useApp()
  const [showDdPopup, setShowDdPopup] = useState(false)

  const handleToggle = useCallback(async () => {
    const isStarting = !monitoringActive
    await toggleMonitoring()
    if (isStarting && logSource === 'datadog') {
      setShowDdPopup(true)
    }
  }, [monitoringActive, logSource, toggleMonitoring])

  return (
    <>
      {showDdPopup && <DatadogActivePopup onClose={() => setShowDdPopup(false)} />}

      <div className="monitoring-control">
        {/* Source toggle — disabled while monitoring is active */}
        <div
          className={`toggle-group source-toggle${monitoringActive === true ? ' toggle-disabled' : ''}`}
          title={monitoringActive === true ? 'Stop monitoring to switch source' : 'Select log source'}
        >
          <button
            className={`toggle-option${logSource === 'local' ? ' active' : ''}`}
            onClick={() => setLogSource('local')}
            disabled={monitoringActive === true}
          >
            Local DB
          </button>
          <button
            className={`toggle-option${logSource === 'datadog' ? ' active' : ''}`}
            onClick={() => setLogSource('datadog')}
            disabled={monitoringActive === true}
          >
            Datadog
          </button>
        </div>

        {/* Divider */}
        <div className="monitoring-divider" />

        {/* Stop / Start monitoring button */}
        <button
          className={`btn monitoring-btn${monitoringActive === true ? ' monitoring-btn-stop' : ' monitoring-btn-start'}`}
          onClick={handleToggle}
          disabled={monitoringLoading}
          title={monitoringActive === true ? 'Stop monitoring' : 'Start monitoring'}
        >
          {monitoringLoading ? (
            <span className="monitoring-spinner" />
          ) : monitoringActive === true ? (
            <>
              <span className="monitoring-live-dot" />
              Stop Monitoring
            </>
          ) : (
            <>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
              Start Monitoring
            </>
          )}
        </button>
      </div>
    </>
  )
}

export default function Dashboard() {
  const { activeNav, streamTarget, toast } = useApp()
  const [healthOk, setHealthOk] = useState(true)

  const checkHealth = useCallback(() => {
    fetchHealth()
      .then(() => setHealthOk(true))
      .catch(() => setHealthOk(false))
  }, [])

  useEffect(() => {
    checkHealth()
    const id = setInterval(checkHealth, 15000)
    return () => clearInterval(id)
  }, [checkHealth])

  const pageTitle = PAGE_TITLES[activeNav] || 'Apollo'

  return (
    <div className="dashboard-layout">
      <Sidebar healthOk={healthOk} />

      <div className="main-area">
        {/* Header */}
        <header className="dashboard-header">
          <span className="header-title">{pageTitle}</span>

          {/* Monitoring controls — always visible */}
          <MonitoringControl />

          <div className="header-status">
            <div className={`header-status-dot ${healthOk ? 'ok' : 'error'}`} />
            <span>{healthOk ? 'API Online' : 'API Offline'}</span>
          </div>
        </header>

        {/* Page content */}
        <main className="page-content">
          {activeNav !== 'settings' && activeNav !== 'tokens' && activeNav !== 'reports' && <StatsBar />}

          {activeNav === 'logs'     && <LogViewer />}
          {activeNav === 'rca'      && <RCADashboard />}
          {activeNav === 'reports'  && <ReportsPage />}
          {activeNav === 'tokens'   && <TokenUsage />}
          {activeNav === 'settings' && <Settings />}
        </main>
      </div>

      {/* RCA Stream overlay */}
      {streamTarget && <RCAStreamPanel />}

      {/* Toast notifications */}
      <Toast toast={toast} />
    </div>
  )
}
