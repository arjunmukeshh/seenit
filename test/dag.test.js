// The condensation must be a DAG. That is the whole premise of the graph view:
// cycles are collapsed into single nodes precisely so the remainder can be
// layered, and if the output ever contains a cycle the layering silently
// produces nonsense rather than failing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { condenseGraph, foldToDirectories } from '../lib/analyze/dag.js'
import { buildGraph, findCycles } from '../lib/analyze/graph.js'

// Build the node map buildGraph would produce, without going through parsing.
function graph(edges) {
  const nodes = new Map()
  const ensure = (path) => {
    if (!nodes.has(path)) {
      nodes.set(path, {
        path,
        dependencies: new Set(),
        dependents: new Set(),
        external: new Set(),
        unresolved: [],
        exports: 1,
        abstract: 0,
        concrete: 1,
        loc: 10,
      })
    }
    return nodes.get(path)
  }
  for (const [from, to] of edges) {
    ensure(from).dependencies.add(to)
    ensure(to).dependents.add(from)
  }
  return nodes
}

// Depth-first cycle check over the condensed edges.
function hasCycle({ nodes, edges }) {
  const out = new Map(nodes.map((n) => [n.id, []]))
  for (const e of edges) out.get(e.from)?.push(e.to)
  const state = new Map()
  const visit = (id) => {
    if (state.get(id) === 1) return true
    if (state.get(id) === 2) return false
    state.set(id, 1)
    for (const next of out.get(id) ?? []) if (visit(next)) return true
    state.set(id, 2)
    return false
  }
  return nodes.some((n) => visit(n.id))
}

test('condensation of an acyclic graph keeps every node separate', () => {
  const nodes = graph([
    ['a.js', 'b.js'],
    ['b.js', 'c.js'],
    ['a.js', 'c.js'],
  ])
  const dag = condenseGraph(nodes, findCycles(nodes))

  assert.equal(dag.nodes.length, 3)
  assert.equal(dag.cycleCount, 0)
  assert.equal(hasCycle(dag), false)

  // Longest path, not shortest: a -> b -> c makes c layer 0, b layer 1,
  // a layer 2, even though a also depends on c directly.
  const layerOf = new Map(dag.nodes.map((n) => [n.id, n.layer]))
  assert.equal(layerOf.get('c.js'), 0)
  assert.equal(layerOf.get('b.js'), 1)
  assert.equal(layerOf.get('a.js'), 2)
})

test('a cycle collapses into one node and the result is acyclic', () => {
  const nodes = graph([
    ['app.js', 'a.js'],
    ['a.js', 'b.js'],
    ['b.js', 'c.js'],
    ['c.js', 'a.js'], // closes a three-member cycle
    ['b.js', 'leaf.js'],
  ])
  const dag = condenseGraph(nodes, findCycles(nodes))

  assert.equal(hasCycle(dag), false, 'the condensation must always be acyclic')
  assert.equal(dag.cycleCount, 1)

  const cycle = dag.nodes.find((n) => n.isCycle)
  assert.deepEqual(cycle.members, ['a.js', 'b.js', 'c.js'])
  assert.equal(cycle.loc, 30, 'component LOC is the sum of its members')

  // The cycle sits above its own dependency and below its dependent.
  const layerOf = new Map(dag.nodes.map((n) => [n.id, n.layer]))
  assert.ok(layerOf.get(cycle.id) > layerOf.get('leaf.js'))
  assert.ok(layerOf.get('app.js') > layerOf.get(cycle.id))
})

test('two independent cycles condense independently', () => {
  const nodes = graph([
    ['a.js', 'b.js'],
    ['b.js', 'a.js'],
    ['x.js', 'y.js'],
    ['y.js', 'x.js'],
  ])
  const dag = condenseGraph(nodes, findCycles(nodes))
  assert.equal(dag.cycleCount, 2)
  assert.equal(dag.nodes.length, 2)
  assert.equal(hasCycle(dag), false)
})

