// Thin wrapper around the git CLI. seenit uses git only to find the repository
// root and the tracked file list.

import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)
const MAX_BUFFER = 256 * 1024 * 1024 // some repos have big trees; don't truncate

async function git(cwd, args) {
  const { stdout } = await execFile('git', args, { cwd, maxBuffer: MAX_BUFFER })
  return stdout.trim()
}

export async function isRepo(cwd) {
  try {
    return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])) === 'true'
  } catch {
    return false
  }
}

export async function repoRoot(cwd) {
  return git(cwd, ['rev-parse', '--show-toplevel'])
}

// Tracked files only — otherwise an untracked node_modules gets normalized and
// scanned, which is slow and finds nothing useful.
export async function trackedFiles(root) {
  const { stdout } = await execFile('git', ['-C', root, 'ls-files'], { maxBuffer: MAX_BUFFER })
  return stdout.split('\n').filter(Boolean)
}
