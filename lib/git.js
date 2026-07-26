// Thin wrapper around the git CLI. We shell out to real git rather than using a
// JS reimplementation because gitcodebase's whole premise is that the analysis is
// stored *by the git engine* — we want real packfiles, real gc, real plumbing.

import { execFile } from 'node:child_process'

const MAX_BUFFER = 256 * 1024 * 1024 // some repos have big trees; don't truncate

// Run git and return trimmed stdout. Throws on non-zero exit.
export function git(cwd, args, { stdin, raw, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      { cwd, maxBuffer: MAX_BUFFER, encoding: raw ? 'buffer' : 'utf8', env: env ? { ...process.env, ...env } : process.env },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (raw ? stderr?.toString() : stderr) || err.message
          reject(new Error(`git ${args.slice(0, 3).join(' ')}: ${String(msg).trim()}`))
          return
        }
        resolve(raw ? stdout : stdout.trim())
      },
    )
    if (stdin !== undefined) {
      child.stdin.end(stdin)
    }
  })
}

// Best-effort variant — returns null instead of throwing. Use when absence is a
// normal outcome (no upstream, ref doesn't exist yet, not a repo).
export async function tryGit(cwd, args, opts) {
  try {
    return await git(cwd, args, opts)
  } catch {
    return null
  }
}

export async function isRepo(cwd) {
  return (await tryGit(cwd, ['rev-parse', '--is-inside-work-tree'])) === 'true'
}

// Absolute path to the repo's .git directory (handles worktrees and submodules).
export async function gitDir(cwd) {
  return git(cwd, ['rev-parse', '--absolute-git-dir'])
}

export async function repoRoot(cwd) {
  return git(cwd, ['rev-parse', '--show-toplevel'])
}

export async function resolveRef(cwd, ref) {
  return tryGit(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
}

export async function currentBranch(cwd) {
  const name = await tryGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  return name || 'HEAD'
}

// Commits reachable from `ref`, oldest first — the order we build ledger
// snapshots in, so ledger parentage mirrors source parentage.
export async function revList(cwd, ref = 'HEAD', { limit, firstParent = true } = {}) {
  const args = ['rev-list', '--reverse']
  if (firstParent) args.push('--first-parent')
  if (limit) args.push(`--max-count=${limit}`)
  args.push(ref)
  const out = await tryGit(cwd, args)
  return out ? out.split('\n').filter(Boolean) : []
}

// Metadata for a set of commits, in one process rather than N.
const LOG_SEP = '\x1e'
const FIELD_SEP = '\x1f'

export async function commitMeta(cwd, ref = 'HEAD', { limit } = {}) {
  const fmt = ['%H', '%h', '%P', '%an', '%ae', '%aI', '%s'].join(FIELD_SEP) + LOG_SEP
  const args = ['log', `--format=${fmt}`]
  if (limit) args.push(`--max-count=${limit}`)
  args.push(ref)
  const out = await tryGit(cwd, args)
  if (!out) return []
  return out
    .split(LOG_SEP)
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map((row) => {
      const [sha, short, parents, author, email, date, subject] = row.split(FIELD_SEP)
      return {
        sha,
        short,
        parents: parents ? parents.split(' ').filter(Boolean) : [],
        author,
        email,
        date,
        subject,
      }
    })
}

// Every blob in a commit's tree: [{ mode, sha, size, path }].
// This is the analyzer's input — we read source from git objects, not the
// working tree, so any historical commit can be analyzed without checking it out.
export async function listTree(cwd, commit) {
  const out = await tryGit(cwd, ['ls-tree', '-r', '-l', '-z', commit])
  if (!out) return []
  return out
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      // "<mode> <type> <sha> <size>\t<path>"
      const tabAt = line.indexOf('\t')
      const meta = line.slice(0, tabAt).split(/\s+/)
      return {
        mode: meta[0],
        type: meta[1],
        sha: meta[2],
        size: meta[3] === '-' ? 0 : Number(meta[3]),
        path: line.slice(tabAt + 1),
      }
    })
    .filter((e) => e.type === 'blob')
}

// Paths changed between two commits — drives incremental re-analysis.
export async function changedPaths(cwd, from, to) {
  if (!from) return null // null means "everything"
  const out = await tryGit(cwd, ['diff-tree', '-r', '--no-commit-id', '--name-only', '-z', from, to])
  if (out === null) return null
  return new Set(out.split('\0').filter(Boolean))
}

export async function readBlob(cwd, sha) {
  return git(cwd, ['cat-file', 'blob', sha], { raw: true })
}

// Read many blobs in ONE git process.
//
// Profiled on a 60-file repo: spawning `cat-file` per blob cost 351 ms and was
// 75% of total analysis time, versus 8 ms batched — a 44x difference. Process
// spawn, not parsing, is the dominant cost of a cold scan, so this is the single
// highest-leverage optimization in the analyzer.
//
// `--batch` protocol: for each SHA on stdin it emits "<sha> <type> <size>\n",
// then <size> raw bytes, then "\n". Content is binary, so the response has to be
// walked by byte offset rather than split on newlines.
const BATCH_CHUNK = 2000 // bound peak memory on very large trees

export async function readBlobsBatch(cwd, shas) {
  const out = new Map()
  for (let i = 0; i < shas.length; i += BATCH_CHUNK) {
    const chunk = shas.slice(i, i + BATCH_CHUNK)
    const buf = await git(cwd, ['cat-file', '--batch'], {
      stdin: chunk.join('\n') + '\n',
      raw: true,
    })
    let pos = 0
    while (pos < buf.length) {
      const nl = buf.indexOf(0x0a, pos)
      if (nl === -1) break
      const header = buf.toString('utf8', pos, nl)
      pos = nl + 1
      const [sha, type, sizeStr] = header.split(' ')
      if (type === 'missing' || sizeStr === undefined) continue
      const size = Number(sizeStr)
      if (type === 'blob') out.set(sha, buf.subarray(pos, pos + size))
      pos += size + 1 // skip content and its trailing newline
    }
  }
  return out
}

export async function objectExists(cwd, sha) {
  return (await tryGit(cwd, ['cat-file', '-e', `${sha}^{object}`])) !== null
}
