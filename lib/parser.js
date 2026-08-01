// tree-sitter loading and the language registry.
//
// Grammars come from @vscode/tree-sitter-wasm, not `tree-sitter-wasms`. The
// latter was built against tree-sitter CLI 0.20 and throws a dylink ABI error
// under web-tree-sitter 0.26.

import { Parser, Language } from 'web-tree-sitter'
import { createRequire } from 'node:module'
import { dirname, join, extname } from 'node:path'

const require = createRequire(import.meta.url)

function wasmDir() {
  return join(dirname(require.resolve('@vscode/tree-sitter-wasm/package.json')), 'wasm')
}

// extension -> grammar name. Adding a language is one line here, provided the
// grammar ships in the wasm package.
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
  // No dedicated C grammar ships; cpp parses C. Mapping these to 'c' breaks
  // every scan of a repository containing a .c file — see test/parser.test.js.
  '.c': 'cpp',
  '.h': 'cpp',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.hpp': 'cpp',
  '.css': 'css',
  '.sh': 'bash',
  '.bash': 'bash',
}

export function languageFor(path) {
  return BY_EXT[extname(path).toLowerCase()] ?? null
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

// tree-sitter parsers are stateful and not reentrant, so keep one per language.
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
// tree.delete(); these are WASM allocations and leak otherwise.
//
// A grammar that fails to load returns null rather than throwing, so one missing
// grammar costs one file instead of the whole scan.
export async function parse(path, source) {
  const language = languageFor(path)
  if (!language) return null
  let parser
  try {
    parser = await parserFor(language)
  } catch {
    return null
  }
  // tree-sitter has a hard source-size limit; skip oversized files.
  if (source.length > 2_000_000) return null
  const tree = parser.parse(source)
  return tree ? { tree, language } : null
}

export const LANGUAGES = [...new Set(Object.values(BY_EXT))].sort()
