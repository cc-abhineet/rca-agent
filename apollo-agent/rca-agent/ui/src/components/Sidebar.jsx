import React, { useState, useEffect, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { getUsername, clearToken, activateOrg } from '../api/client'
import { useApp } from '../context/AppContext'
import OrgWizard from './OrgWizard'

const NAV = [
  {
    id: 'home', label: 'Home', path: '/home',
    icon: <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" /></svg>,
  },
  {
    id: 'incidents', label: 'Incidents', path: '/incidents',
    icon: <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>,
  },
  {
    id: 'workspace', label: 'Investigations', path: '/workspace',
    icon: <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18" /></svg>,
    showPulse: true,
  },
  {
    id: 'integrations', label: 'Integrations', path: '/integrations',
    icon: <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z" /></svg>,
    tag: 'ADMIN',
  },
  {
    id: 'reports', label: 'Reports', path: '/reports',
    icon: <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>,
  },
  {
    id: 'eval', label: 'Eval Suite', path: '/eval',
    icon: <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>,
  },
  {
    id: 'tokens', label: 'Token Usage', path: '/tokens',
    icon: <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>,
  },
]

const SWITCH_STEPS = ['Credentials updated', 'Ingestion agent connected', 'Data loaded']

const OVERLAY = {
  position: 'fixed', inset: 0, zIndex: 2000,
  background: 'rgba(0,0,0,0.55)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  animation: 'fadeIn 0.15s ease',
}

const MODAL = {
  width: 360, background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  borderRadius: 16, padding: '24px',
  boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
  animation: 'fadeUp 0.2s ease',
}

function OrgSwitchModal({ target, phase, step, onCancel, onConfirm }) {
  const orgInitial = target?.name?.[0]?.toUpperCase() || 'O'

  if (phase === 'done') {
    return (
      <div style={OVERLAY}>
        <div style={{ ...MODAL, textAlign: 'center', padding: '36px 32px' }}>
          <div style={{
            width: 56, height: 56, borderRadius: '50%',
            background: 'rgba(34,197,94,0.12)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 16px',
          }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>Connected!</div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            <strong style={{ color: 'var(--text-primary)' }}>{target?.name}</strong> is now active
          </div>
        </div>
      </div>
    )
  }

  if (phase === 'loading') {
    return (
      <div style={OVERLAY}>
        <div style={MODAL}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 22 }}>
            <div style={{
              width: 34, height: 34, borderRadius: '50%', flexShrink: 0,
              border: '3px solid var(--border)',
              borderTopColor: 'var(--indigo)',
              animation: 'ap-spin 0.8s linear infinite',
            }} />
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
                Connecting to {target?.name}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Setting up your workspace…</div>
            </div>
          </div>

          {/* Progress bar */}
          <div style={{ height: 3, background: 'var(--border)', borderRadius: 2, marginBottom: 20, overflow: 'hidden' }}>
            <div style={{
              height: '100%',
              width: `${Math.round((step / SWITCH_STEPS.length) * 100)}%`,
              background: 'var(--indigo-grad)', borderRadius: 2,
              transition: 'width 0.5s ease',
            }} />
          </div>

          {/* Step list */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
            {SWITCH_STEPS.map((label, i) => {
              const n       = i + 1
              const done    = step > n
              const active  = step === n
              const pending = step < n
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
    )
  }

  // Confirm stage
  return (
    <div style={OVERLAY}>
      <div style={MODAL}>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>Switch organization</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 18 }}>You're switching to</div>

        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '12px 14px', borderRadius: 10,
          background: 'var(--bg-2)', border: '1px solid var(--border)', marginBottom: 18,
        }}>
          <div style={{
            width: 36, height: 36, borderRadius: 9,
            background: 'var(--indigo-grad)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontSize: 15, fontWeight: 800, flexShrink: 0,
          }}>
            {orgInitial}
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{target?.name}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{target?.environment || 'production'}</div>
          </div>
        </div>

        <div style={{
          fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.65,
          padding: '10px 12px', background: 'var(--bg-2)', borderRadius: 8,
          border: '1px solid var(--border)', marginBottom: 22,
        }}>
          All credentials, integrations, and data will switch to this organization. The ingestion agent will connect automatically.
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onCancel} style={{
            flex: 1, padding: '9px 0', borderRadius: 8,
            border: '1px solid var(--border)', background: 'var(--bg-2)',
            color: 'var(--text-primary)', fontSize: 13, fontWeight: 500, cursor: 'pointer',
          }}>
            Cancel
          </button>
          <button onClick={onConfirm} style={{
            flex: 1, padding: '9px 0', borderRadius: 8, border: 'none',
            background: 'var(--indigo-grad)', color: '#fff',
            fontSize: 13, fontWeight: 600, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          }}>
            Connect
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms))
}

