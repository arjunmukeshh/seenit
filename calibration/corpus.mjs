#!/usr/bin/env node
// Corpus sampling — selects the repositories the calibration runs against.
//
// The sampling design is the part of this study most able to quietly determine
// its own answer, so it is mechanical and seeded rather than curated.
//
// Dependents is used as an INCLUSION FILTER, not a ranking. Sorting by
// dependent count and taking the top N returns React, TypeScript and Angular —
// projects with full-time maintainers, mandatory review and heavy CI. Their
// distributions would yield thresholds that no ordinary codebase meets, which
// is precisely the failure mode this study exists to avoid. The floor says
// "someone actually depends on this"; the random draw within strata does the
// rest.
//
// Source: ecosyste.ms — free, no API key, and covers npm/PyPI/crates/Go/Maven/
// RubyGems with dependent counts, repository URLs and repo metadata.

import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const API = 'https://packages.ecosyste.ms/api/v1'

// Registries mapped to the analyzer's language names (lib/analyze/parser.js).
//
// The first corpus sampled only npm and PyPI, which left Rust, Java, C++, Go,
// Ruby, C# and PHP represented solely by whatever incidental files happened to
// sit inside JavaScript and Python packages. Those samples were thin — 11
// projects for Java, 12 for Rust — and several fell below the five-project
// minimum and produced no thresholds at all. A language is only properly
// calibrated by sampling its own ecosystem.
export const REGISTRIES = {
  npm: { registry: 'npmjs.org', languages: ['javascript', 'typescript', 'tsx'] },
  pypi: { registry: 'pypi.org', languages: ['python'] },
  cargo: { registry: 'crates.io', languages: ['rust'] },
  go: { registry: 'proxy.golang.org', languages: ['go'] },
  maven: { registry: 'repo1.maven.org', languages: ['java'] },
  nuget: { registry: 'nuget.org', languages: ['c-sharp'] },
  packagist: { registry: 'packagist.org', languages: ['php'] },
  rubygems: { registry: 'rubygems.org', languages: ['ruby'] },
}

export const CRITERIA = {
  minDependents: 10, // "relied upon", not abandoned toy code
  maxRepoSizeKb: 200_000, // ~200MB: excludes monorepos and vendored blobs
  minRepoSizeKb: 50, // excludes empty/placeholder repos
  maxAgeSincePushDays: 730, // still maintained
  pageSeed: 990427, // fixes which pages are drawn, so the sample is reproducible
}

// Strata. Age comes from the registry; size from repo metadata (KB, a proxy
// for LOC at selection time — actual LOC is measured after cloning).
const AGE_STRATA = [
  { name: 'new', maxYears: 1 },
  { name: 'mid', maxYears: 5 },
  { name: 'old', maxYears: Infinity },
]
const SIZE_STRATA = [
  { name: 'small', maxKb: 5_000 },
  { name: 'medium', maxKb: 50_000 },
  { name: 'large', maxKb: Infinity },
]

