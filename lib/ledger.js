// The ledger — analysis history stored as real git objects.
//
// Layout: a *bare sidecar repo* at <repo>/.git/gitcodebase/ledger.git.
//
// Why a sidecar rather than custom refs (refs/gitcodebase/*) in the source repo:
// custom refs are included by `git log --all`, so they surface in lazygit,
// GitKraken, tig and friends — the ledger would visibly pollute the user's
// history. A sidecar is completely invisible to the source repo (verified:
// `git log --all` and `git status` stay clean) while still being a full git
// repo, so log / diff / blame / bisect / tag all work on the analysis itself.
//
// objects/info/alternates points at the source repo's object store, so ledger
// commits can reference source commits without copying objects.
//
// Refs inside the ledger:
//   refs/heads/main        the snapshot chain, one commit per analyzed source commit
//   refs/baselines/<name>  named baselines for drift comparison
//
// The layout deliberately leaves room to mirror into the source repo's
// refs/gitcodebase/* later, for a `publish` command that shares the ledger.

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { git, tryGit } from './git.js'
import { stringify } from './canonical.js'

export const ANALYZER_VERSION = 1
export const LEDGER_REL = 'gitcodebase/ledger.git'
export const MAIN_REF = 'refs/heads/main'

// A ledger handle: knows where the bare repo is and runs git against it.
export class Ledger {
  constructor(repoRoot, ledgerDir) {
    this.repoRoot = repoRoot
    this.dir = ledgerDir
  }

  // All ledger git commands run with --git-dir pointed at the sidecar.
  // `cwd` may be overridden (writeTree runs `git add` inside a temp work tree).
  run(args, { cwd, ...opts } = {}) {
    return git(cwd ?? this.repoRoot, ['--git-dir', this.dir, ...args], opts)
  }

  tryRun(args, { cwd, ...opts } = {}) {
    return tryGit(cwd ?? this.repoRoot, ['--git-dir', this.dir, ...args], opts)
  }
}

export async function openLedger(repoRoot, gitDirPath) {
  const ledgerDir = join(gitDirPath, LEDGER_REL)
  const ledger = new Ledger(repoRoot, ledgerDir)

  if (!existsSync(ledgerDir)) {
    await git(repoRoot, ['init', '--quiet', '--bare', ledgerDir])
    // Identity for snapshot commits — this is a machine-authored history.
    await ledger.run(['config', 'user.name', 'gitcodebase'])
    await ledger.run(['config', 'user.email', 'gitcodebase@local'])
    // Snapshots are machine-generated; never rewrite them by rebase/gc surprises.
    await ledger.run(['config', 'gc.auto', '0'])
    // Let the ledger read the source repo's objects (so we can reference source
    // commits and read source blobs through a single object store).
    const alternates = join(ledgerDir, 'objects', 'info', 'alternates')
    await mkdir(dirname(alternates), { recursive: true })
    await writeFile(alternates, join(gitDirPath, 'objects') + '\n')
  }
  return ledger
}

