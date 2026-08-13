import React from 'react'

const EVAL_SUITES = [
  {
    title: 'Root Cause Accuracy',
    desc: 'Benchmark the agent\'s ability to correctly identify root causes across 50 curated incident scenarios.',
    status: 'coming_soon',
    count: 50,
  },
  {
    title: 'Tool Call Efficiency',
    desc: 'Measure how efficiently the agent selects and executes tools — fewer iterations for the same correct answer.',
    status: 'coming_soon',
    count: 30,
  },
  {
    title: 'Code Trace Quality',
    desc: 'Evaluate the quality of GitHub blame, diff, and file analysis in pinpointing the responsible commit.',
    status: 'coming_soon',
    count: 25,
  },
  {
    title: 'Chat Relevance',
    desc: 'Score the post-RCA chat responses for accuracy, relevance, and actionability given the context.',
    status: 'coming_soon',
    count: 40,
  },
  {
    title: 'Latency & Cost',
    desc: 'Track time-to-root-cause and token spend per investigation across different model configurations.',
    status: 'coming_soon',
    count: null,
  },
  {
    title: 'Regression Guard',
    desc: 'Run the full eval suite on every model change to catch capability regressions before they hit production.',
    status: 'coming_soon',
    count: null,
  },
]

export default function EvalSuitePage() {
  return (
    <div className="eval-page ap-page">
      {/* Hero */}
      <div className="eval-hero">
        <h1 className="eval-hero-title">Evaluation Suite</h1>
        <p className="eval-hero-sub">
          Systematically benchmark Apollo's RCA accuracy, tool efficiency, and chat quality against curated incident datasets.
          Run evals on model changes to catch regressions before they reach production.
        </p>
      </div>

      {/* Status banner */}
      <div style={{ background:'var(--warning-bg)', border:'1px solid var(--warning-border)', borderRadius:'var(--r-lg)', padding:'12px 18px', display:'flex', alignItems:'center', gap:12 }}>
        <span style={{ fontSize:18 }}>🚧</span>
        <div>
          <div style={{ fontWeight:700, color:'var(--warning)', fontSize:13 }}>Eval Suite — Coming Soon</div>
          <div style={{ fontSize:12, color:'var(--text-secondary)', marginTop:2 }}>
            The evaluation framework is under development. The suite cards below represent the planned eval categories.
          </div>
        </div>
      </div>

      {/* Suite cards */}
      <div className="eval-suite-grid">
        {EVAL_SUITES.map(suite => (
          <div key={suite.title} className="eval-suite-card">
            <div className="eval-suite-title">{suite.title}</div>
            <div className="eval-suite-desc">{suite.desc}</div>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
              {suite.count && (
                <span style={{ fontSize:11, color:'var(--text-muted)' }}>{suite.count} scenarios</span>
              )}
              <span className="badge badge-gray" style={{ marginLeft:'auto' }}>Coming soon</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
