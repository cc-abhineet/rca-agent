import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react'
import { fetchMonitoring, setMonitoring, setSource } from '../api/client'

const AppContext = createContext(null)

export function AppProvider({ children }) {
  const [activeNav, setActiveNav]           = useState('logs')
  const [logSource, setLogSourceState]      = useState('local')   // 'local' | 'datadog'
  // null = not yet synced (don't block UI); true/false = known state
  const [monitoringActive, setMonitoringActive] = useState(null)
  const [monitoringLoading, setMonitoringLoading] = useState(false)
  const [streamTarget, setStreamTarget]     = useState(null)
  const [toast, setToast]                   = useState(null)

  const showToast = useCallback((message, type = 'success') => {
    setToast({ message, type })
    setTimeout(() => setToast(null), 3500)
  }, [])

  // Sync monitoring state from backend on mount and every 15s
  const syncMonitoring = useCallback(() => {
    fetchMonitoring()
      .then(data => {
        setMonitoringActive(data.monitoring_active ?? true)
        setLogSourceState(data.source || 'local')
      })
      .catch(() => {
        // If ingestion-agent is unreachable, treat as stopped so UI isn't permanently blocked
        setMonitoringActive(prev => prev === null ? false : prev)
      })
  }, [])

  useEffect(() => {
    syncMonitoring()
    const id = setInterval(syncMonitoring, 15000)
    return () => clearInterval(id)
  }, [syncMonitoring])

  // Toggle monitoring (stop / start)
  const toggleMonitoring = useCallback(async () => {
    const action = monitoringActive ? 'stop' : 'start'
    setMonitoringLoading(true)
    try {
      const res = await setMonitoring(action)
      setMonitoringActive(res.monitoring_active ?? !monitoringActive)
      showToast(
        action === 'stop' ? 'Monitoring stopped' : 'Monitoring started',
        action === 'stop' ? 'info' : 'success',
      )
    } catch (e) {
      showToast(`Failed to ${action} monitoring`, 'error')
    } finally {
      setMonitoringLoading(false)
    }
  }, [monitoringActive, showToast])

  // Switch log source (only callable when monitoring is stopped or unknown)
  const setLogSource = useCallback(async (newSource) => {
    if (monitoringActive === true) return   // guard: toggle disabled while known-active
    setLogSourceState(newSource)
    try {
      await setSource(newSource)
    } catch {
      // best effort
    }
  }, [monitoringActive])

  const openStream = useCallback((id, service, errorType) => {
    setStreamTarget({ id, service, errorType })
  }, [])

  const closeStream = useCallback(() => {
    setStreamTarget(null)
  }, [])

  return (
    <AppContext.Provider value={{
      activeNav, setActiveNav,
      logSource, setLogSource,
      monitoringActive, monitoringLoading, toggleMonitoring,
      streamTarget, openStream, closeStream,
      toast, showToast,
    }}>
      {children}
    </AppContext.Provider>
  )
}

export function useApp() {
  return useContext(AppContext)
}
