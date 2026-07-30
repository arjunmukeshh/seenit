import { useEffect, useState } from 'react'
import { api, healthColor, fmt } from './lib/api'
import { CommitRail } from './components/CommitRail'
import { HealthPanel } from './components/HealthPanel'
import { Treemap } from './components/Treemap'
import { DriftView } from './components/DriftView'
import { StructurePanel } from './components/StructurePanel'
import { DuplicateList } from './components/DuplicateList'
import { useElementWidth } from './lib/useElementWidth'
import { useTheme } from './lib/useTheme'

const TABS = ['duplicates', 'health', 'structure', 'drift']

// The open tab lives in the URL hash so a view can be linked to — "look at the
// cycle in the structure graph" is a thing people send each other, and it also
// makes the tabs addressable to a screenshot script that cannot click.
const tabFromHash = () => {
  const t = window.location.hash.slice(1)
  return TABS.includes(t) ? t : TABS[0]
}

const dirtyCount = ({ changes }) => changes.added.length + changes.modified.length + changes.deleted.length

export default function App() {
  const [railRef, railWidth] = useElementWidth()
  const [repo, setRepo] = useState(null)
  const [snapshots, setSnapshots] = useState([])
  const [workspace, setWorkspace] = useState(null)
  const [tab, setTab] = useState(tabFromHash)
  const [selected, setSelected] = useState(null) // null = working tree
  const [compareWith, setCompareWith] = useState(null)
  const [snapshotHealth, setSnapshotHealth] = useState(null)
  const [error, setError] = useState(null)
  const theme = useTheme()

  // Back/forward and hand-edited hashes both move the tab.
  useEffect(() => {
    const onHash = () => setTab(tabFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

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

  if (error) return <ApiError message={error} />
  if (!repo || !workspace) return <BootSkeleton />

  const viewing = selected ? snapshotHealth : workspace
  // /api/workspace already returns the previous snapshot's full health.json.
  // This used to rebuild a stub from the rail — `{ overall, dimensions: {} }` —
  // which meant per-dimension deltas could never render even though the data
  // was already on the wire.
  const previous = selected ? null : (workspace.previous ?? null)

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--paper)' }}>
      <Header repo={repo} workspace={workspace} theme={theme} />

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

        {/* The tab bar sits outside the scroll container rather than sticking
            to the top of it. Sticky worked, but content scrolling underneath
            showed through the gap above it — and a bar that never moves needs
            no stacking context at all. */}
        <div className="flex-1 flex flex-col min-w-0">
          <TabBar tab={tab} onTab={setTab} selected={selected} />
          <main className="flex-1 overflow-y-auto">
            {/* A max-width so measurements don't stretch across an ultrawide
                display, where a 200-character row is unreadable. */}
            <div className="px-8 pb-20 max-w-[1180px]">
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
    </div>
  )
}

// Time axis. Width steps down on narrower panes; the rail measures its own box
// and drops columns rather than overflowing, since SVG text cannot reflow.
function Rail({ ref, width, workspace, snapshots, selected, compareWith, onSelect, onCompare }) {
  return (
    <aside
      ref={ref}
      className="w-[236px] lg:w-[310px] 2xl:w-[400px] shrink-0 overflow-y-auto"
      style={{ borderRight: '1px solid var(--rule)', background: 'var(--sunken)' }}
    >
      <WorkingTreeRow workspace={workspace} active={selected === null} onClick={() => onSelect(null)} />
      <div
        className="label px-5 pt-4 pb-2"
        style={{ borderTop: '1px solid var(--rule)' }}
      >
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
    <nav
      className="flex items-center gap-6 px-8 pt-4 shrink-0"
      style={{ background: 'var(--paper)', borderBottom: '1px solid var(--rule)' }}
    >
      {TABS.map((t) => (
        // Set both: the hash so the view is linkable, and the state directly so
        // clicking the already-open tab is not a no-op that leaves them apart.
        <button
          key={t}
          onClick={() => {
            window.location.hash = t
            onTab(t)
          }}
          className="tab capitalize"
          data-active={tab === t}
        >
          {t}
        </button>
      ))}
      <span className="num ml-auto text-[11px] pb-2" style={{ color: 'var(--ink-4)' }}>
        {selected ? `snapshot ${selected.slice(0, 7)}` : 'working tree'}
      </span>
    </nav>
  )
}

// One body per tab. Kept out of App so that adding a tab does not push a single
// render function further past the complexity threshold the tool itself
// reports.
function TabBody({ tab, viewing, previous, selected, workspace, snapshots, compareWith }) {
  if (tab === 'duplicates') {
    // Snapshots do not carry the clustered findings, only the live workspace
    // does — so say that rather than rendering an empty list.
    if (selected) {
      return (
        <p className="pt-10 text-[12.5px]" style={{ color: 'var(--ink-3)' }}>
          Duplication findings are computed for the working tree. Select the working tree above to
          see them.
        </p>
      )
    }
    return <DuplicateList duplication={workspace.dimensions?.duplication} />
  }

  if (tab === 'health') {
    if (!viewing) return <PanelSkeleton />
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
      <div className="pt-6 space-y-10">
        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="label">Composition</h2>
            <span className="text-[11px]" style={{ color: 'var(--ink-4)' }}>
              {workspace.files.length} files · area is lines of code, colour is complexity
            </span>
          </div>
          <Treemap files={workspace.files} />
        </section>
        <StructurePanel live dimensions={workspace.dimensions} dag={workspace.dag} />
      </div>
    )
  }

  return (
    <div className="pt-6">
      <DriftView from={compareWith ?? snapshots[1]?.sha} to={selected ?? snapshots[0]?.sha} />
    </div>
  )
}

