import React, { useState, useRef } from 'react'
import { createOrg, saveOrgIntegration } from '../api/client'
import { useApp } from '../context/AppContext'

// ── Step definitions ──────────────────────────────────────────────────────────

const STEPS = [
  { id: 'org',     label: 'Organization', icon: '🏢' },
  { id: 'claude',  label: 'Claude AI',    icon: '🧠' },
  { id: 'datadog', label: 'Datadog',      icon: '◐'  },
  { id: 'code',    label: 'Code',         icon: '⌥'  },
  { id: 'ingest',  label: 'Ingestion',    icon: '⇄'  },
  { id: 'done',    label: 'Review',       icon: '✓'  },
]

// ── Shared styles ─────────────────────────────────────────────────────────────

const infoBox = {
  background: 'var(--indigo-tint)',
  border: '1px solid rgba(249,115,22,.2)',
  borderRadius: 9,
  padding: '10px 14px',
  fontSize: 12.5,
  color: 'var(--indigo)',
  lineHeight: 1.5,
}

const importedBox = {
  background: 'rgba(34,197,94,.07)',
  border: '1px solid rgba(34,197,94,.2)',
  borderRadius: 9,
  padding: '10px 14px',
  fontSize: 12.5,
  color: '#15803d',
  lineHeight: 1.5,
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

// ── .env file parser ──────────────────────────────────────────────────────────

function parseEnvFile(text) {
  const vars = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eqIdx = line.indexOf('=')
    if (eqIdx === -1) continue
    const key = line.slice(0, eqIdx).trim()
    let val = line.slice(eqIdx + 1).trim()
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (key && val) vars[key] = val
  }
  return vars
}

const ENV_LABELS = {
  ANTHROPIC_API_KEY: 'Claude API key',
  GITHUB_PAT:        'Git token',
  GITLAB_TOKEN:      'GitLab token',
  GITLAB_URL:        'GitLab base URL',
  GITHUB_ORG:        'Git org / group',
  DD_API_KEY:        'Datadog API key',
  DD_APP_KEY:        'Datadog app key',
  DD_SITE:           'Datadog site',
  GEMINI_API_KEY:    'Gemini API key',
  LOG_FILE_PATHS:    'Log file paths',
  SERVICE_NAME:      'Service name',
  ENVIRONMENT:       'Environment',
  MODE:              'Ingestion mode',
}

// ── Step 1 — Org details ──────────────────────────────────────────────────────

function StepOrg({ form, update, onEnvImport, importSummary }) {
  const fileRef = useRef()

  const handleFile = (e) => {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => onEnvImport(ev.target.result)
    reader.readAsText(file)
    e.target.value = ''
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>
          Name your organization
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Each org has its own API credentials, integrations, and isolated error stream.
        </div>
      </div>

      {/* ── Credential file import panel ─────────────────────────────────────── */}
      <div style={{
        border: `1.5px dashed ${importSummary ? 'rgba(34,197,94,.4)' : 'var(--border)'}`,
        borderRadius: 10,
        padding: '14px 16px',
        background: importSummary ? 'rgba(34,197,94,.06)' : 'var(--bg-2)',
        transition: 'all .2s',
      }}>
        <input ref={fileRef} type="file" accept=".env,text/plain,.txt" style={{ display: 'none' }} onChange={handleFile} />

        {importSummary ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 15, color: '#16a34a' }}>✓</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#15803d' }}>
                  {importSummary.count} field{importSummary.count !== 1 ? 's' : ''} imported — proceed through each step to verify
                </span>
              </div>
              <button
                type="button"
                onClick={() => fileRef.current.click()}
                style={{ fontSize: 11, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
              >
                Re-import
              </button>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {importSummary.fields.map(f => (
                <span key={f} style={{
                  fontSize: 11, background: 'rgba(34,197,94,.12)', color: '#166534',
                  border: '1px solid rgba(34,197,94,.25)', borderRadius: 5, padding: '2px 7px',
                }}>
                  {f}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ fontSize: 22, flexShrink: 0 }}>📄</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2 }}>
                Import credentials from file
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                Upload a <code style={{ fontSize: 11, background: 'var(--bg-3)', borderRadius: 3, padding: '1px 4px' }}>.env</code> file to auto-fill API keys across all steps. You can edit each field before creating the org.
              </div>
            </div>
            <button
              type="button"
              className="ap-btn-ghost btn"
              style={{ flexShrink: 0, fontSize: 12 }}
              onClick={() => fileRef.current.click()}
            >
              Choose file
            </button>
          </div>
        )}
      </div>

      <div className="form-group">
        <label className="form-label">Organization name *</label>
        <input
          className="form-input"
          value={form.name}
          onChange={update('name')}
          placeholder="e.g. Acme Corp"
          autoFocus
        />
      </div>
      <div className="form-group">
        <label className="form-label">Environment</label>
        <select className="form-select" value={form.environment} onChange={update('environment')}>
          <option value="production">Production</option>
          <option value="staging">Staging</option>
          <option value="development">Development</option>
        </select>
      </div>
    </div>
  )
}

