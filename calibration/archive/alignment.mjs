// Corpus distribution of the duplication alignment signal.
//
// MIN_ALIGNED was set from the same 30 hand-labelled cases it was evaluated on,
// which is precisely the circularity the threshold study in PREREGISTRATION.md
// exists to avoid. Precision needs a human judgement per finding and cannot be
// scaled past a hundred cases; the DISTRIBUTION of aligned-run lengths needs no
// human at all, and is the same kind of quantity the complexity thresholds were
// set from (p75/p90/p99 of real code).
//
// So this measures what a threshold should actually be set from: across a
// random sample of the pinned corpus, how long are aligned runs, and where does
// the mass sit? A cutoff at the 99th percentile of all candidate pairs says
// "rarer than 99% of coincidental overlap", which is an argument. A cutoff
// fitted to thirty cases is a guess.
//
//   node calibration/alignment.mjs --repos 60 --concurrency 4
//
// Clones shallow, measures, deletes. Nothing is kept but the numbers.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { analyzeSource } from '../lib/analyze/index.js'
import { findClones } from '../lib/analyze/metrics/duplication.js'
import { isAnalyzable, isTestFile } from '../lib/analyze/parser.js'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`)
  return i === -1 ? d : args[i + 1]
}
const TARGET = Number(flag('repos', 60))
const CONCURRENCY = Number(flag('concurrency', 4))
const MAX_FILES = 1500 // keep a single huge repo from dominating the distribution

// Seeded so the sample is reproducible — same reason corpus.mjs is seeded.
function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

async function measure(repo, dir) {
  const files = (await run('git', ['-C', dir, 'ls-files'], { maxBuffer: 1 << 28 })).stdout
    .split('\n')
    .filter((f) => f && isAnalyzable(f) && !isTestFile(f))
    .slice(0, MAX_FILES)

  const facts = []
  for (const path of files) {
    try {
      const buf = await readFile(join(dir, path))
      if (buf.length > 2_000_000) continue
      const f = await analyzeSource(path, buf)
      if (f) facts.push({ ...f, path })
    } catch {
      // Unreadable file — skip it, the distribution does not need every file.
    }
  }
  if (facts.length < 5) return null

  // findClones already applies MIN_ALIGNED, which would truncate the very
  // distribution being measured. Recompute the raw aligned values instead.
  const index = new Map()
  for (const f of facts) {
    for (const [hash, line] of f.fingerprints ?? []) {
      let bucket = index.get(hash)
      if (!bucket) index.set(hash, (bucket = []))
      bucket.push({ path: f.path, line })
    }
  }
  const maxFanout = Math.max(8, Math.ceil(facts.length * 0.25))
  const deltas = new Map()
  for (const bucket of index.values()) {
    if (bucket.length < 2 || bucket.length > maxFanout) continue
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const [a, b] = bucket[i].path < bucket[j].path ? [bucket[i], bucket[j]] : [bucket[j], bucket[i]]
        if (a.path === b.path) continue
        const key = `${a.path} ${b.path}`
        let d = deltas.get(key)
        if (!d) deltas.set(key, (d = new Map()))
        const k = a.line - b.line
        d.set(k, (d.get(k) ?? 0) + 1)
      }
    }
  }

  const aligned = [...deltas.values()].map((d) => Math.max(0, ...d.values()))
  return { repo: repo.repository, ecosystem: repo.ecosystem, files: facts.length, aligned }
}

async function one(repo) {
  const dir = await mkdtemp(join(tmpdir(), 'seenit-align-'))
  try {
    await run('git', ['clone', '--depth', '1', '--quiet', repo.repository, dir], { timeout: 180_000 })
    return await measure(repo, dir)
  } catch {
    return null // unreachable, moved, or too slow — the sample tolerates gaps
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const corpus = JSON.parse(await readFile(join(HERE, 'corpus.json'), 'utf8'))
const repos = corpus.repos ?? corpus
const rng = mulberry32(20260727)
const shuffled = [...repos].sort(() => rng() - 0.5).slice(0, TARGET)

const results = []
let done = 0
async function worker(queue) {
  while (queue.length) {
    const repo = queue.pop()
    const r = await one(repo)
    done++
    if (r) results.push(r)
    process.stderr.write(`\r  ${done}/${shuffled.length} repos · ${results.length} measured`)
  }
}
const queue = [...shuffled]
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)))
process.stderr.write('\n')

// AGGREGATE PER REPOSITORY, NOT PER PAIR.
//
// Pooling every candidate pair lets one repository decide the answer. In the
// first run of this script, extract-pg-schema contributed 31,382 of 45,416
// pairs — 69% — because it holds a few hundred mutually-similar generated
// files, and the pooled histogram spiked at exactly its alignment value. The
// "distribution of real code" was one repository wearing a crowd's clothes.
//
// This is the same hazard the threshold study handled with cluster-robust
// standard errors: the unit of independent observation is the repository, not
// the pair. So each repo yields one number and repos are weighted equally.
const perRepo = results
  .filter((r) => r.aligned.length > 0)
  .map((r) => {
    const sorted = [...r.aligned].sort((a, b) => a - b)
    const q = (p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
    return {
      repo: r.repo,
      ecosystem: r.ecosystem,
      files: r.files,
      pairs: sorted.length,
      p99: q(99),
      // Share of this repo's candidate pairs that a given cutoff would keep.
      keptAt: Object.fromEntries(
        [5, 7, 9, 12, 15, 20, 30].map((t) => [t, Number((sorted.filter((v) => v >= t).length / sorted.length).toFixed(4))]),
      ),
    }
  })

const across = (pick) => {
  const vals = perRepo.map(pick).sort((a, b) => a - b)
  const q = (p) => vals[Math.min(vals.length - 1, Math.ceil((p / 100) * vals.length) - 1)] ?? 0
  return { median: q(50), p75: q(75), p90: q(90), max: vals[vals.length - 1] ?? 0 }
}

const summary = {
  measuredAt: new Date().toISOString().slice(0, 10),
  method: 'One observation per repository, weighted equally. Pooling pairs let a single repo contribute 69% of the mass.',
  reposMeasured: perRepo.length,
  reposRequested: shuffled.length,
  reposWithNoCandidates: results.length - perRepo.length,
  totalCandidatePairs: perRepo.reduce((a, r) => a + r.pairs, 0),
  // Across repositories: what does the 99th percentile of coincidental overlap
  // look like in a typical codebase?
  p99AcrossRepos: across((r) => r.p99),
  // For each cutoff, the share of candidate pairs a typical repo would keep.
  keptByCutoff: Object.fromEntries(
    [5, 7, 9, 12, 15, 20, 30].map((t) => [t, across((r) => r.keptAt[t])]),
  ),
  mostPairs: perRepo.sort((a, b) => b.pairs - a.pairs).slice(0, 5).map((r) => ({ repo: r.repo, files: r.files, pairs: r.pairs, p99: r.p99 })),
}

await writeFile(join(HERE, 'results', 'alignment.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify(summary, null, 2))
