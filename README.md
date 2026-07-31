# seenit

Check whether code already exists in your repo **before you write it**. Matches through renamed variables, changed literals, reformatting and comment churn — so a copy that shares no text with the original still comes back.

[![npm](https://img.shields.io/npm/v/seenit)](https://www.npmjs.com/package/seenit)
[![node](https://img.shields.io/node/v/seenit)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/seenit)](https://github.com/arjunmukeshh/seenit/blob/main/LICENSE)

## Install

```bash
npm install -g seenit          # or use npx, no install needed
```

Needs Node 20.11+ and a git repository. No compile step — the detector ships as a prebuilt binary.

## Use

**Check code before writing it.** Exits 1 if it already exists, 0 if not.

```bash
cat draft.js | seenit check
seenit check --file draft.js
```

```console
  Already written

  lib/utils.js:61-90  30 lines shared
```

**List what's already duplicated.**

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

Two tools and 247 tokens of context. Results are paths and line ranges, no prose.

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

Recall measured by injection on 66 npm repositories — lift a real function, transform it, plant it back, check whether seenit finds it. Threshold chosen on half the repositories, reported on the other half.

| copy was… | found |
|---|---|
| pasted unchanged | 0.86 |
| identifiers renamed | 0.86 |
| + literals changed | 0.86 |
| + reformatted | 0.86 |
| + statements reordered | **0.78** |

<img src="https://raw.githubusercontent.com/arjunmukeshh/seenit/main/docs/media/recall.png" alt="Line chart of held-out recall across seven cumulative transformations. Three thresholds sit on top of each other at 0.86 until comments are churned, then separate: k=20 ends at 0.81, k=30 at 0.78, k=75 at 0.69." width="740">

n=36 held out, 95% CI [0.62, 0.88]. **Precision is not measured.**

Method and raw data: [calibration/](https://github.com/arjunmukeshh/seenit/tree/main/calibration).

## Languages

Renamed-copy matching works in **JavaScript, TypeScript, JSX/TSX, Python, Go, Rust, Java, C#, C, C++, Ruby, PHP, CSS, Bash**.

All other formats fall back to exact matching. The accuracy numbers above cover JavaScript and TypeScript only.

## Limitations

- **Copies, not reimplementations.** A `for` loop rewritten as `reduce` shares nothing.
- **Gapped copies are unreliable.** Statements inserted mid-function split the match into fragments that may fall below `--min-tokens`.
- **Precision unmeasured.**
- **1 verbatim copy in 7 is missed**, cause unknown.
- **Pre-1.0** — output format and defaults may change.

## How it works

[jscpd](https://github.com/kucherenko/jscpd) does the matching. It's exact-match only, so seenit parses with tree-sitter first and rewrites every token as its class — identifiers to `ID`, literals to `STR`/`NUM`, one output line per source line. jscpd then matches the normalised stream, and the line numbers come back pointing at your real code.

<img src="https://raw.githubusercontent.com/arjunmukeshh/seenit/main/docs/media/pipeline.png" alt="Diagram: two dissimilar snippets are parsed by tree-sitter into the same normalised token stream where every identifier becomes ID. jscpd then matches that stream and returns the shared region with real line numbers." width="720">

In clone-detection terms that's Type-1 and Type-2, and partial Type-3. Type-4 is out of scope.

## Contributing

```bash
git clone https://github.com/arjunmukeshh/seenit.git && cd seenit
npm install
npm test          # 15 tests
npm run recall    # re-run the accuracy study (clones 63 repos, ~20 min)
npm run media     # regenerate README images (needs Chrome)
```

Issues and PRs: [github.com/arjunmukeshh/seenit/issues](https://github.com/arjunmukeshh/seenit/issues).

If you change something a number depends on, re-run the study rather than editing the number.

## License

MIT
