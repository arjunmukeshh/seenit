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
// absent: an if/else is one decision, not two. Nor are `case`/`switch`
// containers — only their individual arms decide anything.
//
// Grammars disagree on naming, and the disagreement is not cosmetic. Ruby names
// its constructs bare (`if`, `unless`, `when`, `while`) while PHP and C# use
// suffixed forms (`if_statement`) and emit the bare keyword as an ANONYMOUS
// token. Listing only the suffixed forms meant Ruby matched almost nothing:
// 38,460 Ruby methods calibrated to thresholds of 1/1/3 cyclomatic, implying
// that essentially no Ruby method branches at all.
//
// Both spellings are therefore listed, and `isNamed` disambiguates — see the
// walk in measureFunction. Without that check, adding bare `if` would make PHP
// count every if twice.
const BRANCH = new Set([
  // suffixed forms — JS/TS, PHP, C#, Java, Go, Python, Rust
  'if_statement', 'elif_clause', 'else_if_clause', 'elsif',
  'for_statement', 'for_in_statement', 'for_of_statement', 'for_range_loop', 'range_clause',
  'foreach_statement', 'enhanced_for_statement',
  'while_statement', 'do_statement', 'loop_expression',
  'catch_clause', 'except_clause', 'rescue', 'rescue_clause',
  'ternary_expression', 'conditional_expression', 'if_expression',
  'switch_case', 'case_clause', 'when_clause', 'match_arm', 'expression_case',
  'case_statement', 'switch_section', 'switch_label',
  // bare forms — Ruby (named nodes there, anonymous tokens elsewhere)
  'if', 'unless', 'while', 'until', 'when', 'conditional',
])

const LOGICAL_OPS = new Set(['&&', '||', '??', 'and', 'or', '||=', '&&='])

// Node types that carry a binary operator, across grammars.
const BINARY_NODES = new Set(['binary_expression', 'boolean_operator', 'binary'])