// Deterministic RNG (mulberry32) so a seed reproduces the exact sample. Using
// Math.random would make the corpus unreproducible, which would defeat the
// point of pinning it at all.
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle(items, random) {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

async function fetchJson(url, { retries = 3 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'seenit-calibration' } })
      if (res.status === 429) {
        // Public API with no key — back off rather than hammer it.
        await sleep(2000 * (attempt + 1))
        continue
      }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      return await res.json()
    } catch (err) {
      if (attempt === retries) throw err
      await sleep(1000 * (attempt + 1))
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const yearsSince = (iso) => (iso ? (Date.now() - Date.parse(iso)) / (365.25 * 864e5) : null)
const daysSince = (iso) => (iso ? (Date.now() - Date.parse(iso)) / 864e5 : null)

function stratumOf(pkg) {
  const age = yearsSince(pkg.first_release_published_at)
  const sizeKb = pkg.repo_metadata?.size
  if (age === null || sizeKb == null) return null
  const ageStratum = AGE_STRATA.find((s) => age < s.maxYears)
  const sizeStratum = SIZE_STRATA.find((s) => sizeKb < s.maxKb)
  return `${ageStratum.name}/${sizeStratum.name}`
}

// Everything rejected here is rejected for a stated reason, and the counts are
// reported — a silent filter is indistinguishable from a bug.
function eligibility(pkg, seenRepos) {
  const m = pkg.repo_metadata
  if (!pkg.repository_url) return 'no repository url'
  if (!/^https?:\/\/github\.com\//i.test(pkg.repository_url)) return 'not a github repo'
  if (pkg.dependent_packages_count < CRITERIA.minDependents) return 'below dependents floor'
  if (!m) return 'no repo metadata'
  if (m.archived) return 'archived'
  if (m.fork) return 'fork'
  if (m.size == null) return 'no repo size'
  if (m.size > CRITERIA.maxRepoSizeKb) return 'too large (likely monorepo)'
  if (m.size < CRITERIA.minRepoSizeKb) return 'too small'
  if (daysSince(m.pushed_at) > CRITERIA.maxAgeSincePushDays) return 'unmaintained'
  // Many packages share one repository (monorepos publish dozens); counting a
  // repo twice would weight it twice.
  const key = normalizeRepo(pkg.repository_url)
  if (seenRepos.has(key)) return 'duplicate repository'
  return null
}

export function normalizeRepo(url) {
  return url
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '')
    .toLowerCase()
}

// Find the last page on which packages still meet the dependents floor.
//
// Necessary because the eligible population is far deeper than it looks: on npm
// the floor of 10 dependents is not reached until roughly package #80,000.
// Binary search costs ~10 requests and defines the range to sample from.
async function findFloorPage(registry, perPage, floor) {
  const dependentsAt = async (page) => {
    const batch = await fetchJson(
      `${API}/registries/${registry}/packages?sort=dependent_packages_count&order=desc&per_page=${perPage}&page=${page}`,
    )
    if (!batch?.length) return null
    return Math.min(...batch.map((p) => p.dependent_packages_count ?? 0))
  }

  let low = 1
  let high = 1
  // Expand until we fall below the floor (or run out of packages).
  while (high < 20_000) {
    const d = await dependentsAt(high)
    if (d === null || d < floor) break
    low = high
    high *= 2
    await sleep(150)
  }

  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2)
    const d = await dependentsAt(mid)
    await sleep(150)
    if (d === null || d < floor) high = mid
    else low = mid
  }
  return low
}

// Sample the eligible population by drawing RANDOM PAGES uniformly across the
// whole range that meets the floor.
//
// The first version of this walked the top N pages by dependent count, which
// reproduced exactly the bias the floor exists to prevent: a dry run returned
// rollup (130k dependents) and eslint-plugin-react (105k) — the megaprojects,
// not the population. Descending order is how the API is traversed; it must not
// become the selection criterion.
async function collectEligible(registry, { pageSamples, perPage = 100, onProgress }) {
  const eligible = []
  const rejected = {}
  const seenRepos = new Set()

  const floorPage = await findFloorPage(registry, perPage, CRITERIA.minDependents)
  onProgress?.({ phase: 'range', floorPage })

  // Uniform draw without replacement across [1, floorPage].
  const pages = new Set()
  const random = rng(CRITERIA.pageSeed)
  while (pages.size < Math.min(pageSamples, floorPage)) {
    pages.add(1 + Math.floor(random() * floorPage))
  }

  let done = 0
  for (const page of [...pages].sort((a, b) => a - b)) {
    const batch = await fetchJson(
      `${API}/registries/${registry}/packages?sort=dependent_packages_count&order=desc&per_page=${perPage}&page=${page}`,
    )
    done++
    if (!batch?.length) continue

    for (const pkg of batch) {
      const reason = eligibility(pkg, seenRepos)
      if (reason) {
        rejected[reason] = (rejected[reason] ?? 0) + 1
        continue
      }
      const stratum = stratumOf(pkg)
      if (!stratum) {
        rejected['unstratifiable'] = (rejected['unstratifiable'] ?? 0) + 1
        continue
      }
      seenRepos.add(normalizeRepo(pkg.repository_url))
      eligible.push({
        name: pkg.name,
        registry,
        repository: normalizeRepo(pkg.repository_url),
        dependents: pkg.dependent_packages_count,
        firstRelease: pkg.first_release_published_at,
        sizeKb: pkg.repo_metadata.size,
        language: pkg.repo_metadata.language,
        stars: pkg.repo_metadata.stargazers_count,
        defaultBranch: pkg.repo_metadata.default_branch ?? 'HEAD',
        stratum,
      })
    }

    onProgress?.({ phase: 'sample', done, total: pages.size, eligible: eligible.length })
    await sleep(250) // be polite to a free API
  }

  return { eligible, rejected, floorPage, pagesSampled: pages.size }
}

