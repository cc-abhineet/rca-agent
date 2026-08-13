import React, { useState, useEffect } from 'react'
import { fetchSettings, saveSettings, testCredential, fetchOrgIntegrations, saveOrgIntegration } from '../api/client'
import { useApp } from '../context/AppContext'

function EyeBtn({ show, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={show ? 'Hide' : 'Show'}
      style={{
        flexShrink: 0, padding: '0 10px', background: 'var(--bg-2)',
        border: '1px solid var(--border)', borderRadius: 7, cursor: 'pointer',
        display: 'flex', alignItems: 'center', color: 'var(--text-muted)',
        transition: 'color .15s',
      }}
    >
      {show ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
          <line x1="1" y1="1" x2="23" y2="23"/>
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
      )}
    </button>
  )
}

const INTEGRATIONS = [
  {
    id: 'claude',
    name: 'Claude AI',
    color: '#E47B38',
    glyph: '⚡',
    desc: 'Powers all RCA analysis, chat, and reasoning. Set your API key, model, and iteration limits.',
    tools: 13,
    functional: true,
  },
  {
    id: 'datadog',
    name: 'Datadog',
    color: '#7C5CFC',
    glyph: '◐',
    desc: 'Pull logs, metrics, and traces from Datadog in real time.',
    tools: 4,
    functional: true,
  },
  {
    id: 'gitlab',
    name: 'GitHub / GitLab',
    color: '#E2502B',
    glyph: '⌥',
    desc: 'Connect your code repositories for blame and diff analysis.',
    tools: 6,
    functional: true,
  },
  {
    id: 'kubernetes',
    name: 'Kubernetes / EKS',
    color: '#326CE5',
    glyph: '⎈',
    desc: 'Inspect pod logs, events, and cluster health.',
    tools: 5,
    functional: false,
  },
  {
    id: 'cicd',
    name: 'CI/CD Pipelines',
    color: '#1F8A5B',
    glyph: '⟲',
    desc: 'Link build and deploy pipelines to incident context.',
    tools: 3,
    functional: false,
  },
  {
    id: 'config',
    name: 'Configuration',
    color: '#5B616E',
    glyph: '⚙',
    desc: 'Connect feature flags and config management.',
    tools: 2,
    functional: false,
  },
  {
    id: 'aws',
    name: 'AWS Cloud',
    color: '#C2780C',
    glyph: '☁',
    desc: 'Query CloudWatch, S3, and infrastructure data.',
    tools: 7,
    functional: false,
  },
]

