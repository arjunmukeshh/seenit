// The MCP server — seenit's most important surface.
//
// A dashboard only helps someone who remembers to open it. The user this is for
// is vibecoding: generating code far faster than they can read it, with the
// characteristic failure mode that nothing looks wrong until, fifty turns in,
// there are three near-identical helpers, utils.js is 2000 lines, and the agent
// itself has started struggling because the codebase became incoherent.
//
// Exposing the observatory as MCP tools puts the feedback loop where the code is
// actually being written. The most valuable tool here is find_existing: it turns
// duplication detection from a diagnosis into PREVENTION, because the agent can
// ask "does this already exist?" before writing rather than being told
// afterwards that it shouldn't have.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { repoRoot, gitDir, resolveRef } from '../lib/git.js'
import { openLedger, listSnapshots, readSnapshotFile, MAIN_REF } from '../lib/ledger.js'
import { openCache } from '../lib/cache.js'
import { analyzeWorkspace } from '../lib/analyze/index.js'
import { workingChanges } from '../lib/workspace.js'
import { findClones } from '../lib/analyze/metrics/duplication.js'
// Shared with the CLI. Bars and colour are off here: this output lands in an
// agent's context window, where glyphs and escape codes are wasted tokens.
import { formatHealth as renderHealth } from '../lib/format.js'

const formatHealth = (health, dimensions, previous) => renderHealth(health, dimensions, previous)

const TOOLS = [
  {
    name: 'check_health',
    description:
      'Measure the current health of the codebase, including uncommitted changes. ' +
      'Returns an overall score plus six dimensions (complexity, size, duplication, readability, ' +
      'standards, extensibility) and, when a previous snapshot exists, the delta against it. ' +
      'Call this after making substantial edits to see whether they improved or degraded the codebase.',
    inputSchema: {
      type: 'object',
      properties: {
        detail: {
          type: 'string',
          enum: ['summary', 'full'],
          description: 'summary returns scores and deltas; full includes worst offenders per dimension.',
        },
      },
    },
  },
  {
    name: 'find_existing',
    description:
      'Search the codebase for existing implementations before writing new code. ' +
      'Call this BEFORE writing a new helper, utility, or function to avoid creating a duplicate ' +
      'of something that already exists. Searches exported symbol names and returns matches with ' +
      'their file and signature context.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What you are about to implement, e.g. "validate email" or "formatCurrency".',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'check_duplication',
    description:
      'Report near-duplicate code in the repository, detected by token fingerprinting with ' +
      'identifiers normalized (so copies with renamed variables are still found). ' +
      'Use this to find consolidation opportunities.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max pairs to return (default 10).' } },
    },
  },
  {
    name: 'check_structure',
    description:
      'Report architectural problems: dependency cycles, hub modules that are both widely ' +
      'depended upon and widely depending, modules far from the main sequence, and hidden ' +
      'coupling (files that always change together despite having no import between them). ' +
      'Use before refactoring, or when deciding where new code belongs.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'review_changes',
    description:
      'Review what the current uncommitted changes did to the codebase: which files changed, ' +
      'and the health impact of those changes. Call this at the end of a task to check that ' +
      'the work did not degrade the codebase.',
    inputSchema: { type: 'object', properties: {} },
  },
]

// Resolved once per process; the server is per-repo.
let ctx = null

async function context() {
  if (ctx) return ctx
  const cwd = process.env.GITCODEBASE_REPO || process.cwd()
  const root = await repoRoot(cwd)
  const gd = await gitDir(cwd)
  const ledger = await openLedger(root, gd)
  ctx = { root, ledger, cache: openCache(ledger.dir) }
  return ctx
}

async function previousHealth(ledger) {
  const snaps = await listSnapshots(ledger, { limit: 1 })
  if (!snaps.length) return null
  return readSnapshotFile(ledger, snaps[0].sha, 'health.json')
}

