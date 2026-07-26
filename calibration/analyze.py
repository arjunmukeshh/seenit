#!/usr/bin/env python3
"""Statistical analysis for the gitcodebase threshold calibration.

Implements calibration/PREREGISTRATION.md exactly. Two independent outputs:

  Stage A (descriptive) -- per-language percentiles, which become thresholds.
  Stage B (inferential) -- does any metric predict fix density after
                           controlling for size?

statsmodels rather than a hand-rolled GLM on purpose. The entire point of this
exercise is credibility, and "trust my IRLS implementation" is a materially
weaker claim than a library that thousands of papers have leaned on. A subtle
bug in a hand-rolled Poisson fit would invalidate the study silently.

Run `--self-test` first: it fits synthetic data with a known injected effect and
fails loudly if the model cannot recover it. A pipeline that cannot find an
effect it was handed has no business reporting a null.
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

import statsmodels.api as sm
from statsmodels.stats.multitest import multipletests

HERE = Path(__file__).parent
DATA = HERE / "data"
RESULTS = HERE / "results"

# Pre-registration section 5. Function-level metrics are restricted to files
# with at least one function per amendment A1.
FUNCTION_LEVEL = [
    "maxCyclomatic",
    "maxCognitive",
    "maxNesting",
    "maxParams",
    "p90FunctionLines",
]
FILE_LEVEL = ["loc", "commentRatio", "crypticIdentifierRatio"]
METRICS = FUNCTION_LEVEL + FILE_LEVEL

# Section 6: practical-significance floor. At large n, trivial effects reach
# p < 0.05, so significance alone is not the decision criterion.
MIN_IRR = 1.10
ALPHA = 0.05
DISPERSION_SWITCH = 1.5  # Pearson dispersion above this -> negative binomial


# ---------------------------------------------------------------- Stage A

def percentiles(series, qs=(50, 75, 90, 95, 99)):
    clean = series.dropna()
    if clean.empty:
        return {f"p{q}": None for q in qs}
    return {f"p{q}": float(np.percentile(clean, q)) for q in qs}


def describe(df):
    """Per-language distributions, honouring amendment A1's populations."""
    out = {}
    for language, group in df.groupby("language"):
        with_functions = group[group["functions"] > 0]
        entry = {
            "files": int(len(group)),
            "filesWithFunctions": int(len(with_functions)),
            "projects": int(group["project"].nunique()),
            "metrics": {},
        }
        for metric in METRICS:
            if metric not in group.columns:
                continue
            # A1: function-level metrics are undefined for files with no
            # functions; recording them as 0 would conflate "simple" with
            # "not applicable".
            population = with_functions if metric in FUNCTION_LEVEL else group
            entry["metrics"][metric] = {
                "n": int(population[metric].notna().sum()),
                **percentiles(population[metric]),
            }
        out[language] = entry
    return out


def thresholds_from(description):
    """Section: good = p75, warn = p90, bad = p99 of observed code.

    A score then means something falsifiable -- "worse than 90% of comparable
    real-world code" -- rather than encoding anyone's taste.
    """
    mapping = {
        "maxCyclomatic": "cyclomatic",
        "maxCognitive": "cognitive",
        "p90FunctionLines": "functionLines",
        "loc": "fileLines",
        "maxParams": "params",
        "maxNesting": "nesting",
    }
    out = {}
    for language, entry in description.items():
        table = {}
        for source, name in mapping.items():
            m = entry["metrics"].get(source)
            if not m or m["p75"] is None or m["n"] < 100:
                continue  # too few observations to set a threshold from
            table[name] = {
                "good": round(m["p75"], 2),
                "warn": round(m["p90"], 2),
                "bad": round(m["p99"], 2),
                "n": m["n"],
            }
        if table:
            out[language] = table
    return out


# ---------------------------------------------------------------- Stage B

def zscore_within_project(df, columns):
    """Section 5: predictors z-scored within project.

    Removes project-level differences in style and convention without fitting a
    factor per repository. Projects with no variation in a metric yield 0.
    """
    out = df.copy()
    for col in columns:
        grouped = out.groupby("project")[col]
        mean = grouped.transform("mean")
        std = grouped.transform("std").replace(0, np.nan)
        out[f"{col}_z"] = ((out[col] - mean) / std).fillna(0.0)
    return out


