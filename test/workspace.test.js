import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git, repoRoot, gitDir } from '../lib/git.js'
import { workingChanges, workspaceFiles, hashWorkingFiles } from '../lib/workspace.js'
import { AnalysisCache } from '../lib/cache.js'

async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'gcb-ws-'))
  await git(dir, ['init', '--quiet', '.'])
  await git(dir, ['config', 'user.email', 'test@test'])
  await git(dir, ['config', 'user.name', 'test'])
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'src', 'tracked.js'), 'export const a = 1\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-qm', 'init'])
  return dir
}

test('workingChanges: unstaged paths are not shifted by trimming', async (t) => {
  const dir = await makeRepo()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const root = await repoRoot(dir)

  // An unstaged modification is the case that broke: porcelain emits " M path"
  // with a leading space, and trimming stdout ate it, yielding "rc/tracked.js".
  await writeFile(join(root, 'src', 'tracked.js'), 'export const a = 2\n')
  await writeFile(join(root, 'src', 'fresh.js'), 'export const b = 3\n')

  const changes = await workingChanges(root)
  assert.deepEqual(changes.modified, ['src/tracked.js'], 'leading space must not shift the path')
  assert.deepEqual(changes.added, ['src/fresh.js'])
  assert.deepEqual(changes.deleted, [])
})

test('workingChanges: staged and unstaged both parse correctly', async (t) => {
  const dir = await makeRepo()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const root = await repoRoot(dir)

  await writeFile(join(root, 'src', 'staged.js'), 'export const s = 1\n')
  await git(root, ['add', 'src/staged.js']) // "A " — no leading space
  await writeFile(join(root, 'src', 'tracked.js'), 'changed\n') // " M" — leading space

  const changes = await workingChanges(root)
  assert.ok(changes.added.includes('src/staged.js'))
  assert.ok(changes.modified.includes('src/tracked.js'))
  for (const p of [...changes.added, ...changes.modified]) {
    assert.ok(p.startsWith('src/'), `path "${p}" lost its first character`)
  }
})

test('workspace: untracked files are included, ignored files are not', async (t) => {
  const dir = await makeRepo()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const root = await repoRoot(dir)

  await writeFile(join(root, '.gitignore'), 'ignored.js\n')
  await writeFile(join(root, 'ignored.js'), 'export const x = 1\n')
  await writeFile(join(root, 'src', 'brand-new.js'), 'export const n = 1\n')

  const files = await workspaceFiles(root)
  // A brand new file is exactly what an agent just wrote, so it must appear.
  assert.ok(files.includes('src/brand-new.js'), 'untracked files must be analyzed')
  assert.ok(!files.includes('ignored.js'), 'gitignored files must not be')
})

test('workspace: hashes match git object ids so the cache key is shared', async (t) => {
  const dir = await makeRepo()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const root = await repoRoot(dir)

  const hashes = await hashWorkingFiles(root, ['src/tracked.js'])
  const fromGit = await git(root, ['rev-parse', 'HEAD:src/tracked.js'])
  assert.equal(hashes.get('src/tracked.js'), fromGit, 'working-tree hash must equal the blob SHA')
})

test('cache: concurrent flushes do not race on the temp file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gcb-cache-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const cache = new AnalysisCache(dir)
  await cache.set('a'.repeat(40), { loc: 1, functions: [] })

  // The MCP server handles concurrent tool calls; overlapping flushes used to
  // collide on an identical pid-based temp name and fail with ENOENT.
  await Promise.all([cache.flush(), cache.flush(), cache.flush(), cache.flush()])

  const reloaded = new AnalysisCache(dir)
  assert.deepEqual(await reloaded.get('a'.repeat(40)), { loc: 1, functions: [] })
})

test('cache: entries survive a round trip and drop the path', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gcb-cache2-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const cache = new AnalysisCache(dir)
  await cache.set('b'.repeat(40), { path: 'src/a.js', loc: 10 })
  await cache.flush()

  // Identical content at a different path must reuse the same entry, so the
  // path cannot be part of the cached value.
  const reloaded = new AnalysisCache(dir)
  const got = await reloaded.get('b'.repeat(40))
  assert.equal(got.loc, 10)
  assert.ok(!('path' in got), 'path must not be cached — it varies per location')
})
