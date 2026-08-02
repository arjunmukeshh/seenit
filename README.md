# seenit

Check whether code already exists in a repository before writing it.

Coding agents rewrite helpers that are already there, because they search for text and a reimplementation shares none. seenit compares structure instead: rename every variable, change every string, reformat it and add comments, and it still matches.

[![npm](https://img.shields.io/npm/v/seenit?style=flat-square&color=0b7285)](https://www.npmjs.com/package/seenit)
[![node](https://img.shields.io/node/v/seenit?style=flat-square&color=0b7285)](https://nodejs.org)
[![size](https://img.shields.io/npm/unpacked-size/seenit?style=flat-square&color=0b7285)](https://www.npmjs.com/package/seenit)
[![license](https://img.shields.io/npm/l/seenit?style=flat-square&color=0b7285)](https://github.com/arjunmukeshh/seenit/blob/main/LICENSE)

## Install

```bash
npm install -g seenit          # or use npx, no install needed
```

Requires Node 20.11+ and a git repository. The detector ships as a prebuilt binary for Linux, macOS and Windows, so there is no compile step.

## Quick start

From inside any git repository, ask whether a file's contents already exist somewhere:

```bash
npx seenit check --file src/draft.js
```

```console
  Already written

  lib/utils.js:61-90  30 lines shared
```

It exits 1 when it finds something and 0 when it does not, so it drops straight into a script. To see what is already duplicated across the whole repository, run `npx seenit` with no arguments.

## Use with an AI agent

This is what the tool is for. Two ways in, and they answer different problems.

**As a hook**, so nothing has to remember to ask. Add to `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [{ "type": "command", "command": "npx seenit hook" }]
      }
    ]
  }
}
```

Every write over a dozen lines gets checked against the repository. When the code already exists, the agent is handed the location mid-task:

```console
seenit: this overlaps code already in the repository.
  lib/orders.js:12-31  (19 lines shared)
Reuse it, or continue if the duplication is deliberate.
```

Otherwise the hook says nothing at all. It never blocks a write — see [Why it warns instead of blocking](#why-it-warns-instead-of-blocking).

Run `seenit prime` once per repository first. The hook has a five-second budget and stays quiet rather than stalling a write, so on a cold cache it will not have time to answer.

**As an MCP server**, so the agent can ask deliberately. Add to `.mcp.json` (Claude Code) or `.cursor/mcp.json` (Cursor):

```json
{
  "mcpServers": {
    "seenit": { "command": "npx", "args": ["seenit", "mcp"] }
  }
}
```

| tool | does |
|---|---|
| `find_existing` | paste code, get back file paths and line ranges, or "safe to write" |
| `check_duplication` | list duplicated regions, largest first |

The two tool definitions total 247 tokens. Results are paths and line ranges.

## Use from the terminal

`seenit check` also reads from stdin, which is handy in a pipeline or a git hook:

```bash
cat draft.js | seenit check
```

`seenit` with no arguments lists what is already duplicated, largest region first:

<img src="https://raw.githubusercontent.com/arjunmukeshh/seenit/main/docs/media/cli.png" alt="Terminal running seenit. Under the heading 'Duplicated' it lists pairs of file paths with line ranges and the number of lines shared." width="760">

Nothing is written to your working tree in either case.

## Options

| | |
|---|---|
| `seenit` | list duplicated regions |
| `seenit check` | check a snippet from stdin or `--file` |
| `seenit mcp` | run as an MCP server |
| `seenit hook` | run as a pre-write hook, reading the tool call on stdin |
| `seenit prime` | normalise the repository up front, so the hook is fast |
| `--min-tokens N` | how much shared code counts as a duplicate (default 30) |
| `--limit N` | findings to show (default 3) |
| `--file PATH` | read the snippet from a file instead of stdin |

`NO_COLOR` and `FORCE_COLOR` are respected. `SEENIT_BUDGET_MS` raises the hook's time budget.

## Accuracy

The two surfaces are measured separately because they behave differently. Figures below always name which one they describe.

### `find_existing` — the hook and the MCP tool

One confusion matrix, one code path, ground truth known by construction on both sides.

**Positives:** a real function is lifted from the repository, transformed, and planted back as a probe. It counts as found only when the location returned is the file the function came from — a hit on some other file is a false positive, not a hit. **Negatives:** a real function from a *different* corpus repository, which this one provably does not contain, planted through the same code path. Any hit is a false positive.

Held out: **38 repositories**, at the shipped `--min-tokens 30`. The bar was chosen on the other 28.

| copy was… | recall | precision | specificity |
|---|---|---|---|
| pasted unchanged | 0.84 | 1.00 | 1.00 |
| identifiers renamed | 0.82 | 1.00 | 1.00 |
| + literals changed | 0.82 | 1.00 | 1.00 |
| + reformatted | 0.82 | 1.00 | 1.00 |
| + comments churned | 0.76 | 1.00 | 1.00 |
| + statements reordered | **0.74** | **1.00** | **1.00** |
| + subexpression extracted | 0.74 | 1.00 | 1.00 |

At the hardest level: 28 true positives, 0 false positives, 10 false negatives, 38 true negatives. Precision 95% CI [0.88, 1]; recall [0.58, 0.85]; specificity [0.91, 1].

Precision is 1.00 because nothing ever came back wrong — no probe was answered with the wrong file, and no foreign function was ever claimed to exist. What seenit misses, it misses silently; what it reports, it got right.

<img src="https://raw.githubusercontent.com/arjunmukeshh/seenit/main/docs/media/recall.png" alt="Line chart of held-out recall across seven cumulative transformations, on 38 repositories. All three thresholds sit together near 0.84 through reformatting, dip at comment churn, then separate once statements are reordered: k=20 ends at 0.76, k=30 at 0.73, k=75 at 0.68." width="740">

### `seenit` — the duplicate listing

A different surface and a weaker one. Whether a reported pair is worth deduplicating is a judgement, so 107 flagged pairs were stripped of file paths and judged blind, mixed with 58 pairs seenit had **not** flagged, unmarked.

**The judges accepted 1 of 58 controls and 58 of 107 flagged pairs** — Fisher p = 1.9e-13. The flagging is doing real work and the judging was not rubber-stamping, which is the precondition for reading anything else in this section.

| | judged redundant | n |
|---|---|---|
| top 3 findings, which is what `seenit` prints | 0.62 | 60 |
| findings past the third | 0.45 | 47 |
| unflagged controls | 0.02 | 58 |

The top three scored higher than the tail, but at these sample sizes that gap is not established — Fisher p = 0.12. Treat the ordering as unproven rather than as a reason to trust the first three more.

Read the listing as candidates, not defects. What it gets wrong is mostly parallel-but-distinct logic — two branches over different values, two readers with different defaults — which erasing identifiers cannot separate from a copy.

Method, judging protocol and raw labels: [calibration/](https://github.com/arjunmukeshh/seenit/tree/main/calibration).

## Speed

Normalising the tree is most of the cost, so it is cached between runs and only changed files are redone.

| repository | first run | after |
|---|---|---|
| 95 files | 0.3s | 0.3s |
| 704 files | 1.7s | 0.3s |
| 17,106 files | 29s | 8s |

The floor on a large repository is jscpd comparing every file against every other, which caching cannot remove. Past roughly ten thousand files the hook exceeds its budget and goes quiet even when warm; raise `SEENIT_BUDGET_MS` if you would rather wait.

### Who this is for

That ceiling cuts against the problem. Duplication barely matters in a 95-file repository you can hold in your head, and matters most in a 17,000-file monorepo where nobody can — which is exactly where the hook runs out of budget.

So: **seenit is for small and mid-sized repositories**, up to a few thousand files, where it answers in well under a second. On a large monorepo the CLI and the MCP tool still work if you accept a slower answer, but the hook is not the right shape for it yet, and pretending otherwise would waste your time.

## Languages

Renamed-copy matching: JavaScript, TypeScript, JSX/TSX, Python, Go, Rust, Java, C#, C, C++, Ruby, PHP, CSS, Bash.

Other formats fall back to exact matching. The accuracy figures above cover JavaScript and TypeScript only.

## Why it warns instead of blocking

The hook reports and steps aside. That is a decision the measurements above forced:

- Recall is 0.84 on a verbatim copy, 0.74 once statements move, and 0 on a genuine reimplementation. Calling that a gate would imply nothing gets past it. Plenty does, and people stop checking once they believe something is enforced.
- Blocking on the listing's 0.62 precision would reject real work often enough that the hook gets switched off within a day.

`seenit check` exits 1 when it finds something, so a hard gate is one line of shell if you want one.

## Limitations

- Finds copies, not reimplementations. A `for` loop rewritten as `reduce` shares nothing.
- Statements inserted mid-function split a match into fragments, which may fall below `--min-tokens`.
- The listing runs at 0.62 on what it prints and 0.45 below that. `find_existing` is the accurate surface.
- `find_existing` recall is 0.84 on an unchanged copy, not 1.0; the cause of the remaining misses is not known. It fails by staying silent, not by answering wrongly.
- Best on repositories up to a few thousand files. The hook stops answering on much larger ones.
- Tests, fixtures, examples and demos are left out of the listing. `find_existing` still searches them.
- Pre-1.0: output format and defaults may change.

## How it works

[jscpd](https://github.com/kucherenko/jscpd) performs the matching. It is exact-match only, so seenit parses each file with tree-sitter and rewrites every token as its class — identifiers to `ID`, literals to `STR` and `NUM` — emitting one output line per source line. jscpd matches that normalised stream, and because line numbers are preserved its results address the original files.

<img src="https://raw.githubusercontent.com/arjunmukeshh/seenit/main/docs/media/pipeline.png" alt="Diagram: two dissimilar snippets are parsed by tree-sitter into the same normalised token stream where every identifier becomes ID. jscpd then matches that stream and returns the shared region with real line numbers." width="720">

This covers Type-1 and Type-2 clones, and Type-3 partially. Type-4 is out of scope.

## Contributing

```bash
git clone https://github.com/arjunmukeshh/seenit.git && cd seenit
npm install
npm test          # 19 tests
npm run recall    # re-run the recall study (clones 63 repos, ~20 min)
npm run precision # re-run the precision study (clones 60 repos, ~40 min)
npm run media     # regenerate README images (needs Chrome)
```

Issues and pull requests: [github.com/arjunmukeshh/seenit/issues](https://github.com/arjunmukeshh/seenit/issues).

The figures under Accuracy come from the calibration scripts; regenerate them rather than editing them by hand.

## License

MIT
