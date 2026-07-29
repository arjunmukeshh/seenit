// Clone detection over the winnowed fingerprints from extract.js.
//
// This is the dimension that matters most for agent-generated code. The
// characteristic failure of vibecoding isn't bad code — each turn produces
// something that works — it's the third near-identical implementation of a
// helper that already existed twice, because the agent had no memory of the
// first two. Identifiers are normalized before fingerprinting, so a renamed
// copy still registers as a clone.
//
// This index is also what makes the MCP `find_existing` tool useful: the agent
// can ask "does this already exist?" *before* writing, which turns duplication
// from a diagnosis into prevention.

import { round, sortedBy } from '../../canonical.js'

const MIN_SHARED = 3 // fingerprints two files must share to count as related

// Floor for the longest aligned run. Below this the matches never line up into
// a block and the pair is two files that merely rhyme.
//
// A FLOOR, not the threshold — the real cutoff is relative, see below. Taken
// from the labelled sample, where noise topped out at 8 and real duplication
// began at 10.
const MIN_ALIGNED_FLOOR = 9

// ...and the cutoff proper is a percentile of this repository's own aligned
// runs — which percentile depends on the surface, see below.
//
// A fixed number cannot serve both ends, which is the third time this project
// has learned it. Measured across 34 corpus repositories (calibration/
// results/alignment.json), the 99th percentile of coincidental overlap has a
// median of 46 and reaches 349 — while seenit's own p99 is 27 and vite's is
// 449, the same quantity 16x apart. A flat 9 keeps a fifth of all candidate
// pairs in a median repository; a flat 46 would delete every real find in a
// small one.
//
// So the bar is "unusual for THIS codebase", the same move as per-language
// complexity thresholds.
//
// The percentile is chosen on RECALL, not on the labelled precision set. That
// set picked the original cutoff from its own gap and then scored it, which is
// selecting the rule after seeing the outcome. Recall is measured by injection
// on corpus repositories nobody here has read, and on a TUNING split disjoint
// from the split the reported number comes from -- see calibration/recall.mjs.
//
// Measured on 63 npm repositories, 28 tuning / 35 held out. The tuning half
// chose p60; the held-out half then reported, verbatim -> fully transformed:
//
//   p50  0.91 -> 0.89     <- shipped to agents
//   p60  0.91 -> 0.83
//   p75  0.91 -> 0.80     <- shipped to humans
//   p90  0.80 -> 0.57
//
// Neither shipped setting is the tuned one, and that is deliberate rather than a
// lapse: tuning optimised recall alone, and p60 yields 49 findings on vite
// against p75's 12 for three points of recall that sit inside the confidence
// interval. Recall picks the ORDER of the options; what each surface can afford
// picks between them.
//
// p90 was the setting this shipped with, and it lost more than four in ten
// transformed copies. The more useful half of the result is how little the
// transformations cost at a sane bar: renaming every identifier, changing every
// literal, reformatting, churning comments, reordering statements and
// extracting a variable together move recall 0.91 -> 0.80. What the tool misses
// it misses because the bar sat above it, not because the copy was disguised.

// The default. Overridable per call so the recall study can measure what the
// choice costs — passed as an argument, NOT read from the environment: a
// module-level env read is evaluated once at import, so a study that set the
// variable per measurement silently measured the same setting three times and
// reported three identical rows.
const ALIGNED_PERCENTILE = 75

// The two surfaces do not want the same bar, and the recall study says how much
// they differ.
//
// A person reads three findings. One bad one and they conclude the tool is
// noisy, so the human surface pays for precision: p75 gives 12 findings on vite
// against 49 at p60, for 0.80 held-out recall against 0.83 — three points of
// recall, inside the confidence interval, for a quarter of the noise.
//
// find_existing hands candidates to a model that reads both snippets and
// decides. A false positive there costs a few hundred tokens and is silently
// discarded; a false negative means the agent writes the third copy and nobody
// ever learns. So the agent surface pays for recall instead: p50, 0.89 held-out
// against 0.80.
export const HUMAN_PERCENTILE = 75
export const AGENT_PERCENTILE = 50

