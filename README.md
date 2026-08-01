# seenit

Check whether code already exists in a repository before writing it. Matching ignores identifier names, literal values, formatting and comments, so a copy that shares no text with the original is still found.

[![npm](https://img.shields.io/npm/v/seenit)](https://www.npmjs.com/package/seenit)
[![node](https://img.shields.io/node/v/seenit)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/seenit)](https://github.com/arjunmukeshh/seenit/blob/main/LICENSE)

## Install

```bash
npm install -g seenit          # or use npx, no install needed
```

Requires Node 20.11+ and a git repository. The detector ships as a prebuilt binary; there is no compile step.

## Use

Check a snippet against the repository. Exits 1 if it already exists, 0 if not.

```bash
cat draft.js | seenit check
seenit check --file draft.js
```

```console
  Already written

  lib/utils.js:61-90  30 lines shared
```

List duplicated regions in the repository.

```bash
seenit
```

<img src="https://raw.githubusercontent.com/arjunmukeshh/seenit/main/docs/media/cli.png" alt="Terminal running seenit. Under the heading 'Duplicated' it lists pairs of file paths with line ranges and the number of lines shared." width="760">

Nothing is written to your working tree.

## Use with an AI agent

Add to `.mcp.json` (Claude Code) or `.cursor/mcp.json` (Cursor):

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

## Options

| | |
|---|---|
| `seenit` | list duplicated regions |
| `seenit check` | check a snippet from stdin or `--file` |
| `seenit mcp` | run as an MCP server |
| `--min-tokens N` | how much shared code counts as a duplicate (default 30) |
| `--limit N` | findings to show (default 3) |
| `--file PATH` | read the snippet from a file instead of stdin |

`NO_COLOR` and `FORCE_COLOR` are respected.

## Accuracy

Recall measured by injection on 66 npm repositories: a real function is lifted, transformed, planted back, and seenit is asked whether it finds it. `--min-tokens` was chosen on half the repositories and reported on the other half.

| copy was… | found |
|---|---|
| pasted unchanged | 0.84 |
| identifiers renamed | 0.81 |
| + literals changed | 0.81 |
| + reformatted | 0.81 |
| + statements reordered | **0.73** |

<img src="https://raw.githubusercontent.com/arjunmukeshh/seenit/main/docs/media/recall.png" alt="Line chart of held-out recall across seven cumulative transformations. Three thresholds sit on top of each other at 0.86 until comments are churned, then separate: k=20 ends at 0.81, k=30 at 0.78, k=75 at 0.69." width="740">

n=37 held out, 95% CI [0.57, 0.85].

Precision measured on 63 npm repositories, two ways.

`find_existing` was asked about a real function taken from a *different* repository — code the repository provably does not contain. It reported a match **0 times out of 62**, 95% CI [0, 0.058].

The duplicate listing was sampled and judged blind: 107 flagged pairs, no file paths, mixed with 58 pairs seenit had **not** flagged as controls.

| | judged redundant | n |
|---|---|---|
| top 3 findings, which is what `seenit` prints | 0.62 | 60 |
| findings past the third | 0.45 | 47 |
| controls, which should be near zero | 0.02 | 58 |

About half of what the listing reports is not worth acting on. Most of the rest is parallel-but-distinct logic — two branches over different values, two readers with different defaults — which normalising identifiers away cannot distinguish from a copy.

Method, judging protocol and raw labels: [calibration/](https://github.com/arjunmukeshh/seenit/tree/main/calibration).

## Languages

Renamed-copy matching: JavaScript, TypeScript, JSX/TSX, Python, Go, Rust, Java, C#, C, C++, Ruby, PHP, CSS, Bash.

Other formats fall back to exact matching. The accuracy figures above cover JavaScript and TypeScript only.

## Limitations

- Finds copies, not reimplementations. A `for` loop rewritten as `reduce` shares nothing.
- Statements inserted mid-function split a match into fragments, which may fall below `--min-tokens`.
- The listing is about half right. Read it as a list of candidates, not a list of defects. `find_existing` is the accurate surface.
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
npm test          # 12 tests
npm run recall    # re-run the recall study (clones 63 repos, ~20 min)
npm run precision # re-run the precision study (clones 63 repos, ~40 min)
npm run media     # regenerate README images (needs Chrome)
```

Issues and pull requests: [github.com/arjunmukeshh/seenit/issues](https://github.com/arjunmukeshh/seenit/issues).

The figures under Accuracy come from `npm run recall`; regenerate them rather than editing them by hand.

## License

MIT
