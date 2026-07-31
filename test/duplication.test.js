// Tests for the seam: that normalisation erases names, that jscpd's output
// survives the trip back to real paths and line numbers, and that a renamed copy
// is still found. Each of these has been broken once.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeSource } from '../lib/normalize.js'
import { detect, detectNormalized, isTest } from '../lib/jscpd.js'
import { clusterBlocks } from '../lib/cluster.js'
import { findExisting } from '../lib/find.js'

const ORIGINAL = `
function calculateOrderTotal(items, taxRate) {
  let subtotal = 0
  for (const item of items) {
    subtotal += item.price * item.quantity
  }
  const discount = subtotal > 100 ? subtotal * 0.1 : 0
  const taxed = (subtotal - discount) * (1 + taxRate)
  return Math.round(taxed * 100) / 100
}
`

// The same function after the treatment an agent gives it: every identifier
// renamed, every literal changed, comments added, reformatted.
const COPY = `
// Work out what the basket costs once everything is applied.
function computeBasketSum(lines, vatFraction) {

  let running = 0

  for (const line of lines) {
    // price times count
    running += line.cost * line.count
  }

  const rebate = running > 250 ? running * 0.2 : 0
  const withVat = (running - rebate) * (1 + vatFraction)

  return Math.round(withVat * 1000) / 1000
}
`

// ------------------------------------------------------------- normalisation

test('normalisation erases names and values but keeps structure', async () => {
  const a = await normalizeSource('a.js', ORIGINAL)
  const b = await normalizeSource('b.js', COPY)

  // Not one identifier or literal from either side survives.
  for (const token of ['calculateOrderTotal', 'taxRate', 'subtotal', 'computeBasketSum', 'vatFraction', '250']) {
    assert.ok(!a.includes(token) && !b.includes(token), `${token} must not survive normalisation`)
  }
  // The shape does survive.
  assert.match(a, /function ID \( ID , ID \)/)
  assert.match(a, /for \( const ID of ID \)/)
})

test('normalisation keeps one output line per original line', async () => {
  const src = 'const a = 1\n\n\nconst b = 2\n'
  const out = await normalizeSource('t.js', src)
  assert.equal(out.split('\n').length, src.split('\n').length, 'line count must be preserved')
  // Line 4 of the source is the second declaration; it must be line 4 of the
  // output, or every range jscpd reports would be shifted.
  assert.match(out.split('\n')[3], /^const ID = NUM/)
  assert.equal(out.split('\n')[1], '', 'blank lines stay blank')
})

test('a file in a language with no grammar normalises to null', async () => {
  assert.equal(await normalizeSource('notes.xyz', 'whatever'), null)
})

// ------------------------------------------------------------------ the claim

