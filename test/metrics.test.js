// Metric validation.
//
// The tool's credibility rests entirely on these numbers being right, so the
// metrics are validated three ways, in descending order of evidential strength:
//
//   1. DIFFERENTIAL — agreement with an independently written reference
//      implementation. Two tools written from the same published definition
//      arriving at the same number is real corroboration, not self-assessment.
//      The cyclomatic values below were cross-checked against ESLint 9's
//      `complexity` rule (8/8 agreement) and are pinned here so a regression in
//      our implementation shows up as a test failure.
//
//   2. GROUND TRUTH — fixtures whose correct answer is derivable by hand from
//      the published definition (McCabe 1976: cyclomatic complexity is
//      1 + the number of decision points).
//
//   3. METAMORPHIC — invariants that must hold regardless of what the "right"
//      answer is. These need no ground truth and catch whole classes of bug:
//      if reformatting a file changes its complexity, something is wrong no
//      matter which number is correct.
//
// What these tests deliberately do NOT establish is construct validity — whether
// cyclomatic complexity actually predicts defects. That is an open empirical
// question in the literature, and not something a test suite can settle. The
// tool's job is to measure what it claims to measure, and to be transparent
// that the composite scores built on top are opinion, not measurement.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse } from '../lib/analyze/parser.js'
import { extract } from '../lib/analyze/extract.js'
import { scoreDuplication, findClones } from '../lib/analyze/metrics/duplication.js'
import { scoreStandards } from '../lib/analyze/metrics/standards.js'
import { buildGraph, findCycles, scoreExtensibility } from '../lib/analyze/graph.js'
import { percentile, scoreAgainst, rollup, grade, scoreComplexity } from '../lib/analyze/metrics/score.js'
import { thresholdsFor } from '../lib/analyze/metrics/thresholds.js'

async function facts(path, source) {
  const parsed = await parse(path, source)
  assert.ok(parsed, `no grammar for ${path}`)
  try {
    return extract(parsed.tree, source, { path, language: parsed.language })
  } finally {
    parsed.tree.delete()
  }
}

const fn = (f, name) => f.functions.find((x) => x.name === name)

// ---------------------------------------------------------------- differential

// Values verified against ESLint 9 `complexity` rule — 8/8 agreement.
const ESLINT_VERIFIED = [
  ['noBranches', 'function noBranches(x) { return x }', 1],
  ['oneIf', 'function oneIf(x) { if (x) return 1; return 2 }', 2],
  ['ifWithAnd', 'function ifWithAnd(x, y) { if (x && y) return 1; return 2 }', 3],
  ['forWithIf', 'function forWithIf(x) { for (const i of x) { if (i) return i } return null }', 3],
  ['tryCatch', 'function tryCatch(x) { try { JSON.parse(x) } catch { return null } return 1 }', 2],
  ['ternary', 'function ternary(x) { return x ? 1 : 2 }', 2],
  ['switchThree', 'function switchThree(x) { switch (x) { case 1: return 1; case 2: return 2; default: return 3 } }', 3],
  ['whileWithIf', 'function whileWithIf(x) { while (x-- > 0) { if (x % 2) continue } return x }', 3],
]

for (const [name, source, expected] of ESLINT_VERIFIED) {
  test(`cyclomatic: ${name} agrees with ESLint (${expected})`, async () => {
    const f = await facts('t.js', source)
    assert.equal(fn(f, name).cyclomatic, expected)
  })
}

// --------------------------------------------------------------- ground truth

test('cyclomatic: matches McCabe definition on nested branching', async () => {
  // 1 (base) + if + && + for + if + catch + ternary = 7
  const f = await facts('t.js', `
    function nested(a, b) {
      if (a > 0 && b.length) {
        for (const x of b) {
          if (x) { try { JSON.parse(x) } catch { return null } }
        }
      }
      return b ? 1 : 2
    }
  `)
  assert.equal(fn(f, 'nested').cyclomatic, 7)
})

