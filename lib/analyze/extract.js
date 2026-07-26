// Single-pass fact extraction from a parsed file.
//
// Structured as extraction (here, AST-coupled) vs scoring (metrics/*.js, pure
// functions over these facts). One traversal rather than one per metric —
// benchmarked at ~1.3 ms/file, and three separate walks would triple that for
// no benefit since every metric wants the same nodes.
//
// Node type names differ across tree-sitter grammars, so the sets below are
// unions covering the supported languages. A name that doesn't exist in a given
// grammar simply never matches, which is harmless.

// Nodes that add a branch to cyclomatic complexity. `else` is deliberately
// absent: an if/else is one decision, not two.
const BRANCH = new Set([
  'if_statement', 'elif_clause', 'else_if_clause',
  'for_statement', 'for_in_statement', 'for_of_statement', 'for_range_loop', 'range_clause',
  'while_statement', 'do_statement', 'loop_expression',
  'catch_clause', 'except_clause', 'rescue',
  'ternary_expression', 'conditional_expression', 'if_expression',
  'switch_case', 'case_clause', 'when_clause', 'match_arm', 'expression_case',
  'optional_chain',
])

const LOGICAL_OPS = new Set(['&&', '||', '??', 'and', 'or'])

const FUNCTION = new Set([
  'function_declaration', 'function_definition', 'function_expression', 'function_item',
  'arrow_function', 'method_definition', 'method_declaration', 'constructor_declaration',
  'generator_function_declaration', 'generator_function',
])

// Nodes that introduce a syntactic nesting level. Critical: measuring raw AST
// depth instead reads ~15 on a trivial function (verified during planning) and
// is meaningless as a readability signal.
const BLOCK = new Set([
  'statement_block', 'block', 'compound_statement', 'suite',
  'class_body', 'object', 'switch_body',
])

const CLASS = new Set([
  'class_declaration', 'class_definition', 'class_specifier', 'struct_item',
  'interface_declaration', 'trait_item', 'impl_item', 'enum_declaration',
])

// Declarations that are abstractions rather than implementations. Feeds the
// abstractness term (A) of the Martin metrics in graph.js — a module that is
// depended upon should be abstract, one that depends on everything should not.
const ABSTRACT = new Set([
  'interface_declaration', 'type_alias_declaration', 'abstract_class_declaration',
  'trait_item', 'protocol_declaration', 'type_declaration',
])

const COMMENT = new Set(['comment', 'line_comment', 'block_comment', 'documentation_comment'])

function nameOf(node) {
  const n = node.childForFieldName?.('name')
  if (n) return n.text
  // arrow functions assigned to a variable: `const foo = () => {}`
  const parent = node.parent
  if (parent && (parent.type === 'variable_declarator' || parent.type === 'assignment')) {
    const id = parent.childForFieldName?.('name') ?? parent.childForFieldName?.('left')
    if (id) return id.text
  }
  if (parent?.type === 'pair') {
    const key = parent.childForFieldName?.('key')
    if (key) return key.text
  }
  return '(anonymous)'
}

function countParams(node) {
  const params = node.childForFieldName?.('parameters')
  if (!params) return 0
  let n = 0
  for (let i = 0; i < params.namedChildCount; i++) {
    const c = params.namedChild(i)
    if (c && !COMMENT.has(c.type)) n++
  }
  return n
}

// Per-function metrics. Cyclomatic counts decision points; cognitive (Sonar's
// model) additionally penalizes *nested* decisions, which is what actually makes
// code hard to hold in your head.
function measureFunction(fnNode) {
  let cyclomatic = 1
  let cognitive = 0
  let maxNesting = 0

  const baseDepth = blockDepth(fnNode)

  ;(function walk(node, nesting) {
    const isBranch = BRANCH.has(node.type)
    if (isBranch) {
      cyclomatic++
      cognitive += 1 + nesting
    }
    if (node.type === 'binary_expression' || node.type === 'boolean_operator') {
      const op = node.childForFieldName?.('operator')?.text
      if (op && LOGICAL_OPS.has(op)) {
        cyclomatic++
        cognitive += 1
      }
    }
    const deeper = BLOCK.has(node.type) ? nesting + 1 : nesting
    if (BLOCK.has(node.type)) maxNesting = Math.max(maxNesting, deeper)
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i)
      if (c && !FUNCTION.has(c.type)) walk(c, deeper) // nested fns measured separately
    }
  })(fnNode, 0)

  return {
    cyclomatic,
    cognitive,
    maxNesting,
    lines: fnNode.endPosition.row - fnNode.startPosition.row + 1,
    params: countParams(fnNode),
    line: fnNode.startPosition.row + 1,
    baseDepth,
  }
}

function blockDepth(node) {
  let d = 0
  for (let p = node.parent; p; p = p.parent) if (BLOCK.has(p.type)) d++
  return d
}

