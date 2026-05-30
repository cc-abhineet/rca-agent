import React, { useEffect, useState, useCallback } from 'react'
import { fetchSettings, saveSettings } from '../api/client'
import { useApp } from '../context/AppContext'

const MODELS = [
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  { value: 'claude-sonnet-4-6',         label: 'Claude Sonnet 4.6' },
  { value: 'claude-opus-4-8',           label: 'Claude Opus 4.8' },
]
const DD_SITES = [
  { value: 'us5.datadoghq.com', label: 'US5 (us5.datadoghq.com)' },
  { value: 'us3.datadoghq.com', label: 'US3 (us3.datadoghq.com)' },
  { value: 'datadoghq.com',     label: 'US1 (datadoghq.com)' },
  { value: 'datadoghq.eu',      label: 'EU1 (datadoghq.eu)' },
  { value: 'ap1.datadoghq.com', label: 'AP1 (ap1.datadoghq.com)' },
]

const SECTIONS = [
  { id: 'claude',        label: 'Claude AI',    icon: '🤖' },
  { id: 'github',        label: 'GitHub',       icon: '⎇' },
  { id: 'datadog',       label: 'Datadog',      icon: '📊' },
  { id: 'observability', label: 'Observability',icon: '👁' },
  { id: 'database',      label: 'Database',     icon: '🗄' },
]

function MaskedInput({ label, name, value, onChange, help }) {
  const [show, setShow] = useState(false)
  return (
    <div className="form-group">
      {label && <label className="form-label">{label}</label>}
      <div className="input-wrap">
        <input
          type={show ? 'text' : 'password'}
          className="form-input mono"
          name={name}
          value={value || ''}
          onChange={onChange}
          placeholder="Leave blank to keep current"
          autoComplete="off"
        />
        <button type="button" className="input-btn" onClick={() => setShow(s => !s)}>
          {show ? (
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
            </svg>
          ) : (
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
          )}
        </button>
      </div>
      {help && <span className="form-help">{help}</span>}
    </div>
  )
}

