// Per-language scoring.
//
// The measured distributions differ enough between languages that a single
// global threshold is wrong for all of them at once. A cyclomatic complexity of
// 9 sits near the p90 of real JavaScript but past the p99 of real TypeScript, so
// scoring both against one number tells a TypeScript user their pathological
// function is merely "approaching warn".
//
// Rather than score a mixed repository against one language's thresholds, each
// language is scored against its own and the results combined weighted by how
// much code is in each. A repo that is 90% TypeScript and 10% shell is judged
// mostly as TypeScript, which is what a reader expects.

import { round } from '../../canonical.js'
import { percentile, scoreAgainst } from './score.js'

// Group items by their language, dropping any without one.
export function groupByLanguage(items, languageOf) {
  const groups = new Map()
  for (const item of items) {
    const language = languageOf(item)
    if (!language) continue
    let bucket = groups.get(language)
    if (!bucket) groups.set(language, (bucket = []))
    bucket.push(item)
  }
  return groups
}

// Score one metric across languages and combine.
//
// Returns null when no language in the repository has a threshold for this
// metric — an honest "not measured" rather than a fabricated 100, which would
// otherwise reward a codebase for being written in a language we cannot judge.
export function scoreMetricByLanguage(groups, { valueOf, metric, thresholdsFor, q = 90 }) {
  let weighted = 0
  let total = 0
  const perLanguage = {}

  for (const [language, items] of groups) {
    const thresholds = thresholdsFor(language)?.[metric]
    if (!thresholds) continue

    const values = items.map(valueOf).filter((v) => Number.isFinite(v))
    if (!values.length) continue

    const observed = percentile(values, q)
    const score = scoreAgainst(observed, thresholds)
    perLanguage[language] = { score, observed, n: values.length, thresholds }

    // Weight by observation count: a language contributing 12 functions should
    // not swing the score as much as one contributing 12,000.
    weighted += score * values.length
    total += values.length
  }

  if (!total) return { score: null, perLanguage: {}, reason: `no calibrated thresholds for ${metric}` }
  return { score: round(weighted / total), perLanguage, n: total }
}

// Share of items exceeding their own language's `warn` threshold.
//
// Computed per language for the same reason the scores are: "over threshold"
// is only meaningful relative to the language the code is written in.
export function shareOverWarn(groups, { valueOf, metric, thresholdsFor }) {
  let over = 0
  let total = 0
  for (const [language, items] of groups) {
    const thresholds = thresholdsFor(language)?.[metric]
    if (!thresholds) continue
    for (const item of items) {
      const value = valueOf(item)
      if (!Number.isFinite(value)) continue
      total++
      if (value > thresholds.warn) over++
    }
  }
  return total ? round(over / total) : 0
}
