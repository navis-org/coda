import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { CodaGraph } from '../../core/graph'
import { canExportNotebook } from '../../export/canExport'
import type { ExportLanguage } from '../../nodes/lib/datasetFamilies'
import { CodaMark } from '../CodaMark'
import { peekExportWarnings, requestExportWarnings, useExportWarnings } from '../exportWarnings'
import { AssistantIcon, BellIcon, ConnectionsIcon, InspectorIcon, ShareIcon } from '../Icons'
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
import { shortcutKeys } from '../shortcuts'
import { useDismissOnOutside } from '../useDismiss'
import { useNarrowShell } from '../smallScreen'

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

  /*
   * The narrow shell — see `smallScreen.ts` for the threshold and `App` for the attribute the
   * stylesheet reads. Everything below that asks this is choosing *where* a control is drawn,
   * never whether it exists: each one is either a button on the row or a row of the `⋯` menu.
   */
  const narrow = useNarrowShell()
  const openSources = useGraphStore((s) => s.openSources)

  /*
   * The controls that fold, declared once and rendered twice.
   *
   * Two renderers read this — `ActionButton` for the row, `ActionItem` for the `⋯` menu — which
   * is what stops the phone's copy of the toolbar drifting from the desktop's. It is the same
   * rule `shortcuts.ts` follows for a chord and `glyphs.ts` for a drawing: the fact is declared
   * in one place and each surface renders it. What is *not* here is anything with state of its
   * own or a shape a menu row cannot take — Run, the workflow name, Auto-run and the bell each
   * keep their own component, and the last three take a `variant` instead.
   *
   * `blurb` is the second line of a menu row. It says what the control does rather than
   * repeating `title`, which is a tooltip nobody on a touchscreen will ever see.
   */
  const actions = {
    undo: {
      label: 'Undo',
      blurb: 'Step back through your edits.',
      face: '↶',
      title: locked ? lockedTitle('Undo') : `Undo (${shortcutKeys('undo')})`,
      disabled: locked || !canUndo,
      onClick: undo,
    },
    redo: {
      label: 'Redo',
      blurb: 'Step forward again.',
      face: '↷',
      title: locked ? lockedTitle('Redo') : `Redo (${shortcutKeys('redo')})`,
      disabled: locked || !canRedo,
      onClick: redo,
    },
    share: {
      label: 'Share workflow',
      blurb: 'A link that opens this graph.',
      face: <ShareIcon />,
      title: 'Share workflow — a link that opens this graph',
      icon: true,
      tour: 'share',
      onClick: requestShare,
    },
    /*
     * The trigger for `SourcesPanel`'s dialog, which is why it is here rather than there: the
     * `⋯` menu closes on the click that opens the dialog, so a trigger living inside the panel
     * component would take the dialog down with the menu. `EdgeSetPanel` has had this shape
     * from the start — the dialog is mounted by the toolbar and opened through the store.
     */
    connections: {
      label: 'Connections',
      blurb: 'Data sources, API keys and sharing.',
      face: <ConnectionsIcon />,
      title: 'Connections — data sources, API keys and sharing',
      icon: true,
      tour: 'connections',
      onClick: openSources,
    },
    assistant: {
      label: 'Assistant',
      blurb: 'Describe a change and let it build it.',
      face: <AssistantIcon />,
      title: `Assistant — describe a change and let it build it (${shortcutKeys('assistant')})`,
      icon: true,
      tour: 'assistant',
      pressed: assistantOpen,
      onClick: () => togglePanel('assistant'),
    },
    inspector: {
      label: 'Inspector',
      blurb: "The selected node's settings, in full.",
      face: <InspectorIcon />,
      title: inspectorOpen
        ? `Hide the inspector (${shortcutKeys('inspector')})`
        : `Show the inspector (${shortcutKeys('inspector')})`,
      icon: true,
      tour: 'inspector',
      pressed: inspectorOpen,
      onClick: () => togglePanel('inspector'),
    },
    dashboard: {
      label: 'Dashboard',
      blurb: 'The nodes worth looking at, on a grid.',
      face: '▦',
      title: dashboardOpen
        ? `Back to the canvas (${shortcutKeys('dashboard')})`
        : `Dashboard — the nodes worth looking at, on a grid (${shortcutKeys('dashboard')})`,
      tour: 'dashboard',
      pressed: dashboardOpen,
      onClick: toggleDashboard,
    },
    clear: {
      label: 'Clear results',
      blurb: 'Drop every cached result so the next run re-fetches.',
      face: 'Clear',
      title: 'Drop every cached result so the next run re-fetches from scratch',
      disabled: busy,
      onClick: clearResults,
    },
    // No `blurb`: this one stays on the row at every width, so nothing ever draws it as a menu
    // row. See the field's note.
    fullscreen: {
      label: fullscreen ? 'Leave fullscreen' : 'Enter fullscreen',
      face: fullscreen ? '⤡' : '⛶',
      title: fullscreen
        ? `Leave fullscreen (${shortcutKeys('fullscreen')})`
        : `Fill the screen, hiding the browser's own tabs and address bar (${shortcutKeys(
            'fullscreen',
          )})`,
      pressed: fullscreen,
      onClick: () => {
        // `fullscreen` is what distinguishes a refusal from an ordinary exit — both come
        // back false, and only one of them is worth saying anything about.
        const entering = !fullscreen
        void toggleFullscreen(appElement()).then((now) => {
          if (entering && !now) setNotice('This browser refused fullscreen')
        })
      },
    },
    theme: {
      label: 'Theme',
      blurb: `Currently ${theme}. Cycles dark, light, system.`,
      face: theme === 'dark' ? '◐' : theme === 'light' ? '◑' : '◒',
      title: `Theme: ${theme}`,
      onClick: () =>
        setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark'),
    },
    // `satisfies` rather than an annotation: each entry is still checked against the shape, and
    // the keys stay literal, so `actions.dashbord` is a compile error rather than `undefined`
    // handed to a renderer that would draw an empty button.
  } satisfies Record<string, ToolbarAction>

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

      {/* On the narrow shell it is the first row of the `⋯` menu instead — 140px of text field
          is the widest thing here and the least often touched. */}
      {!narrow && <GraphNameField value={graph.meta?.name ?? ''} onChange={setGraphName} />}

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

      {!narrow && (
        <>
          <span style={{ width: 8 }} />
          <ActionButton action={actions.undo} />
          <ActionButton action={actions.redo} />
        </>
      )}

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
       *
       * All five fold into `⋯` on the narrow shell, in this order.
       */}
      {!narrow && (
        <>
          <ActionButton action={actions.share} />
          <ActionButton action={actions.connections} />
          <ActionButton action={actions.assistant} />
          <ActionButton action={actions.inspector} />
          <ActionButton action={actions.dashboard} />
        </>
      )}

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
       *
       * Clear is *after* Run because it is about the same thing from the other end — Run brings
       * the stale nodes up to date, Clear makes every node stale again — and reading it before
       * Run put a destructive verb in front of the button people are aiming for. Ghost, not
       * primary, so the pair does not read as two equal choices.
       */}
      {!narrow && (
        <>
          <AutoRunToggle checked={autoRun} onChange={setAutoRun} />
          <ActionButton action={actions.clear} />
          <NotifyToggle />
        </>
      )}

      {/*
       * Fullscreen keeps the toolbar and the status bar: what it reclaims is the browser's
       * ~90px of tabs and address bar, not the app's own chrome. Run, Auto-run and the stale
       * count are exactly what you want in view while a graph is running.
       *
       * **The one control that earns its place on a phone rather than despite being one.** A
       * mobile browser's chrome is ~56px of a ~915px screen and it comes back on every scroll
       * gesture; fullscreen is how the canvas gets it, which is why this stays on the row when
       * everything beside it folds away.
       */}
      <ActionButton action={actions.fullscreen} />
      {!narrow && <ActionButton action={actions.theme} />}

      {/*
       * The rest of the toolbar, on the narrow shell. Last on the row, and everything in it is
       * `actions` rendered the other way — see the table for why there are two renderers.
       *
       * No `Submenu` anywhere in here, deliberately: a flyout opens at `left: 100%` of a 260px
       * panel, which on a 412px screen is off the edge in one direction and, flipped, off it in
       * the other. That is also why New, Open, Save and `?` stay on the row rather than folding
       * in — three of them are menus of their own, and a menu inside this one is unreachable.
       */}
      {narrow && (
        <Dropdown label="⋯" title="More toolbar controls">
          {(close) => (
            <>
              <div className="dropdown__row">
                <GraphNameField value={graph.meta?.name ?? ''} onChange={setGraphName} />
              </div>
              <ActionItem action={actions.undo} close={close} />
              <ActionItem action={actions.redo} close={close} />
              <ActionItem action={actions.share} close={close} />
              <ActionItem action={actions.connections} close={close} />
              <ActionItem action={actions.assistant} close={close} />
              <ActionItem action={actions.inspector} close={close} />
              <ActionItem action={actions.dashboard} close={close} />
              {/* Not a command — it stays put when ticked, like the field above it. */}
              <div className="dropdown__row">
                <AutoRunToggle checked={autoRun} onChange={setAutoRun} />
              </div>
              <ActionItem action={actions.clear} close={close} />
              <NotifyToggle variant="item" close={close} />
              <ActionItem action={actions.theme} close={close} />
            </>
          )}
        </Dropdown>
      )}

      {/*
       * Two dialogs with no trigger of their own: Connections is opened from `actions`, the edge
       * set panel from a dataset card. Mounted here because a modal inside React Flow's
       * transformed pane takes the transform as its containing block — and, for Connections,
       * because a trigger inside the `⋯` menu would be unmounted by the click that used it.
       */}
      <SourcesPanel />
      <EdgeSetPanel />
    </div>
  )
}

