# gitcodebase

A code observatory. It measures the health of a repository — complexity, size,
duplication, readability, standards, extensibility, coverage — and stores every
measurement **as real git objects**, so the history of your codebase's health is
itself version-controlled, diffable, blameable and bisectable.

```bash
npx gitcodebase
```

No install, no config, no signup. Nothing is written to your working tree.

## Why this exists

Tools that measure code health are not new. What is new here is where the
measurements live. SonarQube, CodeScene and Codacy store analysis in *their*
database; you get a dashboard. gitcodebase stores it in yours, in git:

```bash
# when did this module become complex, and which commit did it?
git --git-dir=.git/gitcodebase/ledger.git blame files/src/auth.js.json

# what did that refactor actually do to the codebase?
git --git-dir=.git/gitcodebase/ledger.git diff HEAD~1 HEAD
```

```diff
   "complexity": {
-    "p90Cognitive": 10,
-    "score": 89.1932
+    "p90Cognitive": 14,
+    "score": 78.2083
   },
```

That is a health regression read directly out of a git diff. Because snapshots
are ordinary commits, `log`, `diff`, `blame`, `bisect` and `tag` all work on
your codebase's health the way they work on your code.

## Usage

```bash
gitcodebase                    # health now, including uncommitted work
gitcodebase scan               # snapshot HEAD into the ledger
gitcodebase backfill --limit 50   # build health history from past commits
gitcodebase log                # health over time, as a git-style rail
gitcodebase diff               # what changed about the codebase's health
gitcodebase watch              # continuously review changes in the background
gitcodebase serve              # open the observatory UI
gitcodebase mcp                # run as an MCP server for coding agents
gitcodebase hook               # one-line verdict, for a Claude Code Stop hook
```

`gitcodebase check --fail-under 70` exits non-zero, so it works as a CI gate or
a git hook.

### The observatory UI

`gitcodebase serve` opens a local view of the repository. The commit rail on the
left is the time axis — each node's colour is health and its radius is churn, so
a run of small green dots followed by one large amber one is legible at a
glance. Selecting a snapshot loads that point in history; ⌘-click a second to
compare them in the drift view, which renders a literal `git diff` of the
analysis.

The server binds to 127.0.0.1 only — it exposes the contents of a local
repository and must not be reachable from the network.

### After every agent turn (Claude Code hook)

```json
{ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "npx gitcodebase hook --quiet" }] }] } }
```

Prints a one-line verdict when the score actually moves, and stays silent
otherwise:

```
health 83.8  ▼ -0.9  3 files changed  dup: score.js ↔ api.js
```

### For coding agents (MCP)

```json
{ "mcpServers": { "gitcodebase": { "command": "npx", "args": ["gitcodebase", "mcp"] } } }
```

Five tools: `check_health`, `find_existing`, `check_duplication`,
`check_structure`, `review_changes`.

`find_existing` is the one that matters most. The characteristic failure of
AI-assisted development isn't bad code — each turn produces something that
works — it's the third near-identical helper, written because the agent had no
memory of the first two. Asking *"does this already exist?"* before writing
turns duplication detection from a diagnosis into prevention.

## Where the analysis lives

A bare sidecar repository at `.git/gitcodebase/ledger.git`. It is a real git
repo, so the full toolchain works on it, but it is invisible to your source
repo — `git status` and `git log --all` stay clean.

(Custom refs under `refs/gitcodebase/*` in the source repo were the obvious
alternative and are the wrong answer: `git log --all` includes them, so the
ledger would visibly pollute history in lazygit, GitKraken and tig.)

Each snapshot is a commit whose tree is the analysis, sharded so diffs are
surgical:

```
manifest.json          analyzer version, source commit, languages, thresholds
health.json            seven dimension scores, weights, what went unmeasured
files/<path>.json      per-file metrics  ← sharding makes diffs point at exact files
graph/imports.json     dependency edges
graph/modules.json     fan-in/out, instability, abstractness, cycles
api/surface.json       exported symbols  ← diffing this detects breaking changes
dup/clones.json        duplicated regions
coupling.json          files that change together
```

Everything is written as canonical JSON — keys byte-sorted, floats normalized —
because unstable serialization would produce phantom diffs and drown every real
signal.

Analysis is cached by git blob SHA. Since analysis of a blob is a pure function
of its content and git already deduplicates by content, an unchanged file is
never re-parsed and costs nothing to store. That is what makes backfilling
hundreds of commits affordable.

## Are the metrics right?

This is the question the tool lives or dies on, so it is worth being precise
about what is claimed. Three different kinds of statement get made:

| Claim | Kind | Status |
|---|---|---|
| "this function has cyclomatic complexity 8" | **fact**, per McCabe 1976 | verified against a reference implementation |
| "complexity scores 73.5" | **opinion**, built on thresholds | thresholds partially calibrated, corpus too small |
| "overall health 84.7" | **opinion**, built on weights | weights are a judgement, published for argument |