def fit_one(df, metric):
    """Poisson (or negative binomial) GLM for a single metric.

        fixes ~ metric_z + log(LOC) + age_days + offset(log(commits))

    The offset is what stops "this file changes constantly" being read as "this
    file is buggy". The log(LOC) term is the control the whole study turns on:
    without it the model rediscovers that big files change more and mislabels it
    as complexity predicting defects.
    """
    work = df.dropna(subset=["fixes", "commits", "loc", f"{metric}_z"]).copy()
    work = work[(work["commits"] > 0) & (work["loc"] > 0)]
    if len(work) < 200 or work["fixes"].sum() < 30:
        return {"metric": metric, "error": "insufficient data", "n": int(len(work))}

    X = pd.DataFrame(
        {
            metric: work[f"{metric}_z"],
            "log_loc": np.log(work["loc"]),
            "age_days": work["ageDays"].fillna(work["ageDays"].median()) / 365.0,
        }
    )
    X = sm.add_constant(X)
    y = work["fixes"].astype(float)
    offset = np.log(work["commits"].astype(float))

    model = sm.GLM(y, X, family=sm.families.Poisson(), offset=offset)
    # Section 6: files within a repository are not independent observations.
    fit = model.fit(cov_type="cluster", cov_kwds={"groups": work["project"]})

    dispersion = float(fit.pearson_chi2 / fit.df_resid)
    family = "poisson"
    if dispersion > DISPERSION_SWITCH:
        # Switch decided by the pre-registered rule, not by which fits better.
        try:
            fit = sm.GLM(
                y, X, family=sm.families.NegativeBinomial(alpha=1.0), offset=offset
            ).fit(cov_type="cluster", cov_kwds={"groups": work["project"]})
            family = "negative_binomial"
        except Exception:
            family = "poisson (nb failed to converge)"

    coef = float(fit.params[metric])
    se = float(fit.bse[metric])
    return {
        "metric": metric,
        "n": int(len(work)),
        "projects": int(work["project"].nunique()),
        "family": family,
        "dispersion": round(dispersion, 3),
        "coef": round(coef, 4),
        "se": round(se, 4),
        # Incidence rate ratio per standard deviation -- the effect size the
        # decision rule is written against.
        "irr": round(float(np.exp(coef)), 4),
        "irr_ci": [round(float(np.exp(coef - 1.96 * se)), 4),
                   round(float(np.exp(coef + 1.96 * se)), 4)],
        "p": float(fit.pvalues[metric]),
        "log_loc_coef": round(float(fit.params["log_loc"]), 4),
        "log_loc_p": float(fit.pvalues["log_loc"]),
        "vif": variance_inflation(X, metric),
    }


def variance_inflation(X, column):
    """VIF > 10 means the coefficient is not interpretable (section 8)."""
    others = [c for c in X.columns if c not in ("const", column)]
    if not others:
        return 1.0
    try:
        r2 = sm.OLS(X[column], sm.add_constant(X[others])).fit().rsquared
        return round(float(1.0 / max(1e-9, 1.0 - r2)), 3)
    except Exception:
        return None


def stratified_spearman(df, metric, deciles=10):
    """Robustness check: correlation within LOC deciles.

    No distributional assumptions. Where this disagrees with the GLM the
    stratified result governs interpretation (section 6).
    """
    work = df.dropna(subset=["fixes", "commits", "loc", metric]).copy()
    work = work[(work["commits"] > 0) & (work["loc"] > 0)]
    if len(work) < 200:
        return {"metric": metric, "error": "insufficient data"}

    work["fix_rate"] = work["fixes"] / work["commits"]
    try:
        work["loc_decile"] = pd.qcut(work["loc"], deciles, labels=False, duplicates="drop")
    except ValueError:
        return {"metric": metric, "error": "cannot form deciles"}

    rhos, weights, per_decile = [], [], []
    for decile, group in work.groupby("loc_decile"):
        if len(group) < 30 or group[metric].nunique() < 3:
            continue
        rho, p = stats.spearmanr(group[metric], group["fix_rate"])
        if np.isnan(rho):
            continue
        rhos.append(rho)
        weights.append(len(group))
        per_decile.append({"decile": int(decile), "n": int(len(group)),
                           "rho": round(float(rho), 4), "p": float(p)})

    if not rhos:
        return {"metric": metric, "error": "no usable deciles"}
    pooled = float(np.average(rhos, weights=weights))
    return {
        "metric": metric,
        "pooledRho": round(pooled, 4),
        "deciles": per_decile,
        "consistentSign": bool(all(r > 0 for r in rhos) or all(r < 0 for r in rhos)),
    }


def decide(glm, spearman):
    """Section 7's decision rule, applied mechanically."""
    if "error" in glm:
        return {"action": "insufficient data", "weightFactor": None}

    significant = glm["q"] < ALPHA
    meaningful = glm["irr"] >= MIN_IRR or glm["irr"] <= 1 / MIN_IRR
    strat_null = "error" in spearman or abs(spearman.get("pooledRho", 0)) < 0.05

    if significant and meaningful:
        return {"action": "keep", "weightFactor": 1.0}
    if significant and not meaningful:
        return {"action": "halve weight; mark advisory", "weightFactor": 0.5}
    if not significant and strat_null:
        return {"action": "remove from scoring", "weightFactor": 0.0}
    return {"action": "reduce to diagnostic weight", "weightFactor": 0.05}


