import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getUsername, clearToken } from '../api/client'

function Toggle({ on, onChange, label, sub }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', borderBottom: '1px solid var(--hairline)' }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{label}</div>
        {sub && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
      </div>
      <div
        onClick={() => onChange(!on)}
        style={{
          width: 40, height: 22, borderRadius: 11,
          background: on ? 'var(--indigo)' : 'var(--bg-3)',
          cursor: 'pointer', position: 'relative',
          transition: 'background .2s ease', flexShrink: 0,
        }}
      >
        <div style={{
          position: 'absolute', top: 3, left: on ? 21 : 3,
          width: 16, height: 16, borderRadius: '50%',
          background: '#fff', transition: 'left .2s ease',
          boxShadow: '0 1px 3px rgba(0,0,0,.15)',
        }} />
      </div>
    </div>
  )
}

function EditProfileModal({ username, email, displayName, onClose, onSave }) {
  const [form, setForm] = useState({ displayName: displayName || username, email: email || '', role: 'Admin' })
  const [saving, setSaving] = useState(false)
  const update = k => e => setForm(f => ({ ...f, [k]: e.target.value }))

  const handleSave = async () => {
    setSaving(true)
    await new Promise(r => setTimeout(r, 500))
    onSave(form)
    setSaving(false)
    onClose()
  }

  return (
    <div className="ap-modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="ap-modal" style={{ maxWidth: 420 }}>
        <div className="ap-modal-header">
          <span className="ap-modal-title">Edit Profile</span>
          <button className="ap-modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="ap-modal-body">
          <div className="form-group">
            <label className="form-label">Display name</label>
            <input className="form-input" value={form.displayName} onChange={update('displayName')} placeholder="Your name" />
          </div>
          <div className="form-group">
            <label className="form-label">Email</label>
            <input type="email" className="form-input" value={form.email} onChange={update('email')} placeholder="you@company.com" />
          </div>
          <div className="form-group">
            <label className="form-label">Role</label>
            <select className="form-select" value={form.role} onChange={update('role')}>
              <option value="Admin">Admin</option>
              <option value="Engineer">Engineer</option>
              <option value="Viewer">Viewer</option>
            </select>
          </div>
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

export default function ProfilePage() {
  const navigate      = useNavigate()
  const rawName       = getUsername() || 'User'
  const [displayName, setDisplayName] = useState(rawName)
  const [email, setEmail]             = useState('')
  const [editOpen, setEditOpen]       = useState(false)
  const initials  = displayName.slice(0, 2).toUpperCase()

  const [notifs, setNotifs] = useState({ critical: true, mentions: true, digest: false })

  const handleSignOut = () => {
    clearToken()
    navigate('/login', { replace: true })
  }

  const handleSaved = (form) => {
    setDisplayName(form.displayName || rawName)
    setEmail(form.email)
  }

  return (
    <div className="ap-page" style={{ maxWidth: 640, gap: 20 }}>
      <div className="ap-page-header">
        <h1 className="ap-page-title">Profile</h1>
        <button className="btn btn-danger" onClick={handleSignOut}>Sign out</button>
      </div>

      {/* Identity card */}
      <div className="ap-card">
        <div className="ap-card-header">
          <span className="ap-card-title">Identity</span>
          <button
            className="ap-btn-ghost btn"
            style={{ fontSize: 12, padding: '4px 10px' }}
            onClick={() => setEditOpen(true)}
          >
            Edit profile
          </button>
        </div>
        <div className="ap-card-body" style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <div style={{
            width: 64, height: 64, borderRadius: '50%',
            background: 'var(--indigo-grad)', color: '#fff',
            fontSize: 22, fontWeight: 800,
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            {initials}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>{displayName}</div>
            {email && <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 6 }}>{email}</div>}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span className="badge badge-indigo">Admin</span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Apollo Corp · production</span>
            </div>
          </div>
        </div>
      </div>

      {/* Notifications */}
      <div className="ap-card">
        <div className="ap-card-header"><span className="ap-card-title">Notifications</span></div>
        <div className="ap-card-body" style={{ paddingTop: 0 }}>
          <Toggle on={notifs.critical} onChange={v => setNotifs(n => ({ ...n, critical: v }))}
            label="Critical incidents" sub="Get notified immediately when a critical incident occurs" />
          <Toggle on={notifs.mentions} onChange={v => setNotifs(n => ({ ...n, mentions: v }))}
            label="Steer mentions" sub="Get notified when you are @mentioned in an investigation" />
          <div style={{ borderBottom: 'none' }}>
            <Toggle on={notifs.digest} onChange={v => setNotifs(n => ({ ...n, digest: v }))}
              label="Daily digest" sub="Receive a daily summary of incidents and resolutions" />
          </div>
        </div>
      </div>

      {/* Workspace administration */}
      <div className="ap-card">
        <div className="ap-card-header">
          <span className="ap-card-title">Workspace administration</span>
          <span className="badge badge-indigo">Admin</span>
        </div>
        <div className="ap-card-body" style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>Integrations</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 1 }}>Manage connected data sources</div>
            </div>
            <button className="ap-btn-ghost btn" style={{ fontSize: 12 }} onClick={() => navigate('/integrations')}>Manage →</button>
          </div>

          <div style={{ borderTop: '1px solid var(--hairline)', paddingTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>Organization</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 1 }}>Create or switch organizations</div>
            </div>
            <button className="ap-btn-ghost btn" style={{ fontSize: 12 }} onClick={() => navigate('/integrations')}>Manage →</button>
          </div>

          {/* Members — Invite greyed out (not yet supported) */}
          <div style={{ borderTop: '1px solid var(--hairline)', paddingTop: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Members</div>
              <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <button className="ap-btn-accent btn" style={{ fontSize: 12, padding: '4px 12px', opacity: 0.35, cursor: 'not-allowed' }} disabled>
                  + Invite
                </button>
                <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 5px', whiteSpace: 'nowrap' }}>
                  COMING SOON
                </span>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--indigo-grad)', color: '#fff', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  {initials}
                </div>
                <div style={{ flex: 1 }}>
                  <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{displayName}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 6 }}>you</span>
                </div>
                <span className="badge badge-indigo">Admin</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {editOpen && (
        <EditProfileModal
          username={rawName}
          email={email}
          displayName={displayName}
          onClose={() => setEditOpen(false)}
          onSave={handleSaved}
        />
      )}
    </div>
  )
}
