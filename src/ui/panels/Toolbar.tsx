import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { CodaGraph } from '../../core/graph'
import { canExportNotebook } from '../../export/canExport'
import type { ExportLanguage } from '../../nodes/lib/datasetFamilies'
import { CodaMark } from '../CodaMark'
import { peekExportWarnings, requestExportWarnings, useExportWarnings } from '../exportWarnings'
import { AssistantIcon, InspectorIcon, ShareIcon } from '../Icons'
import { getSource } from '../../data/source'
import { EXAMPLES } from '../../examples'
import type { CustomDatasetNode, DatasetFamily } from '../../nodes/lib/datasetFamilies'
import { CUSTOM_DATASET_NODES, starterFamilies } from '../../nodes/lib/datasetFamilies'
import { getNodeDef } from '../../core/registry'
import type { StarterSpec } from '../../examples/starters'
import type { WorkflowSummary } from '../../store/library'
import { findByName } from '../../store/library'
import { useErrorCount, useGraphStore, useStaleCount } from '../../store/graphStore'
import { pickGraphFile } from '../../store/persistence'
import { downloadGraph, downloadNotebook, downloadRmd } from '../export'
import { formatAgo, plural } from '../format'
import { LOCKED_HINT, lockedTitle } from '../lockCopy'
import { appElement, toggleFullscreen, useIsFullscreen } from '../fullscreen'
import { EdgeSetPanel } from './EdgeSetPanel'
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
  const requestShare = useGraphStore((s) => s.requestShare)
  const undo = useGraphStore((s) => s.undo)
  const redo = useGraphStore((s) => s.redo)
  // Both read the lock: history is a graph edit like any other, and the canvas being frozen is
  // the reason a lit ↶ would then do nothing. Primitives — invariant 7.
  const locked = useGraphStore((s) => s.locked)
  const canUndo = useGraphStore((s) => s.past.length > 0)
  const canRedo = useGraphStore((s) => s.future.length > 0)

  const autoRun = useGraphStore((s) => s.autoRun)
  const setAutoRun = useGraphStore((s) => s.setAutoRun)
  const togglePanel = useGraphStore((s) => s.togglePanel)
  const assistantOpen = useGraphStore((s) => s.panels.assistant)
  // A primitive, not the panels object: the store is read through `useSyncExternalStore`, which
  // compares snapshots by identity, and `togglePanel` mints a fresh object each time.
  const inspectorOpen = useGraphStore((s) => s.panels.inspector)

  const setNotice = useGraphStore((s) => s.setNotice)
  // Read off `document.fullscreenElement`, never off the click: Escape and F11 both leave
  // fullscreen without touching this button. See `ui/fullscreen.ts`.
  const fullscreen = useIsFullscreen(appElement())

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
          <>
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
            {/*
             * A link rather than a button, so it can be opened in a new tab the
             * ordinary way — leaving the graph on the canvas untouched. Through
             * `BASE_URL`, since `base` is './' and an absolute path would resolve
             * to the domain root under a subpath deploy.
             *
             * Three documents, in the order somebody meets them: what Coda is,
             * how it works, then what each node does.
             */}
            <a
              className="dropdown__item"
              href={`${import.meta.env.BASE_URL}overview.html`}
              target="_blank"
              rel="noreferrer noopener"
              onClick={close}
            >
              <strong>Overview</strong>
              <span>What Coda is, in one scroll</span>
            </a>
            <a
              className="dropdown__item"
              href={`${import.meta.env.BASE_URL}tutorial.html`}
              target="_blank"
              rel="noreferrer noopener"
              onClick={close}
            >
              <strong>Field Guide</strong>
              <span>Nodes, wires, queries and viewers, from the beginning</span>
            </a>
            {/*
             * The reference half of the pair. The field guide is read once, front to back;
             * this is the one somebody comes back to with a node in mind, which is why both
             * are offered rather than the second being a section of the first.
             */}
            <a
              className="dropdown__item"
              href={`${import.meta.env.BASE_URL}nodes.html`}
              target="_blank"
              rel="noreferrer noopener"
              onClick={close}
            >
              <strong>Node Guide</strong>
              <span>Every node: what it takes, what it hands on, what it draws</span>
            </a>
          </>
        )}
      </Dropdown>

      <span style={{ width: 8 }} />

      <button
        type="button"
        className="btn btn--ghost"
        onClick={undo}
        disabled={locked || !canUndo}
        title={locked ? lockedTitle('Undo') : 'Undo (⌘Z)'}
      >
        ↶
      </button>
      <button
        type="button"
        className="btn btn--ghost"
        onClick={redo}
        disabled={locked || !canRedo}
        title={locked ? lockedTitle('Redo') : 'Redo (⇧⌘Z)'}
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

      {/*
       * The icon cluster. Share is the odd one out — a verb, where the other three are toggles
       * or a dialog — and it leads because it is about the document, which is what the left-hand
       * menus are about too. It was under `Save ▸` and moved here for the reason the whole
       * cluster lost its words: an action reached for by muscle memory does not need a sentence
       * two clicks deep.
       */}
      <button
        type="button"
        className="btn btn--ghost btn--icon"
        onClick={requestShare}
        title="Share workflow — a link that opens this graph"
        aria-label="Share workflow"
      >
        <ShareIcon />
      </button>

      <SourcesPanel />
      {/* Opened from a dataset card, mounted here: a modal inside React Flow's transformed
          pane takes the transform as its containing block. */}
      <EdgeSetPanel />

      <button
        type="button"
        className="btn btn--ghost btn--icon"
        aria-pressed={assistantOpen}
        title="Assistant — describe a change and let it build it (/)"
        aria-label="Assistant"
        onClick={() => togglePanel('assistant')}
      >
        <AssistantIcon />
      </button>
      {/*
       * The chevron pair this used to draw (`▐` against `▕`) said open-or-closed in the glyph
       * itself. An icon that does not change with the state says it through `aria-pressed`
       * instead — the same trade `.coda-node__fold` records — and the tooltip still names which
       * way the click goes.
       */}
      <button
        type="button"
        className="btn btn--ghost btn--icon"
        aria-pressed={inspectorOpen}
        onClick={() => togglePanel('inspector')}
        title={inspectorOpen ? 'Hide the inspector (I)' : 'Show the inspector (I)'}
        aria-label="Inspector"
      >
        <InspectorIcon />
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

      <button
        type="button"
        className="btn"
        onClick={onOpenBrowser}
        disabled={locked}
        title={locked ? LOCKED_HINT : 'Browse nodes (Tab)'}
      >
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
        <input
          type="checkbox"
          checked={autoRun}
          onChange={(e) => setAutoRun(e.target.checked)}
        />
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

      {/*
       * Fullscreen keeps the toolbar and the status bar: what it reclaims is the browser's
       * ~90px of tabs and address bar, not the app's own chrome. Run, Auto-run and the stale
       * count are exactly what you want in view while a graph is running.
       */}
      <button
        type="button"
        className="btn btn--ghost"
        aria-pressed={fullscreen}
        onClick={() => {
          // `fullscreen` is what distinguishes a refusal from an ordinary exit — both come
          // back false, and only one of them is worth saying anything about.
          const entering = !fullscreen
          void toggleFullscreen(appElement()).then((now) => {
            if (entering && !now) setNotice('This browser refused fullscreen')
          })
        }}
        title={
          fullscreen
            ? 'Leave fullscreen (F)'
            : "Fill the screen, hiding the browser's own tabs and address bar (F)"
        }
        aria-label={fullscreen ? 'Leave fullscreen' : 'Enter fullscreen'}
      >
        {fullscreen ? '⤡' : '⛶'}
      </button>

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
    // Only the families offered as a starting point — see `DatasetFamily.starter`. Every dataset
    // node stays in `Add ▸ Dataset`; what this list decides is where somebody *begins*.
    for (const family of starterFamilies()) {
      const held = bySource.get(family.sourceId)
      if (held) held.push(family)
      else bySource.set(family.sourceId, [family])
    }
    /*
     * A backend's escape hatch goes under that backend's own heading rather than into a trailing
     * "Other", which is what it used to be when there was one of them. Three collected under a
     * heading of their own would sort every custom node away from the datasets it is a custom
     * version *of*, and would leave a reader to work out which of the three matches the group
     * they were just looking at.
     *
     * The second loop is what gives a backend with *no* starter family a heading of its own —
     * the state any backend is in before its family table has an entry, and the state a backend
     * lands in if every one of its families is later marked `starter: false`.
     */
    for (const custom of CUSTOM_DATASET_NODES) {
      if (!bySource.has(custom.sourceId)) bySource.set(custom.sourceId, [])
    }
    return [...bySource.entries()].map(([sourceId, families]) => ({
      sourceId,
      label: getSource(sourceId)?.label ?? sourceId,
      families,
      custom: CUSTOM_DATASET_NODES.filter((entry) => entry.sourceId === sourceId),
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
          {group.custom.map((custom) => (
            <CustomDatasetItem key={custom.type} custom={custom} onDataset={onDataset} />
          ))}
        </div>
      ))}
    </>
  )
}

