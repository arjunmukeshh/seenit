// Group duplicate pairs into findings.
//
// jscpd emits pairs: one file copied into six places produces fifteen. Union-find
// over the block graph, so files transitively linked by any duplicated region
// form a single finding.
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
    // Anchor on the largest region in the group.
    if (b.tokens > g.best.tokens) g.best = b
  }

  return [...groups.values()]
    .map((g) => ({
      ...g.best,
      pairs: g.pairs,
      fileCount: g.files.size,
      // Listed by name rather than counted.
      others: [...g.files].filter((f) => f !== g.best.a && f !== g.best.b).sort(),
    }))
    .sort((x, y) => y.tokens - x.tokens)
}