// ── Step 2 — Claude AI key ────────────────────────────────────────────────────

function StepClaude({ form, update, hasImport }) {
  const [show, setShow] = useState(false)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>
          Connect Claude AI
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Required — powers all RCA analysis and chat. Get your key at console.anthropic.com.
        </div>
      </div>
      {hasImport && form.anthropic_api_key && (
        <div style={importedBox}>
          Pre-filled from your imported file — verify the key is correct before continuing.
        </div>
      )}
      <div style={infoBox}>
        Your API key is encrypted with AES-256 before being stored. It is never logged or exposed.
      </div>
      <div className="form-group">
        <label className="form-label">Anthropic API Key *</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="form-input"
            type={show ? 'text' : 'password'}
            value={form.anthropic_api_key}
            onChange={update('anthropic_api_key')}
            placeholder="sk-ant-api03-••••"
            style={{ flex: 1 }}
          />
          <button type="button" className="ap-btn-ghost btn" style={{ padding: '0 12px', fontSize: 12, flexShrink: 0 }} onClick={() => setShow(s => !s)}>
            {show ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>
      <div className="form-group">
        <label className="form-label">Model</label>
        <select className="form-select" value={form.model} onChange={update('model')}>
          <option value="claude-sonnet-4-6">claude-sonnet-4-6 (Recommended)</option>
          <option value="claude-opus-4-8">claude-opus-4-8 (Most capable)</option>
          <option value="claude-haiku-4-5-20251001">claude-haiku-4-5-20251001 (Fastest)</option>
        </select>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: 'var(--warning)' }}>⚠</span>
        You can skip this and add it later in Integrations, but RCA will not run without it.
      </div>
    </div>
  )
}

// ── Step 3 — Datadog ──────────────────────────────────────────────────────────

function StepDatadog({ form, update, hasImport }) {
  const [show, setShow] = useState(false)
  const hasImportedData = hasImport && (form.datadog_api_key || form.datadog_app_key)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>
          Connect Datadog <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--text-muted)' }}>— optional</span>
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Pull logs, metrics, and traces from Datadog to enrich root-cause analysis.
        </div>
      </div>
      {hasImportedData && (
        <div style={importedBox}>
          Pre-filled from your imported file — verify the credentials below.
        </div>
      )}
      <div className="form-group">
        <label className="form-label">API Key</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="form-input" type={show ? 'text' : 'password'} value={form.datadog_api_key} onChange={update('datadog_api_key')} placeholder="••••••••" style={{ flex: 1 }} />
          <button type="button" className="ap-btn-ghost btn" style={{ padding: '0 12px', fontSize: 12, flexShrink: 0 }} onClick={() => setShow(s => !s)}>
            {show ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>
      <div className="form-group">
        <label className="form-label">Application Key</label>
        <input className="form-input" type="password" value={form.datadog_app_key} onChange={update('datadog_app_key')} placeholder="••••••••" />
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
  )
}

// ── Step 4 — GitHub / GitLab ──────────────────────────────────────────────────

