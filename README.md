# seenit

**Has this already been written?**

seenit is a local, zero-config guardrail that stops your coding agent writing the same thing three times.

```bash
npx seenit
```

```
  Closest matches

  lib/analyze/metrics/score.js:295
  src/lib/api.js:30

  calibration/corpus.mjs:71
  calibration/history.mjs:136

  bin/seenit.mjs:132
  mcp/server.js:221

  31 more pairs, 24 of 42 files involved.
```

Those are real findings in this repository: the same score-threshold ladder written twice, a PRNG copy-pasted between two scripts, and the CLI and MCP server both reimplementing analyse-then-compare.

No install, no config, no signup. Nothing is written to your working tree.

## Why not grep?

Because the third copy never looks like the first. seenit parses with tree-sitter and normalises identifiers, literals and comments away before matching, so a renamed, reformatted, re-commented copy still registers.

Take one function, rename every identifier, change every literal, add comments, reformat it. `grep` finds zero hits on `calculateOrderTotal`, `taxRate` or `item.price`, and no line is byte-identical. seenit matches 10 of 14 fingerprints.

What it does **not** catch: a copy that behaves the same but is built differently. A `for` loop rewritten as `reduce` shares **zero** fingerprints. seenit finds copies, not reimplementations.

## How often is it right?

**Precision 60% on 30 hand-labelled findings** under the original ranking — 18 real, 12 not. Measured, not asserted: [calibration/duplication-labels.json](calibration/duplication-labels.json).

Findings are ranked by *longest aligned run*: the number of matches holding a constant offset between the two files. Copy-paste preserves that offset; coincidental matches scatter. On the labelled set real duplication scored 10–27 aligned and idiomatic noise 3–8, with no overlap — so ranking on it lifted precision to 7 of 8 on this repo, where raw overlap had put a run of `useState` declarations above a threshold ladder written twice.

The bar is **relative to your codebase** — its own p90, floored. A fixed number cannot serve both ends: across 34 corpus repositories the 99th percentile of coincidental overlap has a median of 46 and reaches 349, while this repo's is 27. A flat cutoff either floods a large repo or silences a small one.

**Recall is unmeasured, and that is now the binding limitation.** The filter discards most candidates; nothing counts what it wrongly discards.

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

Repository health over time, version-controlled inside `.git/` as a real git repo you can `log`, `diff` and `bisect` — [docs/observatory.md](docs/observatory.md), or `seenit help --all`. Thresholds come from a pre-registered study of 1.6M functions across 1,100 repositories: [calibration/](calibration/).

MIT.
