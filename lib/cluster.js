// Findings, not pairs.
//
// This survived the engine swap unchanged in spirit, because it was never about
// the engine. jscpd emits pairs; one file copied into six places is fifteen
// pairs of a single fact, and a list of fifteen reads as a wall no matter how
// precise each row is. On vite the old engine produced 468 pairs and 55
// findings, almost entirely because one style.css had been copied across 22
// create-vite templates.
//
// Grouping is orchestration's job, not the detector's — which is exactly why it
// stays here now that the detector is somebody else's.

// Union-find over the block graph: files transitively linked by any duplicated
// region belong to one finding.
export function clusterBlocks(blocks) {
  const parent = new Map()
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x))) // path halving
      x = parent.get(x)
    }
    return x
  }
  const union = (x, y) => {
    for (const v of [x, y]) if (!parent.has(v)) parent.set(v, v)
    const [rx, ry] = [find(x), find(y)]
    if (rx !== ry) parent.set(rx, ry)
  }
  for (const b of blocks) union(b.a, b.b)

  const groups = new Map()
  for (const b of blocks) {
    const key = find(b.a)
    let g = groups.get(key)
    if (!g) groups.set(key, (g = { files: new Set(), pairs: 0, best: b }))
    g.files.add(b.a)
    g.files.add(b.b)
    g.pairs++
    // The anchor is the largest region in the group — the pair worth showing,
    // and the one whose line ranges a reader should open first.
    if (b.tokens > g.best.tokens) g.best = b
  }

  return [...groups.values()]
    .map((g) => ({
      ...g.best,
      pairs: g.pairs,
      fileCount: g.files.size,
      // Named, not counted. "and 20 more files" is a statistic; the reader wants
      // to know which ones.
      others: [...g.files].filter((f) => f !== g.best.a && f !== g.best.b).sort(),
    }))
    .sort((x, y) => y.tokens - x.tokens)
}