function StepCode({ form, update, hasImport }) {
  const [show, setShow] = useState(false)
  const isGitLab = form.provider !== 'github'
  const hasImportedData = hasImport && (form.github_token || form.gitlab_token)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>
          Connect code repository <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--text-muted)' }}>— optional</span>
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Enables blame analysis, diff inspection, and commit-to-incident linking.
        </div>
      </div>
      {hasImportedData && (
        <div style={importedBox}>
          Pre-filled from your imported file — verify the token and org / group below.
        </div>
      )}
      <div className="form-group">
        <label className="form-label">Provider</label>
        <select className="form-select" value={form.provider} onChange={update('provider')}>
          <option value="github">GitHub</option>
          <option value="gitlab">GitLab (cloud)</option>
          <option value="gitlab_self">GitLab (self-managed)</option>
        </select>
      </div>
      {(form.provider === 'gitlab' || form.provider === 'gitlab_self') && (
        <div className="form-group">
          <label className="form-label">Base URL</label>
          <input className="form-input" value={form.gitlab_base_url} onChange={update('gitlab_base_url')} placeholder="https://gitlab.company.com" />
        </div>
      )}
      <div className="form-group">
        <label className="form-label">Personal Access Token</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="form-input"
            type={show ? 'text' : 'password'}
            value={isGitLab ? form.gitlab_token : form.github_token}
            onChange={update(isGitLab ? 'gitlab_token' : 'github_token')}
            placeholder="••••••••"
            style={{ flex: 1 }}
          />
          <button type="button" className="ap-btn-ghost btn" style={{ padding: '0 12px', fontSize: 12, flexShrink: 0 }} onClick={() => setShow(s => !s)}>
            {show ? 'Hide' : 'Show'}
          </button>
        </div>
        <span className="form-help">
          {form.provider === 'github' ? 'Needs repo, read:org scope' : 'Needs read_api, read_repository scope'}
        </span>
      </div>
      <div className="form-group">
        <label className="form-label">Default group / org</label>
        <input className="form-input" value={form.github_org} onChange={update('github_org')} placeholder="my-org" />
      </div>
    </div>
  )
}

// ── Step 5 — Ingestion Agent ──────────────────────────────────────────────────

function StepIngest({ form, setIngestForm, datadogConnected, hasImport }) {
  const [showGemini, setShowGemini] = useState(false)
  const hasLogPaths  = form.log_file_paths.trim().length > 0
  const localEnabled = form.mode === 'db'
  const hasImportedData = hasImport && (form.gemini_api_key || form.service_name || form.log_file_paths)

  const handlePathsChange = (e) => {
    const val = e.target.value
    setIngestForm(f => ({ ...f, log_file_paths: val, mode: val.trim() ? 'db' : 'datadog_poll' }))
  }

  const toggleLocalWatch = () => {
    setIngestForm(f => ({ ...f, mode: f.mode === 'db' ? 'datadog_poll' : 'db' }))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>
          Configure Ingestion Agent <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--text-muted)' }}>— optional</span>
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Each organization gets its own isolated ingestion agent. Set the service name and log source.
        </div>
      </div>

      {hasImportedData && (
        <div style={importedBox}>
          Pre-filled from your imported file — verify each field below.
        </div>
      )}

      <div style={{ ...infoBox, background: 'rgba(34,197,94,.07)', border: '1px solid rgba(34,197,94,.2)', color: '#15803d' }}>
        The ingestion agent connects to your organization <strong>automatically</strong> — no key copy-paste needed.
      </div>

      <div className="form-group">
        <label className="form-label">Gemini API Key <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>— for error classification</span></label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="form-input"
            type={showGemini ? 'text' : 'password'}
            value={form.gemini_api_key}
            onChange={e => setIngestForm(f => ({ ...f, gemini_api_key: e.target.value }))}
            placeholder="AIza••••"
            style={{ flex: 1 }}
          />
          <button type="button" className="ap-btn-ghost btn" style={{ padding: '0 12px', fontSize: 12, flexShrink: 0 }} onClick={() => setShowGemini(s => !s)}>
            {showGemini ? 'Hide' : 'Show'}
          </button>
        </div>
        <span className="form-help">Powers AI classification of incoming error logs. Get your key at aistudio.google.com.</span>
      </div>

      <div className="form-group">
        <label className="form-label">Service name</label>
        <input
          className="form-input"
          value={form.service_name}
          onChange={e => setIngestForm(f => ({ ...f, service_name: e.target.value }))}
          placeholder="e.g. payment-service"
        />
        <span className="form-help">Tags all errors ingested by this agent with this service name.</span>
      </div>

      <div className="form-group">
        <label className="form-label">Local log file paths <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>— optional</span></label>
        <input
          className="form-input"
          value={form.log_file_paths}
          onChange={handlePathsChange}
          placeholder="/var/log/app/app.log, /var/log/app/error.log"
        />
        <span className="form-help">
          Comma-separated paths inside the agent container. Leave blank to use Datadog as the log source.
        </span>
      </div>

      {hasLogPaths ? (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 9, padding: '12px 14px',
        }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Local file watching</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              {localEnabled
                ? 'Agent will tail the log paths above for new errors.'
                : 'Disabled — agent will pull from Datadog instead.'}
            </div>
          </div>
          <ToggleSwitch on={localEnabled} onClick={toggleLocalWatch} />
        </div>
      ) : (
        <div style={{
          background: datadogConnected ? 'var(--indigo-tint)' : '#FFF7ED',
          border: `1px solid ${datadogConnected ? 'rgba(91,91,214,.18)' : 'rgba(249,115,22,.3)'}`,
          borderRadius: 9, padding: '10px 14px', fontSize: 12.5, lineHeight: 1.6,
          color: datadogConnected ? 'var(--indigo)' : '#92400E',
        }}>
          {datadogConnected
            ? 'No local paths — agent will pull logs from Datadog automatically.'
            : 'No local paths and Datadog not connected. Provide at least one log source above or in Datadog step.'}
        </div>
      )}
    </div>
  )
}

