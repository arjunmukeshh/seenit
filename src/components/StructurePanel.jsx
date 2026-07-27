import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { DependencyGraph, FOLD_ABOVE } from './DependencyGraph'
import { foldToDirectories } from '../../lib/analyze/dag.js'

// Architecture findings: cycles, hubs, and modules far from the main sequence.
//
// These are the extensibility signals a per-file linter cannot produce, because
// each one is a property of the graph rather than of any single file.

export function StructurePanel({ snapshotRef, live, dimensions, dag: liveDag }) {
  const [modules, setModules] = useState(null)
  const [coupling, setCoupling] = useState(null)
  const [snapshotDag, setSnapshotDag] = useState(null)
  const [fold, setFold] = useState(null) // null = decide from size

  useEffect(() => {
    if (!snapshotRef) return
    setSnapshotDag(null)
    api.snapshotFile(snapshotRef, 'graph/modules.json').then(setModules).catch(() => setModules(null))
    api.snapshotFile(snapshotRef, 'coupling.json').then(setCoupling).catch(() => setCoupling(null))
    // Snapshots taken before the DAG was stored simply don't have this file;
    // the graph section says so rather than rendering an empty box.
    api.snapshotFile(snapshotRef, 'graph/dag.json').then(setSnapshotDag).catch(() => setSnapshotDag(null))
  }, [snapshotRef])

  const ext = live ? dimensions?.extensibility : null
  const cycles = ext?.worstCycles ?? modules?.cycles ?? []
  const hubs = ext?.hubModules ?? []
  const offMainSeq = ext?.offMainSequence ?? []

  const baseDag = live ? liveDag : snapshotDag
  // Fold automatically when a file-level graph would be unreadable, but let the
  // choice be overridden — the auto default is a guess about screen space, not
  // about what the reader wants.
  const folded = fold ?? (baseDag ? baseDag.nodes.length > FOLD_ABOVE : false)
  const shownDag = useMemo(
    () => (baseDag && folded ? foldToDirectories(baseDag) : baseDag),
    [baseDag, folded],
  )

  return (
    <div className="space-y-10">
      <section>
        <h2 className="label mb-3">Architecture</h2>
        <dl className="flex flex-wrap gap-x-10 gap-y-4">
          <Stat label="modules" value={ext?.modules ?? modules?.modules?.length ?? '—'} />
          <Stat label="cycles" value={cycles.length} bad={cycles.length > 0} />
          <Stat label="hub modules" value={hubs.length} bad={hubs.length > 0} />
          <Stat label="mean main-seq distance" value={ext?.meanMainSequenceDistance ?? '—'} />
        </dl>
      </section>

      <section>
        <h2 className="text-[13.5px] mb-1" style={{ color: 'var(--ink)' }}>
          Module DAG
        </h2>
        <p className="text-[12px] mb-3 max-w-[68ch] text-pretty" style={{ color: 'var(--ink-3)' }}>
          Every strongly-connected component is collapsed into one node, which makes the graph
          provably acyclic and therefore layerable. Layers read upward from foundations: layer 0
          depends on nothing internal, so depth is the build order of the codebase. A cycle is drawn
          as a single box because that is what it is to maintain — you cannot extract one member
          without the rest.
        </p>
        {shownDag ? (
          <DependencyGraph
            dag={shownDag}
            folded={folded}
            onToggleFold={() => setFold(!folded)}
          />
        ) : (
          <p className="text-[12px]" style={{ color: 'var(--ink-3)' }}>
            {snapshotRef
              ? 'This snapshot predates the stored dependency graph. Re-run gitcodebase backfill to add it.'
              : 'Loading…'}
          </p>
        )}
      </section>

      <Section
        title="Dependency cycles"
        note="Cycles block extraction and make modules impossible to reason about independently."
        empty="No cycles — modules form a clean DAG."
        items={cycles}
        render={(c, i) => (
          <div key={i} className="mono text-[11.5px] py-1.5" style={{ borderBottom: '1px solid var(--rule)' }}>
            <span style={{ color: 'var(--h-bad)' }}>◍ </span>
            {c.members.join(' → ')}
            <span style={{ color: 'var(--ink-4)' }}> → ↺</span>
          </div>
        )}
      />

      <Section
        title="Hub modules"
        note="Depended on by many and depending on many — touching these touches everything."
        empty="No hubs."
        items={hubs}
        render={(h) => (
          <div key={h.path} className="flex justify-between gap-4 mono text-[11.5px] py-1.5" style={{ borderBottom: '1px solid var(--rule)' }}>
            <span>{h.path}</span>
            <span style={{ color: 'var(--ink-4)' }}>
              in {h.fanIn} · out {h.fanOut}
            </span>
          </div>
        )}
      />

      <Section
        title="Furthest from the main sequence"
        note="Martin's D = |A + I − 1|. High means either rigid (concrete and depended upon) or useless (abstract and unused)."
        empty="—"
        items={offMainSeq.slice(0, 8)}
        render={(m) => (
          <div key={m.path} className="flex justify-between gap-4 mono text-[11.5px] py-1.5" style={{ borderBottom: '1px solid var(--rule)' }}>
            <span>{m.path}</span>
            <span style={{ color: 'var(--ink-4)' }}>
              I={m.instability} A={m.abstractness} D={m.distance}
            </span>
          </div>
        )}
      />

      {coupling?.hidden?.length > 0 && (
        <Section
          title="Hidden coupling"
          note="These files change together in history but have no import between them — coupling static analysis cannot see."
          empty=""
          items={coupling.hidden.slice(0, 8)}
          render={(h, i) => (
            <div key={i} className="flex justify-between gap-4 mono text-[11.5px] py-1.5" style={{ borderBottom: '1px solid var(--rule)' }}>
              <span>
                {h.a} <span style={{ color: 'var(--ink-4)' }}>↔</span> {h.b}
              </span>
              <span style={{ color: 'var(--h-ok)' }}>{(h.strength * 100).toFixed(0)}%</span>
            </div>
          )}
        />
      )}
    </div>
  )
}

// A figure and its label, not a card.
//
// These were four equal boxes in a row — the single most generic layout in any
// generated dashboard, and unjustified here: "cycles: 0" and "modules: 40" are
// two words and two digits, and wrapping each in a bordered panel gave them the
// visual weight of a section heading.
const Stat = ({ label, value, bad }) => (
  <div>
    <dt className="label mb-1.5">{label}</dt>
    <dd className="readout text-[26px]" style={{ color: bad ? 'var(--h-bad)' : 'var(--ink)' }}>
      {value}
    </dd>
  </div>
)

function Section({ title, note, empty, items, render }) {
  return (
    <section>
      <h2 className="text-[13.5px] mb-1" style={{ color: 'var(--ink)' }}>
        {title}
      </h2>
      <p className="text-[12px] mb-3 max-w-[68ch] text-pretty" style={{ color: 'var(--ink-3)' }}>
        {note}
      </p>
      {items?.length ? (
        <div style={{ color: 'var(--ink-2)', borderTop: '1px solid var(--rule)' }}>
          {items.map(render)}
        </div>
      ) : (
        // A clean result is a finding, not an absence. Saying so in plain words
        // beats an empty region that reads as "failed to load".
        <p className="text-[12px]" style={{ color: 'var(--h-good)' }}>
          {empty}
        </p>
      )}
    </section>
  )
}
