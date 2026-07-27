// Analysis cache keyed by git blob SHA, sharded across 256 files.
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
//
// WHY SHARDED. It began as one JSON file holding every entry, which meant a
// flush rewrote the whole cache no matter how little had changed. On
// TypeScript's repository that was 67MB of JSON.stringify to record a
// single-file edit, and the write cost scaled with the size of the repository
// instead of the size of the change. Sharding by the first byte of the blob SHA
// gives 256 buckets; a run that touches one file rewrites one bucket.
//
// Blob SHAs are uniformly distributed by construction — they are hashes — so
// the buckets stay even without any rebalancing logic.

import { readFile, writeFile, mkdir, rename, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ANALYZER_VERSION } from './ledger.js'
import { languageFor } from './analyze/parser.js'

// A file's blob SHA is the cache key, so every run has to know it — and getting
// it means reading and hashing the file. On TypeScript's repository that was
// 1.9s per run to hash 38,211 working-tree files, which after sharding was the
// single largest cost in an incremental scan.
//
// This is the same index git keeps: remember (size, mtime) -> sha, and re-hash
// only what those say has changed. Statting a file is far cheaper than reading
// it.
export class StatIndex {
  constructor(file) {
    this.file = file
    this.map = new Map() // path -> { size, mtimeMs, sha }
    this.recordedAt = 0
    this.dirty = false
    this.loaded = false
  }

  async load() {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'))
      this.recordedAt = raw.recordedAt ?? 0
      for (const [path, e] of Object.entries(raw.entries ?? {})) this.map.set(path, e)
    } catch {
      // Absent or corrupt — every file simply looks new.
    }
  }

  // A remembered SHA is only trusted when the file's mtime is comfortably older
  // than the moment the index was written.
  //
  // This is git's "racily clean" problem: on a filesystem with coarse mtime
  // granularity, a file modified in the same tick in which it was hashed keeps
  // an mtime that says "unchanged". Anything modified near the last write is
  // re-hashed rather than trusted, which costs one extra hash for files that
  // were being edited at the time and nothing at all for the rest.
  lookup(path, size, mtimeMs) {
    const prev = this.map.get(path)
    if (!prev || prev.size !== size || prev.mtimeMs !== mtimeMs) return null
    if (mtimeMs >= this.recordedAt - RACE_WINDOW_MS) return null
    return prev.sha
  }

  record(path, size, mtimeMs, sha) {
    this.map.set(path, { size, mtimeMs, sha })
    this.dirty = true
  }

  async flush() {
    if (!this.dirty) return
    this.recordedAt = Date.now()
    const tmp = `${this.file}.${process.pid}.tmp`
    await mkdir(join(this.file, '..'), { recursive: true })
    await writeFile(tmp, JSON.stringify({ recordedAt: this.recordedAt, entries: Object.fromEntries(this.map) }))
    await rename(tmp, this.file)
    this.dirty = false
  }
}

const RACE_WINDOW_MS = 2000

// Fingerprint arrays dominate the entry size — roughly 3.4KB each — and they're
// kept because recomputing them means re-parsing, which is the expensive part.
//
// The cap is per shard rather than global, so it can be enforced while writing
// one shard without loading the other 255. 200 x 256 is a ceiling near 51,000
// entries, or about 170MB, for the largest repositories.
//
// It is sized well above real file counts on purpose. An earlier global cap of
// 20,000 sat *below* the 38,211 analyzable files in TypeScript's repository,
// and the result was not a smaller cache but a useless one: every run re-parsed
// ~17,600 files and then evicted precisely what the next run would need, making
// a warm scan slower than a cold one.
const MAX_ENTRIES_PER_SHARD = 200

const SHARD_RE = /^[0-9a-f]{2}\.json$/

export class AnalysisCache {
  static #seq = 0

  constructor(dir) {
    this.dir = dir
    // The analyzer version lives in the directory name, so a version bump is a
    // different directory rather than a file that must be read to be rejected.
    this.versionDir = join(dir, `v${ANALYZER_VERSION}`)
    this.map = new Map()
    // Blob SHAs this process actually looked at — the working set of the commit
    // being analyzed. Eviction keeps these in preference to anything else, so a
    // repeated scan of the same tree stays a full cache hit.
    this.touched = new Set()
    this.loadedShards = new Set()
    this.dirtyShards = new Set()
    this.loading = new Map() // shard -> in-flight promise, so concurrent gets load once
    this.flushing = null
    this.legacyCleaned = false
    // Rides along with the analysis cache so every existing caller gets it
    // without a signature change — they already thread `cache` everywhere and
    // already call flush().
    this.statIndex = new StatIndex(join(dir, `stat-v${ANALYZER_VERSION}.json`))
  }

