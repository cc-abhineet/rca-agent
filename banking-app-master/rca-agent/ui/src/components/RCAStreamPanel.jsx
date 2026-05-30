import React, { useEffect, useRef, useState, useCallback } from 'react'
import { streamRCA, cancelRCA } from '../api/client'
import { useApp } from '../context/AppContext'

const PHASES = ['Initialize', 'Repository', 'Code Analysis', 'Complete']

const EVENT_META = {
  reasoning:     { icon: '🧠', label: 'Reasoning', type: 'reasoning' },
  tool_call:     { icon: '🔧', label: 'Tool Call',  type: 'tool_call' },
  tool_result:   { icon: '✓',  label: 'Tool Result', type: 'tool_result' },
  cache_hit:     { icon: '⚡', label: 'Cache Hit',  type: 'cache_hit' },
  repo_resolved: { icon: '⎇',  label: 'Repo',      type: 'repo_resolved' },
  start:         { icon: '▶',  label: 'Start',      type: 'start' },
  done:          { icon: '★',  label: 'Done',       type: 'done' },
  error:         { icon: '✕',  label: 'Error',      type: 'error' },
}

const FILTER_OPTIONS = ['All', 'Reasoning', 'Tools', 'System']

function filterEvent(ev, filter) {
  if (filter === 'All') return true
  if (filter === 'Reasoning') return ev.type === 'reasoning'
  if (filter === 'Tools') return ev.type === 'tool_call' || ev.type === 'tool_result'
  if (filter === 'System') return ['cache_hit', 'repo_resolved', 'start', 'done', 'error'].includes(ev.type)
  return true
}

