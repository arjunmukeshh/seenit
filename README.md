# seenit

**Has this already been written?**

seenit is a local, zero-config guardrail that stops your coding agent writing the same thing three times.

```bash
npx seenit
```

```
  Closest matches

  calibration/alignment.mjs:36
  calibration/recall.mjs:42
    and 5 more files sharing this shape

  lib/git.js:82
  lib/ledger.js:174

  lib/analyze/metrics/score.js:324
  src/lib/api.js:30

  1 more, 13 of 46 files involved.
```

Those are real findings in this repository, printed by running it on itself: an argument parser copy-pasted across seven scripts, two `git log --format` record parsers built the same way under different constant names, and the same score-threshold ladder encoded once in the analyzer and once in the UI.

No install, no config, no signup. Nothing is written to your working tree.

## Why not grep?

Because the third copy never looks like the first. seenit parses with tree-sitter and normalises identifiers, literals and comments away before matching, so a renamed, reformatted, re-commented copy still registers.

Take one function, rename every identifier, change every literal, add comments, reformat it. `grep` finds zero hits on `calculateOrderTotal`, `taxRate` or `item.price`, and not one line is byte-identical. seenit's fingerprints for the two are identical — all 21 of them. (That exact pair is a test, so the claim stays true: [test/metrics.test.js](https://github.com/arjunmukeshh/seenit/blob/main/test/metrics.test.js).)

What it does **not** catch: a copy that behaves the same but is built differently. A `for` loop rewritten as `reduce` shares **zero** fingerprints. seenit finds copies, not reimplementations.

## How often is it right?

**Recall is the number that matters, because a miss is silent.** Measured by injection on 63 npm repositories: lift a real function, transform it the way an agent would, plant it elsewhere, check whether seenit finds it. Ground truth is known by construction, so no hand-labelling is involved — and the threshold was chosen on one half of the repositories and reported on the other.

| what was done to the copy | `npx seenit` | `find_existing` |
|---|---|---|
| pasted unchanged | 0.91 | 0.91 |
| every identifier renamed | 0.91 | 0.91 |
| + every literal changed | 0.86 | 0.89 |
| + reformatted, comments churned | 0.83 | 0.89 |
| + statements reordered, a variable extracted | **0.80** | **0.89** |

Renaming, reformatting and reordering cost almost nothing — which is the claim in the section above, measured rather than asserted.

The two columns are two thresholds, deliberately. A person reads three findings and one bad one makes the tool feel noisy, so the CLI trades recall for quiet. `find_existing` hands candidates to a model that reads both snippets and discards what does not apply — a false positive costs tokens, a false negative costs the whole point — so it runs wider.

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

Repository health over time, version-controlled inside `.git/` as a real git repo you can `log`, `diff` and `bisect` — [docs/observatory.md](https://github.com/arjunmukeshh/seenit/blob/main/docs/observatory.md), or `seenit help --all`. Thresholds come from a pre-registered study of 1.6M functions across 1,100 repositories: [calibration/](https://github.com/arjunmukeshh/seenit/tree/main/calibration).

MIT.