// Build a git tree from an in-memory payload without touching any working tree.
//
// payload: { 'relative/path.json': <object|string>, ... }
//
// We materialize into a temp dir and let `git add -A` hash everything in one
// process. That handles nested paths natively (git mktree is single-level only)
// and is far faster than spawning hash-object per file. Git's content addressing
// means unchanged analysis yields identical blob SHAs, so a snapshot whose files
// mostly didn't change costs almost nothing on disk.
export async function writeTree(ledger, payload) {
  const stage = await mkdtemp(join(tmpdir(), 'gcb-stage-'))
  const indexFile = join(stage, '.gcb-index')
  try {
    const work = join(stage, 'tree')
    const dirs = new Set()
    const writes = []
    for (const [rel, value] of Object.entries(payload)) {
      const full = join(work, rel)
      const dir = dirname(full)
      if (!dirs.has(dir)) {
        dirs.add(dir)
        await mkdir(dir, { recursive: true })
      }
      writes.push(writeFile(full, typeof value === 'string' ? value : stringify(value)))
    }
    await Promise.all(writes)

    const env = { GIT_INDEX_FILE: indexFile, GIT_WORK_TREE: work }
    await ledger.run(['add', '-A', '--force', '.'], { env, cwd: work })
    return await ledger.run(['write-tree'], { env })
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

// Commit a payload into the ledger chain.
//
// Trailers make the ledger queryable straight from git, e.g.
//   git --git-dir=.git/gitcodebase/ledger.git log \
//       --format='%h %(trailers:key=Health-Score,valueonly)'
export async function commitSnapshot(ledger, { tree, parent, sourceCommit, sourceSubject, sourceRef, health, fileCount }) {
  const subject = `snapshot: ${sourceCommit.slice(0, 7)} ${sourceSubject ?? ''}`.trim()
  const message = [
    subject,
    '',
    `Source-Commit: ${sourceCommit}`,
    sourceRef ? `Source-Ref: ${sourceRef}` : null,
    `Analyzer-Version: ${ANALYZER_VERSION}`,
    health === null || health === undefined ? null : `Health-Score: ${health}`,
    fileCount === undefined ? null : `Files: ${fileCount}`,
  ]
    .filter((l) => l !== null)
    .join('\n')

  const args = ['commit-tree', tree]
  if (parent) args.push('-p', parent)
  return ledger.run(args, { stdin: message + '\n' })
}

export async function updateRef(ledger, ref, sha) {
  await ledger.run(['update-ref', ref, sha])
}

export async function headSnapshot(ledger) {
  return ledger.tryRun(['rev-parse', '--verify', '--quiet', MAIN_REF])
}

// Which source commits already have snapshots — so `scan` can skip them.
export async function analyzedCommits(ledger) {
  const out = await ledger.tryRun([
    'log',
    '--format=%(trailers:key=Source-Commit,valueonly)',
    MAIN_REF,
  ])
  if (!out) return new Set()
  return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean))
}

// The snapshot chain with its trailers parsed — powers the commit rail.
const SEP = '\x1e'
const FS = '\x1f'

export async function listSnapshots(ledger, { limit } = {}) {
  const fmt = [
    '%H',
    '%(trailers:key=Source-Commit,valueonly)',
    '%(trailers:key=Health-Score,valueonly)',
    '%(trailers:key=Files,valueonly)',
    '%aI',
    '%s',
  ].join(FS) + SEP
  const args = ['log', `--format=${fmt}`]
  if (limit) args.push(`--max-count=${limit}`)
  args.push(MAIN_REF)
  const out = await ledger.tryRun(args)
  if (!out) return []
  return out
    .split(SEP)
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map((row) => {
      const [sha, sourceCommit, health, files, date, subject] = row.split(FS)
      return {
        sha,
        sourceCommit: (sourceCommit || '').trim(),
        health: health && health.trim() ? Number(health.trim()) : null,
        files: files && files.trim() ? Number(files.trim()) : null,
        date,
        subject,
      }
    })
}

// Read one file out of a snapshot.
export async function readSnapshotFile(ledger, ref, path) {
  const out = await ledger.tryRun(['cat-file', 'blob', `${ref}:${path}`])
  return out === null ? null : JSON.parse(out)
}

export async function listSnapshotFiles(ledger, ref, prefix = '') {
  const out = await ledger.tryRun(['ls-tree', '-r', '--name-only', '-z', ref, prefix])
  return out ? out.split('\0').filter(Boolean) : []
}

// The money feature: which analyses changed between two snapshots.
export async function diffSnapshots(ledger, a, b, { nameOnly = false, paths = [] } = {}) {
  const args = ['diff', nameOnly ? '--name-status' : '--unified=1', a, b]
  if (paths.length) args.push('--', ...paths)
  return (await ledger.tryRun(args)) ?? ''
}