/**
 * One escape hatch, named by its own node definition.
 *
 * The label and the blurb are read off the registry rather than restated here, which is the
 * whole reason `CUSTOM_DATASET_NODES` carries no presentation: a menu entry saying something the
 * card does not is the drift this codebase keeps writing up, and it is invisible — both strings
 * look perfectly reasonable on their own.
 */
function CustomDatasetItem({
  custom,
  onDataset,
}: {
  custom: CustomDatasetNode
  onDataset: (spec: StarterSpec) => void
}) {
  const def = getNodeDef(custom.type)
  if (!def) return null
  return (
    <button
      type="button"
      className="dropdown__item"
      title={def.description}
      onClick={() =>
        onDataset({ nodeType: custom.type, label: def.label, sourceId: custom.sourceId })
      }
    >
      <strong>{def.label}</strong>
      <span>{def.description}</span>
    </button>
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

  /*
   * How much of the graph the exporters cannot translate, worked out by running them. Started
   * here because this component is mounted only while the menu is open — the `Dropdown` renders
   * its children behind `open` — and the answer arrives on a channel, so `useExportWarnings` is
   * what brings it to the rows below rather than to the next unrelated re-render.
   */
  useExportWarnings()
  useEffect(() => requestExportWarnings(graph), [graph])

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

      {/*
        The caveat sits under the entry it is about, not at the foot of the menu, where it read
        as a note on everything including the download beneath it. It closes that section, so it
        hugs the rule below it — and it is a caveat rather than a hint, so it stands one step
        quieter than the line under every item.

        One sentence, and it stays one line: the advice that used to follow it is what the
        download entry's own hint already says, and a second line here turned an aside into a
        paragraph the eye stops at on the way to the rows.
      */}
      <div className="dropdown__note dropdown__note--caveat">
        Browser storage is per-profile and is cleared with the site data.
      </div>

      {/* Share used to sit here, between the shelf and the download. It is a toolbar icon now —
          see the cluster in `Toolbar`. */}
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

        {/*
         * Both formats, each answering for itself. They no longer agree about what is
         * exportable — a CAVE dataset builds a notebook and no R document — so a refusal has to
         * be a fact about *this row* rather than a sentence replacing the whole block, which is
         * what it was when one answer served both.
         */}
        <ExportItem
          label="Export as Jupyter Notebook"
          description="A Jupyter notebook using neuprint-python, pandas and navis"
          graph={graph}
          language="python"
          onExport={() => downloadNotebook(graph, { appVersion: __APP_VERSION__ })}
          close={close}
        />
        <ExportItem
          label="Export as R Markdown"
          description="An .Rmd using neuprintr, dplyr and nat"
          graph={graph}
          language="r"
          onExport={() => downloadRmd(graph, { appVersion: __APP_VERSION__ })}
          close={close}
        />
      </div>
    </>
  )
}