export default function Sidebar({ hasActiveIncidents, incidentCount }) {
  const navigate  = useNavigate()
  const location  = useLocation()
  const username  = getUsername() || 'User'
  const initials  = username.slice(0, 2).toUpperCase()

  const { orgs, activeOrg, setActiveOrg, loadOrgs } = useApp()

  const [orgOpen,      setOrgOpen]      = useState(false)
  const [wizardOpen,   setWizardOpen]   = useState(false)
  const orgRef = useRef(null)

  // Org-switch modal state
  const [switchTarget, setSwitchTarget] = useState(null)
  const [switchPhase,  setSwitchPhase]  = useState('idle')  // idle | confirm | loading | done
  const [switchStep,   setSwitchStep]   = useState(0)       // 1-3

  useEffect(() => {
    function handler(e) {
      if (orgRef.current && !orgRef.current.contains(e.target)) {
        setOrgOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleNav = (item) => {
    if (item.soon || !item.path) return
    if (item.id === 'workspace') { navigate('/investigations'); return }
    navigate(item.path)
  }

  const handleSignOut = () => {
    clearToken()
    navigate('/login', { replace: true })
  }

  const isActive = (item) => {
    if (!item.path) return false
    if (item.path === '/home') return location.pathname === '/home'
    if (item.path === '/workspace') {
      return location.pathname.startsWith('/workspace') || location.pathname === '/investigations'
    }
    return location.pathname === item.path || location.pathname.startsWith(item.path + '/')
  }

  const handleOrgClick = (org) => {
    setOrgOpen(false)
    if (org.id === activeOrg?.id) return
    setSwitchTarget(org)
    setSwitchPhase('confirm')
    setSwitchStep(0)
  }

  const handleSwitchCancel = () => {
    setSwitchPhase('idle')
    setSwitchTarget(null)
    setSwitchStep(0)
  }

  const handleSwitchConfirm = async () => {
    setSwitchPhase('loading')

    // Step 1 — credentials (instant context switch)
    setSwitchStep(1)
    setActiveOrg(switchTarget)

    // Step 2 — connect ingestion agent (real API call)
    setSwitchStep(2)
    try { await activateOrg(switchTarget.id) } catch { /* best-effort */ }

    // Step 3 — refresh org data
    setSwitchStep(3)
    await loadOrgs()

    setSwitchPhase('done')
    await delay(1300)

    setSwitchPhase('idle')
    setSwitchTarget(null)
    setSwitchStep(0)
  }

  const displayOrg = activeOrg || { name: 'Select org', environment: '—' }
  const orgInitial = displayOrg.name?.[0]?.toUpperCase() || '?'

  return (
    <>
      <aside className="ap-sidebar">
        {/* Org switcher */}
        <div className="ap-org-switcher" ref={orgRef}>
          <button className="ap-org-btn" onClick={() => setOrgOpen(o => !o)}>
            <div className="ap-org-mark">{orgInitial}</div>
            <div className="ap-org-info">
              <div className="ap-org-name">{displayOrg.name}</div>
              <div className="ap-org-sub">{displayOrg.environment || 'production'}</div>
            </div>
            <span className={`ap-org-chevron${orgOpen ? ' open' : ''}`}>▾</span>
          </button>

          {orgOpen && (
            <div className="ap-org-dropdown">
              <div className="ap-org-dropdown-list">
                {orgs.length === 0 && (
                  <div style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-muted)' }}>No organizations yet</div>
                )}
                {orgs.map(org => (
                  <div
                    key={org.id}
                    className={`ap-org-dropdown-item${activeOrg?.id === org.id ? ' active' : ''}`}
                    onClick={() => handleOrgClick(org)}
                  >
                    <div style={{ width: 22, height: 22, borderRadius: 6, background: 'var(--indigo-grad)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 11, fontWeight: 800, flexShrink: 0 }}>
                      {org.name?.[0]?.toUpperCase() || 'O'}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{org.name}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{org.environment || 'production'}</div>
                    </div>
                    {activeOrg?.id === org.id && <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--indigo)' }}>✓</span>}
                  </div>
                ))}
              </div>
              <div className="ap-org-dropdown-divider" />
              <button
                className="ap-org-create-btn"
                onClick={() => { setOrgOpen(false); setWizardOpen(true) }}
              >
                <span>＋</span> Create organization
              </button>
            </div>
          )}
        </div>

        {/* Nav */}
        <nav className="ap-sidebar-nav">
          {NAV.map(item => (
            <button
              key={item.id}
              className={`ap-nav-item${item.soon ? ' disabled' : ''}${isActive(item) ? ' ap-nav-active' : ''}`}
              onClick={() => handleNav(item)}
              title={item.soon ? 'Coming soon' : item.label}
            >
              <span className="ap-nav-icon" style={{ color: isActive(item) ? 'var(--indigo)' : 'var(--text-muted)' }}>
                {item.icon}
              </span>
              <span className="ap-nav-label">{item.label}</span>

              {item.showPulse && hasActiveIncidents && (
                <span className="ap-nav-pulse" />
              )}
              {item.id === 'incidents' && incidentCount > 0 && (
                <span className="ap-nav-badge">{incidentCount > 99 ? '99+' : incidentCount}</span>
              )}
              {item.tag && (
                <span className="ap-nav-tag">{item.tag}</span>
              )}
              {item.soon && (
                <span className="ap-nav-tag" style={{ color: 'var(--text-muted)', background: 'var(--bg-2)' }}>SOON</span>
              )}
            </button>
          ))}
        </nav>

        {/* User block */}
        <div className="ap-sidebar-user">
          <button className="ap-user-btn" onClick={() => navigate('/profile')}>
            <div className="ap-user-avatar">{initials}</div>
            <div>
              <div className="ap-user-name">{username}</div>
              <div className="ap-user-role">on-call</div>
            </div>
          </button>
          <button
            className="ap-btn-ghost btn"
            style={{ fontSize: 11, padding: '4px 8px', marginTop: 6, width: '100%' }}
            onClick={handleSignOut}
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* Org creation wizard */}
      {wizardOpen && (
        <OrgWizard
          onClose={() => setWizardOpen(false)}
          onCreated={(org) => {
            loadOrgs()
            if (org) setActiveOrg(org)
          }}
        />
      )}

      {/* Org switch modal */}
      {switchPhase !== 'idle' && (
        <OrgSwitchModal
          target={switchTarget}
          phase={switchPhase}
          step={switchStep}
          onCancel={handleSwitchCancel}
          onConfirm={handleSwitchConfirm}
        />
      )}
    </>
  )
}