// ── Step 6 — Done / Review ────────────────────────────────────────────────────

function StepDone({ orgForm, claudeForm, datadogForm, codeForm, ingestForm }) {
  const checks = [
    { label: 'Organization',    ok: !!orgForm.name.trim(),                                          note: orgForm.name || '—' },
    { label: 'Claude AI',       ok: !!claudeForm.anthropic_api_key,                                 note: claudeForm.anthropic_api_key ? claudeForm.model : 'Not set — RCA will not run' },
    { label: 'Datadog',         ok: !!(datadogForm.datadog_api_key && datadogForm.datadog_app_key), note: datadogForm.datadog_api_key ? 'Connected' : 'Skipped' },
    { label: 'Code repository', ok: !!(codeForm.github_token || codeForm.gitlab_token),             note: (codeForm.github_token || codeForm.gitlab_token) ? codeForm.provider : 'Skipped' },
    { label: 'Ingestion Agent', ok: !!(ingestForm.service_name || ingestForm.gemini_api_key),       note: ingestForm.service_name ? `${ingestForm.service_name} · ${ingestForm.mode === 'datadog_poll' ? 'Datadog polling' : 'file watch'}` : 'Skipped — configure later' },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>Review and create</div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Everything looks good. You can always update credentials later in Integrations.
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {checks.map(c => (
          <div key={c.label} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 9 }}>
            <div style={{
              width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
              background: c.ok ? 'var(--success)' : 'var(--bg-2)',
              border: `1.5px solid ${c.ok ? 'var(--success)' : 'var(--border)'}`,
              color: c.ok ? '#fff' : 'var(--text-muted)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700,
            }}>
              {c.ok ? '✓' : '—'}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{c.label}</div>
              <div style={{ fontSize: 11, color: c.ok ? 'var(--text-muted)' : 'var(--warning)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {c.note}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Success screen ─────────────────────────────────────────────────────────────

function SuccessScreen({ org, ingestForm }) {
  const hasIngest = !!(ingestForm.service_name || ingestForm.log_file_paths)

  const details = [
    ingestForm.service_name   && { label: 'Service',   value: ingestForm.service_name },
    ingestForm.log_file_paths && { label: 'Log paths', value: ingestForm.log_file_paths },
    hasIngest && { label: 'Mode', value: ingestForm.mode === 'db' ? 'Local file watch' : 'Datadog polling' },
  ].filter(Boolean)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ textAlign: 'center', padding: '8px 0 4px' }}>
        <div style={{
          width: 56, height: 56, borderRadius: '50%', background: 'var(--success)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          margin: '0 auto 14px', fontSize: 24, color: '#fff',
          boxShadow: '0 4px 20px rgba(34,197,94,.35)',
        }}>
          ✓
        </div>
        <div style={{ fontSize: 19, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>
          Organization created!
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          <strong style={{ color: 'var(--text-primary)' }}>{org?.name}</strong> is ready and the ingestion agent will connect automatically.
        </div>
      </div>

      <div style={{
        background: 'rgba(34,197,94,.07)', border: '1px solid rgba(34,197,94,.2)',
        borderRadius: 10, padding: '14px 16px', display: 'flex', gap: 12, alignItems: 'flex-start',
      }}>
        <div style={{ fontSize: 18, lineHeight: 1, marginTop: 1, flexShrink: 0 }}>⚡</div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#15803d', marginBottom: 4 }}>
            Ingestion agent connects automatically
          </div>
          <div style={{ fontSize: 12, color: '#166534', lineHeight: 1.6 }}>
            No API key copy-paste needed. The agent is already connected and will start routing errors to <strong>{org?.name}</strong> immediately.
          </div>
        </div>
      </div>

      {details.length > 0 && (
        <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 10 }}>
            Ingestion Config
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {details.map(d => (
              <div key={d.label} style={{ display: 'flex', gap: 10, fontSize: 12 }}>
                <span style={{ color: 'var(--text-muted)', width: 70, flexShrink: 0 }}>{d.label}</span>
                <span style={{ color: 'var(--text-primary)', fontWeight: 500, wordBreak: 'break-all' }}>{d.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {!hasIngest && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6, textAlign: 'center' }}>
          No ingestion config set — you can configure it later in <strong>Integrations → Ingestion Agent</strong>.
        </div>
      )}
    </div>
  )
}

// ── Main wizard ───────────────────────────────────────────────────────────────

const SUCCESS_STEP = STEPS.length

const CREATION_STEPS = ['Creating organization', 'Saving credentials', 'Connecting agents']

export default function OrgWizard({ onClose, onCreated }) {
  const { showToast, setActiveOrg } = useApp()
  const [step,         setStep]         = useState(0)
  const [saving,       setSaving]       = useState(false)
  const [creatingStep, setCreatingStep] = useState(0)
  const [createdOrg,   setCreatedOrg]   = useState(null)
  const [importSummary, setImportSummary] = useState(null)

  const [orgForm,     setOrgForm]     = useState({ name: '', environment: 'production' })
  const [claudeForm,  setClaudeForm]  = useState({ anthropic_api_key: '', model: 'claude-sonnet-4-6' })
  const [datadogForm, setDatadogForm] = useState({ datadog_api_key: '', datadog_app_key: '', datadog_site: 'datadoghq.com' })
  const [codeForm,    setCodeForm]    = useState({ provider: 'github', github_token: '', gitlab_token: '', gitlab_base_url: '', github_org: '' })
  const [ingestForm,  setIngestForm]  = useState({ service_name: '', log_file_paths: '', mode: 'datadog_poll', gemini_api_key: '' })

  const updateForm = (setter) => (key) => (e) => setter(f => ({ ...f, [key]: e.target.value }))

  // ── .env import ────────────────────────────────────────────────────────────

  const handleEnvImport = (text) => {
    const vars = parseEnvFile(text)
    const filled = []

    if (vars.ANTHROPIC_API_KEY) {
      setClaudeForm(f => ({ ...f, anthropic_api_key: vars.ANTHROPIC_API_KEY }))
      filled.push(ENV_LABELS.ANTHROPIC_API_KEY)
    }

    const ddUp = {}
    if (vars.DD_API_KEY) { ddUp.datadog_api_key = vars.DD_API_KEY; filled.push(ENV_LABELS.DD_API_KEY) }
    if (vars.DD_APP_KEY) { ddUp.datadog_app_key = vars.DD_APP_KEY; filled.push(ENV_LABELS.DD_APP_KEY) }
    if (vars.DD_SITE)    { ddUp.datadog_site    = vars.DD_SITE;    filled.push(ENV_LABELS.DD_SITE) }
    if (Object.keys(ddUp).length) setDatadogForm(f => ({ ...f, ...ddUp }))

    const codeUp = {}
    if (vars.GITHUB_PAT) {
      const isGitLabToken = vars.GITHUB_PAT.startsWith('glpat-')
      if (isGitLabToken) {
        codeUp.gitlab_token = vars.GITHUB_PAT
        codeUp.provider = vars.GITLAB_URL ? 'gitlab_self' : 'gitlab'
      } else {
        codeUp.github_token = vars.GITHUB_PAT
        codeUp.provider = 'github'
      }
      filled.push(ENV_LABELS.GITHUB_PAT)
    }
    if (vars.GITLAB_TOKEN) { codeUp.gitlab_token    = vars.GITLAB_TOKEN; filled.push(ENV_LABELS.GITLAB_TOKEN) }
    if (vars.GITLAB_URL)   { codeUp.gitlab_base_url = vars.GITLAB_URL;   filled.push(ENV_LABELS.GITLAB_URL) }
    if (vars.GITHUB_ORG)   { codeUp.github_org      = vars.GITHUB_ORG;   filled.push(ENV_LABELS.GITHUB_ORG) }
    if (Object.keys(codeUp).length) setCodeForm(f => ({ ...f, ...codeUp }))

    const ingUp = {}
    if (vars.GEMINI_API_KEY) { ingUp.gemini_api_key = vars.GEMINI_API_KEY; filled.push(ENV_LABELS.GEMINI_API_KEY) }
    if (vars.LOG_FILE_PATHS) { ingUp.log_file_paths = vars.LOG_FILE_PATHS; filled.push(ENV_LABELS.LOG_FILE_PATHS) }
    if (vars.SERVICE_NAME)   { ingUp.service_name   = vars.SERVICE_NAME;   filled.push(ENV_LABELS.SERVICE_NAME) }
    if (vars.MODE && ['db', 'datadog_poll'].includes(vars.MODE)) {
      ingUp.mode = vars.MODE
      filled.push(ENV_LABELS.MODE)
    }
    if (Object.keys(ingUp).length) setIngestForm(f => ({ ...f, ...ingUp }))

    if (vars.ENVIRONMENT && ['production', 'staging', 'development'].includes(vars.ENVIRONMENT)) {
      setOrgForm(f => ({ ...f, environment: vars.ENVIRONMENT }))
      filled.push(ENV_LABELS.ENVIRONMENT)
    }

    if (filled.length === 0) {
      showToast('No recognised credential keys found in the file', 'error')
      return
    }
    setImportSummary({ count: filled.length, fields: filled })
    showToast(`Imported ${filled.length} credential field${filled.length !== 1 ? 's' : ''} — step through each to verify`, 'success')
  }

  // ── Navigation ─────────────────────────────────────────────────────────────

  const canNext = () => {
    if (step === 0) return orgForm.name.trim().length > 0
    return true
  }

  const isReview  = step === STEPS.length - 1
  const isSuccess = step === SUCCESS_STEP

  // ── Create ─────────────────────────────────────────────────────────────────

  const handleCreate = async () => {
    if (!orgForm.name.trim()) { showToast('Organization name is required', 'error'); return }
    setSaving(true)
    setCreatingStep(1)
    try {
      const org = await createOrg({ name: orgForm.name.trim(), environment: orgForm.environment })
      const orgId = org.id

      setCreatingStep(2)
      const saves = []
      if (claudeForm.anthropic_api_key) {
        saves.push(saveOrgIntegration(orgId, 'claude', {
          anthropic_api_key: claudeForm.anthropic_api_key,
          model: claudeForm.model,
        }).catch(() => {}))
      }
      if (datadogForm.datadog_api_key && datadogForm.datadog_app_key) {
        saves.push(saveOrgIntegration(orgId, 'datadog', {
          datadog_api_key: datadogForm.datadog_api_key,
          datadog_app_key: datadogForm.datadog_app_key,
          datadog_site:    datadogForm.datadog_site,
        }).catch(() => {}))
      }
      const codeToken = codeForm.provider === 'github' ? codeForm.github_token : codeForm.gitlab_token
      if (codeToken) {
        saves.push(saveOrgIntegration(orgId, codeForm.provider, {
          provider:        codeForm.provider,
          github_token:    codeForm.github_token,
          gitlab_token:    codeForm.gitlab_token,
          gitlab_base_url: codeForm.gitlab_base_url,
          github_org:      codeForm.github_org,
        }).catch(() => {}))
      }
      if (ingestForm.service_name || ingestForm.log_file_paths || ingestForm.gemini_api_key) {
        saves.push(saveOrgIntegration(orgId, 'ingestion', {
          service_name:   ingestForm.service_name,
          log_file_paths: ingestForm.log_file_paths,
          environment:    orgForm.environment,
          mode:           ingestForm.mode,
          gemini_api_key: ingestForm.gemini_api_key,
        }).catch(() => {}))
      }
      await Promise.all(saves)

      setCreatingStep(3)
      // createOrg already notified the ingestion agent immediately via POST /org
      await new Promise(r => setTimeout(r, 500))

      if (setActiveOrg) setActiveOrg(org)
      onCreated?.(org)
      setCreatedOrg(org)
      setStep(SUCCESS_STEP)
    } catch (e) {
      showToast(e.message || 'Failed to create organization', 'error')
    } finally {
      setSaving(false)
      setCreatingStep(0)
    }
  }

  const handleDone = () => onClose()

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="ap-modal-overlay" onClick={e => e.target === e.currentTarget && !isSuccess && onClose()}>
      <div className="ap-modal" style={{ maxWidth: 520, position: 'relative', overflow: saving ? 'hidden' : undefined }}>

        {/* Creation loading overlay */}
        {saving && (
          <div style={{
            position: 'absolute', inset: 0, zIndex: 20,
            background: 'var(--bg-card)', borderRadius: 'inherit',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: 24, padding: 36,
          }}>
            <div style={{
              width: 44, height: 44, borderRadius: '50%',
              border: '3px solid var(--border)', borderTopColor: 'var(--indigo)',
              animation: 'ap-spin 0.8s linear infinite',
            }} />
            <div style={{ width: '100%', maxWidth: 300 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', textAlign: 'center', marginBottom: 6 }}>
                Setting up {orgForm.name}…
              </div>
              <div style={{ height: 3, background: 'var(--border)', borderRadius: 2, marginBottom: 20, overflow: 'hidden' }}>
                <div style={{
                  height: '100%',
                  width: `${Math.round((creatingStep / CREATION_STEPS.length) * 100)}%`,
                  background: 'var(--indigo-grad)', borderRadius: 2,
                  transition: 'width 0.5s ease',
                }} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
                {CREATION_STEPS.map((label, i) => {
                  const n = i + 1
                  const done = creatingStep > n
                  const active = creatingStep === n
                  const pending = creatingStep < n
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, opacity: pending ? 0.35 : 1, transition: 'opacity 0.3s' }}>
                      <div style={{ width: 20, height: 20, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {done && (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                        {active && (
                          <div style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid var(--indigo)', borderTopColor: 'transparent', animation: 'ap-spin 0.7s linear infinite' }} />
                        )}
                        {pending && (
                          <div style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--border)' }} />
                        )}
                      </div>
                      <span style={{
                        fontSize: 13, fontWeight: active || done ? 500 : 400,
                        color: done ? '#22c55e' : active ? 'var(--indigo)' : 'var(--text-muted)',
                        transition: 'color 0.3s',
                      }}>
                        {label}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}

        {/* Header */}
        <div className="ap-modal-header">
          <div>
            <span className="ap-modal-title">
              {isSuccess ? `${createdOrg?.name || 'Organization'} created` : 'Set up organization'}
            </span>
            {!isSuccess && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                Step {step + 1} of {STEPS.length} — {STEPS[step].label}
              </div>
            )}
          </div>
          {!isSuccess && (
            <button className="ap-modal-close" onClick={onClose}>✕</button>
          )}
        </div>

        {/* Step indicator */}
        {!isSuccess && (
          <div style={{ display: 'flex', alignItems: 'center', padding: '12px 24px', borderBottom: '1px solid var(--hairline)', gap: 0, overflowX: 'auto' }}>
            {STEPS.map((s, i) => (
              <React.Fragment key={s.id}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, flexShrink: 0 }}>
                  <div style={{
                    width: 26, height: 26, borderRadius: '50%', fontSize: 11, fontWeight: 700,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: i < step ? 'var(--success)' : i === step ? 'var(--indigo)' : 'var(--bg-2)',
                    color: i <= step ? '#fff' : 'var(--text-muted)',
                    border: `2px solid ${i === step ? 'var(--indigo)' : i < step ? 'var(--success)' : 'var(--border)'}`,
                    transition: 'all .2s',
                    cursor: i < step ? 'pointer' : 'default',
                  }} onClick={() => i < step && setStep(i)}>
                    {i < step ? '✓' : s.icon}
                  </div>
                  <span style={{ fontSize: 9, fontWeight: 600, color: i === step ? 'var(--indigo)' : i < step ? 'var(--success)' : 'var(--text-muted)', textAlign: 'center', whiteSpace: 'nowrap' }}>
                    {s.label}
                  </span>
                </div>
                {i < STEPS.length - 1 && (
                  <div style={{ flex: 1, height: 2, background: i < step ? 'var(--success)' : 'var(--hairline)', margin: '0 3px', marginBottom: 16, minWidth: 12, transition: 'background .3s' }} />
                )}
              </React.Fragment>
            ))}
          </div>
        )}

        {/* Step content */}
        <div className="ap-modal-body">
          {step === 0 && (
            <StepOrg
              form={orgForm}
              update={updateForm(setOrgForm)}
              onEnvImport={handleEnvImport}
              importSummary={importSummary}
            />
          )}
          {step === 1 && <StepClaude  form={claudeForm}  update={updateForm(setClaudeForm)}  hasImport={!!importSummary} />}
          {step === 2 && <StepDatadog form={datadogForm} update={updateForm(setDatadogForm)} hasImport={!!importSummary} />}
          {step === 3 && <StepCode    form={codeForm}    update={updateForm(setCodeForm)}    hasImport={!!importSummary} />}
          {step === 4 && (
            <StepIngest
              form={ingestForm}
              setIngestForm={setIngestForm}
              datadogConnected={!!(datadogForm.datadog_api_key && datadogForm.datadog_app_key)}
              hasImport={!!importSummary}
            />
          )}
          {step === 5 && (
            <StepDone
              orgForm={orgForm}
              claudeForm={claudeForm}
              datadogForm={datadogForm}
              codeForm={codeForm}
              ingestForm={ingestForm}
            />
          )}
          {isSuccess && (
            <SuccessScreen
              org={createdOrg}
              ingestForm={{ ...ingestForm, environment: orgForm.environment }}
            />
          )}
        </div>

        {/* Footer */}
        <div className="ap-modal-footer">
          {isSuccess ? (
            <button className="ap-btn-primary btn" style={{ width: '100%' }} onClick={handleDone}>
              Open Dashboard →
            </button>
          ) : (
            <>
              {step > 0 && (
                <button className="ap-btn-ghost btn" onClick={() => setStep(s => s - 1)} disabled={saving}>
                  ← Back
                </button>
              )}
              <div style={{ flex: 1 }} />
              {step >= 2 && step < STEPS.length - 1 && (
                <button className="ap-btn-ghost btn" onClick={() => setStep(s => s + 1)} disabled={saving} style={{ color: 'var(--text-muted)' }}>
                  Skip
                </button>
              )}
              {!isReview ? (
                <button className="ap-btn-accent btn" disabled={!canNext()} onClick={() => setStep(s => s + 1)}>
                  Continue →
                </button>
              ) : (
                <button className="ap-btn-primary btn" disabled={saving} onClick={handleCreate}>
                  {saving ? 'Creating…' : 'Create organization'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
