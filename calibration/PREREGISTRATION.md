# Pre-registration: do seenit's metrics predict defects?

**Status: committed before any data was collected.** The git commit timestamp on
this file precedes the first commit containing `calibration/data/`. That ordering
is the entire point — an analysis chosen after seeing the outcome can be made to
support almost anything, and the resulting thresholds would be unfalsifiable.

Nothing in this document may be revised once collection begins. Changes of mind
go in an amendment section at the bottom, dated, with the reason — not as edits
to the text above it.

---

## 1. Motivation

seenit scores repositories on seven dimensions. Its raw metrics are
verified (cyclomatic complexity agrees 8/8 with ESLint 9), but its **thresholds
are literature-derived defaults and its weights are asserted**. A score built on
unjustified numbers is an opinion wearing the costume of a measurement.

Two questions:

- **RQ1 (descriptive)** — what are the actual distributions of these metrics
  across real, depended-upon code, per language?
- **RQ2 (inferential)** — does any metric predict defect-proneness *after
  controlling for file size*?

## 2. Relationship to prior work

RQ2 is **a replication, not a discovery**, and is registered as such.

Herraiz & Hassan (*Beyond Lines of Code: Do We Need More Complexity Metrics?*)
conclude that cyclomatic complexity is largely redundant with SLOC. The broader
result — that most complexity metrics lose their association with fault-proneness
once size is controlled for — has been replicated many times, though
predominantly on Java, and heavily on Apache Foundation projects
(The Technical Debt Dataset: 33 Apache Java projects; SmartSHARK: 77).

What is genuinely untested is whether this holds for **these specific metrics**,
on **modern JS/TS and Python**, outside the Apache ecosystem. That is the
contribution claimed here, and it is a modest one.

RQ1 is original: no public dataset provides distributions for seenit's
metrics on these languages.

## 3. Hypotheses

Stated directionally, in advance:

- **H1.** `log(LOC)` is positively associated with fix-commit count.
  *Expected: supported.* This is the best-replicated finding in the area, and
  serves as a **positive control** — if the pipeline cannot recover it, the
  pipeline is broken and no other result from it should be believed.

- **H2.** Cyclomatic and cognitive complexity have **no meaningful partial
  effect** after controlling for `log(LOC)`.
  *Expected: supported* (i.e. we expect a null), per Herraiz & Hassan.
  **Rejecting H2 would be the interesting result** and would warrant its own
  scrutiny before being believed.

- **H3.** Nesting depth, duplication involvement, and parameter count have no
  meaningful partial effect after controlling for `log(LOC)`.
  *Expected: supported (null).*

- **H4.** `crypticIdentifierRatio` and comment density have no meaningful
  partial effect.
  *Expected: supported (null).* These are the two components of the readability
  score with the weakest theoretical basis, and are named here in advance
  precisely so that cutting them later is a pre-committed consequence rather
  than a post-hoc rationalisation.

## 4. Design

**Unit of analysis.** The file. Fix attribution comes from
`git log --name-only`, which is file-granular; function-level attribution would
require line-level blame and is out of scope.

**Population.** Packages with ≥10 dependent packages on their registry
(ecosyste.ms `dependent_packages_count`), excluding archived repositories,
forks, and repositories above the size cap in §5.

**Sampling.** Dependents is an *inclusion filter*, not a ranking. Taking the
top-N by dependents would return React, TypeScript and Angular — projects whose
staffing, review processes and CI gates are atypical, and whose distributions
would produce thresholds no ordinary codebase meets. Within the eligible
population we stratify and sample randomly with a recorded seed.

Strata:
- **age**: <1y, 1–5y, >5y since first release
- **size**: <5k, 5k–50k, >50k LOC

**Exclusions (applied before analysis).** Vendored and generated code, minified
bundles, and test files — the analyzer's existing filters in
`lib/analyze/parser.js` (`isAnalyzable`, `isTestFile`). Test files are excluded
because they legitimately have different characteristics.

## 5. Measures

**Outcome.** `fixes` = number of non-merge commits touching the file whose
subject matches, case-insensitively:

```
\b(fix(e[sd])?|bug|hotfix|patch|resolv(e|es|ed)|regression|revert)\b
```

**Exposure.** `commits` = total non-merge commits touching the file. Entered as
`offset(log(commits))`, so that "this file changes a lot" cannot masquerade as
"this file is buggy". A file touched 100 times with 10 fixes and one touched 10
times with 10 fixes are very different, and the offset is what separates them.

**Primary covariate.** `log(LOC)`. This is the control the entire study turns
on. Without it, an analysis will "discover" that complexity predicts defects
when it has actually rediscovered that large files change more.

**Additional covariate.** File age in days at HEAD — older files accumulate more
commits of every kind.

**Predictors under test.** Per file: `maxCyclomatic`, `maxCognitive`,
`maxNesting`, `p90` function length, parameter count, comment ratio,
`crypticIdentifierRatio`, duplication involvement (boolean).

