import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchStats, getToken } from '../api/client'

function useCountUp(target, duration = 1200) {
  const [value, setValue] = useState(0)
  useEffect(() => {
    if (target === 0) { setValue(0); return }
    const steps = 40
    const step = target / steps
    const interval = duration / steps
    let current = 0
    let count = 0
    const timer = setInterval(() => {
      count++
      current = Math.min(Math.round(step * count), target)
      setValue(current)
      if (current >= target) clearInterval(timer)
    }, interval)
    return () => clearInterval(timer)
  }, [target, duration])
  return value
}

function StarCanvas() {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')

    let w = window.innerWidth
    let h = window.innerHeight
    canvas.width = w
    canvas.height = h

    const stars = Array.from({ length: 100 }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: Math.random() * 1.5 + 0.3,
      alpha: Math.random(),
      speed: Math.random() * 0.015 + 0.005,
      phase: Math.random() * Math.PI * 2,
    }))

    let animId
    let t = 0
    function draw() {
      ctx.clearRect(0, 0, w, h)
      t += 0.016
      for (const s of stars) {
        const a = (Math.sin(t * s.speed * 60 + s.phase) + 1) / 2
        ctx.beginPath()
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(180, 190, 255, ${a * 0.7 + 0.15})`
        ctx.fill()
      }
      animId = requestAnimationFrame(draw)
    }
    draw()

    const onResize = () => {
      w = window.innerWidth
      h = window.innerHeight
      canvas.width = w
      canvas.height = h
    }
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(animId)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  return <canvas ref={canvasRef} className="landing-canvas" />
}

export default function Landing() {
  const navigate = useNavigate()
  const [stats, setStats] = useState({ total: 0, completed: 0, critical: 0 })

  useEffect(() => {
    // Only fetch live stats when the user is authenticated — avoids a 401
    // redirect loop on this public landing page.
    if (!getToken()) return
    fetchStats()
      .then(s => setStats(s))
      .catch(() => {})
  }, [])

  const totalCount     = useCountUp(stats.total)
  const completedCount = useCountUp(stats.completed)
  const criticalCount  = useCountUp(stats.critical)

  return (
    <div className="landing">
      <StarCanvas />

      <div className="landing-content">
        {/* Logo */}
        <div className="landing-logo">
          <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
            <circle cx="20" cy="20" r="18" stroke="white" strokeWidth="2" strokeDasharray="4 2" opacity="0.6" />
            <circle cx="20" cy="20" r="10" fill="rgba(255,255,255,0.15)" stroke="white" strokeWidth="1.5" />
            <circle cx="20" cy="8"  r="3" fill="white" />
            <circle cx="20" cy="32" r="2" fill="rgba(255,255,255,0.5)" />
            <circle cx="8"  cy="20" r="2" fill="rgba(255,255,255,0.5)" />
            <circle cx="32" cy="20" r="2" fill="rgba(255,255,255,0.5)" />
            <circle cx="20" cy="20" r="3" fill="white" />
          </svg>
        </div>

        {/* Title */}
        <h1 className="landing-title">Apollo</h1>
        <p className="landing-subtitle">
          AI-Powered Root Cause Analysis Platform for distributed systems. Detect, analyze, and resolve incidents with autonomous intelligence.
        </p>

        {/* Live stat pills */}
        <div className="landing-stats">
          <div className="landing-stat-pill">
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span className="stat-num">{totalCount}</span>
            <span>Incidents Tracked</span>
          </div>
          <div className="landing-stat-pill">
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="stat-num">{completedCount}</span>
            <span>Analyses Complete</span>
          </div>
          <div className="landing-stat-pill">
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <span className="stat-num">{criticalCount}</span>
            <span>Critical Issues</span>
          </div>
        </div>

        {/* Feature cards */}
        <div className="landing-features">
          <div className="landing-feature-card glass">
            <div className="feature-icon indigo">
              <svg width="22" height="22" fill="none" viewBox="0 0 24 24" stroke="#6366F1" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17H3a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2h-2" />
              </svg>
            </div>
            <div className="feature-card-title">AI Analysis</div>
            <div className="feature-card-desc">Claude-powered root cause analysis with multi-step reasoning</div>
          </div>
          <div className="landing-feature-card glass">
            <div className="feature-icon cyan">
              <svg width="22" height="22" fill="none" viewBox="0 0 24 24" stroke="#06B6D4" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <div className="feature-card-title">Live Streaming</div>
            <div className="feature-card-desc">Watch the agent reason in real-time via SSE event streams</div>
          </div>
          <div className="landing-feature-card glass">
            <div className="feature-icon purple">
              <svg width="22" height="22" fill="none" viewBox="0 0 24 24" stroke="#A855F7" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
            </div>
            <div className="feature-card-title">Full Observability</div>
            <div className="feature-card-desc">Local DB and Datadog integration for log ingestion</div>
          </div>
        </div>

        {/* CTA */}
        <button className="landing-cta" onClick={() => navigate(getToken() ? '/home' : '/login')}>
          Get Started
          <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
          </svg>
        </button>
      </div>
    </div>
  )
}