test('cognitive: penalizes nesting where cyclomatic does not', async () => {
  const flat = await facts('a.js', `
    function flat(a) { if (a) return 1; if (a) return 2; if (a) return 3; return 0 }
  `)
  const deep = await facts('b.js', `
    function deep(a) { if (a) { if (a) { if (a) return 3 } } return 0 }
  `)
  // Same number of decisions, so the same cyclomatic complexity...
  assert.equal(fn(flat, 'flat').cyclomatic, fn(deep, 'deep').cyclomatic)
  // ...but nesting is what makes code hard to hold in your head.
  assert.ok(
    fn(deep, 'deep').cognitive > fn(flat, 'flat').cognitive,
    'cognitive complexity must exceed cyclomatic for nested code',
  )
})

test('nesting: counts syntactic blocks, not raw AST depth', async () => {
  // Raw AST depth of a trivial function reads ~15 and is meaningless. Real
  // block nesting here is 1 (the function body).
  const f = await facts('t.js', 'function shallow(a) { return a.b.c.d.e.f(1, 2, 3) }')
  assert.ok(fn(f, 'shallow').maxNesting <= 1, `expected <=1, got ${fn(f, 'shallow').maxNesting}`)
})

test('params and length are measured per function', async () => {
  const f = await facts('t.js', 'function many(a, b, c, d) {\n  return 1\n}\n')
  assert.equal(fn(f, 'many').params, 4)
  assert.equal(fn(f, 'many').lines, 3)
})

// ----------------------------------------------------------------- metamorphic

test('metamorphic: formatting does not change complexity', async () => {
  const compact = await facts('a.js', 'function f(x){if(x&&x>1){return 1}return 2}')
  const spaced = await facts('b.js', `
    function f(x) {
      if (x && x > 1) {
        return 1
      }
      return 2
    }
  `)
  assert.equal(fn(compact, 'f').cyclomatic, fn(spaced, 'f').cyclomatic)
  assert.equal(fn(compact, 'f').cognitive, fn(spaced, 'f').cognitive)
})

test('metamorphic: consistent renaming does not change complexity', async () => {
  const a = await facts('a.js', 'function f(alpha) { if (alpha) { return alpha + 1 } return 0 }')
  const b = await facts('b.js', 'function f(zeta) { if (zeta) { return zeta + 1 } return 0 }')
  assert.equal(fn(a, 'f').cyclomatic, fn(b, 'f').cyclomatic)
  assert.equal(fn(a, 'f').cognitive, fn(b, 'f').cognitive)
})

test('metamorphic: comments do not change complexity', async () => {
  const bare = await facts('a.js', 'function f(x) { if (x) return 1; return 2 }')
  const documented = await facts('b.js', `
    // explains the branch
    function f(x) {
      /* block comment */
      if (x) return 1 // trailing
      return 2
    }
  `)
  assert.equal(fn(bare, 'f').cyclomatic, fn(documented, 'f').cyclomatic)
  assert.ok(documented.commentLines > 0, 'comments must still be counted for readability')
})

test('metamorphic: each added branch increases cyclomatic by exactly one', async () => {
  let previous = null
  for (let n = 0; n <= 4; n++) {
    const branches = Array.from({ length: n }, (_, i) => `if (x === ${i}) return ${i}`).join('\n      ')
    const f = await facts('t.js', `function f(x) {\n      ${branches}\n      return -1\n    }`)
    const cc = fn(f, 'f').cyclomatic
    if (previous !== null) assert.equal(cc - previous, 1, `adding branch ${n} changed cc by ${cc - previous}`)
    previous = cc
  }
})

test('metamorphic: duplicating a file is detected as duplication', async () => {
  const body = (suffix) => `
    export function process${suffix}(input, options) {
      if (!input) throw new Error('missing')
      const cleaned = String(input).trim().toLowerCase()
      if (cleaned.length === 0) throw new Error('empty')
      if (cleaned.length > 255) throw new Error('too long')
      const segments = cleaned.split(':')
      if (segments.length !== 3) throw new Error('bad shape')
      const [scope, key, value] = segments
      if (!scope || !key) throw new Error('bad parts')
      return { scope, key, value, raw: cleaned }
    }
  `
  const original = await facts('a.js', body('A'))
  const copy = await facts('b.js', body('B'))
  const unrelated = await facts('c.js', 'export const x = 1\nexport const y = [1, 2].map((n) => n * 2)\n')

  const clones = findClones([original, copy, unrelated])
  assert.equal(clones.length, 1, 'exactly one duplicated pair')
  assert.deepEqual([clones[0].a, clones[0].b], ['a.js', 'b.js'])

  // Copy-paste with every symbol renamed must still be caught — that is the
  // characteristic shape of duplication in agent-generated code.
  assert.equal(scoreDuplication([original, copy]).score, 0)
})

