// Watch mode — continuous background review.
//
// This is the tweet's "continuously review changes in the background", and the
// surface that matters most during a session: the agent writes, you see within
// a second or two whether the codebase got better or worse. Nothing to
// remember, nothing to open.
//
// Deliberately does NOT write to the ledger. Uncommitted work is not history,
// and snapshotting every keystroke would fill the ledger with states that never
// existed as commits. Watch compares the working tree against the last snapshot;
// `scan` is what promotes a state into history.

import { watch as fsWatch } from 'node:fs'
import { join } from 'node:path'
import { analyzeWorkspace } from './analyze/index.js'
import { workingChanges } from './workspace.js'
import { listSnapshots, readSnapshotFile } from './ledger.js'
import { isAnalyzable } from './analyze/parser.js'

const DEBOUNCE_MS = 400

// Directories never worth watching. Without this, node_modules alone generates
// enough events to keep the debounce timer permanently reset.
const IGNORED = /(^|\/)(\.git|node_modules|dist|build|coverage|\.next|target|__pycache__|\.venv)(\/|$)/

export function watchRepo(root, { ledger, cache, onResult, onError, debounce = DEBOUNCE_MS } = {}) {
  let timer = null
  let running = false
  let queued = false
  let closed = false

  async function lastSnapshotHealth() {
    if (!ledger) return null
    const snaps = await listSnapshots(ledger, { limit: 1 }).catch(() => [])
    if (!snaps.length) return null
    return readSnapshotFile(ledger, snaps[0].sha, 'health.json').catch(() => null)
  }

  async function analyze() {
    if (closed) return
    if (running) {
      // A change landed mid-analysis; the result is already stale, so remember
      // to run once more rather than queueing an unbounded number of passes.
      queued = true
      return
    }
    running = true
    try {
      const [result, changes, previous] = await Promise.all([
        analyzeWorkspace(root, { cache }),
        workingChanges(root),
        lastSnapshotHealth(),
      ])
      await cache?.flush()
      onResult?.({ ...result, changes, previous, at: new Date() })
    } catch (err) {
      onError?.(err)
    } finally {
      running = false
      if (queued) {
        queued = false
        schedule()
      }
    }
  }

  function schedule() {
    clearTimeout(timer)
    timer = setTimeout(analyze, debounce)
  }

  // Recursive watch is supported on macOS and Windows. On Linux it is not, and
  // node falls back to non-recursive — a known limitation rather than a silent
  // failure, so it is surfaced to the caller.
  let watcher
  try {
    watcher = fsWatch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return
      const path = filename.toString()
      if (IGNORED.test(path)) return
      if (!isAnalyzable(path)) return
      schedule()
    })
  } catch (err) {
    onError?.(new Error(`cannot watch ${root}: ${err.message}`))
    return { close: () => {} }
  }

  watcher.on('error', (err) => onError?.(err))

  // Run once immediately so the first reading doesn't wait for an edit.
  analyze()

  return {
    close() {
      closed = true
      clearTimeout(timer)
      watcher.close()
    },
  }
}

// The one-line verdict used by the CLI and the Claude Code hook. Kept to a
// single line on purpose: it is printed after every agent turn, and anything
// longer becomes noise the user learns to ignore.
export function verdict(result, previousHealth) {
  const parts = []
  const health = result.health
  const delta = previousHealth != null && health != null ? health - previousHealth : null

  parts.push(`health ${health?.toFixed(1) ?? '—'}`)
  if (delta !== null && Math.abs(delta) >= 0.05) {
    parts.push(delta > 0 ? `▲ +${delta.toFixed(1)}` : `▼ ${delta.toFixed(1)}`)
  }

  const changed = result.changes
    ? result.changes.added.length + result.changes.modified.length + result.changes.deleted.length
    : 0
  if (changed) parts.push(`${changed} file${changed === 1 ? '' : 's'} changed`)

  // Surface the single most actionable finding rather than a list.
  const dup = result.dimensions?.duplication
  const ext = result.dimensions?.extensibility
  if (dup?.worstPairs?.length) {
    const p = dup.worstPairs[0]
    parts.push(`dup: ${short(p.a)} ↔ ${short(p.b)}`)
  } else if (ext?.cycles > 0) {
    parts.push(`${ext.cycles} dependency cycle${ext.cycles === 1 ? '' : 's'}`)
  }

  return parts.join('  ')
}

const short = (p) => p.slice(p.lastIndexOf('/') + 1)
