#!/usr/bin/env node
// seenit CLI.
//
// Designed so the first command a user runs is `npx seenit` with no
// install, no config and no signup. Nothing is written to the working tree —
// the ledger lives inside .git/ — so trying it costs nothing and leaves nothing
// behind to clean up.

import { repoRoot, gitDir, isRepo, resolveRef, revList, commitMeta, currentBranch } from '../lib/git.js'
import { openLedger, writeTree, commitSnapshot, updateRef, listSnapshots, analyzedCommits, readSnapshotFile, diffSnapshots, MAIN_REF, ANALYZER_VERSION } from '../lib/ledger.js'
import { openCache } from '../lib/cache.js'
import { analyzeCommit, analyzeWorkspace } from '../lib/analyze/index.js'
import { workingChanges } from '../lib/workspace.js'
import { formatHealth, formatSnapshotRow, colorsFor } from '../lib/format.js'
import { normalizeStoredHealth } from '../lib/analyze/metrics/score.js'

const args = process.argv.slice(2)

// Only the first token can be the command. Scanning for "the first argument
// without a dash" instead made `seenit --port 4300` read 4300 as the
// command and silently fall through to help.
const command = args[0] && !args[0].startsWith('-') ? args[0] : 'default_'

const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1] ?? true
}

// Flags each command accepts. Anything else is a typo worth reporting: silently
// ignoring `--json` and printing the default output looks like the flag worked.
const FLAGS = {
  default_: [],
  health: ['fail-under'],
  check: ['fail-under'], // alias, kept so existing CI gates keep working
  scan: ['ref'],
  backfill: ['limit', 'ref'],
  log: ['limit'],
  diff: ['path'],
  watch: [],
  hook: ['quiet'],
  serve: ['port', 'open'],
  mcp: [],
  help: ['all'],
}

function validateFlags(name) {
  const allowed = new Set(FLAGS[name] ?? [])
  const passed = args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')[0])
  const unknown = passed.filter((f) => !allowed.has(f) && f !== 'help')
  if (!unknown.length) return

  console.error(`${C.red}seenit ${name}:${C.reset} unknown flag ${unknown.map((f) => `--${f}`).join(', ')}`)
  console.error(allowed.size ? `Accepts: ${[...allowed].map((f) => `--${f}`).join(', ')}` : 'This command takes no flags.')
  process.exit(1)
}

const C = colorsFor(process.stdout.isTTY)