// Build an inverted index fingerprint -> files, then turn co-occurrence into
// clone pairs. O(files * fingerprints) rather than O(files^2).
function computeClones(facts, { percentile = ALIGNED_PERCENTILE } = {}) {
  const index = new Map()
  for (const f of facts) {
    for (const [hash, line] of f.fingerprints ?? []) {
      let bucket = index.get(hash)
      if (!bucket) index.set(hash, (bucket = []))
      bucket.push({ path: f.path, line })
    }
  }

  // Fan-out culling: drop fingerprints that appear across a large share of the
  // codebase. Those are license headers, import preambles and framework
  // ceremony, not duplication anyone would extract.
  //
  // The share is deliberately GENEROUS, and a tighter earlier attempt is worth
  // recording as a mistake. A flat limit of 12 could not mean the same thing at
  // both ends -- 29% of a 42-file repo, 0.03% of TypeScript's 38,000 -- so it
  // was replaced with 2% of files. That was worse in a way that mattered more:
  // culling hard on fan-out removes the very thing this tool exists to find,
  // because a helper copied into four files HAS fingerprints in four files. At
  // 2% the limit computed to 3 on this repo, and grade() -- copy-pasted verbatim
  // between score.js and api.js, a genuine find -- was silently discarded as
  // boilerplate.
  //
  // So fan-out now removes only the near-universal. Separating real duplication
  // from idiomatic noise is the job of the region filter below and of a
  // hand-labelled precision study, not of a blunt frequency cut.
  const fileCount = new Set(facts.map((f) => f.path)).size
  const MAX_FANOUT = Math.max(8, Math.ceil(fileCount * 0.25))
  const pairs = new Map()
  for (const bucket of index.values()) {
    if (bucket.length < 2 || bucket.length > MAX_FANOUT) continue
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        if (bucket[i].path === bucket[j].path) continue
        const [a, b] = bucket[i].path < bucket[j].path ? [bucket[i], bucket[j]] : [bucket[j], bucket[i]]
        const key = `${a.path}\u0000${b.path}`
        let p = pairs.get(key)
        if (!p) {
          // Which lines actually carry a matched fingerprint, on each side.
          //
          // Sets, not min/max bounds. Bounds looked cheaper and were wrong:
          // matches are often scattered across a file rather than contiguous,
          // and first-to-last spanned App.jsx lines 21-284 for thirteen
          // scattered hits, reporting "153 duplicated lines" where thirteen
          // was the truth. Overstating is the one thing a duplication report
          // cannot do and keep anyone's trust.
          pairs.set(
            key,
            (p = { a: a.path, b: b.path, shared: 0, samples: [], aLines: new Set(), bLines: new Set(), deltas: new Map() }),
          )
        }
        p.shared++
        p.aLines.add(a.line)
        p.bLines.add(b.line)
        // Histogram of line offsets. A copied block keeps a CONSTANT offset
        // between the two files, so the tallest bar is the length of the
        // longest aligned run -- the ranking signal, explained below.
        const delta = a.line - b.line
        p.deltas.set(delta, (p.deltas.get(delta) ?? 0) + 1)
        if (p.samples.length < 3) p.samples.push({ aLine: a.line, bLine: b.line })
      }
    }
  }

  // RANK BY ALIGNMENT, NOT BY OVERLAP.
  //
  // Raw shared count ranks by file size and puts idiomatic noise on top: on this
  // repo a run of `const [x, setX] = useState(null)` shared 30 fingerprints,
  // while grade() vs healthColor() -- the same threshold ladder written twice --
  // shared only 13.
  //
  // What separates them is not how MUCH matches but whether the matches line up.
  // Genuine copy-paste preserves a constant offset between the two files, so
  // every fingerprint in the copied block lands on the same (lineA - lineB)
  // delta. Incidental matches between unrelated code scatter across many deltas.
  // The tallest bar in the delta histogram is the longest aligned run.
  //
  // Measured on the 30 hand-labelled cases: real duplication scored 10-27
  // aligned, idiomatic noise 3-8, no overlap. Two weaker ideas were tried and
  // discarded first -- inverse document frequency (2.00 vs 2.70 mean
  // files-per-shape, too close) and contiguous line blocks (everything landed at
  // 4-5, because winnowing samples lines too sparsely for blocks to differ).
  //
  // There is still no percentage. Three attempts at one produced three different
  // answers: file containment reads 9.8% for a genuine copy, raw counts rank by
  // size, and first-to-last bounds claimed 153 duplicated lines for thirteen
  // scattered hits. `lines` below is a LOWER BOUND used for ranking ties, never
  // shown as "this much code is duplicated".
  const clones = [...pairs.values()]
    .filter((p) => p.shared >= MIN_SHARED)
    .map(({ aLines, bLines, deltas, ...p }) => ({
      ...p,
      aligned: Math.max(0, ...deltas.values()),
      lines: Math.min(aLines.size, bLines.size),
      samples: sortedBy(p.samples, 'aLine', 'bLine'),
    }))

  // Two passes: the candidates decide their own bar, then it is applied.
  const alignedValues = clones.map((c) => c.aligned).sort((a, b) => a - b)
  const cutoff = alignedValues.length
    ? Math.max(
        MIN_ALIGNED_FLOOR,
        alignedValues[
          Math.min(alignedValues.length - 1, Math.ceil((percentile / 100) * alignedValues.length) - 1)
        ],
      )
    : MIN_ALIGNED_FLOOR

  return { clones: sortedBy(clones.filter((c) => c.aligned >= cutoff), 'a', 'b'), cutoff }
}