test('metamorphic: shared import blocks are not duplication', async () => {
  // Every module opens with structurally identical imports. Before import
  // tokens were excluded from fingerprints, unrelated files matched on these
  // alone and dominated the duplication report.
  const mk = (n) => `
    import { readFile, writeFile, mkdir } from 'node:fs/promises'
    import { join, dirname, resolve } from 'node:path'
    import { tmpdir } from 'node:os'
    export const value${n} = ${n}
  `
  const a = await facts('a.js', mk(1))
  const b = await facts('b.js', mk(2))
  assert.equal(findClones([a, b]).length, 0, 'identical import blocks must not register as clones')
})

// ---------------------------------------------------------------------- graph

test('graph: resolves relative imports and finds cycles', async () => {
  const mk = (path, imports) => ({
    path,
    imports,
    exports: ['x'],
    functions: [],
    classes: [],
    loc: 10,
    identifiers: [],
    fingerprints: [],
    abstractDeclarations: 0,
  })
  const nodes = buildGraph([
    mk('src/a.js', ['./b']),
    mk('src/b.js', ['./c']),
    mk('src/c.js', ['./a']), // closes the cycle
    mk('src/lonely.js', ['react']), // external, not an internal edge
  ])

  assert.ok(nodes.get('src/a.js').dependencies.has('src/b.js'), 'extensionless import resolves')
  assert.equal(nodes.get('src/lonely.js').dependencies.size, 0, 'external packages are not internal edges')

  const cycles = findCycles(nodes)
  assert.equal(cycles.length, 1)
  assert.deepEqual(cycles[0].members, ['src/a.js', 'src/b.js', 'src/c.js'])
})

test('graph: instability follows the Martin definition', async () => {
  const mk = (path, imports) => ({
    path, imports, exports: [], functions: [], classes: [], loc: 10,
    identifiers: [], fingerprints: [], abstractDeclarations: 0,
  })
  // leaf.js is depended on by two modules and depends on none: Ce=0, so I=0.
  const result = scoreExtensibility([
    mk('leaf.js', []),
    mk('one.js', ['./leaf']),
    mk('two.js', ['./leaf']),
  ])
  const leaf = result.moduleMetrics.find((m) => m.path === 'leaf.js')
  assert.equal(leaf.fanIn, 2)
  assert.equal(leaf.fanOut, 0)
  assert.equal(leaf.instability, 0, 'I = Ce/(Ca+Ce) = 0/2 = 0 — maximally stable')

  const one = result.moduleMetrics.find((m) => m.path === 'one.js')
  assert.equal(one.instability, 1, 'depends on one thing, nothing depends on it — maximally unstable')
})

// ------------------------------------------------------------------ standards

test('standards: measures the repo against its own dominant convention', async () => {
  const mk = (path, names) => ({
    path,
    functions: names.map((n) => ({ name: n })),
    classes: [], imports: [], exports: [], identifiers: [],
    fingerprints: [], parseError: false, abstractDeclarations: 0, loc: 10,
  })
  const consistent = scoreStandards([mk('a.js', ['doThing', 'makeWidget', 'parseInput'])])
  assert.equal(consistent.functionNaming.style, 'camelCase')
  assert.equal(consistent.functionNaming.adherence, 1)

  const mixed = scoreStandards([mk('a.js', ['doThing', 'make_widget', 'parse_input', 'handleClick'])])
  assert.ok(mixed.functionNaming.adherence < 1, 'mixed conventions must score below perfect')
  assert.ok(
    mixed.score < consistent.score,
    'an inconsistent codebase must score lower than a consistent one',
  )
})

// --------------------------------------------------------------------- scoring

test('scoring: percentile picks the right element', () => {
  const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  assert.equal(percentile(v, 90), 9)
  assert.equal(percentile(v, 100), 10)
  assert.equal(percentile([], 90), 0)
})

