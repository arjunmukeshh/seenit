#!/usr/bin/env node
// gitcodebase CLI.
//
// Designed so the first command a user runs is `npx gitcodebase` with no
// install, no config and no signup. Nothing is written to the working tree —
// the ledger lives inside .git/ — so trying it costs nothing and leaves nothing
// behind to clean up.

import { repoRoot, gitDir, isRepo, resolveRef, revList, commitMeta, currentBranch } from '../lib/git.js'
import { openLedger, writeTree, commitSnapshot, updateRef, listSnapshots, analyzedCommits, readSnapshotFile, diffSnapshots, MAIN_REF } from '../lib/ledger.js'
import { openCache } from '../lib/cache.js'
import { analyzeCommit, analyzeWorkspace } from '../lib/analyze/index.js'
import { workingChanges } from '../lib/workspace.js'
import { grade } from '../lib/analyze/metrics/score.js'

const args = process.argv.slice(2)
const command = args.find((a) => !a.startsWith('-')) ?? 'check'
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1] ?? true
}

const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', reset: '\x1b[0m' }
  : { dim: '', bold: '', red: '', green: '', yellow: '', reset: '' }

const scoreColor = (s) => (s === null || s === undefined ? C.dim : s >= 80 ? C.green : s >= 60 ? C.yellow : C.red)

async function open() {
  const cwd = process.cwd()
  if (!(await isRepo(cwd))) {
    console.error(`${C.red}Not a git repository.${C.reset} gitcodebase stores analysis in git, so it needs one.`)
    console.error(`Run ${C.bold}git init${C.reset} first.`)
    process.exit(1)
  }
  const root = await repoRoot(cwd)
  const ledger = await openLedger(root, await gitDir(cwd))
  return { root, ledger, cache: openCache(ledger.dir) }
}

function printHealth(health, dimensions, previous) {
  const delta = previous?.overall != null ? health - previous.overall : null
  const arrow = delta === null ? '' : delta > 0.5 ? `${C.green} ▲ +${delta.toFixed(1)}${C.reset}` : delta < -0.5 ? `${C.red} ▼ ${delta.toFixed(1)}${C.reset}` : `${C.dim} (flat)${C.reset}`
  console.log(`\n${C.bold}HEALTH ${scoreColor(health)}${health?.toFixed(1) ?? 'n/a'}${C.reset} ${C.dim}(${grade(health)})${C.reset}${arrow}\n`)
  for (const [name, d] of Object.entries(dimensions)) {
    if (d.score === null || d.score === undefined) {
      console.log(`  ${name.padEnd(14)} ${C.dim}   n/a   ${d.reason ?? ''}${C.reset}`)
      continue
    }
    const prev = previous?.dimensions?.[name]?.score
    const dd = prev != null ? d.score - prev : null
    const mark = dd === null || Math.abs(dd) < 0.5 ? '' : dd > 0 ? `${C.green} +${dd.toFixed(1)}${C.reset}` : `${C.red} ${dd.toFixed(1)}${C.reset}`
    const bar = '█'.repeat(Math.round(d.score / 5)).padEnd(20, '·')
    console.log(`  ${name.padEnd(14)} ${scoreColor(d.score)}${d.score.toFixed(1).padStart(6)}${C.reset} ${C.dim}${bar}${C.reset}${mark}`)
  }
}

async function previousHealth(ledger) {
  const snaps = await listSnapshots(ledger, { limit: 1 })
  return snaps.length ? readSnapshotFile(ledger, snaps[0].sha, 'health.json') : null
}

const commands = {
  // Default: measure right now, including uncommitted work.
  async check() {
    const { root, ledger, cache } = await open()
    const [result, previous] = await Promise.all([analyzeWorkspace(root, { cache }), previousHealth(ledger)])
    await cache.flush()
    printHealth(result.health, result.dimensions, previous)
    console.log(`\n${C.dim}${result.fileCount} files analyzed${previous ? '' : ' · no history yet, run `gitcodebase scan`'}${C.reset}`)

    // Exit non-zero on regression so this works as a CI gate or git hook.
    const threshold = Number(flag('fail-under', 0))
    if (threshold && result.health < threshold) {
      console.error(`\n${C.red}health ${result.health.toFixed(1)} is below --fail-under ${threshold}${C.reset}`)
      process.exit(1)
    }
  },

  // Snapshot HEAD (or a range) into the ledger.
  async scan() {
    const { root, ledger, cache } = await open()
    const ref = flag('ref', 'HEAD')
    const head = await resolveRef(root, ref)
    if (!head) {
      console.error(`${C.red}cannot resolve ${ref}${C.reset}`)
      process.exit(1)
    }
    const done = await analyzedCommits(ledger)
    if (done.has(head)) {
      console.log(`${C.dim}${head.slice(0, 7)} already analyzed${C.reset}`)
      return
    }
    const meta = (await commitMeta(root, head, { limit: 1 }))[0]
    const { payload, health, fileCount } = await analyzeCommit(root, head, { cache })
    await cache.flush()

    const parent = await listSnapshots(ledger, { limit: 1 })
    const tree = await writeTree(ledger, payload)
    const snap = await commitSnapshot(ledger, {
      tree,
      parent: parent[0]?.sha ?? null,
      sourceCommit: head,
      sourceSubject: meta?.subject,
      sourceRef: await currentBranch(root),
      health,
      fileCount,
    })
    await updateRef(ledger, MAIN_REF, snap)
    console.log(`${C.green}✓${C.reset} snapshot ${snap.slice(0, 7)} for ${head.slice(0, 7)} — health ${health?.toFixed(1)} (${fileCount} files)`)
  },

  // Build health history from existing commits.
  //
  // The ledger chain must mirror source history order — a snapshot's parent is
  // the snapshot of the previous source commit — otherwise `log` and `diff`
  // report regressions backwards. Since `scan` may already have snapshotted HEAD
  // before any backfill ran, this rebuilds the chain in source order rather than
  // appending to whatever is there. Rebuilding is cheap: the blob-SHA cache
  // means no file is re-parsed, and identical analysis reuses identical git
  // objects, so the repeated work costs almost nothing.
  async backfill() {
    const { root, ledger, cache } = await open()
    const limit = Number(flag('limit', 50))
    const commits = await revList(root, flag('ref', 'HEAD'), { limit }) // oldest first
    if (!commits.length) return console.log('No commits to analyze.')

    const existing = await listSnapshots(ledger)
    const existingOrder = [...existing].reverse().map((s) => s.sourceCommit)
    const inOrder =
      existingOrder.length <= commits.length &&
      existingOrder.every((sha, i) => sha === commits[i])

    const todo = inOrder ? commits.slice(existingOrder.length) : commits
    if (!todo.length) return console.log('Nothing to backfill — history is up to date.')
    if (!inOrder && existing.length) {
      console.log(`${C.dim}rebuilding chain in source order (${existing.length} existing snapshots out of order)${C.reset}`)
    }

    console.log(`Backfilling ${todo.length} commit(s)…`)
    let parent = inOrder ? existing[0]?.sha ?? null : null
    let i = 0
    for (const sha of todo) {
      const meta = (await commitMeta(root, sha, { limit: 1 }))[0]
      const { payload, health, fileCount } = await analyzeCommit(root, sha, { cache })
      const tree = await writeTree(ledger, payload)
      parent = await commitSnapshot(ledger, {
        tree, parent, sourceCommit: sha, sourceSubject: meta?.subject, health, fileCount,
      })
      i++
      process.stdout.write(`\r  ${i}/${todo.length}  ${sha.slice(0, 7)} health ${health?.toFixed(1) ?? '—'}   `)
    }
    // Move the ref once, at the end — an interrupted backfill leaves the old
    // chain intact rather than a half-built one.
    await updateRef(ledger, MAIN_REF, parent)
    await cache.flush()
    console.log(`\n${C.green}✓${C.reset} backfilled ${i} snapshots`)
  },

  // The history of the codebase's health, rendered as a git-like rail.
  async log() {
    const { ledger } = await open()
    const snaps = await listSnapshots(ledger, { limit: Number(flag('limit', 20)) })
    if (!snaps.length) return console.log('No snapshots yet. Run `gitcodebase scan` or `gitcodebase backfill`.')
    console.log()
    let prev = null
    for (const s of [...snaps].reverse()) {
      const d = prev === null || s.health === null ? null : s.health - prev
      const mark = d === null ? ' ' : d > 0.5 ? `${C.green}▲${C.reset}` : d < -0.5 ? `${C.red}▼${C.reset}` : `${C.dim}·${C.reset}`
      const bar = s.health === null ? '' : '█'.repeat(Math.round(s.health / 5))
      console.log(
        `  ${mark} ${C.dim}${s.sourceCommit.slice(0, 7)}${C.reset} ` +
        `${scoreColor(s.health)}${String(s.health?.toFixed(1) ?? '—').padStart(5)}${C.reset} ` +
        `${C.dim}${bar.padEnd(20, '·')}${C.reset}  ${(s.subject ?? '').replace(/^snapshot: \w+ /, '').slice(0, 50)}`,
      )
      prev = s.health
    }
    console.log()
  },

  // The money demo: read a health regression straight out of a git diff.
  async diff() {
    const { ledger } = await open()
    const snaps = await listSnapshots(ledger, { limit: 2 })
    if (snaps.length < 2) return console.log('Need at least two snapshots to diff.')
    const [b, a] = snaps
    console.log(`${C.dim}diffing analysis of ${a.sourceCommit.slice(0, 7)} → ${b.sourceCommit.slice(0, 7)}${C.reset}\n`)
    const out = await diffSnapshots(ledger, a.sha, b.sha, { paths: [flag('path', '')].filter(Boolean) })
    console.log(out || '(no change in analysis)')
  },

  async mcp() {
    const { startServer } = await import('../mcp/server.js')
    await startServer()
  },

  help() {
    console.log(`
${C.bold}gitcodebase${C.reset} — a git-native code observatory

  ${C.bold}gitcodebase${C.reset}                 measure health now, including uncommitted work
  ${C.bold}gitcodebase scan${C.reset}            snapshot HEAD into the ledger
  ${C.bold}gitcodebase backfill${C.reset}        build health history from past commits  ${C.dim}[--limit 50]${C.reset}
  ${C.bold}gitcodebase log${C.reset}             health over time, as a git-like rail
  ${C.bold}gitcodebase diff${C.reset}            what changed about the codebase's health
  ${C.bold}gitcodebase mcp${C.reset}             run as an MCP server for coding agents

${C.dim}Analysis is stored in .git/gitcodebase/ledger.git — a real git repo, so you can
run log, diff, blame and bisect against your codebase's health directly.
Nothing is written to your working tree.${C.reset}
`)
  },
}

const run = commands[command] ?? commands.help
run().catch((err) => {
  console.error(`${C.red}gitcodebase:${C.reset} ${err.message}`)
  process.exit(1)
})
