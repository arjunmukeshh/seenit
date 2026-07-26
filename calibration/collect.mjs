#!/usr/bin/env node
// Collection: clone each corpus repo, analyze it, emit one row per file, delete.
//
// Emits JSONL rather than JSON so the run is resumable and a crash at repo 380
// does not discard 379 repos of work. Repos are removed immediately after
// analysis — only rows are kept, so peak disk is one repo, not the corpus.
//
// Clone depth is driven by stage, and the difference is large:
//   Stage A (percentiles)     -> --depth 1, current source only
//   Stage B (fix prediction)  -> --filter=blob:none, full history, blobs on demand
//
// Everything here reuses the shipped analyzer — the same code that produces the
// numbers users see. Reimplementing metrics for the study would calibrate
// something other than the product.

import { mkdtemp, rm, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { git, tryGit, listTree, readBlobsBatch } from '../lib/git.js'
import { isAnalyzable, isTestFile, languageFor } from '../lib/analyze/parser.js'
import { analyzeSource } from '../lib/analyze/index.js'
import { mineHistory, sampleForLabelling } from './history.mjs'

const exec = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const DATA = join(HERE, 'data')

const CLONE_TIMEOUT_MS = 300_000

async function clone(url, dest, { stage }) {
  const args = ['clone', '--quiet', '--single-branch', '--no-tags']
  if (stage === 'A') args.push('--depth', '1')
  else args.push('--filter=blob:none') // full history, blobs fetched on demand
  args.push(url, dest)
  await exec('git', args, { timeout: CLONE_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 })
}

// Per-file rows. Field names mirror the pre-registered model variables so the
// analysis script reads them directly without a translation layer.
function toRow(repo, facts, history, headEpoch) {
  const fns = facts.functions
  const record = history?.get(facts.path)
  const lineLengths = fns.length ? fns.map((f) => f.lines).sort((a, b) => a - b) : [0]

  return {
    project: repo.repository,
    ecosystem: repo.ecosystem,
    commit: repo.commit,
    path: facts.path,
    language: facts.language,

    // predictors under test
    loc: facts.loc,
    sloc: facts.sloc,
    maxCyclomatic: fns.length ? Math.max(...fns.map((f) => f.cyclomatic)) : 0,
    maxCognitive: fns.length ? Math.max(...fns.map((f) => f.cognitive)) : 0,
    maxNesting: fns.length ? Math.max(...fns.map((f) => f.maxNesting)) : 0,
    maxParams: fns.length ? Math.max(...fns.map((f) => f.params)) : 0,
    p90FunctionLines: lineLengths[Math.max(0, Math.ceil(0.9 * lineLengths.length) - 1)],
    functions: fns.length,
    commentRatio: facts.loc ? facts.commentLines / facts.loc : 0,
    crypticIdentifierRatio: crypticRatio(facts.identifiers),
    imports: facts.imports.length,
    exports: facts.exports.length,

    // outcome and exposure (null in Stage A, which has no history)
    commits: record?.commits ?? null,
    fixes: record?.fixes ?? null,
    ageDays: record ? Math.max(0, (headEpoch - record.firstTouch) / 86400) : null,
  }
}

// Mirrors lib/analyze/metrics/score.js so the study measures the shipped
// definition rather than a variant of it.
const IDIOMATIC = /^(i|j|k|n|x|y|z|id|db|fs|os|ok|to|on|up|at|by|of|in|is|el|ms|px|kb|mb)$/
function crypticRatio(identifiers) {
  if (!identifiers?.length) return 0
  const cryptic = identifiers.filter((id) => id.length <= 2 && !IDIOMATIC.test(id)).length
  return cryptic / identifiers.length
}

async function collectRepo(repo, { stage, maxFiles }) {
  const dir = await mkdtemp(join(tmpdir(), 'gcb-calib-'))
  const workdir = join(dir, 'repo')
  try {
    await clone(repo.repository, workdir, { stage })

    // Pinned SHA if reachable; a shallow single-branch clone may not contain it,
    // in which case we record what we actually analyzed rather than pretending.
    let commit = repo.commit
    const has = await tryGit(workdir, ['cat-file', '-e', `${repo.commit}^{commit}`])
    if (has === null) commit = await git(workdir, ['rev-parse', 'HEAD'])
    const analyzedAtPinned = commit === repo.commit

    const entries = (await listTree(workdir, commit)).filter(
      (e) => isAnalyzable(e.path) && !isTestFile(e.path),
    )
    if (!entries.length) return { rows: [], skipped: 'no analyzable files' }
    if (maxFiles && entries.length > maxFiles) {
      return { rows: [], skipped: `too many files (${entries.length})` }
    }

    let history = null
    let historyStats = null
    let headEpoch = Date.now() / 1000
    if (stage === 'B') {
      const mined = await mineHistory(workdir, { ref: commit })
      history = mined.files
      historyStats = { commits: mined.commits, fixCommits: mined.fixCommits }
      const epoch = await tryGit(workdir, ['log', '-1', '--format=%at', commit])
      if (epoch) headEpoch = Number(epoch)
    }

    const blobs = await readBlobsBatch(workdir, entries.map((e) => e.sha))
    const rows = []
    const functionRows = []
    for (const entry of entries) {
      const buf = blobs.get(entry.sha)
      if (!buf) continue
      const facts = await analyzeSource(entry.path, buf)
      if (!facts || facts.parseError) continue // a mis-parsed file yields junk metrics
      rows.push({ ...toRow(repo, facts, history, headEpoch), analyzedAtPinned })

      // Function-level rows, required because the thresholds being calibrated
      // are applied to the p90 of the FUNCTION distribution
      // (scoreComplexity in lib/analyze/metrics/score.js flatMaps every
      // function before taking a percentile). Calibrating them against a
      // per-file maximum would compare different quantities and set the
      // thresholds far too high.
      for (const fn of facts.functions) {
        functionRows.push({
          project: repo.repository,
          language: facts.language,
          cyclomatic: fn.cyclomatic,
          cognitive: fn.cognitive,
          nesting: fn.maxNesting,
          params: fn.params,
          lines: fn.lines,
        })
      }
    }
    return { rows, functionRows, historyStats, commit }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// -------------------------------------------------------------------- runner

async function main() {
  const args = process.argv.slice(2)
  const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`)
    return i === -1 ? fallback : args[i + 1]
  }
  const stage = flag('stage', 'A').toUpperCase()
  const limit = Number(flag('limit', 0))
  const maxFiles = Number(flag('max-files', 4000))
  const corpusPath = flag('corpus', join(HERE, 'corpus.json'))
  const outPath = join(DATA, `files-stage${stage}.jsonl`)
  const fnPath = join(DATA, `functions-stage${stage}.jsonl`)
  const statePath = join(DATA, `state-stage${stage}.json`)

  const corpus = JSON.parse(await readFile(corpusPath, 'utf8'))
  let repos = corpus.repos
  if (limit) repos = repos.slice(0, limit)

  await mkdir(DATA, { recursive: true })

  // Resume: skip repos already present in the output.
  const done = new Set()
  if (existsSync(statePath)) {
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    for (const p of state.completed ?? []) done.add(p)
  }

  const summary = { completed: [...done], failed: [], skipped: [], historyStats: {} }
  let rowCount = 0

  for (const [i, repo] of repos.entries()) {
    const label = repo.repository.replace('https://github.com/', '')
    if (done.has(repo.repository)) {
      process.stderr.write(`[${i + 1}/${repos.length}] ${label} — already done\n`)
      continue
    }
    process.stderr.write(`[${i + 1}/${repos.length}] ${label} … `)
    const started = Date.now()
    try {
      const { rows, functionRows, skipped, historyStats } = await collectRepo(repo, { stage, maxFiles })
      if (skipped) {
        summary.skipped.push({ repo: repo.repository, reason: skipped })
        process.stderr.write(`skipped (${skipped})\n`)
      } else {
        await appendFile(outPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
        if (functionRows.length) {
          await appendFile(fnPath, functionRows.map((r) => JSON.stringify(r)).join('\n') + '\n')
        }
        rowCount += rows.length
        if (historyStats) summary.historyStats[repo.repository] = historyStats
        process.stderr.write(`${rows.length} files in ${((Date.now() - started) / 1000).toFixed(1)}s\n`)
      }
      summary.completed.push(repo.repository)
    } catch (err) {
      summary.failed.push({ repo: repo.repository, error: err.message.slice(0, 200) })
      process.stderr.write(`FAILED (${err.message.slice(0, 60)})\n`)
    }
    await writeFile(statePath, JSON.stringify(summary, null, 2))
  }

  process.stderr.write(
    `\n${rowCount} rows written to ${outPath}\n` +
      `completed ${summary.completed.length} · skipped ${summary.skipped.length} · failed ${summary.failed.length}\n`,
  )
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}

export { collectRepo, toRow }
