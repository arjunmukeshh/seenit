// API client. Every endpoint reads from the ledger, so responses are derived
// from git objects rather than any database.

async function get(path, params) {
  const url = new URL(path, window.location.origin)
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v)
  }
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `${res.status} ${res.statusText}`)
  }
  return res.json()
}

export const api = {
  repo: () => get('/api/repo'),
  snapshots: (limit) => get('/api/snapshots', { limit }),
  workspace: () => get('/api/workspace'),
  snapshotFile: (ref, file) => get('/api/snapshot', { ref, file }),
  diff: (from, to) => get('/api/diff', { from, to }),
  history: (path) => get('/api/history', { path }),
}

// Shared health→colour mapping. Kept here rather than in each component so the
// rail, the gauges and the treemap can never disagree about what "78" looks
// like — a score that renders green in one view and amber in another destroys
// trust in the number faster than any inaccuracy.
export function healthColor(score) {
  if (score === null || score === undefined) return 'var(--ink-4)'
  if (score >= 90) return 'var(--h-great)'
  if (score >= 80) return 'var(--h-good)'
  if (score >= 70) return 'var(--h-ok)'
  if (score >= 55) return 'var(--h-poor)'
  return 'var(--h-bad)'
}

export function grade(score) {
  if (score === null || score === undefined) return '?'
  if (score >= 90) return 'A'
  if (score >= 80) return 'B'
  if (score >= 70) return 'C'
  if (score >= 55) return 'D'
  return 'F'
}

// What a grade actually means, in plain words.
//
// The scale is percentile-anchored: thresholds are generated at good = p75,
// warn = p90, bad = p99 of the calibration corpus, and the scoring curve is
// built so those land on 100 / 70 / 0. A repository sitting on the corpus p90
// therefore scores 70 by construction.
//
// So C means average, not mediocre — and a bare letter implies an absolute
// standard when this one is a population comparison. Saying so on screen is
// the difference between a number people trust and one they argue with.
export function gradeMeaning(score) {
  if (score === null || score === undefined) return 'not measured'
  if (score >= 90) return 'top quartile of real code'
  if (score >= 80) return 'better than typical'
  if (score >= 70) return 'typical of real code'
  if (score >= 55) return 'worse than typical'
  return 'approaching the worst 1%'
}

// The reference point on every scale: 70 is where a perfectly ordinary
// repository lands. Marking it turns an abstract 0-100 into a comparison.
export const TYPICAL = 70

export const fmt = (n, places = 1) =>
  n === null || n === undefined ? '—' : Number(n).toFixed(places)