// The README's headline claim, so it fails CI when it stops being true.
test('a renamed, re-littered, re-commented, reformatted copy is still found', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'seenit-test-'))
  try {
    await writeFile(join(dir, 'original.js'), ORIGINAL)
    await writeFile(join(dir, 'copy.js'), COPY)

    // What grep is given: no shared identifier, no shared literal, no shared line.
    for (const token of ['calculateOrderTotal', 'taxRate', 'item.price', 'subtotal']) {
      assert.ok(!COPY.includes(token), `${token} must not appear in the copy`)
    }
    const lines = (s) => new Set(s.split('\n').map((l) => l.trim()).filter((l) => l && l !== '}'))
    assert.deepEqual([...lines(ORIGINAL)].filter((l) => lines(COPY).has(l)), [], 'no line may be byte-identical')

    const blocks = await detectNormalized(dir, ['original.js', 'copy.js'], { minTokens: 20 })
    assert.ok(blocks.length > 0, 'the copy must be detected')
    assert.deepEqual([blocks[0].a, blocks[0].b].sort(), ['copy.js', 'original.js'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('unrelated code is not reported', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'seenit-test-'))
  try {
    await writeFile(join(dir, 'a.js'), ORIGINAL)
    await writeFile(
      join(dir, 'b.js'),
      'export async function fetchUser(id) {\n  const res = await fetch(`/api/users/${id}`)\n  if (!res.ok) throw new Error(res.statusText)\n  return res.json()\n}\n',
    )
    const blocks = await detectNormalized(dir, ['a.js', 'b.js'], { minTokens: 20 })
    assert.equal(blocks.length, 0, 'two unrelated functions must not match')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------ the seam

test('paths come back relative and real, through a symlinked tmpdir', async () => {
  // os.tmpdir() is a symlink on macOS and jscpd --absolute reports the resolved
  // path, so without realpath on both sides nothing compares equal.
  const dir = await mkdtemp(join(tmpdir(), 'seenit-test-'))
  try {
    await mkdir(join(dir, 'nested'), { recursive: true })
    await writeFile(join(dir, 'one.js'), ORIGINAL)
    await writeFile(join(dir, 'nested', 'two.js'), ORIGINAL)
    const blocks = await detect([dir], { base: dir, minTokens: 20 })
    assert.ok(blocks.length > 0)
    for (const b of [blocks[0].a, blocks[0].b]) {
      assert.ok(!b.startsWith('..') && !b.startsWith('/'), `path must be relative to the root, got ${b}`)
    }
    assert.deepEqual([blocks[0].a, blocks[0].b].sort(), ['nested/two.js', 'one.js'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('test files are excluded unless asked for', async () => {
  assert.ok(isTest('src/foo.test.js'))
  assert.ok(isTest('test/helpers.js'))
  assert.ok(isTest('pkg/thing_test.go'))
  assert.ok(!isTest('src/latest.js'), 'a filename containing "test" is not a test file')
})

// ---------------------------------------------------------------- clustering

test('pairs become findings, anchored on the largest region', () => {
  // One file copied into three places: three pairs, one fact.
  const blocks = [
    { a: 'a.js', aStart: 1, aEnd: 40, b: 'b.js', bStart: 1, bEnd: 40, tokens: 300, lines: 40 },
    { a: 'a.js', aStart: 1, aEnd: 40, b: 'c.js', bStart: 5, bEnd: 44, tokens: 290, lines: 40 },
    { a: 'b.js', aStart: 1, aEnd: 40, b: 'c.js', bStart: 5, bEnd: 44, tokens: 280, lines: 40 },
    { a: 'x.js', aStart: 2, aEnd: 9, b: 'y.js', bStart: 2, bEnd: 9, tokens: 60, lines: 8 },
  ]
  const groups = clusterBlocks(blocks)
  assert.equal(groups.length, 2, 'three pairs of one fact collapse into one finding')
  assert.equal(groups[0].tokens, 300, 'largest region first, and it anchors the group')
  assert.equal(groups[0].fileCount, 3)
  assert.deepEqual(groups[0].others, ['c.js'], 'the rest of the group is named, not counted')
  assert.equal(groups[0].pairs, 3)
})

// ------------------------------------------------------------- find_existing

test('find_existing answers with a location, or with nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'seenit-test-'))
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    await run('git', ['-C', dir, 'init', '-q'])
    await writeFile(join(dir, 'orders.js'), ORIGINAL)
    await run('git', ['-C', dir, 'add', '-A'])

    // The copy an agent would write: same function, nothing shared textually.
    const hits = await findExisting(dir, COPY, { minTokens: 20 })
    assert.equal(hits.length, 1, 'the existing implementation must be found')
    assert.equal(hits[0].file, 'orders.js')
    assert.ok(hits[0].startLine >= 1 && hits[0].endLine > hits[0].startLine, 'a real line range')

    // Genuinely new code gets the other answer, which is the common one.
    const novel = await findExisting(
      dir,
      'export function slerp(a, b, t) {\n  const dot = a.x * b.x + a.y * b.y\n  const theta = Math.acos(Math.min(1, Math.abs(dot)))\n  const s = Math.sin(theta)\n  if (s < 1e-6) return a\n  return { x: a.x * Math.sin((1 - t) * theta) / s }\n}\n',
      { minTokens: 20 },
    )
    assert.deepEqual(novel, [], 'unrelated code must return nothing')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
