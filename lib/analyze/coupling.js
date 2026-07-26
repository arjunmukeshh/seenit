// Change coupling — files that keep changing together.
//
// Static imports show intended structure; git history shows actual structure.
// Two files with no import between them that nevertheless change in the same
// commit 90% of the time are coupled, and that coupling is invisible to every
// static analyzer. Being git-native means this costs one `git log` call.
//
// This is the signal that most often explains "why is this codebase hard to
// change" when every static metric looks fine.

import { tryGit } from '../git.js'
import { round, sortedBy } from '../canonical.js'

const MAX_COMMITS = 500 // recent history; older coupling reflects a dead design
const MAX_FILES_PER_COMMIT = 30 // sweeping refactors couple everything to everything
const MIN_SHARED_CHANGES = 4 // below this, co-change is coincidence

export async function analyzeCoupling(repoRoot, ref = 'HEAD', { analyzable } = {}) {
  const out = await tryGit(repoRoot, [
    'log',
    `--max-count=${MAX_COMMITS}`,
    '--name-only',
    '--no-merges', // merges touch everything and would swamp the signal
    '--format=%x1e',
    ref,
  ])
  if (!out) return { pairs: [], commitsAnalyzed: 0 }

  const commits = out
    .split('\x1e')
    .map((block) => block.split('\n').map((l) => l.trim()).filter(Boolean))
    .filter((files) => files.length > 1 && files.length <= MAX_FILES_PER_COMMIT)

  const changeCount = new Map()
  const pairCount = new Map()

  for (const files of commits) {
    const relevant = analyzable ? files.filter((f) => analyzable.has(f)) : files
    if (relevant.length < 2) continue
    const unique = [...new Set(relevant)].sort()
    for (const f of unique) changeCount.set(f, (changeCount.get(f) ?? 0) + 1)
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const key = `${unique[i]}\x00${unique[j]}`
        pairCount.set(key, (pairCount.get(key) ?? 0) + 1)
      }
    }
  }

  const pairs = []
  for (const [key, shared] of pairCount) {
    if (shared < MIN_SHARED_CHANGES) continue
    const [a, b] = key.split('\x00')
    // Degree of coupling: of the times either file changed, how often did both?
    const union = changeCount.get(a) + changeCount.get(b) - shared
    const strength = union ? shared / union : 0
    if (strength < 0.4) continue
    pairs.push({
      a,
      b,
      sharedChanges: shared,
      changesA: changeCount.get(a),
      changesB: changeCount.get(b),
      strength: round(strength),
    })
  }

  return {
    commitsAnalyzed: commits.length,
    pairs: sortedBy(pairs, 'strength').reverse().slice(0, 50),
  }
}

// Coupled pairs with no import relationship between them — the hidden coupling
// that static analysis cannot see, and the most actionable output here.
export function hiddenCoupling(pairs, graphNodes) {
  return pairs.filter(({ a, b }) => {
    const na = graphNodes.get(a)
    const nb = graphNodes.get(b)
    if (!na || !nb) return false
    return !na.dependencies.has(b) && !nb.dependencies.has(a)
  })
}