function ClaudeModal({ orgConfig, settings, activeOrg, onClose, onSaved }) {
  const { showToast } = useApp()
  const [form, setForm] = useState({
    anthropic_api_key: orgConfig?.anthropic_api_key || '',
    model:             orgConfig?.model             || settings?.model || 'claude-sonnet-4-6',
    max_iterations:    parseInt(orgConfig?.max_iterations || settings?.max_react_iterations || 20),
  })
  const [saving,     setSaving]     = useState(false)
  const [testing,    setTesting]    = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [showKey,    setShowKey]    = useState(false)

  const update = k => e => setForm(f => ({ ...f, [k]: e.target.value }))

  const handleTest = async () => {
    if (!form.anthropic_api_key) { showToast('Enter your API key first', 'error'); return }
    setTesting(true)
    setTestResult(null)
    try {
      const res = await testCredential({ key_type: 'anthropic', api_key: form.anthropic_api_key })
      setTestResult({ ok: res.valid, msg: res.message })
    } catch (e) {
      setTestResult({ ok: false, msg: e.message || 'Test failed' })
    } finally { setTesting(false) }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      if (activeOrg?.id) {
        await saveOrgIntegration(activeOrg.id, 'claude', {
          anthropic_api_key: form.anthropic_api_key,
          model:             form.model,
          max_iterations:    parseInt(form.max_iterations),
        })
      } else {
        await saveSettings({
          anthropic_api_key:    form.anthropic_api_key,
          model:                form.model,
          max_react_iterations: parseInt(form.max_iterations),
        })
      }
      showToast('Claude AI settings saved', 'success')
      onSaved?.()
      onClose()
    } catch (e) {
      showToast(e.message || 'Save failed', 'error')
    } finally { setSaving(false) }
  }

  return (
    <div className="ap-modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="ap-modal">
        <div className="ap-modal-header">
          <span className="ap-modal-title">Configure Claude AI</span>
          <button className="ap-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="ap-modal-body">

          <div className="form-group">
            <label className="form-label">Anthropic API Key *</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type={showKey ? 'text' : 'password'}
                className="form-input"
                value={form.anthropic_api_key}
                onChange={update('anthropic_api_key')}
                placeholder="sk-ant-api03-••••"
                style={{ flex: 1 }}
              />
              <EyeBtn show={showKey} onToggle={() => setShowKey(s => !s)} />
            </div>
            <span className="form-help">Get your key at console.anthropic.com → API Keys. Encrypted before storage.</span>
          </div>

          {testResult && (
            <div style={{
              padding: '10px 12px', borderRadius: 8, marginBottom: 4, fontSize: 12.5, lineHeight: 1.5,
              background: testResult.ok ? 'rgba(34,197,94,.08)' : 'rgba(239,68,68,.08)',
              border: `1px solid ${testResult.ok ? 'rgba(34,197,94,.3)' : 'rgba(239,68,68,.3)'}`,
              color: testResult.ok ? '#15803d' : '#dc2626',
            }}>
              {testResult.ok ? '✓ ' : '✗ '}{testResult.msg}
            </div>
          )}

          <div style={{ height: 1, background: 'var(--hairline)', margin: '4px 0 16px' }} />

          <div className="form-group">
            <label className="form-label">Model</label>
            <select className="form-select" value={form.model} onChange={update('model')}>
              <option value="claude-sonnet-4-6">claude-sonnet-4-6 — Recommended</option>
              <option value="claude-opus-4-8">claude-opus-4-8 — Most capable</option>
              <option value="claude-haiku-4-5-20251001">claude-haiku-4-5-20251001 — Fastest / cheapest</option>
            </select>
            <span className="form-help">Model used for all RCA analysis and chat in this organization.</span>
          </div>

          <div className="form-group">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <label className="form-label" style={{ marginBottom: 0 }}>Max ReAct iterations</label>
              <span style={{
                fontSize: 13, fontWeight: 700, color: 'var(--indigo)',
                background: 'var(--indigo-tint)', borderRadius: 6, padding: '2px 10px',
              }}>{form.max_iterations}</span>
            </div>
            <input
              type="range" min={5} max={40} step={1}
              value={form.max_iterations}
              onChange={update('max_iterations')}
              style={{ width: '100%', accentColor: 'var(--indigo)', marginBottom: 6 }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)' }}>
              <span>5 — fast</span>
              <span>20 — default</span>
              <span>40 — thorough</span>
            </div>
            <span className="form-help" style={{ marginTop: 6 }}>
              Higher = more thorough analysis, slower and more expensive per run.
            </span>
          </div>

        </div>
        <div className="ap-modal-footer">
          <button className="ap-btn-ghost btn" onClick={handleTest} disabled={testing}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <button className="ap-btn-primary btn" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function DatadogModal({ orgConfig, settings, activeOrg, onClose, onSaved }) {
  const { showToast } = useApp()
  const [form, setForm] = useState({
    datadog_api_key: orgConfig?.datadog_api_key || settings?.datadog_api_key || '',
    datadog_app_key: orgConfig?.datadog_app_key || settings?.datadog_app_key || '',
    datadog_site:    orgConfig?.datadog_site    || settings?.datadog_site    || 'datadoghq.com',
  })
  const [saving,  setSaving]  = useState(false)
  const [testing, setTesting] = useState(false)
  const [showApi, setShowApi] = useState(false)
  const [showApp, setShowApp] = useState(false)

  const update = k => e => setForm(f => ({ ...f, [k]: e.target.value }))

  const handleTest = async () => {
    setTesting(true)
    try {
      const res = await testCredential({ key_type: 'datadog', api_key: form.datadog_api_key, app_key: form.datadog_app_key })
      if (res.valid) showToast(res.message, 'success')
      else showToast(res.message, 'error')
    } catch (e) {
      showToast(e.message || 'Connection failed', 'error')
    } finally { setTesting(false) }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      if (activeOrg?.id) {
        await saveOrgIntegration(activeOrg.id, 'datadog', form)
      } else {
        await saveSettings(form)
      }
      showToast('Datadog settings saved', 'success')
      onSaved?.()
      onClose()
    } catch (e) {
      showToast(e.message || 'Save failed', 'error')
    } finally { setSaving(false) }
  }

  return (
    <div className="ap-modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="ap-modal">
        <div className="ap-modal-header">
          <span className="ap-modal-title">Configure Datadog</span>
          <button className="ap-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="ap-modal-body">
          <div className="form-group">
            <label className="form-label">API Key</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input type={showApi ? 'text' : 'password'} className="form-input" value={form.datadog_api_key} onChange={update('datadog_api_key')} placeholder="••••••••" style={{ flex: 1 }} />
              <EyeBtn show={showApi} onToggle={() => setShowApi(s => !s)} />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Application Key</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input type={showApp ? 'text' : 'password'} className="form-input" value={form.datadog_app_key} onChange={update('datadog_app_key')} placeholder="••••••••" style={{ flex: 1 }} />
              <EyeBtn show={showApp} onToggle={() => setShowApp(s => !s)} />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Site</label>
            <select className="form-select" value={form.datadog_site} onChange={update('datadog_site')}>
              <option value="datadoghq.com">US1 — datadoghq.com</option>
              <option value="datadoghq.eu">EU — datadoghq.eu</option>
              <option value="us3.datadoghq.com">US3 — us3.datadoghq.com</option>
              <option value="us5.datadoghq.com">US5 — us5.datadoghq.com</option>
            </select>
          </div>
        </div>
        <div className="ap-modal-footer">
          <button className="ap-btn-ghost btn" onClick={handleTest} disabled={testing}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <button className="ap-btn-primary btn" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

function GitlabModal({ orgConfig, settings, activeOrg, onClose, onSaved }) {
  const { showToast } = useApp()
  const [form, setForm] = useState({
    provider:        orgConfig?.provider        || 'github',
    gitlab_base_url: orgConfig?.gitlab_base_url || '',
    gitlab_token:    orgConfig?.gitlab_token    || '',
    github_token:    orgConfig?.github_token    || '',
    github_org:      orgConfig?.github_org      || settings?.github_org || '',
  })
  const [saving,     setSaving]     = useState(false)
  const [testing,    setTesting]    = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [showToken,  setShowToken]  = useState(false)
  const update = k => e => setForm(f => ({ ...f, [k]: e.target.value }))

  const isGitLab = form.provider !== 'github'

  const handleTest = async () => {
    const token = isGitLab ? form.gitlab_token : form.github_token
    if (!token) { showToast('Enter a token first', 'error'); return }
    setTesting(true)
    setTestResult(null)
    try {
      const res = await testCredential({
        key_type: isGitLab ? 'gitlab' : 'github',
        api_key:  token,
        base_url: isGitLab ? (form.gitlab_base_url || 'https://gitlab.com') : undefined,
      })
      setTestResult({ ok: res.valid, msg: res.message })
    } catch (e) {
      setTestResult({ ok: false, msg: e.message || 'Test failed' })
    } finally { setTesting(false) }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      if (activeOrg?.id) {
        await saveOrgIntegration(activeOrg.id, form.provider || 'github', form)
      } else {
        await saveSettings(form)
      }
      showToast('Code repository settings saved', 'success')
      onSaved?.()
      onClose()
    } catch (e) {
      showToast(e.message || 'Save failed', 'error')
    } finally { setSaving(false) }
  }

  return (
    <div className="ap-modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="ap-modal">
        <div className="ap-modal-header">
          <span className="ap-modal-title">Configure GitHub / GitLab</span>
          <button className="ap-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="ap-modal-body">
          <div className="form-group">
            <label className="form-label">Provider</label>
            <select className="form-select" value={form.provider} onChange={update('provider')}>
              <option value="github">GitHub</option>
              <option value="gitlab">GitLab (cloud)</option>
              <option value="gitlab_self">GitLab (self-managed)</option>
            </select>
          </div>
          {isGitLab && (
            <div className="form-group">
              <label className="form-label">Base URL</label>
              <input className="form-input" value={form.gitlab_base_url} onChange={update('gitlab_base_url')} placeholder="https://gitlab.company.com" />
            </div>
          )}
          <div className="form-group">
            <label className="form-label">Personal Access Token</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type={showToken ? 'text' : 'password'}
                className="form-input"
                value={isGitLab ? form.gitlab_token : form.github_token}
                onChange={update(isGitLab ? 'gitlab_token' : 'github_token')}
                placeholder="••••••••"
                style={{ flex: 1 }}
              />
              <EyeBtn show={showToken} onToggle={() => setShowToken(s => !s)} />
            </div>
            <span className="form-help">
              {form.provider === 'github' ? 'Needs repo, read:org scope' : 'Needs read_api, read_repository scope'}
            </span>
          </div>
          <div className="form-group">
            <label className="form-label">Default group / org</label>
            <input className="form-input" value={form.github_org} onChange={update('github_org')} placeholder="my-org" />
          </div>

          {testResult && (
            <div style={{
              padding: '10px 12px', borderRadius: 8, fontSize: 12.5, lineHeight: 1.5,
              background: testResult.ok ? 'rgba(34,197,94,.08)' : 'rgba(239,68,68,.08)',
              border: `1px solid ${testResult.ok ? 'rgba(34,197,94,.3)' : 'rgba(239,68,68,.3)'}`,
              color: testResult.ok ? '#15803d' : '#dc2626',
            }}>
              {testResult.ok ? '✓ ' : '✗ '}{testResult.msg}
            </div>
          )}
        </div>
        <div className="ap-modal-footer">
          <button className="ap-btn-ghost btn" onClick={handleTest} disabled={testing}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <button className="ap-btn-primary btn" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ToggleSwitch({ on, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      role="switch"
      aria-checked={on}
      style={{
        width: 44, height: 24, borderRadius: 12, border: 'none',
        cursor: 'pointer', flexShrink: 0, padding: 0,
        background: on ? 'var(--indigo)' : 'var(--border)',
        position: 'relative', transition: 'background .2s',
      }}
    >
      <div style={{
        width: 18, height: 18, borderRadius: '50%', background: '#fff',
        position: 'absolute', top: 3, left: on ? 23 : 3,
        transition: 'left .2s', boxShadow: '0 1px 3px rgba(0,0,0,.25)',
      }} />
    </button>
  )
}

function IngestAgentModal({ orgId, current, onClose, onSaved }) {
  const { showToast } = useApp()
  const defaultMode = current?.log_file_paths ? (current?.mode || 'db') : 'datadog_poll'
  const [form, setForm] = useState({
    gemini_api_key: current?.gemini_api_key || '',
    service_name:   current?.service_name   || '',
    log_file_paths: current?.log_file_paths || '',
    mode:           defaultMode,
    environment:    current?.environment    || 'production',
    dd_api_key:     current?.dd_api_key     || '',
    dd_app_key:     current?.dd_app_key     || '',
    dd_site:        current?.dd_site        || 'datadoghq.com',
  })
  const [saving,      setSaving]      = useState(false)
  const [showGemini,  setShowGemini]  = useState(false)
  const [showDDApi,   setShowDDApi]   = useState(false)
  const [showDDApp,   setShowDDApp]   = useState(false)
  const update = k => e => setForm(f => ({ ...f, [k]: e.target.value }))

  const hasLogPaths  = form.log_file_paths.trim().length > 0
  const localEnabled = form.mode === 'db'
  const useDatadog   = form.mode === 'datadog_poll'

  const handlePathsChange = (e) => {
    const val = e.target.value
    setForm(f => ({ ...f, log_file_paths: val, mode: val.trim() ? 'db' : 'datadog_poll' }))
  }

  const toggleLocalWatch = () => {
    setForm(f => ({ ...f, mode: f.mode === 'db' ? 'datadog_poll' : 'db' }))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await saveOrgIntegration(orgId, 'ingestion', form)
      showToast('Ingestion config saved', 'success')
      onSaved?.()
      onClose()
    } catch (e) {
      showToast(e.message || 'Save failed', 'error')
    } finally { setSaving(false) }
  }

  return (
    <div className="ap-modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="ap-modal">
        <div className="ap-modal-header">
          <span className="ap-modal-title">Configure Ingestion Agent</span>
          <button className="ap-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="ap-modal-body">

          {/* AI credentials */}
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 10 }}>AI Credentials</div>
          <div className="form-group">
            <label className="form-label">Gemini API Key</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input type={showGemini ? 'text' : 'password'} className="form-input" value={form.gemini_api_key} onChange={update('gemini_api_key')} placeholder="AIza••••" style={{ flex: 1 }} />
              <EyeBtn show={showGemini} onToggle={() => setShowGemini(s => !s)} />
            </div>
            <span className="form-help">Used by the ingestion agent to classify errors with Gemini Flash.</span>
          </div>

          <div style={{ height: 1, background: 'var(--hairline)', margin: '16px 0' }} />

          {/* Service config */}
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 10 }}>Service Config</div>
          <div className="form-group">
            <label className="form-label">Service name</label>
            <input className="form-input" value={form.service_name} onChange={update('service_name')} placeholder="e.g. payment-service" />
            <span className="form-help">Tags all errors ingested by this agent.</span>
          </div>
          <div className="form-group">
            <label className="form-label">Environment</label>
            <select className="form-select" value={form.environment} onChange={update('environment')}>
              <option value="production">Production</option>
              <option value="staging">Staging</option>
              <option value="development">Development</option>
            </select>
          </div>

          <div style={{ height: 1, background: 'var(--hairline)', margin: '16px 0' }} />

          {/* Log source */}
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 10 }}>Log Source</div>
          <div className="form-group">
            <label className="form-label">Local log file paths <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>— optional</span></label>
            <input className="form-input" value={form.log_file_paths} onChange={handlePathsChange} placeholder="/var/log/app/app.log, /var/log/app/error.log" />
            <span className="form-help">Leave blank to use Datadog as the only log source.</span>
          </div>

          {/* Mode toggle */}
          {hasLogPaths ? (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 9, padding: '12px 14px', marginBottom: 12,
            }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Local file watching</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                  {localEnabled ? 'Agent tails the log paths above' : 'Disabled — uses Datadog instead'}
                </div>
              </div>
              <ToggleSwitch on={localEnabled} onClick={toggleLocalWatch} />
            </div>
          ) : (
            <div style={{ background: 'var(--indigo-tint)', border: '1px solid rgba(91,91,214,.18)', borderRadius: 9, padding: '10px 14px', fontSize: 12.5, color: 'var(--indigo)', lineHeight: 1.5, marginBottom: 12 }}>
              No local paths — agent will use Datadog as the log source.
            </div>
          )}

          {/* Datadog credentials — shown when in datadog_poll mode */}
          {useDatadog && (
            <>
              <div style={{ height: 1, background: 'var(--hairline)', margin: '4px 0 16px' }} />
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 10 }}>Datadog Credentials</div>
              <div className="form-group">
                <label className="form-label">API Key</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input type={showDDApi ? 'text' : 'password'} className="form-input" value={form.dd_api_key} onChange={update('dd_api_key')} placeholder="••••••••" style={{ flex: 1 }} />
                  <EyeBtn show={showDDApi} onToggle={() => setShowDDApi(s => !s)} />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Application Key</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input type={showDDApp ? 'text' : 'password'} className="form-input" value={form.dd_app_key} onChange={update('dd_app_key')} placeholder="••••••••" style={{ flex: 1 }} />
                  <EyeBtn show={showDDApp} onToggle={() => setShowDDApp(s => !s)} />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Site</label>
                <select className="form-select" value={form.dd_site} onChange={update('dd_site')}>
                  <option value="datadoghq.com">US1 — datadoghq.com</option>
                  <option value="datadoghq.eu">EU — datadoghq.eu</option>
                  <option value="us3.datadoghq.com">US3 — us3.datadoghq.com</option>
                  <option value="us5.datadoghq.com">US5 — us5.datadoghq.com</option>
                </select>
              </div>
            </>
          )}
        </div>
        <div className="ap-modal-footer">
          <button className="ap-btn-ghost btn" onClick={onClose}>Cancel</button>
          <button className="ap-btn-primary btn" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ComingSoonModal({ name, onClose }) {
  return (
    <div className="ap-modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="ap-modal" style={{ maxWidth: 380 }}>
        <div className="ap-modal-header">
          <span className="ap-modal-title">Configure {name}</span>
          <button className="ap-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="ap-modal-body" style={{ textAlign: 'center', padding: '32px 24px' }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>🚧</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>Coming soon</div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            {name} integration is on the roadmap. Stay tuned for updates.
          </div>
        </div>
        <div className="ap-modal-footer">
          <button className="ap-btn-primary btn" onClick={onClose}>Got it</button>
        </div>
      </div>
    </div>
  )
}

