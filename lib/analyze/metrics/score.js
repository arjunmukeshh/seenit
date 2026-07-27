// Scoring — pure functions over the facts from extract.js. No AST, no I/O, so
// every threshold here is unit-testable and arguable in isolation.
//
// Two deliberate choices:
//
// 1. Scores come from DISTRIBUTIONS (p90, share over threshold), never means.
//    A mean hides the handful of pathological files that actually hurt: ten
//    clean files and one 400-line monster averages to "fine", which is exactly
//    the file you needed to be told about.
//
// 2. Thresholds are published in the output, not buried here. An unexplained
//    score invites distrust, so health.json carries the weights and every raw
//    metric sits next to the derived number in the UI.

import { round } from '../../canonical.js'
import { thresholdsFor } from './thresholds.js'
import { groupByLanguage, scoreMetricByLanguage, shareOverWarn } from './perLanguage.js'

// LEGACY THRESHOLDS — superseded for complexity and size, still live for
// readability.
//
// Complexity and size are now scored against measured per-language tables in
// thresholds.js. This table survives for two things:
//
//   1. `scoreReadability`, which still uses the global nesting, line-length and
//      comment-ratio values below. KNOWN INCONSISTENCY: nesting IS measured
//      per language in thresholds.js, so readability should move to the same
//      per-language path. Until it does, one dimension is judged by assertion
//      while the others are judged by evidence.
//   2. `manifest.json`, which records the thresholds a snapshot was taken under.
//
// The values are literature-derived defaults (McCabe 1976 proposed 10 as a
// cyclomatic limit; the rest are conventional lint values) and the calibration
// showed that basis to be roughly twice as lenient as real code. Treat anything
// still scored against them as the weakest part of the health score.
export const THRESHOLDS = {
  cyclomatic: { good: 5, warn: 10, bad: 20 }, // warn=10 per McCabe 1976
  cognitive: { good: 7, warn: 15, bad: 30 },
  functionLines: { good: 25, warn: 50, bad: 100 },
  fileLines: { good: 200, warn: 400, bad: 800 },
  params: { good: 2, warn: 4, bad: 6 },
  nesting: { good: 2, warn: 4, bad: 6 },
  lineLength: { good: 100, warn: 120, bad: 200 },
  commentRatio: { min: 0.02, ideal: 0.12 },
}

// Weights, revised by the pre-registered decision rule in
// calibration/PREREGISTRATION.md §7 after the full-corpus study.
//
// WHAT THE STUDY FOUND (39,028 files, 386 projects; calibration/RESULTS.md):
// file size is the only metric that robustly predicts fix-commit density.
// log(LOC) holds at p = 2.5e-8, while cyclomatic complexity (q = 0.26),
// cognitive complexity (q = 0.26), nesting (q = 0.053), function length
// (q = 0.15), comment density and cryptic-identifier ratio (both q = 0.68) all
// fail to reach significance once size is controlled for.
//
// The pre-registration committed in advance to the awkward consequence: if
// complexity showed no meaningful partial effect, then weighting complexity
// above size was backwards and size takes the larger share. That condition is
// met, so it does.
//
// WHAT THIS DOES NOT MEAN. Not that complexity is meaningless — only that it
// does not predict *this* outcome, measured *this* way, beyond size. The fix
// signal carries a measured 46.7% false-positive rate, which is non-differential
// and therefore biases every estimate toward the null; these findings are
// conservative. Complexity remains fully measured and displayed, because a
// metric that does not predict defects can still tell you something true about
// code you have to read. The rule governs what gets SCORED, not what gets SHOWN.
//
// UNTESTED DIMENSIONS. duplication, standards, extensibility and coverage were
// never entered into the model — there was no file-level outcome to test them
// against. Their weights are unchanged and rest on judgement, not evidence.
// They are retained on "no evidence either way", not "evidence of value", and
// that distinction is the honest reading of this table.
export const WEIGHTS = {
  size: 0.37, // the one robustly evidenced predictor: log(LOC), p = 2.5e-8
  extensibility: 0.17, // untested — cycles and coupling had no outcome to test against
  coverage: 0.15, // untested
  duplication: 0.13, // untested
  standards: 0.08, // untested
  complexity: 0.05, // tested, null after size control — retained as diagnostic
  readability: 0.05, // tested, null after size control — retained as diagnostic
}

