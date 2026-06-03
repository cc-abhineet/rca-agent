import React, { useEffect, useRef, useState, memo, useCallback } from 'react'
import { streamRCA, cancelRCA } from '../api/client'
import { useApp } from '../context/AppContext'

const MAX_ITER = 20

// ── Session-level cache — survives panel close/re-open ────────
// Keyed by error_log_id. Cleared explicitly on re-run via clearStreamCache().
const _cache = {}

/** Call before openStream() when re-running an already-seen incident. */
export function clearStreamCache(id) {
  if (id) delete _cache[id]
}

// ── Neural background canvas ──────────────────────────────────
function NeuralBg({ active }) {
  const ref    = useRef(null)
  const animId = useRef(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const resize = () => {
      canvas.width  = canvas.offsetWidth
      canvas.height = canvas.offsetHeight
    }
    resize()
    const ctx = canvas.getContext('2d')
    const W = canvas.width, H = canvas.height
    const nodes = Array.from({ length: 22 }, () => ({
      x: Math.random() * W, y: Math.random() * H,
      vx: (Math.random() - 0.5) * 0.6, vy: (Math.random() - 0.5) * 0.6,
      pulse: Math.random() * Math.PI * 2,
    }))
    const draw = () => {
      ctx.clearRect(0, 0, W, H)
      const spd = active ? 1.1 : 0.25
      nodes.forEach(n => {
        n.pulse += 0.028; n.x += n.vx * spd; n.y += n.vy * spd
        if (n.x < 0 || n.x > W) n.vx *= -1
        if (n.y < 0 || n.y > H) n.vy *= -1
      })
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[i].x - nodes[j].x, dy = nodes[i].y - nodes[j].y
          const d  = Math.sqrt(dx * dx + dy * dy)
          if (d < 88) {
            ctx.beginPath()
            ctx.strokeStyle = `rgba(99,102,241,${0.2 * (1 - d / 88) * (active ? 1 : 0.4)})`
            ctx.lineWidth = 0.55
            ctx.moveTo(nodes[i].x, nodes[i].y); ctx.lineTo(nodes[j].x, nodes[j].y)
            ctx.stroke()
          }
        }
      }
      nodes.forEach(n => {
        const r = 1.5 + Math.sin(n.pulse) * 0.5
        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${active ? '99,102,241' : '70,85,160'},${active ? 0.5 : 0.18})`
        ctx.fill()
      })
      animId.current = requestAnimationFrame(draw)
    }
    draw()
    return () => cancelAnimationFrame(animId.current)
  }, [active])
  return <canvas ref={ref} className="neural-bg-canvas" />
}

// ── Confidence gauge ──────────────────────────────────────────
function ConfidenceGauge({ level }) {
  const pct   = level === 'high' ? 92 : level === 'medium' ? 65 : 38
  const r     = 42, circ = 2 * Math.PI * r
  const color = level === 'high' ? '#10b981' : level === 'medium' ? '#f59e0b' : '#f97316'
  return (
    <div className="gauge-hero">
      <div className="gauge-svg-wrap">
        <svg width="110" height="110" viewBox="0 0 110 110">
          <circle cx="55" cy="55" r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="7" />
          <circle cx="55" cy="55" r={r} fill="none" stroke={color}
            strokeWidth="7" strokeLinecap="round"
            strokeDasharray={circ} strokeDashoffset={circ - (pct / 100) * circ}
            transform="rotate(-90 55 55)"
            style={{ transition: 'stroke-dashoffset 1.4s cubic-bezier(0.34,1.56,0.64,1)', filter: `drop-shadow(0 0 8px ${color}99)` }}
          />
        </svg>
        <div className="gauge-center-hero">
          <span className="gauge-pct-hero" style={{ color }}>{pct}%</span>
          <span className="gauge-conf-lbl">{(level || 'N/A').toUpperCase()}</span>
        </div>
      </div>
      <div className="gauge-hero-label">Confidence</div>
    </div>
  )
}

// ── Typewriter ────────────────────────────────────────────────
const Typewriter = memo(function Typewriter({ text, speed = 7 }) {
  const [shown, setShown] = useState('')
  useEffect(() => {
    setShown(''); let i = 0
    const iv = setInterval(() => {
      if (i < text.length) setShown(text.slice(0, ++i)); else clearInterval(iv)
    }, speed)
    return () => clearInterval(iv)
  }, [text, speed])
  return <span>{shown}{shown.length < text.length && <span className="tw-cur" />}</span>
})

// ── Copy button ───────────────────────────────────────────────
function CopyBtn({ text }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className={`cb-copy-btn${copied ? ' copied' : ''}`}
      onClick={() => {
        navigator.clipboard.writeText(String(text)).catch(() => {})
        setCopied(true); setTimeout(() => setCopied(false), 1600)
      }}
    >{copied ? '✓ Copied' : '⎘ Copy'}</button>
  )
}

function CodeBlock({ text, maxH = 200 }) {
  const raw = typeof text === 'string' ? text : JSON.stringify(text, null, 2)
  return (
    <div className="code-block-wrap">
      <div className="code-block" style={{ maxHeight: maxH }}>{raw}</div>
      <CopyBtn text={raw} />
    </div>
  )
}

function JsonBlock({ obj }) {
  if (!obj) return null
  const raw = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)
  const hi  = raw
    .replace(/("(?:[^"\\]|\\.)*")(\s*:)/g, '<span class="jk">$1</span>$2')
    .replace(/:\s*("(?:[^"\\]|\\.)*")/g, ': <span class="js">$1</span>')
    .replace(/:\s*(\d+\.?\d*)/g, ': <span class="jn">$1</span>')
    .replace(/:\s*(true|false|null)/g, ': <span class="jb">$1</span>')
  return (
    <div className="code-block-wrap">
      <div className="code-block" dangerouslySetInnerHTML={{ __html: hi }} />
      <CopyBtn text={raw} />
    </div>
  )
}

// ── Phase tracker ─────────────────────────────────────────────
const PHASES = [
  { id: 'init', label: 'Initialize' },
  { id: 'repo', label: 'Repository' },
  { id: 'analyze', label: 'Analysis' },
  { id: 'done', label: 'Complete' },
]
function getPhaseIdx(events, status) {
  if (status === 'completed' || status === 'failed') return 3
  const types = new Set(events.map(e => e.type))
  if (types.has('reasoning') || types.has('tool_call')) return 2
  if (types.has('start')) return 1
  return 0
}
function PhaseTracker({ events, status }) {
  const ai = getPhaseIdx(events, status)
  return (
    <div className="phase-tracker">
      {PHASES.map((p, i) => (
        <React.Fragment key={p.id}>
          <div className={`phase-node ${i < ai ? 'past' : i === ai ? 'active' : 'future'}`}>
            <div className="phase-dot">{i < ai ? '✓' : i + 1}</div>
            <span className="phase-label">{p.label}</span>
          </div>
          {i < PHASES.length - 1 && <div className={`phase-connector ${i < ai ? 'filled' : ''}`} />}
        </React.Fragment>
      ))}
    </div>
  )
}

// ── Event body ────────────────────────────────────────────────
function EventBody({ ev, stepNum }) {
  switch (ev.type) {
    case 'start':
      return (
        <div className="evb-start">
          {ev.service && <div className="evb-kv"><span className="evb-key">Service</span><span className="evb-val accent">{ev.service}</span></div>}
          {ev.error_type && <div className="evb-kv"><span className="evb-key">Error</span><span className="evb-val mono red">{ev.error_type}</span></div>}
        </div>
      )
    case 'sub_agent':
      return <div className="evb-sub-action">{ev.action || 'Sub-agent launched'}</div>
    case 'reasoning':
      return (
        <div className="evb-reasoning">
          {stepNum && <div className="evb-step-badge">Step {stepNum}</div>}
          <div className="evb-reasoning-text"><Typewriter text={ev.text || ''} speed={6} /></div>
        </div>
      )
    case 'tool_call':
      return (
        <div className="evb-tool">
          <div className="evb-tool-sig">
            <span className="evb-fn-name">{ev.tool}</span>
            <span className="evb-fn-paren">(</span>
            {ev.input && <span className="evb-fn-args">{Object.keys(ev.input).join(', ')}</span>}
            <span className="evb-fn-paren">)</span>
          </div>
          {ev.input && <JsonBlock obj={ev.input} />}
        </div>
      )
    case 'tool_result':
      return (
        <div className="evb-result">
          <CodeBlock text={ev.summary ?? ''} />
          {typeof ev.summary === 'string' && ev.summary.length > 300 && (
            <div className="evb-result-size-hint">{ev.summary.length.toLocaleString()} chars</div>
          )}
        </div>
      )
    case 'cache_hit':
      return (
        <div className="evb-cache">
          <span className="evb-cache-icon">⚡</span>
          <span className="evb-cache-key">{ev.key}</span>
          <span className="evb-cached-badge">CACHED</span>
        </div>
      )
    case 'complete': {
      const conf = ev.confidence || 'medium'
      return (
        <div className="evb-complete">
          <ConfidenceGauge level={conf} />
          <div className="evb-complete-right">
            <div className="evb-complete-stats">
              {ev.iterations !== undefined && (
                <div className="evb-cstat">
                  <span className="evb-cstat-val">{ev.iterations}</span>
                  <span className="evb-cstat-lbl">iterations</span>
                </div>
              )}
              {ev.cross_service !== undefined && (
                <div className="evb-cstat">
                  <span className="evb-cstat-val">{ev.cross_service ? 'Yes' : 'No'}</span>
                  <span className="evb-cstat-lbl">cross-service</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )
    }
    case 'error':
      return <div className="evb-error"><span className="evb-error-msg">{ev.message || 'Unknown error'}</span></div>
    default: return null
  }
}

// ── Type metadata ─────────────────────────────────────────────
const TYPE_META = {
  start:       { label: 'Analysis Started',  dot: 'dot-start',     card: '',             autoOpen: true },
  sub_agent:   { label: 'Sub-Agent',         dot: 'dot-sub_agent', card: 'card-sub_agent',autoOpen: true },
  reasoning:   { label: 'Reasoning',         dot: 'dot-reasoning', card: 'card-reasoning',autoOpen: true },
  tool_call:   { label: 'Tool Call',         dot: 'dot-tool',      card: 'card-tool',     autoOpen: true },
  tool_result: { label: 'Tool Result',       dot: 'dot-result',    card: 'card-result',   autoOpen: false },
  cache_hit:   { label: 'Cache Hit',         dot: 'dot-cache',     card: '',              autoOpen: true },
  complete:    { label: 'Analysis Complete', dot: 'dot-complete',  card: 'card-complete', autoOpen: true },
  error:       { label: 'Error',             dot: 'dot-error',     card: 'card-error',    autoOpen: true },
}
const FALLBACK_META = { label: 'Event', dot: 'dot-start', card: '', autoOpen: false }

// ── Single timeline card ──────────────────────────────────────
function TLEvent({ ev, idx, startMs, stepNum, isLast, globalOpen }) {
  const meta = TYPE_META[ev.type] || FALLBACK_META
  const [open, setOpen] = useState(meta.autoOpen)

  useEffect(() => {
    if (globalOpen !== undefined) setOpen(globalOpen)
  }, [globalOpen])

  const body    = <EventBody ev={ev} stepNum={stepNum} />
  const elapsed = startMs ? ((ev._ts || Date.now()) - startMs) / 1000 : 0
  const tsStr   = `+${elapsed.toFixed(1)}s`

  return (
    <div className="tl-item" style={{ '--anim-delay': `${Math.min(idx * 20, 200)}ms` }}>
      <div className="tl-gutter">
        <div className={`tl-dot ${meta.dot}`} />
        {!isLast && <div className="tl-line" />}
      </div>
      <div className={`tl-card ${meta.card}${open ? ' tl-card-open' : ''}`}>
        <div className="tl-card-header" onClick={() => body && setOpen(v => !v)}>
          <div className="tl-header-left">
            <span className={`tl-type-label ${meta.dot}`}>{meta.label}</span>
            {ev.type === 'reasoning' && stepNum && <span className="tl-step-pill">Step {stepNum}</span>}
            {(ev.type === 'tool_call' || ev.type === 'tool_result') && ev.tool && (
              <span className="tl-tool-pill">{ev.tool}</span>
            )}
          </div>
          <div className="tl-header-right">
            <span className="tl-ts">{tsStr}</span>
            {body && <span className="tl-chevron">{open ? '▲' : '▼'}</span>}
          </div>
        </div>
        {open && body && <div className="tl-card-body">{body}</div>}
      </div>
    </div>
  )
}

// ── Iteration group ───────────────────────────────────────────
function IterationGroup({ n, events, startMs, globalOpen }) {
  const [open, setOpen] = useState(true)
  useEffect(() => {
    if (globalOpen !== undefined) setOpen(globalOpen)
  }, [globalOpen])
  const toolCalls = events.filter(e => e.type === 'tool_call').length
  return (
    <div className="iter-group">
      <div className="iter-group-header" onClick={() => setOpen(v => !v)}>
        <div className="iter-group-icon">⟳</div>
        <div className="iter-group-title">Iteration {n}</div>
        <div className="iter-group-meta">
          {toolCalls > 0 && <span className="iter-tool-count">{toolCalls} tool{toolCalls > 1 ? 's' : ''}</span>}
        </div>
        <div className="iter-group-chevron">{open ? '▲' : '▼'}</div>
      </div>
      {open && (
        <div className="iter-group-inner">
          {events.map((ev, i) => (
            <TLEvent key={i} ev={ev} idx={i} startMs={startMs}
              stepNum={ev._step} isLast={false} globalOpen={globalOpen} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Group events by iteration ─────────────────────────────────
function groupEvents(events) {
  const groups = []; let i = 0
  while (i < events.length) {
    const ev = events[i]
    if (ev.type === 'reasoning') {
      const group = { type: 'iter', n: ev._step, events: [ev] }; i++
      while (i < events.length && ['tool_call','tool_result','cache_hit'].includes(events[i].type)) {
        group.events.push(events[i++])
      }
      groups.push(group)
    } else {
      groups.push({ type: 'single', ev }); i++
    }
  }
  return groups
}

// ── Filter definitions ────────────────────────────────────────
const FILTERS = [
  { id: 'all',       label: 'All',      icon: '≡',  types: null },
  { id: 'reasoning', label: 'Reasoning',icon: '🧠', types: ['reasoning'] },
  { id: 'tools',     label: 'Tools',    icon: '🔧', types: ['tool_call','tool_result'] },
  { id: 'info',      label: 'System',   icon: 'ℹ',  types: ['start','sub_agent','cache_hit','complete','error'] },
]

// ── Main component ────────────────────────────────────────────
export default function RCAStreamPanel() {
  const { streamTarget, closeStream, showToast, incrementNewReports } = useApp()

  // Restore from session cache on open, default to empty
  const cached = streamTarget ? (_cache[streamTarget.id] || {}) : {}

  const [events,          setEvents]          = useState(cached.events     || [])
  const [status,          setStatus]          = useState(cached.status     || 'connecting')
  const [iteration,       setIteration]       = useState(cached.iteration  || 0)
  const [elapsed,         setElapsed]         = useState(cached.elapsed     || 0)
  const [filter,          setFilter]          = useState('all')
  const [globalOpen,      setGlobalOpen]      = useState(undefined)
  const [showCelebration, setShowCelebration] = useState(false)
  const [showStopAnim,    setShowStopAnim]    = useState(false)
  const prevStatusRef  = useRef(cached.status || 'connecting')
  const stoppedByUser  = useRef(false)

  const startMsRef  = useRef(cached.startMs || Date.now())
  const bottomRef   = useRef(null)
  const bodyRef     = useRef(null)
  const timerRef    = useRef(null)
  const autoScroll  = useRef(true)
  const cleanupRef  = useRef(null)

  // Lock body scroll when panel is open
  useEffect(() => {
    document.body.classList.add('rca-panel-open')
    return () => document.body.classList.remove('rca-panel-open')
  }, [])

  // Completion / stop animations on status transition
  useEffect(() => {
    if (status === 'completed' && prevStatusRef.current !== 'completed') {
      setShowCelebration(true)
      incrementNewReports()
      const t = setTimeout(() => setShowCelebration(false), 3000)
      prevStatusRef.current = 'completed'
      return () => clearTimeout(t)
    }
    if (status === 'failed' && prevStatusRef.current !== 'failed' && stoppedByUser.current) {
      setShowStopAnim(true)
      stoppedByUser.current = false
      const t = setTimeout(() => setShowStopAnim(false), 2500)
      prevStatusRef.current = 'failed'
      return () => clearTimeout(t)
    }
    prevStatusRef.current = status
  }, [status, incrementNewReports])

  // Save state to cache on every change
  useEffect(() => {
    if (streamTarget) {
      _cache[streamTarget.id] = {
        events, status, iteration, elapsed,
        startMs: startMsRef.current,
      }
    }
  }, [events, status, iteration, elapsed, streamTarget])

  // Start/restore stream
  useEffect(() => {
    if (!streamTarget) return

    const wasCached = !!(_cache[streamTarget.id]?.events?.length)
    const wasFinished = ['completed', 'failed'].includes(_cache[streamTarget.id]?.status)

    // If already finished, just show cached state — no new stream
    if (wasCached && wasFinished) {
      setEvents(_cache[streamTarget.id].events)
      setStatus(_cache[streamTarget.id].status)
      setIteration(_cache[streamTarget.id].iteration || 0)
      setElapsed(_cache[streamTarget.id].elapsed || 0)
      return
    }

    // Fresh start or resuming in-progress
    if (!wasCached) {
      setEvents([]); setStatus('connecting'); setIteration(0); setElapsed(0)
      startMsRef.current = Date.now()
    }
    autoScroll.current = true

    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startMsRef.current) / 1000))
    }, 1000)

    const cleanup = streamRCA(
      streamTarget.id,
      (ev) => {
        const { type } = ev
        if (type === 'start')    setStatus('running')
        if (type === 'reasoning') setIteration(i => i + 1)
        if (type === 'complete' || type === 'done') {
          setStatus('completed')
          clearInterval(timerRef.current)
          if (type === 'complete') showToast('RCA completed successfully', 'success')
        }
        if (type === 'error') {
          setStatus('failed')
          clearInterval(timerRef.current)
          showToast(ev.message || 'RCA failed', 'error')
        }
        // Don't add 'done' to event list (it just contains full report, noisy)
        if (type !== 'done') {
          setEvents(prev => [...prev, { ...ev, _ts: Date.now() }])
        }
      },
      () => {
        setStatus(s => (s === 'completed' || s === 'failed') ? s : 'failed')
        clearInterval(timerRef.current)
      }
    )
    cleanupRef.current = cleanup

    return () => {
      cleanup()
      clearInterval(timerRef.current)
    }
  }, [streamTarget?.id]) // eslint-disable-line

  // Auto-scroll — only within the panel body, not the page
  useEffect(() => {
    if (autoScroll.current && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [events])

  const handleClose = useCallback(() => {
    cleanupRef.current?.()
    clearInterval(timerRef.current)
    closeStream()
  }, [closeStream])

  const handleStop = useCallback(async () => {
    if (!streamTarget) return
    stoppedByUser.current = true
    try {
      await cancelRCA(streamTarget.id)
    } catch (e) {
      stoppedByUser.current = false
      showToast(e.message, 'error')
    }
  }, [streamTarget, showToast])

  // Prevent wheel events from reaching the background page
  const stopWheelPropagation = useCallback((e) => {
    e.stopPropagation()
  }, [])

  if (!streamTarget) return null

  // Stamp step numbers on reasoning events
  let stepN = 0
  const eventsWithSteps = events.map(ev =>
    ev.type === 'reasoning' ? { ...ev, _step: ++stepN } : ev
  )

  const activeFilter   = FILTERS.find(f => f.id === filter)
  const filteredEvents = activeFilter?.types
    ? eventsWithSteps.filter(ev => activeFilter.types.includes(ev.type))
    : eventsWithSteps
  const groups = groupEvents(filteredEvents)

  const counts = {
    all:       eventsWithSteps.length,
    reasoning: eventsWithSteps.filter(e => e.type === 'reasoning').length,
    tools:     eventsWithSteps.filter(e => ['tool_call','tool_result'].includes(e.type)).length,
    info:      eventsWithSteps.filter(e => ['start','sub_agent','cache_hit','complete','error'].includes(e.type)).length,
  }

  const masterPct  = status === 'completed' || status === 'failed' ? 100
    : Math.min((iteration / MAX_ITER) * 100, 98)
  const timerStr   = `${String(Math.floor(elapsed / 60)).padStart(2,'0')}:${String(elapsed % 60).padStart(2,'0')}`
  const progressCls = status === 'failed' ? 'fail' : status === 'completed' ? 'done' : ''

  return (
    <div className="rca-overlay open" onWheel={stopWheelPropagation}>
      {/* clicking backdrop closes panel */}
      <div className="rca-backdrop" onClick={handleClose} />

      <div className="rca-drawer" onWheel={stopWheelPropagation}>
        <NeuralBg active={status === 'running'} />

        {/* ── HEADER ─────────────────────────────────────────── */}
        <div className="rv2-header">
          <div className="rv2-topbar">
            <button className="rv2-back" onClick={handleClose}>←</button>
            <div className="rv2-title-block">
              <div className="rv2-brand">
                <span className="rv2-brand-icon">⚡</span>
                Root Cause Analysis Engine
              </div>
              <div className="rv2-subtitle">
                {streamTarget.service && (
                  <><span className="rv2-service">{streamTarget.service}</span><span className="rv2-dot-sep">·</span></>
                )}
                {streamTarget.errorType && (
                  <><span className="rv2-err-type">{streamTarget.errorType}</span><span className="rv2-dot-sep">·</span></>
                )}
                <span className="rv2-jobid">{streamTarget.id?.slice(0, 12)}…</span>
              </div>
            </div>
            <div className="rv2-status-area">
              <div className={`rv2-live-badge st-${status}`}>
                {status === 'running'    && <span className="rv2-live-dot" />}
                {status === 'connecting' && <span className="rv2-spinner-sm" />}
                {status === 'connecting' && 'Connecting'}
                {status === 'running'    && 'LIVE'}
                {status === 'completed'  && '✓ Complete'}
                {status === 'failed'     && '✗ Failed'}
              </div>
              <button className="rv2-close" onClick={handleClose}>✕</button>
            </div>
          </div>

          <PhaseTracker events={events} status={status} />

          <div className="rv2-stats">
            <div className="rv2-stat">
              <span className="rv2-sv">{iteration}/{MAX_ITER}</span>
              <span className="rv2-sl">iters</span>
            </div>
            <div className="rv2-divider" />
            <div className="rv2-stat">
              <span className="rv2-sv">{events.length}</span>
              <span className="rv2-sl">events</span>
            </div>
            <div className="rv2-divider" />
            <div className="rv2-stat">
              <span className="rv2-sv timer-glow">{timerStr}</span>
              <span className="rv2-sl">elapsed</span>
            </div>
            <div className="rv2-progress-wrap">
              <div className={`rv2-progress-fill ${progressCls}`} style={{ width: `${masterPct}%` }} />
            </div>
          </div>
        </div>

        {/* ── FILTER BAR ─────────────────────────────────────── */}
        {events.length > 0 && (
          <div className="rv2-filter-bar">
            {FILTERS.map(f => (
              <button key={f.id}
                className={`rv2-filter-pill${filter === f.id ? ' active' : ''}`}
                onClick={() => setFilter(f.id)}
              >
                <span className="rvf-icon">{f.icon}</span>
                {f.label}
                <span className="rvf-count">{counts[f.id]}</span>
              </button>
            ))}
            <div className="rv2-filter-spacer" />
            <button className="rv2-expand-btn"
              onClick={() => setGlobalOpen(v => v === false ? undefined : false)}
              title="Expand / Collapse all"
            >
              {globalOpen === false ? '▼ Expand' : '▲ Collapse'}
            </button>
          </div>
        )}

        {/* ── BODY (scrollable — isolated from page scroll) ──── */}
        <div
          ref={bodyRef}
          className="rv2-body"
          onScroll={e => {
            const el = e.currentTarget
            autoScroll.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 60
          }}
          onWheel={stopWheelPropagation}
        >
          {events.length === 0 && (
            <div className="rv2-empty-state">
              <div className="rv2-pulse-rings">
                <div className="rv2-ring" />
                <div className="rv2-ring rv2-ring-d1" />
                <div className="rv2-ring rv2-ring-d2" />
                <div className="rv2-core">⚡</div>
              </div>
              <div className="rv2-conn-title">Connecting to RCA Stream</div>
              <div className="rv2-conn-sub">Waiting for agent to initialize…</div>
            </div>
          )}

          {groups.length > 0 && (
            <div className="tl-root">
              {groups.map((g, gi) =>
                g.type === 'iter' ? (
                  <IterationGroup key={`iter-${g.n}-${gi}`} n={g.n}
                    events={g.events} startMs={startMsRef.current} globalOpen={globalOpen} />
                ) : (
                  <TLEvent key={gi} ev={g.ev} idx={gi} startMs={startMsRef.current}
                    stepNum={g.ev._step} isLast={gi === groups.length - 1} globalOpen={globalOpen} />
                )
              )}
            </div>
          )}

          {filteredEvents.length === 0 && events.length > 0 && (
            <div className="rv2-no-match">No {activeFilter?.label?.toLowerCase()} events yet</div>
          )}

          {status === 'completed' && events.length > 0 && (
            <div className="rv2-done-banner">
              <div className="rv2-done-glow" />
              <div className="rv2-done-icon">◆</div>
              <div className="rv2-done-title">Root Cause Identified</div>
              <div className="rv2-done-meta">{iteration} iterations · {timerStr} total</div>
              <a href={`/rca/${streamTarget.id}/report`} target="_blank" rel="noreferrer"
                className="btn success rv2-report-link" style={{ textDecoration: 'none', marginTop: 8 }}>
                📊 Open Full Report
              </a>
            </div>
          )}

          {status === 'failed' && events.length > 0 && (
            <div className="rv2-fail-banner">
              <div className="rv2-fail-icon">⊗</div>
              <div className="rv2-fail-title">Analysis Failed</div>
              <div className="rv2-fail-sub">Check API keys and GitHub token in Settings</div>
            </div>
          )}

          <div ref={bottomRef} style={{ height: 6 }} />
        </div>

        {/* ── COMPLETION CELEBRATION ────────────────────────── */}
        {showCelebration && (
          <div className="rca-complete-celebration" onClick={() => setShowCelebration(false)}>
            <div className="rca-celeb-inner">
              <div className="rca-celeb-check">
                <svg width="72" height="72" viewBox="0 0 72 72" fill="none">
                  <circle cx="36" cy="36" r="34" stroke="#10B981" strokeWidth="3" fill="rgba(16,185,129,0.12)" />
                  <path d="M20 36 L30 46 L52 26" stroke="#10B981" strokeWidth="5"
                    strokeLinecap="round" strokeLinejoin="round"
                    style={{ strokeDasharray: 50, strokeDashoffset: 0, animation: 'celebCheckDraw 0.5s ease forwards' }} />
                </svg>
              </div>
              <div className="rca-celeb-title">Root Cause Identified!</div>
              <div className="rca-celeb-sub">
                {(() => {
                  const completeEv = events.slice().reverse().find(e => e.type === 'complete')
                  const conf = completeEv?.confidence || 'N/A'
                  return `Confidence: ${conf.toUpperCase()} · ${iteration} iteration${iteration !== 1 ? 's' : ''}`
                })()}
              </div>
              <div className="rca-celeb-dismiss">Click to dismiss</div>
            </div>
          </div>
        )}

        {/* ── STOP ANIMATION ───────────────────────────────────── */}
        {showStopAnim && (
          <div
            className="rca-complete-celebration"
            style={{ background: 'rgba(10,5,5,0.92)' }}
            onClick={() => setShowStopAnim(false)}
          >
            <div className="rca-celeb-inner">
              <div className="rca-celeb-check">
                <svg width="72" height="72" viewBox="0 0 72 72" fill="none">
                  <circle cx="36" cy="36" r="34" stroke="#EF4444" strokeWidth="3" fill="rgba(239,68,68,0.1)" />
                  {/* Stop square */}
                  <rect x="22" y="22" width="28" height="28" rx="4" fill="#EF4444"
                    style={{ animation: 'celebCheckDraw 0.3s ease forwards' }} />
                </svg>
              </div>
              <div className="rca-celeb-title" style={{ color: '#FCA5A5' }}>Analysis Stopped</div>
              <div className="rca-celeb-sub">The RCA was cancelled after {iteration} iteration{iteration !== 1 ? 's' : ''}.</div>
              <div className="rca-celeb-dismiss">Click to dismiss</div>
            </div>
          </div>
        )}

        {/* ── FOOTER ─────────────────────────────────────────── */}
        <div className="rv2-footer">
          <div className="rv2-foot-left">
            <span className="rv2-foot-timer">{timerStr}</span>
            <span className="rv2-foot-iters">iter {iteration}/{MAX_ITER}</span>
          </div>
          <div className="rv2-foot-right">
            {(status === 'running' || status === 'connecting') && (
              <button
                onClick={handleStop}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  padding: '5px 14px', borderRadius: 7, fontSize: 12, fontWeight: 700,
                  fontFamily: 'inherit', cursor: 'pointer',
                  background: 'rgba(239,68,68,0.15)',
                  border: '1px solid rgba(239,68,68,0.45)',
                  color: '#FCA5A5',
                  transition: 'all 0.15s ease',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(239,68,68,0.3)'; e.currentTarget.style.color = '#fff' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(239,68,68,0.15)'; e.currentTarget.style.color = '#FCA5A5' }}
              >
                ■ Stop
              </button>
            )}
            {status === 'completed' && (
              <a href={`/rca/${streamTarget.id}/report`} target="_blank" rel="noreferrer"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  padding: '5px 14px', borderRadius: 7, fontSize: 12, fontWeight: 700,
                  background: 'rgba(16,185,129,0.15)',
                  border: '1px solid rgba(16,185,129,0.4)',
                  color: '#6EE7B7', textDecoration: 'none',
                }}>
                📊 Report
              </a>
            )}
            <button
              onClick={() => {
                autoScroll.current = true
                if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
              }}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '5px 14px', borderRadius: 7, fontSize: 12, fontWeight: 600,
                fontFamily: 'inherit', cursor: 'pointer',
                background: 'rgba(6,182,212,0.12)',
                border: '1px solid rgba(6,182,212,0.3)',
                color: '#67E8F9',
                transition: 'all 0.15s ease',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(6,182,212,0.22)'; e.currentTarget.style.color = '#fff' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(6,182,212,0.12)'; e.currentTarget.style.color = '#67E8F9' }}
            >
              ↓ Bottom
            </button>
            <button
              onClick={handleClose}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '5px 14px', borderRadius: 7, fontSize: 12, fontWeight: 600,
                fontFamily: 'inherit', cursor: 'pointer',
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.1)',
                color: '#94A3B8',
                transition: 'all 0.15s ease',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(239,68,68,0.1)'; e.currentTarget.style.borderColor = 'rgba(239,68,68,0.3)'; e.currentTarget.style.color = '#F87171' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; e.currentTarget.style.color = '#94A3B8' }}
            >
              Close ✕
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