// ---------------------------------------------------------------------------
// The controls that fold
// ---------------------------------------------------------------------------

/**
 * One toolbar control, in the form both renderers can read.
 *
 * The split between what is in here and what is not is about the *shape* a menu row can take,
 * not about importance or state: Run carries a stale badge, the workflow name is a text field
 * and Auto-run is a checkbox, so those three keep their own components. Holding state is not a
 * reason to stay out — `NotifyToggle` keeps its `useState` and builds a descriptor from it.
 *
 * **Not `paletteItems.ts`, which is the other command table**, and the overlap is real: undo,
 * redo, share, clear, dashboard, fullscreen and theme are in both. They stay apart because they
 * are written for different readers — the palette is searched by typing, so its labels are Title
 * Case nouns and its hints are sentences; these are read as a tooltip on a glyph or as one line
 * of a menu. Merging them would mean one string trying to be both. What must not drift is the
 * *behaviour*, and that does not live in either table: both call the same store actions.
 */
interface ToolbarAction {
  /**
   * The menu row's first line, **and** the button's accessible name.
   *
   * One field for both because they are the same sentence: an icon button's name is what a
   * menu row's first line already has to be — short, a verb phrase, read without the glyph
   * beside it. Splitting them is how a control comes to be called two things, and the name is
   * the half nothing on screen would show you was wrong.
   */
  label: string
  /**
   * The menu row's second line: what the control does. Never a repeat of `title`.
   *
   * Optional, and the absence says something — a control with no blurb is one that never folds,
   * which today is fullscreen alone. Anything reached through `⋯` needs one.
   */
  blurb?: string
  /** What the button draws — an icon element, or the glyph or word it carries. */
  face: React.ReactNode
  /** The button's tooltip and, where `face` is a glyph, its accessible name. */
  title: string
  /** `btn--icon`, for the ones drawing an SVG rather than a glyph. */
  icon?: boolean
  /** `data-tour` name, for a control the Guided Tour points at. See `tour/steps.ts`. */
  tour?: TourAnchor
  pressed?: boolean
  disabled?: boolean
  onClick: () => void
}

