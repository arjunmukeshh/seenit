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

// Thresholds — PROVISIONAL AND UNCALIBRATED.
//
// These are literature-derived defaults, not measurements. McCabe's 1976 paper
// proposed 10 as a cyclomatic limit and NIST 500-235 discusses it; the rest are
// conventional values from common lint configurations. That is a weaker basis
// than it sounds, and until a real calibration exists they should be treated as
// a starting point rather than a finding. See CALIBRATION.md for the corpus
// design that would replace them.
//
// Two things are deliberately NOT done here:
//
//   * No calibration against a handful of convenient repositories. A small
//     single-author sample measures one person's habits, and dressing it up
//     with percentile tables makes an assertion look like evidence.
//   * No per-language differentiation yet, which is a known error: Python
//     functions are meaningfully shorter than Java ones, so a single global
//     threshold is wrong for both. Per-language tables are the first thing
//     calibration should produce.
//
// One structural fix is corpus-independent and has been applied: `params` was
// good:3/warn:5/bad:7, values so lenient the threshold could not fire on
// ordinary code, leaving that component of the size score inert. A threshold
// that never fires is broken regardless of whose code you measure.
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

// Weights sum to 1.0 across all SEVEN dimensions. Coverage was previously
// computed and displayed but absent from this table, so it silently contributed
// nothing to the overall score even on projects that had a coverage report —
// a dimension shown to the user that did not count. Caught by the rollup test.
//
// These weights are the least defensible numbers in the codebase: they encode a
// judgement about what matters, not a measurement. They are published in
// health.json rather than hidden here precisely so they can be argued with, and
// the UI shows raw metrics beside every derived score.
export const WEIGHTS = {
  complexity: 0.22,
  size: 0.12,
  duplication: 0.13,
  readability: 0.13,
  standards: 0.08,
  extensibility: 0.17,
  coverage: 0.15,
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