// Proportional allocation across strata: sample each stratum in proportion to
// how much of the eligible population it represents, so the sample mirrors the
// population rather than over-weighting rare strata.
function sampleStratified(eligible, target, random) {
  const byStratum = new Map()
  for (const pkg of eligible) {
    if (!byStratum.has(pkg.stratum)) byStratum.set(pkg.stratum, [])
    byStratum.get(pkg.stratum).push(pkg)
  }

  const strata = [...byStratum.keys()].sort()
  const picked = []
  const allocation = {}

  for (const stratum of strata) {
    const pool = byStratum.get(stratum)
    const share = pool.length / eligible.length
    const want = Math.max(1, Math.round(target * share))
    const take = shuffle(pool, random).slice(0, Math.min(want, pool.length))
    allocation[stratum] = { available: pool.length, sampled: take.length }
    picked.push(...take)
  }

  // Rounding can overshoot; trim randomly rather than by any property of the
  // repos, which would reintroduce selection bias at the last step.
  return { picked: shuffle(picked, random).slice(0, target), allocation }
}

// Pin each repo to the exact commit its default branch points at right now.
//
// Without this the corpus drifts: re-running months later would analyze
// different code and silently produce different thresholds, so results could
// never be reproduced or audited. `ls-remote` needs no clone.
export async function pinCommits(repos, { concurrency = 8, onProgress } = {}) {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const exec = promisify(execFile)

  let cursor = 0
  let done = 0
  const workers = Array.from({ length: Math.min(concurrency, repos.length) }, async () => {
    while (cursor < repos.length) {
      const repo = repos[cursor++]
      try {
        const { stdout } = await exec('git', ['ls-remote', repo.repository, 'HEAD'], { timeout: 30_000 })
        const sha = stdout.split(/\s+/)[0]
        repo.commit = /^[0-9a-f]{40}$/.test(sha) ? sha : null
      } catch {
        repo.commit = null // private, moved, or deleted since the registry synced
      }
      onProgress?.({ done: ++done, total: repos.length })
    }
  })
  await Promise.all(workers)
  return repos
}

