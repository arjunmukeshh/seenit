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

### Recall

Measured by injection on 65 npm repositories: a real function is lifted, transformed, planted back, and seenit is asked whether it finds it. Ground truth is known by construction. `--min-tokens` was chosen on half the repositories and reported on the other half.

| copy was… | k=20 | k=30 (shipped) | k=75 |
|---|---|---|---|
| pasted unchanged | 0.84 | 0.84 | 0.81 |
| identifiers renamed | 0.81 | 0.81 | 0.81 |
| + literals changed | 0.81 | 0.81 | 0.81 |
| + reformatted | 0.81 | 0.81 | 0.81 |
| + comments churned | 0.76 | 0.76 | 0.76 |
| + statements reordered | 0.76 | **0.73** | 0.68 |
| + subexpression extracted | 0.76 | 0.73 | 0.68 |

<img src="https://raw.githubusercontent.com/arjunmukeshh/seenit/main/docs/media/recall.png" alt="Line chart of held-out recall across seven cumulative transformations, on 37 repositories. All three thresholds sit together near 0.84 through reformatting, dip at comment churn, then separate once statements are reordered: k=20 ends at 0.76, k=30 at 0.73, k=75 at 0.68." width="740">

n=37 held out, 95% CI [0.57, 0.85] at the shipped bar and hardest level.

### Precision

Measured on 62 npm repositories, two ways.

`find_existing` — what the hook and the MCP server call — was asked about a real function taken from a *different* repository, code the repository provably does not contain. It claimed a match **0 times out of 62**, 95% CI [0, 0.058].

The duplicate listing is weaker, and was sampled and judged blind: 107 flagged pairs with no file paths, mixed with 58 pairs seenit had **not** flagged as unmarked controls.

| | judged redundant | n |
|---|---|---|
| top 3 findings, which is what `seenit` prints | 0.62 | 60 |
| findings past the third | 0.45 | 47 |
| controls, which should be near zero | 0.02 | 58 |

Read the listing as candidates, not defects. What survives is mostly parallel-but-distinct logic — two branches over different values, two readers with different defaults — which erasing identifiers cannot separate from a copy.

Method, judging protocol and raw labels: [calibration/](https://github.com/arjunmukeshh/seenit/tree/main/calibration).

## Speed

Normalising the tree is most of the cost, so it is cached between runs and only changed files are redone.

| repository | first run | after |
|---|---|---|
| 95 files | 0.3s | 0.3s |
| 704 files | 1.7s | 0.3s |
| 17,106 files | 29s | 8s |

The floor on a large repository is jscpd comparing every file against every other, which caching cannot remove. Past roughly ten thousand files the hook exceeds its budget and goes quiet even when warm; raise `SEENIT_BUDGET_MS` if you would rather wait.

## Languages

Renamed-copy matching: JavaScript, TypeScript, JSX/TSX, Python, Go, Rust, Java, C#, C, C++, Ruby, PHP, CSS, Bash.

Other formats fall back to exact matching. The accuracy figures above cover JavaScript and TypeScript only.

## Why it warns instead of blocking

The hook reports and steps aside. That is a decision the measurements above forced:

- Recall is 0.84 on a verbatim copy, 0.73 once statements move, and 0 on a genuine reimplementation. Calling that a gate would imply nothing gets past it. Plenty does, and people stop checking once they believe something is enforced.
- Blocking on the listing's 0.62 precision would reject real work often enough that the hook gets switched off within a day.

`seenit check` exits 1 when it finds something, so a hard gate is one line of shell if you want one.

## Limitations

- Finds copies, not reimplementations. A `for` loop rewritten as `reduce` shares nothing.
- Statements inserted mid-function split a match into fragments, which may fall below `--min-tokens`.
- The listing is about half right. `find_existing` is the accurate surface.
- Verbatim recall is 0.84, not 1.0; the cause of the remaining misses is not known.
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
