// Local HTTP server for the observatory UI.
//
// Zero dependencies and no framework, following the footinthedoor pattern: a
// node:http server that reads from the ledger and serves the built frontend.
// There is no database — every response is derived from git objects, which is
// the whole premise.
//
// Binds to 127.0.0.1 only. This exposes the full contents of a local repository,
// so it must never be reachable from the network.

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, extname, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

import { repoRoot, gitDir, currentBranch, commitMeta } from '../lib/git.js'
import { openLedger, listSnapshots, readSnapshotFile, listSnapshotFiles, diffSnapshots, MAIN_REF } from '../lib/ledger.js'
import { ANALYZER_VERSION } from '../lib/ledger.js'
import { normalizeStoredHealth } from '../lib/analyze/metrics/score.js'
import { openCache } from '../lib/cache.js'
import { analyzeWorkspace } from '../lib/analyze/index.js'
import { workingChanges } from '../lib/workspace.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = join(HERE, '..', 'dist')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

function json(res, body, status = 200) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

// Workspace analysis is the expensive call and the UI polls it, so results are
// cached briefly. Any file write invalidates via the mtime check in the caller.
let workspaceCache = { at: 0, value: null }
const WORKSPACE_TTL = 1500

const httpError = (message, status) => Object.assign(new Error(message), { status })

// Require a query parameter, or fail with a 400 rather than a confusing 500
// further down. Every handler that needs an argument goes through this.
function required(url, name) {
  const value = url.searchParams.get(name)
  if (!value) throw httpError(`${name} is required`, 400)
  return value
}

const IS_TEST_PATH = /\.(test|spec)\.|(^|\/)(__tests__|tests?)\//

// Per-file rows drive the treemap and the file table. The per-function metrics
// are collapsed to a per-file maximum here, matching how the ledger stores them.
function fileRow(f) {
  const max = (pick) => (f.functions.length ? Math.max(...f.functions.map(pick)) : 0)
  return {
    path: f.path,
    language: f.language,
    loc: f.loc,
    functions: f.functions.length,
    maxCognitive: max((fn) => fn.cognitive),
    maxCyclomatic: max((fn) => fn.cyclomatic),
    maxNesting: max((fn) => fn.maxNesting),
    commentLines: f.commentLines,
    exports: f.exports.length,
    imports: f.imports,
    isTest: IS_TEST_PATH.test(f.path),
  }
}

