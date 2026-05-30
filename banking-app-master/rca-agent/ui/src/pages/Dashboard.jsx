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

const PAGE_TITLES = {
  logs:     'Log Explorer',
  rca:      'RCA Dashboard',
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

// ── Monitoring pill ────────────────────────────────────────────────────────────

function MonitoringControl() {
  const { logSource, setLogSource, monitoringActive, monitoringLoading, toggleMonitoring } = useApp()

  return (
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
        onClick={toggleMonitoring}
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
          {activeNav !== 'settings' && activeNav !== 'tokens' && <StatsBar />}

          {activeNav === 'logs'     && <LogViewer />}
          {activeNav === 'rca'      && <RCADashboard />}
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
