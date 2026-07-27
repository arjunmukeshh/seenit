import { useMemo, useState } from 'react'
import { useElementWidth } from '../lib/useElementWidth'

// The module graph, drawn.
//
// The data is the SCC condensation from lib/analyze/dag.js, so every cycle has
// already been collapsed into one node and the input is guaranteed acyclic —
// which is what makes layering possible at all. A cycle is drawn as a single
// box because that is what it is to anyone maintaining it: you cannot extract
// or test one member without the others, so it is one unit sitting on one
// layer.
//
// Layers read bottom to top, foundations upward. Layer 0 depends on nothing
// internal; the top layer is where entry points live. Edges therefore always
// point downward, and an arrow that appears to go up is impossible by
// construction rather than by luck.

const NODE_H = 26
const LAYER_GAP = 62
const NODE_GAP = 14
const PAD_X = 12
const CHAR_W = 6.05 // IBM Plex Mono at 11px
const MAX_LABEL = 26

// Above this many nodes a file-level graph stops being readable and starts
// being wallpaper. Folding to directories keeps the same shape at a scale a
// person can actually look at.
export const FOLD_ABOVE = 70

const label = (node) => {
  const name = node.isCycle ? `${node.members.length} files in a cycle` : node.id
  const short = name.length > MAX_LABEL ? `…${name.slice(-(MAX_LABEL - 1))}` : name
  return short
}

const nodeWidth = (node) => Math.max(64, label(node).length * CHAR_W + PAD_X * 2)

// Expand edges that span more than one layer into chains through virtual nodes.
//
// This is the step that makes a layered drawing readable. Without it, an edge
// from the CLI at layer 7 down to a leaf at layer 0 is drawn as one long curve
// straight through five layers of boxes, and a graph with a few such edges
// turns into a cat's cradle. Giving the edge a placeholder on every layer it
// crosses means it gets ordered alongside real nodes, routes around them, and
// bends where they are — the difference between a diagram and a scribble.
function withVirtualNodes(dag) {
  const layerOf = new Map(dag.nodes.map((n) => [n.id, n.layer]))
  const layers = []
  for (const node of dag.nodes) (layers[node.layer] ??= []).push({ id: node.id, node })
  for (let i = 0; i < dag.depth; i++) layers[i] ??= []

  const chains = []
  for (const { from, to } of dag.edges) {
    const top = layerOf.get(from)
    const bottom = layerOf.get(to)
    if (top === undefined || bottom === undefined) continue

    const chain = [from]
    for (let layer = top - 1; layer > bottom; layer--) {
      const id = `~${from}->${to}@${layer}`
      layers[layer].push({ id, virtual: true })
      chain.push(id)
    }
    chain.push(to)
    chains.push({ from, to, chain })
  }

  return { layers, chains }
}

// Order nodes within each layer to reduce edge crossings.
//
// The median heuristic: repeatedly place each node at the median position of
// its neighbours in the adjacent layer. A handful of sweeps gets most of the
// available improvement; optimal crossing minimisation is NP-hard and not worth
// it for a diagram someone glances at.
function orderLayers(layers, chains) {
  const down = new Map()
  const up = new Map()
  const link = (a, b) => {
    if (!down.has(a)) down.set(a, [])
    if (!up.has(b)) up.set(b, [])
    down.get(a).push(b)
    up.get(b).push(a)
  }
  // Link along the chains, so virtual nodes take part in the ordering.
  for (const { chain } of chains) {
    for (let i = 0; i < chain.length - 1; i++) link(chain[i], chain[i + 1])
  }

  const ordered = layers.map((layer) => [...layer])

  const sweep = (neighbours, referenceIndex) => {
    for (let i = 0; i < ordered.length; i++) {
      const reference = referenceIndex(i)
      if (reference < 0 || reference >= ordered.length) continue
      const position = new Map(ordered[reference].map((n, index) => [n.id, index]))
      const median = (item) => {
        const seen = (neighbours.get(item.id) ?? [])
          .map((id) => position.get(id))
          .filter((p) => p !== undefined)
          .sort((a, b) => a - b)
        if (!seen.length) return Number.POSITIVE_INFINITY // unconnected drifts to the end
        return seen[Math.floor(seen.length / 2)]
      }
      ordered[i].sort((a, b) => median(a) - median(b))
    }
  }

  for (let pass = 0; pass < 4; pass++) {
    sweep(down, (i) => i - 1)
    sweep(up, (i) => i + 1)
  }
  return ordered
}

const itemWidth = (item) => (item.virtual ? 1 : nodeWidth(item.node))