export default function Settings() {
  const { showToast } = useApp()
  const [activeSection, setActiveSection] = useState('claude')
  const [form, setForm] = useState({
    anthropic_api_key: '',
    github_pat: '',
    github_org: '',
    model: 'claude-sonnet-4-6',
    max_react_iterations: 20,
    dd_api_key: '',
    dd_app_key: '',
    dd_site: 'us5.datadoghq.com',
    observability_adapter: 'local',
    cicd_adapter: 'mock',
    database_url: '',
  })
  const [displayed, setDisplayed] = useState({})
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    fetchSettings()
      .then(s => {
        setDisplayed(s)
        setForm(prev => ({
          ...prev,
          github_org:            s.github_org            || prev.github_org,
          model:                 s.model                 || prev.model,
          max_react_iterations:  s.max_react_iterations  || prev.max_react_iterations,
          dd_site:               s.dd_site               || prev.dd_site,
          observability_adapter: s.observability_adapter || prev.observability_adapter,
          cicd_adapter:          s.cicd_adapter          || prev.cicd_adapter,
        }))
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  const handleChange = (e) => {
    const { name, value } = e.target
    setForm(f => ({ ...f, [name]: value }))
  }

  const handleSlider = (e) => {
    setForm(f => ({ ...f, max_react_iterations: Number(e.target.value) }))
  }

  const handleSave = async () => {
    setSaving(true)
    // Only send fields that have actual values (don't send empty masked-input placeholders)
    const payload = {}
    Object.entries(form).forEach(([k, v]) => {
      if (v !== '' && v !== null && v !== undefined) payload[k] = v
    })
    try {
      await saveSettings(payload)
      showToast('Settings saved successfully', 'success')
      load()
    } catch (e) {
      showToast(`Save failed: ${e.message}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleReset = () => {
    setForm(prev => ({
      ...prev,
      anthropic_api_key: '',
      github_pat: '',
      dd_api_key: '',
      dd_app_key: '',
    }))
    load()
    showToast('Reset to environment defaults', 'info')
  }

  if (loading) {
    return (
      <div className="settings-layout">
        <div className="settings-nav">
          {SECTIONS.map(s => (
            <div key={s.id} className="skeleton" style={{ height: 40, borderRadius: 10, marginBottom: 4 }} />
          ))}
        </div>
        <div className="glass settings-section">
          <div className="skeleton skeleton-line full" style={{ height: 20, marginBottom: 16 }} />
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="skeleton skeleton-line" style={{ height: 44, marginBottom: 12 }} />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="settings-layout">
      {/* Section nav */}
      <div className="settings-nav">
        {SECTIONS.map(s => (
          <button
            key={s.id}
            className={`settings-nav-item${activeSection === s.id ? ' active' : ''}`}
            onClick={() => setActiveSection(s.id)}
          >
            <span style={{ fontSize: 15 }}>{s.icon}</span>
            {s.label}
          </button>
        ))}
      </div>

      {/* Section content */}
      <div className="settings-content">
        {activeSection === 'claude' && (
          <div className="glass settings-section">
            <h3 className="settings-section-title">
              <span>🤖</span> Claude AI Settings
            </h3>
            <div className="settings-fields">
              <div className="settings-field-full">
                <MaskedInput
                  label="Anthropic API Key"
                  name="anthropic_api_key"
                  value={form.anthropic_api_key}
                  onChange={handleChange}
                  help={displayed.anthropic_api_key ? `Current: ${displayed.anthropic_api_key}` : 'Required for RCA analysis'}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Model</label>
                <select
                  className="form-select"
                  name="model"
                  value={form.model}
                  onChange={handleChange}
                >
                  {MODELS.map(m => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">
                  Max Iterations &nbsp;
                  <span className="slider-value">{form.max_react_iterations}</span>
                </label>
                <input
                  type="range"
                  className="form-range"
                  min="5"
                  max="30"
                  step="1"
                  value={form.max_react_iterations}
                  onChange={handleSlider}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)' }}>
                  <span>5 (Fast)</span>
                  <span>30 (Thorough)</span>
                </div>
              </div>
            </div>
            <SettingsActions onSave={handleSave} onReset={handleReset} saving={saving} />
          </div>
        )}

        {activeSection === 'github' && (
          <div className="glass settings-section">
            <h3 className="settings-section-title">
              <span>⎇</span> GitHub Settings
            </h3>
            <div className="settings-fields">
              <div className="settings-field-full">
                <MaskedInput
                  label="Personal Access Token"
                  name="github_pat"
                  value={form.github_pat}
                  onChange={handleChange}
                  help={displayed.github_pat ? `Current: ${displayed.github_pat}` : 'Required for repo analysis'}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Organization / User</label>
                <input
                  type="text"
                  className="form-input"
                  name="github_org"
                  value={form.github_org}
                  onChange={handleChange}
                  placeholder="e.g. oscorpAI"
                />
                <span className="form-help">GitHub org or user to search repos in</span>
              </div>
            </div>
            <SettingsActions onSave={handleSave} onReset={handleReset} saving={saving} />
          </div>
        )}

        {activeSection === 'datadog' && (
          <div className="glass settings-section">
            <h3 className="settings-section-title">
              <span>📊</span> Datadog Settings
            </h3>
            <div className="settings-fields">
              <div className="settings-field-full">
                <MaskedInput
                  label="DD API Key"
                  name="dd_api_key"
                  value={form.dd_api_key}
                  onChange={handleChange}
                  help={displayed.dd_api_key ? `Current: ${displayed.dd_api_key}` : 'From Datadog org settings'}
                />
              </div>
              <div className="settings-field-full">
                <MaskedInput
                  label="DD Application Key"
                  name="dd_app_key"
                  value={form.dd_app_key}
                  onChange={handleChange}
                  help={displayed.dd_app_key ? `Current: ${displayed.dd_app_key}` : 'From Datadog application keys'}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Site</label>
                <select
                  className="form-select"
                  name="dd_site"
                  value={form.dd_site}
                  onChange={handleChange}
                >
                  {DD_SITES.map(s => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </div>
            </div>
            <SettingsActions onSave={handleSave} onReset={handleReset} saving={saving} />
          </div>
        )}

        {activeSection === 'observability' && (
          <div className="glass settings-section">
            <h3 className="settings-section-title">
              <span>👁</span> Observability &amp; CI/CD
            </h3>
            <div className="settings-fields">
              <div className="form-group">
                <label className="form-label">Observability Adapter</label>
                <div className="toggle-group">
                  {['local', 'datadog'].map(v => (
                    <button
                      key={v}
                      className={`toggle-option${form.observability_adapter === v ? ' active' : ''}`}
                      onClick={() => setForm(f => ({ ...f, observability_adapter: v }))}
                    >
                      {v === 'local' ? 'Local DB' : 'Datadog'}
                    </button>
                  ))}
                </div>
                <span className="form-help" style={{ marginTop: 6 }}>
                  Current: <strong style={{ color: 'var(--text-secondary)' }}>{displayed.observability_adapter}</strong>
                </span>
              </div>
              <div className="form-group">
                <label className="form-label">CI/CD Adapter</label>
                <div className="toggle-group">
                  {['mock', 'real'].map(v => (
                    <button
                      key={v}
                      className={`toggle-option${form.cicd_adapter === v ? ' active' : ''}`}
                      onClick={() => setForm(f => ({ ...f, cicd_adapter: v }))}
                    >
                      {v === 'mock' ? 'Mock' : 'Real'}
                    </button>
                  ))}
                </div>
                <span className="form-help" style={{ marginTop: 6 }}>
                  Current: <strong style={{ color: 'var(--text-secondary)' }}>{displayed.cicd_adapter}</strong>
                </span>
              </div>
            </div>
            <SettingsActions onSave={handleSave} onReset={handleReset} saving={saving} />
          </div>
        )}

        {activeSection === 'database' && (
          <div className="glass settings-section">
            <h3 className="settings-section-title">
              <span>🗄</span> Database
            </h3>
            <div className="settings-fields">
              <div className="settings-field-full">
                <div className="form-group">
                  <label className="form-label">Connection String</label>
                  <input
                    type="text"
                    className="form-input mono"
                    name="database_url"
                    value={form.database_url || displayed.database_url || ''}
                    onChange={handleChange}
                    placeholder="mysql+pymysql://user:pass@host:3306/db"
                  />
                  <span className="form-help">
                    Current (masked): <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{displayed.database_url}</code>
                  </span>
                </div>
              </div>
            </div>
            <SettingsActions onSave={handleSave} onReset={handleReset} saving={saving} />
          </div>
        )}
      </div>
    </div>
  )
}

function SettingsActions({ onSave, onReset, saving }) {
  return (
    <div className="settings-actions">
      <button
        className="btn btn-primary"
        onClick={onSave}
        disabled={saving}
      >
        {saving ? (
          <>
            <span className="anim-spin" style={{ display: 'inline-block', width: 12, height: 12, border: '2px solid rgba(255,255,255,0.3)', borderTopColor: 'white', borderRadius: '50%' }} />
            Saving...
          </>
        ) : 'Save Changes'}
      </button>
      <button className="btn btn-secondary" onClick={onReset}>
        Reset to Defaults
      </button>
    </div>
  )
}