// Module path from an import/require node, or null.
function importSource(node) {
  const src = node.childForFieldName?.('source')
  if (src) return src.text.replace(/^['"`]|['"`]$/g, '')
  // python: `from x import y` / `import x`
  const mod = node.childForFieldName?.('module_name')
  if (mod) return mod.text
  return null
}

// Token-level fingerprints for clone detection (see metrics/duplication.js).
//
// Identifiers and literals are normalized to placeholders so that renaming a
// variable does not hide a copy-paste — which is exactly how duplicates appear
// in agent-generated code: the same logic, different names.
// K_GRAM is 25 rather than the ~12 typical of plagiarism detection. Normalizing
// identifiers makes JSX and other declarative markup collapse into near-identical
// token streams — two unrelated React components genuinely look the same once
// names are stripped — so short windows produce constant false positives. A
// longer window demands a substantially longer literal match.
const K_GRAM = 25
const WINNOW = 4 // winnowing window; selects ~1 fingerprint per WINNOW k-grams

function normalizeToken(node) {
  const t = node.type
  if (t === 'identifier' || t === 'property_identifier' || t === 'type_identifier' || t === 'field_identifier') return 'ID'
  if (t === 'string' || t === 'template_string' || t === 'string_literal' || t === 'raw_string_literal') return 'STR'
  if (t === 'number' || t === 'integer' || t === 'float' || t === 'int_literal') return 'NUM'
  return t
}

// FNV-1a — cheap, deterministic across runs and platforms (important: a hash
// that varies per process would make every snapshot diff look like churn).
function hashTokens(tokens) {
  let h = 0x811c9dc5
  for (const t of tokens) {
    for (let i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    h ^= 0x2c
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

function fingerprint(tokens, lines) {
  if (tokens.length < K_GRAM) return []
  const grams = []
  for (let i = 0; i + K_GRAM <= tokens.length; i++) {
    grams.push([hashTokens(tokens.slice(i, i + K_GRAM)), lines[i]])
  }
  // Winnowing: keep the minimum hash in each sliding window. Guarantees that any
  // shared substring above a threshold length is detected, while storing only a
  // fraction of the k-grams.
  const out = []
  let last = -1
  for (let i = 0; i + WINNOW <= grams.length; i++) {
    let minIdx = i
    for (let j = i + 1; j < i + WINNOW; j++) if (grams[j][0] < grams[minIdx][0]) minIdx = j
    if (minIdx !== last) {
      out.push(grams[minIdx])
      last = minIdx
    }
  }
  return out
}

export function extract(tree, source, { path, language }) {
  const root = tree.rootNode
  const functions = []
  const classes = []
  const imports = new Set()
  const exports = []
  const identifiers = []
  const tokens = []
  const tokenLines = []
  let commentLines = 0
  let branchNodes = 0
  let abstractDeclarations = 0

  ;(function walk(node) {
    const type = node.type

    if (FUNCTION.has(type)) {
      const m = measureFunction(node)
      functions.push({ name: nameOf(node), ...m })
      // still descend: nested functions are their own entries
    }
    if (CLASS.has(type)) classes.push({ name: nameOf(node), line: node.startPosition.row + 1 })
    if (ABSTRACT.has(type)) abstractDeclarations++
    if (COMMENT.has(type)) commentLines += node.endPosition.row - node.startPosition.row + 1
    if (BRANCH.has(type)) branchNodes++

    if (type === 'import_statement' || type === 'import_from_statement' || type === 'import_declaration') {
      const s = importSource(node)
      if (s) imports.add(s)
    }
    // CommonJS / dynamic: require('x'), import('x')
    if (type === 'call_expression') {
      const fn = node.childForFieldName?.('function')?.text
      if (fn === 'require' || fn === 'import') {
        const arg = node.childForFieldName?.('arguments')?.namedChild(0)
        if (arg && (arg.type === 'string' || arg.type === 'template_string')) {
          imports.add(arg.text.replace(/^['"`]|['"`]$/g, ''))
        }
      }
    }

    if (type === 'export_statement' || type === 'export_declaration') {
      exports.push(...exportedNames(node))
    }

    if (type === 'identifier' || type === 'property_identifier' || type === 'type_identifier') {
      identifiers.push(node.text)
    }

    // Leaf nodes are the token stream. Comments are excluded so that changing a
    // comment doesn't move every fingerprint downstream of it.
    if (node.childCount === 0 && !COMMENT.has(type)) {
      tokens.push(normalizeToken(node))
      tokenLines.push(node.startPosition.row + 1)
    }

    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i)
      if (c) walk(c)
    }
  })(root)

  const lines = source.split('\n')
  const blank = lines.filter((l) => l.trim() === '').length

  return {
    path,
    language,
    parseError: root.hasError,
    loc: lines.length,
    sloc: lines.length - blank - commentLines > 0 ? lines.length - blank - commentLines : 0,
    blankLines: blank,
    commentLines,
    maxLineLength: lines.reduce((m, l) => Math.max(m, l.length), 0),
    longLines: lines.filter((l) => l.length > 120).length,
    functions,
    classes,
    imports: [...imports].sort(),
    exports: exports.sort(),
    identifiers,
    branchNodes,
    abstractDeclarations,
    tokenCount: tokens.length,
    fingerprints: fingerprint(tokens, tokenLines),
  }
}

// Exported symbol names — the basis of api/surface.json. Syntactic only: with
// tree-sitter we see the export keyword, not resolved types, so re-exports and
// computed names are approximate. Noted as a v1 limitation.
function exportedNames(node) {
  const names = []
  const decl = node.childForFieldName?.('declaration')
  if (decl) {
    const n = decl.childForFieldName?.('name')
    if (n) names.push(n.text)
    // `export const a = 1, b = 2`
    for (let i = 0; i < decl.namedChildCount; i++) {
      const c = decl.namedChild(i)
      if (c?.type === 'variable_declarator') {
        const vn = c.childForFieldName?.('name')
        if (vn) names.push(vn.text)
      }
    }
  }
  // `export { a, b as c }`
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i)
    if (c?.type === 'export_clause') {
      for (let j = 0; j < c.namedChildCount; j++) {
        const spec = c.namedChild(j)
        if (spec?.type === 'export_specifier') {
          const alias = spec.childForFieldName?.('alias')
          const nm = spec.childForFieldName?.('name')
          if (alias) names.push(alias.text)
          else if (nm) names.push(nm.text)
        }
      }
    }
  }
  if (node.text.startsWith('export default')) names.push('default')
  return names
}