function useElapsed(running) {
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef(Date.now())

  useEffect(() => {
    if (!running) return
    startRef.current = Date.now()
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 1000)
    return () => clearInterval(id)
  }, [running])

  const s = elapsed % 60
  const m = Math.floor(elapsed / 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function TypewriterText({ text }) {
  const [displayed, setDisplayed] = useState('')
  const idx = useRef(0)

  useEffect(() => {
    idx.current = 0
    setDisplayed('')
    const id = setInterval(() => {
      if (idx.current < text.length) {
        setDisplayed(text.slice(0, idx.current + 1))
        idx.current++
      } else {
        clearInterval(id)
      }
    }, 12)
    return () => clearInterval(id)
  }, [text])

  return (
    <span
      className={`stream-event-text${idx.current < text.length ? ' typewriter' : ''}`}
      style={{ display: 'block' }}
    >
      {displayed}
    </span>
  )
}

function EventCard({ ev }) {
  const [expanded, setExpanded] = useState(false)
  const meta = EVENT_META[ev.type] || { icon: '·', label: ev.type, type: ev.type }
  const ts = ev.ts ? new Date(ev.ts).toLocaleTimeString() : ''

  if (ev.type === 'done') {
    const confidence = ev.report?.confidence_score
    return (
      <div className="stream-done-banner">
        <h4>Analysis Complete</h4>
        {confidence != null && (
          <div className="confidence-badge">
            Confidence: {Math.round(confidence * 100)}%
          </div>
        )}
        {ev.report?.root_cause && (
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '8px 0' }}>
            {ev.report.root_cause.slice(0, 200)}
          </p>
        )}
      </div>
    )
  }

  if (ev.type === 'error') {
    return (
      <div className={`stream-event ${ev.type}`}>
        <div className="stream-event-border" />
        <div className="stream-event-inner">
          <div className="stream-event-header">
            <span className="stream-event-icon">{meta.icon}</span>
            <span className="stream-event-label">{meta.label}</span>
            <span className="stream-event-ts">{ts}</span>
          </div>
          <span className="stream-event-text">{ev.message}</span>
        </div>
      </div>
    )
  }

  return (
    <div className={`stream-event ${meta.type}`}>
      <div className="stream-event-border" />
      <div className="stream-event-inner">
        <div className="stream-event-header">
          <span className="stream-event-icon">{meta.icon}</span>
          <span className="stream-event-label">{meta.label}</span>
          {ev.tool_name && (
            <span style={{ fontSize: 12, color: 'var(--cyan)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
              {ev.tool_name}
            </span>
          )}
          <span className="stream-event-ts">{ts}</span>
        </div>

        {ev.type === 'reasoning' && (
          <TypewriterText text={ev.text || ev.message || ''} />
        )}

        {ev.type !== 'reasoning' && (ev.text || ev.message || ev.service) && (
          <span className="stream-event-text" style={{ display: 'block' }}>
            {ev.type === 'repo_resolved'
              ? `${ev.service || ''} → ${ev.owner || ''}/${ev.repo || ''}`
              : ev.text || ev.message || ''}
          </span>
        )}

        {ev.type === 'tool_call' && ev.args && (
          <div className="stream-event-collapsible">
            <button className="stream-event-toggle" onClick={() => setExpanded(e => !e)}>
              {expanded ? '▾ Hide args' : '▸ Show args'}
            </button>
            {expanded && (
              <div style={{ marginTop: 8, background: 'rgba(0,0,0,0.3)', borderRadius: 6, padding: '8px 12px' }}>
                <pre style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  {typeof ev.args === 'string' ? ev.args : JSON.stringify(ev.args, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}

        {ev.type === 'tool_result' && ev.result && (
          <div className="stream-event-collapsible">
            <button className="stream-event-toggle" onClick={() => setExpanded(e => !e)}>
              {expanded ? '▾ Hide result' : '▸ Show result'}
            </button>
            {expanded && (
              <div style={{ marginTop: 8, background: 'rgba(0,0,0,0.3)', borderRadius: 6, padding: '8px 12px' }}>
                <pre style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 200, overflow: 'auto' }}>
                  {typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function PhaseTracker({ phase }) {
  return (
    <div className="phase-tracker">
      {PHASES.map((p, i) => {
        const isDone   = i < phase
        const isActive = i === phase
        const cls = isDone ? 'complete' : isActive ? 'active' : 'pending'
        return (
          <React.Fragment key={p}>
            <div className="phase-item">
              <div className={`phase-dot ${cls}`}>
                {isDone ? '✓' : i + 1}
              </div>
              <span className={`phase-label ${cls}`}>{p}</span>
            </div>
            {i < PHASES.length - 1 && (
              <div className={`phase-line ${isDone ? 'complete' : isActive ? 'active' : ''}`} />
            )}
          </React.Fragment>
        )
      })}
    </div>
  )
}

export default function RCAStreamPanel() {
  const { streamTarget, closeStream, showToast } = useApp()
  const [events, setEvents]     = useState([])
  const [filter, setFilter]     = useState('All')
  const [running, setRunning]   = useState(true)
  const [done, setDone]         = useState(false)
  const [phase, setPhase]       = useState(0)
  const [iterCount, setIterCount] = useState(0)
  const scrollRef  = useRef(null)
  const cleanupRef = useRef(null)
  const phaseRef   = useRef(0)   // mirrors phase state; always current inside callbacks

  const elapsed = useElapsed(running)

  // Keep phaseRef in sync so the stream callback never reads a stale closure value
  useEffect(() => { phaseRef.current = phase }, [phase])

  const advancePhase = useCallback((type) => {
    if (type === 'start')               { setPhase(0); phaseRef.current = 0 }
    else if (type === 'repo_resolved')  { setPhase(1); phaseRef.current = 1 }
    else if (type === 'tool_call' && phaseRef.current < 2) { setPhase(2); phaseRef.current = 2 }
    else if (type === 'done')           { setPhase(3); phaseRef.current = 3 }
  }, [])  // no phase dep — reads phaseRef.current which is always fresh

  useEffect(() => {
    if (!streamTarget) return
    setEvents([])
    setFilter('All')
    setRunning(true)
    setDone(false)
    setPhase(0)
    setIterCount(0)

    const cleanup = streamRCA(
      streamTarget.id,
      (ev) => {
        setEvents(prev => [...prev, { ...ev, _id: Date.now() + Math.random() }])
        advancePhase(ev.type)
        if (ev.type === 'reasoning') setIterCount(c => c + 1)
        if (ev.type === 'done' || ev.type === 'error') {
          setRunning(false)
          setDone(true)
          if (ev.type === 'done') showToast('RCA completed successfully', 'success')
          else showToast(`RCA failed: ${ev.message}`, 'error')
        }
      },
      (err) => {
        setRunning(false)
        setEvents(prev => [...prev, { type: 'error', message: 'Stream connection lost', _id: Date.now() }])
      }
    )
    cleanupRef.current = cleanup
    return () => { cleanup(); cleanupRef.current = null }
  }, [streamTarget?.id])

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [events])

  if (!streamTarget) return null

  const filteredEvents = events.filter(ev => filterEvent(ev, filter))
  const eventCount = events.length

  const handleStop = useCallback(() => {
    // Close SSE stream client-side
    if (cleanupRef.current) cleanupRef.current()
    setRunning(false)
    // Cancel server-side (marks DB as failed/cancelled)
    if (streamTarget?.id) {
      cancelRCA(streamTarget.id).catch(() => {})
    }
    showToast('RCA cancelled', 'info')
  }, [streamTarget?.id, showToast])

  return (
    <div className="stream-overlay" onClick={e => e.target === e.currentTarget && closeStream()}>
      <div className="stream-panel">
        {/* Header */}
        <div className="stream-header">
          <div style={{ width: 36, height: 36, borderRadius: 8, background: 'var(--indigo-dim)', border: '1px solid rgba(99,102,241,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="var(--indigo-light)" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17H3a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2h-2" />
            </svg>
          </div>
          <div className="stream-title">
            <h3>RCA Analysis</h3>
            <p>
              {streamTarget.service && <span className="log-service-badge" style={{ marginRight: 6, fontSize: 10 }}>{streamTarget.service}</span>}
              {streamTarget.errorType}
              &nbsp;·&nbsp;
              <span style={{ fontFamily: 'var(--font-mono)' }}>#{streamTarget.id.slice(0, 8)}</span>
            </p>
          </div>
          <div className="stream-timer">{elapsed}</div>
          <button className="btn btn-ghost btn-icon" onClick={closeStream} title="Close">
            <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Phase tracker */}
        <PhaseTracker phase={phase} />

        {/* Filter pills */}
        <div className="stream-filters">
          {FILTER_OPTIONS.map(f => (
            <button
              key={f}
              className={`filter-pill${filter === f ? ' active-all' : ''}`}
              style={{ fontSize: 11 }}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
          {running && (
            <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--cyan)' }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--cyan)', animation: 'pulseDot 1s infinite', display: 'inline-block' }} />
              Live
            </span>
          )}
        </div>

        {/* Events */}
        <div className="stream-events" ref={scrollRef}>
          {filteredEvents.length === 0 && running && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 13, padding: '16px 0' }}>
              <span className="anim-spin" style={{ display: 'inline-block', width: 14, height: 14, border: '2px solid var(--border)', borderTopColor: 'var(--indigo)', borderRadius: '50%' }} />
              Connecting to agent...
            </div>
          )}
          {filteredEvents.map(ev => <EventCard key={ev._id} ev={ev} />)}
          {done && !running && events.some(e => e.type === 'done') && (
            <div style={{ padding: '8px 0' }}>
              <a
                href={`/rca/${streamTarget.id}/report`}
                target="_blank"
                rel="noreferrer"
                className="btn btn-primary w-full"
                style={{ justifyContent: 'center', marginTop: 8 }}
              >
                View Full Report →
              </a>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="stream-footer">
          <div className="stream-meta">
            <div className="stream-meta-item">
              <span className="stream-meta-label">Iterations</span>
              <span className="stream-meta-val">{iterCount}</span>
            </div>
            <div className="stream-meta-item">
              <span className="stream-meta-label">Events</span>
              <span className="stream-meta-val">{eventCount}</span>
            </div>
            <div className="stream-meta-item">
              <span className="stream-meta-label">Elapsed</span>
              <span className="stream-meta-val">{elapsed}</span>
            </div>
            <div className="stream-meta-item">
              <span className="stream-meta-label">Status</span>
              <span className="stream-meta-val" style={{ color: running ? 'var(--cyan)' : done ? 'var(--success)' : 'var(--text-muted)' }}>
                {running ? 'Running' : done ? 'Done' : 'Idle'}
              </span>
            </div>
          </div>
          {running && (
            <button className="btn btn-danger" onClick={handleStop}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style={{ marginRight: 5 }}>
                <rect x="6" y="6" width="12" height="12" rx="1" />
              </svg>
              Stop RCA
            </button>
          )}
          {!running && (
            <button className="btn btn-secondary" onClick={closeStream}>
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
