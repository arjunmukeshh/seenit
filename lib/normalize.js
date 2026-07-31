// Rewrite source as a stream of token classes, so a renamed copy matches.
//
// jscpd is exact-match only — with 66 identifiers renamed and nothing else
// changed, every jscpd mode returns zero. Normalizing first is what turns it
// into a Type-2 detector.
//
// Output keeps ONE LINE PER SOURCE LINE, so line numbers need no translation.
// Files in languages we have no grammar for are copied through unchanged, which
// leaves jscpd's exact matching working on them.

import { mkdir, readFile, writeFile, cp } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { parse, languageFor } from './parser.js'

// Node types carrying a name or value. These must not survive normalization.
const TOKEN_CLASS = new Map([
  ['identifier', 'ID'],
  ['property_identifier', 'ID'],
  ['type_identifier', 'ID'],
  ['field_identifier', 'ID'],
  // Object shorthand: without these, `const { a, b } = f()` kept its literal
  // property names and a renamed destructure did not match.
  ['shorthand_property_identifier', 'ID'],
  ['shorthand_property_identifier_pattern', 'ID'],
  ['statement_identifier', 'ID'],
  ['label_identifier', 'ID'],
  ['string', 'STR'],
  ['template_string', 'STR'],
  ['string_literal', 'STR'],
  ['raw_string_literal', 'STR'],
  ['interpreted_string_literal', 'STR'],
  ['string_content', 'STR'],
  ['number', 'NUM'],
  ['integer', 'NUM'],
  ['float', 'NUM'],
  ['int_literal', 'NUM'],
  ['float_literal', 'NUM'],
  ['decimal_integer_literal', 'NUM'],
])

const COMMENT = new Set(['comment', 'line_comment', 'block_comment', 'doc_comment', 'documentation_comment'])

/**
 * Normalized text for one source file: token classes, laid out on the lines
 * their tokens came from. Returns null when there is no grammar for the path.
 */
export async function normalizeSource(path, source) {
  if (!languageFor(path)) return null
  const parsed = await parse(path, source)
  if (!parsed) return null

  const byLine = []
  try {
    // Iterative: the recursive form overflows the stack on deeply nested files
    // (TypeScript's binderBinaryExpressionStress.js aborts a whole scan).
    const stack = [parsed.tree.rootNode]
    while (stack.length) {
      const node = stack.pop()
      if (COMMENT.has(node.type)) continue
      if (node.childCount === 0) {
        const row = node.startPosition.row
        ;(byLine[row] ??= []).push(TOKEN_CLASS.get(node.type) ?? node.type)
      }
      for (let i = node.childCount - 1; i >= 0; i--) stack.push(node.child(i))
    }
  } finally {
    parsed.tree.delete()
  }

  const lineCount = source.split('\n').length
  return Array.from({ length: lineCount }, (_, i) => (byLine[i] ?? []).join(' ')).join('\n')
}

/**
 * Build a shadow tree of `files` (paths relative to `root`) under `shadow`,
 * preserving relative paths and extensions so jscpd tokenizes each file as its
 * own language and the reported paths map back by stripping the shadow root.
 */
export async function buildShadow(root, files, shadow, { maxBytes = 2_000_000 } = {}) {
  let normalized = 0
  let copied = 0

  await Promise.all(
    files.map(async (rel) => {
      const from = join(root, rel)
      const to = join(shadow, rel)
      await mkdir(dirname(to), { recursive: true })
      try {
        const stat = await readFile(from)
        if (stat.length > maxBytes) return
        const text = await normalizeSource(rel, stat.toString('utf8'))
        if (text === null) {
          await cp(from, to)
          copied++
        } else {
          await writeFile(to, text)
          normalized++
        }
      } catch {
        // Unreadable, or the grammar refused it. Skip rather than fail the scan.
      }
    }),
  )

  return { normalized, copied }
}
