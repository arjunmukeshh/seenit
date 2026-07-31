// The detection engine, which we do not own.
//
// seenit used to hand-roll MOSS-style winnowing (Schleimer/Wilkerson/Aiken 2003)
// over tree-sitter tokens. jscpd already does that, in Rust, across 223 formats,
// and it does one thing our fingerprints never could: it reports the CONTIGUOUS
// duplicated block. Three separate attempts at deriving a region from winnowed
// fingerprints failed — file containment read 9.8% for a verbatim copy, raw
// counts ranked by file size, and line bounds claimed 153 lines for 13 scattered
// hits. jscpd returns start and end lines because its index is built to.
//
// Measured on this repository: 0.10s against ~1.2s for the tree-sitter pass.
//
// What is left for us is what jscpd deliberately does not do: ask "does this
// snippet already exist?" before it is written, and decide the threshold per
// repository rather than accepting a global default.

import { execFile as execFileCb } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import { promisify } from 'node:util'

import { buildShadow, normalizeSource } from './normalize.js'

const execFile = promisify(execFileCb)
const require = createRequire(import.meta.url)

// jscpd's default. Flat, global, and identical for a 42-file repo and a
// 38,000-file one — the exact failure the old engine's own comments documented
// for its flat threshold. Phase 1 replaces this with a per-repository figure;
// until then it is the honest default rather than a number we invented.
export const JSCPD_DEFAULT_MIN_TOKENS = 30

// Directories and files that are not the user's code. Translated from the old
// analyzer's SKIP_DIRS and SKIP_FILE_RE, which existed because a single
// 10,741-line compiled chunk once landed in the corpus. jscpd honours
// .gitignore, which covers most of it, but build output is frequently committed.
const IGNORE = [
  // .git first, and not for tidiness. Without it the top four findings on this
  // repository were git's own sample hooks matching the ledger's copies of the
  // same sample hooks — 980 tokens of pre-rebase.sample, ranked above every
  // piece of real code.
  '**/.git/**',
  '**/node_modules/**', '**/dist/**', '**/build/**', '**/out/**', '**/vendor/**',
  '**/third_party/**', '**/coverage/**', '**/.next/**', '**/_next/**', '**/.nuxt/**',
  '**/.svelte-kit/**', '**/.venv/**', '**/venv/**', '**/__pycache__/**', '**/target/**',
  '**/Pods/**', '**/DerivedData/**', '**/bower_components/**', '**/jspm_packages/**',
  '**/__generated__/**', '**/generated/**', '**/autogen/**',
  '**/*.min.js', '**/*.min.css', '**/*.bundle.js', '**/*.d.ts',
  '**/*.generated.*', '**/*.pb.go', '**/*_pb2.py',
  // Data and prose, not source. jscpd handles 223 formats including markdown,
  // which is a feature for other purposes and noise for this one: without these
  // it reported repeated headings in observatory.md and matched
  // results/recall.json against results/stageA.json, both above real code.
  '**/*.json', '**/*.lock', '**/*.snap',
  '**/*.md', '**/*.mdx', '**/*.txt', '**/*.rst', '**/*.csv', '**/*.svg',
]

const TEST_RE = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|_test\.[a-z]+$/i

export const isTest = (path) => TEST_RE.test(path)

// The binary ships as a platform-specific optionalDependency; resolve the
// wrapper's own bin rather than trusting PATH, so a globally installed jscpd of
// a different version cannot change our measured numbers.
function binary() {
  try {
    return require.resolve('jscpd/run-jscpd.js')
  } catch {
    throw new Error('jscpd is not installed — it is a dependency of seenit, so this is a broken install')
  }
}

/**
 * Run jscpd over one or more roots and return normalised blocks.
 *
 * Paths come back RELATIVE TO `base`. jscpd reports names relative to whichever
 * scanned root a file sits under, so scanning `lib` and `calibration` together
 * yields bare `alignment.mjs` next to `analyze/metrics/duplication.js` — two
 * different roots, indistinguishable, and ambiguous the moment two directories
 * hold the same filename. `--absolute` plus our own relativisation is the only
 * way to get a stable identity for a file.
 */
