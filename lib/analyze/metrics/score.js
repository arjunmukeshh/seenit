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

// Thresholds, with provenance.
//
// `good` is intended to mean "better than most real code", so each was checked
// against measured distributions rather than left as an assertion. The
// calibration corpus was 4 repositories / 101 files / 984 functions, where the
// observed percentiles were:
//
//   metric          p50   p75   p90   p95   p99   max
//   cyclomatic        1     3     6     9    15    25
//   cognitive         0     3    10    14    27    79
//   functionLines     4    12    28    52   128   238
//   fileLines        97   187   269   311   727   796
//   params            1     1     2     2     3     4
//   nesting           1     2     3     3     4     6
//
// CAVEAT, stated plainly: that corpus is four projects by a single author and
// is far too narrow to set thresholds from. It is enough to catch a threshold
// that is structurally broken, not enough to claim these are the right numbers.
// Broadening it is the main outstanding work on metric credibility.
//
// It did catch one: params was good:3/warn:5/bad:7, but 3 is already the p99 and
// both warn and bad sit beyond the observed maximum — the threshold could never
// fire, so that component of the size score was inert. Tightened below. This
// failure mode is corpus-independent: a threshold past the maximum is broken
// whoever's code you measure.
export const THRESHOLDS = {
  cyclomatic: { good: 5, warn: 10, bad: 20 }, // good ≈ p87, warn ≈ p96
  cognitive: { good: 7, warn: 15, bad: 30 }, // good ≈ p85, warn ≈ p95
  functionLines: { good: 25, warn: 50, bad: 100 }, // good ≈ p88, warn ≈ p95
  fileLines: { good: 200, warn: 400, bad: 800 }, // good ≈ p77, warn ≈ p96
  params: { good: 2, warn: 4, bad: 6 }, // retuned: was inert above p99
  nesting: { good: 2, warn: 4, bad: 6 }, // good ≈ p75, warn ≈ p99
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
export function scoreComplexity(files) {
  const fns = files.flatMap((f) => f.functions)
  if (!fns.length) {
    return { score: 100, p90Cyclomatic: 0, p90Cognitive: 0, maxCyclomatic: 0, overThreshold: 0, functionCount: 0 }
  }

  const cyc = fns.map((f) => f.cyclomatic)
  const cog = fns.map((f) => f.cognitive)
  const p90c = percentile(cyc, 90)
  const p90g = percentile(cog, 90)
  const over = share(fns, (f) => f.cyclomatic > THRESHOLDS.cyclomatic.warn)

  const base = 0.5 * scoreAgainst(p90c, THRESHOLDS.cyclomatic) + 0.5 * scoreAgainst(p90g, THRESHOLDS.cognitive)
  return {
    score: round(Math.max(0, base - over * 40)),
    p90Cyclomatic: p90c,
    p90Cognitive: p90g,
    maxCyclomatic: Math.max(...cyc),
    overThreshold: round(over),
    functionCount: fns.length,
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

  return {
    score: round(
      0.45 * scoreAgainst(p90File, THRESHOLDS.fileLines) +
        0.4 * scoreAgainst(p90Fn, THRESHOLDS.functionLines) +
        0.15 * scoreAgainst(p90Params, THRESHOLDS.params),
    ),
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
