// Orchestrator: a source commit -> a snapshot payload.
//
// Source is read from git objects (`cat-file`), never from the working tree, so
// any historical commit can be analyzed without checking it out. That is what
// makes backfilling history possible while the user keeps working.

import { listTree, readBlob, readBlobsBatch } from '../git.js'
import { parse, isAnalyzable, isTestFile, languageFor } from './parser.js'
import { extract } from './extract.js'
import { scoreComplexity, scoreSize, scoreReadability, rollup, grade, THRESHOLDS, WEIGHTS } from './metrics/score.js'
import { scoreDuplication } from './metrics/duplication.js'
import { scoreStandards } from './metrics/standards.js'
import { scoreCoverage } from './metrics/coverage.js'
import { buildGraph, findCycles, scoreExtensibility } from './graph.js'
import { analyzeCoupling, hiddenCoupling } from './coupling.js'
import { ANALYZER_VERSION } from '../ledger.js'
import { sortedBy } from '../canonical.js'
import { workspaceFiles, hashWorkingFiles, readWorkspaceSources } from '../workspace.js'

// Analyze already-read content. Cacheable by blob SHA: identical content always
// yields identical facts, which is what lets unchanged files cost nothing on
// re-scan and makes backfilling history affordable.
export async function analyzeSource(path, buf) {
  // Binary guard — a NUL in the first chunk means this isn't source.
  if (buf.subarray(0, 8000).includes(0)) return null
  const source = buf.toString('utf8')
  const parsed = await parse(path, source)
  if (!parsed) return null
  try {
    return extract(parsed.tree, source, { path, language: parsed.language })
  } finally {
    parsed.tree.delete() // WASM allocation — leaks without this
  }
}

export async function analyzeBlob(repoRoot, { sha, path }) {
  return analyzeSource(path, await readBlob(repoRoot, sha))
}

// Per-file record written to files/<path>.json. Deliberately compact: this is
// the sharded payload whose diff shows exactly which files changed, so it holds
// metrics rather than raw identifier lists.
export function fileRecord(facts) {
  const fns = facts.functions
  const worst = fns.length ? fns.reduce((a, b) => (b.cognitive > a.cognitive ? b : a)) : null
  return {
    language: facts.language,
    loc: facts.loc,
    sloc: facts.sloc,
    commentLines: facts.commentLines,
    functions: fns.length,
    classes: facts.classes.length,
    maxCyclomatic: fns.length ? Math.max(...fns.map((f) => f.cyclomatic)) : 0,
    maxCognitive: fns.length ? Math.max(...fns.map((f) => f.cognitive)) : 0,
    maxNesting: fns.length ? Math.max(...fns.map((f) => f.maxNesting)) : 0,
    worstFunction: worst ? { name: worst.name, line: worst.line, cognitive: worst.cognitive, cyclomatic: worst.cyclomatic } : null,
    imports: facts.imports,
    exports: facts.exports,
    isTest: isTestFile(facts.path),
    parseError: facts.parseError,
  }
}

// Analyze every analyzable file in a commit and assemble the snapshot payload.
// `cache` is optional and keyed by blob SHA (see lib/cache.js).
export async function analyzeCommit(repoRoot, commit, { cache, onProgress } = {}) {
  const entries = (await listTree(repoRoot, commit)).filter((e) => isAnalyzable(e.path))

  const facts = []
  let fromCache = 0
  let analyzed = 0

  // Cache first, so we only pay git I/O for content we haven't seen. Because the
  // cache is keyed by blob SHA and git dedupes by content, a file that didn't
  // change between commits is free — this is what makes history backfill viable.
  const misses = []
  for (const entry of entries) {
    const cached = cache ? await cache.get(entry.sha) : null
    if (cached) {
      facts.push({ ...cached, path: entry.path })
      fromCache++
    } else {
      misses.push(entry)
    }
  }

  // One git process for every remaining blob — see readBlobsBatch: spawning per
  // file was 75% of total runtime.
  const blobs = misses.length ? await readBlobsBatch(repoRoot, misses.map((e) => e.sha)) : new Map()
  for (const entry of misses) {
    const buf = blobs.get(entry.sha)
    if (!buf) continue
    const f = await analyzeSource(entry.path, buf)
    if (f) {
      facts.push(f)
      analyzed++
      if (cache) await cache.set(entry.sha, f)
    }
    onProgress?.({ done: fromCache + analyzed, total: entries.length })
  }

  facts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { ...(await scoreFacts(repoRoot, facts, commit)), stats: { fromCache, analyzed } }
}

