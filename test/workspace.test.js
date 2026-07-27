import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git, repoRoot, gitDir } from '../lib/git.js'
import { workingChanges, workspaceFiles, hashWorkingFiles } from '../lib/workspace.js'
import { AnalysisCache, cacheKey } from '../lib/cache.js'

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

test('cache: a one-entry change rewrites one shard, not the whole cache', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gcb-shard-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  // Populate entries spread across many shards.
  const cache = new AnalysisCache(dir)
  const shas = []
  for (let i = 0; i < 400; i++) {
    const sha = i.toString(16).padStart(2, '0').slice(0, 2) + 'f'.repeat(38)
    shas.push(sha)
    await cache.set(sha, { loc: i, functions: [] })
  }
  await cache.flush()

  const versionDir = join(dir, (await readdir(dir)).find((d) => d.startsWith('v')))
  const before = new Map()
  for (const name of await readdir(versionDir)) {
    before.set(name, (await stat(join(versionDir, name))).mtimeMs)
  }
  assert.ok(before.size > 1, 'entries must spread across multiple shards')

  // Change exactly one entry. This is the incremental case: an agent edits one
  // file and the cost of recording it must not scale with repository size.
  await new Promise((r) => setTimeout(r, 12)) // mtime granularity
  const fresh = new AnalysisCache(dir)
  await fresh.set(shas[0], { loc: 9999, functions: [] })
  await fresh.flush()

  const rewritten = []
  for (const name of await readdir(versionDir)) {
    if (before.get(name) !== (await stat(join(versionDir, name))).mtimeMs) rewritten.push(name)
  }
  assert.deepEqual(rewritten, [`${shas[0].slice(0, 2)}.json`], 'exactly one shard may be rewritten')

  // And the untouched entries must still be readable.
  const reader = new AnalysisCache(dir)
  assert.equal((await reader.get(shas[0])).loc, 9999)
  assert.equal((await reader.get(shas[399])).loc, 399)
})

test('stat index: returns the same SHAs as hashing, and notices edits', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gcb-stat-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await git(dir, ['init', '-q'])
  await writeFile(join(dir, 'a.js'), 'export const a = 1\n')
  await writeFile(join(dir, 'b.js'), 'export const b = 2\n')

  const root = await repoRoot(dir)
  const paths = await workspaceFiles(root)
  assert.deepEqual(paths, ['a.js', 'b.js'])

  const truth = await hashWorkingFiles(root, paths) // no index: hashes everything
  const cache = new AnalysisCache(join(dir, 'cache'))

  // First pass populates the index; second pass must be served from it.
  const first = await hashWorkingFiles(root, paths, { statIndex: cache.statIndex })
  assert.deepEqual([...first].sort(), [...truth].sort(), 'indexed hashing must agree with direct hashing')
  await cache.flush()

  const reopened = new AnalysisCache(join(dir, 'cache'))
  const second = await hashWorkingFiles(root, paths, { statIndex: reopened.statIndex })
  assert.deepEqual([...second].sort(), [...truth].sort(), 'a cached SHA must equal the real one')

  // An edit must produce a different SHA — a stale hit here would attribute the
  // wrong analysis to the file, which is worse than being slow.
  await new Promise((r) => setTimeout(r, 2100)) // clear the racily-clean window
  await writeFile(join(dir, 'a.js'), 'export const a = 999\n')
  const after = await hashWorkingFiles(root, paths, { statIndex: reopened.statIndex })
  assert.notEqual(after.get('a.js'), truth.get('a.js'), 'edited file must re-hash')
  assert.equal(after.get('b.js'), truth.get('b.js'), 'untouched file keeps its SHA')

  const direct = await hashWorkingFiles(root, paths)
  assert.equal(after.get('a.js'), direct.get('a.js'), 'the re-hash must be correct, not merely different')
})

test('cache key: identical content in different languages must not collide', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gcb-key-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  // Byte-identical content at two extensions hashes to ONE git blob, but the
  // grammar comes from the extension, so the analyses are not interchangeable.
  // Keying on the SHA alone let whichever file was analyzed first win, and the
  // other silently inherited its facts.
  const source = 'export const a = 1\n'
  const sha = 'c'.repeat(40)
  assert.notEqual(cacheKey(sha, 'util.ts'), cacheKey(sha, 'util.js'), 'ts and js must key differently')
  assert.equal(cacheKey(sha, 'a/util.ts'), cacheKey(sha, 'b/util.ts'), 'same language, same content: one entry')

  const cache = new AnalysisCache(dir)
  await cache.set(cacheKey(sha, 'util.ts'), { language: 'typescript', loc: 1 })
  await cache.set(cacheKey(sha, 'util.js'), { language: 'javascript', loc: 1 })

  assert.equal((await cache.get(cacheKey(sha, 'util.ts'))).language, 'typescript')
  assert.equal((await cache.get(cacheKey(sha, 'util.js'))).language, 'javascript')

  // And the shard prefix must still be the SHA, or the buckets stop being even.
  assert.ok(cacheKey(sha, 'util.ts').startsWith(sha.slice(0, 2)))
  assert.equal(source.length, 19) // guard against the fixture drifting
})
