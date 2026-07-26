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
import { formatHealth, formatSnapshotRow, colorsFor } from '../lib/format.js'

const args = process.argv.slice(2)
const command = args.find((a) => !a.startsWith('-')) ?? 'check'
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1] ?? true
}

const C = colorsFor(process.stdout.isTTY)

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

const printHealth = (health, dimensions, previous) =>
  console.log('\n' + formatHealth(health, dimensions, previous, { colors: C, bars: true }))

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
      console.log(formatSnapshotRow(s, prev, { colors: C }))
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

  // Continuous background review — the tweet's core ask.
  async watch() {
    const { root, ledger, cache } = await open()
    const { watchRepo, verdict } = await import('../lib/watch.js')
    console.log(`${C.dim}watching ${root} — ctrl-c to stop${C.reset}\n`)

    let first = true
    watchRepo(root, {
      ledger,
      cache,
      onResult: (result) => {
        const line = verdict(result, result.previous?.overall)
        const time = new Date().toLocaleTimeString()
        console.log(`${C.dim}${time}${C.reset}  ${line}`)
        if (first) {
          first = false
          console.log(`${C.dim}       ${result.fileCount} files · comparing against last snapshot${C.reset}`)
        }
      },
      onError: (err) => console.error(`${C.red}watch:${C.reset} ${err.message}`),
    })
  },

  // Designed for a Claude Code Stop hook: one line, silent when nothing moved.
  // Prints to stderr so it surfaces without being captured as tool output.
  async hook() {
    const { root, ledger, cache } = await open()
    const { verdict } = await import('../lib/watch.js')
    const [result, changes, snaps] = await Promise.all([
      analyzeWorkspace(root, { cache }),
      workingChanges(root),
      listSnapshots(ledger, { limit: 1 }),
    ])
    await cache.flush()

    const previous = snaps.length ? await readSnapshotFile(ledger, snaps[0].sha, 'health.json') : null
    const delta = previous?.overall != null ? result.health - previous.overall : null

    // Stay quiet unless something actually moved — a hook that prints on every
    // turn is one the user stops reading.
    const quiet = flag('quiet', false) !== false
    if (quiet && (delta === null || Math.abs(delta) < 0.5)) return

    console.error(verdict({ ...result, changes }, previous?.overall))
  },

  async mcp() {
    const { startServer } = await import('../mcp/server.js')
    await startServer()
  },

  async serve() {
    const { startServer } = await import('../server/index.js')
    const port = Number(flag('port', 4300))
    const { url, root } = await startServer({ port })
    console.log(`${C.bold}gitcodebase${C.reset} observatory for ${C.dim}${root}${C.reset}`)
    console.log(`  ${url}\n`)
    if (flag('open', true) !== 'false') {
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
      const { execFile } = await import('node:child_process')
      execFile(opener, [url], () => {}) // best effort; headless environments have no opener
    }
  },

  help() {
    console.log(`
${C.bold}gitcodebase${C.reset} — a git-native code observatory

  ${C.bold}gitcodebase${C.reset}                 measure health now, including uncommitted work
  ${C.bold}gitcodebase scan${C.reset}            snapshot HEAD into the ledger
  ${C.bold}gitcodebase backfill${C.reset}        build health history from past commits  ${C.dim}[--limit 50]${C.reset}
  ${C.bold}gitcodebase log${C.reset}             health over time, as a git-like rail
  ${C.bold}gitcodebase diff${C.reset}            what changed about the codebase's health
  ${C.bold}gitcodebase watch${C.reset}           continuously review changes in the background
  ${C.bold}gitcodebase serve${C.reset}           open the observatory UI  ${C.dim}[--port 4300]${C.reset}
  ${C.bold}gitcodebase mcp${C.reset}             run as an MCP server for coding agents
  ${C.bold}gitcodebase hook${C.reset}            one-line verdict, for a Claude Code Stop hook

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
