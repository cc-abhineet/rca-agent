import React, { useState, useEffect, useCallback } from 'react'
import { Routes, Route, Navigate, useLocation, Outlet } from 'react-router-dom'
import { AppProvider } from './context/AppContext'
import { getToken } from './api/client'
import { fetchStats } from './api/client'

import Sidebar from './components/Sidebar'
import Login from './pages/Login'
import Landing from './pages/Landing'
import RCAWorkspace from './pages/RCAWorkspace'
import HomePage from './pages/HomePage'
import IncidentsPage from './pages/IncidentsPage'
import IntegrationsPage from './pages/IntegrationsPage'
import ProfilePage from './pages/ProfilePage'
import TokenUsage from './components/TokenUsage'
import ReportsPage from './components/ReportsPage'
import EvalSuitePage from './pages/EvalSuitePage'
import InvestigationsPage from './pages/InvestigationsPage'
import { useApp } from './context/AppContext'

function ProtectedRoute({ children }) {
  const location = useLocation()
  if (!getToken()) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />
  }
  return children
}

function Toast({ toast }) {
  if (!toast) return null
  return (
    <div className="toast-container">
      <div className={`toast toast-${toast.type}`}>
        {toast.type === 'success' && '✓ '}
        {toast.type === 'error'   && '✕ '}
        {toast.type === 'info'    && 'ℹ '}
        {toast.message}
      </div>
    </div>
  )
}

function TokenUsagePage() {
  return (
    <div className="ap-page">
      <div className="ap-page-header">
        <h1 className="ap-page-title">Token Usage</h1>
      </div>
      <TokenUsage />
    </div>
  )
}

function AppShell() {
  const { toast } = useApp()
  const [stats, setStats] = useState(null)

  const loadStats = useCallback(() => {
    if (!getToken()) return
    fetchStats().then(setStats).catch(() => {})
  }, [])

  useEffect(() => {
    loadStats()
    const id = setInterval(loadStats, 30000)
    return () => clearInterval(id)
  }, [loadStats])

  const hasActive = stats ? (stats.in_progress || 0) > 0 : false
  const incidentCount = stats ? (stats.pending || 0) + (stats.in_progress || 0) : 0

  return (
    <div className="ap-shell">
      <Sidebar hasActiveIncidents={hasActive} incidentCount={incidentCount} />
      <main className="ap-main">
        <Outlet />
      </main>
      <Toast toast={toast} />
    </div>
  )
}

export default function App() {
  return (
    <AppProvider>
      <Routes>
        {/* Public pages */}
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Login />} />

        {/* Protected shell — sidebar layout */}
        <Route
          element={
            <ProtectedRoute>
              <AppShell />
            </ProtectedRoute>
          }
        >
          <Route path="/home"         element={<HomePage />} />
          <Route path="/incidents"    element={<IncidentsPage />} />
          <Route path="/integrations" element={<IntegrationsPage />} />
          <Route path="/profile"      element={<ProfilePage />} />
          <Route path="/tokens"       element={<TokenUsagePage />} />
          <Route path="/reports"      element={<ReportsPage />} />
          <Route path="/eval"            element={<EvalSuitePage />} />
          <Route path="/investigations"  element={<InvestigationsPage />} />
        </Route>

        {/* Workspace — standalone (no sidebar) */}
        <Route
          path="/workspace/:errorLogId"
          element={
            <ProtectedRoute>
              <RCAWorkspace />
            </ProtectedRoute>
          }
        />

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppProvider>
  )
}
