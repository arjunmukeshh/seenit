import { healthColor, fmt } from '../lib/api'

// The commit rail — the spine of the observatory.
//
// Drawn as SVG rather than assembled from divs because the rail is a graph:
// the connecting line, the health-scaled nodes and the delta ticks need to
// align on a shared coordinate system. It reads like `git log --graph`, which
// is the point: this is the *time* axis of the codebase.
//
// Each node encodes two things at once — fill colour is the health score, and
// radius is the size of the change — so a run of small green dots followed by
// one large amber one is legible at a glance as "steady, then something big
// and worse happened here".

const ROW = 34
const RAIL_X = 26

// Column offsets from the rail. The subject column is dropped entirely when
// there isn't room for it — SVG text does not reflow, so a narrow pane would
// otherwise render commit messages overlapping the scores.
const COL = { sha: 18, health: 78, delta: 118, subject: 166 }
const SUBJECT_MIN_WIDTH = 300

export function CommitRail({ snapshots, selected, compareWith, onSelect, onCompare, width = 430 }) {
  if (!snapshots?.length) {
    return (
      <div className="p-6 text-center" style={{ color: 'var(--muted)' }}>
        <p className="mb-2">No snapshots yet.</p>
        <p className="mono text-xs" style={{ color: 'var(--dim)' }}>
          gitcodebase backfill
        </p>
      </div>
    )
  }

  // Oldest at the bottom, like git log — newest first in the array, so render
  // in order and the rail reads downward through time.
  const rows = snapshots
  const height = rows.length * ROW + 16

  // Node radius scales with churn (files changed), clamped so a huge commit
  // cannot swallow the rail.
  const maxFiles = Math.max(...rows.map((s) => s.files ?? 0), 1)
  const radiusFor = (s) => 3.5 + 3 * Math.sqrt((s.files ?? 0) / maxFiles)

  const showSubject = width >= SUBJECT_MIN_WIDTH
  // ~5.6px per character at this font size; leave a small right margin.
  const subjectChars = Math.max(8, Math.floor((width - RAIL_X - COL.subject - 12) / 5.6))

  return (
    <svg width="100%" height={height} style={{ display: 'block' }}>
      {/* The rail itself, drawn behind the nodes */}
      <line
        x1={RAIL_X}
        y1={12}
        x2={RAIL_X}
        y2={rows.length * ROW - ROW / 2 + 4}
        stroke="var(--border)"
        strokeWidth="2"
      />

      {rows.map((s, i) => {
        const y = i * ROW + 16
        const previous = rows[i + 1] // next in array is older
        const delta = previous?.health != null && s.health != null ? s.health - previous.health : null
        const isSelected = s.sha === selected
        const isCompare = s.sha === compareWith
        const color = healthColor(s.health)

        return (
          <g
            key={s.sha}
            onClick={(e) => (e.metaKey || e.shiftKey ? onCompare?.(s.sha) : onSelect?.(s.sha))}
            style={{ cursor: 'pointer' }}
          >
            {/* Hit area and selection highlight span the full row */}
            <rect
              x={0}
              y={y - ROW / 2}
              width="100%"
              height={ROW}
              fill={isSelected ? 'rgba(110,168,254,0.10)' : isCompare ? 'rgba(110,168,254,0.05)' : 'transparent'}
            />
            {(isSelected || isCompare) && (
              <rect x={0} y={y - ROW / 2} width={2} height={ROW} fill="var(--accent)" opacity={isSelected ? 1 : 0.5} />
            )}

            <circle cx={RAIL_X} cy={y} r={radiusFor(s)} fill={color} />
            {isSelected && <circle cx={RAIL_X} cy={y} r={radiusFor(s) + 4} fill="none" stroke={color} strokeWidth="1.5" opacity="0.6" />}

            <text x={RAIL_X + COL.sha} y={y + 4} className="mono" fontSize="11" fill="var(--dim)">
              {s.sourceCommit.slice(0, 7)}
            </text>

            <text x={RAIL_X + COL.health} y={y + 4} className="mono" fontSize="11.5" fill={color} fontWeight="600">
              {fmt(s.health)}
            </text>

            {delta !== null && Math.abs(delta) >= 0.05 && (
              <text
                x={RAIL_X + COL.delta}
                y={y + 4}
                className="mono"
                fontSize="10"
                fill={delta > 0 ? 'var(--h-good)' : 'var(--h-bad)'}
              >
                {delta > 0 ? '▲' : '▼'}
                {Math.abs(delta).toFixed(1)}
              </text>
            )}

            {showSubject && (
              <text x={RAIL_X + COL.subject} y={y + 4} fontSize="11.5" fill="var(--muted)">
                {truncate(s.subject?.replace(/^snapshot: \w+ /, '') ?? '', subjectChars)}
              </text>
            )}

            {/* Without room for the subject the row would be unidentifiable, so
                the full message becomes a native tooltip instead. */}
            <title>{`${s.sourceCommit.slice(0, 7)} · health ${fmt(s.health)}\n${s.subject ?? ''}`}</title>
          </g>
        )
      })}
    </svg>
  )
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
