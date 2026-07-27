import { healthColor, grade, gradeMeaning, fmt, TYPICAL } from '../lib/api'

// The health readout.
//
// Every derived score sits next to the raw metrics that produced it. A
// composite is a judgement built on thresholds and weights, and one you cannot
// trace is one nobody should trust: the raw numbers are facts, the score is an
// opinion, and the interface should keep that distinction visible rather than
// presenting a single confident figure.
//
// This replaced a stack of eight identical cards. The cards were wrong twice
// over. Visually they were the most generic thing in the product — rounded box,
// title left, number right, progress bar, 2x2 stat grid, repeated. And
// informationally they lied: `size` counts for 0.30 of the score and
// `readability` for 0.06, yet both got the same box, the same type size and the
// same share of the eye. Here the rows are ordered by weight and their figures
// are sized by it, so what dominates the score dominates the page.

const DIMENSION_DETAIL = {
  complexity: (d) => [
    ['p90 cyclomatic', d.p90Cyclomatic],
    ['p90 cognitive', d.p90Cognitive],
    ['max cyclomatic', d.maxCyclomatic],
    ['functions', d.functionCount],
  ],
  size: (d) => [
    ['p90 file lines', d.p90FileLines],
    ['p90 fn lines', d.p90FunctionLines],
    ['largest file', d.largestFile],
    ['total LOC', d.totalLoc],
  ],
  duplication: (d) => [
    ['clone pairs', d.clonePairs],
    ['duplicated', pct(d.duplicatedRatio)],
    ['files involved', d.filesInvolved],
  ],
  readability: (d) => [
    ['p90 nesting', d.p90Nesting],
    ['comment ratio', pct(d.commentRatio)],
    ['p90 line length', d.p90LineLength],
  ],
  standards: (d) => [
    ['fn naming', d.functionNaming?.style ?? '—'],
    ['adherence', d.functionNaming ? `${(d.functionNaming.adherence * 100).toFixed(0)}%` : '—'],
    ['parse errors', d.parseErrors],
  ],
  extensibility: (d) => [
    ['modules', d.modules],
    ['cycles', d.cycles],
    ['hubs', d.hubs],
    ['main-seq dist', d.meanMainSequenceDistance],
  ],
  coverage: (d) => [
    ['lines hit', d.linesHit ?? '—'],
    ['lines found', d.linesFound ?? '—'],
    ['source', d.source ?? 'none'],
  ],
}

const pct = (v) => (v != null ? `${(v * 100).toFixed(1)}%` : '—')