async function open() {
  const cwd = process.cwd()
  if (!(await isRepo(cwd))) {
    console.error(`${C.red}Not a git repository.${C.reset} seenit stores analysis in git, so it needs one.`)
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
  if (!snaps.length) return null
  return normalizeStoredHealth(await readSnapshotFile(ledger, snaps[0].sha, 'health.json'), ANALYZER_VERSION)
}

const commands = {
  // THE DEFAULT. One job: has this already been written?
  //
  // Everything else this tool can do still works and is still shipped — health
  // scoring, the ledger, the observatory UI, the module DAG — but it is not
  // what someone typing `npx seenit` for the first time should meet. They get
  // the answer to one question, in under a second, on a repository they have
  // never scanned.
  async default_() {
    const { root, cache } = await open()
    const result = await analyzeWorkspace(root, { cache })
    await cache.flush()

    const dup = result.dimensions.duplication
    const findings = dup?.groups ?? []

    console.log()
    if (!findings.length) {
      console.log(`  ${C.green}Nothing duplicated.${C.reset} ${C.dim}${result.productFiles} files checked.${C.reset}`)
      console.log(`\n  ${C.dim}Check before writing, not after:  seenit mcp${C.reset}\n`)
      return
    }

    // Findings, not pairs, and three of them. One file copied into six places
    // produces fifteen pairs of the same fact; a wall of those is the violation
    // wall this tool exists not to be.
    const shown = findings.slice(0, 3)
    console.log(`  ${C.bold}Closest matches${C.reset}\n`)
    for (const g of shown) {
      const at = g.anchor.samples?.[0]
      console.log(`  ${C.bold}${g.anchor.a}${C.reset}${at ? `${C.dim}:${at.aLine}${C.reset}` : ''}`)
      console.log(`  ${C.bold}${g.anchor.b}${C.reset}${at ? `${C.dim}:${at.bLine}${C.reset}` : ''}`)
      if (g.fileCount > 2) {
        console.log(`    ${C.dim}and ${g.fileCount - 2} more file${g.fileCount === 3 ? '' : 's'} sharing this shape${C.reset}`)
      }
      console.log()
    }

    if (dup.groupCount > shown.length) {
      console.log(
        `  ${C.dim}${dup.groupCount - shown.length} more, ` +
          `${dup.filesInvolved} of ${result.productFiles} files involved.${C.reset}`,
      )
      console.log()
    }

    // Identifiers are normalized before fingerprinting, so this is not a text
    // search — say so, because "why didn't grep find this" is the first
    // question anyone asks.
    //
    // No hit rate is quoted here. It used to say "~7 in 8 are real", which was
    // the 88% figure from choosing a cutoff and scoring it on the same thirty
    // cases. The README retracted that number; a claim retracted in one place
    // and printed in another is worse than never having made it.
    console.log(
      `  ${C.dim}Identifiers and literals are normalized before matching, so renamed\n` +
        `  copies count and grep would not find these. Ranked by longest aligned run.${C.reset}`,
    )
    console.log(`\n  ${C.dim}Check before writing, not after:  seenit mcp${C.reset}\n`)
  },

  // The full health report. Was the default; now one command among several.
  async health() {
    const { root, ledger, cache } = await open()
    const [result, previous] = await Promise.all([analyzeWorkspace(root, { cache }), previousHealth(ledger)])
    await cache.flush()
    printHealth(result.health, result.dimensions, previous)
    // Say what the score is actually based on. Tests are analyzed but excluded
    // from scoring, and on repositories that are mostly fixtures the difference
    // is the whole story.
    const scored =
      result.testFiles > 0
        ? `${result.fileCount} files analyzed · ${result.productFiles} scored, ${result.testFiles} tests excluded`
        : `${result.fileCount} files analyzed`
    console.log(`\n${C.dim}${scored}${previous ? '' : ' · no history yet, run `seenit scan`'}${C.reset}`)

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
    if (!snaps.length) return console.log('No snapshots yet. Run `seenit scan` or `seenit backfill`.')
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
    console.log(`${C.bold}seenit${C.reset} observatory for ${C.dim}${root}${C.reset}`)
    console.log(`  ${url}\n`)
    if (flag('open', true) !== 'false') {
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
      const { execFile } = await import('node:child_process')
      execFile(opener, [url], () => {}) // best effort; headless environments have no opener
    }
  },

  // `check` predates the rename and the re-scope. Kept as an alias because it
  // is the command anyone's CI gate already runs.
  async check() {
    return commands.health()
  },

  help() {
    const all = args.includes('--all')
    console.log(`
${C.bold}seenit${C.reset} — has this already been written?

  ${C.bold}npx seenit${C.reset}            find near-duplicate code, including renamed copies
  ${C.bold}seenit mcp${C.reset}            run as an MCP server so your agent checks before it writes
`)
    if (!all) {
      console.log(`${C.dim}seenit also tracks repository health over time, version-controlled in git.
Run \`seenit help --all\` for those commands.${C.reset}
`)
      return
    }
    console.log(`${C.bold}Health and history${C.reset}

  ${C.bold}seenit health${C.reset}         full health report  ${C.dim}[--fail-under 70]${C.reset}
  ${C.bold}seenit scan${C.reset}           snapshot HEAD into the ledger
  ${C.bold}seenit backfill${C.reset}       build health history from past commits  ${C.dim}[--limit 50]${C.reset}
  ${C.bold}seenit log${C.reset}            health over time, as a git-like rail
  ${C.bold}seenit diff${C.reset}           what changed about the codebase's health
  ${C.bold}seenit watch${C.reset}          continuously review changes in the background
  ${C.bold}seenit serve${C.reset}          open the observatory UI  ${C.dim}[--port 4300]${C.reset}
  ${C.bold}seenit hook${C.reset}           one-line verdict, for a Claude Code Stop hook

${C.dim}Analysis is stored in .git/seenit/ledger.git — a real git repo, so you can
run log, diff, blame and bisect against your codebase's health directly.
Nothing is written to your working tree.${C.reset}
`)
  },
}

if (!commands[command]) {
  console.error(`${C.red}seenit:${C.reset} unknown command "${command}"`)
  commands.help()
  process.exit(1)
}

const run = args.includes('--help') || args.includes('-h') ? commands.help : commands[command]
if (run !== commands.help) validateFlags(command)

// Promise.resolve, not run().catch: `help` is synchronous and returns
// undefined, so calling .catch on its result crashed the CLI immediately after
// printing the help text. It looked fine in a pipe and failed for every user
// who ran `seenit help` on its own.
Promise.resolve()
  .then(run)
  .catch((err) => {
    console.error(`${C.red}seenit:${C.reset} ${err.message}`)
    process.exit(1)
  })
