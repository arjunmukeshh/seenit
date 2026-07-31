// "Does this snippet already exist?" — the pre-write query.
//
// Plants the candidate in the normalized shadow tree and reports what it
// attaches to. Nothing touches the user's working tree.

import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { extname } from 'node:path'

import { detectNormalized, JSCPD_DEFAULT_MIN_TOKENS } from './jscpd.js'

const execFile = promisify(execFileCb)

// Tracked files only — otherwise an untracked node_modules gets normalized and
// scanned, which is slow and finds nothing useful.
export async function trackedFiles(root) {
  const { stdout } = await execFile('git', ['-C', root, 'ls-files'], { maxBuffer: 1 << 28 })
  return stdout.split('\n').filter(Boolean)
}

/**
 * Does `snippet` already exist in the repository?
 *
 * Returns the regions it matches, each with the file and the exact line range,
 * ordered by how much code is shared. An empty array means "safe to write it",
 * which is a real answer and the common one.
 */
export async function findExisting(root, snippet, { minTokens = JSCPD_DEFAULT_MIN_TOKENS, language = 'js', limit = 5 } = {}) {
  const files = await trackedFiles(root)
  // The probe needs an extension so jscpd tokenizes it as the right language.
  // A bare name would be scanned as plain text and match nothing.
  const ext = language.startsWith('.') ? language : `.${language}`
  const probe = `__seenit_probe__${ext}`

  const blocks = await detectNormalized(root, files, {
    minTokens,
    includeTests: true,
    extra: [{ path: probe, source: snippet.endsWith('\n') ? snippet : `${snippet}\n` }],
  })

  return blocks
    // Probe-to-repo blocks only: self-matches say nothing, and repo-to-repo is
    // what `seenit` (no args) reports.
    .filter((b) => (b.a === probe) !== (b.b === probe))
    .map((b) => {
      const mine = b.a === probe
      return {
        file: mine ? b.b : b.a,
        startLine: mine ? b.bStart : b.aStart,
        endLine: mine ? b.bEnd : b.aEnd,
        // Which part of the snippet matched — distinguishes a whole-function hit
        // from an incidental overlap of boilerplate.
        snippetStart: mine ? b.aStart : b.bStart,
        snippetEnd: mine ? b.aEnd : b.bEnd,
        lines: b.lines,
        tokens: b.tokens,
      }
    })
    .slice(0, limit)
}

// Guess a probe extension. Shallow by design — pass `language` when you know it.
export function guessLanguage(snippet, hintPath) {
  if (hintPath) {
    const e = extname(hintPath)
    if (e) return e
  }
  if (/^\s*(def |class .*:|import \w+$)/m.test(snippet)) return '.py'
  if (/\bfunc\s+\w+\s*\(/.test(snippet) && /:=/.test(snippet)) return '.go'
  if (/\bfn\s+\w+\s*\(/.test(snippet) && /->/.test(snippet)) return '.rs'
  if (/:\s*(string|number|boolean)\b|\binterface\s+\w+\s*\{/.test(snippet)) return '.ts'
  return '.js'
}
