// tree-sitter loading and the language registry.
//
// Dependency note: the grammars come from @vscode/tree-sitter-wasm, NOT the more
// obvious `tree-sitter-wasms` package — that one was built against tree-sitter
// CLI 0.20 and throws a dylink ABI error when loaded by web-tree-sitter 0.26.
// The pair below is verified working on Node 22. Do not "upgrade" to
// tree-sitter-wasms; it will not load.

import { Parser, Language } from 'web-tree-sitter'
import { createRequire } from 'node:module'
import { dirname, join, extname, basename } from 'node:path'

const require = createRequire(import.meta.url)

function wasmDir() {
  return join(dirname(require.resolve('@vscode/tree-sitter-wasm/package.json')), 'wasm')
}

// extension -> grammar name. Kept deliberately small and explicit; adding a
// language is one line here plus the grammar shipping in the wasm package.
const BY_EXT = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'tsx',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.cs': 'c-sharp',
  '.rb': 'ruby',
  '.php': 'php',
  // @vscode/tree-sitter-wasm ships no dedicated C grammar, and the cpp grammar
  // parses C well enough for structural metrics. Mapping these to 'c' silently
  // broke every scan of a repository containing a .c file — see the grammar
  // coverage test in test/parser.test.js, which now makes that unrepresentable.
  '.c': 'cpp',
  '.h': 'cpp',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.hpp': 'cpp',
  '.css': 'css',
  '.sh': 'bash',
  '.bash': 'bash',
}

// Files we never analyze: generated, vendored, or not source at all. Analyzing
// these would swamp the health score with code the user did not write.
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'vendor', 'third_party', 'coverage',
  '.next', '.nuxt', '.svelte-kit', '.venv', 'venv', '__pycache__', 'target',
  'Pods', 'DerivedData', '.git', 'bower_components', 'jspm_packages',
])

const SKIP_FILE_RE = /(\.min\.(js|css)|\.bundle\.js|\.generated\.[a-z]+|\.pb\.go|_pb2\.py|\.d\.ts)$/i

export function languageFor(path) {
  return BY_EXT[extname(path).toLowerCase()] ?? null
}

export function isAnalyzable(path) {
  if (SKIP_FILE_RE.test(path)) return false
  for (const part of path.split('/')) {
    if (SKIP_DIRS.has(part)) return false
  }
  return languageFor(path) !== null
}

// Test files are analyzed but scored separately — test code legitimately has
// different characteristics (repetition is fine, complexity should be low).
const TEST_RE = /(^|\/)(__tests__|tests?|spec)(\/|$)|\.(test|spec)\.[a-z]+$|_test\.[a-z]+$/i

export function isTestFile(path) {
  return TEST_RE.test(path)
}

let initialized = null
const grammars = new Map()

async function ensureInit() {
  if (!initialized) initialized = Parser.init()
  return initialized
}

async function loadGrammar(name) {
  if (grammars.has(name)) return grammars.get(name)
  const promise = Language.load(join(wasmDir(), `tree-sitter-${name}.wasm`)).catch((err) => {
    grammars.delete(name)
    throw new Error(`grammar "${name}" failed to load: ${err.message}`)
  })
  grammars.set(name, promise)
  return promise
}

// A pooled parser. tree-sitter parsers are stateful and not reentrant, so we
// keep one per language rather than one global that we keep re-pointing.
const parsers = new Map()

export async function parserFor(language) {
  await ensureInit()
  if (parsers.has(language)) return parsers.get(language)
  const parser = new Parser()
  parser.setLanguage(await loadGrammar(language))
  parsers.set(language, parser)
  return parser
}

// Parse source text. Returns null for unsupported languages. Callers MUST call
// tree.delete() — these are WASM allocations and will leak otherwise.
//
// A grammar that fails to load degrades to "this file is unsupported" rather
// than throwing. One missing grammar should cost you one file, not the entire
// scan — which is exactly what happened before: four repositories in the
// calibration corpus aborted completely because of a single unmapped extension.
export async function parse(path, source) {
  const language = languageFor(path)
  if (!language) return null
  let parser
  try {
    parser = await parserFor(language)
  } catch {
    return null
  }
  // tree-sitter has a hard limit on source size; skip absurd files rather than
  // crashing the whole scan on one generated blob that escaped the filters.
  if (source.length > 2_000_000) return null
  const tree = parser.parse(source)
  return tree ? { tree, language } : null
}

export const LANGUAGES = [...new Set(Object.values(BY_EXT))].sort()
export { basename }