export default function IntegrationsPage() {
  const [settings, setSettings]               = useState({})
  const [orgIntegrations, setOrgIntegrations] = useState([])
  const [modal, setModal]                     = useState(null)
  const [showIngestModal, setShowIngestModal] = useState(false)
  const { showToast, activeOrg } = useApp()

  useEffect(() => {
    fetchSettings().then(setSettings).catch(() => {})
  }, [])

  useEffect(() => {
    if (!activeOrg?.id) return
    fetchOrgIntegrations(activeOrg.id)
      .then(data => setOrgIntegrations(Array.isArray(data) ? data : []))
      .catch(() => {})
  }, [activeOrg?.id])

  const refreshAll = () => {
    fetchSettings().then(setSettings).catch(() => {})
    if (activeOrg?.id) {
      fetchOrgIntegrations(activeOrg.id)
        .then(data => setOrgIntegrations(Array.isArray(data) ? data : []))
        .catch(() => {})
    }
  }

  const ingestConfig = (() => {
    const row = orgIntegrations.find(i => i.integration_type === 'ingestion')
    return row?.config || {}
  })()

  const toggleIngestMode = async () => {
    if (!activeOrg?.id || !ingestConfig.log_file_paths) return
    const newMode = ingestConfig.mode === 'db' ? 'datadog_poll' : 'db'
    try {
      await saveOrgIntegration(activeOrg.id, 'ingestion', { ...ingestConfig, mode: newMode })
      refreshAll()
    } catch {
      showToast('Failed to update mode', 'error')
    }
  }

  const GIT_TYPES = ['github', 'gitlab', 'gitlab_self', 'code']

  const isConnected = (id) => {
    if (id === 'claude') {
      return !!orgIntegrations.find(i => i.integration_type === 'claude' && i.is_connected)
    }
    if (id === 'gitlab') {
      const orgIntg = orgIntegrations.find(i => GIT_TYPES.includes(i.integration_type) && i.is_connected)
      if (orgIntg) return true
      return !!(settings.github_token || settings.gitlab_token)
    }
    const orgIntg = orgIntegrations.find(i => i.integration_type === id && i.is_connected)
    if (orgIntg) return true
    if (id === 'datadog') return !!settings.datadog_api_key
    return false
  }

  const connectedCount = INTEGRATIONS.filter(i => isConnected(i.id)).length
  const depth = Math.round((connectedCount / INTEGRATIONS.length) * 100)

  const renderModal = () => {
    if (!modal) return null
    const intg = INTEGRATIONS.find(i => i.id === modal)
    if (!intg) return null
    if (!intg.functional) return <ComingSoonModal name={intg.name} onClose={() => setModal(null)} />

    if (modal === 'claude') {
      const claudeIntg = orgIntegrations.find(i => i.integration_type === 'claude')
      const orgConfig  = claudeIntg?.config || {}
      return <ClaudeModal orgConfig={orgConfig} settings={settings} activeOrg={activeOrg} onClose={() => setModal(null)} onSaved={refreshAll} />
    }

    if (modal === 'datadog') {
      const orgConfig = orgIntegrations.find(i => i.integration_type === 'datadog')?.config || {}
      return <DatadogModal orgConfig={orgConfig} settings={settings} activeOrg={activeOrg} onClose={() => setModal(null)} onSaved={refreshAll} />
    }

    if (modal === 'gitlab') {
      const gitIntg    = orgIntegrations.find(i => GIT_TYPES.includes(i.integration_type))
      const claudeIntg = orgIntegrations.find(i => i.integration_type === 'claude')
      const orgConfig  = { ...(gitIntg?.config || {}), ...(claudeIntg?.config || {}) }
      return <GitlabModal orgConfig={orgConfig} settings={settings} activeOrg={activeOrg} onClose={() => setModal(null)} onSaved={refreshAll} />
    }

    return null
  }

  return (
    <div className="ap-page">
      <div className="ap-page-header">
        <h1 className="ap-page-title">Integrations</h1>
      </div>

      {/* Analysis depth */}
      <div className="ap-card ap-card-body" style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Analysis depth</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--indigo)' }}>{depth}%</span>
          </div>
          <div style={{ height: 8, background: 'var(--bg-2)', borderRadius: 'var(--r-full)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${depth}%`, background: 'var(--indigo-grad)', borderRadius: 'var(--r-full)', transition: 'width .5s ease' }} />
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
            {connectedCount} of {INTEGRATIONS.length} sources connected. Connect more to improve root-cause accuracy.
          </div>
        </div>
      </div>

      {/* Ingestion Agent */}
      {activeOrg?.id && (
        <div className="ap-card">
          <div className="ap-card-header">
            <span className="ap-card-title">Ingestion Agent</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span className="badge badge-indigo">{activeOrg.name || 'Current org'}</span>
              <button
                className="ap-btn-ghost btn"
                style={{ fontSize: 12, padding: '4px 10px' }}
                onClick={() => setShowIngestModal(true)}
              >
                Configure
              </button>
            </div>
          </div>
          <div className="ap-card-body">
            {(ingestConfig.service_name || ingestConfig.log_file_paths || ingestConfig.gemini_api_key) ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  {ingestConfig.gemini_api_key && (
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 2 }}>Gemini</div>
                      <span className="badge badge-success">Connected</span>
                    </div>
                  )}
                  {ingestConfig.service_name && (
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 2 }}>Service</div>
                      <code style={{ fontSize: 12, background: 'var(--bg-2)', padding: '2px 8px', borderRadius: 5 }}>{ingestConfig.service_name}</code>
                    </div>
                  )}
                  {ingestConfig.environment && (
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 2 }}>Environment</div>
                      <code style={{ fontSize: 12, background: 'var(--bg-2)', padding: '2px 8px', borderRadius: 5 }}>{ingestConfig.environment}</code>
                    </div>
                  )}
                  {ingestConfig.log_file_paths && (
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 2 }}>Log paths</div>
                      <code style={{ fontSize: 12, background: 'var(--bg-2)', padding: '2px 8px', borderRadius: 5, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ingestConfig.log_file_paths}</code>
                    </div>
                  )}
                </div>

                {/* Mode toggle — only shown when local log paths are configured */}
                {ingestConfig.log_file_paths && (
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px',
                  }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Local file watching</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 1 }}>
                        {ingestConfig.mode !== 'datadog_poll'
                          ? 'ON — agent is tailing local log files'
                          : 'OFF — agent is using Datadog instead'}
                      </div>
                    </div>
                    <ToggleSwitch on={ingestConfig.mode !== 'datadog_poll'} onClick={toggleIngestMode} />
                  </div>
                )}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                Not configured yet. Click <strong>Configure</strong> to set up the ingestion agent for this organization.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Integration cards */}
      <div className="ap-integration-grid">
        {INTEGRATIONS.map(intg => {
          const connected = isConnected(intg.id)
          return (
            <div key={intg.id} className="ap-integration-card">
              <div className="ap-int-header">
                <div className="ap-int-icon" style={{ background: `${intg.color}18`, border: `1px solid ${intg.color}30`, color: intg.color }}>
                  {intg.glyph}
                </div>
                <div className="ap-int-info">
                  <div className="ap-int-name">{intg.name}</div>
                  <div style={{ marginTop: 4 }}>
                    {connected ? (
                      <span className="badge badge-success">Connected</span>
                    ) : (
                      <span className="badge badge-error">Not connected</span>
                    )}
                  </div>
                </div>
              </div>

              <p className="ap-int-desc">{intg.desc}</p>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span className="ap-int-meta">{intg.tools} tool{intg.tools !== 1 ? 's' : ''}</span>
                <button
                  className={connected ? 'ap-btn-ghost btn' : 'ap-btn-accent btn'}
                  style={{ fontSize: 12, padding: '5px 12px' }}
                  onClick={() => setModal(intg.id)}
                >
                  {connected ? 'Manage' : 'Connect'}
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {renderModal()}
      {showIngestModal && (
        <IngestAgentModal
          orgId={activeOrg?.id}
          current={ingestConfig}
          onClose={() => setShowIngestModal(false)}
          onSaved={refreshAll}
        />
      )}
    </div>
  )
}