**Project effects.** Predictors are z-scored **within project** before pooling.
This removes project-level differences in style and convention without fitting a
factor per repository.

## 6. Analysis

**Primary model.** Poisson GLM:

```
fixes ~ metric_z + log(LOC) + age_days + offset(log(commits))
```

with **cluster-robust standard errors by project** — files within a repository
are not independent observations, and ignoring that inflates significance.

Overdispersion is expected. If the Pearson dispersion statistic exceeds 1.5, the
model switches to **negative binomial**, decided by that rule rather than by
which gives the nicer answer.

One model per metric, plus one full model containing all metrics. Both reported.

**Robustness check.** Spearman correlation between metric and fix rate **within
LOC deciles**. This makes no distributional assumptions and is directly
interpretable; where it disagrees with the GLM, the stratified result is
preferred for interpretation and the disagreement is reported.

**Multiple comparisons.** Benjamini–Hochberg across the metric family,
FDR = 0.05.

**Significance threshold.** α = 0.05 after FDR correction.

**Effect size.** Statistical significance is not the decision criterion on its
own — at large *n*, trivial effects reach significance. A metric must show an
incidence rate ratio of **≥1.10 per standard deviation** to count as
practically meaningful.

## 7. Decision rule — fixed in advance

For each metric, applied mechanically:

| Result | Action on `WEIGHTS` in `lib/analyze/metrics/score.js` |
|---|---|
| Significant **and** IRR ≥ 1.10 | keep; weight may increase proportional to effect |
| Significant but IRR < 1.10 | halve the weight; mark advisory in the UI |
| Not significant | reduce weight to 0.05 (retained as diagnostic, not scored) |
| Not significant in **both** GLM and stratified check | remove from scoring entirely |

If H2 is supported — complexity shows no partial effect — then the current
weighting of `complexity: 0.22` against `size: 0.12` is **backwards**, and size
takes the larger share. That consequence is registered now so it cannot later be
argued away because it is inconvenient for a product built around complexity.

**Metrics are not removed from *display* regardless of outcome.** A metric that
does not predict defects may still be useful to a human reading their codebase.
The rule governs what gets *scored*, not what gets *shown*.

## 8. Validity threats

- **Fix-commit identification is the weakest link.** Research on SZZ finds only
  about half of identified bug-fixing commits are genuinely bug-fixing. We will
  hand-label ~30 commits from a pilot repository and **publish the measured
  false-positive rate**. Effects are treated as directional, not precise. Full
  SZZ is out of scope.
- **Multicollinearity.** Complexity, size and nesting move together. Variance
  inflation factors will be reported; VIF > 10 means the coefficient is not
  interpretable and the stratified analysis governs.
- **Survivorship.** Only surviving, depended-upon packages are sampled. Code so
  bad it was abandoned is absent, which likely *attenuates* observed effects.
- **Commit-message conventions vary** by project and language, so fix-detection
  sensitivity is uneven. Within-project z-scoring mitigates but does not remove
  this.
- **Causality is not claimed.** These are associations. Nothing here supports
  "reducing complexity will reduce defects".

## 9. What would falsify the conclusion

If complexity shows a robust partial effect (significant, IRR ≥ 1.10, VIF < 10,
consistent in the stratified check) across both languages, then H2 is rejected,
the literature does not generalise to modern JS/TS and Python, and complexity's
weight is retained or increased. This is stated so the study can come out the
other way.

---

## Amendments

### A1 — 2026-07-27 — analysis population for function-level metrics

**Trigger.** The Stage A pilot (3 repos, 1,155 files) showed that **42.9% of
analyzable non-test files contain no functions at all** — config files, constant
tables, re-export barrels, type-only modules.

**Why it matters.** Including them materially moves the thresholds:

| metric | p50 | p90 | p99 |
|---|---|---|---|
| maxCyclomatic, all files | 1 | 6 | 17 |
| maxCyclomatic, files with ≥1 function | 2 | 8 | 19 |
| LOC, all files | 24 | 142 | 707 |
| LOC, files with ≥1 function | 44 | 168 | 529 |

**Change.** Collection is unchanged — every analyzable non-test file is still
recorded, so nothing is lost and both populations remain reportable. The
*analysis population* is now specified per metric family:

- **Function-level metrics** (cyclomatic, cognitive, nesting, params, function
  length): files with **≥1 function**.
- **File-level metrics** (file length, comment ratio, identifier ratio): all
  analyzable non-test files.

**Reasoning.** A file with no functions has no function complexity. Recording it
as `0` conflates "simple" with "not applicable" — precisely the error the tool
already refuses to make when it reports missing coverage as `null` rather than
0%. Consistency demands the same treatment here.

**Why this is not result-fitting.** Stage A carries no outcome variable — every
row has `fixes: null`. This decision concerns which files constitute source
code and was made without any view of the outcome. It does not touch §6 or §7,
and the hypotheses in §3 are unchanged.
