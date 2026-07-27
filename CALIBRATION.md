# Threshold calibration

The thresholds in `lib/analyze/metrics/score.js` are **provisional and
uncalibrated**. They are literature-derived defaults (McCabe 1976 proposed 10 as
a cyclomatic limit; the rest are conventional lint values). This document
specifies the corpus and method that would replace them with something
defensible, so the work is reproducible rather than a matter of taste.

## Why this matters

A threshold encodes the claim "past here, code is worse." Three different
statements get made by the tool and they are not equally solid:

| Claim | Kind | Depends on |
|---|---|---|
| cyclomatic complexity is 8 | fact | the definition — verifiable, and verified |
| complexity scores 73.5 | opinion | **thresholds** |
| overall health 84.7 | opinion | thresholds **and** weights |

Everything below rows one is only as good as this calibration. Until it is done,
the derived scores should be read as relative signals — is this getting better
or worse — rather than as absolute grades.

## What disqualifies a corpus

- **Too small.** Stable p99 estimates need on the order of 10⁴–10⁵ functions per
  language. A few thousand is noise.
- **Single-author or single-team.** Measures one set of habits, not the
  population. (An earlier pass in this repo calibrated against four projects by
  one author; that was withdrawn, because a percentile table computed from a
  convenience sample makes an assertion look like evidence.)
- **Selected on the metrics themselves.** Choosing repositories that "look
  clean" smuggles the conclusion into the premise. Selection must use signals
  independent of what is being measured.
- **Popularity as a proxy for quality.** Widely used is not well engineered.

## Corpus design

**Sampling frame.** Package registries rather than GitHub stars: top packages by
*dependent count* on npm, PyPI, crates.io, Go modules, Maven. Dependents is an
independent signal — it means other engineers rely on this in production — and
it is not derived from any metric being calibrated.

**Stratification.** Sample within each language across:
- domain (library / application / CLI / framework)
- age (>5 years, 1–5 years, <1 year)
- size (<5k, 5k–50k, >50k LOC)

Stratifying matters because these subpopulations have genuinely different
distributions, and an unstratified sample would be dominated by whichever
category is most numerous.

**Scale target.** 200–500 repositories per language, ≥50k functions per
language. At the analyzer's measured ~1.3 ms/file this is roughly five minutes
of parsing for 250k files, so scale is not the constraint — sampling discipline
is.

**Exclusions.** Vendored and generated code, minified bundles, and test files
(tests have legitimately different characteristics and are scored separately).

## Method A — descriptive percentiles

Set `good` = p75, `warn` = p90, `bad` = p99 of the observed distribution,
**per language**.

A score then means something falsifiable: *this file is worse than 90% of
comparable real-world code.* No quality judgement is required.

Known limitation: this calibrates to the average, and average code is not good
code. It answers "is this unusual?", not "is this bad?".

## Method B — outcome-linked (the one worth doing)

Descriptive percentiles establish distribution. They do not establish that the
metric *matters*. Method B tests that directly, and it is the approach a linter
structurally cannot take — it requires history, which gitcodebase already mines.

**Outcome signal.** For each file, derive from git history:
- *fix density* — share of commits touching the file whose subject matches
  `fix|bug|hotfix|revert|regression`
- *churn* — commits per unit time
- *revert incidence*

**Controls.** File size is the critical confounder: complexity correlates with
LOC, and LOC correlates with churn, so an uncontrolled analysis will "discover"
that complexity predicts defects when it is really rediscovering that big files
change more. Regress on the metric with LOC as a covariate, and report the
partial effect.

**Threshold selection.** Set `warn` where the metric begins predicting elevated
fix density beyond what size alone explains.

**The honest outcome.** If a metric shows no partial effect, that is a result:
lower its weight or remove it. Readability's `crypticIdentifierRatio` and the
comment-density ideal of 0.12 are the components most likely to fail this test,
and both are currently asserted without evidence.

## Reproducibility

A calibration nobody can rerun is a better-dressed assertion. Any run must ship:

1. `calibration/corpus.json` — repository URLs pinned to **commit SHAs**, so the
   sample is fixed rather than drifting with upstream
2. `calibration/run.mjs` — regenerates percentiles from that manifest
3. `calibration/results/<language>.json` — observed distributions, with sample
   sizes, committed to the ledger so threshold changes are themselves diffable

## Status

**Method A complete.** 396 repositories, 60,343 files, 392,954 functions across
391 projects, sampled as specified above and pinned to commit SHAs. Per-language
thresholds are measured and in use; see [RESULTS.md](calibration/RESULTS.md).

The headline: the previous literature-derived defaults were roughly twice as
lenient as real code, and per-language tables were necessary — cyclomatic 9 sits
near the p90 of JavaScript but past the p99 of TypeScript.

**Method B in progress.** The pilot (19 projects) found size to be the strongest
predictor and nesting depth the only metric clearing both significance and the
pre-registered effect floor, with comment density and cryptic-identifier ratio
null as predicted. The full run raises project count roughly twentyfold, which
is what determines whether those intervals are usable.

## Known limitations, stated rather than resolved

**Readability is still judged by assertion.** `scoreComplexity` and `scoreSize`
use measured per-language thresholds; `scoreReadability` still uses the global
literature-derived values for nesting, line length and comment ratio.

This is deliberately **not** fixed, and the reasoning is worth recording so it
isn't mistaken for an oversight. A complete fix needs `lineLength` and
`commentRatio` distributions, which the collection schema does not currently
carry — so it costs a full re-run of 1,100+ repositories. Meanwhile readability
carries a weight of 0.05, and Stage B found two of its four components
(`commentRatio`, `crypticIdentifierRatio`) to be null predictors. Re-running the
entire corpus to refine the internals of a 5%-weighted dimension whose
components are already known not to predict anything is tidiness, not value.

Recorded as a `KNOWN INCONSISTENCY` at the definition in `score.js`.

**Ruby, C++ and bash rest on narrower evidence** than TypeScript or Python.
`params` is unavailable for bash and C++ where the grammar does not expose it —
excluded rather than reported as zero.

**Fix detection remains a subject-line heuristic** with a measured 46.7%
false-positive rate. Full SZZ (tracing fix commits back to the changes that
introduced them) is the standard improvement and is out of scope here.
