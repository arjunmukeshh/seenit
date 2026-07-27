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
// them means re-parsing, which is the expensive part. At roughly 3.4KB per
// entry this caps the on-disk cache near 170MB for the largest repositories,
// which lives in .git/ and is discardable.
//
// The old cap of 20,000 was below the file count of real repositories —
// TypeScript's has 38,211 analyzable files — and the effect was not a smaller
// cache but a useless one: every run re-parsed ~17,600 files and then evicted
// whatever the next run would need. A warm scan measured *slower* than a cold
// one, because it paid full parse cost plus cache serialization on top.
const MAX_ENTRIES = 50000

export class AnalysisCache {
  static #seq = 0

  constructor(dir) {
    this.dir = dir
    this.file = join(dir, `analysis-v${ANALYZER_VERSION}.json`)
    this.map = new Map()
    // Blob SHAs this process actually looked at — the working set of the commit
    // being analyzed. Eviction keeps these in preference to anything else, so a
    // repeated scan of the same tree stays a full cache hit.
    this.touched = new Set()
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
    this.touched.add(sha)
    return this.map.get(sha) ?? null
  }

  async set(sha, facts) {
    await this.load()
    // `path` is deliberately excluded: the same content at two paths must share
    // one entry, and callers re-attach the path.
    const { path, ...rest } = facts
    this.map.set(sha, rest)
    this.touched.add(sha)
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

    const entries = this.#evict()

    // Write-then-rename so a crash mid-write can't leave a corrupt cache that
    // poisons every later run.
    const tmp = `${this.file}.${process.pid}.${AnalysisCache.#seq++}.tmp`
    await writeFile(tmp, JSON.stringify({ analyzerVersion: ANALYZER_VERSION, entries: Object.fromEntries(entries) }))
    await rename(tmp, this.file)
    this.dirty = false

    // Keep memory in step with the file. Without this the in-memory map grew
    // past the cap for the life of the process — the MCP server is long-lived,
    // so an unbounded map there is a slow leak, and a 38k-file repository was
    // holding 36,122 entries against a 20,000-entry file.
    if (this.map.size > MAX_ENTRIES) this.map = new Map(entries)
  }

  // Keep the current working set first, then the most recently added of
  // whatever else fits. Insertion order alone evicted exactly the entries the
  // next run needed on any repository larger than the cap.
  #evict() {
    if (this.map.size <= MAX_ENTRIES) return [...this.map.entries()]

    const kept = []
    const spare = []
    for (const entry of this.map) (this.touched.has(entry[0]) ? kept : spare).push(entry)

    // A working set bigger than the cap cannot be helped by ordering; keep the
    // tail so at least a stable subset survives between runs.
    if (kept.length >= MAX_ENTRIES) return kept.slice(-MAX_ENTRIES)
    return kept.concat(spare.slice(-(MAX_ENTRIES - kept.length)))
  }

  get size() {
    return this.map.size
  }
}

export function openCache(ledgerDir) {
  return new AnalysisCache(join(ledgerDir, 'cache'))
}
