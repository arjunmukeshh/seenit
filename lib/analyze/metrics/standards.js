// Coding-standards adherence, measured against the repository's OWN dominant
// conventions rather than an external style guide.
//
// This is a deliberate design choice. A tool that imports someone else's
// opinion produces thousands of findings on day one, all of which the user
// correctly ignores. Measuring self-consistency instead means: whatever you
// chose, are you still doing it? That needs no configuration, never fights the
// user's taste, and catches the thing that actually matters in agent-generated
// code — an agent that has no memory of the convention drifting away from it
// file by file.

import { round } from '../../canonical.js'

const CASES = {
  camelCase: /^[a-z][a-zA-Z0-9]*$/,
  PascalCase: /^[A-Z][a-zA-Z0-9]*$/,
  snake_case: /^[a-z][a-z0-9_]*$/,
  UPPER_SNAKE: /^[A-Z][A-Z0-9_]*$/,
  'kebab-case': /^[a-z][a-z0-9-]*$/,
}

function classify(name) {
  for (const [style, re] of Object.entries(CASES)) {
    if (re.test(name)) return style
  }
  return 'other'
}

// The dominant style and how consistently it is followed.
function dominant(names) {
  if (!names.length) return { style: null, adherence: 1, sampled: 0, distribution: {} }
  const counts = {}
  for (const n of names) {
    const c = classify(n)
    counts[c] = (counts[c] ?? 0) + 1
  }
  // "other" is never a convention worth conforming to; exclude it from the
  // winner but keep it in the denominator so it counts against adherence.
  let best = null
  let bestCount = 0
  for (const [style, count] of Object.entries(counts)) {
    if (style === 'other') continue
    if (count > bestCount) {
      best = style
      bestCount = count
    }
  }
  return {
    style: best,
    adherence: round(bestCount / names.length),
    sampled: names.length,
    distribution: counts,
  }
}

function baseName(path) {
  const file = path.slice(path.lastIndexOf('/') + 1)
  return file.replace(/\.[^.]+$/, '').replace(/\.(test|spec)$/, '')
}

export function scoreStandards(facts) {
  const functionNames = facts
    .flatMap((f) => f.functions.map((fn) => fn.name))
    .filter((n) => n && n !== '(anonymous)')
  const classNames = facts.flatMap((f) => f.classes.map((c) => c.name)).filter((n) => n && n !== '(anonymous)')
  const fileNames = facts.map((f) => baseName(f.path)).filter(Boolean)

  const functions = dominant(functionNames)
  const classes = dominant(classNames)
  const files = dominant(fileNames)

  // Import ordering: are external packages listed before local ones? A weak
  // signal individually, but a reliable indicator of drift in aggregate.
  let ordered = 0
  let checked = 0
  for (const f of facts) {
    const kinds = f.imports.map((s) => (s.startsWith('.') ? 'local' : 'external'))
    if (kinds.length < 2) continue
    checked++
    const firstLocal = kinds.indexOf('local')
    const lastExternal = kinds.lastIndexOf('external')
    if (firstLocal === -1 || lastExternal === -1 || lastExternal < firstLocal) ordered++
  }
  const importOrder = checked ? ordered / checked : 1

  // Parse failures are a standards signal too — syntax the grammar rejects is
  // usually an unsupported dialect or genuinely malformed code.
  const parseErrors = facts.filter((f) => f.parseError).length
  const parseOk = facts.length ? 1 - parseErrors / facts.length : 1

  const components = [
    { weight: 0.3, value: functions.adherence },
    { weight: 0.2, value: classes.adherence },
    { weight: 0.2, value: files.adherence },
    { weight: 0.15, value: importOrder },
    { weight: 0.15, value: parseOk },
  ]
  const score = round(100 * components.reduce((a, c) => a + c.weight * c.value, 0))

  return {
    score,
    functionNaming: functions,
    classNaming: classes,
    fileNaming: files,
    importOrderAdherence: round(importOrder),
    parseErrors,
  }
}
