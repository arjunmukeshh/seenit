// Recall by injection.
//
// A false positive is visible and annoying. A false negative is silent: the
// agent writes the third copy and nobody ever learns the tool was there. The
// product's claim — "stops your agent writing the same thing three times" — is
// a RECALL claim, and it was the one number with no evidence behind it.
//
// Precision needs a human per finding. Recall does not: take a real function
// from a real repository, transform it the way an agent would, paste it
// somewhere else, and check whether seenit surfaces it. Ground truth is known
// by construction because the copy was planted.
//
// Transformations run in increasing severity, so the output is a curve rather
// than a single number — it says where the fingerprinting gives out, which is
// more useful than "recall is 0.8":
//
//   verbatim         copied unchanged
//   rename           every identifier renamed
//   rename+literals  identifiers and string/number literals changed
//   +reformat        line breaks and indentation redone
//   +comments        comments added and removed
//   +reorder         independent statements reordered
//   +extract         a subexpression pulled into a local
//
//   node calibration/recall.mjs --repos 25 --concurrency 4

import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { analyzeSource } from '../lib/analyze/index.js'
import { findClones } from '../lib/analyze/metrics/duplication.js'
import { isAnalyzable, isTestFile } from '../lib/analyze/parser.js'

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`)
  return i === -1 ? d : args[i + 1]
}
const TARGET = Number(flag('repos', 25))
const CONCURRENCY = Number(flag('concurrency', 4))

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---- transformations, applied cumulatively in the order listed ----

const renameIdentifiers = (src, rng) => {
  const seen = new Map()
  return src.replace(/\b[a-z_$][A-Za-z0-9_$]{2,}\b/g, (word) => {
    if (RESERVED.has(word)) return word
    if (!seen.has(word)) seen.set(word, `v${Math.floor(rng() * 1e6).toString(36)}`)
    return seen.get(word)
  })
}

const changeLiterals = (src, rng) =>
  src
    .replace(/'[^'\n]*'/g, () => `'s${Math.floor(rng() * 1e6).toString(36)}'`)
    .replace(/"[^"\n]*"/g, () => `"s${Math.floor(rng() * 1e6).toString(36)}"`)
    .replace(/\b\d+\b/g, () => String(Math.floor(rng() * 900) + 10))

const reformat = (src) =>
  src
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => (i % 2 === 0 ? `  ${l}` : `    ${l}`))
    .join('\n')

const churnComments = (src) =>
  src
    .replace(/\/\/[^\n]*/g, '')
    .split('\n')
    .map((l, i) => (i % 3 === 1 ? `${l} // note ${i}` : l))
    .join('\n')

// Reorder adjacent const declarations that do not reference each other — the
// kind of harmless shuffle a model produces when rewriting from memory.
const reorderStatements = (src) => {
  const lines = src.split('\n')
  for (let i = 1; i < lines.length - 1; i++) {
    const a = lines[i]
    const b = lines[i + 1]
    if (!/^\s*(const|let)\s/.test(a) || !/^\s*(const|let)\s/.test(b)) continue
    const nameA = a.match(/(?:const|let)\s+([A-Za-z0-9_$]+)/)?.[1]
    if (nameA && b.includes(nameA)) continue
    lines[i] = b
    lines[i + 1] = a
    i++
  }
  return lines.join('\n')
}

// Pull a binary subexpression into a local — a real refactor, not a rename.
const extractVariable = (src) =>
  src.replace(/return ([A-Za-z0-9_$.]+ [+\-*/] [A-Za-z0-9_$.]+)/, (m, expr) => `const _t = ${expr}\n  return _t`)

const RESERVED = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'switch', 'case',
  'break', 'continue', 'new', 'this', 'class', 'extends', 'import', 'export', 'default', 'from',
  'async', 'await', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'null', 'undefined',
  'true', 'false', 'void', 'delete', 'in', 'of', 'yield', 'static', 'get', 'set', 'super',
])

const LEVELS = [
  ['verbatim', (s) => s],
  ['rename', (s, r) => renameIdentifiers(s, r)],
  ['rename+literals', (s, r) => changeLiterals(renameIdentifiers(s, r), r)],
  ['+reformat', (s, r) => reformat(changeLiterals(renameIdentifiers(s, r), r))],
  ['+comments', (s, r) => churnComments(reformat(changeLiterals(renameIdentifiers(s, r), r)))],
  ['+reorder', (s, r) => reorderStatements(churnComments(reformat(changeLiterals(renameIdentifiers(s, r), r))))],
  ['+extract', (s, r) => extractVariable(reorderStatements(churnComments(reformat(changeLiterals(renameIdentifiers(s, r), r)))))],
]

