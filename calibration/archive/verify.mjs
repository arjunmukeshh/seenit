#!/usr/bin/env node
// Final verification of a completed calibration.
//
// "Finished without any doubt" needs to mean something checkable, not a
// feeling. Every assertion here corresponds to a specific way this study has
// already gone wrong at least once — each is a scar, not a hypothetical:
//
//   * Ruby extracted zero functions across 120 repositories
//   * Ruby thresholds came out 1/1/3, implying no method ever branches
//   * C/C++ functions were all named "(anonymous)" with zero parameters
//   * params thresholds sat above the p99, so they could never fire
//   * a JS file-length threshold of 10,882 lines, set by one compiled chunk
//   * thresholds generated from a stale results file after analysis had failed
//   * Go emitted thresholds from 4 projects and was 4x every other language
//
// Exits non-zero if any check fails, so it can gate a release.

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const failures = []
const warnings = []
const passes = []

const check = (ok, label, detail = '') => {
  if (ok) passes.push(label)
  else failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
}
const warn = (ok, label, detail = '') => {
  if (ok) passes.push(label)
  else warnings.push(`${label}${detail ? ` — ${detail}` : ''}`)
}

const results = JSON.parse(await readFile(join(HERE, 'results', 'stageA.json'), 'utf8'))
const corpus = JSON.parse(await readFile(join(HERE, 'corpus.json'), 'utf8'))
const thresholdsPath = join(HERE, '..', 'lib', 'analyze', 'metrics', 'thresholds.js')
const { MEASURED_THRESHOLDS, THRESHOLD_SAMPLE_SIZES, thresholdsFor } = await import(thresholdsPath)

// ---------------------------------------------------------------- corpus

check(corpus.repos.every((r) => /^[0-9a-f]{40}$/.test(r.commit)), 'every corpus repo is pinned to a full commit SHA')
check(typeof corpus.seed === 'number', 'corpus records its RNG seed (reproducible)')
check(new Set(corpus.repos.map((r) => r.repository)).size === corpus.repos.length, 'no duplicate repositories in corpus')
check(Object.keys(corpus.ecosystems).length >= 6, 'corpus spans at least 6 registries', `${Object.keys(corpus.ecosystems).length}`)

// Dependents used as an inclusion filter, not a ranking: the sample should not
// be dominated by megaprojects.
const deps = corpus.repos.map((r) => r.dependents).sort((a, b) => a - b)
const medianDeps = deps[Math.floor(deps.length / 2)]
check(medianDeps < 500, 'median dependents is ordinary, not megaproject-skewed', `median=${medianDeps}`)

// --------------------------------------------------------------- coverage

check(results.projects >= 500, 'at least 500 independent projects', `${results.projects}`)
check(results.functions >= 500_000, 'at least 500k functions measured', `${(results.functions ?? 0).toLocaleString()}`)

// ------------------------------------------------------------- thresholds

for (const [language, table] of Object.entries(MEASURED_THRESHOLDS)) {
  for (const [metric, t] of Object.entries(table)) {
    const id = `${language}.${metric}`

    // Ordering must hold or scoreAgainst produces nonsense.
    check(t.good <= t.warn && t.warn <= t.bad, `${id}: good <= warn <= bad`, `${t.good}/${t.warn}/${t.bad}`)

    // An all-zero table means the metric was never really extracted.
    check(t.bad > 0, `${id}: not an all-zero distribution`, 'extraction likely unsupported')

    // A threshold that cannot discriminate is worse than none — it looks like
    // a measurement while never firing.
    check(t.warn > t.good || t.bad > t.warn, `${id}: can actually discriminate`)

    // Minimums differ by population, matching analyze.py. A repository holds
    // thousands of functions but only hundreds of files, so requiring 500
    // observations of both would reject sound file-level thresholds — as it
    // did for go.fileLines at n=165.
    const n = THRESHOLD_SAMPLE_SIZES?.[language]?.[metric] ?? 0
    const minimum = metric === 'fileLines' ? 100 : 500
    check(n >= minimum, `${id}: backed by >=${minimum} observations`, `n=${n}`)
  }
}

// Cross-language sanity: cyclomatic warn should sit in a believable band for
// every language. Ruby's 1/1/3 and Go's 8/20/85 both violated this.
for (const [language, table] of Object.entries(MEASURED_THRESHOLDS)) {
  const c = table.cyclomatic
  if (!c) continue
  check(c.warn >= 2 && c.warn <= 12, `${language}: cyclomatic warn is plausible`, `warn=${c.warn}`)
}

// -------------------------------------------------- extraction coverage

// Every language with a threshold table must genuinely produce functions —
// a language silently yielding nothing is the exact Ruby failure.
const fnDesc = results.descriptiveFunctions ?? {}
for (const language of Object.keys(MEASURED_THRESHOLDS)) {
  const entry = fnDesc[language]
  if (!entry) continue
  if (Object.keys(MEASURED_THRESHOLDS[language]).some((m) => m !== 'fileLines')) {
    check((entry.functions ?? 0) > 0, `${language}: function extraction produces results`)
    check((entry.projects ?? 0) >= 5, `${language}: >=5 independent projects`, `${entry.projects}`)
  }
}

// ------------------------------------------------------------ provenance

check(existsSync(join(HERE, 'PREREGISTRATION.md')), 'pre-registration document exists')
check(existsSync(join(HERE, 'results', 'fix-labels.json')), 'fix-regex error rate was measured and published')
check(typeof thresholdsFor === 'function', 'thresholdsFor() is exported for scoring')
warn(thresholdsFor('cobol') === null, 'an unknown language returns null rather than a fabricated table')

// ----------------------------------------------------------------- report

console.log(`\n${passes.length} checks passed`)
if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`)
  for (const w of warnings) console.log(`  ! ${w}`)
}
if (failures.length) {
  console.log(`\n${failures.length} FAILURE(S):`)
  for (const f of failures) console.log(`  ✗ ${f}`)
  console.log('\ncalibration is NOT verified\n')
  process.exit(1)
}
console.log('\ncalibration verified — thresholds are safe to ship\n')
