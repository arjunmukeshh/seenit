#!/usr/bin/env node
// seenit CLI. `seenit` lists duplicated regions; `seenit check` tests one
// snippet against the repository. The working tree is never written to.

import { readFile } from 'node:fs/promises'

import { repoRoot, isRepo, trackedFiles } from '../lib/git.js'
import { detectNormalized, JSCPD_DEFAULT_MIN_TOKENS } from '../lib/jscpd.js'
import { clusterBlocks } from '../lib/cluster.js'
import { findExisting, guessLanguage } from '../lib/find.js'

const args = process.argv.slice(2)
const command = args[0] && !args[0].startsWith('-') ? args[0] : 'default_'

const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1] ?? true
}

const FLAGS = {
  default_: ['min-tokens', 'limit'],
  check: ['file', 'min-tokens'],
  mcp: [],
  hook: ['min-tokens'],
  prime: [],
  help: [],
}

// Report unknown flags rather than ignoring them.
function validateFlags(name) {
  const allowed = new Set(FLAGS[name] ?? [])
  const unknown = args
    .filter((a) => a.startsWith('--'))
    .map((a) => a.slice(2).split('=')[0])
    .filter((f) => !allowed.has(f) && f !== 'help')
  if (!unknown.length) return
  console.error(`${C.red}seenit ${name === 'default_' ? '' : name}:${C.reset} unknown flag ${unknown.map((f) => `--${f}`).join(', ')}`)
  console.error(allowed.size ? `Accepts: ${[...allowed].map((f) => `--${f}`).join(', ')}` : 'This command takes no flags.')
  process.exit(1)
}