function layout(dag, width) {
  const { layers, chains } = withVirtualNodes(dag)
  const ordered = orderLayers(layers, chains)

  const placed = new Map() // real nodes, for rendering and hit-testing
  const point = new Map() // every item including virtuals, for edge routing
  let y = 12
  let maxRight = 0

  // Highest layer at the top: entry points above the things they rest on.
  for (let i = ordered.length - 1; i >= 0; i--) {
    // Wrap a wide layer onto multiple rows rather than letting it overflow.
    const rows = [[]]
    let rowWidth = 0
    for (const item of ordered[i]) {
      const w = itemWidth(item)
      if (rowWidth + w + NODE_GAP > width && rows[rows.length - 1].length) {
        rows.push([])
        rowWidth = 0
      }
      rows[rows.length - 1].push(item)
      rowWidth += w + NODE_GAP
    }

    for (const row of rows) {
      const total = row.reduce((a, item) => a + itemWidth(item) + NODE_GAP, -NODE_GAP)
      let x = Math.max(0, (width - total) / 2) // centre each row
      for (const item of row) {
        const w = itemWidth(item)
        if (item.virtual) {
          point.set(item.id, { x: x + w / 2, top: y, bottom: y + NODE_H })
        } else {
          placed.set(item.id, { node: item.node, x, y, w, h: NODE_H, layer: i })
          point.set(item.id, { x: x + w / 2, top: y, bottom: y + NODE_H })
        }
        x += w + NODE_GAP
        maxRight = Math.max(maxRight, x)
      }
      y += NODE_H + NODE_GAP
    }
    y += LAYER_GAP - NODE_GAP
  }

  // Turn each chain into the list of points its edge passes through.
  const routes = chains.map(({ from, to, chain }) => ({
    from,
    to,
    points: chain
      .map((id, index) => {
        const p = point.get(id)
        if (!p) return null
        // Leave the bottom of the source, arrive at the top of the target, pass
        // through the middle of anything between.
        if (index === 0) return { x: p.x, y: p.bottom }
        if (index === chain.length - 1) return { x: p.x, y: p.top }
        return { x: p.x, y: (p.top + p.bottom) / 2 }
      })
      .filter(Boolean),
  }))

  return { placed, routes, height: y + 8, width: Math.max(width, maxRight) }
}

// Everything reachable from a node, in both directions. Hovering answers "what
// breaks if I change this" — the transitive closure, not just the neighbours.
function reachable(startId, edges) {
  const down = new Map()
  const up = new Map()
  const push = (map, key, value) => {
    const list = map.get(key)
    if (list) list.push(value)
    else map.set(key, [value])
  }
  for (const { from, to } of edges) {
    push(down, from, to)
    push(up, to, from)
  }
  const walk = (adjacency) => {
    const seen = new Set()
    const stack = [startId]
    while (stack.length) {
      const id = stack.pop()
      for (const next of adjacency.get(id) ?? []) {
        if (seen.has(next)) continue
        seen.add(next)
        stack.push(next)
      }
    }
    return seen
  }
  return { downstream: walk(down), upstream: walk(up) }
}

export function DependencyGraph({ dag, folded, onToggleFold }) {
  const [ref, measured] = useElementWidth()
  const [hovered, setHovered] = useState(null)
  const width = Math.max(320, (measured || 0) - 2)

  const { placed, routes, height } = useMemo(() => layout(dag, width), [dag, width])
  const related = useMemo(
    () => (hovered ? reachable(hovered, dag.edges) : null),
    [hovered, dag.edges],
  )

  if (!dag.nodes.length) {
    return (
      <p className="py-10 text-[12.5px]" style={{ color: 'var(--ink-3)' }}>
        No internal module dependencies — every file stands alone.
      </p>
    )
  }

  const isDimmed = (id) =>
    related !== null && id !== hovered && !related.downstream.has(id) && !related.upstream.has(id)

  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2 mb-3">
        <Legend dag={dag} />
        <button className="btn-quiet px-2 py-1 text-[11px] ml-auto" onClick={onToggleFold}>
          {folded ? 'Show files' : 'Group by folder'}
        </button>
      </div>

      <div
        ref={ref}
        className="rounded-lg overflow-x-auto"
        style={{ background: 'var(--sunken)', border: '1px solid var(--rule)' }}
      >
        <svg width={width} height={height} style={{ display: 'block' }}>
          <g>
            {routes.map(({ from, to, points }) => (
              <Edge
                key={`${from}->${to}`}
                points={points}
                dimmed={
                  related !== null &&
                  !(from === hovered || to === hovered) &&
                  !(related.downstream.has(from) && related.downstream.has(to)) &&
                  !(related.upstream.has(from) && related.upstream.has(to))
                }
              />
            ))}
          </g>
          {[...placed.values()].map((box) => (
            <Node
              key={box.node.id}
              box={box}
              dimmed={isDimmed(box.node.id)}
              active={hovered === box.node.id}
              onEnter={() => setHovered(box.node.id)}
              onLeave={() => setHovered(null)}
            />
          ))}
        </svg>
      </div>

      {hovered && <Detail node={placed.get(hovered)?.node} related={related} />}
    </div>
  )
}

