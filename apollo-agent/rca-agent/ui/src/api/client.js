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
export const fetchStats = (orgId = null) => {
  const q = orgId ? `?org_id=${encodeURIComponent(orgId)}` : ''
  return request(`/api/stats${q}`)
}

// ── Logs ──────────────────────────────────────────────────────────────────────
export const fetchLogs = (params = {}) => {
  const q = new URLSearchParams()
  if (params.org_id)     q.set('org_id', params.org_id)
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
export const triggerRCA  = (error_log_id, org_id = null) =>
  request('/api/rca/trigger', { method: 'POST', body: JSON.stringify({ error_log_id, ...(org_id ? { org_id } : {}) }) })
export const runRCA      = (error_log_id) =>
  request('/rca/run', { method: 'POST', body: JSON.stringify({ error_log_id }) })

// Report URL — token passed as query param so window.open() works without headers
export const getRCAReport = (id) => {
  const token = getToken()
  return token ? `/rca/${id}/report?token=${encodeURIComponent(token)}` : `/rca/${id}/report`
}

// ── SSE stream ────────────────────────────────────────────────────────────────
// EventSource doesn't support custom headers, so the token goes in the query string.
export function streamRCA(error_log_id, onEvent, onError, org_id = null) {
  const token = getToken()
  const params = new URLSearchParams()
  if (token)  params.set('token', token)
  if (org_id) params.set('org_id', org_id)
  const qs  = params.toString()
  const url = `/api/rca/stream/${error_log_id}${qs ? '?' + qs : ''}`
  const es  = new EventSource(url)
  es.onmessage = (e) => { try { onEvent(JSON.parse(e.data)) } catch {} }
  es.onerror   = (e) => { onError(e); es.close() }
  return () => es.close()
}

// ── Org / integration endpoints ──────────────────────────────────────────────
export const fetchOrgs         = ()               => request('/api/orgs')
export const createOrg         = (body)           => request('/api/orgs', { method: 'POST', body: JSON.stringify(body) })
export const deleteOrg         = (id)             => request(`/api/orgs/${id}`, { method: 'DELETE' })
export const activateOrg       = (orgId)          => request(`/api/orgs/${orgId}/activate`, { method: 'POST' })
export const fetchOrgIntegrations = (orgId)       => request(`/api/orgs/${orgId}/integrations`)
export const saveOrgIntegration   = (orgId, type, config) =>
  request(`/api/orgs/${orgId}/integrations/${type}`, { method: 'PUT', body: JSON.stringify({ config }) })
export const fetchIngestKey    = (orgId)          => request(`/api/orgs/${orgId}/ingest-key`)

// ── Chat stream ────────────────────────────────────────────────────────────────
// POST-based SSE for follow-up chat (EventSource doesn't support POST).
// Returns a cancel function.
export function streamChat(error_log_id, messages, { onChunk, onToolCall, onToolResult, onDone, onError }, org_id = null) {
  const token = getToken()
  const ctrl  = new AbortController()

  fetch(`/api/chat/${error_log_id}`, {
    method: 'POST',
    signal: ctrl.signal,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ messages, ...(org_id ? { org_id } : {}) }),
  })
    .then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''

      function read() {
        reader.read().then(({ done, value }) => {
          if (done) { onDone?.(); return }
          buf += decoder.decode(value, { stream: true })
          const parts = buf.split('\n')
          buf = parts.pop() ?? ''
          for (const line of parts) {
            if (!line.startsWith('data: ')) continue
            try {
              const ev = JSON.parse(line.slice(6))
              if (ev.type === 'chunk')       onChunk?.(ev.text)
              else if (ev.type === 'tool_call')   onToolCall?.(ev)
              else if (ev.type === 'tool_result') onToolResult?.(ev)
              else if (ev.type === 'done')   { onDone?.(); return }
              else if (ev.type === 'error')  { onError?.(ev.message); return }
            } catch {}
          }
          read()
        }).catch(err => { if (!ctrl.signal.aborted) onError?.(String(err)) })
      }
      read()
    })
    .catch(err => { if (!ctrl.signal.aborted) onError?.(String(err)) })

  return () => ctrl.abort()
}