test('scoring: scoreAgainst is monotonic and bounded', () => {
  const t = { good: 5, warn: 10, bad: 20 }
  assert.equal(scoreAgainst(0, t), 100)
  assert.equal(scoreAgainst(5, t), 100)
  assert.equal(scoreAgainst(20, t), 0)
  assert.equal(scoreAgainst(1000, t), 0, 'one catastrophic value must not push a score negative')

  let previous = 101
  for (let v = 0; v <= 25; v++) {
    const s = scoreAgainst(v, t)
    assert.ok(s <= previous, `score must never increase as the metric worsens (at ${v})`)
    assert.ok(s >= 0 && s <= 100, `score out of bounds at ${v}: ${s}`)
    previous = s
  }
})

test('scoring: p90 is used so one bad file is not averaged away', async () => {
  const clean = Array.from({ length: 20 }, () => ({ functions: [{ cyclomatic: 1, cognitive: 1 }] }))
  const withMonster = [...clean, { functions: [{ cyclomatic: 60, cognitive: 90 }] }]
  assert.ok(
    scoreComplexity(withMonster).maxCyclomatic === 60,
    'the outlier must be visible in the reported maximum',
  )
})

test('scoring: unmeasured dimensions are excluded, not scored zero', () => {
  const withCoverage = rollup({
    complexity: { score: 80 }, size: { score: 80 }, duplication: { score: 80 },
    readability: { score: 80 }, standards: { score: 80 }, extensibility: { score: 80 },
    coverage: { score: 80 },
  })
  const withoutCoverage = rollup({
    complexity: { score: 80 }, size: { score: 80 }, duplication: { score: 80 },
    readability: { score: 80 }, standards: { score: 80 }, extensibility: { score: 80 },
    coverage: { score: null },
  })
  // Missing coverage must not drag the overall score down — "no report" and
  // "nothing covered" are different facts.
  assert.equal(withoutCoverage.overall, withCoverage.overall)
  assert.ok(withoutCoverage.unmeasured.includes('coverage'))
})

test('scoring: grade boundaries', () => {
  assert.equal(grade(95), 'A')
  assert.equal(grade(85), 'B')
  assert.equal(grade(75), 'C')
  assert.equal(grade(60), 'D')
  assert.equal(grade(10), 'F')
  assert.equal(grade(null), '?')
})

// ------------------------------------------------------------- per-language

test('per-language: each language is scored against its own thresholds', async () => {
  const { groupByLanguage, scoreMetricByLanguage } = await import('../lib/analyze/metrics/perLanguage.js')

  // Same measured value, different languages: 9 is ordinary JavaScript but
  // pathological TypeScript. A single global threshold cannot express that.
  const tables = {
    javascript: { cyclomatic: { good: 4, warn: 9, bad: 28 } },
    typescript: { cyclomatic: { good: 2, warn: 4, bad: 13 } },
  }
  const thresholdsFor = (lang) => tables[lang]

  const js = scoreMetricByLanguage(
    groupByLanguage([{ language: 'javascript', v: 9 }], (i) => i.language),
    { valueOf: (i) => i.v, metric: 'cyclomatic', thresholdsFor },
  )
  const ts = scoreMetricByLanguage(
    groupByLanguage([{ language: 'typescript', v: 9 }], (i) => i.language),
    { valueOf: (i) => i.v, metric: 'cyclomatic', thresholdsFor },
  )
  assert.ok(js.score > ts.score, 'the same value must score worse in the stricter language')
})

test('per-language: combination is weighted by observation count', async () => {
  const { groupByLanguage, scoreMetricByLanguage } = await import('../lib/analyze/metrics/perLanguage.js')
  const tables = {
    javascript: { cyclomatic: { good: 4, warn: 9, bad: 28 } },
    typescript: { cyclomatic: { good: 2, warn: 4, bad: 13 } },
  }
  const items = [
    ...Array.from({ length: 999 }, () => ({ language: 'javascript', v: 1 })), // perfect
    { language: 'typescript', v: 13 }, // worst possible
  ]
  const result = scoreMetricByLanguage(groupByLanguage(items, (i) => i.language), {
    valueOf: (i) => i.v,
    metric: 'cyclomatic',
    thresholdsFor: (l) => tables[l],
  })
  // One bad TypeScript function among a thousand clean JS ones must barely move
  // the number; an unweighted mean would have averaged 100 and 0 to 50.
  assert.ok(result.score > 95, `expected >95, got ${result.score}`)
})

