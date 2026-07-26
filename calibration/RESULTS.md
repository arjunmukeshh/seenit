# Calibration results — pilot

**Pilot scale. Not the final calibration.** 40 repositories for Stage A, 20 for
Stage B, against the 200–500 per language specified in
[CALIBRATION.md](../CALIBRATION.md). Directionally informative; the confidence
intervals are wide and the language coverage is thin. Everything below is
reported against [PREREGISTRATION.md](PREREGISTRATION.md), written and committed
before any data was collected.

## Stage A — distributions

8,482 files and **102,548 functions** across 40 independently sampled projects,
selected by dependents floor plus stratified random draw (median dependents:
38 npm / 22 PyPI — ordinary packages, not megaprojects).

Thresholds are `good` = p75, `warn` = p90, `bad` = p99 of observed code, so a
score means something falsifiable: *worse than 90% of comparable real code*.

### Cyclomatic complexity, per language

| | good | warn | bad | n (functions) |
|---|---|---|---|---|
| **current, asserted** | 5 | 10 | 20 | — |
| javascript | 4 | 9 | 28 | 63,757 |
| python | 3 | 6 | 22 | 14,740 |
| tsx | 2 | 4 | 15 | 7,863 |
| typescript | 2 | 4 | 13 | 15,240 |

**Per-language thresholds were necessary.** A single global set is wrong for
every language at once. A TypeScript function at cyclomatic 9 currently scores
as merely approaching "warn" when it is in fact worse than 99% of real
TypeScript.

`cpp` (4 projects) and `php` (1 project) produced no thresholds: fewer than 5
independent projects is one team's house style, not a distribution.

## Stage B — does any of it predict defects?

Poisson GLM, cluster-robust standard errors by project, `log(LOC)` covariate,
`offset(log(commits))`. n = 3,004 files across 19 projects; 29,947 file-commits
of which 4,892 matched the fix pattern. Dispersion 0.98, so Poisson held and no
negative-binomial switch was triggered. All VIFs 1.0–1.35, so coefficients are
interpretable.

| metric | IRR / SD | 95% CI | q | stratified ρ | pre-registered action |
|---|---|---|---|---|---|
| **maxNesting** | **1.133** | [1.07, 1.20] | 4.2e-5 | 0.069 | **keep** |
| maxParams | 1.085 | [1.04, 1.13] | 2.4e-4 | −0.016 | halve, advisory |
| maxCyclomatic | 1.080 | [1.04, 1.12] | 7.7e-5 | 0.113 | halve, advisory |
| p90FunctionLines | 1.076 | [1.03, 1.13] | 3.2e-3 | 0.143 | halve, advisory |
| maxCognitive | 1.050 | [1.02, 1.08] | 1.8e-3 | 0.106 | halve, advisory |
| commentRatio | 1.065 | [0.96, 1.19] | 0.30 | 0.055 | diagnostic only |
| crypticIdentifierRatio | 1.016 | [0.99, 1.05] | 0.31 | 0.156 | diagnostic only |

### Against the hypotheses

**H1 — size predicts fixes. SUPPORTED.** `log(LOC)` coefficient 0.172,
p = 4.1e-6. This was the positive control: a pipeline that could not recover the
best-replicated finding in the field would not be trustworthy when reporting a
null. It recovered it.

**H2 — complexity has no partial effect. REJECTED statistically, SUPPORTED
practically.** Cyclomatic (IRR 1.080) and cognitive (1.050) both survive the
size control with clear significance. But both fall below the pre-registered
practical floor of 1.10, so by the rule fixed in advance they are halved and
marked advisory. This is a more interesting outcome than a clean null: the
effect is real but small, which is consistent with Herraiz & Hassan's claim that
complexity adds little *beyond* size without requiring it to add nothing.

**H3 — nesting/duplication/params have no effect. REJECTED for nesting.**
`maxNesting` is the **only** metric clearing both significance and the effect
floor (IRR 1.133). Nesting depth outperforms both cyclomatic and cognitive
complexity as a defect predictor. That was not expected, and it is the most
actionable finding here.

**H4 — comment density and cryptic identifiers have no effect. SUPPORTED.**
Both non-significant (q = 0.30, 0.31). Both were named in the pre-registration
as the components most likely to fail, precisely so that cutting them would be a
pre-committed consequence rather than a post-hoc rationalisation. They failed.

### The awkward consequence, registered in advance

The pre-registration stated that if complexity showed no meaningful partial
effect, then weighting `complexity: 0.22` above `size: 0.12` is backwards. That
condition is met — complexity is below the practical floor while size is the
strongest single predictor. **Size should take the larger share.**

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

- **Pilot scale.** 19–20 projects for inference. Confidence intervals are wide.
- **Two ecosystems.** npm and PyPI only; no Go, Rust, Java, Ruby.
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
