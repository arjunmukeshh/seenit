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

import { detect, isTest } from '../lib/jscpd.js'
import { buildShadow, normalizeSource } from '../lib/normalize.js'

const JSCPD_VERSION = JSON.parse(
  await readFile(new URL('../node_modules/jscpd/package.json', import.meta.url), 'utf8'),
).version

const run = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`)
  return i === -1 ? d : args[i + 1]
}
const TARGET = Number(flag('repos', 25))
// Repositories are split in two by a stable hash of their URL. The percentile
// is chosen by looking ONLY at the tuning half; the reported recall comes from
// the held-out half, which no choice has ever seen.
//
// Without this the study repeats the mistake it exists to catch: the original
// alignment cutoff was picked from the gap in 30 labelled cases and then scored
// on those same 30 cases. Choosing p75 by comparing recall on eleven repos and
// then reporting recall at p75 on those eleven would be the same error wearing
// a different hat.
const splitOf = (url) => {
  let h = 0
  for (let i = 0; i < url.length; i++) h = (Math.imul(h, 31) + url.charCodeAt(i)) >>> 0
  return h % 2 === 0 ? 'tune' : 'holdout'
}
// The bar being swept. jscpd's own default is 30 — flat, and identical for a
// 42-file repository and a 38,000-file one, which is the failure this project
// already documented for its own flat threshold. Sweeping it here is what lets
// the bar be chosen from an outcome instead of accepted from a default.
const MIN_TOKENS = (flag('min-tokens', '20,30,50,75')).split(',').map(Number)
// The injection harness lifts a JavaScript function and plants it back, so a
// Java or Go repository yields nothing and its "recall 0" is an artifact of the
// filter rather than a fact about the language. Sampling is restricted to the
// ecosystems where the measurement means something — which is also the honest
// answer to "should this use all 1,114 repos": only the ~196 npm ones can
// answer this particular question.
const ECOSYSTEMS = new Set((flag('ecosystems', 'npm')).split(','))
const CONCURRENCY = Number(flag('concurrency', 4))
// Repositories used only as a source of negative probes, held out of the
// measured set.
const DONOR_REPOS = Number(flag('donors', 8))

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

async function measure(repo, dir, rng, foreign) {
  const files = (await run('git', ['-C', dir, 'ls-files'], { maxBuffer: 1 << 28 })).stdout
    .split('\n')
    .filter((f) => f && /\.(js|mjs|ts)$/.test(f) && !isTest(f) && !f.includes('node_modules/'))
  if (files.length < 12) return null // too little JS here for the result to mean anything

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

  // Plant with the DONOR's extension. jscpd treats .ts and .js as separate
  // formats, so planting TypeScript into a .js file made the copy invisible for
  // reasons that had nothing to do with how well it hid — the same artifact as
  // the previous study's non-JS repositories scoring zero.
  const ext = donor.path.slice(donor.path.lastIndexOf('.'))
  const planted = `__seenit_planted__${ext}`

  // Build the shadow ONCE. It depends only on the repository, not on the bar or
  // the transformation, and normalizing every file 28 times over made tree-sitter
  // the entire cost of the study.
  const shadow = await mkdtemp(join(tmpdir(), 'seenit-recall-shadow-'))
  const found = {}
  const negative = {}
  try {
    await buildShadow(dir, files, shadow)

    // Which repository files did the planted probe get linked to? Answering
    // with a boolean was the original mistake: a probe that matched some
    // unrelated file counted as "found", so recall was measured as "something
    // came back" rather than "the right thing came back".
    const probeHits = async (bar) => {
      const blocks = await detect([shadow], { minTokens: bar, base: shadow, includeSecondary: true })
      return blocks
        .filter((b) => (b.a === planted) !== (b.b === planted))
        .map((b) => (b.a === planted ? b.b : b.a))
    }

    for (const bar of MIN_TOKENS) {
      found[bar] = {}
      for (const [level, transform] of LEVELS) {
        const text = await normalizeSource(planted, `${transform(donor.body, rng)}\n`)
        await writeFile(join(shadow, planted), text ?? '')
        const hits = await probeHits(bar)
        found[bar][level] = {
          hit: hits.length > 0,
          // The planted copy came from donor.path. Anything else is a wrong
          // answer, and a wrong answer is a false positive, not a hit.
          correct: hits.includes(donor.path),
          matched: hits.slice(0, 3),
        }
      }
    }

    // Negatives, through the same code path and the same shadow: a real
    // function from a DIFFERENT repository, which this one provably does not
    // contain. Measuring these separately, on a separate surface, was the other
    // half of the labelling problem — specificity and recall have to come from
    // the same thing before they can be read together.
    if (foreign) {
      const text = await normalizeSource(planted, `${foreign.body}\n`)
      await writeFile(join(shadow, planted), text ?? '')
      for (const bar of MIN_TOKENS) {
        const hits = await probeHits(bar)
        negative[bar] = { hit: hits.length > 0, matched: hits.slice(0, 3) }
      }
    }
  } finally {
    await rm(shadow, { recursive: true, force: true })
  }
  return {
    repo: repo.repository,
    split: splitOf(repo.repository),
    ecosystem: repo.ecosystem,
    donor: donor.path,
    files: files.length,
    found,
    negative,
    foreignFrom: foreign?.repo ?? null,
  }
}

// Clone a repository only to lift one function out of it, for use as a
// negative probe elsewhere. Donor repositories are held out of the measured
// set, so no repository is ever probed with a function from a repository that
// is also a result.
async function harvestDonor(repo) {
  const dir = await mkdtemp(join(tmpdir(), 'seenit-recall-donor-'))
  try {
    await run('git', ['clone', '--depth', '1', '--quiet', repo.repository, dir], { timeout: 180_000 })
    const files = (await run('git', ['-C', dir, 'ls-files'], { maxBuffer: 1 << 28 })).stdout
      .split('\n')
      .filter((f) => f && /\.(js|mjs|ts)$/.test(f) && !isTest(f) && !f.includes('node_modules/'))
    for (const path of files.slice(0, 60)) {
      try {
        const body = donorFunction(await readFile(join(dir, path), 'utf8'))
        if (body) return { repo: repo.repository, path, body }
      } catch {
        /* skip */
      }
    }
    return null
  } catch {
    return null
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function one(repo, rng, foreign) {
  const dir = await mkdtemp(join(tmpdir(), 'seenit-recall-'))
  try {
    await run('git', ['clone', '--depth', '1', '--quiet', repo.repository, dir], { timeout: 180_000 })
    return await measure(repo, dir, rng, foreign)
  } catch {
    return null
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const corpus = JSON.parse(await readFile(join(HERE, 'corpus.json'), 'utf8'))
const repos = corpus.repos ?? corpus
const rng = mulberry32(6060842)
const pool = [...repos].filter((r) => ECOSYSTEMS.has(r.ecosystem)).sort(() => rng() - 0.5)
const donorRepos = pool.slice(0, DONOR_REPOS)
const shuffled = pool.slice(DONOR_REPOS, DONOR_REPOS + TARGET * 4)

process.stderr.write(`  harvesting negative probes from ${donorRepos.length} repositories\n`)
const donors = (await Promise.all(donorRepos.map(harvestDonor))).filter(Boolean)
if (!donors.length) throw new Error('no negative probes could be harvested')
process.stderr.write(`  ${donors.length} donors\n`)

const results = []
let done = 0
let nextDonor = 0
async function worker(queue) {
  while (queue.length && results.length < TARGET) {
    const repo = queue.pop()
    const r = await one(repo, rng, donors[nextDonor++ % donors.length])
    done++
    if (r) results.push(r)
    process.stderr.write(`\r  ${done} tried · ${results.length}/${TARGET} usable`)
  }
}
const queue = [...shuffled]
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)))
process.stderr.write('\n')

// A probe that came back with the donor's own file is a true positive. A probe
// that came back with some other file is a false positive, not a hit — scoring
// it as one measured "something was returned" rather than "the right thing was
// returned", which is a different and much easier question.
const recallFor = (rows, pct, level) => {
  if (!rows.length) return null
  const cells = rows.map((r) => r.found[pct]?.[level]).filter(Boolean)
  const tp = cells.filter((c) => c.correct).length
  const wrong = cells.filter((c) => c.hit && !c.correct).length
  const missed = cells.filter((c) => !c.hit).length
  return {
    found: tp,
    of: cells.length,
    recall: cells.length ? Number((tp / cells.length).toFixed(3)) : null,
    wrongFile: wrong,
    missed,
  }
}

// Negatives share the surface, the shadow and the code path with the positives
// above, so the two compose into one confusion matrix instead of describing two
// different things that happen to both be called accuracy.
const negativesFor = (rows, pct) => {
  const cells = rows.map((r) => r.negative?.[pct]).filter(Boolean)
  const fp = cells.filter((c) => c.hit).length
  return { of: cells.length, falsePositives: fp, trueNegatives: cells.length - fp }
}

// Wilson score interval — the normal approximation is badly wrong at these
// sample sizes and near the extremes, which is exactly where these numbers sit.
const wilson = (hits, n) => {
  if (!n) return null
  const z = 1.96
  const p = hits / n
  const d = 1 + (z * z) / n
  const c = p + (z * z) / (2 * n)
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return [Number(((c - s) / d).toFixed(3)), Number(((c + s) / d).toFixed(3))]
}

const tune = results.filter((r) => r.split === 'tune')
const holdout = results.filter((r) => r.split === 'holdout')

// Chosen by looking only at the tuning half, at the hardest transformation.
const hardest = LEVELS[LEVELS.length - 1][0]
// Ties break toward the HIGHER bar: equal recall for fewer findings is a
// strictly better trade, and the old study learned this the hard way when p60
// and p75 tied inside the CI while p60 produced four times the noise.
const chosen = MIN_TOKENS.map((bar) => ({ pct: bar, r: recallFor(tune, bar, hardest)?.recall ?? 0 })).sort(
  (a, b) => b.r - a.r || b.pct - a.pct,
)[0]

// One surface, both directions: precision, recall and specificity computed
// from a single confusion matrix rather than assembled from separate studies.
const matrixFor = (rows, pct, level) => {
  const pos = recallFor(rows, pct, level)
  const neg = negativesFor(rows, pct)
  if (!pos) return null
  const tp = pos.found
  // Every wrong answer counts against precision, whichever probe produced it:
  // a positive probe answered with the wrong file, and a negative probe
  // answered at all, are both the tool claiming code exists where it does not.
  const fp = pos.wrongFile + neg.falsePositives
  const fn = pos.missed
  const tn = neg.trueNegatives
  return {
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    trueNegatives: tn,
    precision: tp + fp ? Number((tp / (tp + fp)).toFixed(3)) : null,
    precisionCi95: tp + fp ? wilson(tp, tp + fp) : null,
    recall: tp + fn ? Number((tp / (tp + fn)).toFixed(3)) : null,
    recallCi95: tp + fn ? wilson(tp, tp + fn) : null,
    specificity: tn + neg.falsePositives ? Number((tn / (tn + neg.falsePositives)).toFixed(3)) : null,
    specificityCi95: tn + neg.falsePositives ? wilson(tn, tn + neg.falsePositives) : null,
  }
}

const summary = {
  measuredAt: new Date().toISOString().slice(0, 10),
  surface: 'find_existing — the same call the MCP tool and the pre-write hook make. Not the listing.',
  method:
    'Positives: a substantial function is lifted from the repository, transformed, and planted back as a probe; a hit counts only when the location returned is the file the function came from. Negatives: a real function from a different corpus repository, which this one provably does not contain, planted through the same code path — any hit is a false positive. Ground truth is known by construction on both sides, so nothing is hand-labelled. Repositories are split by a stable hash of their URL: the min-tokens bar is chosen on the tuning half only, and headline figures come from the held-out half.',
  repos: { total: results.length, tune: tune.length, holdout: holdout.length },
  engine: 'jscpd ' + JSCPD_VERSION,
  chosenOnTuningSplit: { minTokens: chosen?.pct ?? null, recallAtHardest: chosen?.r ?? null },
  // The headline confusion matrix: held-out repositories, shipped bar, hardest
  // transformation.
  heldOutMatrix: Object.fromEntries(
    MIN_TOKENS.map((pct) => [pct, Object.fromEntries(LEVELS.map(([level]) => [level, matrixFor(holdout, pct, level)]))]),
  ),
  heldOutNegatives: Object.fromEntries(MIN_TOKENS.map((pct) => [pct, negativesFor(holdout, pct)])),
  heldOut: Object.fromEntries(
    MIN_TOKENS.map((pct) => [
      pct,
      Object.fromEntries(
        LEVELS.map(([level]) => {
          const r = recallFor(holdout, pct, level)
          return [level, r ? { ...r, ci95: wilson(r.found, r.of) } : null]
        }),
      ),
    ]),
  ),
  tuning: Object.fromEntries(
    MIN_TOKENS.map((pct) => [pct, Object.fromEntries(LEVELS.map(([level]) => [level, recallFor(tune, pct, level)]))]),
  ),
  byEcosystem: Object.fromEntries(
    [...new Set(results.map((r) => r.ecosystem))].map((eco) => {
      const rows = results.filter((r) => r.ecosystem === eco)
      return [eco, { repos: rows.length, recallAtChosen: recallFor(rows, chosen?.pct, hardest) }]
    }),
  ),
}

await writeFile(join(HERE, 'results', 'recall.json'), JSON.stringify(summary, null, 2) + '\n')
const bar = summary.chosenOnTuningSplit.minTokens
console.log(
  JSON.stringify(
    {
      surface: summary.surface,
      repos: summary.repos,
      chosen: summary.chosenOnTuningSplit,
      heldOutNegatives: summary.heldOutNegatives[bar],
      matrixVerbatim: summary.heldOutMatrix[bar]?.verbatim,
      matrixHardest: summary.heldOutMatrix[bar]?.['+extract'],
    },
    null,
    2,
  ),
)
