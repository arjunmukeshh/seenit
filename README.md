# seenit

**Has this already been written?**

Every copy/paste detector answers "what is duplicated in this repository?" — a report you read after the code exists. seenit answers the other question: you hand it code you are *about to* write, and it tells you where that already lives. It matches through renames and reformatting, so a copy sharing no identifier with the original still comes back.

[![npm](https://img.shields.io/npm/v/seenit)](https://www.npmjs.com/package/seenit)
[![node](https://img.shields.io/node/v/seenit)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/seenit)](https://github.com/arjunmukeshh/seenit/blob/main/LICENSE)

## Quick start

```bash
cat draft.js | npx seenit check
```

```console
  Already written

  lib/cluster.js:15-54  40 lines shared
```

Exit code 1 when it finds something, 0 when it doesn't — so it drops into a pre-commit hook or a script unchanged.

To see what is *already* duplicated, run it with no arguments:

```bash
npx seenit
```

<img src="https://raw.githubusercontent.com/arjunmukeshh/seenit/main/docs/media/cli.png" alt="Terminal running npx seenit. Under the heading 'Duplicated' it lists pairs of file paths with line ranges and the number of lines shared." width="760">

No install, no config, no signup. Nothing is written to your working tree.

## Requirements

- **Node.js 20.11 or newer**
- **A git repository** — seenit reads the tracked file list from git, and exits with an error outside one.
- macOS, Linux and Windows. The detector ships as a prebuilt binary; there is no compile step.

## Install

`npx` needs nothing installed. Install it properly once you want it everywhere:

```bash
npm install -g seenit
```

## How it works

Clone detection has a standard taxonomy, and where a tool sits in it is the whole story:

| | differs from the original by | seenit |
|---|---|---|
| **Type-1** | whitespace, layout, comments | yes |
| **Type-2** | + identifiers, literals, types | yes |
| **Type-3** | + statements added or removed | partly |
| **Type-4** | same behaviour, different code | no |

**Detection is [jscpd](https://github.com/kucherenko/jscpd)** — a mature Rust implementation of Rabin-Karp matching across 223 formats. Reimplementing that would be reinventing a wheel that rolls perfectly well.

**Normalisation is ours, and it is the reason this exists.** jscpd is Type-1: measured on one function with 66 identifiers renamed and nothing else touched, every jscpd mode returns zero. So seenit parses with tree-sitter first and rewrites every token as its class — identifiers to `ID`, literals to `STR` and `NUM` — one output line per source line, so the line numbers come back pointing at your real code.

<img src="https://raw.githubusercontent.com/arjunmukeshh/seenit/main/docs/media/pipeline.png" alt="Diagram: two dissimilar snippets, one named calculateOrderTotal and one named computeBasketSum, are parsed by tree-sitter into the same normalised token stream where every identifier becomes ID. jscpd then matches that stream and returns the shared region with real line numbers." width="720">

Take one function, rename every identifier, change every literal, add comments, reformat it. `grep` finds zero hits and not one line is byte-identical. seenit returns the original's exact line range. [That pair is a test](https://github.com/arjunmukeshh/seenit/blob/main/test/duplication.test.js), so the claim fails CI when it stops being true.

## How often is it right?

**Recall is the number that matters, because a miss is silent.** Measured by injection on 66 npm repositories: lift a real function, transform it the way an agent would, plant it back, check whether seenit finds it. Ground truth is known by construction. The threshold was chosen on one half of the repositories and reported on the other.

| what was done to the copy | found |
|---|---|
| pasted unchanged | 0.86 |
| every identifier renamed | 0.86 |
| + every literal changed | 0.86 |
| + reformatted | 0.86 |
| + comments churned | 0.81 |
| + statements reordered, a variable extracted | **0.78** |

<img src="https://raw.githubusercontent.com/arjunmukeshh/seenit/main/docs/media/recall.png" alt="Line chart of held-out recall across seven cumulative transformations. Three thresholds sit on top of each other at 0.86 until comments are churned, then separate: k=20 ends at 0.81, k=30 at 0.78, k=75 at 0.69." width="740">

Held out, n=36, 95% CI [0.62, 0.88]. Renaming and reformatting cost nothing at all — that is the claim above, measured rather than asserted. What costs recall is *reordering*, which is the Type-3 boundary in the table above.

**Precision is not measured.** A held-out precision study is the next thing, and until it exists that gap is the honest state rather than a number to quote.

Method and raw results: **[calibration/](https://github.com/arjunmukeshh/seenit/tree/main/calibration)**.

## For coding agents

The point isn't better search. It's search that happens *before the writing*, without being asked.

**Claude Code, Cursor, and anything else that speaks MCP.** Add this to your MCP config — `.mcp.json` in the project root for Claude Code, `.cursor/mcp.json` for Cursor:

```json
{
  "mcpServers": {
    "seenit": { "command": "npx", "args": ["seenit", "mcp"] }
  }
}
```

Two tools, deliberately:

- **`find_existing`** — paste the code you are about to write; get back paths and line ranges, or "safe to write".
- **`check_duplication`** — what is already duplicated, largest first.

Tool definitions are permanent context, so this surface is kept small on purpose: **247 tokens**, and results are paths and line ranges with no prose. A `find_existing` call costs roughly 250 tokens against the 3,000–8,000 an agent spends grepping and reading files to answer the same question itself.

## Languages

Normalised — and therefore matched through renames — in **JavaScript, TypeScript, JSX/TSX, Python, Go, Rust, Java, C#, C, C++, Ruby, PHP, CSS and Bash**.

Every other format jscpd knows (223 of them) still gets exact matching as a floor. Note the asymmetry honestly: the accuracy study above was run on JavaScript and TypeScript only.

## Limitations

- **It finds copies, not reimplementations.** A `for` loop rewritten as `reduce` shares nothing. Type-4 is out of scope.
- **Gapped copies are hit and miss.** Insert statements in the middle and the match splits into fragments that may fall under the threshold. Recall drops from 0.86 to 0.78 across that boundary.
- **Precision is unmeasured.**
- **Recall was measured on JavaScript and TypeScript only.** Nothing is known about the other twelve normalised languages beyond that they parse.
- **One verbatim copy in seven is still missed**, and the cause is not yet understood.
- **Pre-1.0.** Output formats and thresholds may change.

## Contributing

Issues and pull requests welcome: [github.com/arjunmukeshh/seenit/issues](https://github.com/arjunmukeshh/seenit/issues).

```bash
git clone https://github.com/arjunmukeshh/seenit.git
cd seenit
npm install
npm test              # 15 tests
npm run recall        # re-run the accuracy study (clones 63 repos)
npm run media         # regenerate the README images (needs Chrome)
```

If a change touches a measured claim, re-run the study that backs it rather than editing the number. Every image above is generated by [docs/media/build.mjs](https://github.com/arjunmukeshh/seenit/blob/main/docs/media/build.mjs) — the terminal from the CLI's real output, the chart from the measurement file.

## License

MIT — see [LICENSE](https://github.com/arjunmukeshh/seenit/blob/main/LICENSE).
