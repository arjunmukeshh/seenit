# Accuracy measurement

How the recall numbers in the README were produced, and how to reproduce them.

## Run it

```bash
node calibration/recall.mjs --repos 63 --concurrency 4
```

Clones each repository shallow, measures, deletes. Takes ~20 minutes and needs
network. Writes `results/recall.json`.

## Method

Precision needs a human judgement per finding. Recall does not:

1. Take a real function from a real repository.
2. Transform it the way an agent rewriting from memory would.
3. Plant it back into the working tree as a new file.
4. Ask seenit whether it finds it.

Ground truth is known by construction, so nothing is hand-labelled.

Transformations are cumulative, so the output is a curve rather than a single
number — it shows *where* matching gives out:

| level | what changed |
|---|---|
| `verbatim` | nothing |
| `rename` | every identifier |
| `rename+literals` | + every string and number |
| `+reformat` | + indentation and line breaks |
| `+comments` | + comments added and removed |
| `+reorder` | + independent statements swapped |
| `+extract` | + a subexpression pulled into a local |

## Held-out split

Repositories are split in two by a stable hash of their URL. `--min-tokens` is
chosen by looking **only** at the tuning half; the reported recall comes from the
held-out half, which no choice has seen.

This exists because the project's first threshold was picked from the gap in 30
hand-labelled cases and then scored on those same 30 cases. Choosing a bar on the
same data you report it on is not a measurement.

## Corpus

`corpus.json` — 1,114 repositories sampled from [ecosyste.ms](https://ecosyste.ms),
filtered to ≥10 dependent packages, excluding archived repos and forks, stratified
by age and size. Pinned to commit SHAs, so the sample is frozen.

Only the ~196 npm repositories are used here: the injector lifts a JavaScript
function, so a Go or Java repository would score 0 as an artifact of the harness
rather than a fact about the language.

## Known gaps

- **Precision is not measured.** It needs a human per finding.
- **JavaScript and TypeScript only.**
- **Verbatim recall is 0.86, not 1.0.** One exact copy in seven is missed and the
  cause is not yet understood.

## archive/

Scripts and results from the health-scoring model seenit used to ship — Stage A
percentile thresholds across 1.6M functions, the Stage B defect regression, and
the alignment study for the previous in-house clone engine. Kept because commit
history cites their numbers. None of it feeds the current tool.