// A tty gets colour; NO_COLOR and FORCE_COLOR override it.
const ANSI = { dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', reset: '\x1b[0m' }
const PLAIN = { dim: '', bold: '', red: '', green: '', reset: '' }
const C = process.env.NO_COLOR
  ? PLAIN
  : process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0'
    ? ANSI
    : process.stdout.isTTY
      ? ANSI
      : PLAIN

async function open() {
  const cwd = process.cwd()
  if (!(await isRepo(cwd))) {
    console.error(`${C.red}Not a git repository.${C.reset} seenit reads the tracked file list from git.`)
    console.error(`Run ${C.bold}git init${C.reset} first.`)
    process.exit(1)
  }
  return repoRoot(cwd)
}

const minTokens = () => Number(flag('min-tokens', JSCPD_DEFAULT_MIN_TOKENS))

const commands = {
  // Duplicated regions in the repository.
  async default_() {
    const root = await open()
    const files = await trackedFiles(root)
    // Cached, so a second run costs only the files that changed — and so the
    // hook is already warm once anyone has run this.
    const blocks = await detectNormalized(root, files, { minTokens: minTokens(), cache: true })

    console.log()
    if (!blocks.length) {
      console.log(`  ${C.green}Nothing duplicated.${C.reset} ${C.dim}${files.length} files checked.${C.reset}`)
      console.log(`\n  ${C.dim}Check a snippet before writing it:  seenit check --file draft.js${C.reset}\n`)
      return
    }

    // Findings, not pairs: one file copied six times produces fifteen pairs.
    const groups = clusterBlocks(blocks)
    const limit = Number(flag('limit', 3))
    console.log(`  ${C.bold}Duplicated${C.reset}\n`)
    for (const g of groups.slice(0, limit)) {
      console.log(`  ${C.bold}${g.a}${C.reset}${C.dim}:${g.aStart}-${g.aEnd}${C.reset}`)
      console.log(`  ${C.bold}${g.b}${C.reset}${C.dim}:${g.bStart}-${g.bEnd}${C.reset}`)
      console.log(`    ${C.dim}${g.lines} lines${g.others.length ? `, and ${g.others.length} more file${g.others.length === 1 ? '' : 's'}` : ''}${C.reset}`)
      console.log()
    }
    if (groups.length > limit) {
      console.log(`  ${C.dim}${groups.length - limit} more.${C.reset}\n`)
    }
    console.log(`  ${C.dim}Check a snippet before writing it:  seenit check --file draft.js${C.reset}\n`)
  },

  // Check one snippet, read from --file or stdin.
  async check() {
    const root = await open()
    const file = flag('file', null)
    const code = file ? await readFile(file, 'utf8') : await readStdin()

    if (!code || code.trim().length < 20) {
      console.error(`${C.red}seenit check:${C.reset} pass the code to check, via --file or stdin.`)
      console.error(`  seenit check --file draft.js`)
      console.error(`  cat draft.js | seenit check`)
      process.exit(1)
    }

    const hits = await findExisting(root, code, {
      minTokens: minTokens(),
      language: guessLanguage(code, file),
    })

    console.log()
    if (!hits.length) {
      console.log(`  ${C.green}No existing implementation.${C.reset} ${C.dim}Safe to write.${C.reset}\n`)
      return
    }
    console.log(`  ${C.bold}Already written${C.reset}\n`)
    for (const h of hits) {
      console.log(`  ${C.bold}${h.file}${C.reset}${C.dim}:${h.startLine}-${h.endLine}${C.reset}  ${C.dim}${h.lines} lines shared${C.reset}`)
    }
    console.log()
    // Non-zero so this can gate a hook or script.
    process.exit(1)
  },

  async mcp() {
    const { startServer } = await import('../mcp/server.js')
    await startServer()
  },

  // PreToolUse hook. Reads the tool call on stdin and warns when the code about
  // to be written is already in the repository.
  async hook() {
    const { runHook } = await import('../lib/hook.js')
    const message = await runHook({ minTokens: minTokens() })
    if (message) {
      // additionalContext reaches the model without blocking the write. Exiting
      // non-zero here would block it, which this hook deliberately does not do.
      console.log(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: message },
        }),
      )
    }
    // Exit rather than return. On a cold cache the scan outlives its own time
    // budget, and returning leaves that work pending: the hook gave up waiting
    // at five seconds but the process still sat there for forty-two on a
    // 17,000-file repository, stalling the write it had already cleared.
    process.exit(0)
  },

  // Build the cache without a time budget, so the hook is fast from its first
  // write. Worth running once per repository; `seenit` warms it too.
  async prime() {
    const root = await open()
    const files = await trackedFiles(root)
    const { syncShadow } = await import('../lib/shadow.js')
    const started = Date.now()
    const s = await syncShadow(root, files)
    const secs = ((Date.now() - started) / 1000).toFixed(1)
    console.log(
      `\n  ${C.green}Ready.${C.reset} ${C.dim}${s.rebuilt} normalised, ${s.reused} reused${s.failed ? `, ${s.failed} unreadable` : ''} in ${secs}s${C.reset}\n`,
    )
  },

  help() {
    console.log(`
${C.bold}seenit${C.reset} — has this already been written?

  ${C.bold}npx seenit${C.reset}                    what is already duplicated  ${C.dim}[--limit 3]${C.reset}
  ${C.bold}seenit check --file f.js${C.reset}      does this code exist yet?  ${C.dim}(exits 1 if it does)${C.reset}
  ${C.bold}seenit mcp${C.reset}                    run as an MCP server, so your agent asks before writing
  ${C.bold}seenit hook${C.reset}                   run as a pre-write hook, so it does not have to ask
  ${C.bold}seenit prime${C.reset}                  normalise the repository up front, so the hook is fast

${C.dim}Matches renamed and reformatted copies, not just exact ones.
Nothing is written to your working tree.

  --min-tokens ${JSCPD_DEFAULT_MIN_TOKENS}   how much shared code counts as a duplicate
  --limit 3        findings to show
  --file PATH      read the snippet from a file instead of stdin${C.reset}
`)
  },
}

const readStdin = async () => {
  if (process.stdin.isTTY) return ''
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

if (!commands[command]) {
  console.error(`${C.red}seenit:${C.reset} unknown command "${command}"`)
  commands.help()
  process.exit(1)
}

const run = args.includes('--help') || args.includes('-h') ? commands.help : commands[command]
if (run !== commands.help) validateFlags(command)

// Promise.resolve, not run().catch — `help` is sync and returns undefined.
Promise.resolve()
  .then(run)
  .catch((err) => {
    console.error(`${C.red}seenit:${C.reset} ${err.message}`)
    process.exit(1)
  })
