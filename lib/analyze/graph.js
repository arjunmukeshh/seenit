// Module graph and extensibility metrics.
//
// "Extensibility" is easy to hand-wave about, so everything here is a concrete,
// citable measurement rather than a vibe:
//
//   * Martin metrics — instability I = Ce/(Ca+Ce), abstractness A, and distance
//     from the main sequence D = |A + I - 1|. Modules far off the main sequence
//     are either rigid (concrete and depended upon: painful to change) or
//     useless (abstract and depended on by nobody).
//   * Dependency cycles (Tarjan SCC) — the clearest structural blocker to
//     extending or extracting anything.
//   * Hub risk — high fan-in AND high fan-out means a module both knows
//     everything and is known by everything.
//
// Change coupling (files that always change together) is mined separately in
// coupling.js from git history, and catches hidden coupling that imports miss.

import { round, sortedBy } from '../canonical.js'
import { scoreAgainst } from './metrics/score.js'

const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs']

// Resolve an import specifier to a path in the analyzed file set. Bare
// specifiers ("react") are external and excluded from the internal graph.
function resolveImport(fromPath, spec, fileSet) {
  if (!spec.startsWith('.')) return null // external package

  const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : ''
  const parts = (fromDir ? fromDir + '/' : '') + spec
  const stack = []
  for (const seg of parts.split('/')) {
    if (seg === '.' || seg === '') continue
    if (seg === '..') stack.pop()
    else stack.push(seg)
  }
  const base = stack.join('/')

  if (fileSet.has(base)) return base
  for (const ext of SOURCE_EXTS) {
    if (fileSet.has(base + ext)) return base + ext
  }
  for (const ext of SOURCE_EXTS) {
    if (fileSet.has(`${base}/index${ext}`)) return `${base}/index${ext}`
  }
  return null // unresolved: probably an asset, alias, or path-mapped import
}

