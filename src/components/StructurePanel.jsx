import { useEffect, useState } from 'react'
import { api } from '../lib/api'

// Architecture findings: cycles, hubs, and modules far from the main sequence.
//
// These are the extensibility signals a per-file linter cannot produce, because
// each one is a property of the graph rather than of any single file.

export function StructurePanel({ snapshotRef, live, dimensions }) {
  const [modules, setModules] = useState(null)
  const [coupling, setCoupling] = useState(null)

  useEffect(() => {
    if (!snapshotRef) return
    api.snapshotFile(snapshotRef, 'graph/modules.json').then(setModules).catch(() => setModules(null))
    api.snapshotFile(snapshotRef, 'coupling.json').then(setCoupling).catch(() => setCoupling(null))
  }, [snapshotRef])

  const ext = live ? dimensions?.extensibility : null
  const cycles = ext?.worstCycles ?? modules?.cycles ?? []
  const hubs = ext?.hubModules ?? []
  const offMainSeq = ext?.offMainSequence ?? []

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="modules" value={ext?.modules ?? modules?.modules?.length ?? '—'} />
        <Stat label="cycles" value={cycles.length} bad={cycles.length > 0} />
        <Stat label="hub modules" value={hubs.length} bad={hubs.length > 0} />
        <Stat label="main-seq distance" value={ext?.meanMainSequenceDistance ?? '—'} />
      </div>

      <Section
        title="Dependency cycles"
        note="Cycles block extraction and make modules impossible to reason about independently."
        empty="No cycles — modules form a clean DAG."
        items={cycles}
        render={(c, i) => (
          <div key={i} className="mono text-[11px] py-1">
            <span style={{ color: 'var(--h-bad)' }}>◍ </span>
            {c.members.join(' → ')}
            <span style={{ color: 'var(--dim)' }}> → ↺</span>
          </div>
        )}
      />

      <Section
        title="Hub modules"
        note="Depended on by many and depending on many — touching these touches everything."
        empty="No hubs."
        items={hubs}
        render={(h) => (
          <div key={h.path} className="flex justify-between mono text-[11px] py-1">
            <span>{h.path}</span>
            <span style={{ color: 'var(--dim)' }}>
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
          <div key={m.path} className="flex justify-between mono text-[11px] py-1">
            <span>{m.path}</span>
            <span style={{ color: 'var(--dim)' }}>
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
            <div key={i} className="flex justify-between mono text-[11px] py-1">
              <span>
                {h.a} <span style={{ color: 'var(--dim)' }}>↔</span> {h.b}
              </span>
              <span style={{ color: 'var(--h-ok)' }}>{(h.strength * 100).toFixed(0)}%</span>
            </div>
          )}
        />
      )}
    </div>
  )
}

const Stat = ({ label, value, bad }) => (
  <div className="panel p-3">
    <div className="label mb-1">{label}</div>
    <div className="mono text-xl" style={{ color: bad ? 'var(--h-bad)' : 'var(--text)' }}>
      {value}
    </div>
  </div>
)

function Section({ title, note, empty, items, render }) {
  return (
    <div className="panel p-4">
      <div className="label mb-1">{title}</div>
      <p className="text-[11px] mb-3" style={{ color: 'var(--dim)' }}>
        {note}
      </p>
      {items?.length ? (
        <div style={{ color: 'var(--muted)' }}>{items.map(render)}</div>
      ) : (
        <div className="text-[11px]" style={{ color: 'var(--h-good)' }}>
          {empty}
        </div>
      )}
    </div>
  )
}
