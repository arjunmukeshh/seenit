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

## Recall

Recall needs no judgement, because the answer can be constructed:

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

## Precision

Precision cannot be constructed the same way, so it is measured in two halves
and only the second needs a judge.

**The half that needs no judge.** A real function is lifted from one repository
and asked about in a *different* one, as an agent would ask `find_existing`
before writing something. The target repository does not contain that function,
so a match is an error by construction. Result: 0 matches in 63 repositories,
95% CI [0, 0.057]. Donor repositories are held out of the measured set, so no
repository is ever probed with a function from a repository that is also a
result.

**The half that needs a judge.** Whether a reported pair is worth deduplicating
is an opinion, so the listing is sampled and judged blind — see
[judging.md](judging.md) for the protocol and the verbatim instruction.

Two sampling rules, both learned from earlier mistakes in this project:

- **At most two cases per repository.** The previous alignment study pooled
  every pair and one repository ended up owning 69% of the result.
- **Sampled at two ranks.** One case from the top three, which is what the CLI
  prints, and one from the tail. These score differently — 0.57 against 0.39 —
  and reporting either as "precision" would be picking the flattering one.

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
  things are alike leans toward yes; the 2-of-58 control rate is what that lean
  measures, and it is small, but it is not zero and it is not a human.
- **Neither study re-clones at the pinned SHA.** `corpus.json` records a commit
  for every repository, but both harnesses shallow-clone the default branch. The
  corpus is frozen; the code measured is not, so a re-run months from now will
  not reproduce these numbers exactly.
- **JavaScript and TypeScript only.**
- **Verbatim recall is 0.86, not 1.0.** One exact copy in seven is missed and the
  cause is not yet understood.
- **Listing precision is 0.49 and the causes are only partly addressable.** Of 57
  judged-wrong findings, 29 were parallel-but-distinct logic, which normalising
  identifiers away cannot separate from a copy. The remaining 28 were data,
  config, generated files and test fixtures reaching the scanner — those are
  ignore-list work, and doing it means deriving the change on the tuning half and
  re-scoring on the held-out half rather than fitting to the labels above.

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
