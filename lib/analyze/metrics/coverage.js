// Test coverage, read from whatever report the project already produces.
//
// gitcodebase never runs your test suite — running arbitrary project commands
// in the background is both slow and unsafe. It reads an existing report if one
// is present, and reports null if not.
//
// Returning null (rather than 0) is deliberate and important: "no coverage
// report found" and "nothing is covered" are completely different facts, and a
// tool that renders the first as a red 0% is one the user stops believing.
// rollup() in score.js redistributes the weight of unmeasured dimensions.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { round } from '../../canonical.js'

const REPORT_PATHS = [
  'coverage/lcov.info',
  'lcov.info',
  'coverage/coverage-final.json',
  'coverage/coverage-summary.json',
  '.nyc_output/coverage-final.json',
]

// lcov: DA:<line>,<hits> per line; LF/LH are per-file totals.
function parseLcov(text) {
  const files = {}
  let current = null
  let found = 0
  let hit = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) {
      current = line.slice(3).trim()
      files[current] = { found: 0, hit: 0 }
    } else if (line.startsWith('LF:') && current) {
      const n = Number(line.slice(3))
      files[current].found = n
      found += n
    } else if (line.startsWith('LH:') && current) {
      const n = Number(line.slice(3))
      files[current].hit = n
      hit += n
    }
  }
  return { files, found, hit }
}

// istanbul coverage-final.json: { path: { statementMap, s: { id: hits } } }
function parseIstanbul(json) {
  const files = {}
  let found = 0
  let hit = 0
  for (const [path, data] of Object.entries(json)) {
    const statements = Object.values(data.s ?? {})
    if (!statements.length) continue
    const f = statements.length
    const h = statements.filter((n) => n > 0).length
    files[path] = { found: f, hit: h }
    found += f
    hit += h
  }
  return { files, found, hit }
}

export async function scoreCoverage(repoRoot) {
  for (const rel of REPORT_PATHS) {
    let text
    try {
      text = await readFile(join(repoRoot, rel), 'utf8')
    } catch {
      continue
    }

    let parsed
    try {
      parsed = rel.endsWith('.json') ? parseIstanbul(JSON.parse(text)) : parseLcov(text)
    } catch {
      continue // malformed report — keep looking rather than crashing the scan
    }
    if (!parsed.found) continue

    const ratio = parsed.hit / parsed.found
    // Relative paths so the value is comparable across machines and appears in
    // ledger diffs as a real change rather than a path change.
    const files = {}
    for (const [p, v] of Object.entries(parsed.files)) {
      const relPath = p.startsWith(repoRoot) ? p.slice(repoRoot.length + 1) : p
      files[relPath] = { found: v.found, hit: v.hit, ratio: v.found ? round(v.hit / v.found) : 0 }
    }

    return {
      score: round(ratio * 100),
      source: rel,
      linesFound: parsed.found,
      linesHit: parsed.hit,
      ratio: round(ratio),
      files,
    }
  }

  // No report — explicitly unmeasured, not zero.
  return { score: null, source: null, reason: 'no coverage report found', searched: REPORT_PATHS }
}
