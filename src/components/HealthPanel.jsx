import { healthColor, grade, fmt } from '../lib/api'

// The health scorecard.
//
// Every derived score is shown next to the raw metrics that produced it. This
// is deliberate: a composite score is a judgement built on thresholds and
// weights, and one you cannot trace is one nobody should trust. The raw numbers
// are facts; the score is an opinion; the UI should make that distinction
// visible rather than presenting a single confident number.

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
    ['duplicated', d.duplicatedRatio != null ? `${(d.duplicatedRatio * 100).toFixed(1)}%` : '—'],
    ['files involved', d.filesInvolved],
  ],
  readability: (d) => [
    ['p90 nesting', d.p90Nesting],
    ['comment ratio', d.commentRatio != null ? `${(d.commentRatio * 100).toFixed(1)}%` : '—'],
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

export function HealthPanel({ health, dimensions, previous, weights }) {
  const delta = previous?.overall != null && health != null ? health - previous.overall : null

  return (
    <div className="space-y-3">
      <div className="panel p-4 flex items-baseline gap-4">
        <div>
          <div className="label mb-1">Overall health</div>
          <div className="flex items-baseline gap-2">
            <span className="mono text-4xl font-semibold" style={{ color: healthColor(health) }}>
              {fmt(health)}
            </span>
            <span className="mono text-lg" style={{ color: 'var(--dim)' }}>
              {grade(health)}
            </span>
            {delta !== null && Math.abs(delta) >= 0.05 && (
              <span
                className="mono text-sm"
                style={{ color: delta > 0 ? 'var(--h-good)' : 'var(--h-bad)' }}
              >
                {delta > 0 ? '▲ +' : '▼ '}
                {Math.abs(delta).toFixed(1)}
              </span>
            )}
          </div>
        </div>
        {/* This caption previously read "thresholds that are not yet
            calibrated", which stopped being true once the study landed. A stale
            disclaimer is its own kind of inaccuracy. */}
        <p className="text-xs ml-auto max-w-sm hidden xl:block" style={{ color: 'var(--dim)' }}>
          A weighted composite. The raw metrics beside each dimension are facts; this number is a
          judgement built on them. Thresholds are measured per language from 1M+ functions across
          1,100 repositories — <span style={{ color: 'var(--muted)' }}>good = p75, warn = p90</span> of
          real code. Weights are partly measured, partly judgement.
        </p>
      </div>

      <div className="grid grid-cols-1 2xl:grid-cols-2 gap-3">
        {Object.entries(dimensions ?? {}).map(([name, d]) => (
          <DimensionCard
            key={name}
            name={name}
            dimension={d}
            previous={previous?.dimensions?.[name]?.score}
            weight={weights?.[name]}
          />
        ))}
      </div>
    </div>
  )
}

function DimensionCard({ name, dimension, previous, weight }) {
  const measured = dimension.score !== null && dimension.score !== undefined
  const delta = measured && previous != null ? dimension.score - previous : null

  return (
    <div className="panel p-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs font-medium capitalize">{name}</span>
        {weight != null && (
          <span className="mono text-[10px]" style={{ color: 'var(--dim)' }}>
            w={weight}
          </span>
        )}
        <span className="ml-auto flex items-baseline gap-1.5">
          <CardScore score={dimension.score} delta={delta} measured={measured} />
        </span>
      </div>

      {/* Unmeasured dimensions show why, rather than rendering a red zero —
          "no report found" and "nothing covered" are different facts. */}
      {measured ? (
        <CardDetail name={name} dimension={dimension} />
      ) : (
        <div className="text-[11px]" style={{ color: 'var(--dim)' }}>
          {dimension.reason ?? 'no data'}
        </div>
      )}
    </div>
  )
}

function CardScore({ score, delta, measured }) {
  if (!measured) {
    return (
      <span className="mono text-xs" style={{ color: 'var(--dim)' }}>
        not measured
      </span>
    )
  }
  return (
    <>
      <span className="mono text-lg font-semibold" style={{ color: healthColor(score) }}>
        {fmt(score)}
      </span>
      {delta !== null && Math.abs(delta) >= 0.05 && (
        <span className="mono text-[10px]" style={{ color: delta > 0 ? 'var(--h-good)' : 'var(--h-bad)' }}>
          {delta > 0 ? '+' : ''}
          {delta.toFixed(1)}
        </span>
      )}
    </>
  )
}

function CardDetail({ name, dimension }) {
  const detail = DIMENSION_DETAIL[name]?.(dimension) ?? []
  return (
    <>
      <div className="h-1 rounded-full mb-2.5 overflow-hidden" style={{ background: 'var(--panel-2)' }}>
        <div
          className="h-full rounded-full"
          style={{ width: `${dimension.score}%`, background: healthColor(dimension.score) }}
        />
      </div>
      {/* Single column until there is genuinely room for two — at narrow widths
          the label and value collided into each other. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
        {detail.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-2 text-[11px]">
            <span className="truncate" style={{ color: 'var(--dim)' }}>{k}</span>
            <span className="mono shrink-0" style={{ color: 'var(--muted)' }}>
              {v ?? '—'}
            </span>
          </div>
        ))}
      </div>
    </>
  )
}
