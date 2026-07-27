// Architectural guards, enforced with gitcodebase's own analysis.
//
// The tool reports dependency cycles; shipping that is worth nothing if its
// findings about its own codebase go unactioned. This suite closes the loop by
// failing the build on the conditions the tool exists to detect.
//
// The cycle this pins was real: perLanguage.js imported percentile and
// scoreAgainst from score.js while score.js imported groupByLanguage back from
// perLanguage.js. It *worked*, but only because both shared functions are
// declarations and ESM hoists those. Rewriting either as
// `const percentile = (...) => ...` — an ordinary tidy-up — would have turned it
// into "Cannot access before initialization" at import time. No existing test
// would have caught that, because nothing was broken yet.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildGraph, findCycles } from '../lib/analyze/graph.js'
import { analyzeSource } from '../lib/analyze/index.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function sourceFiles(dir, out = []) {
  for (const entry of await readdir(join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const rel = join(dir, entry.name)
    if (entry.isDirectory()) await sourceFiles(rel, out)
    else if (/\.(js|mjs|jsx)$/.test(entry.name)) out.push(rel)
  }
  return out
}

async function analyzeTree(dirs) {
  const facts = []
  for (const dir of dirs) {
    for (const path of await sourceFiles(dir)) {
      const buf = await readFile(join(ROOT, path))
      const f = await analyzeSource(path, buf)
      if (f) facts.push({ ...f, path })
    }
  }
  return facts
}

test('lib/ has no circular imports', async () => {
  const facts = await analyzeTree(['lib'])
  assert.ok(facts.length > 5, 'expected to analyze several files')

  const cycles = findCycles(buildGraph(facts))
  assert.deepEqual(
    cycles.map((c) => c.members.join(' -> ')),
    [],
    'a cycle that works today can break on an unrelated refactor — ESM hoisting is not a design',
  )
})

test('the whole shipped surface has no circular imports', async () => {
  // lib, server, mcp and bin together — a cycle spanning modules is harder to
  // see by eye than one inside a single directory.
  const facts = await analyzeTree(['lib', 'server', 'mcp', 'bin'])
  const cycles = findCycles(buildGraph(facts))
  assert.deepEqual(cycles.map((c) => c.members.join(' -> ')), [])
})

test('scale.js stays a leaf module', async () => {
  // It exists solely to break the score <-> perLanguage cycle. If it grows an
  // import back into either, the cycle returns by a different route.
  const source = await readFile(join(ROOT, 'lib/analyze/metrics/scale.js'), 'utf8')
  const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])
  assert.deepEqual(
    imports,
    ['../../canonical.js'],
    'scale.js must depend only on canonical.js, or it stops breaking the cycle',
  )
})
