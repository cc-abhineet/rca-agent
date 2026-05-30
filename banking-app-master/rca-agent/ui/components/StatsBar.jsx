import React, { useEffect, useState, useRef } from 'react'
import { fetchStats } from '../api/client'

function AnimatedNumber({ target }) {
  const [display, setDisplay] = useState(0)
  const prev = useRef(0)

  useEffect(() => {
    const start = prev.current
    const end = target
    prev.current = end
    if (start === end) return

    const steps = 24
    const duration = 600
    const increment = (end - start) / steps
    const interval = duration / steps
    let count = 0

    const timer = setInterval(() => {
      count++
      const next = Math.round(start + increment * count)
      setDisplay(Math.min(next, end))
      if (count >= steps) clearInterval(timer)
    }, interval)
    return () => clearInterval(timer)
  }, [target])

  return <>{display}</>
}

const CARDS = [
  { key: 'total',       label: 'Total Logs',   cls: 'total' },
  { key: 'pending',     label: 'Pending RCA',  cls: 'pending' },
  { key: 'in_progress', label: 'In Progress',  cls: 'running' },
  { key: 'completed',   label: 'Completed',    cls: 'done' },
  { key: 'failed',      label: 'Failed',       cls: 'failed' },
  { key: 'critical',    label: 'Critical',     cls: 'critical' },
]

export default function StatsBar() {
  const [stats, setStats] = useState({
    total: 0, pending: 0, in_progress: 0, completed: 0, failed: 0, critical: 0,
  })
  const [loading, setLoading] = useState(true)

  const load = () => {
    fetchStats()
      .then(s => { setStats(s); setLoading(false) })
      .catch(() => setLoading(false))
  }

  useEffect(() => {
    load()
    const id = setInterval(load, 5000)
    return () => clearInterval(id)
  }, [])

  if (loading) {
    return (
      <div className="stats-bar">
        {CARDS.map(c => (
          <div key={c.key} className="glass stat-card">
            <div className="skeleton skeleton-line short" style={{ height: 32, marginBottom: 8 }} />
            <div className="skeleton skeleton-line" style={{ height: 12, width: '60%' }} />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="stats-bar">
      {CARDS.map(c => (
        <div key={c.key} className={`glass stat-card ${c.cls}`}>
          <div className="stat-num">
            <AnimatedNumber target={stats[c.key] || 0} />
          </div>
          <div className="stat-label">{c.label}</div>
        </div>
      ))}
    </div>
  )
}