// Pull a substantial function body out of a source file, to use as the donor.
function donorFunction(src) {
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!/^(export\s+)?(async\s+)?function\s|^(export\s+)?const\s+[A-Za-z0-9_$]+\s*=\s*(async\s*)?\(/.test(lines[i])) continue
    let depth = 0
    for (let j = i; j < Math.min(lines.length, i + 90); j++) {
      depth += (lines[j].match(/{/g) ?? []).length - (lines[j].match(/}/g) ?? []).length
      if (depth === 0 && j > i) {
        const body = lines.slice(i, j + 1).join('\n')
        // Long enough to exceed K_GRAM once tokenized, and non-trivial.
        if (j - i >= 12 && body.length > 400) return body
        break
      }
    }
  }
  return null
}

async function measure(repo, dir, rng) {
  const files = (await run('git', ['-C', dir, 'ls-files'], { maxBuffer: 1 << 28 })).stdout
    .split('\n')
    .filter((f) => f && /\.(js|mjs|ts)$/.test(f) && isAnalyzable(f) && !isTestFile(f))
  if (files.length < 3) return null

  const facts = []
  for (const path of files.slice(0, 400)) {
    try {
      const buf = await readFile(join(dir, path))
      if (buf.length > 400_000) continue
      const f = await analyzeSource(path, buf)
      if (f) facts.push({ ...f, path })
    } catch {
      /* skip */
    }
  }
  if (facts.length < 3) return null

  // Donor: the first file yielding a substantial function.
  let donor = null
  for (const path of files.slice(0, 60)) {
    try {
      const body = donorFunction(await readFile(join(dir, path), 'utf8'))
      if (body) {
        donor = { path, body }
        break
      }
    } catch {
      /* skip */
    }
  }
  if (!donor) return null

  const found = {}
  for (const [level, transform] of LEVELS) {
    const planted = `${transform(donor.body, rng)}\n`
    const injected = await analyzeSource('__planted__.js', Buffer.from(planted))
    if (!injected) {
      found[level] = false
      continue
    }
    const clones = findClones([...facts, { ...injected, path: '__planted__.js' }])
    // Did the planted copy get linked to anything at all?
    found[level] = clones.some((c) => c.a === '__planted__.js' || c.b === '__planted__.js')
  }
  return { repo: repo.repository, ecosystem: repo.ecosystem, donor: donor.path, files: facts.length, found }
}

async function one(repo, rng) {
  const dir = await mkdtemp(join(tmpdir(), 'seenit-recall-'))
  try {
    await run('git', ['clone', '--depth', '1', '--quiet', repo.repository, dir], { timeout: 180_000 })
    return await measure(repo, dir, rng)
  } catch {
    return null
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const corpus = JSON.parse(await readFile(join(HERE, 'corpus.json'), 'utf8'))
const repos = corpus.repos ?? corpus
const rng = mulberry32(6060842)
const shuffled = [...repos].sort(() => rng() - 0.5).slice(0, TARGET * 3)

const results = []
let done = 0
async function worker(queue) {
  while (queue.length && results.length < TARGET) {
    const repo = queue.pop()
    const r = await one(repo, rng)
    done++
    if (r) results.push(r)
    process.stderr.write(`\r  ${done} tried · ${results.length}/${TARGET} usable`)
  }
}
const queue = [...shuffled]
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)))
process.stderr.write('\n')

const summary = {
  measuredAt: new Date().toISOString().slice(0, 10),
  method:
    'A substantial function is lifted from each repository, transformed, and planted back as a new file. Ground truth is known by construction. Recall is the share of plants the tool links to anything.',
  repos: results.length,
  recallByTransformation: Object.fromEntries(
    LEVELS.map(([level]) => {
      const hits = results.filter((r) => r.found[level]).length
      return [level, { found: hits, of: results.length, recall: results.length ? Number((hits / results.length).toFixed(3)) : null }]
    }),
  ),
  misses: Object.fromEntries(
    LEVELS.map(([level]) => [level, results.filter((r) => !r.found[level]).map((r) => r.repo).slice(0, 6)]),
  ),
}

await writeFile(join(HERE, 'results', 'recall.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify(summary.recallByTransformation, null, 2))