Validation runs three ways, strongest evidence first:

**1. Differential.** Cyclomatic complexity is cross-checked against ESLint 9's
`complexity` rule across eight constructs — `if`, `&&`, `for`, `try/catch`,
ternary, `switch`, `while`, and the no-branch base case. **8/8 agreement.** Two
implementations written independently from the same published definition
arriving at the same number is corroboration; a tool grading its own homework is
not. The verified values are pinned as fixtures so a regression fails the suite.

**2. Ground truth.** Fixtures whose correct answer is derivable by hand from the
published definition.

**3. Metamorphic.** Invariants that must hold regardless of the right answer:
reformatting, consistent renaming and comment edits must not move complexity;
each added branch must raise cyclomatic complexity by exactly one; duplicating a
file must be detected; identical import blocks must not count as duplication.
These need no ground truth and catch whole classes of bug.

**What is not claimed.** Construct validity — whether cyclomatic complexity
actually predicts defects — is an open question in the literature and no test
suite settles it. The tool's job is to measure what it says it measures, and to
be transparent that the composite scores built on top are judgement.

**Known weakness — the thresholds are uncalibrated.** They are literature-derived
defaults, not measurements, so today's derived scores are honest as *relative*
signals (is this getting better or worse) but should not be read as absolute
grades. [CALIBRATION.md](CALIBRATION.md) specifies the corpus and method that
would fix this, including an outcome-linked approach that tests whether each
metric actually predicts defect density — the check a linter structurally cannot
run, because it needs git history.

Dimensions that cannot be measured report `null`, not `0`. "No coverage report
found" and "nothing is covered" are different facts, and rendering the first as
a red 0% is how a tool loses your trust. Unmeasured dimensions are excluded from
the rollup and their weight redistributed.

## Why not just use ESLint?

For a point-in-time check of a JS/TS repo, `eslint` plus `eslint-plugin-sonarjs`
plus `jscpd` plus `dependency-cruiser` covers most of the *static* metrics here,
and those tools are mature. If that is all you need, use them.

What they structurally cannot do:

- **No memory.** ESLint reports the state right now. It cannot tell you
  complexity went 12 → 31, which commit did it, or whether you are trending
  better or worse. You cannot `git blame` a lint run.
- **Per-file by design.** Fan-in/fan-out, instability, main-sequence distance
  and architectural drift are invisible to a model that looks at one file at a
  time. That is architecture, not a missing rule.
- **Blind to git.** Change coupling — files that always change together despite
  no import between them — is often the most actionable finding, and is entirely
  outside ESLint's world.
- **A gate, not an instrument.** A wall of individual violations is not a health
  picture, which is why teams end up reaching for `// eslint-disable`.
- **JS/TS only**, where this covers 17 languages.

ESLint agreeing with these numbers is a feature. The competition is not over
whether complexity can be computed — that is solved and verifiable — but over
what you do with it across time.

## How health is measured

Seven dimensions, each 0–100, weighted into an overall score. Scores come from
**distributions** (p90, share over threshold), never means: ten clean files and
one 400-line monster average to "fine", which is exactly the file you needed to
be told about.

- **Complexity** — cyclomatic and cognitive complexity per function
- **Size** — file length, function length, parameter counts
- **Duplication** — token fingerprinting with identifiers normalized, so a copy
  with every symbol renamed is still caught
- **Readability** — block nesting, comment density, identifier quality, line length
- **Standards** — adherence to the repository's *own* dominant conventions, not
  an imported style guide. A tool carrying someone else's opinion produces
  thousands of findings on day one, all correctly ignored.
- **Extensibility** — Martin metrics (instability `I = Ce/(Ca+Ce)`, abstractness,
  distance from the main sequence), dependency cycles via Tarjan SCC, and hub risk
- **Coverage** — parsed from lcov or istanbul if a report exists; never executed

## Status

Working: the ledger engine, the analyzer, all seven dimensions, the CLI, the MCP
server, the HTTP API, the observatory UI, watch mode and the Claude Code hook.
39 tests passing. Dogfooded on three separate repositories.

Not built yet:

- **Threshold calibration** — the largest outstanding item; see
  [CALIBRATION.md](CALIBRATION.md)
- **Symbol navigation and reference search** — deferred with the tree-sitter
  decision, since syntax-only parsing makes cross-file resolution heuristic. A
  TypeScript-compiler-API provider behind the same interface would make it exact
- **Publishing the ledger** to a remote, so a team shares one health history
- **Ingesting ESLint output** as a signal where a project already has it
  configured, the same way coverage reports are read rather than recomputed

## Development

```bash
npm install
npm test
node bin/gitcodebase.mjs        # run against this repo
```

Requires Node 22+ and git. Grammars come from `@vscode/tree-sitter-wasm` — not
`tree-sitter-wasms`, which is built against an older ABI and fails to load under
`web-tree-sitter` 0.26.
