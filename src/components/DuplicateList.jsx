// Duplication findings — the product's one job, on screen.
//
// This view did not exist until the tool was re-scoped around duplication, and
// its absence was the loudest inconsistency in the product: the front page and
// the MCP server both answered "has this already been written?", while the
// observatory showed everything except the answer.
//
// Findings, not pairs. One file copied into six places produces fifteen pairs
// of the same fact, so the list would read as a wall even at high precision.

const anchorOf = (g) => g.anchor?.samples?.[0]

export function DuplicateList({ duplication }) {
  const findings = duplication?.groups ?? []

  if (!duplication) {
    return <p className="py-10 text-[12.5px]" style={{ color: 'var(--ink-3)' }}>Loading…</p>
  }

  if (!findings.length) {
    return (
      <div className="py-10">
        <p className="text-[13px]" style={{ color: 'var(--h-good)' }}>
          Nothing duplicated.
        </p>
        <p className="mt-1 text-[12px]" style={{ color: 'var(--ink-3)' }}>
          No group of files shares a long enough aligned run to count as a copy.
        </p>
      </div>
    )
  }

  return (
    <div className="pt-6">
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="label">Duplication</h2>
        <span className="text-[11px]" style={{ color: 'var(--ink-4)' }}>
          {duplication.groupCount} findings · {duplication.clonePairs} pairs ·{' '}
          {duplication.filesInvolved} files involved
        </span>
      </div>

      <p className="text-[12px] mb-5 max-w-[68ch] text-pretty" style={{ color: 'var(--ink-3)' }}>
        Identifiers, literals and comments are normalised away before matching, so a renamed and
        reformatted copy still registers. Ranked by longest aligned run — the number of matches
        that hold a constant offset between the two files, which is what separates a real copy from
        two files that merely share a shape. It is weakest on view code, where unrelated components
        share a lot of shape.
      </p>

      <div style={{ borderTop: '1px solid var(--rule)' }}>
        {findings.map((g, i) => (
          <Finding key={`${g.anchor.a}|${g.anchor.b}|${i}`} group={g} />
        ))}
      </div>
    </div>
  )
}

function Finding({ group }) {
  const at = anchorOf(group)
  const others = group.files.filter((f) => f !== group.anchor.a && f !== group.anchor.b)

  return (
    <article
      className="grid gap-x-6 gap-y-2 py-4 items-baseline grid-cols-[minmax(0,1fr)] md:grid-cols-[minmax(0,1fr)_7rem]"
      style={{ borderBottom: '1px solid var(--rule)' }}
    >
      <div className="min-w-0">
        <Location path={group.anchor.a} line={at?.aLine} />
        <Location path={group.anchor.b} line={at?.bLine} />

        {others.length > 0 && (
          // The rest of the group. Named rather than counted: "and 20 more
          // files" is a statistic, and the reader wants to know which ones.
          <details className="mt-1.5">
            <summary
              className="text-[11.5px] cursor-pointer"
              style={{ color: 'var(--ink-4)' }}
            >
              and {others.length} more file{others.length === 1 ? '' : 's'} sharing this shape
            </summary>
            <div className="mt-1.5 pl-3" style={{ borderLeft: '1px solid var(--rule)' }}>
              {others.map((f) => (
                <div key={f} className="mono text-[11.5px] py-0.5" style={{ color: 'var(--ink-3)' }}>
                  {f}
                </div>
              ))}
            </div>
          </details>
        )}
      </div>

      <div className="md:text-right">
        <div className="readout text-[19px]" style={{ color: 'var(--ink-2)' }}>
          {group.aligned}
        </div>
        <div className="text-[10.5px] mt-0.5" style={{ color: 'var(--ink-4)' }}>
          aligned
        </div>
      </div>
    </article>
  )
}

const Location = ({ path, line }) => (
  <div className="mono text-[12px] leading-relaxed" style={{ color: 'var(--ink)' }}>
    {path}
    {line != null && <span style={{ color: 'var(--ink-4)' }}>:{line}</span>}
  </div>
)