export async function buildCorpus({ ecosystems, target, seed, pageSamples }) {
  const random = rng(seed)
  const out = {
    generatedAt: new Date().toISOString(),
    seed,
    criteria: CRITERIA,
    strata: { age: AGE_STRATA.map((s) => s.name), size: SIZE_STRATA.map((s) => s.name) },
    ecosystems: {},
    repos: [],
  }

  for (const eco of ecosystems) {
    const { registry } = REGISTRIES[eco]
    process.stderr.write(`\n${eco} (${registry})\n`)

    const { eligible, rejected, floorPage, pagesSampled } = await collectEligible(registry, {
      pageSamples,
      onProgress: (p) => {
        if (p.phase === 'range') {
          process.stderr.write(`  floor of ${CRITERIA.minDependents} dependents reached at page ${p.floorPage} (~${p.floorPage * 100} packages)\n`)
        } else {
          process.stderr.write(`\r  sampled ${p.done}/${p.total} random pages · ${p.eligible} eligible   `)
        }
      },
    })
    process.stderr.write('\n')

    const { picked, allocation } = sampleStratified(eligible, target, random)
    const deps = picked.map((p) => p.dependents).sort((a, b) => a - b)
    out.ecosystems[eco] = {
      registry,
      floorPage,
      pagesSampled,
      eligiblePopulation: eligible.length,
      sampled: picked.length,
      dependentsMedian: deps[Math.floor(deps.length / 2)] ?? null,
      rejected,
      allocation,
    }
    out.repos.push(...picked.map((p) => ({ ...p, ecosystem: eco })))

    for (const [stratum, a] of Object.entries(allocation)) {
      process.stderr.write(`  ${stratum.padEnd(14)} ${String(a.sampled).padStart(3)} of ${a.available}\n`)
    }
    process.stderr.write(`  median dependents in sample: ${out.ecosystems[eco].dependentsMedian}\n`)
  }
  return out
}

// ---------------------------------------------------------------------- CLI

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`)
    return i === -1 ? fallback : args[i + 1]
  }

  const ecosystems = (flag('ecosystems', 'npm,pypi')).split(',')
  const target = Number(flag('target', 20))
  const seed = Number(flag('seed', 20260727))
  const pageSamples = Number(flag('page-samples', 12))
  const dryRun = args.includes('--dry-run')

  const corpus = await buildCorpus({ ecosystems, target, seed, pageSamples })

  console.error(`\ntotal: ${corpus.repos.length} repos across ${ecosystems.length} ecosystems`)
  console.error(`seed ${seed} — rerunning with this seed reproduces the identical sample`)

  if (dryRun) {
    console.error('\n--dry-run: not writing corpus.json\n')
    for (const r of corpus.repos.slice(0, 15)) {
      console.error(`  ${r.stratum.padEnd(14)} ${String(r.dependents).padStart(6)} deps  ${r.repository}`)
    }
    if (corpus.repos.length > 15) console.error(`  … and ${corpus.repos.length - 15} more`)
  } else {
    console.error('\npinning commit SHAs (ls-remote, no clone)…')
    await pinCommits(corpus.repos, {
      onProgress: ({ done, total }) => process.stderr.write(`\r  ${done}/${total}   `),
    })
    const unresolved = corpus.repos.filter((r) => !r.commit)
    corpus.repos = corpus.repos.filter((r) => r.commit)
    console.error(`\n  pinned ${corpus.repos.length}; dropped ${unresolved.length} unreachable`)

    await mkdir(HERE, { recursive: true })
    const path = join(HERE, 'corpus.json')

    // Merge with an existing corpus by default rather than overwriting it.
    //
    // Adding six registries to an existing two-registry corpus silently
    // destroyed the original 396-repo sample, which had to be recovered from
    // git. Extending a corpus is the normal case; replacing one should be the
    // explicit request.
    let merged = corpus
    if (existsSync(path) && !args.includes('--replace')) {
      const previous = JSON.parse(await readFile(path, 'utf8'))
      const seen = new Set()
      const repos = []
      // Existing entries win: their SHAs may already have been collected
      // against, and re-pinning mid-study would silently change the sample.
      for (const repo of [...previous.repos, ...corpus.repos]) {
        if (seen.has(repo.repository)) continue
        seen.add(repo.repository)
        repos.push(repo)
      }
      merged = {
        ...previous,
        generatedAt: new Date().toISOString(),
        ecosystems: { ...previous.ecosystems, ...corpus.ecosystems },
        repos,
      }
      console.error(
        `merged with existing corpus: ${previous.repos.length} + ${corpus.repos.length} ` +
          `-> ${repos.length} unique (pass --replace to overwrite instead)`,
      )
    }

    await writeFile(path, JSON.stringify(merged, null, 2) + '\n')
    console.error(`wrote ${path} — ${merged.repos.length} repos across ${Object.keys(merged.ecosystems).length} ecosystems`)
  }
}
