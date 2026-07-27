// Analyze the working tree — including uncommitted changes.
//
// This is the path that matters during a vibecoding session. The agent has just
// written code that isn't committed yet, and the useful question is "what did
// that just do to the codebase?", not "what did HEAD look like?".
//
// Working-tree content is hashed with `git hash-object` so it lands in the same
// blob-SHA cache as committed content. An agent that edits a file and reverts it
// gets a cache hit, and files it never touched are free.

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { git, tryGit } from './git.js'
import { isAnalyzable } from './analyze/parser.js'

// Tracked files plus untracked-but-not-ignored ones — an agent's brand new file
// is untracked and is exactly what we most want to look at.
export async function workspaceFiles(repoRoot) {
  const out = await tryGit(repoRoot, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
  if (!out) return []
  return [...new Set(out.split('\0').filter(Boolean))].filter(isAnalyzable).sort()
}

// Hash working-tree files, skipping any whose size and mtime say they are
// unchanged since the last run.
//
// Hashing means reading the whole file, so on a large repository this was the
// dominant cost of an incremental scan — 1.9s to hash 38,211 files in order to
// discover that one of them had changed. Statting them instead costs about a
// tenth of that, and only the files that actually moved get read.
//
// Without a stat index this falls back to hashing everything, which is what the
// first run does anyway.
export async function hashWorkingFiles(repoRoot, paths, { statIndex } = {}) {
  if (!paths.length) return new Map()
  if (!statIndex) return hashAll(repoRoot, paths)

  await statIndex.load()

  const known = new Map()
  const stale = []
  await Promise.all(
    paths.map(async (path) => {
      try {
        const s = await stat(join(repoRoot, path))
        const sha = statIndex.lookup(path, s.size, s.mtimeMs)
        if (sha) known.set(path, sha)
        else stale.push({ path, size: s.size, mtimeMs: s.mtimeMs })
      } catch {
        // Vanished between listing and statting — a live working tree moves.
      }
    }),
  )

  if (stale.length) {
    const hashed = await hashAll(repoRoot, stale.map((f) => f.path))
    for (const { path, size, mtimeMs } of stale) {
      const sha = hashed.get(path)
      if (!sha) continue
      known.set(path, sha)
      statIndex.record(path, size, mtimeMs, sha)
    }
  }

  return known
}

// Hash a set of files in ONE git process. Same reasoning as readBlobsBatch:
// per-file spawning dominates runtime otherwise.
async function hashAll(repoRoot, paths) {
  if (!paths.length) return new Map()
  const stdout = await git(repoRoot, ['hash-object', '--stdin-paths'], {
    stdin: paths.map((p) => join(repoRoot, p)).join('\n') + '\n',
  })
  const shas = stdout.split('\n').filter(Boolean)
  const map = new Map()
  paths.forEach((p, i) => {
    if (shas[i]) map.set(p, shas[i])
  })
  return map
}

// Read working-tree files, honoring the same cache as committed analysis.
export async function readWorkspaceSources(repoRoot, paths) {
  const contents = new Map()
  await Promise.all(
    paths.map(async (p) => {
      try {
        contents.set(p, await readFile(join(repoRoot, p)))
      } catch {
        // Deleted between listing and reading — a live working tree moves.
      }
    }),
  )
  return contents
}

// Which files differ from HEAD, split by status. Drives "what did this turn
// change?" without needing to diff analysis payloads.
export async function workingChanges(repoRoot) {
  // trim:false is essential — porcelain status codes are two columns and an
  // unstaged modification reads " M path", so trimming eats the leading space
  // and shifts the path.
  const out = await tryGit(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { trim: false })
  if (!out) return { modified: [], added: [], deleted: [] }

  const modified = []
  const added = []
  const deleted = []

  // NUL-separated; renames emit an extra NUL-terminated field for the old path.
  const parts = out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (!entry) continue
    const code = entry.slice(0, 2)
    const path = entry.slice(3)
    if (code[0] === 'R') i++ // consume the rename's source path
    if (!isAnalyzable(path)) continue
    if (code.includes('D')) deleted.push(path)
    else if (code === '??' || code.includes('A')) added.push(path)
    else modified.push(path)
  }
  return { modified: modified.sort(), added: added.sort(), deleted: deleted.sort() }
}
