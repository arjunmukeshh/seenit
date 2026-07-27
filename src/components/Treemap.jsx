import { useMemo, useState } from 'react'
import { healthColor } from '../lib/api'
import { useElementWidth } from '../lib/useElementWidth'

// Structure view: the codebase as area.
//
// Rectangle area is lines of code, fill is a per-file health proxy, so the
// shape of the repo and where its weight sits are visible at once. A squarified
// layout (Bruls et al. 2000) rather than a naive slice-and-dice, because thin
// slivers are unreadable and unclickable.
//
// Implemented directly rather than pulling in d3-hierarchy: it is ~40 lines and
// avoids a dependency in a tool whose startup time is part of the pitch.

function squarify(items, x, y, w, h) {
  const out = []
  const total = items.reduce((a, i) => a + i.value, 0)
  if (total <= 0) return out

  let remaining = [...items].sort((a, b) => b.value - a.value)
  let scale = (w * h) / total

  while (remaining.length) {
    const vertical = w >= h
    const side = vertical ? h : w
    const row = []
    let best = Infinity

    // Grow the row while the worst aspect ratio keeps improving.
    for (const item of remaining) {
      const candidate = [...row, item]
      const area = candidate.reduce((a, i) => a + i.value * scale, 0)
      const thickness = area / side
      const worst = Math.max(
        ...candidate.map((i) => {
          const length = (i.value * scale) / thickness
          return Math.max(thickness / length, length / thickness)
        }),
      )
      if (worst > best) break
      best = worst
      row.push(item)
    }

    const rowArea = row.reduce((a, i) => a + i.value * scale, 0)
    const thickness = rowArea / side
    let offset = 0
    for (const item of row) {
      const length = (item.value * scale) / thickness
      out.push(
        vertical
          ? { item, x, y: y + offset, w: thickness, h: length }
          : { item, x: x + offset, y, w: length, h: thickness },
      )
      offset += length
    }

    if (vertical) {
      x += thickness
      w -= thickness
    } else {
      y += thickness
      h -= thickness
    }
    remaining = remaining.slice(row.length)
    if (w <= 0 || h <= 0) break
  }
  return out
}

// Per-file health proxy. The ledger scores dimensions repo-wide, not per file,
// so this derives a comparable per-file signal from the metrics that do exist.
// Named as a proxy rather than presented as "the file's health" — it is not the
// same quantity as the overall score and shouldn't be read as one.
function fileScore(f) {
  const complexity = Math.max(0, 100 - f.maxCognitive * 3)
  const size = Math.max(0, 100 - Math.max(0, f.loc - 200) / 6)
  const nesting = Math.max(0, 100 - Math.max(0, f.maxNesting - 2) * 18)
  return 0.45 * complexity + 0.3 * size + 0.25 * nesting
}

export function Treemap({ files, height = 460, onSelect }) {
  const [hovered, setHovered] = useState(null)
  // Measured rather than fixed: a hardcoded width overflowed its panel on
  // anything narrower than a wide desktop.
  const [ref, measured] = useElementWidth()
  const width = Math.max(240, measured || 0)

  const cells = useMemo(() => {
    const items = (files ?? [])
      .filter((f) => f.loc > 0)
      .map((f) => ({ value: f.loc, file: f, score: fileScore(f) }))
    return squarify(items, 0, 0, width, height)
  }, [files, width, height])

  if (!files?.length) return <div className="p-8 text-center" style={{ color: 'var(--ink-4)' }}>No files.</div>

  return (
    <div className="relative" ref={ref}>
      <svg width={width} height={height} style={{ display: 'block', maxWidth: '100%' }}>
        {cells.map(({ item, x, y, w, h }) => {
          const f = item.file
          const isHovered = hovered === f.path
          return (
            <g
              key={f.path}
              onMouseEnter={() => setHovered(f.path)}
              onMouseLeave={() => setHovered(null)}
              onClick={() => onSelect?.(f.path)}
              style={{ cursor: 'pointer' }}
            >
              {/* Tinted fill with a saturated edge, rather than a solid block
                  of colour at 72% opacity.
                  Solid fills made the map read as a muddy patchwork of olive
                  and brick, and forced the labels onto a hardcoded black that
                  disappeared in dark mode. Mixing the health colour into the
                  surface keeps every cell legible in both schemes, lets the
                  label sit in plain ink, and still ranks the cells by hue. */}
              <rect
                x={x}
                y={y}
                width={Math.max(0, w - 1)}
                height={Math.max(0, h - 1)}
                style={{
                  fill: `color-mix(in srgb, ${healthColor(item.score)} ${
                    isHovered ? 46 : f.isTest ? 11 : 28
                  }%, var(--surface))`,
                  stroke: isHovered ? 'var(--ink)' : healthColor(item.score),
                  strokeWidth: isHovered ? 1.5 : 0.75,
                  strokeOpacity: isHovered ? 1 : 0.5,
                  transition: 'fill 140ms ease',
                }}
              />
              {/* Only label cells with room; unreadable text is worse than none */}
              {w > 54 && h > 20 && (
                <text
                  x={x + 6}
                  y={y + 14}
                  fontSize="9.5"
                  className="mono"
                  style={{ pointerEvents: 'none', fill: isHovered ? 'var(--ink)' : 'var(--ink-2)' }}
                >
                  {basename(f.path, Math.floor((w - 12) / 5.6))}
                </text>
              )}
            </g>
          )
        })}
      </svg>

      {hovered && <Tooltip file={files.find((f) => f.path === hovered)} />}
    </div>
  )
}

function Tooltip({ file }) {
  if (!file) return null
  return (
    <div
      className="panel absolute top-3 right-3 p-3 pointer-events-none"
      style={{ background: 'var(--surface)', boxShadow: 'var(--shadow-sm)' }}
    >
      <div className="mono text-[11px] mb-1.5">{file.path}</div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px]">
        <Stat label="lines" value={file.loc} />
        <Stat label="functions" value={file.functions} />
        <Stat label="max cognitive" value={file.maxCognitive} />
        <Stat label="max nesting" value={file.maxNesting} />
        <Stat label="exports" value={file.exports} />
        <Stat label="language" value={file.language} />
      </div>
    </div>
  )
}

const Stat = ({ label, value }) => (
  <div className="flex justify-between gap-3">
    <span style={{ color: 'var(--ink-4)' }}>{label}</span>
    <span className="mono" style={{ color: 'var(--ink-2)' }}>{value}</span>
  </div>
)

function basename(path, maxChars) {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return name.length > maxChars ? name.slice(0, Math.max(1, maxChars - 1)) + '…' : name
}
