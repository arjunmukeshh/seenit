import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { languageFor, parse, isAnalyzable, isTestFile, LANGUAGES } from '../lib/analyze/parser.js'

const require = createRequire(import.meta.url)
const WASM_DIR = join(dirname(require.resolve('@vscode/tree-sitter-wasm/package.json')), 'wasm')

function shippedGrammars() {
  return new Set(
    readdirSync(WASM_DIR)
      .filter((f) => f.startsWith('tree-sitter-') && f.endsWith('.wasm'))
      .map((f) => f.replace(/^tree-sitter-/, '').replace(/\.wasm$/, '')),
  )
}

test('every mapped language has a grammar that actually ships', () => {
  // The bug this prevents: '.c' and '.h' were mapped to a 'c' grammar that
  // @vscode/tree-sitter-wasm does not ship. Loading threw, and because the
  // throw propagated, a single C file aborted the scan of an entire repository.
  // Four of forty repos in the calibration corpus failed this way.
  const available = shippedGrammars()
  const missing = LANGUAGES.filter((lang) => !available.has(lang))
  assert.deepEqual(missing, [], `mapped grammars with no .wasm file: ${missing.join(', ')}`)
})

test('a missing grammar degrades to unsupported, it does not throw', async () => {
  // Even with the mapping correct, a grammar failing to load at runtime (a
  // corrupt or partial install) must cost one file, not the whole run.
  const result = await parse('nonexistent.zzzunknown', 'some content')
  assert.equal(result, null)
})

test('C files are analyzable and parse via the cpp grammar', async () => {
  assert.equal(languageFor('src/main.c'), 'cpp')
  assert.equal(languageFor('include/header.h'), 'cpp')
  assert.ok(isAnalyzable('src/main.c'))

  const source = `
    #include <stdio.h>
    int add(int a, int b) {
      if (a > b) { return a; }
      return b;
    }
  `
  const parsed = await parse('src/main.c', source)
  assert.ok(parsed, 'C source must parse rather than crash the scan')
  try {
    assert.equal(parsed.language, 'cpp')
  } finally {
    parsed.tree.delete()
  }
})

test('generated and build output is excluded', () => {
  // Every case here was found in the calibration corpus, having slipped through
  // the filters and landed in the measured distributions. The Next.js chunk was
  // 10,741 lines and single-handedly set the p99 file-length threshold for
  // JavaScript to a value no real source file could ever reach.
  for (const path of [
    'docs/_next/static/chunks/pages/_app.js', // _next, not .next
    'packages/node-opcua-units/source/_generated_categorized_units.ts',
    'src/__generated__/schema.ts',
    'app/static/chunks/main.js',
    'lib/bundle.min.js',
    'api/service_pb2.py',
  ]) {
    assert.equal(isAnalyzable(path), false, `${path} should be excluded as generated/build output`)
  }

  // ...without excluding real source that merely looks similar.
  for (const path of ['src/index.ts', 'lib/parser.js', 'src/generator.ts', 'app/staticRoutes.ts']) {
    assert.equal(isAnalyzable(path), true, `${path} is real source and must be analyzed`)
  }
})

test('test files are recognised across language conventions', () => {
  for (const path of [
    'crates/package-manager/src/install/tests.rs', // Rust module convention
    'src/test.rs',
    'a/conftest.py', // pytest
    'src/testing/helper.ts',
    'src/foo.test.ts',
    'src/foo_test.go',
  ]) {
    assert.equal(isTestFile(path), true, `${path} should be treated as test code`)
  }
  for (const path of ['src/tester.ts', 'src/index.ts', 'src/latest.ts', 'src/protest.js']) {
    assert.equal(isTestFile(path), false, `${path} is not a test file`)
  }
})

test('language mapping covers the corpus extensions', () => {
  for (const [path, expected] of [
    ['a.ts', 'typescript'],
    ['a.tsx', 'tsx'],
    ['a.jsx', 'tsx'],
    ['a.mjs', 'javascript'],
    ['a.py', 'python'],
    ['a.go', 'go'],
    ['a.rs', 'rust'],
    ['a.rb', 'ruby'],
  ]) {
    assert.equal(languageFor(path), expected, `${path} should map to ${expected}`)
  }
  assert.equal(languageFor('a.unknownext'), null)
})
