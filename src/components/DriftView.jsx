import { useEffect, useState } from 'react'
import { api, healthColor, fmt } from '../lib/api'

// Drift: what changed about the codebase between two snapshots.
//
// The patch shown here is a literal `git diff` between two ledger commits. That
// is the product's central claim made visible — because the analysis is stored
// as git objects, "what happened to my architecture" is answerable with the
// same tool you already use for "what happened to my code".

export function DriftView({ from, to }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!from || !to) return
    setData(null)
    setError(null)
    api.diff(from, to).then(setData).catch((e) => setError(e.message))
  }, [from, to])

  if (!from || !to) {
    return (
      <Empty>
        Select a snapshot, then ⌘-click (or shift-click) another to compare.
      </Empty>
    )
  }
  if (error) return <Empty>{error}</Empty>
  if (!data) return <Empty>Loading…</Empty>

  const dims = Object.keys(data.to?.dimensions ?? {})

  return (
    <div className="space-y-3">
      <div className="panel p-4">
        <div className="label mb-3">Health change</div>
        <div className="flex items-baseline gap-3 mb-4">
          <span className="mono text-2xl" style={{ color: healthColor(data.from?.overall) }}>
            {fmt(data.from?.overall)}
          </span>
          <span style={{ color: 'var(--dim)' }}>→</span>
          <span className="mono text-2xl" style={{ color: healthColor(data.to?.overall) }}>
            {fmt(data.to?.overall)}
          </span>
          <Delta from={data.from?.overall} to={data.to?.overall} large />
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {dims.map((name) => (
            <div key={name} className="flex items-center justify-between px-2 py-1.5 rounded" style={{ background: 'var(--panel-2)' }}>
              <span className="text-[11px] capitalize" style={{ color: 'var(--muted)' }}>{name}</span>
              <Delta from={data.from?.dimensions?.[name]?.score} to={data.to?.dimensions?.[name]?.score} />
            </div>
          ))}
        </div>
      </div>

      <div className="panel p-4">
        <div className="label mb-2">
          Analysis files changed ({data.changed.length})
        </div>
        <div className="max-h-40 overflow-auto">
          {data.changed.map((c) => (
            <div key={c.path} className="mono text-[11px] py-0.5 flex gap-2">
              <span style={{ color: c.status === 'A' ? 'var(--h-good)' : c.status === 'D' ? 'var(--h-bad)' : 'var(--dim)' }}>
                {c.status}
              </span>
              <span style={{ color: 'var(--muted)' }}>{c.path}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="panel p-4">
        <div className="label mb-2">git diff of the analysis</div>
        <pre className="mono text-[11px] leading-relaxed overflow-auto max-h-[28rem]">
          {data.patch.split('\n').map((line, i) => (
            <div key={i} className={lineClass(line)}>
              {line || ' '}
            </div>
          ))}
        </pre>
      </div>
    </div>
  )
}

function lineClass(line) {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index '))
    return 'diff-meta'
  if (line.startsWith('@@')) return 'diff-hunk'
  if (line.startsWith('+')) return 'diff-add'
  if (line.startsWith('-')) return 'diff-del'
  return ''
}

function Delta({ from, to, large }) {
  if (from == null || to == null) return <span className="mono text-[11px]" style={{ color: 'var(--dim)' }}>—</span>
  const d = to - from
  if (Math.abs(d) < 0.05) return <span className="mono text-[11px]" style={{ color: 'var(--dim)' }}>flat</span>
  return (
    <span
      className={`mono ${large ? 'text-base' : 'text-[11px]'}`}
      style={{ color: d > 0 ? 'var(--h-good)' : 'var(--h-bad)' }}
    >
      {d > 0 ? '▲ +' : '▼ '}
      {Math.abs(d).toFixed(1)}
    </span>
  )
}

const Empty = ({ children }) => (
  <div className="panel p-8 text-center text-xs" style={{ color: 'var(--dim)' }}>
    {children}
  </div>
)
