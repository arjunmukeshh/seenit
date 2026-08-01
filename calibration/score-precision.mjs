// Score the judged cases against the key.
//
//   node calibration/score-precision.mjs
//
// Reads results/precision-key.json (which case was a finding, which a control,
// which repository each came from) and results/precision-labels.json (the
// verdicts, made without any of that). Writes results/precision.json.
//
// Three numbers matter and they are reported separately, because collapsing
// them would hide the interesting parts:
//
//   - Control acceptance. Judged "yes" on pairs seenit never flagged. This is
//     the study's own error bar. If it is high the precision number below is
//     measuring the judge, not the tool.
//   - Precision on what the CLI prints (the top three findings) against
//     precision on the tail. These are different products; a user reads the
//     first and an agent asked for everything reads the second.
//   - Micro against macro. Micro pools every case, so a repository that
//     contributed more cases counts for more. Macro averages within each
//     repository first. The earlier alignment study reported a pooled number
//     that one repository owned 69% of, which is the mistake macro exists to
//     make visible.

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = async (f) => JSON.parse(await readFile(join(HERE, 'results', f), 'utf8'))

const key = await read('precision-key.json')
const labels = await read('precision-labels.json')

const verdictOf = new Map(labels.map((l) => [l.id, l.verdict]))
const missing = key.key.filter((k) => !verdictOf.has(k.id))
if (missing.length) throw new Error(`unjudged cases: ${missing.map((m) => m.id).join(', ')}`)

const rows = key.key.map((k) => ({ ...k, verdict: verdictOf.get(k.id) }))

const wilson = (hits, n) => {
  if (!n) return null
  const z = 1.96
  const p = hits / n
  const d = 1 + (z * z) / n
  const c = p + (z * z) / (2 * n)
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return [Number(((c - s) / d).toFixed(3)), Number(((c + s) / d).toFixed(3))]
}

// "unclear" is a real answer, not a missing one — the regions were truncated or
// the context was not there. Reported both ways rather than silently folded:
// dropping it gives precision among decided cases, counting it against gives a
// floor that assumes every undecidable case was wrong.
function precision(items) {
  const yes = items.filter((r) => r.verdict === 'yes').length
  const no = items.filter((r) => r.verdict === 'no').length
  const unclear = items.filter((r) => r.verdict === 'unclear').length
  const decided = yes + no
  return {
    n: items.length,
    yes,
    no,
    unclear,
    precision: decided ? Number((yes / decided).toFixed(3)) : null,
    ci95: wilson(yes, decided),
    floorCountingUnclearAgainst: items.length ? Number((yes / items.length).toFixed(3)) : null,
  }
}

// Precision within each repository first, then averaged. A repository that
// contributed one case counts the same as one that contributed three.
function macro(items) {
  const byRepo = new Map()
  for (const r of items) {
    if (!byRepo.has(r.repo)) byRepo.set(r.repo, [])
    byRepo.get(r.repo).push(r)
  }
  const per = [...byRepo.values()]
    .map((group) => precision(group).precision)
    .filter((p) => p !== null)
  return per.length ? Number((per.reduce((a, b) => a + b, 0) / per.length).toFixed(3)) : null
}

const findings = rows.filter((r) => r.kind === 'finding')
const controls = rows.filter((r) => r.kind === 'control')
const displayed = findings.filter((r) => r.rank === 'displayed')
const tail = findings.filter((r) => r.rank === 'tail')
const holdout = findings.filter((r) => r.split === 'holdout')

const controlScore = precision(controls)

const summary = {
  measuredAt: new Date().toISOString().slice(0, 10),
  engine: key.engine,
  minTokens: key.minTokens,
  repos: key.repos,
  judging: {
    protocol: 'calibration/judging.md',
    judge: 'Claude, in fresh contexts with no knowledge of this project, six batches, one batch each',
    blind: 'Cases carry two code regions and an id. No repository, no file paths, no indication of which pairs were flagged, controls unmarked.',
  },

  // The half that needed no judge.
  falsePositiveProbe: key.falsePositiveProbe,

  // The study's own error bar. Read this before reading anything below it.
  controls: {
    meaning: 'Pairs seenit did NOT flag, mixed in unmarked. A judge that accepts these is not discriminating, and the precision numbers below would be measuring agreeableness instead.',
    ...controlScore,
    acceptanceRate: controlScore.precision,
  },

  precision: {
    all: { ...precision(findings), macroByRepo: macro(findings) },
    displayed: { note: 'The top three findings, which is what the CLI prints.', ...precision(displayed), macroByRepo: macro(displayed) },
    tail: { note: 'Findings past the third, which only an agent asking for everything sees.', ...precision(tail), macroByRepo: macro(tail) },
    heldOut: { note: 'Repositories whose URL hash put them in the half that did not tune min-tokens.', ...precision(holdout) },
  },

  // The difference between what the tool flags and what the judge accepts at
  // random, which is the only version of the number that means anything on its
  // own.
  liftOverControls:
    controlScore.precision !== null && precision(findings).precision !== null
      ? Number((precision(findings).precision - controlScore.precision).toFixed(3))
      : null,
}

await writeFile(join(HERE, 'results', 'precision.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify(summary, null, 2))
