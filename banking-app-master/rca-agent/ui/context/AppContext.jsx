import React, { createContext, useContext, useState, useCallback } from 'react'

const AppContext = createContext(null)

export function AppProvider({ children }) {
  const [activeNav, setActiveNav] = useState('logs')
  const [logSource, setLogSource] = useState('local') // 'local' | 'datadog'
  const [streamTarget, setStreamTarget] = useState(null) // { id, service, errorType }
  const [toast, setToast] = useState(null) // { message, type: 'success'|'error'|'info' }

  const showToast = useCallback((message, type = 'success') => {
    setToast({ message, type })
    setTimeout(() => setToast(null), 3500)
  }, [])

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