test('layering terminates on a long chain without overflowing the stack', () => {
  // The recursive form of longest-path layering dies here. 20,000 links is
  // deeper than any real import chain, which is the point: the algorithm must
  // not have a depth limit that a pathological repository can find.
  const edges = []
  for (let i = 0; i < 20000; i++) edges.push([`m${i}.js`, `m${i + 1}.js`])
  const dag = condenseGraph(graph(edges), [])

  assert.equal(dag.depth, 20001)
  assert.equal(hasCycle(dag), false)
})

test('condensation is deterministic', () => {
  const edges = [
    ['a.js', 'b.js'],
    ['b.js', 'c.js'],
    ['c.js', 'b.js'],
    ['d.js', 'a.js'],
  ]
  const once = condenseGraph(graph(edges), findCycles(graph(edges)))
  const twice = condenseGraph(graph([...edges].reverse()), findCycles(graph([...edges].reverse())))
  // Same graph, different insertion order: the ledger stores this, so identical
  // structure must serialize identically or every snapshot shows a false diff.
  assert.deepEqual(JSON.stringify(once), JSON.stringify(twice))
})

test('folding to directories keeps the shape and survives folder-level cycles', () => {
  // lib/a imports app/b and app/c imports lib/d: no file-level cycle, but the
  // two folders now point at each other. Folding must not hang or throw.
  const nodes = graph([
    ['lib/a.js', 'app/b.js'],
    ['app/c.js', 'lib/d.js'],
  ])
  const folded = foldToDirectories(condenseGraph(nodes, findCycles(nodes)), 1)

  assert.equal(folded.folded, true)
  assert.deepEqual(folded.nodes.map((n) => n.id).sort(), ['app', 'lib'])
  assert.ok(folded.nodes.every((n) => Number.isInteger(n.layer)))
})

test('folding groups by directory, never by file', () => {
  // The filename has to be dropped before the depth cap. Capping the whole
  // path left `lib/watch.js` as its own "folder", so the folded view rendered
  // file names and looked like it had not folded at all.
  const nodes = graph([
    ['bin/cli.mjs', 'lib/watch.js'],
    ['lib/watch.js', 'lib/analyze/metrics/score.js'],
    ['lib/analyze/metrics/score.js', 'lib/analyze/scale.js'],
    ['bin/cli.mjs', 'root.js'],
  ])
  const folded = foldToDirectories(condenseGraph(nodes, findCycles(nodes)), 2)

  assert.deepEqual(
    folded.nodes.map((n) => n.id).sort(),
    ['(root)', 'bin', 'lib', 'lib/analyze'],
    'every id must be a directory, and a bare filename becomes (root)',
  )
  assert.ok(
    folded.nodes.every((n) => !n.id.endsWith('.js') && !n.id.endsWith('.mjs')),
    'no folded node may be named after a file',
  )

  // lib/analyze/metrics/score.js caps at two segments, so it lands in
  // lib/analyze alongside lib/analyze/scale.js.
  const analyze = folded.nodes.find((n) => n.id === 'lib/analyze')
  assert.deepEqual(analyze.members, ['lib/analyze/metrics/score.js', 'lib/analyze/scale.js'])
})

test('the real codebase condenses to an acyclic graph', async () => {
  const { readdir, readFile } = await import('node:fs/promises')
  const { join, dirname, resolve } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const { analyzeSource } = await import('../lib/analyze/index.js')

  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const files = async (dir, out = []) => {
    for (const entry of await readdir(join(ROOT, dir), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const rel = join(dir, entry.name)
      if (entry.isDirectory()) await files(rel, out)
      else if (/\.(js|mjs|jsx)$/.test(entry.name)) out.push(rel)
    }
    return out
  }

  const facts = []
  for (const path of await files('lib')) {
    const f = await analyzeSource(path, await readFile(join(ROOT, path)))
    if (f) facts.push({ ...f, path })
  }

  const nodes = buildGraph(facts)
  const dag = condenseGraph(nodes, findCycles(nodes))
  assert.ok(dag.nodes.length > 5)
  assert.equal(hasCycle(dag), false)
})
