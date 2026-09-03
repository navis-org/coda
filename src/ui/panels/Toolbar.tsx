import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { CodaGraph } from '../../core/graph'
import { canExportNotebook } from '../../export/canExport'
import type { ExportLanguage } from '../../nodes/lib/datasetFamilies'
import { CodaMark } from '../CodaMark'
import { peekExportWarnings, requestExportWarnings, useExportWarnings } from '../exportWarnings'
import { AssistantIcon, BellIcon, InspectorIcon, ShareIcon } from '../Icons'
import type { CustomDatasetNode } from '../../nodes/lib/datasetFamilies'
import {
  BACKENDS,
  CUSTOM_DATASET_NODES,
  starterFamilies,
} from '../../nodes/lib/datasetFamilies'
import { getNodeDef } from '../../core/registry'
import { WIZARD_BLURB, WIZARD_LABEL } from '../../wizard/options'
import type { StarterSpec } from '../../examples/starters'
import type { WorkflowSummary } from '../../store/library'
import { findByName } from '../../store/library'
import { useErrorCount, useGraphStore, useStaleCount } from '../../store/graphStore'
import { pickGraphFile } from '../../store/persistence'
import { graphName } from '../../core/graph'
import { downloadGraph, downloadNotebook, downloadRmd } from '../export'
import { formatAgo, plural } from '../format'
import { lockedTitle } from '../lockCopy'
import { appElement, toggleFullscreen, useIsFullscreen } from '../fullscreen'
import type { NotifyState } from '../notify'
import {
  NOTIFY_AFTER_MS,
  bellState,
  notifyState,
  requestNotifyPermission,
  showTestNotification,
} from '../notify'
import { EdgeSetPanel } from './EdgeSetPanel'
import { SourcesPanel } from './SourcesPanel'
import type { TourAnchor } from '../tour/steps'
import { TOURS, startTour } from '../tour/tourState'
import { restoreHints, useDismissedHints } from '../hints'
import { useDismissOnOutside } from '../useDismiss'

/*
 * No props. It had two — `onOpenPalette` and `onOpenBrowser`, routed through the store because
 * the toolbar sits outside the React Flow provider and cannot convert screen coordinates. Both
 * buttons are gone: Add is a circle on the canvas itself (`Editor.tsx`), which can convert
 * coordinates and so needs no relay, and Commands was a second, wordier way to press Space.
 * `requestPalette` stays on the store — the Save menu and the tour still open the palette.
 */