const handlers = {
  async check_health({ detail = 'summary' }) {
    const { root, ledger, cache } = await context()
    const [result, previous] = await Promise.all([analyzeWorkspace(root, { cache }), previousHealth(ledger)])
    await cache.flush()

    const out = [formatHealth(result.health, result.dimensions, previous)]
    if (previous === null) {
      out.push('\n(no previous snapshot — run `seenit scan` to start tracking history)')
    }

    if (detail === 'full') {
      const d = result.dimensions
      out.push('\nWorst offenders:')
      const worstFile = result.facts
        .filter((f) => f.functions.length)
        .map((f) => ({ path: f.path, worst: Math.max(...f.functions.map((fn) => fn.cognitive)) }))
        .sort((a, b) => b.worst - a.worst)[0]
      if (worstFile) out.push(`  complexity: ${worstFile.path} (cognitive ${worstFile.worst})`)
      if (d.duplication?.worstPairs?.length) {
        const p = d.duplication.worstPairs[0]
        out.push(`  duplication: ${p.a} <-> ${p.b}`)
      }
      if (d.extensibility?.worstCycles?.length) {
        out.push(`  cycle: ${d.extensibility.worstCycles[0].members.join(' -> ')}`)
      }
    }
    return out.join('\n')
  },

  async find_existing({ query }) {
    const { root, cache } = await context()
    const { facts } = await analyzeWorkspace(root, { cache })
    await cache.flush()

    // Match on symbol name and path. Deliberately fuzzy: the agent describes
    // intent ("validate email"), not the exact identifier it's looking for.
    const terms = query.toLowerCase().split(/[^a-z0-9]+/i).filter((t) => t.length > 2)
    if (!terms.length) return 'Query too short to search.'

    const hits = []
    for (const f of facts) {
      for (const name of f.exports) {
        const hay = `${name} ${f.path}`.toLowerCase()
        const score = terms.filter((t) => hay.includes(t)).length
        if (score) hits.push({ name, path: f.path, score, kind: 'export' })
      }
      for (const fn of f.functions) {
        if (fn.name === '(anonymous)') continue
        const hay = `${fn.name} ${f.path}`.toLowerCase()
        const score = terms.filter((t) => hay.includes(t)).length
        if (score) hits.push({ name: fn.name, path: f.path, line: fn.line, score, kind: 'function' })
      }
    }

    if (!hits.length) {
      return `No existing implementation found for "${query}". Safe to write it.`
    }

    const top = hits.sort((a, b) => b.score - a.score).slice(0, 12)
    return [
      `Found ${hits.length} possible existing implementation(s) for "${query}".`,
      'Consider reusing or extending one of these instead of writing a new one:',
      ...top.map((h) => `  ${h.name}  —  ${h.path}${h.line ? `:${h.line}` : ''} (${h.kind})`),
    ].join('\n')
  },

  async check_duplication({ limit = 10 }) {
    const { root, cache } = await context()
    const { facts } = await analyzeWorkspace(root, { cache })
    await cache.flush()
    const clones = findClones(facts.filter((f) => !f.path.match(/\.(test|spec)\./)))
    if (!clones.length) return 'No significant duplication detected.'
    const top = [...clones].sort((a, b) => b.shared - a.shared).slice(0, limit)
    return [
      `${clones.length} duplicated region(s) across the codebase:`,
      ...top.map((c) => `  ${c.a} <-> ${c.b}  (${c.shared} shared fingerprints, e.g. lines ${c.samples[0]?.aLine}/${c.samples[0]?.bLine})`),
    ].join('\n')
  },

  async check_structure() {
    const { root, ledger, cache } = await context()
    const { dimensions } = await analyzeWorkspace(root, { cache })
    await cache.flush()
    const e = dimensions.extensibility
    const out = [`Extensibility ${e.score?.toFixed(1)} — ${e.modules} modules, ${e.cycles} cycle(s), ${e.hubs} hub(s)`]

    if (e.worstCycles?.length) {
      out.push('\nDependency cycles (block extraction and refactoring):')
      for (const c of e.worstCycles) out.push(`  ${c.members.join(' -> ')} -> (back)`)
    }
    if (e.hubModules?.length) {
      out.push('\nHub modules (know everything and are known by everything):')
      for (const h of e.hubModules.slice(0, 5)) out.push(`  ${h.path}  fan-in ${h.fanIn}, fan-out ${h.fanOut}`)
    }

    const coupling = await readSnapshotFile(ledger, MAIN_REF, 'coupling.json').catch(() => null)
    if (coupling?.hidden?.length) {
      out.push('\nHidden coupling (change together, but no import between them):')
      for (const h of coupling.hidden.slice(0, 5)) {
        out.push(`  ${h.a} <-> ${h.b}  (${(h.strength * 100).toFixed(0)}% co-change)`)
      }
    }
    return out.join('\n')
  },

  async review_changes() {
    const { root, ledger, cache } = await context()
    const [changes, result, previous] = await Promise.all([
      workingChanges(root),
      analyzeWorkspace(root, { cache }),
      previousHealth(ledger),
    ])
    await cache.flush()

    const touched = [...changes.added, ...changes.modified, ...changes.deleted]
    if (!touched.length) return 'No uncommitted changes to review.'

    const out = [
      `${changes.added.length} added, ${changes.modified.length} modified, ${changes.deleted.length} deleted`,
      ...changes.added.map((p) => `  + ${p}`),
      ...changes.modified.map((p) => `  ~ ${p}`),
      ...changes.deleted.map((p) => `  - ${p}`),
      '',
      formatHealth(result.health, result.dimensions, previous),
    ]

    // Surface duplication involving the files just touched — the most likely
    // thing a fresh agent turn got wrong.
    const touchedSet = new Set([...changes.added, ...changes.modified])
    const clones = findClones(result.facts).filter((c) => touchedSet.has(c.a) || touchedSet.has(c.b))
    if (clones.length) {
      out.push('\n⚠ Changed files duplicate existing code:')
      for (const c of clones.sort((a, b) => b.shared - a.shared).slice(0, 5)) {
        out.push(`  ${c.a} <-> ${c.b}`)
      }
    }
    return out.join('\n')
  },
}

export async function startServer() {
  const server = new Server(
    { name: 'seenit', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const handler = handlers[request.params.name]
    if (!handler) {
      return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }], isError: true }
    }
    try {
      const text = await handler(request.params.arguments ?? {})
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      // Never crash the server on one bad call — the agent should see the error
      // and be able to continue.
      return { content: [{ type: 'text', text: `seenit error: ${err.message}` }], isError: true }
    }
  })

  await server.connect(new StdioServerTransport())
}
