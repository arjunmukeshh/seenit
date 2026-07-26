// Analysis cache keyed by git blob SHA.
//
// The key insight: git already content-addresses every file, and analysis of a
// blob is a pure function of its content. So a file that didn't change between
// two commits — or between two agent turns — never needs re-parsing, no matter
// how many snapshots reference it. This is what makes backfilling hundreds of
// commits affordable and what makes the MCP server's repeated calls feel
// instant during a vibecoding session.
//
// Stored inside the ledger repo's directory (not the working tree) so it never
// shows up in the user's `git status`.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { ANALYZER_VERSION } from './ledger.js'

// Fingerprint arrays dominate the cache size; they're kept because recomputing
// them means re-parsing, which is the expensive part.
const MAX_ENTRIES = 20000

export class AnalysisCache {
  static #seq = 0

  constructor(dir) {
    this.dir = dir
    this.file = join(dir, `analysis-v${ANALYZER_VERSION}.json`)
    this.map = new Map()
    this.dirty = false
    this.loaded = false
    this.flushing = null
  }

  async load() {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'))
      // Version mismatch means the analyzer changed; the old facts are wrong,
      // not merely stale, so discard rather than migrate.
      if (raw.analyzerVersion === ANALYZER_VERSION) {
        for (const [sha, facts] of Object.entries(raw.entries)) this.map.set(sha, facts)
      }
    } catch {
      // No cache yet, or it's corrupt — either way, start clean.
    }
  }

  async get(sha) {
    await this.load()
    return this.map.get(sha) ?? null
  }

  async set(sha, facts) {
    await this.load()
    // `path` is deliberately excluded: the same content at two paths must share
    // one entry, and callers re-attach the path.
    const { path, ...rest } = facts
    this.map.set(sha, rest)
    this.dirty = true
  }

  // Flushes are serialized through a promise chain. The MCP server handles
  // concurrent tool calls, and two overlapping flushes previously raced on an
  // identical pid-based temp filename — one renamed it, the other's rename
  // failed with ENOENT. The counter makes temp names unique even within a
  // process; the chain means only one write is in flight at a time.
  async flush() {
    this.flushing = Promise.resolve(this.flushing).then(
      () => this.#write(),
      () => this.#write(),
    )
    return this.flushing
  }

  async #write() {
    if (!this.dirty) return
    await mkdir(this.dir, { recursive: true })

    let entries = [...this.map.entries()]
    if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES)

    // Write-then-rename so a crash mid-write can't leave a corrupt cache that
    // poisons every later run.
    const tmp = `${this.file}.${process.pid}.${AnalysisCache.#seq++}.tmp`
    await writeFile(tmp, JSON.stringify({ analyzerVersion: ANALYZER_VERSION, entries: Object.fromEntries(entries) }))
    await rename(tmp, this.file)
    this.dirty = false
  }

  get size() {
    return this.map.size
  }
}

export function openCache(ledgerDir) {
  return new AnalysisCache(join(ledgerDir, 'cache'))
}