// Public shape stays an array — callers and tests only ever wanted the clones.
export function findClones(facts, options) {
  return computeClones(facts, options).clones
}

// Collapse pairs into findings.
//
// One copied file produces a pair for every OTHER copy of it, so a style.css
// duplicated across six create-vite templates comes back as fifteen rows of the
// same fact. That is a list, not a decision — and it is how a report with good
// precision still reads as a wall.
//
// Files transitively linked by clone pairs form one group, found with union-find.
// The group reports the strongest pair inside it as its anchor, so the reader
// gets "this shape appears in six files, look here" once.
export function clusterClones(clones) {
  const parent = new Map()
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)))
      x = parent.get(x)
    }
    return x
  }
  const union = (x, y) => {
    for (const v of [x, y]) if (!parent.has(v)) parent.set(v, v)
    const [rx, ry] = [find(x), find(y)]
    if (rx !== ry) parent.set(rx, ry)
  }
  for (const c of clones) union(c.a, c.b)

  const groups = new Map()
  for (const c of clones) {
    const root = find(c.a)
    let g = groups.get(root)
    if (!g) groups.set(root, (g = { files: new Set(), pairs: 0, aligned: 0, anchor: null }))
    g.files.add(c.a)
    g.files.add(c.b)
    g.pairs++
    if (c.aligned > g.aligned) {
      g.aligned = c.aligned
      g.anchor = c
    }
  }

  return sortedBy(
    [...groups.values()].map((g) => ({
      files: [...g.files].sort(),
      fileCount: g.files.size,
      pairs: g.pairs,
      aligned: g.aligned,
      anchor: g.anchor,
    })),
    'aligned',
    'fileCount',
  ).reverse()
}

export function scoreDuplication(facts) {
  const { clones, cutoff } = computeClones(facts)

  // Ratio must be computed over DISTINCT fingerprints. Summing `shared` across
  // pairs double-counts: a fingerprint present in four files contributes to six
  // pairs, which inflated the measured ratio to ~48% on a codebase with only
  // moderate real duplication.
  const seen = new Map() // hash -> set of files containing it
  for (const f of facts) {
    for (const [hash] of f.fingerprints ?? []) {
      let s = seen.get(hash)
      if (!s) seen.set(hash, (s = new Set()))
      s.add(f.path)
    }
  }
  const involved = new Set()
  for (const c of clones) {
    involved.add(c.a)
    involved.add(c.b)
  }

  // NO 0-100 SCORE. The counts are reported; the grade is not.
  //
  // There used to be one, from scoreAgainst(ratio, {good: 3, warn: 8, bad: 20}),
  // and it was indefensible twice over.
  //
  // The scale was broken. `ratio` divides duplicated fingerprints by EVERY
  // distinct fingerprint in the repository, so the denominator grows with the
  // codebase and the ratio shrinks no matter how much is duplicated. seenit
  // scored 100.0 while listing 23 near-duplicate pairs in itself; TypeScript's
  // repository scored 100.0 too. A perfect grade sitting next to a list of
  // duplications is not a rounding problem, it is two contradictory claims
  // shipped in one product.
  //
  // And the thresholds were asserted, never measured. Duplication was one of
  // the four dimensions the calibration study never entered into any outcome
  // model, so there is no evidence about what level of duplication is bad.
  //
  // Returning null rather than inventing a number is the same choice this
  // codebase already makes for coverage with no report and for languages with
  // no calibrated thresholds: rollup() drops a null dimension and renormalises
  // the remaining weights. The measurements below are the honest part and are
  // still shown everywhere — including, now, as the product's front page.
  return {
    score: null,
    reason: 'counted, not graded — no calibrated scale for how much duplication is too much',
    clonePairs: clones.length,
    filesInvolved: involved.size,
    worstPairs: sortedBy(clones, 'aligned', 'shared').reverse().slice(0, 10),
    // Findings, not pairs — see clusterClones.
    groups: clusterClones(clones).slice(0, 10),
    groupCount: clusterClones(clones).length,
    // The bar this repository set for itself — worth showing, since it moves.
    alignedCutoff: cutoff,
    clones,
  }
}