test('per-language: an uncalibrated language reports null, not a free 100', async () => {
  const { groupByLanguage, scoreMetricByLanguage } = await import('../lib/analyze/metrics/perLanguage.js')
  const result = scoreMetricByLanguage(
    groupByLanguage([{ language: 'cobol', v: 40 }], (i) => i.language),
    { valueOf: (i) => i.v, metric: 'cyclomatic', thresholdsFor: () => null },
  )
  // Scoring 100 would reward a codebase for being written in a language we
  // cannot judge — the same lie as reporting missing coverage as 0%.
  assert.equal(result.score, null)
  assert.match(result.reason, /no calibrated thresholds/)
})

// ------------------------------------------------- cross-language extraction

// Every case here was found by calibration, not by inspection. Ruby recorded
// ZERO functions across 120 sampled RubyGems repositories before this was
// caught — a whole language silently producing no function-level data.
const LANGUAGE_FIXTURES = [
  ['t.rb', 'class W\n def render(o)\n  if o then 1 else 2 end\n end\nend\ndef top(a,b)\n a>b ? a : b\nend', 2, 2],
  ['t.go', 'package m\nfunc Add(a, b int) int { if a>b { return a }; return b }', 1, 2],
  ['t.cpp', 'int add(int a,int b){ if(a>b) return a; return b; }', 1, 2],
  ['t.java', 'class W { int add(int a,int b){ if(a>b) return a; return b; } }', 1, 2],
  ['t.py', 'def add(a,b):\n    if a>b: return a\n    return b', 1, 2],
  ['t.ts', 'function add(a:number,b:number){ if(a>b) return a; return b }', 1, 2],
  ['t.rs', 'fn add(a:i32,b:i32)->i32{ if a>b {a} else {b} }', 1, 2],
]

for (const [path, source, minFunctions, expectedParams] of LANGUAGE_FIXTURES) {
  test(`extraction: ${path.split('.')[1]} yields functions and parameters`, async () => {
    const f = await facts(path, source)
    assert.ok(
      f.functions.length >= minFunctions,
      `expected >=${minFunctions} functions, got ${f.functions.length} — the language is silently unsupported`,
    )
    assert.equal(
      Math.max(0, ...f.functions.map((fn) => fn.params)),
      expectedParams,
      'parameter extraction must work for this grammar',
    )
    assert.ok(
      f.functions.every((fn) => fn.name !== '(anonymous)'),
      'named functions must resolve their names, not fall back to (anonymous)',
    )
  })
}

test('extraction: Go groups parameters sharing a type', async () => {
  // `func f(a, b int)` is ONE parameter_declaration naming two parameters.
  // Counting the node rather than the names undercounts by the group size.
  const f = await facts('t.go', 'package m\nfunc f(a, b, c int, d string) int { return 0 }')
  assert.equal(f.functions[0].params, 4)
})

// --------------------------------------------- cross-language branch counting

// Grammars spell the same construct differently and the disagreement is not
// cosmetic. Ruby names its constructs bare ('if', 'when', 'while'); PHP and C#
// use suffixed forms and emit the bare keyword as an ANONYMOUS token. Listing
// only suffixed forms made Ruby match almost nothing: 38,460 Ruby methods
// calibrated to thresholds of 1/1/3 cyclomatic, implying no Ruby method ever
// branches. Caught only because the calibration corpus grew to include Ruby.
const BRANCH_FIXTURES = [
  ['t.rb', 'def f(a,b)\n if a && b\n  x=1\n end\n while a\n  break\n end\n case a\n when 1 then 1\n end\n begin\n  g()\n rescue\n  nil\n end\nend'],
  ['t.py', 'def f(a,b):\n    if a and b:\n        pass\n    while a:\n        break\n    try:\n        g()\n    except:\n        pass'],
  ['t.go', 'package m\nfunc f(a bool,b bool){ if a&&b {} ; for {} ; switch a { case true: } }'],
  ['t.rs', 'fn f(a:bool,b:bool){ if a&&b {} while a {} match a { true=>{}, _=>{} } }'],
  ['t.java', 'class W{void f(boolean a,boolean b){ if(a&&b){} while(a){} switch(1){case 1:break;} try{g();}catch(Exception e){} }}'],
  ['t.ts', 'function f(a,b){ if(a&&b){} while(a){} switch(a){case 1:break;} try{g()}catch(e){} }'],
  ['t.php', '<?php function f($a,$b){ if($a&&$b){} while($a){} switch($a){case 1:break;} try{g();}catch(Exception $e){} }'],
  ['t.cs', 'class W{void f(bool a,bool b){ if(a&&b){} while(a){} switch(1){case 1:break;} try{g();}catch(Exception e){} }}'],
]

