# seenit

**Has this already been written?**

seenit is a local, zero-config guardrail that stops your coding agent writing the same thing three times.

```bash
npx seenit
```

<img src="https://raw.githubusercontent.com/arjunmukeshh/seenit/main/docs/media/cli.png" alt="Terminal running npx seenit. Under the heading 'Closest matches' it lists three pairs of file paths with line numbers, then '2 more, 15 of 47 files involved.'" width="760">

Those are real findings in this repository, printed by running it on itself: an argument parser copy-pasted across seven scripts, two `git log --format` record parsers built the same way under different constant names, and the same score-threshold ladder encoded once in the analyzer and once in the UI.

No install, no config, no signup. Nothing is written to your working tree.

## Why not grep?

Because the third copy never looks like the first. seenit parses with tree-sitter and normalises identifiers, literals and comments away before matching, so a renamed, reformatted, re-commented copy still registers.

<img src="https://raw.githubusercontent.com/arjunmukeshh/seenit/main/docs/media/pipeline.png" alt="Diagram: two dissimilar snippets, one named calculateOrderTotal and one named computeBasketSum, are parsed and normalised into the same token stream, where every identifier becomes ID. The stream is cut into 25-token windows, and the resulting fingerprints for the two files line up four in a row at a constant offset — the signal that says copy." width="720">

Take one function, rename every identifier, change every literal, add comments, reformat it. `grep` finds zero hits on `calculateOrderTotal`, `taxRate` or `item.price`, and not one line is byte-identical. seenit's fingerprints for the two are identical — all 21 of them. (That exact pair is a test, so the claim stays true: [test/metrics.test.js](https://github.com/arjunmukeshh/seenit/blob/main/test/metrics.test.js).)

What it does **not** catch: a copy that behaves the same but is built differently. A `for` loop rewritten as `reduce` shares **zero** fingerprints. seenit finds copies, not reimplementations.

## How often is it right?

**Recall is the number that matters, because a miss is silent.** Measured by injection on 63 npm repositories: lift a real function, transform it the way an agent would, plant it elsewhere, check whether seenit finds it. Ground truth is known by construction, so no hand-labelling is involved — and the threshold was chosen on one half of the repositories and reported on the other.

<img src="https://raw.githubusercontent.com/arjunmukeshh/seenit/main/docs/media/recall.png" alt="Line chart of held-out recall across seven cumulative transformations, from pasted unchanged to variable extracted. npx seenit falls from 0.91 to 0.80, find_existing from 0.91 to 0.89, and the tool's old default from 0.80 to 0.57." width="740">

Renaming, reformatting and reordering cost almost nothing. That is the claim in the section above, measured rather than asserted — and the dashed line is the threshold this shipped with until the study was run, which lost more than four transformed copies in ten.

The two solid lines are two thresholds, deliberately. A person reads three findings and one bad one makes the tool feel noisy, so the CLI trades recall for quiet. `find_existing` hands candidates to a model that reads both snippets and discards what does not apply — a false positive costs tokens, a false negative costs the whole point — so it runs wider.

**Precision for the shipped ranking is not yet measured.** The honest state: 60% was measured on the *previous* ranking, and the 88% figure came from choosing the cutoff and scoring it on the same 30 cases — fitting, not evidence. A held-out precision study is the next thing.

Full method, corpus percentiles and known gaps: **[calibration/](https://github.com/arjunmukeshh/seenit/tree/main/calibration)**.

## For coding agents

The point isn't better search. It's search that happens *without being asked* — before the agent writes, not after you notice.

**Claude Code, Cursor, and anything else that speaks MCP:**

```json
{
  "mcpServers": {
    "seenit": { "command": "npx", "args": ["seenit", "mcp"] }
  }
}
```

Gives your agent `find_existing` and `check_duplication`.

**Claude Code, without MCP** — a Stop hook, silent unless something moved:

```json
{ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "npx seenit hook --quiet" }] }] } }
```

```console
health 83.8  ▼ -0.9  3 files changed  dup: score.js ↔ api.js
```

## Also in here

Repository health over time, version-controlled inside `.git/` as a real git repo you can `log`, `diff` and `bisect`.

<img src="https://raw.githubusercontent.com/arjunmukeshh/seenit/main/docs/media/observatory.png" alt="The seenit observatory: a left rail of 25 health snapshots with scores and deltas, and a Duplicates tab listing four findings ranked by the length of their aligned run." width="1000">

`npx seenit serve` opens it. Every snapshot in that rail is a commit in a real git repository inside `.git/`, so the codebase's history is something you can diff and bisect — [docs/observatory.md](https://github.com/arjunmukeshh/seenit/blob/main/docs/observatory.md), or `seenit help --all`. Thresholds come from a pre-registered study of 1.6M functions across 1,100 repositories: [calibration/](https://github.com/arjunmukeshh/seenit/tree/main/calibration).

Every image above is generated by [docs/media/build.mjs](https://github.com/arjunmukeshh/seenit/blob/main/docs/media/build.mjs) — the terminal from the CLI's real output, the chart from the measurement file, the screenshots from the running app. A stale screenshot is worse than a stale paragraph, because nobody thinks to doubt it.

MIT.