export function HealthPanel({ health, dimensions, previous, weights }) {
  const delta = previous?.overall != null && health != null ? health - previous.overall : null

  // Heaviest first. The order is the argument: it tells you what actually
  // moves this number before you read a single figure.
  const rows = Object.entries(dimensions ?? {}).sort(
    ([a], [b]) => (weights?.[b] ?? 0) - (weights?.[a] ?? 0),
  )
  const maxWeight = Math.max(...rows.map(([name]) => weights?.[name] ?? 0), 0.01)

  return (
    <div>
      <Overall health={health} delta={delta} />

      <div className="mt-9">
        <div className="flex items-baseline justify-between mb-1">
          <h2 className="label">Dimensions</h2>
          <span className="text-[11px]" style={{ color: 'var(--ink-4)' }}>
            ordered by weight · scale marks {TYPICAL}
          </span>
        </div>

        <div style={{ borderTop: '1px solid var(--rule)' }}>
          {rows.map(([name, dimension]) => (
            <DimensionRow
              key={name}
              name={name}
              dimension={dimension}
              previous={previous?.dimensions?.[name]?.score}
              weight={weights?.[name]}
              maxWeight={maxWeight}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

// The headline figure, given room to be the headline.
function Overall({ health, delta }) {
  return (
    <section className="pt-2">
      <h2 className="label">Overall health</h2>

      <div className="flex flex-wrap items-end gap-x-5 gap-y-3 mt-3">
        <div className="flex items-end gap-3">
          <span
            className="readout"
            style={{ fontSize: 'clamp(3.5rem, 8vw, 5.25rem)', color: healthColor(health) }}
          >
            {fmt(health)}
          </span>
          <span className="readout pb-1.5" style={{ fontSize: '1.5rem', color: 'var(--ink-3)' }}>
            {grade(health)}
          </span>
        </div>

        <div className="pb-2">
          <div className="text-[13px]" style={{ color: 'var(--ink-2)' }}>
            {gradeMeaning(health)}
          </div>
          {delta !== null && Math.abs(delta) >= 0.05 && (
            <div
              className="num text-[12px] mt-0.5"
              style={{ color: delta > 0 ? 'var(--h-good)' : 'var(--h-bad)' }}
            >
              {delta > 0 ? '↑' : '↓'} {Math.abs(delta).toFixed(1)} since last snapshot
            </div>
          )}
        </div>

        {/* The provenance note. Not a boxed "info card" — running text at the
            end of the line, where a caption belongs. */}
        <p
          className="text-[12px] leading-relaxed ml-auto max-w-[38ch] pb-1 hidden lg:block text-pretty"
          style={{ color: 'var(--ink-3)' }}
        >
          A weighted composite. Thresholds are measured per language from 1.6M functions across
          1,100 repositories, at{' '}
          <span style={{ color: 'var(--ink-2)' }}>good = p75, warn = p90</span> of real code — so 70
          is where an ordinary repository lands.
        </p>
      </div>
    </section>
  )
}

function DimensionRow({ name, dimension, previous, weight, maxWeight }) {
  const measured = dimension.score !== null && dimension.score !== undefined
  const delta = measured && previous != null ? dimension.score - previous : null
  const detail = measured ? (DIMENSION_DETAIL[name]?.(dimension) ?? []) : []

  // Weight drives type size as well as order. The range is narrow on purpose:
  // enough that the eye ranks them without the lightest dimension becoming
  // unreadable.
  const emphasis = (weight ?? 0) / maxWeight
  const scoreSize = 1.375 + emphasis * 0.5 // rem

  return (
    <article
      className="grid gap-x-5 gap-y-2 py-4 items-baseline grid-cols-[minmax(0,1fr)] md:grid-cols-[8.5rem_minmax(0,1fr)_5.5rem]"
      style={{ borderBottom: '1px solid var(--rule)' }}
    >
      <div className="flex items-baseline gap-2 md:block">
        <h3 className="text-[13.5px] capitalize" style={{ color: 'var(--ink)' }}>
          {name}
        </h3>
        {weight != null && (
          <div className="num text-[11px] md:mt-0.5" style={{ color: 'var(--ink-4)' }}>
            weight {weight.toFixed(2)}
          </div>
        )}
      </div>

      <div className="min-w-0">
        {measured ? (
          <>
            <Scale score={dimension.score} />
            <dl className="flex flex-wrap gap-x-5 gap-y-1 mt-2.5">
              {detail.map(([k, v]) => (
                <div key={k} className="flex items-baseline gap-1.5">
                  <dt className="text-[11.5px]" style={{ color: 'var(--ink-4)' }}>
                    {k}
                  </dt>
                  <dd className="num text-[11.5px]" style={{ color: 'var(--ink-2)' }}>
                    {v ?? '—'}
                  </dd>
                </div>
              ))}
            </dl>
          </>
        ) : (
          // Unmeasured says why, rather than rendering a red zero. "No report
          // found" and "nothing is covered" are different facts, and only one
          // of them is the codebase's problem.
          <p className="text-[12px] py-1" style={{ color: 'var(--ink-3)' }}>
            {dimension.reason ?? 'no data'}
          </p>
        )}
      </div>

      <div className="md:text-right">
        {measured ? (
          <>
            <span
              className="readout"
              style={{ fontSize: `${scoreSize}rem`, color: healthColor(dimension.score) }}
            >
              {fmt(dimension.score)}
            </span>
            {delta !== null && Math.abs(delta) >= 0.05 && (
              <div
                className="num text-[11px] mt-1"
                style={{ color: delta > 0 ? 'var(--h-good)' : 'var(--h-bad)' }}
              >
                {delta > 0 ? '+' : ''}
                {delta.toFixed(1)}
              </div>
            )}
          </>
        ) : (
          <span className="text-[12px]" style={{ color: 'var(--ink-4)' }}>
            not measured
          </span>
        )}
      </div>
    </article>
  )
}

// A measured scale rather than a progress bar.
//
// A bare bar answers "how full is it?", which is the wrong question — nobody
// knows what full means here. The tick at 70 turns it into a comparison: this
// is where an ordinary repository sits, and you can see at a glance which side
// of ordinary you are on.
function Scale({ score }) {
  return (
    <div className="relative h-[7px]" aria-hidden="true">
      <div className="absolute inset-x-0 top-[2.5px] h-[2px]" style={{ background: 'var(--rule)' }} />
      <div
        className="absolute left-0 top-[2.5px] h-[2px]"
        style={{ width: `${Math.max(0, Math.min(100, score))}%`, background: healthColor(score) }}
      />
      <div
        className="absolute top-0 h-[7px] w-[1px]"
        style={{ left: `${TYPICAL}%`, background: 'var(--ink-4)' }}
        title={`${TYPICAL} — typical of real code`}
      />
    </div>
  )
}