export function Toolbar() {
  const graph = useGraphStore((s) => s.graph)
  const busy = useGraphStore((s) => s.busy)
  const theme = useGraphStore((s) => s.theme)
  const setTheme = useGraphStore((s) => s.setTheme)
  const clearResults = useGraphStore((s) => s.clearResults)
  const setGraphName = useGraphStore((s) => s.setGraphName)
  const newWorkflow = useGraphStore((s) => s.newWorkflow)
  const openWizard = useGraphStore((s) => s.openWizard)
  const openZoo = useGraphStore((s) => s.openZoo)
  const refreshLibrary = useGraphStore((s) => s.refreshLibrary)
  const loadStarter = useGraphStore((s) => s.loadStarter)
  const runAll = useGraphStore((s) => s.runAll)
  const cancelRun = useGraphStore((s) => s.cancelRun)
  const openStartPage = useGraphStore((s) => s.openStartPage)
  const requestShare = useGraphStore((s) => s.requestShare)
  const requestShortcuts = useGraphStore((s) => s.requestShortcuts)
  // The set itself rather than a boolean: `useSyncExternalStore` compares snapshots by identity
  // and the set is replaced on every write, so this is one subscription and no allocation.
  const dismissedHints = useDismissedHints()
  const requestPrivacy = useGraphStore((s) => s.requestPrivacy)
  const requestFeedback = useGraphStore((s) => s.requestFeedback)
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
  // Primitives — invariant 7.
  const dashboardOpen = useGraphStore((s) => s.dashboardOpen)
  const toggleDashboard = useGraphStore((s) => s.toggleDashboard)

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
        {/* Just the name. It used to carry `connectome data analysis` beside it on a shared
            baseline, which is what `.toolbar__brandText` was for — a mark centred on a
            one-line name rather than on a block that went two lines whenever the descriptor
            wrapped. One line needs no wrapper, so both went. The descriptor still leads the
            static pages, which is where somebody who has not seen the app is reading. */}
        <strong>Coda</strong>
      </div>

      <input
        className="toolbar__name"
        value={graph.meta?.name ?? ''}
        placeholder="Untitled graph"
        onChange={(e) => setGraphName(e.target.value)}
        title="Graph name — used as the filename when saving"
      />

      {/*
       * `flyouts` — the panel must not clip, because the datasets are submenus now. Safe here for
       * the reason that note gives: opting out of the scroll is only safe for a menu short enough
       * never to need it, and folding a dozen dataset rows into three took this menu from about
       * twenty rows to six. The two facts are the same change.
       */}
      <Dropdown label="New" flyouts>
        {(close) => (
          <NewMenu
            onEmpty={() => {
              newWorkflow()
              close()
            }}
            onDataset={(spec) => {
              loadStarter(spec)
              close()
            }}
            onWizard={() => {
              openWizard()
              close()
            }}
            onZoo={() => {
              openZoo()
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

      {/*
       * The way back to the start page once "Don't show again" is ticked, plus every document
       * and both tours. A menu rather than a bare button because a lone "?" says nothing about
       * what it does until you press it.
       *
       * **Six rows, two of which open a submenu.** Flat, it was nine — and nine two-line rows is
       * a wall you read rather than scan, in the one menu whose whole job is to be scannable by
       * somebody who is already lost. The two groupings are the two questions actually being
       * asked ("show me around" and "where is it written down"), and both are collapsed rather
       * than only the second, because a menu with one submenu in it reads as an afterthought.
       *
       * The rows run from "I am lost" to "I know what I want": the way back to the start page,
       * then the two groups that teach, then the two cards a reader looks something up in — and
       * last, once none of those was it, somewhere to say so. See the note above Data & Privacy
       * for the rule this replaced.
       *
       * `flyouts` turns off the panel's own `overflow-y`, which would otherwise clip the
       * submenus — see the note on `Dropdown`.
       */}
      <Dropdown label="?" title="Help" tour="help" flyouts>
        {(close) => (
          <>
            {/*
             * First, because it is the way back to the thing somebody ticked "Don't show again"
             * on, and the row a reader who is merely lost wants before any of the others.
             */}
            <button
              type="button"
              className="dropdown__item"
              onClick={() => {
                openStartPage()
                close()
              }}
            >
              <strong>Welcome Dialog</strong>
              <span>Quick start plus a few useful links.</span>
            </button>
            {/*
             * Beside it for the same reason it is first: this is the other way back to something
             * a reader put away, and a hint is dismissed **for good** — keyed on its own text so
             * a new workflow does not re-teach the same sentence (`ui/hints.ts`). Without a row
             * here, tidying up a canvas is irreversible; the node menu has the per-card version.
             *
             * Rendered only when there is something to restore, so it is not a permanent row
             * advertising a feature the reader has never met.
             */}
            {dismissedHints.size > 0 && (
              <button
                type="button"
                className="dropdown__item"
                onClick={() => {
                  restoreHints()
                  close()
                }}
              >
                <strong>Show Hints Again</strong>
                <span>Bring back every guidance box you have dismissed.</span>
              </button>
            )}
            {/*
             * The two "teach me" groups, adjacent and in the order somebody meets them: the
             * tours happen on this canvas, the documents open a tab and go wider.
             *
             * The tours take `short` rather than `label` — under a heading that already says
             * "Guides", "Guided Tour" stutters. See the note on `TOURS` for why the palette and
             * the start page keep the long name.
             */}
            <Submenu label="Guides" blurb="Walkthroughs, in place on this canvas.">
              {TOURS.map((tour) => (
                <button
                  key={tour.id}
                  type="button"
                  className="dropdown__item"
                  onClick={() => {
                    void startTour(tour.id)
                    close()
                  }}
                >
                  <strong>{tour.short}</strong>
                  <span>{tour.blurb}</span>
                </button>
              ))}
            </Submenu>
            {/*
             * Links rather than buttons, so they open in a new tab the ordinary way. Through
             * `BASE_URL`, since `base` is './' and an absolute path would resolve to the domain
             * root under a subpath deploy.
             *
             * Three documents, in the order somebody meets them: what Coda is, how it works,
             * then what each node does.
             */}
            <Submenu label="Documentation" blurb="Overview, Help, Contents, etc.">
              <a
                className="dropdown__item"
                href={`${import.meta.env.BASE_URL}overview.html`}
                target="_blank"
                rel="noreferrer noopener"
                onClick={close}
              >
                <strong>Overview</strong>
                <span>The highlights reel.</span>
              </a>
              <a
                className="dropdown__item"
                href={`${import.meta.env.BASE_URL}tutorial.html`}
                target="_blank"
                rel="noreferrer noopener"
                onClick={close}
              >
                <strong>Field Guide</strong>
                <span>Explains the basic concepts.</span>
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
                <span>Catalogue of all nodes</span>
              </a>
            </Submenu>
            {/*
             * The two reference cards. Both are dialogs that stay over the canvas, and both are
             * what somebody *returns* for rather than reads once — which is the whole ordering
             * principle here: the menu runs from "I am lost" to "I know what I want and need to
             * check it", and ends with the row for when none of it helped.
             *
             * This retired an earlier rule, which was that everything above `Documentation ▸`
             * acted on the canvas and everything below it opened a tab. It described the code
             * accurately and organised the menu by the wrong thing: it split the two cards a
             * reader looks *up* from the documents they sit beside, to keep a distinction about
             * what a click costs that the submenu's own blurb already makes.
             *
             * Data & Privacy before Keyboard Shortcuts: it is the one row here carrying
             * something a reader is obliged to act on, and a keymap is the more findable of the
             * two without help.
             */}
            <button
              type="button"
              className="dropdown__item"
              onClick={() => {
                requestPrivacy()
                close()
              }}
            >
              <strong>Data &amp; Privacy</strong>
              <span>How your data is handled and how to cite the datasets.</span>
            </button>
            <button
              type="button"
              className="dropdown__item"
              onClick={() => {
                requestShortcuts()
                close()
              }}
            >
              <strong>Keyboard Shortcuts</strong>
              <span>Every key and canvas gesture, on one card.</span>
            </button>
            {/*
             * Last, and deliberately after everything it might have been an alternative to: the
             * reader who still wants this has been past the tours, the documents and both cards,
             * which is exactly the reader whose "this is missing" is worth having. Above the
             * groups it competed with them — the loudest row in the menu offering to take a
             * question that the row below it answers.
             */}
            <button
              type="button"
              className="dropdown__item"
              onClick={() => {
                requestFeedback('general')
                close()
              }}
            >
              <strong>Give Feedback</strong>
              <span>Bug reports, feature requests, or just say hi.</span>
            </button>
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
        data-tour="share"
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
        data-tour="assistant"
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
        data-tour="inspector"
        onClick={() => togglePanel('inspector')}
        title={inspectorOpen ? 'Hide the inspector (I)' : 'Show the inspector (I)'}
        aria-label="Inspector"
      >
        <InspectorIcon />
      </button>

      {/*
       * The dashboard toggle. Beside the inspector's rather than in a menu, because it is the
       * same kind of control — which surface you are looking through — and because a mode with
       * no visible way back is a mode people get stuck in. `aria-pressed` says which way the
       * click goes; the dashboard's own bar carries a ← Canvas as well.
       */}
      <button
        type="button"
        className="btn btn--ghost"
        data-tour="dashboard"
        aria-pressed={dashboardOpen}
        onClick={toggleDashboard}
        title={
          dashboardOpen
            ? 'Back to the canvas (D)'
            : 'Dashboard — the nodes worth looking at, on a grid (D)'
        }
        aria-label="Dashboard"
      >
        ▦
      </button>

      {busy ? (
        <button
          type="button"
          className="btn"
          data-tour="run"
          onClick={cancelRun}
          title="Cancel the running graph"
        >
          Cancel
        </button>
      ) : (
        <button
          type="button"
          className="btn btn--primary"
          data-tour="run"
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
       * Next to Run because it is a statement about the same action: whether it happens on its
       * own. A real checkbox rather than a toggle button — this is a persistent setting with an
       * on and an off, not a command.
       */}
      <label
        className="autorun"
        data-tour="autorun"
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

      {/*
       * Clear is *after* Run because it is about the same thing from the other end — Run brings
       * the stale nodes up to date, Clear makes every node stale again — and reading it before
       * Run put a destructive verb in front of the button people are aiming for. Ghost, not
       * primary, so the pair does not read as two equal choices.
       */}
      <button
        type="button"
        className="btn btn--ghost"
        onClick={clearResults}
        disabled={busy}
        title="Drop every cached result so the next run re-fetches from scratch"
      >
        Clear
      </button>

      <NotifyToggle />

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

/** The floor in the words the tooltips use. Derived from a constant, so not per render. */
const NOTIFY_FLOOR_SECONDS = Math.round(NOTIFY_AFTER_MS / 1000)

/**
 * The bell: whether a run finishing on a tab nobody is watching raises a browser notification.
 *
 * Beside Run because that is what it is about. The mechanism, and why the tab's title is
 * rewritten whether or not this is on, are in `ui/notify.ts` — including the two rules that
 * shape this control and are not obvious from it: the click has to *be* the permission prompt,
 * because `requestPermission` is refused outside a user gesture; and a refusal is permanent from
 * this side, so `bellState` reads the browser's answer alongside the stored preference rather
 * than trusting the preference alone.
 *
 * The permission is held in local state rather than read on each render because reading it is
 * the only way to learn it: it moves when we ask, and the one other way it moves — the user
 * relenting in browser settings — raises nothing anywhere.
 */
function NotifyToggle() {
  const notifyRuns = useGraphStore((s) => s.notifyRuns)
  const setNotifyRuns = useGraphStore((s) => s.setNotifyRuns)
  const setNotice = useGraphStore((s) => s.setNotice)
  const [permission, setPermission] = useState<NotifyState>(() => notifyState())

  const { on, blocked } = bellState(notifyRuns, permission)

  // Both blocked arms end the same way, and that sentence is the point of saying anything at
  // all: a struck-through bell on its own reads as "nothing will tell you anything", which is
  // not true — the tab title still changes.
  const title = blocked
    ? `${
        permission === 'unsupported'
          ? 'This browser will not show notifications for this page.'
          : 'Notifications are blocked for this site — allow them in your browser settings.'
      } The tab title still changes when a run finishes.`
    : on
      ? `Notifying you when a run over ${NOTIFY_FLOOR_SECONDS}s finishes while you are looking elsewhere. Click to stop.`
      : `Notify me when a run over ${NOTIFY_FLOOR_SECONDS}s finishes while I am looking elsewhere`

  return (
    <button
      type="button"
      className="btn btn--ghost btn--icon"
      aria-pressed={on}
      disabled={blocked}
      onClick={() => {
        // Granted covers both directions: `on` implies granted, so this is the plain toggle and
        // everything below it is the one-time ask.
        if (permission === 'granted') {
          setNotifyRuns(!on)
          // Every time it is switched on, not only the first time permission was given — the
          // ask below is skipped entirely once a browser remembers the grant, and that is the
          // path somebody re-testing this takes.
          if (!on) showTestNotification()
          return
        }
        void requestNotifyPermission().then((next) => {
          setPermission(next)
          if (next === 'granted') {
            setNotifyRuns(true)
            // One now, while they are looking. Granting permission is otherwise the only step
            // in this feature with no visible result, and the next notification is a long run
            // away on a tab they have left — so a chain broken anywhere (a Focus mode, the
            // browser not allowed to post at the OS level) presents as silence much later,
            // which reads as the feature not working rather than as the machine refusing.
            showTestNotification()
            setNotice(
              `Notifications on — runs over ${NOTIFY_FLOOR_SECONDS}s will say so while you are away`,
            )
          } else if (next === 'denied') {
            setNotice('This browser blocked notifications for Coda')
          } else {
            /*
             * Still `default`: the prompt was dismissed rather than answered, or the browser
             * never showed it — Chrome's "quieter notification permissions" demotes it to an
             * icon in the address bar, and Firefox can be set to suppress it outright. All
             * three resolve here, and without this the click is a silent no-op, which reads as
             * the button being broken. Asking again is allowed from `default`, so say so.
             */
            setNotice('Notifications were not allowed yet — click the bell again to ask')
          }
        })
      }}
      // Named for a screen reader, and named for what pressing it would *do* rather than for
      // what it currently is — the same call every other toggle in this toolbar makes.
      aria-label={on ? 'Turn off run notifications' : 'Notify me when a run finishes'}
      title={title}
    >
      <BellIcon slashed={blocked} />
    </button>
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
/**
 * The New menu: the three ways to start something that is not a file.
 *
 * **Empty, then the two that produce a workflow, then the datasets.** The order is how much the
 * app decides for you — nothing, a whole pipeline, or a dataset to browse — and the rules between
 * them are that statement. The wizard and the Zoo used to be a `Workflows` menu of their own,
 * which put two rows behind a top-level button while "New" sat beside it meaning the same thing:
 * where do I begin.
 *
 * **The datasets are submenus, one per backend.** Flat, they were a dozen rows under four
 * headings and the menu needed a scrollbar — the state where a heading is a thing you scroll past
 * rather than a thing you choose. A backend is a real choice (it decides what a dataset node can
 * *do*, which is what `SourceCapabilities` is about), so it is worth a row of its own, and the
 * blurb lists what is inside so the choice can be made without opening it.
 *
 * **Nothing here offers the synthetic dataset.** It is what the Workflow Wizard's first question
 * opens on, which is a better place for it: a demo dataset is worth reaching for when you want a
 * *pipeline* to look at, and "New ▸ Demo Data" was offering it as though it were somewhere to
 * begin real work. Dropping it empties the mock backend's group, which is why the groups are
 * filtered — a heading with nothing under it is worse than no heading.
 */
function NewMenu({
  onEmpty,
  onDataset,
  onWizard,
  onZoo,
}: {
  onEmpty: () => void
  onDataset: (spec: StarterSpec) => void
  onWizard: () => void
  onZoo: () => void
}) {
  const groups = useMemo(() => {
    /*
     * Grouped by **backend**, not by source id, and the difference only shows on CATMAID.
     * Everywhere else the two coincide — every neuPrint family is on the `neuprint` source — but
     * a CATMAID source is keyed on the *server*, so FAFB and L1 are two sources and grouping on
     * that put a second submenu reading `CATMAID (l1em.catmaid.virtualflybrain.org)` beside the
     * first. What the row answers is "which backend am I looking at".
     *
     * Only the families offered as a starting point — see `DatasetFamily.starter` — and not the
     * synthetic ones, which the wizard opens on instead. Every dataset node stays in
     * `Add ▸ Dataset`; what this list decides is where somebody *begins*.
     *
     * The key list is the **union** of both tables rather than the families' alone, which is
     * what gives a backend with no starter family a row of its own: the state any backend is in
     * before its family table has an entry, and the state one lands in if every family it has is
     * later marked `starter: false`. A backend's escape hatch then goes under that backend's own
     * row rather than into a trailing "Other", which would sort every custom node away from the
     * datasets it is a custom version *of*. A backend with neither is dropped, which is what
     * removing the synthetic dataset does to the mock one.
     */
    const families = starterFamilies().filter((family) => !family.synthetic)
    const backends = [...new Set([...families, ...CUSTOM_DATASET_NODES].map((e) => e.backend))]
    return backends
      .map((backend) => ({
        backend,
        label: BACKENDS[backend]?.heading || BACKENDS[backend]?.label || backend,
        families: families.filter((family) => family.backend === backend),
        custom: CUSTOM_DATASET_NODES.filter((entry) => entry.backend === backend),
      }))
      .filter((group) => group.families.length + group.custom.length > 0)
  }, [])

  return (
    <>
      <button type="button" className="dropdown__item" onClick={onEmpty}>
        <strong>Empty</strong>
        <span>Start building on an empty canvas</span>
      </button>

      {/*
       * Both rows produce a whole workflow, which is what separates them from Empty above and
       * from a dataset below. Within the pair the order is the same rule the Zoo has always
       * drawn: the wizard builds locally and instantly, the row under it goes to a public
       * repository over the network.
       */}
      <div className="dropdown__group">
        <button type="button" className="dropdown__item" onClick={onWizard}>
          {/* The `…` is this surface's convention for a row that opens a dialog; the name and
              the blurb come from `WIZARD_LABEL`/`WIZARD_BLURB`, so the four surfaces offering
              the same thing cannot drift apart — which they already had. */}
          <strong>{WIZARD_LABEL}…</strong>
          <span>{WIZARD_BLURB}</span>
        </button>
        <button type="button" className="dropdown__item" onClick={onZoo}>
          <strong>Browse Workflows…</strong>
          <span>Search the Coda Zoo — real workflows shared by other users.</span>
        </button>
      </div>

      <div className="dropdown__group">
        {groups.map((group) => (
          <Submenu
            key={group.backend}
            label={group.label}
            /* The contents, listed. Derived rather than described, so a family added to the
               table cannot leave this row claiming something else. */
            blurb={group.families.map((family) => family.label).join(' · ')}
          >
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
          </Submenu>
        ))}
      </div>
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
  const openDocument = useGraphStore((s) => s.openDocument)

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
            if (result) openDocument(result.graph, result.warnings)
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

  const name = graphName(graph)
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
  tour,
  flyouts,
  children,
}: {
  label: string
  /** Accessible name and tooltip, for a trigger whose label is a glyph rather than a word. */
  title?: string
  /** Fired on the transition to open — the seam for a menu whose contents have to be fetched. */
  onOpen?: () => void
  /** `data-tour` name, for a menu the Guided Tour points at. See `tour/steps.ts`. */
  tour?: TourAnchor
  /**
   * This menu contains a `Submenu`, so the panel must not clip.
   *
   * `.dropdown__panel` sets `overflow-y: auto` for the long menus (New, Open, Save), and
   * `overflow-y` on a box makes `overflow-x` compute to `auto` as well — so a flyout positioned
   * at `left: 100%` renders *inside a scrollbar*, or not at all. Opting out is safe only for a
   * menu short enough never to need the scroll, which is the same menu short enough to want
   * submenus. Not inferred from the children: the panel is a render prop, so nothing here can
   * see what is in it until it is too late to style.
   */
  flyouts?: boolean
  children: (close: () => void) => React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])

  useDismissOnOutside(ref, close, { enabled: open })

  return (
    <div className="dropdown" ref={ref} data-tour={tour}>
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
      {open && (
        <div className={`dropdown__panel${flyouts ? ' dropdown__panel--flyouts' : ''}`}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

/**
 * One row of a `Dropdown` that opens a panel of its own beside it.
 *
 * **Hover opens it and click toggles it, and both are needed.** Hover alone is unreachable by
 * touch and by keyboard; click alone makes a pointer user press twice to read a menu that is
 * already under the cursor. The flyout is a *child* of the row's wrapper and butts against it
 * with no gap, so travelling from the row into it never leaves the wrapper and `pointerleave`
 * never fires mid-journey — a gap here is the classic submenu that closes as you reach for it.
 *
 * Focus opens it too, and `relatedTarget` distinguishes moving *between* children (stay open)
 * from leaving altogether (close), since `focusout` fires on every hop inside. **That path is
 * currently unreachable, and not because of anything here:** `Editor.tsx` binds Tab globally to
 * the node browser and exempts only text fields, so Tab inside any toolbar menu opens the
 * browser rather than moving through the rows — measured in a browser against the untouched
 * Examples menu (since replaced), so it is app-wide and predates submenus. The handling stays because it is
 * correct and becomes live the moment that guard learns about open menus.
 */
function Submenu({
  label,
  blurb,
  children,
}: {
  label: string
  blurb: string
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  /**
   * Which side the flyout is on, decided from a real rect on each open.
   *
   * The `?` menu sits mid-toolbar, so at an ordinary window width the right side is free — but
   * the toolbar is not fixed-width and the panel is 260px, so on a narrow window the flyout ran
   * off the viewport with no scrollbar to reach it by. Measured rather than guessed at a
   * breakpoint, because what matters is where this particular menu ended up, which depends on
   * how wide the graph's name rendered.
   */
  const [flip, setFlip] = useState(false)

  useLayoutEffect(() => {
    if (!open) return
    const row = ref.current?.getBoundingClientRect()
    const panel = ref.current?.querySelector('.dropdown__flyout')?.getBoundingClientRect()
    if (!row || !panel) return
    setFlip(row.right + panel.width > window.innerWidth - 8)
  }, [open])

  return (
    <div
      className="dropdown__sub"
      ref={ref}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!ref.current?.contains(event.relatedTarget)) setOpen(false)
      }}
    >
      <button
        type="button"
        className="dropdown__item dropdown__item--parent"
        aria-haspopup="true"
        aria-expanded={open}
        /*
         * Opens, and deliberately does not toggle.
         *
         * A toggle looked right and was wrong in all three input paths, because in every one of
         * them something has *already* opened the flyout by the time the click lands: a pointer
         * hovered, a keyboard focused, a tap fired `pointerenter` first. So Enter on the row a
         * keyboard user had just opened closed it again, and a tap opened and shut it in one
         * gesture. Closing belongs to leaving — `pointerleave`, blur, or dismissing the menu —
         * and this stays as the fallback for the browsers that fire neither (Safari does not
         * focus a button on click).
         */
        onClick={() => setOpen(true)}
      >
        <strong>{label}</strong>
        <span>{blurb}</span>
      </button>
      {open && (
        <div
          className={`dropdown__panel dropdown__panel--flyouts dropdown__flyout${
            flip ? ' dropdown__flyout--left' : ''
          }`}
        >
          {children}
        </div>
      )}
    </div>
  )
}
