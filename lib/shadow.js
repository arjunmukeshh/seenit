// A shadow tree that survives between runs.
//
// Normalising is ~80% of the cost of a scan and almost all of it is repeated
// work: between two invocations a second apart, a handful of files changed and
// the other seventeen thousand did not. Cold, microsoft/vscode takes 30s to
// normalise; warm, it should cost only the files that moved.
//
// This exists for the pre-write hook, which runs on every write and cannot
// spend 30s doing it. The CLI gets the same benefit for free.
//
// The cache is keyed by absolute repository path and versioned by everything
// that changes what normalisation produces. A stale entry does not error, it
// silently reports the wrong duplication, so the version key is deliberately
// aggressive: bump CACHE_VERSION on any change to the normaliser.

import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { normalizeSource } from './normalize.js'

// Bump when normalizeSource changes shape. A cache built by an older
// normaliser is not merely stale, it is wrong.
const CACHE_VERSION = 1

const MAX_BYTES = 2_000_000

export function cacheDirFor(root) {
  // Resolve first. The same repository reached through a symlink spells its own
  // path two ways — /var/... and /private/var/... on macOS — and hashing the
  // spelling gives each one its own cache. The hook would then see a repository
  // primed by the CLI as cold, and re-normalise the whole tree.
  let real = root
  try {
    real = realpathSync(root)
  } catch {
    /* not on disk yet; the literal path is as good a key as any */
  }
  const key = createHash('sha256').update(real).digest('hex').slice(0, 16)
  return join(tmpdir(), 'seenit-cache', `v${CACHE_VERSION}-${key}`)
}

async function readManifest(dir) {
  try {
    const m = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
    return m.version === CACHE_VERSION ? m : null
  } catch {
    return null
  }
}

/**
 * Has this repository ever been normalised?
 *
 * The hook needs to know before it starts, not after. On a cold cache it runs
 * out of budget and says nothing — which is byte-for-byte what it says when the
 * repository is clean, so an unprimed hook looks exactly like a working one.
 */
export async function isPrimed(root) {
  return (await readManifest(cacheDirFor(root))) !== null
}

/**
 * Record that the cold-cache warning has been given for this repository.
 *
 * Once, not on every write. The hook fires constantly; a line repeated on every
 * Edit is noise, and noise is how a hook gets uninstalled.
 */
export async function markWarned(root) {
  const dir = cacheDirFor(root)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'warned'), '')
  } catch {
    /* the warning is advisory; failing to record it is not worth an error */
  }
}

export async function hasWarned(root) {
  try {
    await stat(join(cacheDirFor(root), 'warned'))
    return true
  } catch {
    return false
  }
}

/**
 * Bring the cached shadow at `dir` into line with `files`, and return it.
 *
 * A file is considered unchanged when its size and mtime both match what was
 * recorded. That is the same bet git makes for its index, and it is wrong in
 * the same rare case: a write that preserves both. The alternative is hashing
 * every file, which costs most of what the cache saves.
 */
export async function syncShadow(root, files, { concurrency = 12 } = {}) {
  const dir = cacheDirFor(root)
  const previous = (await readManifest(dir))?.files ?? {}
  const current = {}
  await mkdir(dir, { recursive: true })

  const wanted = new Set(files)
  let reused = 0
  let rebuilt = 0
  let failed = 0

  let next = 0
  const worker = async () => {
    while (next < files.length) {
      const rel = files[next++]
      const from = join(root, rel)
      const to = join(dir, rel)
      try {
        const s = await stat(from)
        const stamp = `${s.size}:${Math.floor(s.mtimeMs)}`
        if (previous[rel] === stamp) {
          current[rel] = stamp
          reused++
          continue
        }
        if (s.size > MAX_BYTES) continue

        const text = await normalizeSource(rel, await readFile(from, 'utf8'))
        await mkdir(dirname(to), { recursive: true })
        if (text === null) await cp(from, to)
        else await writeFile(to, text)
        current[rel] = stamp
        rebuilt++
      } catch {
        failed++
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length || 1) }, worker))

  // Drop what is no longer tracked. Leaving it behind would report duplication
  // against a file the repository does not have any more.
  const stale = Object.keys(previous).filter((p) => !wanted.has(p))
  await Promise.all(stale.map((p) => rm(join(dir, p), { force: true })))

  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ version: CACHE_VERSION, files: current }))

  return { dir, reused, rebuilt, failed, dropped: stale.length }
}

// Remove a repository's cache. Exposed for `seenit --no-cache` recovery and for
// tests, which must not inherit state from each other.
export async function clearCache(root) {
  await rm(cacheDirFor(root), { recursive: true, force: true })
}