/**
 * A control on the toolbar row.
 *
 * `aria-label` is the **label**, not the title: the title is a tooltip that names the shortcut
 * and the direction of the next click, which is a poor name to hear read aloud. On a control the
 * tour points at, the anchor rides here — so a control folded into `⋯` has no anchor at all, and
 * `tour.ts` centres that step's popover rather than spotlighting nothing.
 */
function ActionButton({ action }: { action: ToolbarAction }) {
  return (
    <button
      type="button"
      className={`btn btn--ghost${action.icon ? ' btn--icon' : ''}`}
      data-tour={action.tour}
      title={action.title}
      aria-label={action.label}
      aria-pressed={action.pressed}
      disabled={action.disabled}
      onClick={action.onClick}
    >
      {action.face}
    </button>
  )
}

/**
 * The same control as a row of the `⋯` menu.
 *
 * Closing is this renderer's business rather than the action's: every one of these is a command,
 * and a menu that stayed open over the dialog it just opened would be covering it. The two that
 * are *not* commands — the workflow name and Auto-run — are rendered as themselves in a
 * `.dropdown__row` instead, which is what keeps that rule from needing an exception.
 */
function ActionItem({ action, close }: { action: ToolbarAction; close: () => void }) {
  return (
    <button
      type="button"
      className="dropdown__item"
      aria-pressed={action.pressed}
      disabled={action.disabled}
      onClick={() => {
        action.onClick()
        close()
      }}
    >
      <strong>{action.label}</strong>
      {action.blurb && <span>{action.blurb}</span>}
    </button>
  )
}

