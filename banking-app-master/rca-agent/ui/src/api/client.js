const BASE = ''

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  })
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try { const j = await res.json(); detail = j.detail || detail } catch {}
    throw new Error(detail)
  }
  return res.json()
}

// Health
export const fetchHealth = () => request('/health')

// Stats
export const fetchStats = () => request('/api/stats')

// Logs
export const fetchLogs = (params = {}) => {
  const q = new URLSearchParams()
  if (params.page)      q.set('page', params.page)
  if (params.limit)     q.set('limit', params.limit)
  if (params.service)   q.set('service', params.service)
  if (params.severity)  q.set('severity', params.severity)
  if (params.risk_level) q.set('risk_level', params.risk_level)
  if (params.status)    q.set('status', params.status)
  return request(`/api/logs?${q}`)
}

export const fetchLog = (id) => request(`/api/logs/${id}`)

// Settings
export const fetchSettings = () => request('/api/settings')

export const saveSettings = (body) =>
  request('/api/settings', { method: 'POST', body: JSON.stringify(body) })

// Datadog logs
export const fetchDatadogLogs = (limit = 50) =>
  request(`/api/datadog/logs?limit=${limit}`)

// Token usage
export const fetchTokenUsage = (recentLimit = 50) =>
  request(`/api/token-usage?recent_limit=${recentLimit}`)

// Monitoring control
export const fetchMonitoring = () => request('/api/monitoring')

export const setMonitoring = (action) =>
  request('/api/monitoring', { method: 'POST', body: JSON.stringify({ action }) })

export const setSource = (source) =>
  request('/api/source', { method: 'POST', body: JSON.stringify({ source }) })

// RCA cancel
export const cancelRCA = (error_log_id) =>
  request(`/api/rca/cancel/${error_log_id}`, { method: 'POST' })

// Credential testing
export const testCredential = (body) =>
  request('/api/settings/test', { method: 'POST', body: JSON.stringify(body) })

// RCA
export const triggerRCA = (error_log_id) =>
  request('/api/rca/trigger', { method: 'POST', body: JSON.stringify({ error_log_id }) })

export const runRCA = (error_log_id) =>
  request('/rca/run', { method: 'POST', body: JSON.stringify({ error_log_id }) })

export const getRCAReport = (id) => `/rca/${id}/report`

/**
 * Open an SSE stream for RCA. Returns a cleanup function.
 * onEvent(event: object) called for each SSE message.
 * onError(err) called on connection error.
 */
export function streamRCA(error_log_id, onEvent, onError) {
  const es = new EventSource(`/api/rca/stream/${error_log_id}`)
  es.onmessage = (e) => {
    try { onEvent(JSON.parse(e.data)) } catch {}
  }
  es.onerror = (e) => {
    onError(e)
    es.close()
  }
  return () => es.close()
}