/**
 * One export format's row: what it makes, whether it can, and what it will be missing.
 *
 * **The refusal is shown before the click, not after it.** The Save menu used to let the click
 * through and replace the whole export block with a sentence — right while one answer served
 * both formats, and wrong now that they can disagree, because it also hid the format that
 * *would* have worked. A disabled row with the reason under it says the same thing without
 * taking the other row away, and it is what the palette has always done with less room.
 *
 * The reason is rendered at full strength while the row above it dims, so a disabled row is
 * still legible where it matters. Dimming the whole button would take a 4.5:1 colour to about
 * half that.
 */
function ExportItem({
  label,
  description,
  graph,
  language,
  onExport,
  close,
}: {
  label: string
  description: string
  graph: CodaGraph
  language: ExportLanguage
  onExport: () => Promise<{ ok: boolean }>
  close: () => void
}) {
  const refusal = canExportNotebook(graph, language)
  const warning = peekExportWarnings(graph, language)
  return (
    <button
      type="button"
      className="dropdown__item"
      disabled={refusal !== undefined}
      onClick={() => void onExport().then((result) => result.ok && close())}
    >
      <strong>{label}</strong>
      <span>{description}</span>
      {refusal ? (
        <span className="dropdown__refused">
          Cannot export: {refusal.reason}. {refusal.detail}
        </span>
      ) : (
        warning && <span className="dropdown__warn">⚠ {warning.detail}</span>
      )}
    </button>
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
