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
    <div className="space-y-10">
      <section>
        <h2 className="label mb-3">Health change</h2>
        <div className="flex items-baseline gap-3">
          <span className="readout text-[34px]" style={{ color: healthColor(data.from?.overall) }}>
            {fmt(data.from?.overall)}
          </span>
          <span style={{ color: 'var(--ink-4)' }}>→</span>
          <span className="readout text-[34px]" style={{ color: healthColor(data.to?.overall) }}>
            {fmt(data.to?.overall)}
          </span>
          <Delta from={data.from?.overall} to={data.to?.overall} large />
        </div>

        {/* Per-dimension movement as a plain list. These were tinted chips in a
            4-up grid, which gave a dimension that did not move the same
            presence as one that did. */}
        <dl className="mt-5 grid gap-x-10 gap-y-0 sm:grid-cols-2 lg:grid-cols-3">
          {dims.map((name) => (
            <div
              key={name}
              className="flex items-baseline justify-between gap-4 py-1.5"
              style={{ borderBottom: '1px solid var(--rule)' }}
            >
              <dt className="text-[12px] capitalize" style={{ color: 'var(--ink-2)' }}>
                {name}
              </dt>
              <dd>
                <Delta
                  from={data.from?.dimensions?.[name]?.score}
                  to={data.to?.dimensions?.[name]?.score}
                />
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section>
        <h2 className="label mb-2">Analysis files changed ({data.changed.length})</h2>
        <div className="max-h-44 overflow-auto">
          {data.changed.map((c) => (
            <div key={c.path} className="mono text-[11.5px] py-0.5 flex gap-2.5">
              <span
                style={{
                  color:
                    c.status === 'A'
                      ? 'var(--h-good)'
                      : c.status === 'D'
                        ? 'var(--h-bad)'
                        : 'var(--ink-4)',
                }}
              >
                {c.status}
              </span>
              <span style={{ color: 'var(--ink-2)' }}>{c.path}</span>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="label mb-1">git diff of the analysis</h2>
        <p className="text-[12px] mb-3 max-w-[68ch]" style={{ color: 'var(--ink-3)' }}>
          A literal diff between two ledger commits — the product's central claim, visible. Because
          the analysis is stored as git objects, "what happened to my architecture" is answerable
          with the tool you already use for "what happened to my code".
        </p>
        <pre
          className="mono text-[11.5px] leading-relaxed overflow-auto max-h-[30rem] p-3 rounded-lg"
          style={{ background: 'var(--sunken)', border: '1px solid var(--rule)' }}
        >
          {data.patch.split('\n').map((line, i) => (
            <div key={i} className={lineClass(line)}>
              {line || ' '}
            </div>
          ))}
        </pre>
      </section>
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
  if (from == null || to == null) return <span className="num text-[12px]" style={{ color: 'var(--ink-4)' }}>—</span>
  const d = to - from
  if (Math.abs(d) < 0.05) return <span className="num text-[12px]" style={{ color: 'var(--ink-4)' }}>flat</span>
  return (
    <span
      className={`num ${large ? 'text-[15px]' : 'text-[12px]'}`}
      style={{ color: d > 0 ? 'var(--h-good)' : 'var(--h-bad)' }}
    >
      {d > 0 ? '▲ +' : '▼ '}
      {Math.abs(d).toFixed(1)}
    </span>
  )
}

// An empty drift view is a normal state, not a failure — it means you have not
// picked two snapshots yet. It says what to do rather than showing a blank box.
const Empty = ({ children }) => (
  <div className="py-16 text-center text-[12.5px]" style={{ color: 'var(--ink-3)' }}>
    {children}
  </div>
)
