const BASE = ''

// ── Token storage ─────────────────────────────────────────────────────────────
export function getToken()                    { return localStorage.getItem('apollo_token') }
export function getUsername()                 { return localStorage.getItem('apollo_username') }
export function setToken(token, username)     { localStorage.setItem('apollo_token', token); localStorage.setItem('apollo_username', username || '') }
export function clearToken()                  { localStorage.removeItem('apollo_token'); localStorage.removeItem('apollo_username') }

// ── Core fetch wrapper ────────────────────────────────────────────────────────
async function request(path, options = {}) {
  const token = getToken()
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {}),
  }
  const res = await fetch(`${BASE}${path}`, { ...options, headers })

  if (res.status === 401) {
    clearToken()
    // Only redirect from actual app pages — not from landing ('/') or login
    // itself, to avoid infinite reload loops on public pages.
    const p = window.location.pathname
    const isPublicPage = p === '/' || p.startsWith('/login')
    if (!isPublicPage) {
      window.location.href = '/login'
    }
    throw new Error('Session expired — please sign in again')
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try { const j = await res.json(); detail = j.detail || detail } catch {}
    throw new Error(detail)
  }
  return res.json()
}

// ── Auth endpoints ────────────────────────────────────────────────────────────
export const authLogin = (username, password) =>
  request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) })

export const authRegister = (username, password) =>
  request('/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) })

// ── Health ────────────────────────────────────────────────────────────────────
export const fetchHealth = () => request('/health')

// ── Stats ─────────────────────────────────────────────────────────────────────
export const fetchStats = () => request('/api/stats')

// ── Logs ──────────────────────────────────────────────────────────────────────
export const fetchLogs = (params = {}) => {
  const q = new URLSearchParams()
  if (params.page)       q.set('page', params.page)
  if (params.limit)      q.set('limit', params.limit)
  if (params.service)    q.set('service', params.service)
  if (params.severity)   q.set('severity', params.severity)
  if (params.risk_level) q.set('risk_level', params.risk_level)
  if (params.status)     q.set('status', params.status)
  return request(`/api/logs?${q}`)
}

export const fetchLog = (id) => request(`/api/logs/${id}`)

// ── Settings ──────────────────────────────────────────────────────────────────
export const fetchSettings = () => request('/api/settings')
export const saveSettings  = (body) =>
  request('/api/settings', { method: 'POST', body: JSON.stringify(body) })

// ── Datadog ───────────────────────────────────────────────────────────────────
export const fetchDatadogLogs = (limit = 50) =>
  request(`/api/datadog/logs?limit=${limit}`)

// ── Token usage ───────────────────────────────────────────────────────────────
export const fetchTokenUsage = (recentLimit = 50) =>
  request(`/api/token-usage?recent_limit=${recentLimit}`)

export const fetchTokenUsageByIncident = (limit = 50) =>
  request(`/api/token-usage/by-incident?limit=${limit}`)

// ── Monitoring ────────────────────────────────────────────────────────────────
export const fetchMonitoring = () => request('/api/monitoring')
export const setMonitoring   = (action) =>
  request('/api/monitoring', { method: 'POST', body: JSON.stringify({ action }) })
export const setSource       = (source) =>
  request('/api/source', { method: 'POST', body: JSON.stringify({ source }) })

// ── RCA ───────────────────────────────────────────────────────────────────────
export const cancelRCA   = (error_log_id) =>
  request(`/api/rca/cancel/${error_log_id}`, { method: 'POST' })
export const testCredential = (body) =>
  request('/api/settings/test', { method: 'POST', body: JSON.stringify(body) })
export const triggerRCA  = (error_log_id) =>
  request('/api/rca/trigger', { method: 'POST', body: JSON.stringify({ error_log_id }) })
export const runRCA      = (error_log_id) =>
  request('/rca/run', { method: 'POST', body: JSON.stringify({ error_log_id }) })

// Report URL — token passed as query param so window.open() works without headers
export const getRCAReport = (id) => {
  const token = getToken()
  return token ? `/rca/${id}/report?token=${encodeURIComponent(token)}` : `/rca/${id}/report`
}

// ── SSE stream ────────────────────────────────────────────────────────────────
// EventSource doesn't support custom headers, so the token goes in the query string.
export function streamRCA(error_log_id, onEvent, onError) {
  const token = getToken()
  const url   = token
    ? `/api/rca/stream/${error_log_id}?token=${encodeURIComponent(token)}`
    : `/api/rca/stream/${error_log_id}`
  const es = new EventSource(url)
  es.onmessage = (e) => { try { onEvent(JSON.parse(e.data)) } catch {} }
  es.onerror   = (e) => { onError(e); es.close() }
  return () => es.close()
}
