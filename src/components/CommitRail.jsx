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
const RAIL_X = 24

// Column offsets from the rail. The subject column is dropped entirely when
// there isn't room for it — SVG text does not reflow, so a narrow pane would
// otherwise render commit messages overlapping the scores.
const COL = { sha: 16, health: 76, delta: 116, subject: 162 }
const SUBJECT_MIN_WIDTH = 300

export function CommitRail({ snapshots, selected, compareWith, onSelect, onCompare, width = 430 }) {
  if (!snapshots?.length) {
    return (
      <div className="p-6 text-center" style={{ color: 'var(--ink-2)' }}>
        <p className="mb-2">No snapshots yet.</p>
        <p className="mono text-xs" style={{ color: 'var(--ink-4)' }}>
          seenit backfill
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
  const radiusFor = (s) => 3 + 2.6 * Math.sqrt((s.files ?? 0) / maxFiles)

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
        stroke="var(--rule-strong)"
        strokeWidth="1"
      />

      {rows.map((s, i) => (
        <RailRow
          key={s.sha}
          snapshot={s}
          y={i * ROW + 16}
          previous={rows[i + 1]} // next in array is older
          radius={radiusFor(s)}
          isSelected={s.sha === selected}
          isCompare={s.sha === compareWith}
          showSubject={showSubject}
          subjectChars={subjectChars}
          onSelect={onSelect}
          onCompare={onCompare}
        />
      ))}
    </svg>
  )
}

// One row of the rail. Split out of the map callback, which the tool scored at
// cyclomatic 16 against a measured TSX warn of 4 — past `bad` for the language,
// and the worst single function in the codebase.
function RailRow({ snapshot: s, y, previous, radius, isSelected, isCompare, showSubject, subjectChars, onSelect, onCompare }) {
  const delta = previous?.health != null && s.health != null ? s.health - previous.health : null
  const color = healthColor(s.health)
  const sha = s.sourceCommit.slice(0, 7)

  return (
    <g
      onClick={(e) => (e.metaKey || e.shiftKey ? onCompare?.(s.sha) : onSelect?.(s.sha))}
      style={{ cursor: 'pointer' }}
    >
      <RowBackground y={y} isSelected={isSelected} isCompare={isCompare} />

      <circle cx={RAIL_X} cy={y} r={radius} fill={color} />
      {isSelected && (
        <circle cx={RAIL_X} cy={y} r={radius + 4} fill="none" stroke={color} strokeWidth="1.5" opacity="0.6" />
      )}

      <text x={RAIL_X + COL.sha} y={y + 4} className="mono" fontSize="11" fill="var(--ink-4)">
        {sha}
      </text>

      <text x={RAIL_X + COL.health} y={y + 4} className="mono" fontSize="11.5" fill={color} fontWeight="600">
        {fmt(s.health)}
      </text>

      <DeltaTick x={RAIL_X + COL.delta} y={y + 4} delta={delta} />

      {showSubject && (
        <text x={RAIL_X + COL.subject} y={y + 4} fontSize="11.5" fill="var(--ink-2)">
          {truncate(s.subject?.replace(/^snapshot: \w+ /, '') ?? '', subjectChars)}
        </text>
      )}

      {/* Without room for the subject the row would be unidentifiable, so the
          full message becomes a native tooltip instead. */}
      <title>{`${sha} · health ${fmt(s.health)}\n${s.subject ?? ''}`}</title>
    </g>
  )
}

// Hit area and selection highlight, spanning the full row.
//
// Selection lifts the row to the page surface rather than tinting it blue. The
// old hardcoded rgba(110,168,254) was both untheme-able — it did not move
// between light and dark — and a decorative hue in an interface where colour is
// supposed to mean measurement.
function RowBackground({ y, isSelected, isCompare }) {
  const fill = isSelected ? 'var(--surface)' : isCompare ? 'var(--wash)' : 'transparent'
  return (
    <>
      <rect x={0} y={y - ROW / 2} width="100%" height={ROW} fill={fill} />
      {(isSelected || isCompare) && (
        <rect x={0} y={y - ROW / 2} width={2} height={ROW} fill="var(--ink)" opacity={isSelected ? 1 : 0.35} />
      )}
    </>
  )
}

// Health change against the previous snapshot. Movements under 0.05 are noise
// and would only add visual clutter to a rail of otherwise steady commits.
function DeltaTick({ x, y, delta }) {
  if (delta === null || Math.abs(delta) < 0.05) return null
  return (
    <text x={x} y={y} className="mono" fontSize="10" fill={delta > 0 ? 'var(--h-good)' : 'var(--h-bad)'}>
      {delta > 0 ? '▲' : '▼'}
      {Math.abs(delta).toFixed(1)}
    </text>
  )
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
