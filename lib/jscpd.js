// jscpd wrapper: spawn the binary, normalise its JSON into blocks with
// contiguous start/end line ranges. detectNormalized, at the bottom, is the
// entry point the CLI and MCP server use.

import { execFile as execFileCb } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import { promisify } from 'node:util'

import { buildShadow, normalizeSource } from './normalize.js'

const execFile = promisify(execFileCb)
const require = createRequire(import.meta.url)

// jscpd's own default. The recall study found the bar has little effect until
// statements are reordered, so it is left as-is.
export const JSCPD_DEFAULT_MIN_TOKENS = 30

// Not source. jscpd honours .gitignore, but build output is often committed,
// and .git is scanned otherwise — git's sample hooks match each other.
const IGNORE = [
  '**/.git/**',
  '**/node_modules/**', '**/dist/**', '**/build/**', '**/out/**', '**/vendor/**',
  '**/third_party/**', '**/coverage/**', '**/.next/**', '**/_next/**', '**/.nuxt/**',
  '**/.svelte-kit/**', '**/.venv/**', '**/venv/**', '**/__pycache__/**', '**/target/**',
  '**/Pods/**', '**/DerivedData/**', '**/bower_components/**', '**/jspm_packages/**',
  '**/__generated__/**', '**/generated/**', '**/autogen/**',
  '**/*.min.js', '**/*.min.css', '**/*.bundle.js', '**/*.d.ts',
  '**/*.generated.*', '**/*.pb.go', '**/*_pb2.py',
  // Data and prose. jscpd covers markdown and JSON, which here surfaces repeated
  // headings and similar result files.
  '**/*.json', '**/*.lock', '**/*.snap',
  '**/*.md', '**/*.mdx', '**/*.txt', '**/*.rst', '**/*.csv', '**/*.svg',
]

const TEST_RE = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|_test\.[a-z]+$/i

export const isTest = (path) => TEST_RE.test(path)

// Resolve the bundled binary rather than PATH, so a globally installed jscpd of
// another version cannot change the results.
function binary() {
  try {
    return require.resolve('jscpd/run-jscpd.js')
  } catch {
    throw new Error('jscpd is not installed — it is a dependency of seenit, so this is a broken install')
  }
}

/**
 * Run jscpd over one or more roots. Paths come back relative to `base`.
 *
 * `--absolute` is required: jscpd otherwise names files relative to whichever
 * scanned root they sit under, so two roots produce ambiguous, colliding paths.
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
      // .ts and .js are different formats to jscpd and are not compared without
      // this, so a TypeScript original never matches a JavaScript copy.
      '--cross-formats', 'js-ts',
      '--no-colors',
      '--silent',
    ]
    try {
      await execFile(binary(), args, { maxBuffer: 1 << 26 })
    } catch (err) {
      // jscpd exits non-zero on --threshold breaches as well as real failures.
      // The report file is the source of truth.
      if (!err.code && !err.stdout) throw err
    }

    let report
    try {
      report = JSON.parse(await readFile(join(out, 'jscpd-report.json'), 'utf8'))
    } catch {
      return [] // no duplicates found writes no report on some paths
    }

    // Embedded blocks get their format appended: "notes.md:markdown". Strip only
    // that exact suffix so paths containing a colon survive.
    const clean = (name, format) => (name.endsWith(`:${format}`) ? name.slice(0, -(format.length + 1)) : name)

    // Resolve symlinks on both sides. jscpd reports real paths, and os.tmpdir()
    // is a symlink on macOS — without this every path came back as
    // "../../../private/var/..." and nothing compared equal.
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
      // Self-matches at overlapping ranges are jscpd artifacts for embedded
      // sub-blocks. Intra-file duplication at distinct ranges is a real finding.
      .filter((d) => !(d.a === d.b && d.aStart < d.bEnd && d.bStart < d.aEnd))
      .filter((d) => includeTests || (!isTest(d.a) && !isTest(d.b)))
      // Longest block first.
      .sort((x, y) => y.tokens - x.tokens)
  } finally {
    await rm(out, { recursive: true, force: true })
  }
}

/**
 * Detection over normalised source. `detect` alone matches only unedited copies.
 *
 * Blocks are addressed by original paths and line numbers. `extra` plants files
 * that are not in `root`, which is how find_existing compares a candidate
 * without writing it to disk.
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