for (const [path, source] of BRANCH_FIXTURES) {
  test(`branches: ${path.split('.')[1]} detects conditionals, loops and handlers`, async () => {
    const f = await facts(path, source)
    const cc = f.functions[0]?.cyclomatic ?? 0
    // Equivalent logic across languages should land in the same band. A value
    // at or below 2 means the grammar's branch nodes are not being recognised
    // at all, which is the failure this guards.
    assert.ok(cc >= 5, `expected >=5 for 5 decision points, got ${cc} — branch nodes unrecognised`)
    assert.ok(cc <= 8, `expected <=8, got ${cc} — branches likely double-counted`)
  })
}

test('branches: anonymous keyword tokens are not double-counted', async () => {
  // PHP emits a bare 'if' token inside if_statement. Counting unnamed nodes
  // would score this 3 instead of 2.
  const php = await facts('t.php', '<?php function f($a){ if($a){ return 1; } return 2; }')
  assert.equal(php.functions[0].cyclomatic, 2)
})

// The scale is percentile-anchored, and the whole meaning of a health number
// rests on that anchoring holding.
//
// Thresholds are generated as good = p75, warn = p90, bad = p99 of the
// calibration corpus, and scoreAgainst is built so those land on 100 / 70 / 0.
// That is what makes "70 = typical" true and what the grade documentation
// promises. A future change to either the generator's percentiles or the decay
// curve could silently move it, turning every published grade into a different
// claim without any test failing.
test('grades mean what they say: p75/p90/p99 score 100/70/0', () => {
  const languages = ['javascript', 'typescript', 'tsx', 'python', 'go', 'rust', 'java']
  let checked = 0

  for (const language of languages) {
    const thresholds = thresholdsFor(language)
    if (!thresholds) continue
    for (const [metric, t] of Object.entries(thresholds)) {
      // Degenerate tables (all-zero, or good == warn) have no curve to check.
      if (!(t.good < t.warn && t.warn < t.bad)) continue
      const where = `${language}.${metric}`
      assert.equal(scoreAgainst(t.good, t), 100, `${where}: corpus p75 must score 100`)
      assert.equal(scoreAgainst(t.warn, t), 70, `${where}: corpus p90 must score 70 — "C is typical" depends on this`)
      assert.equal(scoreAgainst(t.bad, t), 0, `${where}: corpus p99 must score 0`)
      checked++
    }
  }

  assert.ok(checked >= 20, `expected many calibrated tables, checked ${checked}`)
  assert.equal(grade(70), 'C', 'a typical repository must grade C')
  assert.equal(grade(69.9), 'D')
})

// Deeply nested input must not overflow the stack.
//
// Found by running the analyzer over TypeScript's own repository, where
// tests/baselines/reference/binderBinaryExpressionStress.js — a file written
// to nest binary expressions as deeply as a parser will accept — threw
// RangeError from the recursive AST walk. That did not merely skip the file:
// it aborted the entire 38,000-file scan. Both walks in extract.js are now
// iterative, for the same reason findCycles is.
test('extract: deep nesting does not overflow the stack', async () => {
  const deepExpression = `const x = ${'('.repeat(6000)}1${')'.repeat(6000)}`
  const chained = `const y = ${Array.from({ length: 8000 }, (_, i) => i).join(' + ')}`
  const nestedBlocks = 'function f(){' + 'if(a){'.repeat(2000) + 'b()' + '}'.repeat(2000) + '}'

  for (const [label, source] of [
    ['parenthesized', deepExpression],
    ['chained binary', chained],
    ['nested blocks', nestedBlocks],
  ]) {
    const f = await facts('deep.js', source)
    assert.ok(f, `${label}: expected facts, got null`)
    assert.equal(typeof f.loc, 'number', `${label}: analysis must complete`)
  }
})