// Dimensions whose weight is backed by the study rather than by judgement.
// Published in health.json so a reader can see which parts of the score rest on
// evidence and which are still opinion.
export const WEIGHT_PROVENANCE = {
  size: 'measured: log(LOC) predicts fix density, p=2.5e-8, 386 projects',
  complexity: 'measured: no partial effect after size control (q=0.26) — diagnostic weight',
  readability: 'measured: comment density and identifier quality null (q=0.68) — diagnostic weight',
  extensibility: 'untested — no outcome model was fitted for cycles or coupling',
  coverage: 'untested',
  duplication: 'untested',
  standards: 'untested',
}

export function percentile(values, p) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

// Map a value onto 0-100 where `good` scores 100 and `bad` scores 0, decaying
// linearly through `warn`. Values past `bad` floor at 0 rather than going
// negative, so one catastrophic file can't drag a whole dimension below zero.
export function scoreAgainst(value, { good, warn, bad }) {
  if (value <= good) return 100
  if (value >= bad) return 0
  if (value <= warn) return round(100 - 30 * ((value - good) / (warn - good)))
  return round(70 - 70 * ((value - warn) / (bad - warn)))
}

const share = (arr, pred) => (arr.length ? arr.filter(pred).length / arr.length : 0)

// Complexity: weight the p90 function heavily, plus a penalty for the share of
// functions over the warn threshold.
//
// Scored per language against measured thresholds, then combined weighted by
// function count. A cyclomatic complexity of 9 sits near the p90 of real
// JavaScript but past the p99 of real TypeScript, so one global number tells a
// TypeScript user their worst function is merely "approaching warn".
export function scoreComplexity(files) {
  const fns = files.flatMap((f) => f.functions.map((fn) => ({ ...fn, language: f.language })))
  if (!fns.length) {
    return { score: 100, p90Cyclomatic: 0, p90Cognitive: 0, maxCyclomatic: 0, overThreshold: 0, functionCount: 0 }
  }

  const groups = groupByLanguage(fns, (f) => f.language)
  const cyclomatic = scoreMetricByLanguage(groups, {
    valueOf: (f) => f.cyclomatic,
    metric: 'cyclomatic',
    thresholdsFor,
  })
  const cognitive = scoreMetricByLanguage(groups, {
    valueOf: (f) => f.cognitive,
    metric: 'cognitive',
    thresholdsFor,
  })
  const over = shareOverWarn(groups, { valueOf: (f) => f.cyclomatic, metric: 'cyclomatic', thresholdsFor })

  const cyc = fns.map((f) => f.cyclomatic)
  const parts = [cyclomatic.score, cognitive.score].filter((s) => s !== null)
  // No calibrated language present — report unmeasured rather than inventing a
  // score, consistent with how missing coverage is handled.
  if (!parts.length) {
    return {
      score: null,
      reason: 'no calibrated thresholds for the languages in this repository',
      maxCyclomatic: Math.max(...cyc),
      functionCount: fns.length,
    }
  }

  const base = parts.reduce((a, b) => a + b, 0) / parts.length
  return {
    score: round(Math.max(0, base - over * 40)),
    p90Cyclomatic: percentile(cyc, 90),
    p90Cognitive: percentile(fns.map((f) => f.cognitive), 90),
    maxCyclomatic: Math.max(...cyc),
    overThreshold: round(over),
    functionCount: fns.length,
    byLanguage: cyclomatic.perLanguage,
  }
}

