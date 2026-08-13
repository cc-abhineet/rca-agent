import React, {
  useEffect, useRef, useState, useCallback, memo,
} from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { fetchLog, streamRCA, streamChat, getRCAReport } from '../api/client'
import { useApp } from '../context/AppContext'

// ─── localStorage chat persistence ───────────────────────────────────────────

const _chatKey = (id) => `apollo_chat_${id}`

function loadChatHistory(id) {
  try { return JSON.parse(localStorage.getItem(_chatKey(id)) || '[]') } catch { return [] }
}

function saveChatHistory(id, msgs) {
  try {
    // Only persist finalized messages (not mid-stream agent placeholders)
    const clean = msgs.filter(m => !m.streaming && m.text)
    localStorage.setItem(_chatKey(id), JSON.stringify(clean))
  } catch {}
}

function clearChatHistory(id) {
  try { localStorage.removeItem(_chatKey(id)) } catch {}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtTime(ts) {
  if (!ts) return '—'
  try {
    return new Date(ts + (ts.includes('Z') || ts.includes('+') ? '' : 'Z'))
      .toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch { return ts }
}

function fmtElapsed(secs) {
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

const SEV_COLOR = {
  critical: '#FCA5A5', high: '#FDBA74', medium: '#FDE047', low: '#93C5FD', error: '#FCA5A5',
}

// ─── Markdown renderer ────────────────────────────────────────────────────────
// Handles: ## h2, ### h3, - bullets, 1. ordered, **bold**, `code`, ```blocks```, ---

function renderInline(str, key) {
  const parts = String(str).split(/(\*\*[^*]+\*\*|`[^`]+`)/)
  return parts.map((p, j) => {
    if (p.startsWith('**') && p.endsWith('**'))
      return <strong key={j}>{p.slice(2, -2)}</strong>
    if (p.startsWith('`') && p.endsWith('`'))
      return <code key={j} className="ws-inline-code">{p.slice(1, -1)}</code>
    return p
  })
}

function MarkdownMsg({ text }) {
  const lines  = (text || '').split('\n')
  const output = []
  let inCode   = false, codeLang = '', codeLines = []
  let listBuf  = []      // accumulates bullet / ordered items
  let listType = null    // 'ul' | 'ol'

  function flushList() {
    if (!listBuf.length) return
    const Tag = listType === 'ol' ? 'ol' : 'ul'
    output.push(
      <Tag key={`list-${output.length}`} className={`ws-md-${listType}`}>
        {listBuf.map((item, i) => (
          <li key={i} className="ws-md-li">{renderInline(item)}</li>
        ))}
      </Tag>
    )
    listBuf = []; listType = null
  }

  lines.forEach((line, i) => {
    // ── Code fence
    if (line.startsWith('```')) {
      if (!inCode) {
        flushList()
        inCode = true; codeLang = line.slice(3).trim(); codeLines = []
      } else {
        output.push(
          <pre key={`cb-${i}`} className="ws-code-block">
            {codeLang && <span className="ws-code-lang">{codeLang}</span>}
            <code>{codeLines.join('\n')}</code>
          </pre>
        )
        inCode = false; codeLines = []; codeLang = ''
      }
      return
    }
    if (inCode) { codeLines.push(line); return }

    // ── Headings
    if (/^#{1,6}\s/.test(line)) {
      flushList()
      const lvl   = line.match(/^(#+)/)[1].length
      const label = line.replace(/^#+\s*/, '')
      const cls   = lvl === 1 ? 'ws-md-h1' : lvl === 2 ? 'ws-md-h2' : 'ws-md-h3'
      output.push(<div key={i} className={cls}>{renderInline(label)}</div>)
      return
    }

    // ── Horizontal rule
    if (/^[-_*]{3,}$/.test(line.trim())) {
      flushList()
      output.push(<hr key={i} className="ws-md-hr" />)
      return
    }

    // ── Unordered list
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.*)/)
    if (ulMatch) {
      if (listType && listType !== 'ul') flushList()
      listType = 'ul'
      listBuf.push(ulMatch[2])
      return
    }

    // ── Ordered list
    const olMatch = line.match(/^\s*\d+\.\s+(.*)/)
    if (olMatch) {
      if (listType && listType !== 'ol') flushList()
      listType = 'ol'
      listBuf.push(olMatch[1])
      return
    }

    // ── Empty line — flush list, add spacing
    if (!line.trim()) {
      flushList()
      return
    }

    // ── Normal paragraph
    flushList()
    output.push(<p key={i} className="ws-msg-para">{renderInline(line)}</p>)
  })

  flushList()
  return <div className="ws-markdown">{output}</div>
}

// ─── RCA stream display (inline in chat) ─────────────────────────────────────

const TYPE_DOT = {
  start:       'dot-start',
  reasoning:   'dot-reasoning',
  tool_call:   'dot-tool',
  tool_result: 'dot-result',
  cache_hit:   'dot-cache',
  sub_agent:   'dot-sub_agent',
  complete:    'dot-complete',
  error:       'dot-error',
}

const TYPE_LABEL = {
  start: 'Started', reasoning: 'Reasoning', tool_call: 'Tool Call',
  tool_result: 'Result', cache_hit: 'Cache Hit', sub_agent: 'Sub-Agent',
  complete: 'Complete', error: 'Error',
}

function IterBlock({ n, events }) {
  const [open, setOpen] = useState(true)
  const tools = events.filter(e => e.type === 'tool_call').length
  return (
    <div className="ws-iter-block">
      <button className="ws-iter-hdr" onClick={() => setOpen(v => !v)}>
        <span className="ws-iter-icon">⟳</span>
        <span className="ws-iter-title">Iteration {n}</span>
        {tools > 0 && <span className="ws-iter-badge">{tools} tool{tools > 1 ? 's' : ''}</span>}
        <span className="ws-iter-chev">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="ws-iter-body">
          {events.map((ev, i) => (
            <div key={i} className={`ws-tl-row dot-cls-${TYPE_DOT[ev.type] || 'dot-start'}`}>
              <div className={`ws-tl-dot ${TYPE_DOT[ev.type] || 'dot-start'}`} />
              <div className="ws-tl-content">
                <span className="ws-tl-label">{TYPE_LABEL[ev.type] || ev.type}</span>
                {ev.type === 'reasoning' && (
                  <p className="ws-tl-text">{(ev.text || '').slice(0, 220)}{(ev.text || '').length > 220 ? '…' : ''}</p>
                )}
                {ev.type === 'tool_call' && ev.tool && (
                  <p className="ws-tl-text mono">{ev.tool}({Object.keys(ev.input || {}).join(', ')})</p>
                )}
                {ev.type === 'tool_result' && (
                  <p className="ws-tl-text mono dim">{(ev.summary || '').slice(0, 180)}{(ev.summary || '').length > 180 ? '…' : ''}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function groupRCAEvents(events) {
  const groups = []; let i = 0
  while (i < events.length) {
    const ev = events[i]
    if (ev.type === 'reasoning') {
      const g = { type: 'iter', n: ev._step, events: [ev] }; i++
      while (i < events.length && ['tool_call', 'tool_result', 'cache_hit'].includes(events[i].type)) {
        g.events.push(events[i++])
      }
      groups.push(g)
    } else {
      groups.push({ type: 'single', ev }); i++
    }
  }
  return groups
}

// ─── Stored-report bubble (shown when returning to a completed incident) ───────

function RCAReportBubble({ report, errorLogId }) {
  const [collapsed, setCollapsed] = useState(false)
  const rc = report?.root_cause || {}
  const conf = rc.confidence
  const confColor = conf === 'high' ? '#10B981' : conf === 'medium' ? '#F59E0B' : '#F97316'
  const sols = report?.suggested_solutions || []
  const evidence = report?.evidence || []

  return (
    <div className="ws-rca-bubble">
      <div className="ws-rca-bub-hdr">
        <div className="ws-rca-bub-left">
          <span className="ws-rca-bub-icon">⚡</span>
          <span className="ws-rca-bub-title">Apollo Agent — Analysis Complete</span>
          <span className="ws-rca-status-badge st-completed">✓ Complete</span>
        </div>
        <div className="ws-rca-bub-right">
          <button className="ws-collapse-btn" onClick={() => setCollapsed(v => !v)}>
            {collapsed ? '▼ Show' : '▲ Hide'}
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="ws-rca-bub-body">
          {/* Summary */}
          {report?.incident_summary?.description && (
            <div className="ws-report-section">
              <div className="ws-report-sec-label">SUMMARY</div>
              <p className="ws-report-sec-text">{report.incident_summary.description}</p>
            </div>
          )}

          {/* Root cause */}
          {rc.summary && (
            <div className="ws-report-section">
              <div className="ws-report-sec-label">ROOT CAUSE</div>
              <div className="ws-report-root-cause" style={{ borderColor: confColor }}>
                <div className="ws-report-rc-summary">{rc.summary}</div>
                {rc.code_reference?.file && (
                  <div className="ws-report-rc-file">
                    📄 {rc.code_reference.file}
                    {rc.code_reference.line && `:${rc.code_reference.line}`}
                  </div>
                )}
                <span className="ws-conf-badge" style={{ color: confColor }}>
                  {conf?.toUpperCase()} confidence
                </span>
              </div>
            </div>
          )}

          {/* Evidence (first 3) */}
          {evidence.length > 0 && (
            <div className="ws-report-section">
              <div className="ws-report-sec-label">EVIDENCE</div>
              {evidence.slice(0, 3).map((ev, i) => (
                <div key={i} className="ws-report-ev-row">
                  <span className="ws-report-ev-dot">·</span>
                  <span className="ws-report-ev-text">{ev.description || String(ev)}</span>
                </div>
              ))}
            </div>
          )}

          {/* Solutions (first 3) */}
          {sols.length > 0 && (
            <div className="ws-report-section">
              <div className="ws-report-sec-label">SOLUTIONS</div>
              {sols.slice(0, 3).map((sol, i) => (
                <div key={i} className="ws-report-sol-row">
                  <span className="ws-report-sol-num">{sol.priority || i + 1}</span>
                  <span className="ws-report-sol-text">{sol.action}</span>
                </div>
              ))}
            </div>
          )}

          <div className="ws-rca-complete-strip" style={{ borderColor: confColor }}>
            <span className="ws-rca-complete-icon" style={{ color: confColor }}>◆</span>
            <span className="ws-rca-complete-txt">Root Cause Identified</span>
            <a href={getRCAReport(errorLogId)} target="_blank" rel="noreferrer" className="ws-report-link">
              📊 Full Report
            </a>
          </div>
        </div>
      )}
    </div>
  )
}

const RCAStreamBubble = memo(function RCAStreamBubble({
  events, status, iteration, elapsed, errorLogId,
}) {
  const [collapsed, setCollapsed] = useState(false)

  let stepN = 0
  const stamped = events.map(ev =>
    ev.type === 'reasoning' ? { ...ev, _step: ++stepN } : ev
  )
  const groups = groupRCAEvents(stamped)

  const completeEv = events.slice().reverse().find(e => e.type === 'complete')
  const confidence = completeEv?.confidence

  const confColor = confidence === 'high' ? '#10B981'
    : confidence === 'medium' ? '#F59E0B' : '#F97316'

  return (
    <div className="ws-rca-bubble">
      {/* Header */}
      <div className="ws-rca-bub-hdr">
        <div className="ws-rca-bub-left">
          <span className="ws-rca-bub-icon">⚡</span>
          <span className="ws-rca-bub-title">Apollo Agent — Root Cause Analysis</span>
          <span className={`ws-rca-status-badge st-${status}`}>
            {status === 'running' && <><span className="ws-live-dot" /> LIVE</>}
            {status === 'connecting' && 'Connecting…'}
            {status === 'completed' && '✓ Complete'}
            {status === 'failed' && '✗ Failed'}
          </span>
        </div>
        <div className="ws-rca-bub-right">
          <span className="ws-rca-bub-meta">{iteration} iter · {fmtElapsed(elapsed)}</span>
          <button className="ws-collapse-btn" onClick={() => setCollapsed(v => !v)}>
            {collapsed ? '▼ Show' : '▲ Hide'}
          </button>
        </div>
      </div>

      {/* Progress bar */}
      {(status === 'running' || status === 'connecting') && (
        <div className="ws-rca-progress">
          <div className="ws-rca-progress-fill" style={{ width: `${Math.min((iteration / 20) * 100, 98)}%` }} />
        </div>
      )}

      {/* Stream body */}
      {!collapsed && (
        <div className="ws-rca-bub-body">
          {events.length === 0 && (
            <div className="ws-rca-connecting">
              <span className="ws-spinner-sm" />
              <span>Connecting to RCA engine…</span>
            </div>
          )}

          {groups.map((g, gi) =>
            g.type === 'iter' ? (
              <IterBlock key={`iter-${g.n}-${gi}`} n={g.n} events={g.events} />
            ) : g.ev.type !== 'complete' && g.ev.type !== 'start' ? null : (
              <div key={gi} className={`ws-tl-row`}>
                <div className={`ws-tl-dot ${TYPE_DOT[g.ev.type] || 'dot-start'}`} />
                <span className="ws-tl-label">{TYPE_LABEL[g.ev.type] || g.ev.type}</span>
              </div>
            )
          )}

          {status === 'completed' && confidence && (
            <div className="ws-rca-complete-strip" style={{ borderColor: confColor }}>
              <span className="ws-rca-complete-icon" style={{ color: confColor }}>◆</span>
              <span className="ws-rca-complete-txt">Root Cause Identified</span>
              <span className="ws-conf-badge" style={{ color: confColor }}>
                {confidence.toUpperCase()} confidence
              </span>
              <a
                href={getRCAReport(errorLogId)}
                target="_blank" rel="noreferrer"
                className="ws-report-link"
              >
                📊 Full Report
              </a>
            </div>
          )}

          {status === 'failed' && (
            <div className="ws-rca-fail-strip">
              <span>⊗</span>
              <span>Analysis failed — check API keys and GitLab token in Settings.</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
})

// ─── Chat message bubbles ─────────────────────────────────────────────────────

function UserBubble({ text }) {
  return (
    <div className="ws-msg-row ws-msg-user">
      <div className="ws-bubble ws-bubble-user">
        <MarkdownMsg text={text} />
      </div>
    </div>
  )
}

function ToolCallChip({ tool, input }) {
  const [open, setOpen] = useState(false)
  const label = tool === 'search_code'
    ? `🔍 Searching: ${input?.query || ''}`
    : `📄 Reading: ${input?.file_path || ''}`
  return (
    <div className="ws-tool-chip">
      <button className="ws-tool-chip-btn" onClick={() => setOpen(v => !v)}>
        {label}
        <span className="ws-tool-chev">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <pre className="ws-tool-detail">{JSON.stringify(input, null, 2)}</pre>
      )}
    </div>
  )
}

function ToolResultChip({ tool, preview }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="ws-tool-result-chip">
      <button className="ws-tool-chip-btn dim" onClick={() => setOpen(v => !v)}>
        ↳ {tool} result
        <span className="ws-tool-chev">{open ? '▲' : '▼'}</span>
      </button>
      {open && <pre className="ws-tool-detail">{preview}</pre>}
    </div>
  )
}

function AgentBubble({ text, streaming, toolEvents }) {
  return (
    <div className="ws-msg-row ws-msg-agent">
      <div className="ws-agent-avatar">⚡</div>
      <div className="ws-bubble ws-bubble-agent">
        {toolEvents?.map((te, i) =>
          te.kind === 'call'
            ? <ToolCallChip key={i} tool={te.tool} input={te.input} />
            : <ToolResultChip key={i} tool={te.tool} preview={te.preview} />
        )}
        {text && <MarkdownMsg text={text} />}
        {streaming && !text && <span className="ws-typing-dot" />}
        {streaming && text && <span className="ws-cursor" />}
      </div>
    </div>
  )
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

function Sidebar({ incident, rcaStatus, iteration, elapsed, onRerun, onBack, errorLogId, width, onDragStart, isDragging }) {
  const sev      = (incident?.severity || '').toLowerCase()
  const sevColor = SEV_COLOR[sev] || '#94A3B8'
  const isRunning = rcaStatus === 'running' || rcaStatus === 'connecting'

  return (
    <aside className="ws-sidebar" style={{ width: width || 272, minWidth: width || 272, position: 'relative', transition: isDragging ? 'none' : undefined }}>

      {/* Incident card */}
      <div style={{ padding: '18px 16px 14px', borderBottom: '1px solid var(--hairline)' }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 10 }}>Incident</div>
        <div style={{
          background: 'var(--bg-2)', borderRadius: 10, padding: '12px 14px',
          borderLeft: `3px solid ${sevColor}`, position: 'relative',
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4, lineHeight: 1.3 }}>
            {incident?.service_name || '—'}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.4, marginBottom: 8, wordBreak: 'break-word' }}>
            {incident?.error_type || incident?.error_message || '—'}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {sev && (
              <span style={{
                fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 4,
                background: `${sevColor}20`, color: sevColor, textTransform: 'uppercase', letterSpacing: '.04em',
              }}>
                {incident.severity}
              </span>
            )}
            {incident?.occurred_at && (
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {fmtTime(incident.occurred_at)}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* RCA Status */}
      <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--hairline)' }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 10 }}>RCA Status</div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <div style={{ flex: 1, background: 'var(--bg-2)', borderRadius: 8, padding: '10px 12px', textAlign: 'center' }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1 }}>{iteration}</div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3, textTransform: 'uppercase', letterSpacing: '.04em' }}>iterations</div>
          </div>
          <div style={{ flex: 1, background: 'var(--bg-2)', borderRadius: 8, padding: '10px 12px', textAlign: 'center' }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{fmtElapsed(elapsed)}</div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3, textTransform: 'uppercase', letterSpacing: '.04em' }}>elapsed</div>
          </div>
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px',
          borderRadius: 8, fontSize: 12.5, fontWeight: 600,
          background: rcaStatus === 'completed' ? 'rgba(34,197,94,.1)'
            : rcaStatus === 'failed' ? 'rgba(239,68,68,.1)'
            : 'rgba(91,91,214,.1)',
          color: rcaStatus === 'completed' ? '#15803d'
            : rcaStatus === 'failed' ? '#dc2626'
            : 'var(--indigo)',
        }}>
          {isRunning && <span className="ws-live-dot" />}
          {rcaStatus === 'running'    && 'Analyzing…'}
          {rcaStatus === 'connecting' && 'Connecting…'}
          {rcaStatus === 'completed'  && '✓ Analysis complete'}
          {rcaStatus === 'failed'     && '✗ Analysis failed'}
          {rcaStatus === 'idle'       && 'Ready'}
        </div>
      </div>

      {/* Actions */}
      <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--hairline)' }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 10 }}>Actions</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <button
            className="btn"
            onClick={onRerun}
            disabled={isRunning}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '9px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600,
              background: isRunning ? 'var(--bg-2)' : 'var(--indigo-grad)',
              color: isRunning ? 'var(--text-muted)' : '#fff',
              border: 'none', cursor: isRunning ? 'not-allowed' : 'pointer',
              transition: 'opacity 0.15s',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            Re-run Analysis
          </button>
          {rcaStatus === 'completed' && (
            <a
              href={getRCAReport(errorLogId)}
              target="_blank" rel="noreferrer"
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '9px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                background: 'var(--bg-2)', color: 'var(--text-primary)',
                border: '1px solid var(--border)', textDecoration: 'none',
                transition: 'border-color 0.15s',
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3"/></svg>
              Full Report
            </a>
          )}
          <button
            className="btn"
            onClick={onBack}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '9px 14px', borderRadius: 8, fontSize: 13, fontWeight: 500,
              background: 'transparent', color: 'var(--text-muted)',
              border: '1px solid var(--border)', cursor: 'pointer',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18"/></svg>
            Dashboard
          </button>
        </div>
      </div>

      {/* Ask Apollo tips */}
      <div style={{ padding: '14px 16px' }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 10 }}>Ask Apollo</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {['What is the root cause?', 'Explain the fix', 'Show me the failing code', 'How to prevent this?'].map(q => (
            <div key={q} style={{
              fontSize: 12, color: 'var(--text-muted)', padding: '6px 10px',
              background: 'var(--bg-2)', borderRadius: 7, lineHeight: 1.3,
              fontStyle: 'italic',
            }}>
              "{q}"
            </div>
          ))}
        </div>
      </div>

      {/* Drag handle */}
      <div
        onMouseDown={onDragStart}
        style={{
          position: 'absolute', right: 0, top: 0, bottom: 0, width: 4,
          cursor: 'col-resize', zIndex: 10,
          background: isDragging ? 'var(--indigo)' : 'transparent',
          transition: 'background 0.15s',
        }}
        onMouseEnter={e => { if (!isDragging) e.currentTarget.style.background = 'var(--border)' }}
        onMouseLeave={e => { if (!isDragging) e.currentTarget.style.background = 'transparent' }}
      />
    </aside>
  )
}

// ─── Main workspace ───────────────────────────────────────────────────────────

const MAX_ITER = 20

export default function RCAWorkspace() {
  const { errorLogId } = useParams()
  const navigate       = useNavigate()
  const { activeOrg }  = useApp()

  // ── Incident
  const [incident,     setIncident]     = useState(null)
  // storedReport: set when returning to an already-completed incident (no re-run)
  const [storedReport, setStoredReport] = useState(null)

  // ── RCA stream state
  const [rcaEvents,    setRcaEvents]    = useState([])
  const [rcaStatus,    setRcaStatus]    = useState('idle')
  const [rcaIteration, setRcaIteration] = useState(0)
  const [rcaElapsed,   setRcaElapsed]   = useState(0)
  const rcaStartMs  = useRef(null)
  const rcaTimerRef = useRef(null)
  const rcaCleanup  = useRef(null)

  // ── Chat state
  // Each message: { type: 'user'|'agent', text, streaming?, toolEvents? }
  const [chatMessages, setChatMessages] = useState([])
  const [chatInput,    setChatInput]    = useState('')
  const [chatLoading,  setChatLoading]  = useState(false)
  const chatCancelRef  = useRef(null)

  // ── Refs
  const bottomRef  = useRef(null)
  const inputRef   = useRef(null)
  const hasRunOnce = useRef(false)

  // ── Sidebar resize ────────────────────────────────────────────────────────
  const [sidebarWidth, setSidebarWidth] = useState(272)
  const dragging       = useRef(false)
  const dragOrigin     = useRef({ x: 0, w: 0 })
  const [isDragging, setIsDragging]     = useState(false)

  useEffect(() => {
    const onMove = (e) => {
      if (!dragging.current) return
      const delta = e.clientX - dragOrigin.current.x
      setSidebarWidth(Math.max(200, Math.min(440, dragOrigin.current.w + delta)))
    }
    const onUp = () => {
      if (!dragging.current) return
      dragging.current = false
      setIsDragging(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [])

  const handleDragStart = useCallback((e) => {
    dragging.current = true
    dragOrigin.current = { x: e.clientX, w: sidebarWidth }
    setIsDragging(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    e.preventDefault()
  }, [sidebarWidth])

  // ── Auto-scroll
  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  useEffect(() => { scrollToBottom() }, [rcaEvents, chatMessages, scrollToBottom])

  // ── Start RCA stream
  const startStream = useCallback(() => {
    // Cancel any running stream
    rcaCleanup.current?.()
    clearInterval(rcaTimerRef.current)

    setRcaEvents([])
    setRcaStatus('connecting')
    setRcaIteration(0)
    setRcaElapsed(0)
    rcaStartMs.current = Date.now()

    rcaTimerRef.current = setInterval(() => {
      setRcaElapsed(Math.floor((Date.now() - rcaStartMs.current) / 1000))
    }, 1000)

    const cleanup = streamRCA(
      errorLogId,
      (ev) => {
        const { type } = ev
        if (type === 'start')    setRcaStatus('running')
        if (type === 'reasoning') setRcaIteration(i => i + 1)
        if (type === 'complete' || type === 'done') {
          setRcaStatus('completed')
          clearInterval(rcaTimerRef.current)
        }
        if (type === 'error') {
          setRcaStatus('failed')
          clearInterval(rcaTimerRef.current)
        }
        if (type !== 'done') {
          setRcaEvents(prev => [...prev, { ...ev, _ts: Date.now() }])
        }
      },
      () => {
        setRcaStatus(s => (s === 'completed' || s === 'failed') ? s : 'failed')
        clearInterval(rcaTimerRef.current)
      },
      activeOrg?.id ?? null,
    )
    rcaCleanup.current = cleanup
  }, [errorLogId, activeOrg])

  // ── On mount: load incident → decide what to do based on rca_status ──
  useEffect(() => {
    // Restore saved chat history immediately (before the fetch)
    const saved = loadChatHistory(errorLogId)
    if (saved.length > 0) setChatMessages(saved)

    fetchLog(errorLogId)
      .then(data => {
        setIncident(data)

        if (data.rca_status === 'completed') {
          // Already done — restore report, don't start a new RCA
          setRcaStatus('completed')
          const raw = data.rca_result
          if (raw) {
            try {
              setStoredReport(typeof raw === 'string' ? JSON.parse(raw) : raw)
            } catch {}
          }
        } else if (data.rca_status === 'in_progress') {
          // An agent is already running — join the live stream
          if (!hasRunOnce.current) { hasRunOnce.current = true; startStream() }
        } else {
          // pending / failed / unknown — start fresh
          if (!hasRunOnce.current) { hasRunOnce.current = true; startStream() }
        }
      })
      .catch(() => {
        // Network error — try streaming anyway
        if (!hasRunOnce.current) { hasRunOnce.current = true; startStream() }
      })

    return () => {
      rcaCleanup.current?.()
      clearInterval(rcaTimerRef.current)
    }
  }, [errorLogId]) // eslint-disable-line

  // ── Re-run handler — clears stored report + chat history, starts fresh
  const handleRerun = useCallback(() => {
    setStoredReport(null)
    setChatMessages([])
    clearChatHistory(errorLogId)
    hasRunOnce.current = true
    startStream()
  }, [startStream, errorLogId])

  // ── Build chat history for the API
  const buildApiMessages = useCallback((localMessages, userText) => {
    const history = localMessages
      .filter(m => (m.type === 'user' || m.type === 'agent') && m.text)
      .map(m => ({ role: m.type === 'user' ? 'user' : 'assistant', content: m.text }))
    history.push({ role: 'user', content: userText })
    return history
  }, [])

  // ── Send chat message
  const sendMessage = useCallback(() => {
    const text = chatInput.trim()
    if (!text || chatLoading) return

    setChatInput('')
    setChatMessages(prev => [...prev, { type: 'user', text }])
    setChatLoading(true)

    // Add an empty agent message (will fill via streaming)
    const agentIdx = chatMessages.length + 1
    setChatMessages(prev => [...prev, { type: 'agent', text: '', streaming: true, toolEvents: [] }])

    const apiMessages = buildApiMessages(chatMessages, text)

    let accText = ''
    const localToolEvents = []

    chatCancelRef.current = streamChat(errorLogId, apiMessages, {
      onChunk: (chunk) => {
        accText += chunk
        setChatMessages(prev => {
          const copy = [...prev]
          const last = copy[copy.length - 1]
          if (last?.type === 'agent') {
            copy[copy.length - 1] = { ...last, text: accText, toolEvents: [...localToolEvents] }
          }
          return copy
        })
      },
      onToolCall: (ev) => {
        localToolEvents.push({ kind: 'call', tool: ev.tool, input: ev.input })
        setChatMessages(prev => {
          const copy = [...prev]
          const last = copy[copy.length - 1]
          if (last?.type === 'agent') {
            copy[copy.length - 1] = { ...last, toolEvents: [...localToolEvents] }
          }
          return copy
        })
      },
      onToolResult: (ev) => {
        localToolEvents.push({ kind: 'result', tool: ev.tool, preview: ev.preview })
        setChatMessages(prev => {
          const copy = [...prev]
          const last = copy[copy.length - 1]
          if (last?.type === 'agent') {
            copy[copy.length - 1] = { ...last, toolEvents: [...localToolEvents] }
          }
          return copy
        })
      },
      onDone: () => {
        setChatLoading(false)
        setChatMessages(prev => {
          const copy = [...prev]
          const last = copy[copy.length - 1]
          if (last?.type === 'agent') {
            copy[copy.length - 1] = { ...last, streaming: false }
          }
          // Persist to localStorage now that the response is complete
          saveChatHistory(errorLogId, copy)
          return copy
        })
        setTimeout(() => inputRef.current?.focus(), 100)
      },
      onError: (err) => {
        setChatLoading(false)
        setChatMessages(prev => {
          const copy = [...prev]
          const last = copy[copy.length - 1]
          if (last?.type === 'agent') {
            copy[copy.length - 1] = {
              ...last, streaming: false,
              text: (last.text || '') + `\n\n*Error: ${err}*`,
            }
          }
          return copy
        })
      },
    }, activeOrg?.id ?? null)
  }, [chatInput, chatLoading, chatMessages, errorLogId, buildApiMessages])

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }, [sendMessage])

  const rcaDone = rcaStatus === 'completed' || rcaStatus === 'failed'

  return (
    <div className="ws-root">
      {/* ── Header ── */}
      <header className="ws-header">
        <button className="ws-header-back" onClick={() => navigate('/investigations')}>
          ← Investigations
        </button>
        <div className="ws-header-title">
          <span className="ws-header-service">{incident?.service_name || '…'}</span>
          {incident?.error_type && (
            <><span className="ws-header-sep">·</span>
            <span className="ws-header-error">{incident.error_type}</span></>
          )}
        </div>
        <div className={`ws-header-badge st-${rcaStatus}`}>
          {rcaStatus === 'running' && <span className="ws-live-dot" />}
          {rcaStatus === 'running' && 'LIVE'}
          {rcaStatus === 'connecting' && 'Connecting…'}
          {rcaStatus === 'completed' && '✓ Done'}
          {rcaStatus === 'failed' && '✗ Failed'}
          {rcaStatus === 'idle' && 'Idle'}
        </div>
      </header>

      {/* ── Body ── */}
      <div className="ws-body">
        {/* Sidebar */}
        <Sidebar
          incident={incident}
          rcaStatus={rcaStatus}
          iteration={rcaIteration}
          elapsed={rcaElapsed}
          errorLogId={errorLogId}
          onRerun={handleRerun}
          onBack={() => navigate('/investigations')}
          width={sidebarWidth}
          onDragStart={handleDragStart}
          isDragging={isDragging}
        />

        {/* ── Chat area ── */}
        <div className="ws-chat-col" style={{ background: 'linear-gradient(180deg,#F8F9FB 0%,#FFFFFF 100%)' }}>
          <div className="ws-chat-scroll">

            {/* RCA bubble — stored report (returning user) OR live stream */}
            <div className="ws-msg-row ws-msg-agent">
              <div className="ws-agent-avatar">⚡</div>
              <div className="ws-rca-bubble-wrap">
                {storedReport ? (
                  <RCAReportBubble report={storedReport} errorLogId={errorLogId} />
                ) : (
                  <RCAStreamBubble
                    events={rcaEvents}
                    status={rcaStatus}
                    iteration={rcaIteration}
                    elapsed={rcaElapsed}
                    errorLogId={errorLogId}
                  />
                )}
              </div>
            </div>

            {/* Prompt to start chatting */}
            {(rcaStatus === 'completed' || storedReport) && chatMessages.length === 0 && (
              <div style={{ padding: '16px 0' }}>
                <div className="ws-completion-prompt">
                  <div className="ws-comp-text">
                    Analysis complete — ask Apollo anything about this incident.
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                  {['What is the root cause?', 'How do I fix this?', 'Show me the failing code', 'How to prevent this?'].map(q => (
                    <button
                      key={q}
                      onClick={() => { setChatInput(q); setTimeout(() => inputRef.current?.focus(), 50) }}
                      style={{
                        background: '#fff', border: '1px solid var(--border)', borderRadius: 'var(--r-full)',
                        padding: '5px 14px', fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer',
                        transition: 'all 0.15s ease',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--indigo)'; e.currentTarget.style.color = 'var(--indigo)' }}
                      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-secondary)' }}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Chat messages */}
            {chatMessages.map((msg, i) =>
              msg.type === 'user' ? (
                <UserBubble key={i} text={msg.text} />
              ) : (
                <AgentBubble
                  key={i}
                  text={msg.text}
                  streaming={msg.streaming}
                  toolEvents={msg.toolEvents}
                />
              )
            )}

            <div ref={bottomRef} style={{ height: 8 }} />
          </div>

          {/* ── Input bar ── */}
          <div className={`ws-input-bar${!rcaDone ? ' ws-input-disabled' : ''}`}>
            {!rcaDone ? (
              <div className="ws-input-waiting">
                <span className="ws-spinner-sm" />
                <span>RCA in progress — chat available after analysis completes…</span>
              </div>
            ) : (
              <div className="ws-input-row">
                <textarea
                  ref={inputRef}
                  className="ws-input"
                  rows={1}
                  placeholder="Ask Apollo about this incident…"
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={chatLoading}
                />
                <button
                  className={`ws-send-btn${chatLoading ? ' loading' : ''}`}
                  onClick={sendMessage}
                  disabled={chatLoading || !chatInput.trim()}
                  title="Send (Enter)"
                >
                  {chatLoading
                    ? <span className="ws-spinner-sm" />
                    : <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
                      </svg>
                  }
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
