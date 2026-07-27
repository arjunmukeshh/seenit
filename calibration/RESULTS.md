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
`offset(log(commits))`. **n = 153,696 files across 1,078 projects** for the
function-level metrics (per amendment A1, restricted to files containing at
least one function); 199,485 files across 1,091 projects for the two file-level
ones. Dispersion 1.42, below the pre-registered 1.5 switch, so Poisson was
retained. All VIFs 1.01–1.26, so coefficients are interpretable.

| metric | IRR / SD | 95% CI | q | stratified ρ | pre-registered action |
|---|---|---|---|---|---|
| maxNesting | 1.098 | [1.05, 1.15] | 2.7e-4 | 0.117 | halve weight; mark advisory |
| maxParams | 1.036 | [1.00, 1.07] | 7.9e-2 | 0.014 | **remove from scoring** |
| p90FunctionLines | 1.031 | [1.01, 1.05] | 6.8e-3 | 0.090 | halve weight; mark advisory |
| maxCyclomatic | 1.029 | [1.01, 1.05] | 1.9e-2 | 0.099 | halve weight; mark advisory |
| maxCognitive | 1.029 | [1.01, 1.05] | 1.3e-2 | 0.100 | halve weight; mark advisory |
| commentRatio | 0.970 | [0.94, 1.00] | 7.9e-2 | 0.014 | **remove from scoring** |
| crypticIdentifierRatio | 1.007 | [0.97, 1.04] | 6.8e-1 | 0.002 | **remove from scoring** |

### Significance flipped three times. Effect size never did.

This is the single most important thing this study produced, and it is an
argument for pre-registration rather than an argument about complexity.

| | 19 projects | 386 projects | 1,078 projects |
|---|---|---|---|
| maxCyclomatic q | 7.7e-5 | 0.26 | 0.019 |
| **significant?** | yes | **no** | yes |
| maxCyclomatic IRR/SD | 1.080 | 1.020 | 1.029 |
| **≥ 1.10 effect floor?** | no | no | no |

Read on significance alone, the same metric was a real predictor, then a clean
null, then a real predictor again — three sample sizes, three different
products. Read on effect size, the answer never moved: complexity's partial
association with fixes is around **3% more fixes per standard deviation**, well
under the 1.10 floor §6 fixed in advance.

The middle column is the known failure mode in both directions. **Cluster-robust
standard errors are anti-conservative when clusters are few** — with 19 projects
the estimator understates uncertainty and manufactures significance, and roughly
40+ clusters are the usual guidance before it can be trusted. But the 386-project
null was underpowered in the other direction, and reading it as evidence of
absence is the mistake I made: complexity's weight was cut to 0.05 on the
strength of it, and that cut is corrected below.

The rule that survived all three runs is the conjunction: **statistically
significant AND IRR ≥ 1.10.** Neither criterion alone gives a stable answer;
requiring both, in advance, gives the same answer every time.

### Against the hypotheses

**H1 — size predicts fixes. SUPPORTED.** `log(LOC)` coefficient 0.107,
p = 4.7e-5. The positive control holds, so a pipeline capable of finding an
effect is the one reporting the small effects below.

**H2 — complexity has no partial effect after controlling for size. PARTIALLY
SUPPORTED, and stated honestly:** at full scale the effect is statistically
detectable (cyclomatic q = 0.019, cognitive q = 0.013) but far below the
pre-registered practical floor (IRR 1.029 vs 1.10). Herraiz & Hassan's finding
reproduces in *magnitude* on modern JavaScript, TypeScript and Python — but with
1,078 clusters there is enough power to reject the strict null, and claiming a
clean null here would be overreach.

**H3 — nesting and parameters have no effect. MIXED.** Nesting is the strongest
non-size signal (IRR 1.098, q = 2.7e-4, ρ = 0.117) and sits just under the
floor — close enough that a larger corpus could clear it. Parameters fail both
tests (q = 0.079, ρ = 0.014) and are removed from scoring outright.

**H4 — comment density and cryptic identifiers have no effect. SUPPORTED.**
Cryptic identifiers q = 0.68 with ρ = 0.002, the cleanest null in the study.
Comment ratio is *negatively* signed (IRR 0.970) and misses significance anyway.
Both were named in advance as most likely to fail, so removing them is a
pre-committed consequence rather than a post-hoc rationalisation.

### The consequence, registered in advance and now applied

| dimension | asserted | interim (386) | **final (1,078)** | basis |
|---|---|---|---|---|
| size | 0.12 | 0.37 | **0.30** | measured — the one large effect |
| extensibility | 0.17 | 0.17 | 0.17 | untested |
| coverage | 0.15 | 0.15 | 0.15 | untested |
| duplication | 0.13 | 0.13 | 0.13 | untested |
| complexity | 0.22 | 0.05 | **0.11** | measured — significant, sub-floor |
| standards | 0.08 | 0.08 | 0.08 | untested |
| readability | 0.13 | 0.05 | 0.06 | measured — components null |

Two corrections in one table. Size still rises over its asserted 0.12, because
it is the only dimension with a large measured effect. But complexity moves back
**up** from the interim 0.05 to 0.11: the "halve weight; mark advisory" branch
of the decision rule, not the "remove" branch. Cutting it to 0.05 treated an
underpowered null as a finding.

**What this does not mean.** Not that complexity is meaningless — only that its
partial effect on *this* outcome, measured *this* way, beyond size, is small.
The fix signal carries a measured 46.7% false-positive rate; being
non-differential, it biases every estimate toward the null, so these effect
sizes are conservative. Complexity stays fully measured and displayed. The rule
governs what is **scored**, not what is **shown**, and a metric with a 3% effect
on defect density can still tell you something true about code you have to read.

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
effect that is not there, so the effects that were found survive this caveat
while the nulls (H4) are weakened by it.

The regex was frozen at pre-registration and has **not** been changed in light
of this measurement.

## Limitations

- **Effects near the floor are not settled.** Nesting at IRR 1.098 sits a
  hair under the 1.10 cutoff. A larger corpus could push it over, and the
  cutoff itself is a judgement — recorded in §6 before the data, but a
  judgement. It is not a law of nature that 1.10 matters and 1.098 does not.
- **Eight registries sampled**, but coverage is uneven: npm, PyPI, crates.io,
  Go, Maven, RubyGems, Packagist and NuGet. Several languages appear mainly as
  incidental files inside repositories drawn for another ecosystem, which is why
  a few project counts fall below the threshold minimum.
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
