import React, { useEffect, useState, useCallback } from 'react'
import { fetchHealth } from '../api/client'
import { useApp } from '../context/AppContext'
import Sidebar from '../components/Sidebar'
import StatsBar from '../components/StatsBar'
import LogViewer from '../components/LogViewer'
import RCADashboard from '../components/RCADashboard'
import RCAStreamPanel from '../components/RCAStreamPanel'
import Settings from '../components/Settings'

const PAGE_TITLES = {
  logs:     'Log Explorer',
  rca:      'RCA Dashboard',
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

export default function Dashboard() {
  const { activeNav, logSource, setLogSource, streamTarget, toast } = useApp()
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

          {(activeNav === 'logs') && (
            <div className="toggle-group">
              <button
                className={`toggle-option${logSource === 'local' ? ' active' : ''}`}
                onClick={() => setLogSource('local')}
              >
                Local DB
              </button>
              <button
                className={`toggle-option${logSource === 'datadog' ? ' active' : ''}`}
                onClick={() => setLogSource('datadog')}
              >
                Datadog
              </button>
            </div>
          )}

          <div className="header-status">
            <div className={`header-status-dot ${healthOk ? 'ok' : 'error'}`} />
            <span>{healthOk ? 'API Online' : 'API Offline'}</span>
          </div>
        </header>

        {/* Page content */}
        <main className="page-content">
          {activeNav !== 'settings' && <StatsBar />}

          {activeNav === 'logs' && <LogViewer />}
          {activeNav === 'rca'  && <RCADashboard />}
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
