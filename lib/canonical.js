// Canonical JSON — the single most load-bearing file in the project.
//
// Every byte written into the ledger goes through here. The product's core
// feature is that `git diff` between two snapshots reads as a meaningful health
// diff, and `git blame` on a metric file names the commit that caused a
// regression. Both collapse the moment serialization is unstable: an unsorted
// key, or a float that renders as 0.30000000000000004 on one run and 0.3 on the
// next, produces phantom diffs and every real signal drowns in noise.
//
// Rules:
//   1. Object keys sorted in byte order (not locale — collation varies by host).
//   2. Floats rounded to FLOAT_PRECISION so platform FP noise can't leak through.
//   3. -0 normalized to 0; NaN/Infinity to null (JSON can't encode them).
//   4. Pretty-printed, one value per line, so diffs are line-granular.
//   5. Trailing newline, so files never diff as "\ No newline at end of file".
//
// Arrays are NOT sorted — order is meaningful in some payloads. Callers wanting
// stable arrays must sort before serializing; `sortedBy` is provided for that.

export const FLOAT_PRECISION = 4

function normalizeNumber(n) {
  if (!Number.isFinite(n)) return null
  if (Number.isInteger(n)) return n === 0 ? 0 : n // also collapses -0 to 0
  const rounded = Number(n.toFixed(FLOAT_PRECISION))
  return rounded === 0 ? 0 : rounded
}

function byteOrder(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

// Recursively rebuild a value with sorted keys and normalized numbers.
function canonicalize(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return normalizeNumber(value)
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value instanceof Set) return [...value].sort(byteOrder).map(canonicalize)
  if (value instanceof Map) {
    const out = {}
    for (const k of [...value.keys()].sort(byteOrder)) out[k] = canonicalize(value.get(k))
    return out
  }
  if (typeof value === 'object') {
    const out = {}
    for (const k of Object.keys(value).sort(byteOrder)) out[k] = canonicalize(value[k])
    return out
  }
  return null // functions, symbols — not representable
}

// Serialize to the canonical form written into git objects.
export function stringify(value) {
  return JSON.stringify(canonicalize(value), null, 2) + '\n'
}

export function parse(text) {
  return JSON.parse(typeof text === 'string' ? text : text.toString('utf8'))
}

// Sort an array of objects by one or more keys — for building stable arrays
// before serializing (edge lists, violations, clone clusters).
export function sortedBy(items, ...keys) {
  return [...items].sort((a, b) => {
    for (const k of keys) {
      const av = a[k]
      const bv = b[k]
      if (av === bv) continue
      if (typeof av === 'number' && typeof bv === 'number') return av - bv
      return byteOrder(String(av), String(bv))
    }
    return 0
  })
}

// Round for computation without going through full serialization.
export function round(n, places = FLOAT_PRECISION) {
  if (!Number.isFinite(n)) return null
  const r = Number(n.toFixed(places))
  return r === 0 ? 0 : r
}