const FUNCTION = new Set([
  'function_declaration', 'function_definition', 'function_expression', 'function_item',
  'arrow_function', 'method_definition', 'method_declaration', 'constructor_declaration',
  'generator_function_declaration', 'generator_function',
  // Ruby names its function nodes 'method' and 'singleton_method'. Their
  // absence here meant Ruby extracted ZERO functions — across 120 RubyGems
  // repositories the calibration recorded no function-level data at all, and a
  // Ruby user would have seen every function-based metric silently empty.
  'method', 'singleton_method',
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

// C-family grammars hang the name and parameter list off a nested
// `function_declarator` rather than exposing them on the function node, so a
// plain `name` lookup returns nothing. Walk the declarator chain to reach them.
function declaratorOf(node) {
  let current = node.childForFieldName?.('declarator')
  for (let depth = 0; current && depth < 4; depth++) {
    if (current.type === 'function_declarator') return current
    current = current.childForFieldName?.('declarator')
  }
  return null
}

function nameOf(node) {
  const n = node.childForFieldName?.('name')
  if (n) return n.text

  const declarator = declaratorOf(node)
  if (declarator) {
    const inner = declarator.childForFieldName?.('declarator')
    if (inner) return inner.text
  }
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

// Parameter count, handling the three shapes the supported grammars use:
//   * a `parameters` field on the function node (JS/TS, Python, Java, C#, Rust)
//   * a nested function_declarator holding it (C/C++)
//   * grouped declarations where one node covers several names (Go's `a, b int`)
//
// Bash is legitimately zero: shell functions take positional arguments and
// declare none. Calibration treats an all-zero distribution as unsupported
// extraction rather than a measurement, so no threshold is derived from it.
function countParams(node) {
  const params = node.childForFieldName?.('parameters') ?? declaratorOf(node)?.childForFieldName?.('parameters')
  if (!params) return 0

  let n = 0
  for (let i = 0; i < params.namedChildCount; i++) {
    const child = params.namedChild(i)
    if (!child || COMMENT.has(child.type)) continue

    // Go and C group parameters sharing a type into one declaration node:
    // `func f(a, b int)` is a single parameter_declaration naming two
    // parameters. Counting the node once would undercount by the group size.
    if (child.type === 'parameter_declaration' && child.namedChildCount > 1) {
      let names = 0
      for (let j = 0; j < child.namedChildCount; j++) {
        if (child.namedChild(j)?.type === 'identifier') names++
      }
      n += Math.max(1, names)
      continue
    }
    n++
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
    // isNamed is what makes one BRANCH set work across grammars that spell the
    // same construct differently: Ruby's `if` is a named node, PHP's `if` is an
    // anonymous keyword token inside if_statement. Counting anonymous nodes
    // would double-count every conditional in the C-family grammars.
    const isBranch = node.isNamed && BRANCH.has(node.type)
    if (isBranch) {
      cyclomatic++
      cognitive += 1 + nesting
    }
    if (BINARY_NODES.has(node.type)) {
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

// Accumulate one node's contribution. Returns whether the subtree beneath it is
// inside an import, which the caller threads down the recursion.
function collectNode(node, acc, inImport) {
  const type = node.type

  if (FUNCTION.has(type)) acc.functions.push({ name: nameOf(node), ...measureFunction(node) })
  if (CLASS.has(type)) acc.classes.push({ name: nameOf(node), line: node.startPosition.row + 1 })
  if (ABSTRACT.has(type)) acc.abstractDeclarations++
  if (COMMENT.has(type)) acc.commentLines += node.endPosition.row - node.startPosition.row + 1
  if (BRANCH.has(type)) acc.branchNodes++

  const isImport = inImport || IMPORT_NODES.has(type)
  if (IMPORT_NODES.has(type)) collectImport(node, acc.imports)
  if (type === 'call_expression') collectCallImport(node, acc.imports)
  if (type === 'export_statement' || type === 'export_declaration') acc.exports.push(...exportedNames(node))
  if (IDENTIFIER_NODES.has(type)) acc.identifiers.push(node.text)

  // Leaf nodes are the token stream. Comments are excluded so editing a
  // comment doesn't shift every fingerprint after it.
  if (node.childCount === 0 && !COMMENT.has(type) && !isImport) {
    acc.tokens.push(normalizeToken(node))
    acc.tokenLines.push(node.startPosition.row + 1)
  }

  return isImport
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

// Token classes collapsed for fingerprinting: two functions that differ only in
// variable names or literal values are still clones. This was a chain of `||`
// comparisons; as a Map it is one lookup instead of up to twelve string
// compares, on a path that runs once per leaf node of every AST.
const TOKEN_CLASS = new Map([
  ['identifier', 'ID'], ['property_identifier', 'ID'], ['type_identifier', 'ID'], ['field_identifier', 'ID'],
  ['string', 'STR'], ['template_string', 'STR'], ['string_literal', 'STR'], ['raw_string_literal', 'STR'],
  ['number', 'NUM'], ['integer', 'NUM'], ['float', 'NUM'], ['int_literal', 'NUM'],
])

function normalizeToken(node) {
  return TOKEN_CLASS.get(node.type) ?? node.type
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

const IMPORT_NODES = new Set(['import_statement', 'import_from_statement', 'import_declaration'])
const IDENTIFIER_NODES = new Set(['identifier', 'property_identifier', 'type_identifier'])

// Record an ES/Python-style import.
function collectImport(node, imports) {
  const s = importSource(node)
  if (s) imports.add(s)
}

// CommonJS and dynamic imports: require('x'), import('x').
function collectCallImport(node, imports) {
  const fn = node.childForFieldName?.('function')?.text
  if (fn !== 'require' && fn !== 'import') return
  const arg = node.childForFieldName?.('arguments')?.namedChild(0)
  if (arg && (arg.type === 'string' || arg.type === 'template_string')) {
    imports.add(arg.text.replace(/^['"`]|['"`]$/g, ''))
  }
}

export function extract(tree, source, { path, language }) {
  const root = tree.rootNode
  const acc = {
    functions: [],
    classes: [],
    imports: new Set(),
    exports: [],
    identifiers: [],
    tokens: [],
    tokenLines: [],
    commentLines: 0,
    branchNodes: 0,
    abstractDeclarations: 0,
  }

  // Traversal is separated from collection below: `walk` recurses, `collectNode`
  // decides what one node contributes. The split is for reading and testing —
  // `collectNode` can be exercised on a single node without a tree — and it is
  // deliberately a flat sequence of Set lookups rather than a handler table.
  // This runs once per AST node on the hot path, and a closure call per node
  // type would cost more than the branches it removes. The tool's own study
  // puts complexity's effect at IRR 1.029, below its 1.10 action floor, so
  // "advisory" is exactly how its reading of this function is being treated.
  //
  // `inImport` suppresses fingerprint tokens inside import statements. Every
  // module in a codebase opens with structurally identical import blocks, which
  // normalized to the same token sequence and made unrelated files register as
  // clones — after consolidating a genuinely duplicated formatter, the entire
  // remaining top-five duplication list was import statements.
  ;(function walk(node, inImport) {
    const isImport = collectNode(node, acc, inImport)
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i)
      if (c) walk(c, isImport)
    }
  })(root, false)

  const { functions, classes, imports, exports, identifiers, tokens, tokenLines } = acc
  const { commentLines, branchNodes, abstractDeclarations } = acc

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
// Named children of `node` matching `type`. The index loop appears four times
// in this file's export handling; naming it once removes three of them.
function* namedChildrenOfType(node, type) {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i)
    if (c?.type === type) yield c
  }
}

const fieldText = (node, field) => node.childForFieldName?.(field)?.text

// `export function f`, `export class C`, `export const a = 1, b = 2`
function declarationNames(decl) {
  const names = []
  const name = fieldText(decl, 'name')
  if (name) names.push(name)
  for (const d of namedChildrenOfType(decl, 'variable_declarator')) {
    const n = fieldText(d, 'name')
    if (n) names.push(n)
  }
  return names
}

// `export { a, b as c }` — the alias is the exported name when present.
function clauseNames(node) {
  const names = []
  for (const clause of namedChildrenOfType(node, 'export_clause')) {
    for (const spec of namedChildrenOfType(clause, 'export_specifier')) {
      const name = fieldText(spec, 'alias') ?? fieldText(spec, 'name')
      if (name) names.push(name)
    }
  }
  return names
}

function exportedNames(node) {
  const decl = node.childForFieldName?.('declaration')
  return [
    ...(decl ? declarationNames(decl) : []),
    ...clauseNames(node),
    ...(node.text.startsWith('export default') ? ['default'] : []),
  ]
}
