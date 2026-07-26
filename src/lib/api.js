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
  if (score === null || score === undefined) return 'var(--dim)'
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

export const fmt = (n, places = 1) =>
  n === null || n === undefined ? '—' : Number(n).toFixed(places)
