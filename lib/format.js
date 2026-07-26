// Shared health rendering for the CLI and the MCP server.
//
// This module exists because gitcodebase flagged it: running `review_changes`
// against its own working tree reported that bin/gitcodebase.mjs and
// mcp/server.js duplicated each other, which they did — the same health
// formatter written twice. Consolidating here is the tool taking its own advice.
//
// The two callers differ only in whether they emit ANSI colour, so colour is a
// parameter rather than a second implementation.

import { grade } from './analyze/metrics/score.js'

export const ANSI = {
  dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m',
  green: '\x1b[32m', yellow: '\x1b[33m', reset: '\x1b[0m',
}

export const PLAIN = { dim: '', bold: '', red: '', green: '', yellow: '', reset: '' }

export const colorsFor = (tty) => (tty ? ANSI : PLAIN)

const scoreColor = (C, s) => (s === null || s === undefined ? C.dim : s >= 80 ? C.green : s >= 60 ? C.yellow : C.red)

// Signed delta with an arrow, or '' when there's nothing to compare against.
// Movements under half a point are noise and render as flat.
function deltaMark(C, current, previous, { arrow = false } = {}) {
  if (previous === null || previous === undefined || current === null || current === undefined) return ''
  const d = current - previous
  if (Math.abs(d) < 0.5) return arrow ? `${C.dim} (flat)${C.reset}` : ''
  const sign = d > 0 ? '+' : ''
  const color = d > 0 ? C.green : C.red
  const glyph = arrow ? (d > 0 ? '▲ ' : '▼ ') : ''
  return `${color} ${glyph}${sign}${d.toFixed(1)}${C.reset}`
}

// The health block shown by `gitcodebase check` and by the MCP check_health
// tool. `bars` is off for MCP, where the glyphs would just cost context tokens.
export function formatHealth(health, dimensions, previous, { colors = PLAIN, bars = false } = {}) {
  const C = colors
  const lines = [
    `${C.bold}HEALTH ${scoreColor(C, health)}${health?.toFixed(1) ?? 'n/a'}${C.reset} ` +
      `${C.dim}(${grade(health)})${C.reset}${deltaMark(C, health, previous?.overall, { arrow: true })}`,
  ]

  for (const [name, d] of Object.entries(dimensions)) {
    if (d.score === null || d.score === undefined) {
      lines.push(`  ${name.padEnd(14)} ${C.dim}   n/a   ${d.reason ?? 'not measured'}${C.reset}`)
      continue
    }
    const bar = bars ? ` ${C.dim}${'█'.repeat(Math.round(d.score / 5)).padEnd(20, '·')}${C.reset}` : ''
    lines.push(
      `  ${name.padEnd(14)} ${scoreColor(C, d.score)}${d.score.toFixed(1).padStart(6)}${C.reset}` +
        bar +
        deltaMark(C, d.score, previous?.dimensions?.[name]?.score),
    )
  }
  return lines.join('\n')
}

// One line per snapshot for the git-style history rail.
export function formatSnapshotRow(snapshot, previousHealth, { colors = PLAIN } = {}) {
  const C = colors
  const d = previousHealth === null || snapshot.health === null ? null : snapshot.health - previousHealth
  const mark = d === null ? ' ' : d > 0.5 ? `${C.green}▲${C.reset}` : d < -0.5 ? `${C.red}▼${C.reset}` : `${C.dim}·${C.reset}`
  const bar = snapshot.health === null ? '' : '█'.repeat(Math.round(snapshot.health / 5))
  const subject = (snapshot.subject ?? '').replace(/^snapshot: \w+ /, '').slice(0, 50)
  return (
    `  ${mark} ${C.dim}${snapshot.sourceCommit.slice(0, 7)}${C.reset} ` +
    `${scoreColor(C, snapshot.health)}${String(snapshot.health?.toFixed(1) ?? '—').padStart(5)}${C.reset} ` +
    `${C.dim}${bar.padEnd(20, '·')}${C.reset}  ${subject}`
  )
}
