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
import { percentile, scoreAgainst } from './scale.js'
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
// WHAT THE STUDY FOUND (153,696 files, 1,078 projects, 8 registries;
// calibration/RESULTS.md). Size predicts fix-commit density robustly —
// log(LOC) at p = 4.7e-5. Complexity metrics carry a real but tiny partial
// effect: cyclomatic and cognitive both at an incidence rate ratio of 1.029 per
// standard deviation, nesting at 1.098, function length at 1.031. Comment
// density and cryptic-identifier ratio remain null.
//
// THE METHODOLOGICAL POINT, which matters more than any single number.
// Complexity's SIGNIFICANCE flipped three times as the corpus grew:
//
//   19 projects    q = 7.7e-05   significant  (too few clusters; robust SEs
//                                              are anti-conservative there)
//   386 projects   q = 0.26      not significant  (underpowered for a small
//                                                  true effect)
//   1,078 projects q = 0.019     significant  (finally powered to see it)
//
// Its EFFECT SIZE never once reached the pre-registered floor of 1.10. Reading
// significance alone would have produced three different answers; the effect
// floor gave the same answer every time. That is exactly why §6 of the
// pre-registration required both, and it is the strongest argument in this
// whole exercise for fixing decision criteria before seeing data.
//
// So the rule's middle case applies: significant, but below the practical
// floor — halve the weight and mark advisory. Complexity therefore moves from
// 0.05 back UP to 0.11. The earlier reduction to 0.05 was based on the
// underpowered 386-project null and over-penalised it; this corrects that.
//
// WHAT THIS DOES NOT MEAN. Complexity is not meaningless — it predicts defects
// weakly, at roughly 3% more fixes per standard deviation, once size is
// accounted for. The fix signal also carries a measured 46.7% false-positive
// rate which, being non-differential, biases estimates toward the null, so these
// are conservative. Complexity stays fully measured and displayed: the rule
// governs what is SCORED, not what is SHOWN.
//
// UNTESTED DIMENSIONS. duplication, standards, extensibility and coverage were
// never entered into the model — there was no file-level outcome to test them
// against. Their weights rest on judgement, retained on "no evidence either
// way" rather than "evidence of value".
export const WEIGHTS = {
  size: 0.3, // measured: the robust predictor, log(LOC) p = 4.7e-5
  extensibility: 0.17, // untested
  coverage: 0.15, // untested
  duplication: 0.13, // untested
  complexity: 0.11, // measured: real but below the 1.10 effect floor — halved, advisory
  standards: 0.08, // untested
  readability: 0.06, // measured: nesting weak, comment/identifier null — halved
}

// Which weights rest on evidence and which on judgement. Published in
// health.json so a reader can tell the two apart without reading this file.
export const WEIGHT_PROVENANCE = {
  size: 'measured: log(LOC) predicts fix density, p=4.7e-5, 1,078 projects',
  complexity: 'measured: significant (q=0.019) but IRR 1.029 is below the 1.10 practical floor — halved, advisory',
  readability: 'measured: nesting IRR 1.098 below floor; comment density and identifier quality null (q=0.68) — halved',
  extensibility: 'untested — no outcome model was fitted for cycles or coupling',
  coverage: 'untested',
  duplication: 'untested',
  standards: 'untested',
}

// Re-exported so existing importers of score.js keep working; the definitions
// live in the leaf module that breaks the score <-> perLanguage cycle.
export { percentile, scoreAgainst } from './scale.js'

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

// What these letters actually mean, which is not what school grades mean.
//
// The thresholds are percentiles of the calibration corpus — good = p75,
// warn = p90, bad = p99 — and `scoreAgainst` is anchored so that a value
// landing exactly on `warn` scores exactly 70. A repository whose own p90
// equals the population p90 therefore scores 70 by construction, before the
// over-threshold penalty pulls it a few points lower.
//
// So the scale is relative, not absolute:
//
//   100  every measured percentile at or better than the corpus p75
//    70  exactly typical — sitting on the corpus p90
//     0  at the corpus p99, i.e. worse than 99% of real code
//
// The consequence is that **C means average, not mediocre**, and A requires
// top-quartile numbers on every dimension at once. seenit scores itself a
// C for this reason, and so will most healthy codebases. This is deliberate —
// a scale where the median project scores A has no room left to say anything —
// but it is documented here because a bare letter grade implies an absolute
// standard and this one is a population comparison.
export function grade(score) {
  if (score === null || score === undefined) return '?'
  if (score >= 90) return 'A' // top-quartile on essentially everything
  if (score >= 80) return 'B' // better than typical
  if (score >= 70) return 'C' // typical: on the corpus p90
  if (score >= 55) return 'D' // worse than typical
  return 'F' // approaching the corpus p99
}
