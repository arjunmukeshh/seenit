import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git, gitDir, repoRoot } from '../lib/git.js'
import { stringify, sortedBy, round } from '../lib/canonical.js'
import {
  openLedger, writeTree, commitSnapshot, updateRef, listSnapshots,
  readSnapshotFile, diffSnapshots, analyzedCommits, MAIN_REF,
} from '../lib/ledger.js'

async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'gcb-test-'))
  await git(dir, ['init', '--quiet', '.'])
  await git(dir, ['config', 'user.email', 'test@test'])
  await git(dir, ['config', 'user.name', 'test'])
  await writeFile(join(dir, 'a.js'), 'export const a = 1\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-qm', 'init'])
  return dir
}

test('canonical: key order is stable regardless of insertion order', () => {
  const a = stringify({ zebra: 1, apple: 2, mango: { z: 1, a: 2 } })
  const b = stringify({ mango: { a: 2, z: 1 }, apple: 2, zebra: 1 })
  assert.equal(a, b)
})

test('canonical: float noise is normalized away', () => {
  // The classic case that would otherwise produce a phantom diff every run.
  assert.equal(stringify({ v: 0.1 + 0.2 }), stringify({ v: 0.3 }))
  assert.equal(stringify({ v: -0 }), stringify({ v: 0 }))
  assert.equal(stringify({ v: NaN }), stringify({ v: null }))
  assert.equal(stringify({ v: Infinity }), stringify({ v: null }))
})

test('canonical: output is line-granular and newline-terminated', () => {
  const s = stringify({ a: 1, b: 2 })
  assert.ok(s.endsWith('\n'))
  assert.ok(s.includes('\n  "a": 1'), 'each value on its own line for clean diffs')
})

test('canonical: helpers', () => {
  assert.deepEqual(sortedBy([{ n: 3 }, { n: 1 }, { n: 2 }], 'n').map((x) => x.n), [1, 2, 3])
  assert.equal(round(1 / 3), 0.3333)
})

test('ledger: writes snapshots without touching the source repo', async (t) => {
  const dir = await makeRepo()
  t.after(() => rm(dir, { recursive: true, force: true }))

  const root = await repoRoot(dir)
  const gd = await gitDir(dir)
  const ledger = await openLedger(root, gd)
  const source = await git(dir, ['rev-parse', 'HEAD'])

  const tree = await writeTree(ledger, {
    'manifest.json': { sourceCommit: source, analyzerVersion: 1 },
    'health.json': { overall: 81 },
    'files/src/deep/nested.js.json': { complexity: 4 },
  })
  const snap = await commitSnapshot(ledger, {
    tree, parent: null, sourceCommit: source, sourceSubject: 'init', health: 81, fileCount: 1,
  })
  await updateRef(ledger, MAIN_REF, snap)

  // The critical guarantee: the user's repo is untouched.
  assert.equal(await git(dir, ['status', '--porcelain']), '', 'working tree stays clean')
  const all = await git(dir, ['log', '--oneline', '--all'])
  assert.equal(all.split('\n').length, 1, 'git log --all shows only source commits')

  // Nested paths survive the round trip (git mktree could not do this).
  assert.deepEqual(await readSnapshotFile(ledger, MAIN_REF, 'files/src/deep/nested.js.json'), { complexity: 4 })

  const snaps = await listSnapshots(ledger)
  assert.equal(snaps.length, 1)
  assert.equal(snaps[0].sourceCommit, source, 'trailer links snapshot to source commit')
  assert.equal(snaps[0].health, 81)
  assert.ok((await analyzedCommits(ledger)).has(source))
})

test('ledger: identical analysis produces an identical tree (determinism)', async (t) => {
  const dir = await makeRepo()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ledger = await openLedger(await repoRoot(dir), await gitDir(dir))

  // Same data, different key insertion order — must hash identically, or every
  // diff in the product becomes noise.
  const t1 = await writeTree(ledger, { 'health.json': { overall: 81, complexity: 70 } })
  const t2 = await writeTree(ledger, { 'health.json': { complexity: 70, overall: 81 } })
  assert.equal(t1, t2, 'canonical serialization makes snapshots reproducible')
})

test('ledger: diff between snapshots is a semantic health diff', async (t) => {
  const dir = await makeRepo()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const ledger = await openLedger(await repoRoot(dir), await gitDir(dir))

  const t1 = await writeTree(ledger, {
    'health.json': { overall: 81 },
    'files/a.js.json': { complexity: 12 },
    'files/vendor.js.json': { complexity: 3 },
  })
  const c1 = await commitSnapshot(ledger, { tree: t1, sourceCommit: 'a'.repeat(40), health: 81 })

  const t2 = await writeTree(ledger, {
    'health.json': { overall: 62 },
    'files/a.js.json': { complexity: 31 },
    'files/vendor.js.json': { complexity: 3 }, // unchanged
  })
  const c2 = await commitSnapshot(ledger, { tree: t2, parent: c1, sourceCommit: 'b'.repeat(40), health: 62 })
  await updateRef(ledger, MAIN_REF, c2)

  const diff = await diffSnapshots(ledger, c1, c2)
  assert.ok(diff.includes('-  "complexity": 12'), 'diff shows the old value')
  assert.ok(diff.includes('+  "complexity": 31'), 'diff shows the regression')

  // Only the files that actually changed appear — the impact surface.
  const names = await diffSnapshots(ledger, c1, c2, { nameOnly: true })
  assert.ok(names.includes('files/a.js.json'))
  assert.ok(!names.includes('vendor.js.json'), 'unchanged analysis does not appear in the diff')

  // ...and unchanged analysis is stored once, not twice.
  const [v1, v2] = await Promise.all([
    ledger.run(['rev-parse', `${t1}:files/vendor.js.json`]),
    ledger.run(['rev-parse', `${t2}:files/vendor.js.json`]),
  ])
  assert.equal(v1, v2, 'blob dedup: unchanged files cost zero additional storage')
})
