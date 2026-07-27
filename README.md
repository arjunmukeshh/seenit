# seenit

**Has this already been written?**

seenit is a local, zero-config guardrail that stops your coding agent writing the same thing three times.

```bash
npx seenit
```

```
  23 near-duplicate pairs across 19 of 42 files

  lib/git.js:82
  ↔ lib/ledger.js:170
     31 shared fingerprints

  src/components/DriftView.jsx:12
  ↔ src/components/StructurePanel.jsx:14
     16 shared fingerprints

  …and 18 more

  Renamed copies count: identifiers and literals are normalized
  before matching, so grep would not find these.
```

No install, no config, no signup. Nothing is written to your working tree.

## Why not grep?

Because the third copy never looks like the first. seenit parses with tree-sitter and normalizes identifiers, literals and comments away before matching, so a renamed, reformatted, re-commented copy still registers.

A worked example — same logic, every name and literal changed:

| | grep | seenit |
|---|---|---|
| `calculateOrderTotal` | 0 hits | — |
| `taxRate` | 0 hits | — |
| byte-identical lines | none | — |
| structural match | — | **10 of 14 fingerprints (71%)** |

What it does **not** catch: a copy that is behaviourally identical but structurally different — a `for` loop rewritten as `reduce` shares **0** fingerprints. seenit finds copies, not reimplementations.

## For coding agents (MCP)

The point isn't better search. It's search that happens *without being asked* — before the agent writes, not after you notice.

```json
{
  "mcpServers": {
    "seenit": { "command": "npx", "args": ["seenit", "mcp"] }
  }
}
```

Gives your agent `find_existing` and `check_duplication`.

## Honest limits

- **Precision is not yet measured.** The boilerplate filter keeps fingerprints appearing in under 2% of files. That share is a judgement, not a measurement, and it is the next thing to be replaced by a hand-labelled study.
- Clone detection is Type-1 and Type-2 (exact, and renamed/parameterised). Type-4 semantic clones are out of scope.

## There's more under the hood

seenit also tracks repository health over time — seven dimensions, thresholds calibrated from 1.6M functions across 1,100 repositories, all of it version-controlled inside `.git/` as a real git repo you can `log`, `diff` and `bisect`.

That work is real and still ships, but it isn't the front page. See **[docs/observatory.md](docs/observatory.md)**, and `seenit help --all`.

The calibration study — pre-registered, 1,078 projects — is in [calibration/](calibration/).

MIT.
