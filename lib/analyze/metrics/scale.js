// Scoring primitives — a leaf module with no dependencies beyond canonical.js.
//
// Extracted to break a circular import: score.js imported groupByLanguage and
// friends from perLanguage.js, while perLanguage.js imported percentile and
// scoreAgainst back from score.js. seenit reported the cycle against its
// own codebase, which is the whole point of shipping cycle detection.
//
// The cycle "worked" only by accident. Both functions are declarations, and ESM
// hoists those, so they happened to be initialized before the cycle resolved.
// Rewriting either as `const percentile = (...) => ...` would have turned it
// into a "Cannot access before initialization" crash at import time — a trap
// laid for whoever next tidied the file.

import { round } from '../../canonical.js'

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
