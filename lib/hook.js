// The pre-write hook.
//
// A tool the agent calls is only used when the agent thinks to use it, which is
// exactly not the moment it is needed — mid-task, focused on the diff, is when
// "has this been written already?" goes unasked. The hook removes that choice.
//
// It warns; it does not block. Two reasons, both measured on find_existing,
// which is what this calls:
//
//   - Recall is 0.84 on a verbatim copy and 0.74 once statements move. A thing
//     called a gate implies nothing gets past it. One in four to one in seven
//     does, and people stop looking once they believe something is enforced.
//   - Precision is 1.00 over 38 held-out repositories, CI [0.88, 1]. That is
//     what makes warning cheap — it is almost never wrong when it speaks. It is
//     not what would make blocking safe, because blocking is judged by the
//     misses, and those are one in four.
//
// Every exit is silent unless there is a match. A hook that talks during
// ordinary work gets removed.

import { isRepo, repoRoot } from './git.js'
import { findExisting, guessLanguage } from './find.js'
import { hasWarned, isPrimed, markWarned } from './shadow.js'

// Below this, matching cannot fire anyway: 30 tokens is roughly a dozen lines
// of real code, and checking a three-line edit costs more than it can return.
const MIN_LINES = 12

// Writes that are not source. The hook sees every write, including lockfiles
// and generated output, and should not spend a scan on them.
const SKIP_RE = /\.(json|lock|md|mdx|txt|rst|csv|svg|ya?ml|html?|xml|snap|min\.js|d\.ts)$/i

// If the scan cannot finish in this long, say nothing and let the write
// proceed. An agent stalled behind a linter is worse than a missed duplicate.
//
// Caching removes the normalising cost but not jscpd's, which compares every
// file against every other and takes about eight seconds on a 17,000-file
// repository. So past roughly ten thousand files the hook goes quiet even warm.
// SEENIT_BUDGET_MS raises the ceiling for anyone who would rather wait.
const BUDGET_MS = Number(process.env.SEENIT_BUDGET_MS) || 5_000

/**
 * Decide what to say about one intercepted write.
 *
 * Returns null to stay silent, or a message. Never throws: any failure here is
 * a failure to warn, not a reason to fail the write.
 */
export async function reviewWrite({ path, content, cwd, minTokens }) {
  if (!content || !path) return null
  if (SKIP_RE.test(path)) return null

  const lines = content.split('\n').filter((l) => l.trim()).length
  if (lines < MIN_LINES) return null

  if (!(await isRepo(cwd))) return null
  const root = await repoRoot(cwd)

  // Say so before scanning. On a cold cache the scan will not finish inside the
  // budget, and the hook's way of giving up is silence — the same silence that
  // means "nothing found". Someone installs the hook, sees nothing for a week,
  // and concludes their repository is clean.
  if (!(await isPrimed(root))) {
    // Once per repository. The hook fires on every write, and a line repeated
    // on every edit is noise — which is how a hook gets uninstalled.
    if (await hasWarned(root)) return null
    await markWarned(root)
    return `seenit: cache not primed for this repository, so this write was not checked. Run 'seenit prime' once and the hook starts working.`
  }

  const hits = await findExisting(root, content, {
    minTokens,
    language: guessLanguage(content, path),
    cache: true,
  })

  // Drop the file being written. An Edit resends a region that is already on
  // disk, so without this every edit to a long function reports that function
  // as a duplicate of itself.
  const rel = path.startsWith(root) ? path.slice(root.length + 1) : path
  const elsewhere = hits.filter((h) => h.file !== rel)
  if (!elsewhere.length) return null

  return [
    `seenit: this overlaps code already in the repository.`,
    ...elsewhere.slice(0, 3).map((h) => `  ${h.file}:${h.startLine}-${h.endLine}  (${h.lines} lines shared)`),
    `Reuse it, or continue if the duplication is deliberate.`,
  ].join('\n')
}

// Claude Code sends the tool call as JSON on stdin. Write carries `content`,
// Edit carries `new_string`; anything else is not a write and is ignored.
export function extractWrite(payload) {
  const name = payload?.tool_name
  const input = payload?.tool_input ?? {}
  if (name === 'Write') return { path: input.file_path, content: input.content }
  if (name === 'Edit') return { path: input.file_path, content: input.new_string }
  return null
}

/**
 * Read a hook payload from stdin, print any warning, and exit 0.
 *
 * Always exit 0. A non-zero exit from a PreToolUse hook blocks the tool call,
 * and this hook has no business doing that — see the note at the top.
 */
export async function runHook({ stdin, cwd = process.cwd(), minTokens } = {}) {
  let message = null
  try {
    const raw = stdin ?? (await readStdin())
    if (!raw.trim()) return null
    const write = extractWrite(JSON.parse(raw))
    if (!write) return null

    // The timer is cleared on the way out. Left pending it keeps the event
    // loop alive, and every hook invocation took the full budget in wall time
    // no matter how fast the scan was.
    let timer
    const budget = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), BUDGET_MS)
    })
    try {
      message = await Promise.race([reviewWrite({ ...write, cwd, minTokens }), budget])
    } finally {
      clearTimeout(timer)
    }
  } catch {
    // A malformed payload, a repository mid-rebase, a missing binary. The hook
    // is advisory; none of that justifies interrupting the write.
    return null
  }
  return message
}

async function readStdin() {
  if (process.stdin.isTTY) return ''
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}
