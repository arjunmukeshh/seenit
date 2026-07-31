// The half of clone detection jscpd does not do.
//
// jscpd is a Type-1 detector: it finds copies that are byte-equivalent after
// tokenizing, and it finds nothing at all once identifiers change. Measured on a
// single function with 66 identifiers renamed and nothing else touched, every
// mode — mild, weak, strict, --ignore-case — returned zero clones.
//
// That is the whole product. "The third copy never looks like the first" is the
// claim, and the previous engine earned 0.91 recall after renaming every
// identifier precisely because it normalized them away before matching.
//
// So we supply the normalization and let jscpd supply the matching. Every leaf
// token is replaced by its class — identifiers become ID, strings STR, numbers
// NUM, everything else its own node type — and written out with ONE ORIGINAL
// LINE PER OUTPUT LINE, so the line numbers jscpd reports need no translation.
//
// Files in languages we have no grammar for are copied verbatim rather than
// dropped: jscpd handles 223 formats and exact matching on the other 209 is a
// strictly better floor than not looking at them.

import { mkdir, readFile, writeFile, cp } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { parse, languageFor } from './analyze/parser.js'

// Node types that carry a name or a value, and therefore must not survive into
// the normalized stream. Kept in sync with the old fingerprinting path, which
// used exactly this mapping to reach 0.91 recall on renamed copies.
const TOKEN_CLASS = new Map([
  ['identifier', 'ID'],
  ['property_identifier', 'ID'],
  ['type_identifier', 'ID'],
  ['field_identifier', 'ID'],
  // Object shorthand. Missing this left `const { a, b } = f()` normalizing to
  // its literal property names, so a renamed destructure did not match.
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
    // Iterative, not recursive. The recursive form overflowed the stack on
    // TypeScript's binderBinaryExpressionStress.js and aborted a 38,000-file
    // scan; that lesson cost a day and is not worth relearning.
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
        // Unreadable, or a grammar that refused it. Skipping one file is better
        // than failing the scan.
      }
    }),
  )

  return { normalized, copied }
}