export function buildGraph(facts) {
  const fileSet = new Set(facts.map((f) => f.path))
  const nodes = new Map()
  for (const f of facts) {
    nodes.set(f.path, {
      path: f.path,
      dependencies: new Set(),
      dependents: new Set(),
      external: new Set(),
      unresolved: [],
      exports: f.exports.length,
      abstract: f.abstractDeclarations ?? 0,
      concrete: f.functions.length + f.classes.length - (f.abstractDeclarations ?? 0),
      loc: f.loc,
    })
  }

  for (const f of facts) {
    const node = nodes.get(f.path)
    for (const spec of f.imports) {
      if (!spec.startsWith('.')) {
        node.external.add(spec.split('/')[0].replace(/^@[^/]+\//, (m) => m))
        continue
      }
      const target = resolveImport(f.path, spec, fileSet)
      if (target && target !== f.path) {
        node.dependencies.add(target)
        nodes.get(target).dependents.add(f.path)
      } else if (!target) {
        node.unresolved.push(spec)
      }
    }
  }
  return nodes
}

// Tarjan's strongly-connected components. Any SCC with more than one member is
// a dependency cycle. Iterative rather than recursive — a deep graph would blow
// the JS stack on a large repo.
// Deliberately left as one function, against the tool's own reading of it
// (cyclomatic 13, cognitive 49 — the highest in the codebase).
//
// This is Tarjan's SCC algorithm, made iterative because the recursive form
// blows the stack on real dependency graphs. Its difficulty is in the algorithm,
// not the formatting: `index`, `low`, `stack` and `onStack` are one coupled
// state machine, and splitting the enter/descend/settle phases into separate
// functions would mean passing that state around and would make it *harder* to
// check against the published algorithm, which is the only way anyone verifies
// this is correct.
//
// Recorded here because "the tool flagged it and we ignored it" should be a
// visible decision with a reason, not silence. The calibration is what licenses
// the decision: complexity measured IRR 1.029, below the 1.10 action floor, so
// it is advisory. A threshold that cannot be argued with is a threshold that
// gets gamed instead.
export function findCycles(nodes) {
  let index = 0
  const meta = new Map()
  const stack = []
  const onStack = new Set()
  const cycles = []

  for (const start of nodes.keys()) {
    if (meta.has(start)) continue
    const work = [{ v: start, iter: null }]

    while (work.length) {
      const frame = work[work.length - 1]
      const v = frame.v

      if (frame.iter === null) {
        meta.set(v, { index, low: index })
        index++
        stack.push(v)
        onStack.add(v)
        frame.iter = [...nodes.get(v).dependencies][Symbol.iterator]()
      }

      const next = frame.iter.next()
      if (!next.done) {
        const w = next.value
        if (!nodes.has(w)) continue
        if (!meta.has(w)) {
          work.push({ v: w, iter: null })
        } else if (onStack.has(w)) {
          const m = meta.get(v)
          m.low = Math.min(m.low, meta.get(w).index)
        }
        continue
      }

      // Done with v's edges — pop and settle.
      work.pop()
      const m = meta.get(v)
      if (work.length) {
        const parent = meta.get(work[work.length - 1].v)
        parent.low = Math.min(parent.low, m.low)
      }
      if (m.low === m.index) {
        const component = []
        let w
        do {
          w = stack.pop()
          onStack.delete(w)
          component.push(w)
        } while (w !== v)
        if (component.length > 1) cycles.push(component.sort())
      }
    }
  }
  return sortedBy(cycles.map((c) => ({ size: c.length, members: c })), 'size').reverse()
}

export function scoreExtensibility(facts) {
  const nodes = buildGraph(facts)
  if (!nodes.size) return { score: 100, cycles: 0, modules: 0 }

  const cycles = findCycles(nodes)
  const inCycle = new Set(cycles.flatMap((c) => c.members))

  const modules = []
  for (const n of nodes.values()) {
    const ca = n.dependents.size // afferent: who depends on me
    const ce = n.dependencies.size // efferent: who I depend on
    const total = ca + ce
    const instability = total === 0 ? 0 : ce / total
    const decls = n.abstract + Math.max(0, n.concrete)
    const abstractness = decls === 0 ? 0 : n.abstract / decls
    modules.push({
      path: n.path,
      fanIn: ca,
      fanOut: ce,
      instability: round(instability),
      abstractness: round(abstractness),
      // Distance from the main sequence. 0 is ideal, 1 is maximally misplaced.
      distance: round(Math.abs(abstractness + instability - 1)),
      inCycle: inCycle.has(n.path),
      loc: n.loc,
    })
  }

  // Hubs: depended on by many AND depending on many. These are the modules that
  // make a codebase resist change, because touching them touches everything.
  const hubs = modules.filter((m) => m.fanIn >= 5 && m.fanOut >= 5)

  const meanDistance = modules.reduce((a, m) => a + m.distance, 0) / modules.length
  const cycleRatio = inCycle.size / nodes.size

  // Weighting: cycles are the hardest blocker, so they dominate. Distance from
  // the main sequence is a softer, more advisory signal.
  const score = round(
    0.45 * scoreAgainst(cycleRatio * 100, { good: 0, warn: 5, bad: 25 }) +
      0.35 * scoreAgainst(meanDistance * 100, { good: 30, warn: 55, bad: 80 }) +
      0.2 * scoreAgainst(hubs.length, { good: 0, warn: 3, bad: 10 }),
  )

  return {
    score,
    modules: modules.length,
    cycles: cycles.length,
    filesInCycles: inCycle.size,
    meanMainSequenceDistance: round(meanDistance),
    hubs: hubs.length,
    worstCycles: cycles.slice(0, 5),
    hubModules: sortedBy(hubs, 'fanIn').reverse().slice(0, 10),
    offMainSequence: sortedBy(modules, 'distance').reverse().slice(0, 10),
    moduleMetrics: sortedBy(modules, 'path'),
  }
}