export async function detect(roots, { minTokens = JSCPD_DEFAULT_MIN_TOKENS, base, includeTests = false } = {}) {
  const out = await mkdtemp(join(tmpdir(), 'seenit-jscpd-'))
  try {
    const args = [
      ...roots,
      '--reporters', 'json',
      '--output', out,
      '--absolute',
      '--min-tokens', String(minTokens),
      '--ignore', IGNORE.join(','),
      // A .ts file and a .js file are different formats to jscpd and are not
      // compared by default. The planted-copy study caught this: donors come
      // from TypeScript as often as JavaScript, and without this the copy is
      // invisible for reasons that have nothing to do with how well it hid.
      '--cross-formats', 'js-ts',
      '--no-colors',
      '--silent',
    ]
    try {
      await execFile(binary(), args, { maxBuffer: 1 << 26 })
    } catch (err) {
      // jscpd exits non-zero for --threshold breaches, which we never set, but
      // also on real failures. The report is the source of truth: if it was
      // written, the run worked.
      if (!err.code && !err.stdout) throw err
    }

    let report
    try {
      report = JSON.parse(await readFile(join(out, 'jscpd-report.json'), 'utf8'))
    } catch {
      return [] // no duplicates found writes no report on some paths
    }

    // For embedded blocks jscpd suffixes the name with its format —
    // "docs/observatory.md:markdown". Strip only that exact suffix, so a path
    // that legitimately contains a colon survives.
    const clean = (name, format) => (name.endsWith(`:${format}`) ? name.slice(0, -(format.length + 1)) : name)

    // Resolve symlinks on BOTH sides before relativising. --absolute makes jscpd
    // report real paths, and on macOS os.tmpdir() is /var/folders/... which is a
    // symlink to /private/var/folders/... — so relative() produced
    // "../../../private/var/.../file.js" and no path ever compared equal. The
    // recall harness read that as jscpd having zero recall on verbatim copies,
    // which would have been reported as a fact about the engine.
    const root = base ? await realpath(base).catch(() => base) : null
    const rel = (name) => (root && isAbsolute(name) ? relative(root, name) : name)

    return (report.duplicates ?? [])
      .map((d) => ({
        a: rel(clean(d.firstFile.name, d.format)),
        aStart: d.firstFile.start,
        aEnd: d.firstFile.end,
        b: rel(clean(d.secondFile.name, d.format)),
        bStart: d.secondFile.start,
        bEnd: d.secondFile.end,
        lines: d.lines,
        tokens: d.tokens,
        format: d.format,
      }))
      // A block matching itself. jscpd emits these for embedded sub-blocks —
      // observatory.md:76-84 paired with observatory.md:76-84 — and they are
      // never a finding. Intra-file duplication at DIFFERENT ranges is real and
      // is kept: a helper written twice in one file is worth knowing about.
      .filter((d) => !(d.a === d.b && d.aStart < d.bEnd && d.bStart < d.aEnd))
      .filter((d) => includeTests || (!isTest(d.a) && !isTest(d.b)))
      // Longest block first. Unlike the old ranking this needs no invented
      // signal: jscpd already knows how much code is shared, contiguously.
      .sort((x, y) => y.tokens - x.tokens)
  } finally {
    await rm(out, { recursive: true, force: true })
  }
}

/**
 * Detection over normalized source — the product's actual path.
 *
 * `detect` alone finds only copies nobody edited. This builds a shadow tree
 * where every token is replaced by its class, runs jscpd over that, and returns
 * blocks addressed by the ORIGINAL paths and line numbers, because the shadow
 * preserves both.
 *
 * `extra` plants additional files into the shadow that are not in `root` — the
 * mechanism behind find_existing, which needs the candidate snippet compared
 * against the repository without ever writing it to the user's working tree.
 */
export async function detectNormalized(root, files, { minTokens = JSCPD_DEFAULT_MIN_TOKENS, includeTests = false, extra = [] } = {}) {
  const shadow = await mkdtemp(join(tmpdir(), 'seenit-shadow-'))
  try {
    const stats = await buildShadow(root, files, shadow)
    for (const { path, source } of extra) {
      const text = await normalizeSource(path, source)
      await writeFile(join(shadow, path), text ?? source)
    }
    const blocks = await detect([shadow], { minTokens, base: shadow, includeTests })
    return Object.assign(blocks, { shadow: stats })
  } finally {
    await rm(shadow, { recursive: true, force: true })
  }
}
