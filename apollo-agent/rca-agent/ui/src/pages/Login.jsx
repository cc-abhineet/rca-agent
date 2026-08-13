import React, { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { authLogin, authRegister, setToken } from '../api/client'

function EyeIcon({ open }) {
  return open ? (
    <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
    </svg>
  ) : (
    <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
    </svg>
  )
}

export default function Login() {
  const navigate = useNavigate()
  const location = useLocation()
  const from     = location.state?.from || '/home'

  const [mode,     setMode]     = useState('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm,  setConfirm]  = useState('')
  const [showPwd,  setShowPwd]  = useState(false)
  const [showCfm,  setShowCfm]  = useState(false)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')
  const [success,  setSuccess]  = useState('')

  function switchMode(m) {
    setMode(m); setError(''); setSuccess(''); setPassword(''); setConfirm('')
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError(''); setSuccess('')
    if (!username.trim())      return setError('Username is required')
    if (password.length < 6)   return setError('Password must be at least 6 characters')
    if (mode === 'register') {
      if (username.trim().length < 3) return setError('Username must be at least 3 characters')
      if (password !== confirm)       return setError('Passwords do not match')
    }
    setLoading(true)
    try {
      const fn   = mode === 'login' ? authLogin : authRegister
      const data = await fn(username.trim(), password)
      setToken(data.token, data.username)
      if (mode === 'register') {
        setSuccess('Account created! Redirecting…')
        setTimeout(() => navigate(from, { replace: true }), 800)
      } else {
        navigate(from, { replace: true })
      }
    } catch (err) {
      setError(err.message || 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-root">
      {/* Left panel — branding */}
      <div className="auth-left">
        <div className="auth-left-inner">
          {/* Logo mark */}
          <div className="auth-logo">
            <svg width="28" height="28" viewBox="0 0 40 40" fill="none">
              <circle cx="20" cy="20" r="18" stroke="white" strokeWidth="2" strokeDasharray="4 2" opacity="0.4"/>
              <circle cx="20" cy="20" r="10" fill="rgba(255,255,255,0.15)" stroke="white" strokeWidth="1.5"/>
              <circle cx="20" cy="8"  r="3" fill="white"/>
              <circle cx="20" cy="32" r="2" fill="rgba(255,255,255,0.5)"/>
              <circle cx="8"  cy="20" r="2" fill="rgba(255,255,255,0.5)"/>
              <circle cx="32" cy="20" r="2" fill="rgba(255,255,255,0.5)"/>
              <circle cx="20" cy="20" r="3" fill="white"/>
            </svg>
            <span className="auth-logo-name">Apollo</span>
          </div>

          <div className="auth-left-body">
            <h1 className="auth-left-title">AI-Powered Root Cause Analysis</h1>
            <p className="auth-left-sub">
              Investigate incidents faster with an AI agent that reads your logs, traces code, and pinpoints the root cause.
            </p>

            {/* Feature list */}
            <ul className="auth-feature-list">
              {[
                'Claude-powered ReAct investigation loop',
                'GitHub & GitLab blame + diff analysis',
                'Datadog logs, metrics & traces',
                'Chat with your incidents after RCA',
              ].map(f => (
                <li key={f} className="auth-feature-item">
                  <span className="auth-feature-check">✓</span>
                  {f}
                </li>
              ))}
            </ul>
          </div>

          {/* Decorative orbs */}
          <div className="auth-orb auth-orb-1" />
          <div className="auth-orb auth-orb-2" />
        </div>
      </div>

      {/* Right panel — form */}
      <div className="auth-right">
        <div className="auth-card">
          {/* Header */}
          <div className="auth-card-header">
            <h2 className="auth-card-title">
              {mode === 'login' ? 'Welcome back' : 'Create account'}
            </h2>
            <p className="auth-card-sub">
              {mode === 'login'
                ? 'Sign in to your Apollo workspace'
                : 'Set up your Apollo account'}
            </p>
          </div>

          {/* Tab switcher */}
          <div className="auth-tabs">
            <button
              className={`auth-tab${mode === 'login' ? ' active' : ''}`}
              onClick={() => switchMode('login')}
              type="button"
            >
              Sign In
            </button>
            <button
              className={`auth-tab${mode === 'register' ? ' active' : ''}`}
              onClick={() => switchMode('register')}
              type="button"
            >
              Register
            </button>
          </div>

          {/* Form */}
          <form className="auth-form" onSubmit={handleSubmit} autoComplete="off">
            <div className="auth-field">
              <label className="auth-label">Username</label>
              <input
                className="auth-input"
                type="text"
                placeholder="your_username"
                value={username}
                onChange={e => setUsername(e.target.value)}
                autoFocus
                autoComplete="username"
              />
            </div>

            <div className="auth-field">
              <label className="auth-label">Password</label>
              <div className="auth-input-wrap">
                <input
                  className="auth-input"
                  type={showPwd ? 'text' : 'password'}
                  placeholder="••••••••"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                />
                <button type="button" className="auth-eye" onClick={() => setShowPwd(v => !v)} tabIndex={-1}>
                  <EyeIcon open={showPwd} />
                </button>
              </div>
            </div>

            {mode === 'register' && (
              <div className="auth-field">
                <label className="auth-label">Confirm Password</label>
                <div className="auth-input-wrap">
                  <input
                    className="auth-input"
                    type={showCfm ? 'text' : 'password'}
                    placeholder="••••••••"
                    value={confirm}
                    onChange={e => setConfirm(e.target.value)}
                    autoComplete="new-password"
                  />
                  <button type="button" className="auth-eye" onClick={() => setShowCfm(v => !v)} tabIndex={-1}>
                    <EyeIcon open={showCfm} />
                  </button>
                </div>
              </div>
            )}

            {error   && <div className="auth-alert auth-alert-error">{error}</div>}
            {success && <div className="auth-alert auth-alert-success">{success}</div>}

            <button className="auth-submit" type="submit" disabled={loading}>
              {loading
                ? <span className="auth-spinner" />
                : mode === 'login' ? 'Sign In to Apollo' : 'Create Account'}
            </button>
          </form>

          <p className="auth-switch">
            {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
            <button
              type="button"
              className="auth-switch-btn"
              onClick={() => switchMode(mode === 'login' ? 'register' : 'login')}
            >
              {mode === 'login' ? 'Register' : 'Sign In'}
            </button>
          </p>
        </div>
      </div>
    </div>
  )
}
