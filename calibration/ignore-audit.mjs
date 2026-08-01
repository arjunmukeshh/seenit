// Where do findings come from?
//
// The precision study found that half the listing is not worth acting on, and
// that roughly half of THAT is files which are not source at all — lockfiles,
// generated output, declarative data, test fixtures reaching the scanner. That
// part is ignore-list work rather than a limit of the matching.
//
// This aggregates findings by extension, directory and filename across the
// TUNING repositories only. The held-out half must not inform which patterns
// get added, or the precision number measured afterwards is fitted to the same
// data it is reported on — the exact mistake this project's first threshold
// made.
//
//   node calibration/ignore-audit.mjs --concurrency 4

import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, extname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { detect, JSCPD_DEFAULT_MIN_TOKENS } from '../lib/jscpd.js'
import { buildShadow } from '../lib/normalize.js'
import { clusterBlocks } from '../lib/cluster.js'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`)
  return i === -1 ? d : args[i + 1]
}
const CONCURRENCY = Number(flag('concurrency', 4))
const TARGET = Number(flag('repos', 28))

// Identical to precision.mjs and recall.mjs. Copied rather than shared because
// changing it in one place and not the others would silently invalidate the
// split across all three studies.
const splitOf = (url) => {
  let h = 0
  for (let i = 0; i < url.length; i++) h = (Math.imul(h, 31) + url.charCodeAt(i)) >>> 0
  return h % 2 === 0 ? 'tune' : 'holdout'
}

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

async function measure(repo, dir) {
  const tracked = (await run('git', ['-C', dir, 'ls-files'], { maxBuffer: 1 << 28 })).stdout
    .split('\n')
    .filter(Boolean)
  if (tracked.filter((f) => /\.(js|mjs|cjs|ts|tsx|jsx)$/.test(f)).length < 12) return null

  const shadow = await mkdtemp(join(tmpdir(), 'seenit-audit-'))
  try {
    await buildShadow(dir, tracked, shadow)
    const blocks = await detect([shadow], { minTokens: JSCPD_DEFAULT_MIN_TOKENS, base: shadow })
    return { repo: repo.repository, findings: clusterBlocks(blocks).map((f) => [f.a, f.b]) }
  } finally {
    await rm(shadow, { recursive: true, force: true })
  }
}

async function one(repo) {
  const dir = await mkdtemp(join(tmpdir(), 'seenit-audit-repo-'))
  try {
    await run('git', ['clone', '--depth', '1', '--quiet', repo.repository, dir], { timeout: 180_000 })
    return await measure(repo, dir)
  } catch {
    return null
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const corpus = JSON.parse(await readFile(join(HERE, 'corpus.json'), 'utf8'))
const rng = mulberry32(20260801)
const pool = [...(corpus.repos ?? corpus)].filter((r) => r.ecosystem === 'npm').sort(() => rng() - 0.5)
// Same donor offset as precision.mjs, so the same repositories are in play.
const queue = pool.slice(6).filter((r) => splitOf(r.repository) === 'tune')

const results = []
let done = 0
async function worker() {
  while (queue.length && results.length < TARGET) {
    const r = await one(queue.pop())
    done++
    if (r) results.push(r)
    process.stderr.write(`\r  ${done} tried · ${results.length}/${TARGET} usable`)
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker))
process.stderr.write('\n')

// Count each file once per finding it appears in. A file pulled into many
// findings is exactly the kind that an ignore pattern would clear out.
const byExt = {}
const byDir = {}
const byName = {}
const bump = (m, k) => (m[k] = (m[k] ?? 0) + 1)

let total = 0
for (const r of results) {
  for (const pair of r.findings) {
    total++
    for (const f of pair) {
      bump(byExt, extname(f) || '(none)')
      for (const seg of dirname(f).split('/')) if (seg && seg !== '.') bump(byDir, seg)
      bump(byName, basename(f))
    }
  }
}

const top = (m, n = 30) =>
  Object.fromEntries(
    Object.entries(m)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n),
  )

const out = {
  measuredAt: new Date().toISOString().slice(0, 10),
  split: 'tune',
  note: 'Counts are file appearances across findings, tuning repositories only. The held-out half is deliberately absent.',
  repos: results.length,
  findings: total,
  byExtension: top(byExt),
  byDirectorySegment: top(byDir),
  byFilename: top(byName, 40),
  perRepoFindings: Object.fromEntries(results.map((r) => [r.repo, r.findings.length])),
}
await writeFile(join(HERE, 'results', 'ignore-audit.json'), JSON.stringify(out, null, 2) + '\n')
console.log(JSON.stringify({ repos: out.repos, findings: out.findings, byExtension: out.byExtension }, null, 2))