// One handler per endpoint, keyed by pathname.
//
// This was a single switch. Splitting it is not cosmetic: seenit scored
// the combined function at cyclomatic 19 against a measured JavaScript warn of
// 6, and a health tool that ignores its own reading about itself is not worth
// much. Each handler now sits in the low single digits and the dispatcher is
// a map lookup.
const ROUTES = {
  // Repo identity — shown in the header.
  '/api/repo': async ({ root, ledger }) => {
    const [branch, head] = await Promise.all([currentBranch(root), commitMeta(root, 'HEAD', { limit: 1 })])
    return { root, name: root.split('/').pop(), branch, head: head[0] ?? null, ledgerPath: ledger.dir }
  },

  // The commit rail: every snapshot with its health, newest first.
  '/api/snapshots': async ({ ledger }, url) => ({
    snapshots: await listSnapshots(ledger, { limit: Number(url.searchParams.get('limit')) || 200 }),
  }),

  // Current state including uncommitted work.
  '/api/workspace': async ({ root, ledger, cache }) => {
    if (Date.now() - workspaceCache.at < WORKSPACE_TTL && workspaceCache.value) return workspaceCache.value

    const [result, changes, previous] = await Promise.all([
      analyzeWorkspace(root, { cache }),
      workingChanges(root),
      listSnapshots(ledger, { limit: 1 }).then((s) => (s.length ? readSnapshotFile(ledger, s[0].sha, 'health.json') : null)),
    ])
    await cache.flush()

    const value = {
      health: result.health,
      dimensions: result.dimensions,
      weights: result.weights,
      dag: result.dag,
      fileCount: result.fileCount,
      productFiles: result.productFiles,
      testFiles: result.testFiles,
      previous,
      changes,
      files: result.facts.map(fileRow),
    }
    workspaceCache = { at: Date.now(), value }
    return value
  },

  // Any file from any snapshot — health.json, graph/modules.json, etc.
  '/api/snapshot': async ({ ledger }, url) => {
    const ref = url.searchParams.get('ref') ?? MAIN_REF
    const file = url.searchParams.get('file')
    if (!file) return { files: await listSnapshotFiles(ledger, ref) }
    const content = await readSnapshotFile(ledger, ref, file)
    if (content === null) throw httpError(`not in snapshot: ${file}`, 404)
    // Stored health from an older analyzer carries a withdrawn duplication
    // score; neutralise it before it reaches a screen.
    return file === 'health.json' ? normalizeStoredHealth(content, ANALYZER_VERSION) : content
  },

  // The drift view: what changed about the codebase between two snapshots.
  '/api/diff': async ({ ledger }, url) => {
    const from = required(url, 'from')
    const to = required(url, 'to')
    const [names, patch, fromHealth, toHealth] = await Promise.all([
      diffSnapshots(ledger, from, to, { nameOnly: true }),
      diffSnapshots(ledger, from, to),
      readSnapshotFile(ledger, from, 'health.json'),
      readSnapshotFile(ledger, to, 'health.json'),
    ])
    const changed = names.split('\n').filter(Boolean).map((line) => {
      const [status, path] = line.split('\t')
      return { status, path }
    })
    return {
      changed,
      patch,
      from: normalizeStoredHealth(rawFrom, ANALYZER_VERSION),
      to: normalizeStoredHealth(rawTo, ANALYZER_VERSION),
    }
  },

  // Health of one file across the whole ledger — the metric-blame view.
  '/api/history': async ({ ledger }, url) => {
    const path = required(url, 'path')
    const snaps = await listSnapshots(ledger, { limit: 100 })
    const series = []
    for (const s of snaps) {
      const record = await readSnapshotFile(ledger, s.sha, `files/${path}.json`)
      if (record) series.push({ snapshot: s.sha, sourceCommit: s.sourceCommit, date: s.date, ...record })
    }
    return { path, series: series.reverse() }
  },
}

async function routes(ctx, url) {
  const handler = ROUTES[url.pathname]
  if (!handler) throw httpError('not found', 404)
  return handler(ctx, url)
}

async function serveStatic(res, pathname) {
  if (!existsSync(DIST)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      `<!doctype html><meta charset=utf-8><title>seenit</title>
       <body style="font-family:system-ui;max-width:40rem;margin:4rem auto;line-height:1.6">
       <h1>seenit</h1>
       <p>The UI has not been built yet. Run:</p>
       <pre style="background:#f4f4f5;padding:1rem;border-radius:6px">npm run build</pre>
       <p>The API is live — try <a href="/api/workspace">/api/workspace</a>.</p>`,
    )
    return
  }

  // Percent-decode BEFORE validating: url.pathname preserves encoding, so a
  // check for ".." against the raw pathname never sees "%2e%2e" and would pass
  // traversal straight through once dist/ exists.
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    res.writeHead(400).end('bad request')
    return
  }
  if (decoded.includes('\0')) {
    res.writeHead(400).end('bad request')
    return
  }

  const rel = normalize(decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, ''))
  const file = resolve(DIST, rel)
  // Authoritative check: the resolved absolute path must live under DIST.
  // Prefix-matching on the raw path is not enough (a sibling directory named
  // "dist-old" would match "dist"), hence the separator.
  if (file !== DIST && !file.startsWith(DIST + sep)) {
    res.writeHead(403).end('forbidden')
    return
  }
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    // SPA fallback — client-side routing owns unknown paths.
    try {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(await readFile(join(DIST, 'index.html')))
    } catch {
      res.writeHead(404).end('not found')
    }
  }
}

export async function startServer({ port = 4300, cwd = process.cwd() } = {}) {
  const root = await repoRoot(cwd)
  const ledger = await openLedger(root, await gitDir(cwd))
  const ctx = { root, ledger, cache: openCache(ledger.dir) }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname)
    try {
      json(res, await routes(ctx, url))
    } catch (err) {
      json(res, { error: err.message }, err.status ?? 500)
    }
  })

  // 127.0.0.1 rather than 0.0.0.0: this serves the full contents of a local
  // repository and must not be reachable from the network.
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${port}`, root }
}
