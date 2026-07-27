# Calibration results

Reported against [PREREGISTRATION.md](PREREGISTRATION.md), written and committed
before any data was collected.

## Stage A — distributions (complete)

**60,343 files and 392,954 functions across 391 projects**, 13 languages, zero
collection failures. Repositories selected by a dependents floor plus stratified
random draw over the entire eligible population (npm's floor of 10 dependents is
not reached until roughly package #85,000), pinned to commit SHAs and
reproducible from a seed. Median dependents 26 — ordinary packages, not
megaprojects.

Thresholds are `good` = p75, `warn` = p90, `bad` = p99 of observed code, so a
score means something falsifiable: *worse than 90% of comparable real code*.

### Measured thresholds (good / warn / bad)

| language | cyclomatic | cognitive | fn lines | functions | projects |
|---|---|---|---|---|---|
| python | 3 / 6 / 19 | 5 / 12 / 48 | 21 / 45 / 143 | 119,690 | 204 |
| typescript | 3 / 5 / 19 | 3 / 9 / 44 | 15 / 33 / 128 | 111,332 | 120 |
| javascript | 3 / 6 / 24 | 3 / 10 / 53 | 5 / 18 / 123 | 84,813 | 173 |
| tsx | 2 / 4 / 13 | 2 / 5 / 24 | 16 / 40 / 211 | 36,869 | 45 |
| rust | 3 / 5 / 16 | 4 / 9 / 41 | 17 / 35 / 121 | 18,838 | 12 |
| cpp | 3 / 7 / 25 | 5 / 14 / 74 | 20 / 47 / 160 | 9,172 | 30 |
| java | 2 / 4 / 14 | 2 / 7 / 36 | 9 / 21 / 65 | 7,116 | 11 |
| bash | 3 / 4 / 17 | 4 / 6 / 33 | 20 / 38 / 236 | 558 | 43 |
| **previous, asserted** | **5 / 10 / 20** | **7 / 15 / 30** | **25 / 50 / 100** | — | — |

**The asserted thresholds were roughly twice as lenient as real code.**
`good = 5` sits above every measured language's p75 and `warn = 10` above every
measured `warn`. A function the tool called acceptable was, in most languages,
already worse than three quarters of real code. McCabe's limit of 10 is
defensible for the 1976 FORTRAN and C it was derived from, and simply wrong for
modern JavaScript, TypeScript and Python.

**Per-language thresholds were necessary.** Cyclomatic 9 sits near the p90 of
JavaScript but past the p99 of TypeScript; one number cannot serve both.

### Effect on this repository

Applying the measured thresholds moved gitcodebase's own score from **83.8 (B)
to 70.1 (C)** — complexity 73.5 → 52.5, size 96.3 → 60.9. Verified as a correct
verdict rather than a scoring bug: JavaScript p90 cyclomatic here is 7 against a
measured warn of 6, and the worst functions are real and nameable
(`exportedNames` 21, `App` 21, `StructurePanel` 21).

### Languages excluded, and why

- `c-sharp` (3 projects), `php` (2), `ruby` (4) — below the 5-project minimum.
  One project measures a team's house style, not a distribution.
- `go`, `css` — function-level metrics only; too few projects contributed
  functions even though file counts looked adequate.
- `bash`, `cpp` params — parameter extraction is unsupported for those grammars,
  producing an all-zero distribution. That is a measurement failure, not a
  measurement, and emitting `good=warn=bad=0` would fail every function on a
  metric never actually taken.

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
