import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { languageFor, parse, LANGUAGES } from '../lib/parser.js'

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
