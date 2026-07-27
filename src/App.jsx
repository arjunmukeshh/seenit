import { useEffect, useState } from 'react'
import { api, healthColor, fmt } from './lib/api'
import { CommitRail } from './components/CommitRail'
import { HealthPanel } from './components/HealthPanel'
import { Treemap } from './components/Treemap'
import { DriftView } from './components/DriftView'
import { StructurePanel } from './components/StructurePanel'
import { useElementWidth } from './lib/useElementWidth'

const TABS = ['health', 'structure', 'drift']

const dirtyCount = ({ changes }) => changes.added.length + changes.modified.length + changes.deleted.length

export default function App() {
  const [railRef, railWidth] = useElementWidth()
  const [repo, setRepo] = useState(null)
  const [snapshots, setSnapshots] = useState([])
  const [workspace, setWorkspace] = useState(null)
  const [tab, setTab] = useState('health')
  const [selected, setSelected] = useState(null) // null = working tree
  const [compareWith, setCompareWith] = useState(null)
  const [snapshotHealth, setSnapshotHealth] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    Promise.all([api.repo(), api.snapshots(200), api.workspace()])
      .then(([r, s, w]) => {
        setRepo(r)
        setSnapshots(s.snapshots)
        setWorkspace(w)
      })
      .catch((e) => setError(e.message))
  }, [])

  // Selecting a snapshot loads its stored health; the working tree uses the
  // live analysis instead.
  useEffect(() => {
    if (!selected) return setSnapshotHealth(null)
    api.snapshotFile(selected, 'health.json').then(setSnapshotHealth).catch(() => setSnapshotHealth(null))
  }, [selected])

  if (error) {
    return (
      <Centered>
        <div className="panel p-6 max-w-md">
          <div className="mb-2" style={{ color: 'var(--h-bad)' }}>Could not reach the API</div>
          <div className="mono text-xs" style={{ color: 'var(--muted)' }}>{error}</div>
        </div>
      </Centered>
    )
  }
  if (!repo || !workspace) return <Centered><span style={{ color: 'var(--dim)' }}>Loading…</span></Centered>

  const viewing = selected ? snapshotHealth : workspace
  const previous = selected
    ? null
    : snapshots.length
      ? { overall: snapshots[0].health, dimensions: {} }
      : null

  return (
    <div className="h-full flex flex-col">
      <Header repo={repo} workspace={workspace} />

      <div className="flex-1 flex min-h-0">
        <Rail
          ref={railRef}
          width={railWidth}
          workspace={workspace}
          snapshots={snapshots}
          selected={selected}
          compareWith={compareWith}
          onSelect={setSelected}
          onCompare={setCompareWith}
        />

        <main className="flex-1 overflow-y-auto min-w-0">
          <TabBar tab={tab} onTab={setTab} selected={selected} />
          <div className="px-5 pb-8">
            <TabBody
              tab={tab}
              viewing={viewing}
              previous={previous}
              selected={selected}
              workspace={workspace}
              snapshots={snapshots}
              compareWith={compareWith}
            />
          </div>
        </main>
      </div>
    </div>
  )
}

// Time axis. Width steps down on narrower panes; the rail measures its own box
// and drops columns rather than overflowing, since SVG text cannot reflow.
function Rail({ ref, width, workspace, snapshots, selected, compareWith, onSelect, onCompare }) {
  return (
    <aside
      ref={ref}
      className="w-[248px] lg:w-[330px] 2xl:w-[430px] shrink-0 border-r overflow-y-auto"
      style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}
    >
      <WorkingTreeRow workspace={workspace} active={selected === null} onClick={() => onSelect(null)} />
      <div className="label px-4 py-2" style={{ borderTop: '1px solid var(--border)' }}>
        History · {snapshots.length} snapshots
      </div>
      <CommitRail
        snapshots={snapshots}
        selected={selected}
        compareWith={compareWith}
        onSelect={onSelect}
        onCompare={onCompare}
        width={width}
      />
    </aside>
  )
}

