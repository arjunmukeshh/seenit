# seenit

**Has this already been written?**

seenit finds code your project already contains — including copies that were renamed, reformatted and re-commented, which `grep` cannot see. It is a local, zero-config guardrail against the characteristic failure of agent-written code: the third near-identical implementation of a helper that already existed twice.

[![npm](https://img.shields.io/npm/v/seenit)](https://www.npmjs.com/package/seenit)
[![node](https://img.shields.io/node/v/seenit)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/seenit)](https://github.com/arjunmukeshh/seenit/blob/main/LICENSE)

## Quick start

Run it in any git repository. No install, no config, no signup.

```bash
npx seenit
```

<img src="https://raw.githubusercontent.com/arjunmukeshh/seenit/main/docs/media/cli.png" alt="Terminal running npx seenit. Under the heading 'Closest matches' it lists three pairs of file paths with line numbers, then '2 more, 15 of 47 files involved.'" width="760">

Those are real findings in this repository, printed by running it on itself: an argument parser copy-pasted across seven scripts, two `git log --format` record parsers built the same way under different constant names, and the same score-threshold ladder encoded once in the analyzer and once in the UI.

Nothing is written to your working tree. Analysis lives in `.git/seenit/`.

## Requirements

- **Node.js 20.11 or newer**
- **A git repository.** seenit stores its analysis in git, so it exits with an error outside one — run `git init` first.
- macOS, Linux and Windows. No compiler or native build step: parsing is WebAssembly.

## Install

`npx` needs nothing installed and is the right way to try it. Install it properly once you want it on every repo:

```bash
npm install -g seenit
```

## Languages

JavaScript, TypeScript, JSX/TSX, Python, Go, Rust, Java, C#, C, C++, Ruby, PHP, CSS and Bash.

All are parsed with real grammars, not regex. Note the honest asymmetry: every language is *analysed*, but the accuracy study below was run on JavaScript and TypeScript only.

## Commands

| Command | What it does |
|---|---|
| `seenit` | Near-duplicate code, ranked. The default. |
| `seenit mcp` | Run as an MCP server so your agent checks before it writes |
| `seenit health` | Full health report `[--fail-under 70]` — exits non-zero as a CI gate |
| `seenit serve` | Open the observatory UI `[--port 4300]` |
| `seenit watch` | Review changes continuously in the background |
| `seenit help --all` | Everything, including the ledger commands |

## For coding agents

The point isn't better search. It's search that happens *without being asked* — before the agent writes, not after you notice.

**Claude Code, Cursor, and anything else that speaks MCP.** Add this to your MCP config (`.mcp.json` in the project root for Claude Code, `.cursor/mcp.json` for Cursor):

```json
{
  "mcpServers": {
    "seenit": { "command": "npx", "args": ["seenit", "mcp"] }
  }
}
```

That gives your agent `find_existing` — "does this already exist?", asked before writing — plus `check_duplication`, `check_health`, `check_structure` and `review_changes`.

**Claude Code without MCP** — a Stop hook in `.claude/settings.json`, silent unless something moved:

```json
{ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "npx seenit hook --quiet" }] }] } }
```

```console
health 83.8  ▼ -0.9  3 files changed  dup: score.js ↔ api.js
```

## Why not grep?

Because the third copy never looks like the first. seenit parses with tree-sitter and normalises identifiers, literals and comments away before matching, so a renamed, reformatted, re-commented copy still registers.

<img src="https://raw.githubusercontent.com/arjunmukeshh/seenit/main/docs/media/pipeline.png" alt="Diagram: two dissimilar snippets, one named calculateOrderTotal and one named computeBasketSum, are parsed and normalised into the same token stream, where every identifier becomes ID. The stream is cut into 25-token windows, and the resulting fingerprints for the two files line up four in a row at a constant offset — the signal that says copy." width="720">

Take one function, rename every identifier, change every literal, add comments, reformat it. `grep` finds zero hits on `calculateOrderTotal`, `taxRate` or `item.price`, and not one line is byte-identical. seenit's fingerprints for the two are identical — all 21 of them. That exact pair is a test, so the claim stays true: [test/metrics.test.js](https://github.com/arjunmukeshh/seenit/blob/main/test/metrics.test.js).

## How often is it right?

**Recall is the number that matters, because a miss is silent.** Measured by injection on 63 npm repositories: lift a real function, transform it the way an agent would, plant it elsewhere, check whether seenit finds it. Ground truth is known by construction, so no hand-labelling is involved — and the threshold was chosen on one half of the repositories and reported on the other.

<img src="https://raw.githubusercontent.com/arjunmukeshh/seenit/main/docs/media/recall.png" alt="Line chart of held-out recall across seven cumulative transformations, from pasted unchanged to variable extracted. npx seenit falls from 0.91 to 0.80, find_existing from 0.91 to 0.89, and the tool's old default from 0.80 to 0.57." width="740">

Renaming, reformatting and reordering cost almost nothing. That is the claim in the section above, measured rather than asserted — and the dashed line is the threshold this shipped with until the study was run, which lost more than four transformed copies in ten.

The two solid lines are two thresholds, deliberately. A person reads three findings and one bad one makes the tool feel noisy, so the CLI trades recall for quiet. `find_existing` hands candidates to a model that reads both snippets and discards what does not apply — a false positive costs tokens, a false negative costs the whole point — so it runs wider.

Full method, corpus percentiles and known gaps: **[calibration/](https://github.com/arjunmukeshh/seenit/tree/main/calibration)**.

## Limitations

- **It finds copies, not reimplementations.** A `for` loop rewritten as `reduce` shares **zero** fingerprints. Different code that does the same thing is out of scope.
- **Precision is not yet measured for the shipped ranking.** 60% was measured on the *previous* ranking, and the 88% figure that circulated came from choosing the cutoff and scoring it on the same 30 cases — fitting, not evidence. A held-out precision study is the next thing.
- **Recall was measured on JavaScript and TypeScript only.** Nothing is known about the other eleven languages beyond that they parse.
- **It is weakest on view code**, where unrelated components legitimately share a great deal of shape.
- **Pre-1.0.** Output formats and thresholds may change.

## Also in here

Repository health over time, version-controlled inside `.git/` as a real git repo you can `log`, `diff` and `bisect`.

<img src="https://raw.githubusercontent.com/arjunmukeshh/seenit/main/docs/media/observatory.png" alt="The seenit observatory: a left rail of 25 health snapshots with scores and deltas, and a Duplicates tab listing four findings ranked by the length of their aligned run." width="1000">

`seenit serve` opens it. Every snapshot in that rail is a commit in a real git repository inside `.git/`, so your codebase's history is something you can diff and bisect — see [docs/observatory.md](https://github.com/arjunmukeshh/seenit/blob/main/docs/observatory.md). Health thresholds come from a pre-registered study of 1.6M functions across 1,100 repositories: [calibration/](https://github.com/arjunmukeshh/seenit/tree/main/calibration).

Every image above is generated by [docs/media/build.mjs](https://github.com/arjunmukeshh/seenit/blob/main/docs/media/build.mjs) — the terminal from the CLI's real output, the chart from the measurement file, the screenshots from the running app. A stale screenshot is worse than a stale paragraph, because nobody thinks to doubt it.

## Contributing

Issues and pull requests are welcome: [github.com/arjunmukeshh/seenit/issues](https://github.com/arjunmukeshh/seenit/issues).

```bash
git clone https://github.com/arjunmukeshh/seenit.git
cd seenit
npm install
npm test          # 86 tests
npm run build     # build the observatory UI
npm run media     # regenerate the README images (needs Chrome)
```

If a change touches a measured claim, re-run the study that backs it rather than editing the number — `calibration/` holds the harnesses, and `node calibration/verify.mjs` checks that the shipped thresholds still match the results on disk.

## License

MIT — see [LICENSE](https://github.com/arjunmukeshh/seenit/blob/main/LICENSE).
