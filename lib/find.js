// Query a snippet against the repository.
//
// The candidate is planted in the normalised shadow tree; the working tree is
// never written to.

import { extname } from 'node:path'

import { detectNormalized, JSCPD_DEFAULT_MIN_TOKENS } from './jscpd.js'
import { trackedFiles } from './git.js'

/**
 * Does `snippet` already exist in the repository?
 *
 * Returns matching regions with file and line range, ordered by how much code is
 * shared. An empty array means no match.
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
    // Probe-to-repository blocks only. Repository-to-repository pairs are what
    // `seenit` with no arguments reports.
    .filter((b) => (b.a === probe) !== (b.b === probe))
    .map((b) => {
      const mine = b.a === probe
      return {
        file: mine ? b.b : b.a,
        startLine: mine ? b.bStart : b.aStart,
        endLine: mine ? b.bEnd : b.aEnd,
        // Which part of the snippet matched, distinguishing a whole-function hit
        // from an incidental overlap.
        snippetStart: mine ? b.aStart : b.bStart,
        snippetEnd: mine ? b.aEnd : b.bEnd,
        lines: b.lines,
        tokens: b.tokens,
      }
    })
    .slice(0, limit)
}

// Guess a probe extension. Heuristic; pass `language` explicitly where known.
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
