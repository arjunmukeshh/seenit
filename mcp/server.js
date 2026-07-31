// MCP server: find_existing and check_duplication.
//
// Tool definitions are permanent context, so the surface stays at two tools and
// 247 tokens, and results are paths and line ranges with no prose.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { repoRoot, trackedFiles } from '../lib/git.js'
import { findExisting, guessLanguage } from '../lib/find.js'
import { detectNormalized } from '../lib/jscpd.js'
import { clusterBlocks } from '../lib/cluster.js'

const TOOLS = [
  {
    name: 'find_existing',
    description:
      'Before writing a new function, helper or component, paste it here to check whether the ' +
      'codebase already contains it. Matches through renames, reformatting and comment changes, ' +
      'so a copy sharing no identifier with the original is still found. ' +
      'Returns file paths with exact line ranges, or nothing when the code is genuinely new.',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'The code you are about to write. A whole function or block works best.',
        },
        path: {
          type: 'string',
          description: 'Where you intend to write it, if known. Only used to pick the language.',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'check_duplication',
    description:
      'List near-duplicate regions already in the repository, largest first. ' +
      'Use when asked to clean up or refactor; use find_existing before writing instead.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum findings to return. Default 10.' },
      },
    },
  },
]

let root = null
const repo = async () => (root ??= await repoRoot(process.env.SEENIT_REPO || process.cwd()))

// A location an agent can act on: path plus line range.
const at = (file, start, end) => `${file}:${start}-${end}`

const handlers = {
  async find_existing({ code, path }) {
    if (!code || code.trim().length < 20) {
      return 'Nothing to check — pass the code you are about to write.'
    }
    const hits = await findExisting(await repo(), code, { language: guessLanguage(code, path) })
    if (!hits.length) return 'No existing implementation. Safe to write.'

    return [
      `Already present in ${hits.length} place(s) — reuse instead of rewriting:`,
      ...hits.map((h) => `  ${at(h.file, h.startLine, h.endLine)}  (${h.lines} lines shared)`),
    ].join('\n')
  },

  async check_duplication({ limit = 10 }) {
    const dir = await repo()
    const blocks = await detectNormalized(dir, await trackedFiles(dir))
    if (!blocks.length) return 'No duplication above the threshold.'

    const groups = clusterBlocks(blocks)
    return [
      `${groups.length} duplicated region(s):`,
      ...groups
        .slice(0, limit)
        .map(
          (g) =>
            `  ${at(g.a, g.aStart, g.aEnd)}  =  ${at(g.b, g.bStart, g.bEnd)}` +
            `  (${g.lines} lines${g.others.length ? `, +${g.others.length} more files` : ''})`,
        ),
    ].join('\n')
  },
}

export async function startServer() {
  const server = new Server({ name: 'seenit', version: '0.2.0' }, { capabilities: { tools: {} } })

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const handler = handlers[request.params.name]
    if (!handler) {
      return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }], isError: true }
    }
    try {
      const text = await handler(request.params.arguments ?? {})
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      // Never crash the server on one bad call — the agent should see the error
      // and be able to continue.
      return { content: [{ type: 'text', text: `seenit error: ${err.message}` }], isError: true }
    }
  })

  await server.connect(new StdioServerTransport())
}
