import { useCallback, useMemo, useRef, useState } from 'react'

import { CodaMark } from '../CodaMark'
import { getSource } from '../../data/source'
import { EXAMPLES } from '../../examples'
import type { DatasetFamily } from '../../nodes/lib/datasetFamilies'
import { DATASET_FAMILIES } from '../../nodes/lib/datasetFamilies'
import type { StarterSpec } from '../../examples/starters'
import type { WorkflowSummary } from '../../store/library'
import { findByName } from '../../store/library'
import { useErrorCount, useGraphStore, useStaleCount } from '../../store/graphStore'
import { pickGraphFile } from '../../store/persistence'
import { downloadGraph } from '../export'
import { formatAgo, plural } from '../format'
import { SourcesPanel } from './SourcesPanel'
import { useDismissOnOutside } from '../useDismiss'

export interface ToolbarProps {
  /** Opens the command palette, which lives inside the canvas. */
  onOpenPalette: (initialQuery?: string) => void
  /** Opens the large add-node browser. */
  onOpenBrowser: () => void
}

export function Toolbar({ onOpenPalette, onOpenBrowser }: ToolbarProps) {
  const graph = useGraphStore((s) => s.graph)
  const busy = useGraphStore((s) => s.busy)
  const theme = useGraphStore((s) => s.theme)
  const setTheme = useGraphStore((s) => s.setTheme)
  const clearResults = useGraphStore((s) => s.clearResults)
  const setGraphName = useGraphStore((s) => s.setGraphName)
  const newGraph = useGraphStore((s) => s.newGraph)
  const loadExample = useGraphStore((s) => s.loadExample)
  const refreshLibrary = useGraphStore((s) => s.refreshLibrary)
  const loadStarter = useGraphStore((s) => s.loadStarter)
  const runAll = useGraphStore((s) => s.runAll)
  const cancelRun = useGraphStore((s) => s.cancelRun)
  const openStartPage = useGraphStore((s) => s.openStartPage)
  const undo = useGraphStore((s) => s.undo)
  const redo = useGraphStore((s) => s.redo)
  const canUndo = useGraphStore((s) => s.past.length > 0)
  const canRedo = useGraphStore((s) => s.future.length > 0)

  const autoRun = useGraphStore((s) => s.autoRun)
  const setAutoRun = useGraphStore((s) => s.setAutoRun)
  const togglePanel = useGraphStore((s) => s.togglePanel)
  // A primitive, not the panels object: the store is read through `useSyncExternalStore`, which
  // compares snapshots by identity, and `togglePanel` mints a fresh object each time.
  const inspectorOpen = useGraphStore((s) => s.panels.inspector)

  const staleCount = useStaleCount()
  const errorCount = useErrorCount()

  return (
    <div className="toolbar">
      <div className="toolbar__brand">
        {/* currentColor, not --accent: an accent-blue mark here is the same blue as a Table
            socket, and would read as a typed port rather than as chrome. */}
        <CodaMark size={17} />
        {/* The name and its descriptor share a baseline; the mark centres on the pair. Without
            this wrapper the mark centres on a block that is two lines tall whenever the
            descriptor wraps, and sits visibly low against the name. */}
        <div className="toolbar__brandText">
          <strong>Coda</strong>
          <span>connectome data analysis</span>
        </div>
      </div>

      <input
        className="toolbar__name"
        value={graph.meta?.name ?? ''}
        placeholder="Untitled graph"
        onChange={(e) => setGraphName(e.target.value)}
        title="Graph name — used as the filename when saving"
      />

      <Dropdown label="New">
        {(close) => (
          <NewMenu
            onEmpty={() => {
              newGraph()
              close()
            }}
            onDataset={(spec) => {
              loadStarter(spec)
              close()
            }}
          />
        )}
      </Dropdown>
      {/*
        * Open and Save are menus rather than buttons because each now has two destinations: a
        * file, and the browser's own shelf. Reading the shelf is deferred to the moment a menu
        * opens — someone who never uses it never touches IndexedDB.
        */}
      <Dropdown label="Open" onOpen={() => void refreshLibrary()}>
        {(close) => <OpenMenu close={close} />}
      </Dropdown>
      <Dropdown label="Save" onOpen={() => void refreshLibrary()}>
        {(close) => <SaveMenu close={close} />}
      </Dropdown>

      <Dropdown label="Examples">
        {(close) =>
          EXAMPLES.map((example) => (
            <button
              key={example.id}
              type="button"
              className="dropdown__item"
              onClick={() => {
                loadExample(example.id)
                close()
              }}
            >
              <strong>{example.name}</strong>
              <span>{example.summary}</span>
            </button>
          ))
        }
      </Dropdown>

      {/* The way back to the start page once "Don't show again" is ticked. Same target as the
          palette's Help ▸ Welcome to Coda. A menu rather than a bare button because a lone "?"
          says nothing about what it does until you press it. */}
      <Dropdown label="?" title="Help">
        {(close) => (
          <button
            type="button"
            className="dropdown__item"
            onClick={() => {
              openStartPage()
              close()
            }}
          >
            <strong>Show Welcome Dialog</strong>
            <span>What Coda is, and a few places to begin</span>
          </button>
        )}
      </Dropdown>

      <span style={{ width: 8 }} />

      <button
        type="button"
        className="btn btn--ghost"
        onClick={undo}
        disabled={!canUndo}
        title="Undo (⌘Z)"
      >
        ↶
      </button>
      <button
        type="button"
        className="btn btn--ghost"
        onClick={redo}
        disabled={!canRedo}
        title="Redo (⇧⌘Z)"
      >
        ↷
      </button>

      <div className="toolbar__spacer" />

      {errorCount > 0 && (
        <span
          className="badge-count"
          data-tone="error"
          title={`${errorCount} node(s) with errors`}
        >
          {errorCount} ×
        </span>
      )}

      <SourcesPanel />

      <button
        type="button"
        className="btn btn--ghost"
        aria-pressed={inspectorOpen}
        onClick={() => togglePanel('inspector')}
        title={inspectorOpen ? 'Hide the inspector (I)' : 'Show the inspector (I)'}
      >
        {inspectorOpen ? '▐' : '▕'} Inspector <span className="btn__kbd">I</span>
      </button>

      <button
        type="button"
        className="btn btn--ghost"
        onClick={clearResults}
        disabled={busy}
        title="Drop every cached result so the next run re-fetches from scratch"
      >
        Clear
      </button>

      <button type="button" className="btn" onClick={onOpenBrowser} title="Browse nodes (Tab)">
        + Add <span className="btn__kbd">Tab</span>
      </button>

      <button
        type="button"
        className="btn"
        onClick={() => onOpenPalette()}
        title="Commands and nodes (Space)"
      >
        Commands <span className="btn__kbd">Space</span>
      </button>

      {/*
        * Next to Run because it is a statement about the same action: whether it happens on its
        * own. A real checkbox rather than a toggle button — this is a persistent setting with an
        * on and an off, not a command.
        */}
      <label
        className="autorun"
        title={
          autoRun
            ? 'Re-running the whole graph after every change. Uncheck for expensive workflows.'
            : 'Re-run the whole graph after every change. Expensive nodes will query on every edit.'
        }
      >
        <input type="checkbox" checked={autoRun} onChange={(e) => setAutoRun(e.target.checked)} />
        <span>Auto-run</span>
      </label>

      {busy ? (
        <button
          type="button"
          className="btn"
          onClick={cancelRun}
          title="Cancel the running graph"
        >
          Cancel
        </button>
      ) : (
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void runAll()}
          disabled={staleCount === 0}
          // Explicit label: the visible content reads "Run 5 ⇧R", which is a poor name for
          // a screen reader and ambiguous against the per-node Run buttons.
          aria-label="Run all stale nodes"
          title={
            staleCount === 0
              ? 'Everything is up to date'
              : autoRun
                ? `Run ${plural(staleCount, 'stale node')} now, without waiting for auto-run (⇧R)`
                : `Run ${plural(staleCount, 'stale node')} (⇧R)`
          }
        >
          Run
          {staleCount > 0 && (
            <span className="badge-count" data-tone="stale">
              {staleCount}
            </span>
          )}
          <span className="btn__kbd">⇧R</span>
        </button>
      )}

      <button
        type="button"
        className="btn btn--ghost"
        title={`Theme: ${theme}`}
        onClick={() =>
          setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark')
        }
      >
        {theme === 'dark' ? '◐' : theme === 'light' ? '◑' : '◒'}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------

/**
 * The New menu: an empty canvas, or a graph already pointed at a dataset.
 *
 * Driven by the static family table rather than by a live dataset listing, which is what lets it
 * open instantly and work with no token — the entries are the dataset *nodes* that exist, and
 * each node then resolves its own versions once a connection is available. It also means opening
 * the menu no longer fires a request at a shared production server for anyone who was only
 * looking.
 */
function NewMenu({
  onEmpty,
  onDataset,
}: {
  onEmpty: () => void
  onDataset: (spec: StarterSpec) => void
}) {
  const groups = useMemo(() => {
    const bySource = new Map<string, DatasetFamily[]>()
    for (const family of DATASET_FAMILIES) {
      const held = bySource.get(family.sourceId)
      if (held) held.push(family)
      else bySource.set(family.sourceId, [family])
    }
    return [...bySource.entries()].map(([sourceId, families]) => ({
      sourceId,
      label: getSource(sourceId)?.label ?? sourceId,
      families,
    }))
  }, [])

  return (
    <>
      <button type="button" className="dropdown__item" onClick={onEmpty}>
        <strong>Empty</strong>
        <span>A blank canvas</span>
      </button>

      {groups.map((group) => (
        <div key={group.sourceId} className="dropdown__group">
          <div className="dropdown__heading">{group.label}</div>
          {group.families.map((family) => (
            <button
              key={family.key}
              type="button"
              className="dropdown__item"
              title={family.description}
              onClick={() =>
                onDataset({
                  nodeType: `dataset.${family.key}`,
                  label: family.label,
                  sourceId: family.sourceId,
                })
              }
            >
              <strong>{family.label}</strong>
              <span>{family.description}</span>
            </button>
          ))}
        </div>
      ))}

      <div className="dropdown__group">
        <div className="dropdown__heading">Other</div>
        <button
          type="button"
          className="dropdown__item"
          onClick={() =>
            onDataset({
              nodeType: 'dataset.neuprint',
              label: 'Custom neuPrint',
              sourceId: 'neuprint',
            })
          }
        >
          <strong>Custom neuPrint</strong>
          <span>Name a server and dataset by hand</span>
        </button>
      </div>
    </>
  )
}

/**
 * The Open menu: what is on the browser shelf, then the file picker.
 *
 * The shelf comes first because it is the frequent case once anything is on it, and the file
 * entry stays last with its own separator so it never moves as the list grows. Manage controls
 * live on the rows rather than behind a separate dialog: the list is right here, and a panel
 * whose only job is to delete things is a panel most people will never find.
 */
function OpenMenu({ close }: { close: () => void }) {
  const library = useGraphStore((s) => s.library)
  const loaded = useGraphStore((s) => s.libraryLoaded)
  const openFromLibrary = useGraphStore((s) => s.openFromLibrary)
  const loadGraph = useGraphStore((s) => s.loadGraph)

  return (
    <>
      <div className="dropdown__heading">Saved in this browser</div>

      {!loaded && <div className="dropdown__note">Reading…</div>}
      {loaded && library.length === 0 && (
        <div className="dropdown__note">
          Nothing saved yet. Save ▸ Save in this browser keeps a copy here.
        </div>
      )}

      {library.map((entry) => (
        <LibraryRow
          key={entry.id}
          entry={entry}
          onOpen={() => {
            void openFromLibrary(entry.id)
            close()
          }}
        />
      ))}

      <div className="dropdown__group">
        <button
          type="button"
          className="dropdown__item"
          onClick={async () => {
            close()
            const result = await pickGraphFile()
            if (result) loadGraph(result.graph, result.warnings)
          }}
        >
          <strong>Open a .coda.json file…</strong>
          <span>From disk, wherever you saved it</span>
        </button>
      </div>
    </>
  )
}

/**
 * One shelf row: open it, rename it, delete it.
 *
 * The three are siblings rather than nested buttons, and both destructive-ish actions ask in
 * place — a rename opens an input over the row, a delete swaps the row for a confirm. Neither
 * uses `window.confirm`: jsdom does not implement it, and browser chrome for "delete this
 * bookmark" is heavier than the action deserves.
 */
function LibraryRow({ entry, onOpen }: { entry: WorkflowSummary; onOpen: () => void }) {
  const renameInLibrary = useGraphStore((s) => s.renameInLibrary)
  const deleteFromLibrary = useGraphStore((s) => s.deleteFromLibrary)
  const [mode, setMode] = useState<'idle' | 'rename' | 'delete'>('idle')
  const [draft, setDraft] = useState(entry.name)

  if (mode === 'rename') {
    const commit = () => {
      if (draft.trim() && draft !== entry.name) void renameInLibrary(entry.id, draft)
      setMode('idle')
    }
    return (
      <div className="library-row library-row--editing">
        <input
          className="library-row__input"
          value={draft}
          autoFocus
          aria-label={`Rename ${entry.name}`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') {
              setDraft(entry.name)
              setMode('idle')
            }
          }}
        />
        <button type="button" className="btn btn--primary library-row__btn" onClick={commit}>
          Rename
        </button>
      </div>
    )
  }

  if (mode === 'delete') {
    return (
      <div className="library-row library-row--editing">
        <span className="library-row__ask">Delete “{entry.name}”?</span>
        <button
          type="button"
          className="btn library-row__btn"
          data-tone="danger"
          onClick={() => void deleteFromLibrary(entry.id)}
        >
          Delete
        </button>
        <button type="button" className="btn library-row__btn" onClick={() => setMode('idle')}>
          Cancel
        </button>
      </div>
    )
  }

  return (
    <div className="library-row">
      <button type="button" className="dropdown__item library-row__open" onClick={onOpen}>
        <strong>{entry.name}</strong>
        <span>
          {formatAgo(entry.savedAt)} · {plural(entry.nodeTypes.length, 'node')}
        </span>
      </button>
      <button
        type="button"
        className="library-row__act"
        title={`Rename ${entry.name}`}
        aria-label={`Rename ${entry.name}`}
        onClick={() => {
          setDraft(entry.name)
          setMode('rename')
        }}
      >
        ✎
      </button>
      <button
        type="button"
        className="library-row__act"
        title={`Delete ${entry.name}`}
        aria-label={`Delete ${entry.name}`}
        onClick={() => setMode('delete')}
      >
        ✕
      </button>
    </div>
  )
}

