// Precision, measured two ways.
//
// The recall study could construct its own ground truth: plant a copy, then ask
// whether it comes back. Precision cannot be constructed that way — deciding
// whether a reported pair is really the same code is a judgement. So this study
// splits the question in two, and only the second half needs a judge.
//
//   A. False "already written". An agent asks find_existing about code the
//      repository does not contain. Ground truth is known by construction: the
//      probe is a real function lifted from a DIFFERENT repository in the
//      corpus, so any hit is either a false positive or a genuinely equivalent
//      implementation. Both are recorded with their matched source so the
//      distinction can be made afterwards rather than assumed.
//
//   B. Precision of the listing. `seenit` with no arguments reports duplicated
//      regions. Whether a region is worth deduplicating is a judgement, so this
//      half emits cases for a blind judge instead of scoring itself.
//
// Two sampling rules the earlier calibration learned the hard way:
//
//   - At most a few cases per repository. Pooling every finding lets one repo
//     own the result; in the previous alignment study a single repository
//     contributed 69% of the mass.
//   - Cases are sampled at two ranks: from the top three, which is what the CLI
//     actually prints, and uniformly from the rest. Precision of what a user
//     sees is not precision over everything found, and reporting one as the
//     other would overstate whichever is better.
//
// Controls: each repository also contributes a pair of regions seenit did NOT
// flag, shuffled into the cases and marked nowhere in the file the judge reads.
// A judge that accepts controls is not discriminating, and its verdicts on the
// real cases mean nothing. The control acceptance rate is reported next to the
// precision number, not buried.
//
//   node calibration/precision.mjs --repos 60 --concurrency 4

import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { detect, isTest, JSCPD_DEFAULT_MIN_TOKENS } from '../lib/jscpd.js'
import { buildShadow, normalizeSource } from '../lib/normalize.js'
import { clusterBlocks } from '../lib/cluster.js'

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
const TARGET = Number(flag('repos', 60))
const CONCURRENCY = Number(flag('concurrency', 4))
// The shipped operating point, not a sweep. Precision is being measured for the
// bar the tool actually uses.
const MIN_TOKENS = Number(flag('min-tokens', JSCPD_DEFAULT_MIN_TOKENS))
const ECOSYSTEMS = new Set(flag('ecosystems', 'npm').split(','))
// Per repository. Two flagged cases and one control keeps the labelling set
// small enough to judge carefully and large enough to have an interval.
const CASES_PER_REPO = 2
// Probe donors come from their own repositories, held out of the measured set.
// Harvesting donors from the repositories being measured would make the probe
// depend on the order repositories happened to finish in, and would let a
// repository be probed with a function from a repository that is also a result.
const DONOR_REPOS = Number(flag('donors', 6))

// Same split function as recall.mjs, deliberately: a repository that tuned the
// min-tokens bar must not also score it here.
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

// Cases carry real source, so cap them. Sixty lines is more than enough to tell
// whether two regions are the same thing, and keeps the labelling file readable.
const MAX_CASE_LINES = 60

async function region(dir, path, start, end) {
  try {
    const lines = (await readFile(join(dir, path), 'utf8')).split('\n')
    const clipped = Math.min(end, start + MAX_CASE_LINES - 1)
    return {
      path,
      start,
      end,
      truncated: clipped < end,
      code: lines.slice(start - 1, clipped).join('\n'),
    }
  } catch {
    return null
  }
}