function TabBar({ tab, onTab, selected }) {
  return (
    <nav className="flex gap-1 px-5 pt-4 pb-3 sticky top-0 z-10" style={{ background: 'var(--bg)' }}>
      {TABS.map((t) => (
        <button
          key={t}
          onClick={() => onTab(t)}
          className="px-3 py-1.5 rounded text-xs capitalize transition-colors"
          style={{
            background: tab === t ? 'var(--panel-2)' : 'transparent',
            color: tab === t ? 'var(--text)' : 'var(--dim)',
          }}
        >
          {t}
        </button>
      ))}
      <div className="ml-auto mono text-[11px] self-center" style={{ color: 'var(--dim)' }}>
        {selected ? `snapshot ${selected.slice(0, 7)}` : 'working tree'}
      </div>
    </nav>
  )
}

// One body per tab. Kept out of App so that adding a tab does not push a single
// render function further past the complexity threshold the tool itself reports.
function TabBody({ tab, viewing, previous, selected, workspace, snapshots, compareWith }) {
  if (tab === 'health') {
    if (!viewing) return <Loading />
    return (
      <HealthPanel
        health={viewing.overall ?? viewing.health}
        dimensions={viewing.dimensions}
        previous={previous}
        weights={viewing.weights}
      />
    )
  }

  if (tab === 'structure') {
    if (selected) return <StructurePanel snapshotRef={selected} />
    return (
      <div className="space-y-3">
        <div className="panel p-3">
          <div className="label mb-2">
            {workspace.files.length} files · area is lines of code, colour is a per-file complexity proxy
          </div>
          <Treemap files={workspace.files} />
        </div>
        <StructurePanel live dimensions={workspace.dimensions} />
      </div>
    )
  }

  return <DriftView from={compareWith ?? snapshots[1]?.sha} to={selected ?? snapshots[0]?.sha} />
}

function Header({ repo, workspace }) {
  const dirty = dirtyCount(workspace)

  return (
    <header
      className="flex items-center gap-4 px-5 py-3 border-b shrink-0"
      style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}
    >
      <div className="flex items-baseline gap-2">
        <span className="font-semibold">gitcodebase</span>
        <span className="mono text-xs" style={{ color: 'var(--dim)' }}>
          {repo.name}
        </span>
      </div>

      <span className="mono text-[11px] px-2 py-0.5 rounded" style={{ background: 'var(--panel-2)', color: 'var(--muted)' }}>
        {repo.branch}
      </span>

      {dirty > 0 && (
        <span className="mono text-[11px]" style={{ color: 'var(--h-ok)' }}>
          {dirty} uncommitted
        </span>
      )}

      <div className="ml-auto flex items-baseline gap-2">
        <span className="label">health</span>
        <span className="mono text-xl font-semibold" style={{ color: healthColor(workspace.health) }}>
          {fmt(workspace.health)}
        </span>
      </div>
    </header>
  )
}

// The working tree sits above the rail rather than in it — it is not a snapshot
// and pretending otherwise would put uncommitted state into the history.
function WorkingTreeRow({ workspace, active, onClick }) {
  const dirty = dirtyCount(workspace)
  return (
    <button
      onClick={onClick}
      className="w-full text-left px-4 py-3 flex items-center gap-3 transition-colors"
      style={{ background: active ? 'rgba(110,168,254,0.10)' : 'transparent' }}
    >
      <span
        className="w-2.5 h-2.5 rounded-full shrink-0"
        style={{
          background: healthColor(workspace.health),
          outline: dirty ? '2px dashed var(--h-ok)' : 'none',
          outlineOffset: '2px',
        }}
      />
      <div className="min-w-0">
        <div className="text-xs">Working tree</div>
        <div className="mono text-[10px]" style={{ color: 'var(--dim)' }}>
          {dirty ? `${dirty} uncommitted change${dirty === 1 ? '' : 's'}` : 'clean'}
        </div>
      </div>
      <span className="mono ml-auto font-semibold" style={{ color: healthColor(workspace.health) }}>
        {fmt(workspace.health)}
      </span>
    </button>
  )
}

const Centered = ({ children }) => (
  <div className="h-full flex items-center justify-center">{children}</div>
)
const Loading = () => <div className="panel p-8 text-center text-xs" style={{ color: 'var(--dim)' }}>Loading…</div>
