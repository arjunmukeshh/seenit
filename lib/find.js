// The pre-write query — "does this already exist?" — asked with a snippet.
//
// This is the one thing no copy/paste detector does, and it is the reason
// seenit exists alongside jscpd rather than on top of it. jscpd answers "what is
// duplicated in this repository?", a report you read after the fact. An agent
// about to write a helper needs the other question, asked before the writing,
// against code it has not read.
//
// The mechanism is the same one the recall study uses to establish ground truth:
// plant the candidate and see what it attaches to. Nothing is written to the
// user's working tree — the probe lives only in the normalized shadow.

import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { extname } from 'node:path'

import { detectNormalized, JSCPD_DEFAULT_MIN_TOKENS } from './jscpd.js'

const execFile = promisify(execFileCb)

// Tracked files only. An untracked node_modules or build directory would
// otherwise be normalized and scanned, which is slow and finds nothing anyone
// wants told about.
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
    // Only blocks that pair the probe with real code. A probe matching itself
    // says nothing, and two repository files matching each other is the other
    // tool's question.
    .filter((b) => (b.a === probe) !== (b.b === probe))
    .map((b) => {
      const mine = b.a === probe
      return {
        file: mine ? b.b : b.a,
        startLine: mine ? b.bStart : b.aStart,
        endLine: mine ? b.bEnd : b.aEnd,
        // Which part of the submitted snippet matched, so the caller can tell a
        // whole-function match from an incidental overlap of boilerplate.
        snippetStart: mine ? b.aStart : b.bStart,
        snippetEnd: mine ? b.aEnd : b.bEnd,
        lines: b.lines,
        tokens: b.tokens,
      }
    })
    .slice(0, limit)
}

// Guess a probe extension from the snippet, so callers that do not know the
// language still get tokenized rather than treated as prose. Deliberately
// shallow: the caller passing `language` explicitly is always better.
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