// Same shape as a real finding, but from two regions seenit did not link. The
// judge sees no difference; the answer key does.
async function control(dir, files, rng, lineCount) {
  const pick = () => files[Math.floor(rng() * files.length)]
  for (let attempt = 0; attempt < 40; attempt++) {
    const [pa, pb] = [pick(), pick()]
    if (!pa || !pb || pa === pb) continue
    try {
      const [la, lb] = await Promise.all([
        readFile(join(dir, pa), 'utf8').then((s) => s.split('\n')),
        readFile(join(dir, pb), 'utf8').then((s) => s.split('\n')),
      ])
      if (la.length < lineCount + 4 || lb.length < lineCount + 4) continue
      const sa = 1 + Math.floor(rng() * (la.length - lineCount - 1))
      const sb = 1 + Math.floor(rng() * (lb.length - lineCount - 1))
      const a = await region(dir, pa, sa, sa + lineCount - 1)
      const b = await region(dir, pb, sb, sb + lineCount - 1)
      // A region of only blank lines or closing braces is not a fair control —
      // it is trivially rejectable and would flatter the judge.
      const substantial = (r) => r && r.code.split('\n').filter((l) => l.trim().length > 3).length >= lineCount * 0.6
      if (substantial(a) && substantial(b)) return { a, b, lines: lineCount }
    } catch {
      /* try another pair */
    }
  }
  return null
}

// Pull a substantial function body out of a source file, to use as a probe.
// Same extractor as recall.mjs — the donor population should be identical, so
// that a difference between the two studies is a difference in what is being
// measured and not in what was fed to it.
function donorFunction(src) {
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!/^(export\s+)?(async\s+)?function\s|^(export\s+)?const\s+[A-Za-z0-9_$]+\s*=\s*(async\s*)?\(/.test(lines[i])) continue
    let depth = 0
    for (let j = i; j < Math.min(lines.length, i + 90); j++) {
      depth += (lines[j].match(/{/g) ?? []).length - (lines[j].match(/}/g) ?? []).length
      if (depth === 0 && j > i) {
        const body = lines.slice(i, j + 1).join('\n')
        if (j - i >= 12 && body.length > 400) return body
        break
      }
    }
  }
  return null
}