function Header({ repo, workspace, theme }) {
  const dirty = dirtyCount(workspace)

  return (
    <header
      className="flex items-center gap-3 px-8 py-3.5 shrink-0"
      style={{ borderBottom: '1px solid var(--rule)', background: 'var(--surface)' }}
    >
      <span className="text-[13.5px] font-semibold tracking-tight">seenit</span>
      <span className="num text-[12px]" style={{ color: 'var(--ink-3)' }}>
        {repo.name}
      </span>
      <span
        className="num text-[11px] px-1.5 py-0.5 rounded"
        style={{ background: 'var(--wash)', color: 'var(--ink-2)' }}
      >
        {repo.branch}
      </span>

      {dirty > 0 && (
        <span className="num text-[11px]" style={{ color: 'var(--h-poor)' }}>
          {dirty} uncommitted
        </span>
      )}

      <div className="ml-auto flex items-center gap-5">
        <ThemeControl theme={theme} />
        <div className="flex items-baseline gap-2">
          <span className="label">Health</span>
          <span
            className="readout text-[19px]"
            style={{ color: healthColor(workspace.health) }}
          >
            {fmt(workspace.health)}
          </span>
        </div>
      </div>
    </header>
  )
}

// Deliberately not a sun/moon switch. That control is the most recognisable
// stamp of a generated interface, and it cannot express "follow the system"
// anyway — which is a real preference, not the absence of one.
function ThemeControl({ theme }) {
  return (
    <button
      onClick={theme.cycle}
      className="btn-quiet px-2 py-1 text-[11px] capitalize"
      title="Switch between system, light and dark"
      aria-label={`Theme: ${theme.mode}. Click to change.`}
    >
      {theme.mode}
    </button>
  )
}

// The working tree sits above the rail rather than in it — it is not a snapshot
// and pretending otherwise would put uncommitted state into the history.
function WorkingTreeRow({ workspace, active, onClick }) {
  const dirty = dirtyCount(workspace)
  return (
    <button
      onClick={onClick}
      className="w-full text-left px-5 py-4 flex items-center gap-3 transition-colors"
      style={{ background: active ? 'var(--surface)' : 'transparent' }}
    >
      <span
        className="w-2 h-2 rounded-full shrink-0"
        style={{
          background: healthColor(workspace.health),
          outline: dirty ? '1px dashed var(--ink-4)' : 'none',
          outlineOffset: '2.5px',
        }}
      />
      <span className="min-w-0">
        <span className="block text-[12.5px]" style={{ color: 'var(--ink)' }}>
          Working tree
        </span>
        <span className="block num text-[10.5px]" style={{ color: 'var(--ink-4)' }}>
          {dirty ? `${dirty} uncommitted change${dirty === 1 ? '' : 's'}` : 'clean'}
        </span>
      </span>
      <span
        className="readout ml-auto text-[15px]"
        style={{ color: healthColor(workspace.health) }}
      >
        {fmt(workspace.health)}
      </span>
    </button>
  )
}

function ApiError({ message }) {
  return (
    <Centered>
      <div className="panel p-6 max-w-md">
        <p className="mb-2" style={{ color: 'var(--h-bad)' }}>
          Could not reach the API
        </p>
        <p className="num text-[12px] mb-4" style={{ color: 'var(--ink-3)' }}>
          {message}
        </p>
        <p className="text-[12px]" style={{ color: 'var(--ink-3)' }}>
          The observatory reads from a local server. Start it with{' '}
          <code className="num" style={{ color: 'var(--ink-2)' }}>
            seenit serve
          </code>
          .
        </p>
      </div>
    </Centered>
  )
}

// Skeletons in the shape of the thing that is coming, rather than a spinner
// that tells you nothing about what to expect.
function BootSkeleton() {
  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--paper)' }}>
      <div className="h-[50px] shrink-0" style={{ borderBottom: '1px solid var(--rule)' }} />
      <div className="flex-1 flex min-h-0">
        <div
          className="w-[236px] lg:w-[310px] 2xl:w-[400px] shrink-0 p-5 space-y-3"
          style={{ borderRight: '1px solid var(--rule)', background: 'var(--sunken)' }}
        >
          {Array.from({ length: 9 }, (_, i) => (
            <div key={i} className="skeleton h-4" style={{ width: `${88 - i * 4}%` }} />
          ))}
        </div>
        <div className="flex-1 px-8 pt-10">
          <PanelSkeleton />
        </div>
      </div>
    </div>
  )
}

function PanelSkeleton() {
  return (
    <div className="pt-4">
      <div className="skeleton h-3 w-24" />
      <div className="skeleton h-16 w-56 mt-4" />
      <div className="mt-10 space-y-6">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex gap-5 items-center">
            <div className="skeleton h-3 w-28 shrink-0" />
            <div className="skeleton h-[2px] flex-1" />
            <div className="skeleton h-6 w-14 shrink-0" />
          </div>
        ))}
      </div>
    </div>
  )
}

const Centered = ({ children }) => (
  <div className="h-full flex items-center justify-center" style={{ background: 'var(--paper)' }}>
    {children}
  </div>
)