export function scoreSize(files) {
  if (!files.length) {
    return { score: 100, p90FileLines: 0, p90FunctionLines: 0, p90Params: 0, largestFile: 0, totalLoc: 0, fileCount: 0 }
  }
  const fileLines = files.map((f) => f.loc)
  const fns = files.flatMap((f) => f.functions)
  const fnLines = fns.length ? fns.map((f) => f.lines) : [0]
  const params = fns.length ? fns.map((f) => f.params) : [0]

  const p90File = percentile(fileLines, 90)
  const p90Fn = percentile(fnLines, 90)
  const p90Params = percentile(params, 90)

  // Per-language, same reasoning as complexity: Python functions are routinely
  // longer than TypeScript ones, and a shared threshold misjudges both.
  const fileGroups = groupByLanguage(files, (f) => f.language)
  const fnGroups = groupByLanguage(
    files.flatMap((f) => f.functions.map((fn) => ({ ...fn, language: f.language }))),
    (f) => f.language,
  )
  const fileScore = scoreMetricByLanguage(fileGroups, { valueOf: (f) => f.loc, metric: 'fileLines', thresholdsFor })
  const fnScore = scoreMetricByLanguage(fnGroups, { valueOf: (f) => f.lines, metric: 'functionLines', thresholdsFor })
  const paramScore = scoreMetricByLanguage(fnGroups, { valueOf: (f) => f.params, metric: 'params', thresholdsFor })

  // Weights renormalize over whatever could be measured, so a language lacking
  // a params table (C/C++, where extraction is unsupported) does not silently
  // score zero on that component.
  const components = [
    { weight: 0.45, score: fileScore.score },
    { weight: 0.4, score: fnScore.score },
    { weight: 0.15, score: paramScore.score },
  ].filter((c) => c.score !== null)
  const totalWeight = components.reduce((a, c) => a + c.weight, 0)

  return {
    score: totalWeight
      ? round(components.reduce((a, c) => a + c.weight * c.score, 0) / totalWeight)
      : null,
    p90FileLines: p90File,
    p90FunctionLines: p90Fn,
    p90Params,
    largestFile: Math.max(...fileLines),
    totalLoc: fileLines.reduce((a, b) => a + b, 0),
    fileCount: files.length,
  }
}

// Readability: nesting depth, comment density, and line length. Naming quality
// is the share of identifiers that are single characters or cryptic
// abbreviations — a crude but stable signal that works across languages
// without needing a dictionary. Conventional loop and idiom names are exempt.
const IDIOMATIC = /^(i|j|k|n|x|y|z|id|db|fs|os|ok|to|on|up|at|by|of|in|is|el|ms|px|kb|mb)$/

export function scoreReadability(files) {
  if (!files.length) return { score: 100, p90Nesting: 0, maxNesting: 0, commentRatio: 0, p90LineLength: 0, crypticIdentifierRatio: 0 }
  const fns = files.flatMap((f) => f.functions)
  const nesting = fns.length ? fns.map((f) => f.maxNesting) : [0]
  const p90Nest = percentile(nesting, 90)

  const totalLines = files.reduce((a, f) => a + f.loc, 0)
  const commentLines = files.reduce((a, f) => a + f.commentLines, 0)
  const commentRatio = totalLines ? commentLines / totalLines : 0
  const commentScore =
    commentRatio >= THRESHOLDS.commentRatio.ideal ? 100 : round(100 * (commentRatio / THRESHOLDS.commentRatio.ideal))

  const p90Line = percentile(files.map((f) => f.maxLineLength), 90)

  const idents = files.flatMap((f) => f.identifiers)
  const cryptic = share(idents, (id) => id.length <= 2 && !IDIOMATIC.test(id))

  return {
    score: round(
      0.35 * scoreAgainst(p90Nest, THRESHOLDS.nesting) +
        0.25 * commentScore +
        0.2 * scoreAgainst(p90Line, THRESHOLDS.lineLength) +
        0.2 * Math.max(0, 100 - cryptic * 500),
    ),
    p90Nesting: p90Nest,
    maxNesting: Math.max(...nesting),
    commentRatio: round(commentRatio),
    p90LineLength: p90Line,
    crypticIdentifierRatio: round(cryptic),
  }
}

// Roll the dimensions into one number. Dimensions that could not be measured
// (coverage with no report present) are excluded and their weight redistributed
// rather than scored as zero — reporting "0% coverage" when we simply don't
// know would be a lie the user would rightly stop trusting the tool over.
export function rollup(dimensions) {
  let weighted = 0
  let totalWeight = 0
  const included = {}
  for (const [name, weight] of Object.entries(WEIGHTS)) {
    const d = dimensions[name]
    if (!d || d.score === null || d.score === undefined) continue
    weighted += d.score * weight
    totalWeight += weight
    included[name] = weight
  }
  return {
    overall: totalWeight ? round(weighted / totalWeight) : null,
    weightsApplied: included,
    unmeasured: Object.keys(WEIGHTS).filter((k) => !(k in included)),
  }
}

export function grade(score) {
  if (score === null || score === undefined) return '?'
  if (score >= 90) return 'A'
  if (score >= 80) return 'B'
  if (score >= 70) return 'C'
  if (score >= 55) return 'D'
  return 'F'
}