// Clone a repository just to lift one function out of it.
async function harvestDonor(repo) {
  const dir = await mkdtemp(join(tmpdir(), 'seenit-donor-'))
  try {
    await run('git', ['clone', '--depth', '1', '--quiet', repo.repository, dir], { timeout: 180_000 })
    const files = (await run('git', ['-C', dir, 'ls-files'], { maxBuffer: 1 << 28 })).stdout
      .split('\n')
      .filter((f) => f && /\.(js|mjs|cjs|ts)$/.test(f) && !isTest(f) && !f.includes('node_modules/'))
    for (const path of files.slice(0, 60)) {
      try {
        const body = donorFunction(await readFile(join(dir, path), 'utf8'))
        if (body) return { repo: repo.repository, path, body, ext: path.slice(path.lastIndexOf('.')) }
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

async function measure(repo, dir, rng, donor) {
  const tracked = (await run('git', ['-C', dir, 'ls-files'], { maxBuffer: 1 << 28 })).stdout
    .split('\n')
    .filter(Boolean)
  const js = tracked.filter((f) => /\.(js|mjs|cjs|ts|tsx|jsx)$/.test(f) && !isTest(f) && !f.includes('node_modules/'))
  if (js.length < 12) return null

  const shadow = await mkdtemp(join(tmpdir(), 'seenit-precision-'))
  try {
    // One shadow, two measurements. Normalizing the tree is the whole cost.
    await buildShadow(dir, tracked, shadow)

    // ---- B: what the listing reports ----
    const blocks = await detect([shadow], { minTokens: MIN_TOKENS, base: shadow })
    const findings = clusterBlocks(blocks)

    const cases = []
    // Rank matters: the CLI prints three. Sample one from what a user sees and
    // one from the tail, and keep the rank so they can be reported apart.
    const buckets = [findings.slice(0, 3), findings.slice(3)]
    for (const [i, bucket] of buckets.entries()) {
      if (!bucket.length || cases.length >= CASES_PER_REPO) continue
      const f = bucket[Math.floor(rng() * bucket.length)]
      const [a, b] = await Promise.all([region(dir, f.a, f.aStart, f.aEnd), region(dir, f.b, f.bStart, f.bEnd)])
      if (a && b) {
        cases.push({ kind: 'finding', rank: i === 0 ? 'displayed' : 'tail', lines: f.lines, tokens: f.tokens, a, b })
      }
    }

    // One control per repository, sized like the cases it hides among. Capped
    // well below MAX_CASE_LINES: a 200-line finding would demand two 200-line
    // files to draw a control from, and most repositories have none.
    const size = cases.length ? Math.min(cases[0].lines, 40) : 20
    const ctrl = await control(dir, js, rng, Math.max(8, size))
    if (ctrl) cases.push({ kind: 'control', rank: null, ...ctrl, tokens: null })

    // ---- A: asking about code that is not here ----
    // A donor lifted from a different repository. Any hit is a claim that the
    // repository already contains code it demonstrably does not.
    const foreign = donor
    let probe = null
    if (foreign) {
      const planted = `__seenit_probe__${foreign.ext}`
      const text = await normalizeSource(planted, `${foreign.body}\n`)
      await writeFile(join(shadow, planted), text ?? foreign.body)
      const withProbe = await detect([shadow], { minTokens: MIN_TOKENS, base: shadow, includeTests: true })
      const hits = withProbe.filter((b) => (b.a === planted) !== (b.b === planted))
      probe = {
        from: foreign.repo,
        donor: foreign.path,
        hit: hits.length > 0,
        // Keep the evidence. A hit is not automatically an error — two
        // repositories can genuinely contain the same helper — and that call
        // cannot be made from a boolean.
        matches: await Promise.all(
          hits.slice(0, 3).map(async (h) => {
            const mine = h.a === planted
            const file = mine ? h.b : h.a
            const [s, e] = mine ? [h.bStart, h.bEnd] : [h.aStart, h.aEnd]
            return { ...(await region(dir, file, s, e)), lines: h.lines, tokens: h.tokens }
          }),
        ),
        probeCode: hits.length ? foreign.body.split('\n').slice(0, MAX_CASE_LINES).join('\n') : null,
      }
    }

    return {
      repo: repo.repository,
      split: splitOf(repo.repository),
      ecosystem: repo.ecosystem,
      files: tracked.length,
      codeFiles: js.length,
      findings: findings.length,
      pairs: blocks.length,
      cases,
      probe,
    }
  } finally {
    await rm(shadow, { recursive: true, force: true })
  }
}

async function one(repo, rng, donor) {
  const dir = await mkdtemp(join(tmpdir(), 'seenit-precision-repo-'))
  try {
    await run('git', ['clone', '--depth', '1', '--quiet', repo.repository, dir], { timeout: 180_000 })
    return await measure(repo, dir, rng, donor)
  } catch {
    return null
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const corpus = JSON.parse(await readFile(join(HERE, 'corpus.json'), 'utf8'))
const repos = corpus.repos ?? corpus
const rng = mulberry32(20260801)
const pool = [...repos].filter((r) => ECOSYSTEMS.has(r.ecosystem)).sort(() => rng() - 0.5)

// Donor repositories come off the front, measured repositories off the back, so
// the two sets never overlap.
const donorRepos = pool.slice(0, DONOR_REPOS)
const measured = pool.slice(DONOR_REPOS, DONOR_REPOS + TARGET * 4)

process.stderr.write(`  harvesting donors from ${donorRepos.length} repositories\n`)
const donors = (await Promise.all(donorRepos.map(harvestDonor))).filter(Boolean)
if (!donors.length) throw new Error('no probe donors could be harvested — cannot measure false positives')
process.stderr.write(`  ${donors.length} donors\n`)

const results = []
// ONE shared queue. Giving each worker its own copy had every worker cloning
// the same repositories and the results silently triple-counting them.
const queue = [...measured]
let done = 0
let nextDonor = 0
async function worker() {
  while (queue.length && results.length < TARGET) {
    const repo = queue.pop()
    const r = await one(repo, rng, donors[nextDonor++ % donors.length])
    done++
    if (r) results.push(r)
    process.stderr.write(`\r  ${done} tried · ${results.length}/${TARGET} usable`)
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker))
process.stderr.write('\n')

// Wilson score interval — the normal approximation is wrong at these sample
// sizes and near the extremes, which is where these numbers sit.
const wilson = (hits, n) => {
  if (!n) return null
  const z = 1.96
  const p = hits / n
  const d = 1 + (z * z) / n
  const c = p + (z * z) / (2 * n)
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return [Number(((c - s) / d).toFixed(3)), Number(((c + s) / d).toFixed(3))]
}

const probed = results.filter((r) => r.probe)
const falseHits = probed.filter((r) => r.probe.hit)

// The judge must not see the answer key, the repository, or which items were
// flagged. Shuffled, stripped, and written separately from the raw results.
const allCases = results.flatMap((r) =>
  r.cases.map((c) => ({ ...c, repo: r.repo, split: r.split })),
)
for (let i = allCases.length - 1; i > 0; i--) {
  const j = Math.floor(rng() * (i + 1))
  ;[allCases[i], allCases[j]] = [allCases[j], allCases[i]]
}
const withIds = allCases.map((c, i) => ({ id: `c${String(i + 1).padStart(3, '0')}`, ...c }))

await mkdir(join(HERE, 'results'), { recursive: true })

// The key: everything the judge must not see.
await writeFile(
  join(HERE, 'results', 'precision-key.json'),
  JSON.stringify(
    {
      measuredAt: new Date().toISOString().slice(0, 10),
      engine: `jscpd ${JSCPD_VERSION}`,
      minTokens: MIN_TOKENS,
      repos: {
        total: results.length,
        tune: results.filter((r) => r.split === 'tune').length,
        holdout: results.filter((r) => r.split === 'holdout').length,
      },
      falsePositiveProbe: {
        method:
          'A real function from a different corpus repository is planted as a find_existing probe. The repository does not contain it, so any hit is either a false positive or a genuinely equivalent implementation; matched source is kept so the two can be told apart.',
        probed: probed.length,
        hits: falseHits.length,
        rate: probed.length ? Number((falseHits.length / probed.length).toFixed(3)) : null,
        ci95: wilson(falseHits.length, probed.length),
      },
      findingCounts: {
        reposWithNoFindings: results.filter((r) => r.findings === 0).length,
        medianFindings: results.length
          ? [...results.map((r) => r.findings)].sort((a, b) => a - b)[Math.floor(results.length / 2)]
          : null,
        maxFindings: Math.max(0, ...results.map((r) => r.findings)),
      },
      // Provenance lives here rather than in the cases file, so a verdict can
      // be traced back to the source it was made from without the judge ever
      // seeing where the code came from.
      key: withIds.map((c) => ({
        id: c.id,
        kind: c.kind,
        rank: c.rank,
        repo: c.repo,
        split: c.split,
        a: c.a && { path: c.a.path, start: c.a.start, end: c.a.end },
        b: c.b && { path: c.b.path, start: c.b.start, end: c.b.end },
      })),
      repos_detail: results.map(({ cases, probe, ...rest }) => ({
        ...rest,
        probeHit: probe?.hit ?? null,
        probeFrom: probe?.from ?? null,
      })),
      probeEvidence: falseHits.map((r) => ({ repo: r.repo, ...r.probe })),
    },
    null,
    2,
  ) + '\n',
)

// What the judge sees: two regions, no repository, no verdict, no distinction
// between a flagged pair and a control.
await writeFile(
  join(HERE, 'results', 'precision-cases.json'),
  JSON.stringify(
    withIds.map((c) => ({ id: c.id, a: { code: c.a.code }, b: { code: c.b.code } })),
    null,
    2,
  ) + '\n',
)

console.log(
  JSON.stringify(
    {
      repos: results.length,
      cases: withIds.length,
      controls: withIds.filter((c) => c.kind === 'control').length,
      probe: { probed: probed.length, falseHits: falseHits.length },
    },
    null,
    2,
  ),
)