/**
 * The Save menu: the browser shelf, or a file.
 *
 * A library entry is a *document keyed by its name*, so saving under a name already on the
 * shelf replaces it — and says so first. The alternative, appending a new entry per save, fills
 * the shelf with near-identical copies nobody can tell apart; renaming the graph in the toolbar
 * is what makes a second one.
 *
 * The file entry stays, and stays described as the durable one: browser storage is per-profile,
 * wiped by "clear site data" and absent in a private window, so it complements the download
 * rather than replacing it.
 */
function SaveMenu({ close }: { close: () => void }) {
  const graph = useGraphStore((s) => s.graph)
  const saveToLibrary = useGraphStore((s) => s.saveToLibrary)
  // Subscribe to the list rather than asking the store to answer: the menu's own `onOpen`
  // refreshes it, so a component reading through a store method would render the answer from
  // before the read landed and never hear about the one after it.
  const library = useGraphStore((s) => s.library)
  const loaded = useGraphStore((s) => s.libraryLoaded)
  const [confirming, setConfirming] = useState(false)

  const name = (graph.meta?.name ?? '').trim() || 'Untitled'
  const conflict = findByName(library, name)

  const save = () => {
    void saveToLibrary()
    close()
  }

  return (
    <>
      {confirming && conflict ? (
        <div className="dropdown__confirm">
          <p>
            Replace “{conflict.name}”, saved {formatAgo(conflict.savedAt)}?
          </p>
          <div>
            <button type="button" className="btn btn--primary" onClick={save}>
              Replace
            </button>
            <button type="button" className="btn" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="dropdown__item"
          onClick={() => {
            if (conflict) setConfirming(true)
            else save()
          }}
        >
          <strong>Save in this browser</strong>
          <span>
            {!loaded
              ? `As “${name}”`
              : conflict
                ? `Replaces the copy saved ${formatAgo(conflict.savedAt)}`
                : `As “${name}” — reopen it from Open, or the start page`}
          </span>
        </button>
      )}

      <div className="dropdown__group">
        <button
          type="button"
          className="dropdown__item"
          onClick={() => {
            downloadGraph(graph)
            close()
          }}
        >
          <strong>Download .coda.json</strong>
          <span>A file you can share, back up, or open on another machine</span>
        </button>
      </div>

      <div className="dropdown__note">
        Browser storage is per-profile and is cleared with the site data. Download the file for
        anything you would be sorry to lose.
      </div>
    </>
  )
}

function Dropdown({
  label,
  title,
  onOpen,
  children,
}: {
  label: string
  /** Accessible name and tooltip, for a trigger whose label is a glyph rather than a word. */
  title?: string
  /** Fired on the transition to open — the seam for a menu whose contents have to be fetched. */
  onOpen?: () => void
  children: (close: () => void) => React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])

  useDismissOnOutside(ref, close, { enabled: open })

  return (
    <div className="dropdown" ref={ref}>
      <button
        type="button"
        className="btn btn--ghost"
        title={title}
        aria-label={title}
        onClick={() => {
          // Not inside the state updater: React may call that twice under StrictMode, which
          // would fire the fetch twice for one click.
          const next = !open
          setOpen(next)
          if (next) onOpen?.()
        }}
      >
        {label} ▾
      </button>
      {open && <div className="dropdown__panel">{children(() => setOpen(false))}</div>}
    </div>
  )
}