/**
 * The workflow's name. The same element in both places — on the row, and as the first row of the
 * `⋯` menu — so the placeholder, the tooltip and the width rules have one spelling. What differs
 * is `.dropdown__row`'s CSS, which lets it fill the panel.
 */
function GraphNameField({
  value,
  onChange,
}: {
  value: string
  onChange: (next: string) => void
}) {
  return (
    <input
      className="toolbar__name"
      value={value}
      placeholder="Untitled graph"
      onChange={(e) => onChange(e.target.value)}
      title="Graph name — used as the filename when saving"
    />
  )
}

/** Auto-run, likewise the same checkbox in both places. */
function AutoRunToggle({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <label
      className="autorun"
      data-tour="autorun"
      title={
        checked
          ? 'Re-running the whole graph after every change. Uncheck for expensive workflows.'
          : 'Re-run the whole graph after every change. Expensive nodes will query on every edit.'
      }
    >
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>Auto-run</span>
    </label>
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
function NotifyToggle({
  variant = 'button',
  close,
}: {
  /**
   * `item` draws it as a row of the `⋯` menu instead. A prop rather than a `ToolbarAction`
   * descriptor because of the local state below: the browser's answer is learned by asking, and
   * asking is this component's click.
   */
  variant?: 'button' | 'item'
  close?: () => void
}) {
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

  const ask = () => {
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
  }

  /*
   * A descriptor like every other folding control, built here rather than in the toolbar's table
   * because the browser's answer is learned by *asking* and asking is this component's click.
   * That is the only thing local about it — the markup is `ActionButton`'s and `ActionItem`'s,
   * so a change to a menu row's shape reaches the bell too. Written out by hand, it did not.
   *
   * Named for what pressing it would *do* rather than for what it currently is, which is the
   * call every other toggle in this toolbar makes. The blurb is the tooltip: on a touchscreen
   * there is no hover, so a control whose state lives in a `title` has no visible state at all.
   */
  const action: ToolbarAction = {
    label: on ? 'Turn off run notifications' : 'Notify me when a run finishes',
    blurb: title,
    face: <BellIcon slashed={blocked} />,
    title,
    icon: true,
    pressed: on,
    disabled: blocked,
    onClick: ask,
  }

  return variant === 'item' ? (
    <ActionItem action={action} close={close ?? noop} />
  ) : (
    <ActionButton action={action} />
  )
}

/** For the bell as a row: `ActionItem` always closes, and a caller outside a menu has nothing
    to close. */
const noop = () => {}

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

/** The margin a menu keeps from the window's edge. One number, both menus. */
const MENU_GUTTER = 8

export interface MenuFit {
  /** The panel's own width — content-driven above `min-width`, so it has to be measured. */
  width: number
  rowLeft: number
  rowRight: number
  viewport: number
}

/**
 * The numbers a menu needs to decide where to open, measured from real rects once it is open.
 *
 * Measuring rather than deciding at a breakpoint, because what matters is where *this* menu
 * ended up — which depends on how wide the workflow's name rendered — and how wide its panel
 * turned out. In a `useLayoutEffect`, so a correction lands before paint rather than as a flash.
 *
 * It answers with numbers rather than a placement because the two callers ask different
 * questions of them: a top-level panel hangs *from* an edge of its trigger, a flyout opens
 * *beside* the row, and only one of the two has an inline fallback. Those decisions sit at the
 * call sites; what is shared, and was written out twice before, is this.
 */
/**
 * How far to shift a top-level menu's panel so it stays inside the window, in px from where it
 * would otherwise open — which is its trigger's left edge.
 *
 * A *shift*, not a flip, and the difference is the bug this replaced. Anchoring to the trigger's
 * right edge instead is only a second fixed position, so a panel that fits neither is placed at
 * whichever edge was asked about last: `Save` opened at **-110** on a 412px screen, 110px off the
 * left, where staying put would have been 52px off the right. But a menu panel is 260–315px and
 * a phone is 375–412 — it *fits*, just not aligned to either edge of a trigger two thirds of the
 * way along the row. So the answer is neither edge: put it where it fits and leave it alone
 * wherever it already does, which is every window wide enough to have never had the problem.
 *
 * Pure, and exported, because it is the half a suite with no layout can pin: jsdom measures
 * nothing, so the rects have to be handed in.
 */
export function menuShift(fit: MenuFit | undefined): number {
  if (!fit) return 0
  // The furthest left it may start and still clear the far gutter — floored at the near one, so
  // a panel wider than the window overflows to the right rather than off the left, where a
  // scroll cannot reach it.
  const rightmost = Math.max(MENU_GUTTER, fit.viewport - MENU_GUTTER - fit.width)
  const wanted = Math.min(Math.max(fit.rowLeft, MENU_GUTTER), rightmost)
  return Math.round(wanted - fit.rowLeft)
}

export type FlyoutPlacement = 'right' | 'left' | 'inline'

/**
 * Where a submenu's flyout goes: right of its row, else left of it, else **under** it.
 *
 * Exported, and pure, because it is the part worth pinning and the part a test with no layout
 * can reach — jsdom measures nothing, so the numbers have to be handed in. `submenuPlacement`
 * is the whole of the geometry; the component only supplies rects.
 *
 * The third answer is what this grew. A panel is `min-width: 260px`, so a row plus a flyout is
 * 520px, and on a 412px viewport neither side fits — asked as a flip ("does the right fit? no,
 * then left") that is a choice between two impossible positions, and it picked the worse:
 * `New ▸ neuPrint` opened at **-229**, where not flipping would have been 135 past the right.
 * Two answers went wrong at 744 on a tablet as well, where the right side misses by 9px and the
 * left by 27 — so this was never a phone rule, and a breakpoint would not have caught it. Both
 * measured in a browser.
 *
 * `narrow` short-circuits ahead of the measurement rather than beside it: no shell that narrow
 * can seat a 260px panel beside a 260px one, and answering before the first render is what keeps
 * a flyout from being painted at the wrong place and corrected.
 */
export function submenuPlacement(fit: MenuFit | undefined, narrow: boolean): FlyoutPlacement {
  if (narrow) return 'inline'
  // Not measured yet: the flyout has to be somewhere to be measured, and right is where it
  // belongs whenever there is room. `useLayoutEffect` corrects it before paint.
  if (!fit) return 'right'
  if (fit.rowRight + fit.width <= fit.viewport - MENU_GUTTER) return 'right'
  if (fit.rowLeft - fit.width >= MENU_GUTTER) return 'left'
  return 'inline'
}

function useMenuFit(
  ref: React.RefObject<HTMLDivElement | null>,
  open: boolean,
  panelSelector: string,
): MenuFit | undefined {
  const [fit, setFit] = useState<MenuFit | undefined>(undefined)

  useLayoutEffect(() => {
    if (!open) return
    const row = ref.current?.getBoundingClientRect()
    const panel = ref.current?.querySelector(panelSelector)?.getBoundingClientRect()
    if (!row || !panel) return
    setFit({
      width: panel.width,
      rowLeft: row.left,
      rowRight: row.right,
      /*
       * `clientWidth`, **not `window.innerWidth`** — and the difference is the bug that made the
       * first version of this shift a panel by 8px instead of 60. On a phone `innerWidth` is the
       * visual viewport at minimum scale, so a panel hanging past the right edge widens the
       * document, the browser zooms out to fit it, and `innerWidth` grows to include the very
       * overflow being measured. The clamp then computes against the wrong window and leaves the
       * panel off screen. `documentElement.clientWidth` is the layout viewport, which does not
       * move.
       */
      viewport: document.documentElement.clientWidth,
    })
  }, [open, ref, panelSelector])

  return fit
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
  /*
   * A top-level menu opens at its trigger's left edge and is nudged back inside the window when
   * that would hang it over an edge — `menuShift` holds the reasoning. It matters here at all
   * because the narrow shell puts four menus on a 412px row, and an absolutely-positioned box
   * past the window is scrollable overflow, which is the thing that makes a phone zoom out.
   */
  const shift = menuShift(useMenuFit(ref, open, '.dropdown__panel'))

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
        <div
          className={`dropdown__panel${flyouts ? ' dropdown__panel--flyouts' : ''}`}
          /* Inline because it is a measurement, not a state: there is no class for "60px to the
             left of where you would have been". Absent whenever the panel already fits. */
          style={shift === 0 ? undefined : { left: shift }}
        >
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
  /*
   * Where the flyout opens — `submenuPlacement` holds the reasoning. Inline, it is an ordinary
   * block in the panel it is already inside, so it always fits, and the panel scrolls, having
   * nothing beside it left to clip (see `.dropdown__panel--flyouts`).
   */
  const narrow = useNarrowShell()
  const placement = submenuPlacement(useMenuFit(ref, open, '.dropdown__flyout'), narrow)
  const inline = placement === 'inline'

  /*
   * Hover is the other half of the same change. Opening on `pointerenter` is right for a flyout
   * you travel across to and wrong on a touchscreen, where there is no hover to leave and the
   * only gesture is the tap — so inline, the row is a plain toggle and nothing else opens it.
   *
   * That inverts the rule below deliberately. "Opens, and does not toggle" is true *because*
   * something has already opened the flyout by the time the click lands; with no pointer or
   * focus handler attached, nothing has, and a row that only ever opens is a row that cannot be
   * shut.
   */
  const hover = inline
    ? {}
    : {
        onPointerEnter: () => setOpen(true),
        onPointerLeave: () => setOpen(false),
        onFocus: () => setOpen(true),
        onBlur: (event: React.FocusEvent) => {
          if (!ref.current?.contains(event.relatedTarget)) setOpen(false)
        },
      }

  return (
    <div className="dropdown__sub" ref={ref} {...hover}>
      <button
        type="button"
        className="dropdown__item dropdown__item--parent"
        aria-haspopup="true"
        aria-expanded={open}
        /*
         * Opens, and deliberately does not toggle — beside its row. See `hover` above for why
         * inline is the other way round.
         *
         * A toggle looked right and was wrong in all three input paths, because in every one of
         * them something has *already* opened the flyout by the time the click lands: a pointer
         * hovered, a keyboard focused, a tap fired `pointerenter` first. So Enter on the row a
         * keyboard user had just opened closed it again, and a tap opened and shut it in one
         * gesture. Closing belongs to leaving — `pointerleave`, blur, or dismissing the menu —
         * and this stays as the fallback for the browsers that fire neither (Safari does not
         * focus a button on click).
         */
        onClick={() => setOpen(inline ? !open : true)}
      >
        <strong>{label}</strong>
        <span>{blurb}</span>
      </button>
      {open && (
        <div
          className={`dropdown__panel dropdown__panel--flyouts dropdown__flyout${
            placement === 'inline'
              ? ' dropdown__flyout--inline'
              : placement === 'left'
                ? ' dropdown__flyout--left'
                : ''
          }`}
        >
          {children}
        </div>
      )}
    </div>
  )
}
