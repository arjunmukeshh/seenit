# Calibration results

Reported against [PREREGISTRATION.md](PREREGISTRATION.md), written and committed
before any data was collected.

## Stage A — distributions (complete, verified)

**198,571 files and 1,620,805 functions across 1,090 projects**, sampled from
**8 package registries** — npm, PyPI, crates.io, the Go module proxy, Maven,
NuGet, Packagist and RubyGems. Zero collection failures.

Repositories selected by a dependents floor plus stratified random draw over the
entire eligible population (npm's floor of 10 dependents is not reached until
roughly package #85,000), pinned to commit SHAs, reproducible from a seed.
Median dependents 21–67 per ecosystem — ordinary packages, not megaprojects.

Thresholds are `good` = p75, `warn` = p90, `bad` = p99 of observed code, so a
score means something falsifiable: *worse than 90% of comparable real code*.

**All 335 automated verification checks pass** (`node calibration/verify.mjs`).

### Measured thresholds (good / warn / bad)

| language | cyclomatic | cognitive | functions | projects |
|---|---|---|---|---|
| java | 2 / 4 / 13 | 2 / 6 / 32 | 388,309 | 107 |
| c-sharp | 2 / 4 / 14 | 2 / 6 / 34 | 284,780 | 120 |
| javascript | 3 / 6 / 24 | 4 / 10 / 51 | 222,004 | 269 |
| go | 3 / 5 / 18 | 3 / 8 / 45 | 208,607 | 128 |
| python | 3 / 6 / 20 | 5 / 12 / 49 | 127,167 | 245 |
| typescript | 3 / 5 / 17 | 2 / 8 / 39 | 121,072 | 146 |
| rust | 1 / 4 / 15 | 0 / 6 / 38 | 120,481 | 135 |
| php | 2 / 5 / 16 | 2 / 8 / 36 | 47,465 | 121 |
| tsx | 2 / 4 / 12 | 2 / 5 / 21 | 42,054 | 54 |
| ruby | 2 / 3 / 10 | 1 / 2 / 9 | 38,460 | 126 |
| cpp | 3 / 7 / 28 | 4 / 14 / 88 | 17,955 | 67 |
| bash | 2 / 4 / 12 | 2 / 6 / 20 | 2,451 | 131 |
| **previously asserted** | **5 / 10 / 20** | **7 / 15 / 30** | — | — |

**The asserted thresholds were roughly twice as lenient as real code.**
`good = 5` sits above every measured language's p75, and `warn = 10` above every
measured `warn` — which now falls between **3 and 7** in all twelve. A function
the tool called acceptable was, in most languages, already worse than three
quarters of real code. McCabe's limit of 10 is defensible for the 1976 FORTRAN
and C it was derived from, and simply wrong for anything here.

That twelve independently-sampled ecosystems, drawn from different registries
and maintained by different communities, converge on a `warn` band of 3–7 is
itself corroborating. Noise does not converge.

**Per-language thresholds were necessary.** Cyclomatic 9 sits near the p90 of
JavaScript but past the p99 of TypeScript; one number cannot serve both.

### Effect on this repository

Applying the measured thresholds moved gitcodebase's own score from **83.8 (B)
to 74.7 (C)**. Verified as a correct verdict rather than a scoring bug:
JavaScript p90 cyclomatic here is 7 against a measured warn of 6, and the worst
functions are real and nameable (`exportedNames` 21, `App` 21,
`StructurePanel` 21).

### What the expansion cost, and what it caught

Extending from 2 registries to 8 was undertaken for coverage, but its more
valuable output was defects. Sampling RubyGems directly exposed that **Ruby had
been extracting zero functions** — its grammar names function nodes `method` and
`singleton_method`, neither of which was recognised. An audit of all ten
languages then found C/C++ returning `(anonymous)` with zero parameters, and Go
undercounting grouped parameters.

Ruby's *first* corrected run then produced thresholds of **1/1/3 cyclomatic**,
implying no Ruby method ever branches. Ruby names its branch constructs bare
(`if`, `unless`, `when`) where PHP and C# use suffixed forms and emit the bare
keyword as an anonymous token; only the suffixed spellings were listed. Fixing
it moved Ruby to **2/3/10**, PHP and C# up by two decisions each, and required
a third full re-collection.

None of these were caught by reasoning about the code. All were caught by
running it against ecosystems it had never seen.

### Excluded, and why

- `css` — no functions to measure; file-level metrics only.
- `bash`, `cpp` **params** — the grammars do not expose a parameter list, giving
  an all-zero distribution. That is a measurement failure, not a measurement:
  emitting `good=warn=bad=0` would fail every function on a metric never taken.

## Stage B — does any of it predict defects?

Poisson GLM, cluster-robust standard errors by project, `log(LOC)` covariate,
`offset(log(commits))`. **n = 39,028 files across 386 projects.** Dispersion
1.36, below the pre-registered 1.5 switch, so Poisson was retained. All VIFs
1.00–1.18, so coefficients are interpretable.

| metric | IRR / SD | 95% CI | q | stratified ρ | pre-registered action |
|---|---|---|---|---|---|
| maxNesting | 1.097 | [1.02, 1.17] | 0.053 | 0.140 | diagnostic weight |
| maxParams | 1.050 | [0.98, 1.12] | 0.26 | 0.041 | **remove from scoring** |
| p90FunctionLines | 1.033 | [1.00, 1.07] | 0.15 | 0.104 | diagnostic weight |
| maxCyclomatic | 1.020 | [0.99, 1.05] | 0.26 | 0.123 | diagnostic weight |
| maxCognitive | 1.020 | [1.00, 1.05] | 0.26 | 0.125 | diagnostic weight |
| commentRatio | 1.010 | [0.96, 1.06] | 0.68 | 0.026 | **remove from scoring** |
| crypticIdentifierRatio | 1.013 | [0.97, 1.06] | 0.68 | 0.034 | **remove from scoring** |

### The pilot was wrong, and why that matters

The 19-project pilot reported cyclomatic complexity as significant at
q = 7.7e-5. At 386 projects it is q = 0.26.

| metric | pilot q (19 proj) | full q (386 proj) |
|---|---|---|
| maxCyclomatic | 7.7e-5 | 0.26 |
| maxCognitive | 1.8e-3 | 0.26 |
| maxNesting | 4.2e-5 | 0.053 |
| p90FunctionLines | 3.2e-3 | 0.15 |

This is not noise, it is a known failure mode: **cluster-robust standard errors
are anti-conservative when clusters are few.** With 19 projects the estimator
understates uncertainty and manufactures significance; the usual guidance is
that roughly 40+ clusters are needed before it can be trusted. Every "finding"
the pilot produced about complexity was an artefact of cluster count, and the
pilot's own conclusion that nesting "beats" complexity does not survive.

Worth stating plainly because the pilot results were reported as findings before
this run existed. A study that can correct itself is the point of running it at
scale.

### Against the hypotheses

**H1 — size predicts fixes. SUPPORTED**, and strengthened: `log(LOC)`
coefficient 0.166, p = 2.5e-8 (pilot: 4.1e-6). The positive control holds, so a
pipeline capable of finding an effect is the one reporting the nulls below.

**H2 — complexity has no partial effect after controlling for size. SUPPORTED.**
Cyclomatic q = 0.26, cognitive q = 0.26. This is the clean null the
pre-registration expected, and it reproduces Herraiz & Hassan on modern
JavaScript, TypeScript and Python rather than 2000s-era Java.

**H3 — nesting and parameters have no effect. SUPPORTED.** Nesting q = 0.053
just misses; parameters q = 0.26 with a stratified ρ of 0.041, failing both
tests and removed from scoring outright.

**H4 — comment density and cryptic identifiers have no effect. SUPPORTED.**
q = 0.68 for both. Named in advance as most likely to fail, so removing them is
a pre-committed consequence rather than a post-hoc rationalisation.

### The awkward consequence, registered in advance and now applied

The pre-registration stated that if complexity showed no meaningful partial
effect, weighting `complexity: 0.22` above `size: 0.12` is backwards and size
takes the larger share. That condition is met. Applied:

| dimension | before | after | basis |
|---|---|---|---|
| size | 0.12 | **0.37** | measured — the one robust predictor |
| extensibility | 0.17 | 0.17 | untested |
| coverage | 0.15 | 0.15 | untested |
| duplication | 0.13 | 0.13 | untested |
| standards | 0.08 | 0.08 | untested |
| complexity | 0.22 | **0.05** | measured — null after size control |
| readability | 0.13 | **0.05** | measured — components null |

**What this does not mean.** Not that complexity is meaningless — only that it
does not predict *this* outcome, measured *this* way, beyond size. The fix
signal carries a measured 46.7% false-positive rate; being non-differential, it
biases every estimate toward the null, so these results are conservative.
Complexity stays fully measured and displayed. The rule governs what is
**scored**, not what is **shown**, and a metric that fails to predict defects
can still tell you something true about code you have to read.

**Four dimensions were never tested.** duplication, standards, extensibility and
coverage had no file-level outcome model fitted against them. Their weights are
unchanged and rest on judgement, retained on *no evidence either way* rather
than *evidence of value*. `WEIGHT_PROVENANCE` in `score.js` marks which is
which, so the distinction survives into the product rather than living only
here.

## Fix-detection error rate

Measured, not assumed, as required by §8. Hand-labelled 30 commits, stratified
15 matched / 15 unmatched — see [fix-labels.json](results/fix-labels.json).

- **precision 53.3%**, false-positive rate **46.7%**
- **0 false negatives** in the sample
- every false positive was a documentation, prose, link or jsdoc change
  containing the word "fix"

The 46.7% closely matches published SZZ findings that roughly half of
heuristically-identified bug-fixing commits genuinely are. This is a property of
subject-line heuristics generally, not of this implementation.

**Direction of the resulting bias.** The misclassification is non-differential —
whether a commit message says "docs: fix typo" is unrelated to the complexity of
the files it touches — so it adds noise to the outcome and pulls estimates
**toward the null**. Reported effects are therefore conservative; true
associations are likely somewhat larger. Crucially, it cannot manufacture an
effect that is not there, so the significant findings survive this caveat while
the nulls (H4) are weakened by it.

The regex was frozen at pre-registration and has **not** been changed in light
of this measurement.

## Limitations

- **Stage B inference is still pilot-scale** (19 projects) pending the full run.
  Stage A is complete at 391 projects.
- **Two ecosystems sampled.** npm and PyPI. Rust, Java, C++ and Go appear only
  as incidental files inside those repositories, which is why their project
  counts are low and several fall below the threshold minimum.
- **Survivorship.** Only surviving, depended-upon packages are sampled. Code bad
  enough to be abandoned is absent, which likely attenuates effects further.
- **Association, not causation.** Nothing here supports "reducing nesting will
  reduce defects".
- **File-granular.** Fixes are attributed to files, not functions, so
  function-level metrics are aggregated to a per-file maximum before modelling.

## Reproducing

```bash
node calibration/corpus.mjs --ecosystems npm,pypi --target 20   # pinned to SHAs
node calibration/collect.mjs --stage A
node calibration/collect.mjs --stage B
calibration/.venv/bin/python calibration/analyze.py --stage A
calibration/.venv/bin/python calibration/analyze.py --stage B
```

`corpus.json` pins every repository to a commit SHA and both RNGs are seeded, so
the sample is fixed rather than drifting with upstream.
