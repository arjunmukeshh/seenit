# The judging protocol

Precision needs someone to decide whether a reported pair is really the same
code. This is the instruction that decision is made under, recorded here so the
verdicts can be checked against the question that produced them.

## What the judge sees

`results/precision-cases.json` — an id and two code regions, shuffled. Nothing
else. Not the repository, not the file paths, not which tool produced the pair,
not whether the pair was flagged at all. Controls are mixed in unmarked.

## The instruction, verbatim

> You are reviewing a codebase for redundancy. Below are two regions of code
> taken from the same repository.
>
> Answer one question: **would a competent engineer maintaining this repository
> call these two regions redundant — that is, is one of them doing a job the
> other already does, such that they could reasonably be replaced by a single
> shared implementation?**
>
> Answer `yes`, `no`, or `unclear`, and give one sentence of reasoning.
>
> - `yes` — same logic, whatever the names and values differ. A copy-paste, a
>   near-copy, or two hand-written implementations of one idea.
> - `no` — they merely look alike. Parallel-but-distinct constants, unrelated
>   code with a coincidentally similar shape, two switch statements over
>   different things, boilerplate that is supposed to repeat.
> - `unclear` — the regions are truncated or lack the context to tell.
>
> Judge what is in front of you. Do not assume the pair was flagged by anything,
> and do not assume it is or is not a duplicate.

## Why controls

Every repository contributes one pair of regions that were **not** flagged,
drawn at random and sized like the real cases. A judge inclined to say "yes" to
anything that looks vaguely similar will say yes to these too.

The control acceptance rate is reported next to the precision number. If it is
not near zero, the precision number is not measuring precision — it is measuring
the judge's agreeableness, and should be discarded rather than published.

## Who judges

Six fresh Claude contexts, one batch of about 29 cases each, none told what this
project is or what produced the pairs, none reading anything but its own batch.

This is a real limitation, stated rather than worked around: an LLM asked
whether two things are alike has a known pull toward yes, and these judges share
an architecture with the author. The controls exist to put a number on that
pull — it came out at 2 of 58.

`results/precision-cases.json` holds exactly what the judges saw and
`results/precision-labels.json` every verdict with its one-line reason, so any
call here can be disputed against the code it was made from.
