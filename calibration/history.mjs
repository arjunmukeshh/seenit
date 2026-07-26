// Fix-commit and exposure mining.
//
// Produces, per file: how many commits touched it, how many of those look like
// fixes, and how old it is. The fix count is the study's outcome variable and
// the commit count is its exposure — see calibration/PREREGISTRATION.md §5.
//
// This is the weakest link in the whole design and is treated as such. Research
// on SZZ finds only about half of commits identified as bug-fixing genuinely
// are. `sampleForLabelling` exists so the false-positive rate gets measured and
// published rather than assumed away.

import { tryGit } from '../lib/git.js'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

// Frozen at pre-registration. Word-boundaried to avoid matching "prefix",
// "bugle", "dispatch" and similar. Changing this after collection begins would
// invalidate the pre-registration.
export const FIX_PATTERN = /\b(fix(e[sd])?|bug|hotfix|patch|resolv(e|es|ed)|regression|revert)\b/i

const SEP = '\x1e'
const FIELD = '\x1f'

// Environment for history walks over a partial (--filter=blob:none) clone.
//
// Without this, `git log --name-only` aborts on larger repositories with
// "could not fetch ... from promisor remote": walking the log triggers lazy
// object fetches, and when one fails git kills the whole command. It failed
// silently in the sense that tryGit returned null and the repo simply recorded
// zero history — 5 of 20 Stage B repos, and every one of the large ones, so the
// loss was heavily biased toward exactly the projects with the most history.
//
// GIT_NO_LAZY_FETCH is safe here because blobless clones retain every tree, and
// --name-only needs only trees. The commit-graph is disabled too: the failures
// reported objects "in the commit graph file but not in the object database",
// so a stale graph was part of it.
const HISTORY_ENV = { GIT_NO_LAZY_FETCH: '1' }
const HISTORY_CONFIG = ['-c', 'core.commitGraph=false']

// One `git log` walk yields commits, fix commits and first/last touch per file.
// Merges are excluded: they touch everything and would swamp the signal.
//
// Streamed line by line rather than buffered. A repository with tens of
// thousands of commits produces a `--name-only` log far too large to hold as a
// single string — at full-corpus scale that is the difference between a bounded
// footprint and exhausting memory on the largest repo in the sample. Only the
// per-path aggregate is retained, which is bounded by file count, not history
// length.
export async function mineHistory(repoRoot, { ref = 'HEAD', maxCommits = 20_000 } = {}) {
  const args = [
    ...HISTORY_CONFIG,
    'log',
    `--max-count=${maxCommits}`,
    '--no-merges',
    '--name-only',
    `--format=${SEP}%H${FIELD}%at${FIELD}%s`,
    ref,
  ]

  const files = new Map()
  let commits = 0
  let fixCommits = 0
  let timestamp = 0
  let isFix = false

  const child = spawn('git', args, {
    cwd: repoRoot,
    env: { ...process.env, ...HISTORY_ENV },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stderr = ''
  child.stderr.on('data', (chunk) => {
    // Keep only the tail; a failing walk can emit a great deal of output.
    stderr = (stderr + chunk).slice(-2000)
  })

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  for await (const line of lines) {
    if (line.startsWith(SEP)) {
      // Commit header: SEP<sha>FIELD<epoch>FIELD<subject>
      const [sha, epoch, subject = ''] = line.slice(1).split(FIELD)
      if (!sha) continue
      timestamp = Number(epoch)
      isFix = FIX_PATTERN.test(subject)
      commits++
      if (isFix) fixCommits++
      continue
    }
    const path = line.trim()
    if (!path) continue

    let record = files.get(path)
    if (!record) {
      files.set(path, (record = { commits: 0, fixes: 0, firstTouch: timestamp, lastTouch: timestamp }))
    }
    record.commits++
    if (isFix) record.fixes++
    // git log walks newest-first, so the oldest timestamp arrives last.
    if (timestamp < record.firstTouch) record.firstTouch = timestamp
    if (timestamp > record.lastTouch) record.lastTouch = timestamp
  }

  const code = await new Promise((resolve) => child.on('close', resolve))
  // Distinguish "no history" from "the walk failed" — conflating them is what
  // let the promisor bug pass as a legitimate absence of data.
  if (code !== 0) return { files: new Map(), commits: 0, fixCommits: 0, failed: true, stderr }

  return { files, commits, fixCommits }
}

// Draw commits for manual labelling so the regex's false-positive rate can be
// measured. Returns both matches and non-matches: sampling only the matches
// would measure precision while saying nothing about recall.
export async function sampleForLabelling(repoRoot, { n = 30, ref = 'HEAD', seed = 1 } = {}) {
  const out = await tryGit(
    repoRoot,
    ['log', '--max-count=3000', '--no-merges', `--format=%H${FIELD}%s`, ref],
    { trim: false },
  )
  if (!out) return []

  const rows = out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, subject = ''] = line.split(FIELD)
      return { sha, subject, matched: FIX_PATTERN.test(subject) }
    })

  const matched = rows.filter((r) => r.matched)
  const unmatched = rows.filter((r) => !r.matched)

  // Deterministic draw so the labelled sample is reproducible.
  let a = seed >>> 0
  const random = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const draw = (pool, count) => {
    const copy = [...pool]
    const picked = []
    while (picked.length < Math.min(count, copy.length)) {
      picked.push(...copy.splice(Math.floor(random() * copy.length), 1))
    }
    return picked
  }

  return [
    ...draw(matched, Math.ceil(n / 2)).map((r) => ({ ...r, stratum: 'matched' })),
    ...draw(unmatched, Math.floor(n / 2)).map((r) => ({ ...r, stratum: 'unmatched' })),
  ]
}
