# Accuracy measurement

How the numbers in the README were produced, and how to reproduce them.

## Run it

```bash
node calibration/recall.mjs --repos 63 --concurrency 4
node calibration/precision.mjs --repos 60 --concurrency 4
node calibration/score-precision.mjs
```

Each clones every repository shallow, measures, deletes. Twenty minutes and
forty respectively, both needing network. They write `results/recall.json` and
`results/precision.json`.

## find_existing: one confusion matrix

Recall, precision and specificity for `find_existing` come from a single run of
a single code path, because reporting them from different surfaces would let
them look composable when they are not.

Positives are constructed:

1. Take a real function from a real repository.
2. Transform it the way an agent rewriting from memory would.
3. Plant it back into the working tree as a new file.
4. Ask seenit whether it finds it.

A planted probe counts as found only when the location returned is the file the
function was lifted from. Answering with some other file is a false positive, not
a hit — scoring it as one measured "something came back" rather than "the right
thing came back".

Negatives run through the same shadow and the same code path: a real function
from a *different* corpus repository, which this one provably does not contain,
so any hit is an error. Donor repositories are held out of the measured set.

Ground truth is known by construction on both sides, so nothing is hand-labelled.

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

## Precision

Precision cannot be constructed the same way, so it is measured in two halves
and only the second needs a judge.

**The half that needs no judge** now lives in the confusion matrix above, not
here. It was previously reported as "precision", which it was not: asking only
about code the repository provably lacks measures **specificity** — the
false-positive rate on known negatives — and a tool hardcoded to answer "safe to
write" would have scored identically. Precision needs cases where the tool says
yes, which is what pairing the negatives with the planted positives supplies.

**The half that needs a judge.** Whether a reported pair is worth deduplicating
is an opinion, so the listing is sampled and judged blind — see
[judging.md](judging.md) for the protocol and the verbatim instruction. Result:
0.62 on the three findings the CLI prints, 0.45 past that, against a control
acceptance rate of 0.02.

The gap that matters is flagged against controls: 58 of 107 versus 1 of 58,
Fisher p = 1.9e-13. The gap between the top three and the tail does not clear
significance at this sample — Fisher p = 0.12 — so the ordering is reported but
not relied on.

Two sampling rules, both learned from earlier mistakes in this project:

- **At most two cases per repository.** The previous alignment study pooled
  every pair and one repository ended up owning 69% of the result.
- **Sampled at two ranks.** One case from the top three, which is what the CLI
  prints, and one from the tail. Reporting either alone as "precision" would be
  picking whichever flatters. The two differ by 0.17, which at n=60 and n=47 is
  not a significant difference (Fisher p = 0.12).

**Controls.** Every repository also contributes a pair of regions seenit did
*not* flag, drawn at random, sized like the real cases, and shuffled in
unmarked. A judge inclined to call anything similar-looking a duplicate would
accept these too. They accepted 2 of 58. Without that number the precision
figure would be unreadable, so it is reported next to it rather than omitted.

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

- **The judge is a language model, not a human.** Six fresh Claude contexts, one
  batch each, none knowing what produced the pairs. An LLM asked whether two
  things are alike leans toward yes; the 1-of-58 control rate is what that lean
  measures, and it is small, but it is not zero and it is not a human.
- **Neither study re-clones at the pinned SHA.** `corpus.json` records a commit
  for every repository, but both harnesses shallow-clone the default branch. The
  corpus is frozen; the code measured is not, so a re-run months from now will
  not reproduce these numbers exactly.
- **JavaScript and TypeScript only.**
- **Verbatim recall is 0.84, not 1.0.** One exact copy in six is missed and the
  cause is not yet understood. The misses are silent, not wrong: precision over
  the same 38 held-out repositories is 1.00, CI [0.88, 1].
- **Listing precision is 0.54 and most of what remains is not addressable.** The
  ignore work below took it from 0.49; of the wrong findings that survive, the
  bulk is parallel-but-distinct logic, which normalising identifiers away cannot
  separate from a copy by construction.

## The ignore pass

The first precision run found half the listing not worth acting on, and roughly
half of *that* was files which are not source. `ignore-audit.mjs` counted where
findings came from across the tuning repositories only — 702 findings, 30 repos —
and the held-out half was not looked at until the change was already made.

| | appearances |
|---|---|
| `fixtures/` | 290 |
| `examples/`, `demos/`, samples | 240 |
| `scaffolds/` | 69 |
| `.yml` / `.yaml` | 48 |
| `.html` | 30 |

What that bought, held-out precision 0.39 → 0.49 and findings per repository
17 → 14 at the median, 180 → 74 at the worst. Intervals overlap; the direction
was consistent across all four slices.

It also cost five points of recall, which turned out to be a mistake in *where*
the patterns went rather than in the patterns. `IGNORE` means never parsed, so a
helper in `examples/` became invisible to `find_existing` too — the tool
answering "no, go ahead" about code the repository visibly contains. Moving
those to the listing-time filter (`isSecondary`) restored recall to 0.84 and
changed the listing not at all, because the listing excluded them either way.

Worth recording that the intermediate state also flipped the tuning half's
choice of `--min-tokens` from 30 to 50, on a three-way tie broken toward the
higher bar. Reverting the misplacement put it back at 30.

## results/

`recall.json` and `precision.json` are the summaries the README quotes.
`precision-cases.json` is what the judges saw and `precision-labels.json` what
they answered; `precision-key.json` holds the provenance they were not shown.

The cases file contains short excerpts — sixty lines at most — of source from the
corpus repositories, which is what makes the verdicts checkable rather than
merely asserted. It is not shipped in the npm package.

## archive/

Scripts and results from the health-scoring model seenit used to ship — Stage A
percentile thresholds across 1.6M functions, the Stage B defect regression, and
the alignment study for the previous in-house clone engine. Kept because commit
history cites their numbers. None of it feeds the current tool.