// Edges leave the bottom of a dependent and arrive at the top of a dependency,
// so direction is readable without arrowheads on a dense diagram.
//
// The path runs through every routing point the layout produced, smoothed with
// a cubic between each pair. Vertical control handles keep the curve leaving
// and entering each box straight down, which is what makes a bundle of edges
// read as parallel lines rather than as a knot.
function Edge({ points, dimmed }) {
  if (!points || points.length < 2) return null

  let d = `M ${points[0].x} ${points[0].y}`
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const mid = (a.y + b.y) / 2
    d += ` C ${a.x} ${mid}, ${b.x} ${mid}, ${b.x} ${b.y}`
  }

  return (
    <path
      d={d}
      fill="none"
      stroke="var(--ink-4)"
      strokeWidth={dimmed ? 0.6 : 1}
      strokeOpacity={dimmed ? 0.1 : 0.45}
      style={{ transition: 'stroke-opacity 140ms ease' }}
    />
  )
}

function Node({ box, dimmed, active, onEnter, onLeave }) {
  const { node, x, y, w, h } = box
  // Cycles are the only thing on this diagram that gets colour, for the same
  // reason anything else does: it is a finding, not decoration.
  const stroke = node.isCycle ? 'var(--h-bad)' : active ? 'var(--ink)' : 'var(--rule-strong)'

  return (
    <g
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{ cursor: 'default', opacity: dimmed ? 0.25 : 1, transition: 'opacity 140ms ease' }}
    >
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={6}
        fill={active ? 'var(--wash)' : 'var(--surface)'}
        stroke={stroke}
        strokeWidth={node.isCycle ? 1.5 : 1}
      />
      <text
        x={x + w / 2}
        y={y + h / 2 + 3.5}
        textAnchor="middle"
        fontSize="11"
        className="mono"
        style={{ pointerEvents: 'none', fill: node.isCycle ? 'var(--h-bad)' : 'var(--ink-2)' }}
      >
        {label(node)}
      </text>
      <title>
        {node.isCycle
          ? `Cycle · ${node.members.length} files\n${node.members.join('\n')}`
          : `${node.id}\nlayer ${node.layer} · ${node.loc} lines`}
      </title>
    </g>
  )
}

function Legend({ dag }) {
  return (
    <dl className="flex flex-wrap items-baseline gap-x-5 text-[11px]" style={{ color: 'var(--ink-4)' }}>
      <Pair label="nodes" value={dag.nodes.length} />
      <Pair label="edges" value={dag.edges.length} />
      <Pair label="depth" value={dag.depth} />
      <Pair label="cycles" value={dag.cycleCount} bad={dag.cycleCount > 0} />
    </dl>
  )
}

const Pair = ({ label: text, value, bad }) => (
  <div className="flex items-baseline gap-1.5">
    <dt>{text}</dt>
    <dd className="num" style={{ color: bad ? 'var(--h-bad)' : 'var(--ink-2)' }}>
      {value}
    </dd>
  </div>
)

// What the hover is actually telling you, in words. The diagram shows the
// blast radius; this counts it.
function Detail({ node, related }) {
  if (!node) return null
  return (
    <div className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-[11.5px]">
      <span className="mono" style={{ color: node.isCycle ? 'var(--h-bad)' : 'var(--ink)' }}>
        {node.isCycle ? `cycle of ${node.members.length}` : node.id}
      </span>
      <span style={{ color: 'var(--ink-3)' }}>
        layer <span className="num">{node.layer}</span>
      </span>
      <span style={{ color: 'var(--ink-3)' }}>
        depends on <span className="num">{related?.downstream.size ?? 0}</span> transitively
      </span>
      <span style={{ color: 'var(--ink-3)' }}>
        <span className="num">{related?.upstream.size ?? 0}</span> would be affected by a change
      </span>
      {node.isCycle && (
        <span className="mono" style={{ color: 'var(--ink-4)' }}>
          {node.members.join(' · ')}
        </span>
      )}
    </div>
  )
}