// Score a set of extracted facts into a full snapshot payload. Shared by commit
// analysis and working-tree analysis so both produce byte-identical structures —
// which is what lets us diff "what the agent just did" against HEAD directly.
export async function scoreFacts(repoRoot, facts, commit) {
  // Product code and test code are scored separately: test files legitimately
  // repeat themselves and shouldn't drag the duplication or size score down.
  const product = facts.filter((f) => !isTestFile(f.path))
  const tests = facts.filter((f) => isTestFile(f.path))

  const extensibility = scoreExtensibility(product)
  const duplication = scoreDuplication(product)
  const coverage = await scoreCoverage(repoRoot)
  const coupling = await analyzeCoupling(repoRoot, commit, {
    analyzable: new Set(facts.map((f) => f.path)),
  })
  const graphNodes = buildGraph(product)

  const dimensions = {
    complexity: scoreComplexity(product),
    size: scoreSize(product),
    readability: scoreReadability(product),
    duplication: { ...duplication, clones: undefined }, // full list lives in dup/clones.json
    standards: scoreStandards(product),
    extensibility: { ...extensibility, moduleMetrics: undefined }, // full table in graph/modules.json
    coverage,
  }
  const totals = rollup(dimensions)

  const hidden = hiddenCoupling(coupling.pairs, graphNodes)

  const payload = {
    'manifest.json': {
      analyzerVersion: ANALYZER_VERSION,
      sourceCommit: commit,
      fileCount: facts.length,
      productFiles: product.length,
      testFiles: tests.length,
      languages: countBy(facts.map((f) => f.language)),
      thresholds: THRESHOLDS,
    },
    'health.json': {
      overall: totals.overall,
      grade: grade(totals.overall),
      dimensions,
      weights: WEIGHTS,
      weightsApplied: totals.weightsApplied,
      unmeasured: totals.unmeasured,
    },
    'graph/imports.json': buildImportEdges(facts),
    'graph/modules.json': { modules: extensibility.moduleMetrics, cycles: findCycles(graphNodes) },
    'api/surface.json': buildApiSurface(product),
    'dup/clones.json': { pairs: duplication.clones ?? [], ratio: duplication.duplicatedRatio },
    'coupling.json': {
      commitsAnalyzed: coupling.commitsAnalyzed,
      pairs: coupling.pairs,
      // Coupled in history but with no import between them — the coupling no
      // static analyzer can see.
      hidden: hidden.map(({ a, b, strength, sharedChanges }) => ({ a, b, strength, sharedChanges })),
    },
  }

  for (const f of facts) {
    payload[`files/${f.path}.json`] = fileRecord(f)
  }

  return { payload, facts, health: totals.overall, dimensions, fileCount: facts.length }
}

// Analyze the working tree, uncommitted changes included. This is the view that
// matters mid-session: the agent just wrote code that isn't committed, and the
// useful question is what that did to the codebase.
export async function analyzeWorkspace(repoRoot, { cache } = {}) {
  const paths = await workspaceFiles(repoRoot)
  const shas = await hashWorkingFiles(repoRoot, paths)

  const facts = []
  const misses = []
  for (const path of paths) {
    const sha = shas.get(path)
    const cached = cache && sha ? await cache.get(sha) : null
    if (cached) facts.push({ ...cached, path })
    else misses.push(path)
  }

  const sources = await readWorkspaceSources(repoRoot, misses)
  for (const path of misses) {
    const buf = sources.get(path)
    if (!buf) continue
    const f = await analyzeSource(path, buf)
    if (f) {
      facts.push(f)
      const sha = shas.get(path)
      if (cache && sha) await cache.set(sha, f)
    }
  }

  facts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return scoreFacts(repoRoot, facts, 'WORKING')
}

function countBy(items) {
  const out = {}
  for (const i of items) out[i] = (out[i] ?? 0) + 1
  return out
}

// Sorted edge list — sorted so the serialized form is stable and its diff shows
// real dependency changes rather than reordering noise.
function buildImportEdges(facts) {
  const edges = []
  for (const f of facts) {
    for (const spec of f.imports) {
      edges.push({ from: f.path, to: spec, external: !spec.startsWith('.') })
    }
  }
  return { edges: sortedBy(edges, 'from', 'to'), count: edges.length }
}

// The public API surface. Diffing this between snapshots is how breaking
// changes surface. Syntactic only in v1: tree-sitter sees the export keyword
// but not resolved types, so re-exports and computed names are approximate.
function buildApiSurface(facts) {
  const modules = {}
  for (const f of facts) {
    if (f.exports.length) modules[f.path] = [...new Set(f.exports)].sort()
  }
  return { modules, symbolCount: Object.values(modules).reduce((a, x) => a + x.length, 0) }
}