  #shardOf(sha) {
    return sha.slice(0, 2)
  }

  // Load one shard on demand. Concurrent callers awaiting the same shard share
  // a single read — the MCP server issues overlapping tool calls, and without
  // this each would parse the same file.
  async #loadShard(shard) {
    if (this.loadedShards.has(shard)) return
    const inFlight = this.loading.get(shard)
    if (inFlight) return inFlight

    const promise = (async () => {
      try {
        const raw = JSON.parse(await readFile(join(this.versionDir, `${shard}.json`), 'utf8'))
        for (const [sha, facts] of Object.entries(raw)) {
          // A value already in memory is newer than the file; don't clobber it.
          if (!this.map.has(sha)) this.map.set(sha, facts)
        }
      } catch {
        // Missing or corrupt shard — treat as empty. The cache is derived data,
        // so recomputing is always correct and never worth failing a run over.
      }
      this.loadedShards.add(shard)
      this.loading.delete(shard)
    })()

    this.loading.set(shard, promise)
    return promise
  }

  async get(sha) {
    await this.#loadShard(this.#shardOf(sha))
    this.touched.add(sha)
    return this.map.get(sha) ?? null
  }

  async set(sha, facts) {
    const shard = this.#shardOf(sha)
    await this.#loadShard(shard)
    // `path` is deliberately excluded: the same content at two paths of the
    // same language must share one entry, and callers re-attach the path. The
    // language itself is part of the key — see cacheKey.
    const { path, ...rest } = facts
    this.map.set(sha, rest)
    this.touched.add(sha)
    this.dirtyShards.add(shard)
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
    await this.statIndex.flush()
    if (!this.dirtyShards.size) return
    await mkdir(this.versionDir, { recursive: true })

    const shards = [...this.dirtyShards]
    this.dirtyShards.clear()

    // Group entries by shard in one pass rather than scanning the map per
    // shard, which would be O(entries x dirty shards).
    const grouped = new Map(shards.map((s) => [s, []]))
    for (const entry of this.map) {
      const bucket = grouped.get(this.#shardOf(entry[0]))
      if (bucket) bucket.push(entry)
    }

    await Promise.all([...grouped].map(([shard, entries]) => this.#writeShard(shard, entries)))
    await this.#dropLegacy()
  }

  async #writeShard(shard, entries) {
    const kept = this.#evict(entries)

    // Write-then-rename so a crash mid-write can't leave a corrupt shard that
    // poisons every later run.
    const tmp = join(this.versionDir, `${shard}.${process.pid}.${AnalysisCache.#seq++}.tmp`)
    await writeFile(tmp, JSON.stringify(Object.fromEntries(kept)))
    await rename(tmp, join(this.versionDir, `${shard}.json`))

    // Keep memory in step with what was written. Without this the in-memory map
    // grew past the cap for the life of the process, which in the long-lived
    // MCP server is a slow leak.
    if (kept.length < entries.length) {
      const survivors = new Set(kept.map(([sha]) => sha))
      for (const [sha] of entries) if (!survivors.has(sha)) this.map.delete(sha)
    }
  }

  // Keep the current working set first, then the most recently added of
  // whatever else fits. Insertion order alone evicted exactly the entries the
  // next run needed on any repository larger than the cap.
  #evict(entries) {
    if (entries.length <= MAX_ENTRIES_PER_SHARD) return entries

    const kept = []
    const spare = []
    for (const entry of entries) (this.touched.has(entry[0]) ? kept : spare).push(entry)

    // A working set bigger than the cap cannot be helped by ordering; keep the
    // tail so at least a stable subset survives between runs.
    if (kept.length >= MAX_ENTRIES_PER_SHARD) return kept.slice(-MAX_ENTRIES_PER_SHARD)
    return kept.concat(spare.slice(-(MAX_ENTRIES_PER_SHARD - kept.length)))
  }

  // Remove the pre-sharding single-file cache, which is dead weight once shards
  // exist — 67MB of it on a large repository.
  async #dropLegacy() {
    if (this.legacyCleaned) return
    this.legacyCleaned = true
    await rm(join(this.dir, `analysis-v${ANALYZER_VERSION}.json`), { force: true })
  }

  // Entries currently held in memory. This counts loaded shards only, which is
  // the useful number: it is what a flush would write.
  get size() {
    return this.map.size
  }

  // Total entries on disk, for diagnostics. Reads every shard, so it is not on
  // any hot path.
  async diskSize() {
    let total = 0
    let files = []
    try {
      files = await readdir(this.versionDir)
    } catch {
      return 0
    }
    for (const name of files) {
      if (!SHARD_RE.test(name)) continue
      try {
        total += Object.keys(JSON.parse(await readFile(join(this.versionDir, name), 'utf8'))).length
      } catch {
        // Unreadable shard contributes nothing.
      }
    }
    return total
  }
}

export function openCache(ledgerDir) {
  return new AnalysisCache(join(ledgerDir, 'cache'))
}

// The cache key: blob SHA plus language.
//
// The SHA alone is wrong, and was wrong for a long time without being noticed.
// Analysis is a pure function of content *and grammar*, and the grammar comes
// from the file extension, not the bytes. Identical content at `util.ts` and
// `util.js` hashes to one blob, so whichever was analyzed first won and the
// other silently inherited its facts — parsed by the wrong grammar, counted
// under the wrong language.
//
// It showed up as vite scoring 68.2 cold and 68.3 warm: one TypeScript function
// appeared and disappeared depending on cache state. Small, but it meant the
// number moved for a reason that had nothing to do with the code.
//
// The SHA stays first so the shard prefix is still uniformly distributed.
export function cacheKey(sha, path) {
  return `${sha}.${languageFor(path) ?? 'none'}`
}