def infer(df):
    df = zscore_within_project(df, [m for m in METRICS if m in df.columns])

    glms, strats = [], []
    for metric in METRICS:
        if metric not in df.columns:
            continue
        population = df[df["functions"] > 0] if metric in FUNCTION_LEVEL else df
        glms.append(fit_one(population, metric))
        strats.append(stratified_spearman(population, metric))

    # Section 6: Benjamini-Hochberg across the metric family.
    testable = [g for g in glms if "p" in g]
    if testable:
        _, qs, _, _ = multipletests([g["p"] for g in testable], alpha=ALPHA, method="fdr_bh")
        for g, q in zip(testable, qs):
            g["q"] = float(q)
    for g in glms:
        g.setdefault("q", 1.0)

    by_metric = {s["metric"]: s for s in strats}
    for g in glms:
        g["decision"] = decide(g, by_metric.get(g["metric"], {}))

    return {"glm": glms, "stratified": strats}


# ------------------------------------------------------------- self-test

def self_test():
    """Fit synthetic data with a known effect; fail loudly if unrecovered.

    Guards the study's central risk: reporting a null that is really a broken
    pipeline. A model that cannot find an effect handed to it directly cannot
    be trusted when it reports absence.
    """
    rng = np.random.default_rng(42)
    n = 6000
    project = rng.integers(0, 40, n)
    loc = np.exp(rng.normal(4.2, 0.9, n))
    commits = rng.integers(3, 60, n)

    signal = rng.normal(0, 1, n)   # true effect
    noise = rng.normal(0, 1, n)    # no effect

    true_beta = 0.30  # IRR ~ 1.35 per SD
    rate = np.exp(-2.0 + true_beta * signal + 0.25 * np.log(loc)) * commits
    fixes = rng.poisson(rate)

    df = pd.DataFrame({
        "project": [f"p{i}" for i in project],
        "language": "synthetic",
        "loc": loc, "commits": commits, "fixes": fixes,
        "ageDays": rng.integers(30, 2000, n), "functions": 5,
        "maxCyclomatic": signal, "maxCognitive": noise,
    })

    prepared = zscore_within_project(df, ["maxCyclomatic", "maxCognitive"])
    hit = fit_one(prepared, "maxCyclomatic")
    miss = fit_one(prepared, "maxCognitive")

    print("self-test — recovering a known injected effect")
    print(f"  injected  : beta={true_beta}  (IRR ~ {np.exp(true_beta):.3f} per SD)")
    print(f"  recovered : IRR={hit['irr']} CI={hit['irr_ci']} p={hit['p']:.2e}  [{hit['family']}]")
    print(f"  null metric: IRR={miss['irr']} CI={miss['irr_ci']} p={miss['p']:.3f}")

    ok = True
    if not (hit["irr_ci"][0] <= np.exp(true_beta) <= hit["irr_ci"][1]):
        print("  FAIL: true effect outside recovered CI")
        ok = False
    if hit["p"] > 1e-6:
        print("  FAIL: known strong effect not significant")
        ok = False
    if miss["p"] < 0.01:
        print("  FAIL: pure-noise metric came out significant")
        ok = False

    # A pipeline that finds size irrelevant is broken (H1 is the positive control).
    if hit["log_loc_p"] > 0.01:
        print("  FAIL: log(LOC) control not recovered")
        ok = False

    print("  PASS" if ok else "  FAILED")
    return 0 if ok else 1


# ------------------------------------------------------------------ main

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", default="A", choices=["A", "B"])
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--input")
    args = parser.parse_args()

    if args.self_test:
        return self_test()

    path = Path(args.input) if args.input else DATA / f"files-stage{args.stage}.jsonl"
    if not path.exists():
        print(f"no data at {path} — run collect.mjs first", file=sys.stderr)
        return 1

    df = pd.read_json(path, lines=True)
    print(f"{len(df):,} files · {df['project'].nunique()} projects · "
          f"{df['language'].nunique()} languages", file=sys.stderr)

    RESULTS.mkdir(exist_ok=True)
    description = describe(df)
    output = {
        "stage": args.stage,
        "files": int(len(df)),
        "projects": int(df["project"].nunique()),
        "descriptive": description,
        "proposedThresholds": thresholds_from(description),
    }

    if args.stage == "B":
        output["inferential"] = infer(df)

    out_path = RESULTS / f"stage{args.stage}.json"
    out_path.write_text(json.dumps(output, indent=2, sort_keys=True) + "\n")
    print(f"wrote {out_path}", file=sys.stderr)

    for language, entry in description.items():
        print(f"\n{language}  ({entry['files']} files, {entry['filesWithFunctions']} with functions, "
              f"{entry['projects']} projects)")
        print(f"  {'metric':<24} {'p50':>8} {'p75':>8} {'p90':>8} {'p95':>8} {'p99':>8}")
        for metric, m in entry["metrics"].items():
            if m["p50"] is None:
                continue
            print(f"  {metric:<24} {m['p50']:>8.2f} {m['p75']:>8.2f} {m['p90']:>8.2f} "
                  f"{m['p95']:>8.2f} {m['p99']:>8.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
