/**
 * Editor state.
 *
 * Zustand holds the *document* (graph, selection, history). The Scheduler is a mutable
 * class kept outside the store — it owns caches of potentially large tables, and putting
 * those behind immutable state updates would mean copying references on every tick for
 * no benefit. The store instead bumps `runVersion` when scheduler state changes, and
 * components read node state through selectors that depend on it.
 *
 * Auto-evaluation is debounced: cheap nodes re-run ~180ms after you stop typing.
 * Expensive nodes are left stale by the auto pass and wait for Run.
 */

import { create } from 'zustand'

import type { CodaGraph, GraphEdge, GraphGroup, GraphNode } from '../core/graph'
import type { NodeCategory } from '../core/node'
import type { FeedbackCategory } from '../data/feedback'
import type { ApplyResult } from '../assistant/apply'
import { applyPlan } from '../assistant/apply'
import type { AssistantPlan } from '../assistant/planShape'
import {
  addEdge as addGraphEdge,
  deserializeGraph,
  graphName,
  edgeInto,
  emptyGraph,
  newId,
  serializeGraph,
  reconnectEdge,
  removeEdges,
  removeNodes,
  setNodeParam,
  updateNode,
} from '../core/graph'
import {
  addCells,
  moveCell,
  removeCells,
  setViewOpen,
  setColumns as setDashboardTracks,
  setSpan as setCellSpan,
} from '../core/dashboard'
import { createGroup, removeGroups, updateGroup } from '../core/groups'
import type { Point } from '../core/clipboard'
import {
  PASTE_OFFSET,
  fragmentFrom,
  insertFragment,
  readFragment,
  subgraphOf,
} from '../core/clipboard'
import { autoWireDataset } from '../core/autowire'
import { addNodeWithCompanion } from '../core/companion'
import type { InferenceResult } from '../core/inference'
import { checkConnection, inferGraph } from '../core/inference'
import { spliceCandidate, spliceGraph } from '../core/splice'
import type { ParamValue } from '../core/node'
import { defaultParams } from '../core/node'
import { getNodeDef, isAnnotation, requireNodeDef } from '../core/registry'
import type { IterationInfo, NodeRunInfo, RunSummary } from '../core/scheduler'
import { Scheduler } from '../core/scheduler'
import type { TableSchema } from '../core/types'
import type { Value } from '../core/values'
import { isTableValue } from '../core/values'
import { registerBuiltinSources } from '../data/builtins'
import { requireSource, subscribeSourceLearned } from '../data/source'
import { subscribeUploadLearned } from '../data/uploads'
import { subscribeEdgeSetsLearned } from '../data/edges/store'
import { subscribeAnnotationsLearned } from '../data/annotations'
import { subscribeRootCheck } from '../data/cave/rootIds'
import type { StarterSpec } from '../examples/starters'
import { buildStarter } from '../examples/starters'
import type { WorkflowSummary } from './library'
import { deleteSessionDoc, loadSession, saveSessionDoc, saveSessionMeta } from './session'
import {
  deleteWorkflow,
  findByName,
  listWorkflows,
  loadWorkflow,
  renameWorkflow,
  saveWorkflow,
} from './library'
import { hasShareFragment } from '../data/share/fragment'
/*
 * Type only, and that is the whole of the coupling: `TourId` is a union of three string
 * literals, so it erases at build time and the store links against nothing in `src/ui`. The
 * store holds which guides are finished because it is what persists them and what `tour.ts`
 * reports into; naming them `string` here would put the one place a typo could not be caught
 * next to the one place it would be silent.
 */
import type { TourId } from '../ui/tour/tourState'
import type { EdgeRouting, LayoutOptions } from '../layout/options'
import { EDGE_ROUTINGS } from '../layout/options'
import type { PanelState, ThemePreference } from './persistence'
import {
  applyTheme,
  clampDockFraction,
  loadAutoRun,
  loadDockFraction,
  loadNotifyRuns,
  tabId,
  loadActiveDocId,
  loadAutosave,
  loadLayoutPrefs,
  loadPanels,
  loadGuidesDone,
  loadGuidesSeen,
  loadWizardDashboard,
  loadWizardNotes,
  loadStartPageDismissed,
  loadTheme,
  saveAutoRun,
  saveNotifyRuns,
  saveLayoutPrefs,
  savePanels,
  saveDockFraction,
  saveActiveDocId,
  saveAutosave,
  saveGuidesDone,
  saveStartPageDismissed,
  saveWizardDashboard,
  saveWizardNotes,
  watchTabIdentity,
} from './persistence'
// Side-effect import: the store resolves node types the moment it loads the autosaved
// graph, so the node pack must be registered first. Declaring the dependency here rather
// than relying on import order in main.tsx keeps that from silently breaking.
import '../nodes'
import { nodePorts } from '../core/graph'

// Registered once, at module load. See `data/builtins.ts` for the set and the ordering.
registerBuiltinSources()

const AUTO_RUN_DELAY_MS = 180

/**
 * Debounce for the *full* auto-run, which is longer than the cheap pass on purpose.
 *
 * The cheap pass is local arithmetic, so 180ms is free. A full pass can send a query per edit, so
 * this has to outlast a burst of typing — inter-keystroke intervals sit around 150–250ms — and
 * coalesce a slider drag into one run at the end of it.
 */
const AUTO_FULL_RUN_DELAY_MS = 700
const AUTOSAVE_DELAY_MS = 800
/** Param edits closer together than this collapse into one undo step. */
const HISTORY_COALESCE_MS = 700
const HISTORY_LIMIT = 100

interface HistoryEntry {
  graph: CodaGraph
  /** Identifies coalescable edits: `param:<nodeId>:<paramId>`. */
  tag?: string
  at: number
}

/**
 * The canvas transform. Shaped like `CodaGraph.viewport` rather than imported from React Flow,
 * which `src/store` has no business depending on.
 */
export interface CanvasViewport {
  x: number
  y: number
  zoom: number
}

/**
 * One row in the workflow switcher — see `ui/panels/WorkflowTabs.tsx`.
 *
 * Deliberately *not* the document itself. The switcher needs a name and an id; the graph behind
 * it changes on every keystroke, and putting it in a snapshot the tab bar subscribes to would
 * re-render the list for edits it cannot show. Rebuilt by `syncTabs`, which compares before it
 * writes, so the array's identity moves only when a name or the set of documents does.
 */
export interface WorkflowTab {
  id: string
  /** Already defaulted — `'Untitled'` for a graph nobody has named. */
  name: string
}

/**
 * Everything about a document that is *live in the store* while it is the one on screen.
 *
 * Set aside on the way out and put back on the way in, which is what makes a switch cost nothing
 * and lose nothing.
 *
 * **Three functions and no fourth spelling.** `stashOf` reads the slice off the store, `blankDoc`
 * says what it is for a document nobody has touched, and `activate` spreads one or the other back
 * — so adding a per-document field is a type error in `DocStash` and one edit in each of the two,
 * rather than a field that silently leaks across a switch because one of six object literals
 * forgot it. `loadGraph` and `newGraph` are deliberately *not* in that set: they reset the live
 * store rather than build a stash, and `inference` is `afterGraphChange`'s there.
 *
 * Note what is **not** here: `locked` is a canvas mode rather than a fact about a document, and
 * follows the reader between them on purpose — every reload starts unlocked.
 */
interface DocStash {
  graph: CodaGraph
  /**
   * Undefined where it has not been computed yet — a document restored from the session store,
   * which nobody is looking at. `activate` computes it on the switch that needs it, so a reload
   * with five workflows open does not walk five graphs on the boot path to fill in a field no
   * surface reads until it is on screen.
   */
  inference: InferenceResult | undefined
  past: HistoryEntry[]
  future: HistoryEntry[]
  selection: string[]
  notice: string | undefined
  lastRun: RunSummary | undefined
  expandedNodeId: string | undefined
  pinnedNodeId: string | undefined
  dashboardOpen: boolean
  edgePanelNode: string | undefined
  autoLayout: boolean
}

/**
 * One open workflow, held outside the store for the reason the Scheduler already is: these are
 * mutable objects owning caches of potentially large tables, and copying references to them
 * through immutable state updates on every tick buys nothing.
 *
 * **A Scheduler each, rather than one shared.** Two documents opened from the same file carry
 * the same node ids — `deserializeGraph` does not remap them and `newId` is only unique within a
 * session — so a single cache keyed by node id would have two copies of one workflow thrashing
 * each other's entries. An instance each also makes closing a document a single `invalidateAll`,
 * which is the only thing that returns its results to the heap.
 *
 * `lastObserved` is per document for the same reason it exists at all: it is the answer to
 * "did a finished run change a shape inference could not see statically", and that question is
 * about one graph.
 */
interface DocRecord {
  id: string
  scheduler: Scheduler
  lastObserved: Record<string, TableSchema | undefined>
  /**
   * Where the canvas was left. Captured from React Flow's `onMoveEnd` rather than restored from
   * `CodaGraph.viewport`, which is a fact about the *file* and is never written back.
   *
   * Not in `DocStash`, because it is written continuously by a pan rather than at the moment of
   * a switch — a stash captured 800ms ago would put the canvas back where it was two gestures
   * before you left.
   */
  viewport: CanvasViewport | undefined
  /** Set aside while another document is active; `undefined` for the one on screen. */
  stash: DocStash | undefined
}

export interface GraphState {
  graph: CodaGraph
  inference: InferenceResult
  selection: string[]
  /** Bumped whenever scheduler node states change, to invalidate memoised selectors. */
  runVersion: number
  /**
   * Bumped when a running node publishes or drops a partial result — see `Scheduler.onPreview`.
   *
   * Its own counter rather than a second use of `runVersion`, because of who has to subscribe.
   * `runVersion` is read by selectors that already return something that moves with it (a node's
   * own state, a stale count); a card drawing from its *inputs* has no such thing — the 3D
   * viewer's own output and state are unchanged while its upstream fills in, so nothing it
   * selects would differ and zustand would skip the render. `void s.runVersion` inside a selector
   * subscribes to nothing on its own: the comparison is on what the selector *returns*.
   *
   * So this is selected directly, as the primitive invariant 7 requires. Every card re-renders
   * when it moves, which is why `PUBLISH_INTERVAL_MS` bounds how often that can be.
   */
  previewVersion: number
  past: HistoryEntry[]
  future: HistoryEntry[]
  /** Transient messages (load warnings, run failures) shown in the status bar. */
  notice: string | undefined
  lastRun: RunSummary | undefined
  busy: boolean
  /**
   * Asks the canvas to open the command palette. The palette lives inside the React Flow
   * provider (it needs screen→flow coordinates) but the toolbar buttons are outside it, so
   * this is the seam. `seq` increments so repeat requests still fire.
   */
  paletteRequest: { seq: number; initialQuery: string }
  requestPalette(initialQuery?: string): void
  /**
   * Separate signal for the big add-node browser. Distinct from `paletteRequest` because
   * they are different widgets serving different intents, not two modes of one.
   */
  browserRequest: number
  requestNodeBrowser(): void
  /**
   * Asks for the Share dialog.
   *
   * A third counter rather than local state in the toolbar, because two surfaces open it — the
   * Save menu and the command palette — and the palette closes on pick, so it has nowhere to
   * hold a dialog of its own. Same idiom, same mount-seeded guard.
   */
  shareRequest: number
  requestShare(): void
  /**
   * Asks for the Keyboard Shortcuts dialog.
   *
   * A fourth counter, for the same reason as `shareRequest`: the `?` menu and the command
   * palette both open it, and both close on pick.
   */
  shortcutsRequest: number
  requestShortcuts(): void
  /**
   * Asks for the Data & Privacy dialog.
   *
   * Same idiom again, and a dialog rather than a page for `ShortcutsDialog`'s reason: both
   * questions it answers — where does my work live, and who do I have to cite — are asked
   * *while* looking at a graph, and the three documents in the `?` menu all navigate away.
   */
  privacyRequest: number
  requestPrivacy(): void
  /**
   * Asks for the Feedback dialog, on whichever tab the caller means.
   *
   * A fifth counter, same idiom as `shareRequest` and `shortcutsRequest`: the `?` menu, the
   * command palette, the start page and the periodic nudge all open it, and none of them has
   * anywhere to hold a dialog of its own.
   */
  feedbackRequest: { seq: number; category: FeedbackCategory }
  requestFeedback(category?: FeedbackCategory): void
  /**
   * Asks the canvas to frame the whole graph.
   *
   * Bumped by `loadGraph`, so opening a file, an example or a starter lands on the work rather
   * than wherever the previous graph's viewport happened to be — which, for a graph laid out
   * somewhere else entirely, is an empty canvas that reads as "nothing loaded". Only the canvas
   * can do it: the viewport belongs to React Flow, and every trigger for it is outside the
   * provider.
   *
   * A counter with a mount-seeded guard, for the same reason `browserRequest` is one.
   */
  fitRequest: number
  requestFitView(): void
  /** Theme preference. In the store because both the toolbar and the palette set it. */
  theme: ThemePreference
  setTheme(theme: ThemePreference): void
  /**
   * Re-run the whole graph after every change, expensive nodes included.
   *
   * Off by default: it opts out of the hybrid evaluation model, whose entire purpose is that a
   * reactive editor pointed at a shared production database does not fire a query per keystroke.
   * Remembered across sessions, so an expensive workflow can be left on manual.
   */
  autoRun: boolean
  setAutoRun(enabled: boolean): void
  /**
   * Whether a long run that finishes on a tab nobody is watching may raise a browser
   * notification. The user's half of the decision only — read it through `bellState` rather
   * than as "notifications will appear". See `ui/notify.ts`.
   */
  notifyRuns: boolean
  setNotifyRuns(enabled: boolean): void
  /**
   * Re-arrange the canvas after every *structural* change — a node added or deleted, a wire
   * connected, a card collapsed or resized. Params are not structural, so typing never moves
   * anything.
   *
   * Two things turn it off, and both are the same rule: a position somebody chose outranks one
   * ELK computed. Dragging a node clears it, and so does opening a graph.
   */
  autoLayout: boolean
  setAutoLayout(enabled: boolean): void
  /**
   * Canvas lock: the viewport, the cards' geometry and the graph's structure all frozen.
   *
   * What it stops is every *canvas* gesture and every command that would move or restructure
   * anything — pan, zoom, drag, resize, wiring, add, delete, duplicate, arrange, auto-layout,
   * undo, redo, and an assistant plan. What it deliberately leaves alone is everything that is
   * not the canvas: selecting a card, editing its params, muting, collapsing, expanding a
   * result, running, exporting, and opening another graph.
   *
   * **Session-only, and not part of the document.** It is not in the `.coda.json`, not in a
   * share link and not in `localStorage`: a graph somebody sends you never arrives frozen, and
   * a lock left on by yesterday's session is not something to rediscover by finding the canvas
   * dead. Every reload starts unlocked.
   *
   * The guards below are a **backstop**, not the mechanism. Every surface that can reach one of
   * them is disabled while this is on and says why, because a button that silently does nothing
   * is the failure this whole feature would otherwise read as. What the guards buy is that a
   * path somebody adds later — or one that skips the UI, as the assistant does — cannot quietly
   * edit a locked graph.
   */
  locked: boolean
  toggleLocked(): void
  /** How the layout is computed. Per-user, in `localStorage`; see `persistence.ts`. */
  layoutOptions: LayoutOptions
  setLayoutOptions(patch: Partial<LayoutOptions>): void
  /**
   * How wires are drawn — see `EdgeRouting`. Per-user, in `localStorage`, and deliberately not
   * in the document: it changes no position, no param and nothing any node computes.
   *
   * Note it does **not** trigger a layout pass. Every routing reads the arrangement already on
   * the canvas, so switching to `routed` with nothing arranged yet draws exactly what `curved`
   * did — there are no routes to use. Arranging is what produces them, which is why the two
   * controls sit next to each other on the rail.
   */
  edgeRouting: EdgeRouting
  /**
   * Swap the routing. Two modes, so the rail's control is an ordinary toggle.
   *
   * Written as a step through `EDGE_ROUTINGS` rather than as a boolean flip, because the stored
   * value is a named mode and `coerceEdgeRouting` validates against that same list — a boolean
   * here would mean two representations of one setting, and they would disagree the first time a
   * third mode came back. If one ever does, this stays correct and the *button* is what has to
   * stop calling itself pressed.
   */
  toggleEdgeRouting(): void
  /**
   * Write arranged positions in as one undo step.
   *
   * Deliberately *not* `moveNodes`: that is the drag path, and the drag path is what switches
   * auto-layout off. An arrange travelling down it would turn the mode off every time it ran.
   */
  arrangeNodes(positions: ReadonlyMap<string, { x: number; y: number }>): void
  /**
   * Which optional panels are open. Both start closed; see `persistence.ts` for why.
   *
   * Read as `s.panels.inspector` — a primitive, so `useSyncExternalStore`'s identity check is
   * satisfied. Selecting the whole object would return a fresh reference per call only if this
   * were rebuilt, which `togglePanel` does, so subscribe to the field rather than the object.
   */
  panels: PanelState
  togglePanel(panel: keyof PanelState): void
  /**
   * Whether the start page is showing.
   *
   * A plain boolean, unlike `paletteRequest` and `browserRequest`: those are *requests* a
   * component has to catch, which is why they carry a sequence number and need a mount-seeded
   * guard against re-firing on remount. This is state the store owns outright, so a remount
   * simply reads it.
   */
  startPageOpen: boolean
  /**
   * Which dataset node's Edge data panel is open, if any.
   *
   * In the store rather than in the card, because the panel is a modal and a card lives inside
   * React Flow's transformed pane — where a `position: fixed` descendant is captured by the
   * transform and lands nowhere near the viewport. The same containing-block trap the chart
   * tooltips document. So the button is on the card and the dialog is mounted at the top level.
   */
  edgePanelNode: string | undefined
  openEdgePanel(nodeId: string): void
  closeEdgePanel(): void
  /**
   * Attach an edge set to a dataset node, or detach it with `undefined`.
   *
   * One commit for both params, so attaching is **one undo step**. Two `setParam` calls would
   * leave a state where the id is set and the name is not — which is what a refusal message
   * reads to name the set somebody is looking for.
   */
  attachEdgeSet(nodeId: string, set: { id: string; name: string } | undefined): void
  /**
   * Whether the user ticked "Don't show again". Distinct from `startPageOpen` because closing
   * the start page is not dismissing it — only the checkbox writes to storage.
   */
  startPageDismissed: boolean
  openStartPage(): void
  closeStartPage(): void
  /**
   * Whether the launch sequence is at its first stage — the guides dialog rather than the
   * welcome page.
   *
   * A stage *within* `startPageOpen`, not a second modal beside it, and the two are read
   * together by `useLaunchStage`. That composition is what makes the sequence one thing to
   * close: everything that already closed the welcome page — the toolbar, a share link, the
   * Zoo, every test that wants the canvas — closes the guides dialog too, without having
   * learned that it exists.
   *
   * True until the reader has been shown it once (`coda.guidesSeen.v1`); it is deliberately
   * *not* set false while a guide runs, because it is what brings the dialog back at the end.
   */
  guidesOpen: boolean
  /**
   * Guides finished to their last step, in the order they were finished, as `TOURS` spells the
   * ids. Written only through `finishGuide`, which takes a `TourId`, and read by asking whether
   * a given guide is in it — so nothing validates what came back from storage: a guide renamed
   * later leaves an entry that matches nothing, which is invisible rather than wrong.
   */
  completedGuides: string[]
  /** Leave the guides dialog for the welcome page behind it. */
  closeGuides(): void
  /**
   * Take the launch sequence off screen for a guide that is about to run over the canvas.
   *
   * Does not itself start the guide — `startTour` is a dynamic import and belongs to the UI.
   * What it records is that this guide was launched *from the dialog*, which is the only thing
   * `finishGuide` needs in order to know whether to bring the dialog back.
   */
  beginGuide(): void
  /**
   * A guide ended. `completed` is true only for one walked to its last step.
   *
   * Called for every guide however it was launched, so the checkmark is earned from the `?`
   * menu too; the return to the dialog is not, and hangs on `beginGuide` having run.
   */
  finishGuide(id: TourId, completed: boolean): void
  /**
   * The canvas's **+** menu: whether the rail is unfolded, and which category's band is out.
   *
   * Here rather than in `AddMenu`'s own `useState`, for `sourcesOpen`'s two reasons exactly.
   * **A second reader**: the feedback nudge parks in the gap above the closed button, which is
   * the space the rail unfolds into and where a low category's band lands outright, so it
   * withholds itself the way it already does for `startPageOpen` — where the alternative was a
   * `:has()` rule in the menu's stylesheet reaching across the app to hide somebody else's
   * component, keyed on an ancestry neither owns and untestable, since jsdom computes no styles.
   * **And a third way in**: "Learn to Build" asks the reader to open the menu and pick a node out
   * of it, and every interactive step in that tour has a successor that does the move if it was
   * skipped — which is a `before` with nothing to call on a component's state. A tour that could
   * open this and not close it again is the same wedge `sourcesOpen` was lifted to fix.
   *
   * Two primitives rather than one object, per invariant 7: the store is read through
   * `useSyncExternalStore` and a `{ open, category }` field would be a fresh identity per write.
   * Not persisted, and not a mode — nothing else reads it.
   */
  addMenuOpen: boolean
  addMenuCategory: NodeCategory | null
  setAddMenu(open: boolean, category?: NodeCategory | null): void
  /**
   * Whether the Zoo browser is up.
   *
   * A plain boolean owned by the store, like `startPageOpen` and unlike the palette's request
   * counter, because two unrelated surfaces open it — the toolbar's New menu and the
   * command palette — and neither is an ancestor of the other or of where it mounts.
   */
  zooOpen: boolean
  openZoo(): void
  closeZoo(): void
  /**
   * Whether the Connections dialog is up.
   *
   * Here for `zooOpen`'s reason — two unrelated surfaces open it and neither is an ancestor of
   * the other. It was the panel's own `useState` while the toolbar button and a backend's
   * auth-failure channel were the only two ways in; the third is a tour, which has to be able to
   * *close* it again as well, and a step's `after` has nothing to call on a component's state.
   * A tour that could open it and not close it is the wedge this was added to fix: driver makes
   * everything but the spotlit element inert, so a dialog left up mid-tour cannot be dismissed.
   */
  sourcesOpen: boolean
  openSources(): void
  closeSources(): void
  /**
   * Whether the Workflow Wizard is up.
   *
   * A plain boolean owned by the store, like `zooOpen`: three unrelated surfaces open it — the
   * start page, the toolbar menu and the command palette — and none is an ancestor of the
   * others.
   */
  wizardOpen: boolean
  openWizard(): void
  closeWizard(): void
  /**
   * Whether a generated workflow arrives with its explanatory notes.
   *
   * A remembered preference (`coda.wizardNotes.v1`) rather than a fifth question, because it is a
   * statement about how this reader likes their canvas and not about the workflow being built —
   * the same standing `startPageDismissed` has.
   */
  wizardNotes: boolean
  setWizardNotes(enabled: boolean): void
  /**
   * Whether a generated workflow opens into the dashboard grid rather than onto the canvas.
   *
   * Remembered beside `wizardNotes` and for the same reason — a statement about how this reader
   * likes to be handed a workflow, not about the workflow. Off by default: see
   * `loadWizardDashboard`.
   */
  wizardDashboard: boolean
  setWizardDashboard(enabled: boolean): void
  setStartPageDismissed(dismissed: boolean): void
  /**
   * Node whose output is open in the full-size viewer overlay, if any. In the store because
   * it is triggered from the node body, the inspector and the command palette alike.
   */
  expandedNodeId: string | undefined
  expandNode(nodeId: string | undefined): void
  /**
   * Node whose output is docked down the right-hand side of the canvas, if any.
   *
   * The overlay's non-modal twin: same surface, drawn beside the graph instead of over it, so a
   * neuroglancer scene or a 3D view can stay open while the wires under it are rewired.
   *
   * **Never the same node as `expandedNodeId`**, and that is not tidiness. A viewer's card
   * already stands down while the overlay owns the node (`showPreview` in `CodaNodeView` —
   * three WebGL contexts and 3 × 170 kB measured for one 21-neuron scene), and the dock is a
   * *third* mount site for the same node. Both holding one id means two live instances of one
   * neuroglancer embed, each an application fetching EM.
   *
   * Two *different* nodes is allowed, and the exclusion is written asymmetrically to say so —
   * see the two setters. A pin is a workspace choice and outlives a glance at something else;
   * an expansion is the glance.
   *
   * Not persisted — see the note on `DOCK_KEY` in `persistence.ts`. A node id means nothing in
   * the next graph.
   */
  pinnedNodeId: string | undefined
  pinNode(nodeId: string | undefined): void
  /**
   * The dock's share of the window, as a fraction. Persisted; the node id is not.
   *
   * A primitive on the store rather than local state in `ViewerDock`, because the grid column it
   * sizes is on `.app` — two components, one number.
   */
  dockFraction: number
  /**
   * `totalPx` is the width the fraction will be resolved against. Passing it lets the pixel
   * floor be part of the stored answer, so the number the store holds is the one the grid
   * column renders — without it the grip would announce 20% for a dock CSS is drawing at 25%.
   */
  setDockFraction(fraction: number, totalPx?: number): void
  /**
   * Whether the dashboard is up instead of the canvas.
   *
   * A **mode**, and the canvas is genuinely gone while it is on — `App.tsx` renders one or the
   * other into the same grid area, so React Flow unmounts and every card's viewer with it. That
   * is not a tidiness choice: a grid of live viewers next to a canvas of live previews is two
   * WebGL contexts per node, which is the measurement `showPreview` already stands cards down
   * for. Swapping the surfaces trades contexts rather than adding them, and it is why a cell
   * needs no stand-down rule of its own.
   *
   * **Live state here, and a recorded fact in the document.** This is the truth while running;
   * `DashboardLayout.open` is what the last save saw, and a graph saved from the dashboard opens
   * back into it. So the two are kept in step in one direction only — every setter below writes
   * the flag through, and `loadGraph` reads it back — rather than this being a selector over the
   * graph, because a graph with no layout yet has nowhere to hold it and the mode still has to
   * be togglable there.
   *
   * The write is `history: false`. Looking at the other view is a change to the document under
   * this rule, but it is not an *edit*: an undo step for having pressed `D` would put a keypress
   * between somebody and the thing they actually want to undo.
   *
   * The pin is dropped on the way in. The dock exists to keep one viewer up *while working on
   * the graph beside it*, and there is no graph beside it here; leaving it would also be the one
   * way a node could be live in a cell and in the dock at once.
   */
  dashboardOpen: boolean
  /** Switch the view. Both entry points go through one function — see `setDashboard`. */
  setDashboardOpen(open: boolean): void
  toggleDashboard(): void
  /**
   * Put these nodes on the dashboard, in the order given, skipping any already there.
   *
   * **Live under the lock.** Everything else the lock refuses is canvas geometry or graph
   * structure, and a dashboard is neither — it is the *other* view. Refusing it would also be
   * backwards for the feature the lock was reaching for: freezing the canvas so it can be used
   * as a dashboard is the want this replaces, so a locked canvas is exactly when somebody is
   * assembling one.
   */
  addToDashboard(nodeIds: string[]): void
  removeFromDashboard(nodeIds: string[]): void
  /** Reorder: put this cell at `toIndex`, counted after it has been lifted out. */
  moveDashboardCell(nodeId: string, toIndex: number): void
  /** Resize one cell. Spans are clamped to the grid, never refused — see `clampSpan`. */
  setDashboardSpan(nodeId: string, span: { w?: number; h?: number }): void
  setDashboardColumns(columns: number): void
  /**
   * Node **type** whose help document is open, if any.
   *
   * A type rather than a node id, and that is the whole design: a help document is about a kind
   * of node, so it opens from a card, from the inspector, from the node browser — where nothing
   * has been placed on the canvas yet — and from a cross-reference in another document. A node
   * id would have made the browser's entry point impossible and the cross-reference meaningless.
   */
  helpType: string | undefined
  openHelp(type: string | undefined): void

  // --- open workflows ------------------------------------------------------
  /**
   * Every workflow open in this tab, in the order they were opened. Never empty.
   *
   * A name and an id per row and nothing else — see `WorkflowTab`. The documents themselves live
   * outside the store beside their Schedulers, and only the active one's state is in the fields
   * above.
   */
  tabs: WorkflowTab[]
  activeTabId: string
  /**
   * Show a different open workflow.
   *
   * The outgoing document's state is set aside whole, so coming back finds the same undo stack,
   * the same selection, the same run results and the same viewport. What does *not* survive is a
   * run in flight: only the document on screen runs, so switching cancels rather than leaving a
   * query landing into a canvas nobody is looking at. A no-op for the active id or an unknown one.
   */
  switchDocument(id: string): void
  /**
   * Close one. The last document is never closed — closing it leaves a fresh empty one, because
   * a canvas with no document is a state nothing else in the app knows how to draw.
   *
   * Nothing is asked first. The autosave holds the *active* document only, so closing an
   * unsaved one really does lose it; a prototype-stage gap, noted rather than hidden.
   */
  closeDocument(id: string): void
  /**
   * Open a graph in a document of its own — what every route that used to replace the canvas
   * now calls. See `loadGraph` for the in-place version, which is still what a tour restores
   * through.
   *
   * A blank, untouched document is reused rather than left behind, so opening a workflow on a
   * fresh visit does not strand an empty tab beside it.
   */
  openDocument(graph: CodaGraph, warnings?: string[]): void
  /**
   * Remember where the canvas was left, so a switch back puts it there.
   *
   * Deliberately writes no store state: nothing renders from it, it fires at the end of every
   * pan and zoom, and invariant 7 would have every card re-render for a fact no card shows.
   */
  recordViewport(viewport: CanvasViewport): void
  /**
   * Asks the canvas to put the viewport back where the incoming document left it.
   *
   * A request counter for `fitRequest`'s reason — the transform belongs to React Flow and the
   * switch is raised from outside the provider — and a *separate* one from `fitRequest` because
   * the two answers are exclusive: a document being seen for the first time is framed, and one
   * being returned to is restored. `viewport` is undefined for the first case.
   */
  viewportRequest: { seq: number; viewport: CanvasViewport | undefined }

  // --- document ------------------------------------------------------------
  setGraph(graph: CodaGraph, options?: { history?: boolean; tag?: string }): void
  setGraphName(name: string): void
  /** Record (or clear) the gist this workflow was last shared to. See `CodaGraph.meta.gist`. */
  setGraphGist(gist: { id: string; owner?: string } | undefined): void
  /**
   * Empty *this* document, in place.
   *
   * The reset it has always been, and deliberately not "start a new workflow" — see
   * `newWorkflow`, which is what every surface offering that now calls. Overloading this one on
   * hidden state was a silent behaviour change for the twenty-three suites that reset with it.
   */
  newGraph(): void
  /** A blank workflow in a document of its own. What the New menu and the switcher's + offer. */
  newWorkflow(): void
  loadGraph(graph: CodaGraph, warnings?: string[]): void
  /** New graph pre-wired to browse one dataset. What the New menu's dataset entries build. */
  loadStarter(spec: StarterSpec): void

  // --- library -------------------------------------------------------------
  /**
   * Workflows saved in this browser, newest first. See `library.ts` for why they live in
   * IndexedDB rather than beside the autosave.
   *
   * Read lazily — `refreshLibrary` is called when a surface that shows the shelf opens, and
   * after every write — so someone who never uses the feature never touches the database.
   */
  library: WorkflowSummary[]
  /**
   * Whether the shelf has been read yet, which is *not* the same question as whether it is
   * empty. The start page rail renders on the first and hides on the second, so collapsing the
   * two would flash a rail on every launch.
   */
  libraryLoaded: boolean
  refreshLibrary(): Promise<void>
  /**
   * Save the current graph to the browser.
   *
   * Identity is the graph's name: with no `id`, an entry whose name matches is overwritten.
   * The caller is expected to have confirmed that first — this does not ask.
   */
  saveToLibrary(options?: { id?: string }): Promise<{ ok: boolean; error?: string }>
  openFromLibrary(id: string): Promise<void>
  renameInLibrary(id: string, name: string): Promise<void>
  deleteFromLibrary(id: string): Promise<void>

  // --- editing -------------------------------------------------------------
  addNode(type: string, position: { x: number; y: number }): string
  /**
   * End a drag by inserting the dragged node into the wire it was dropped on.
   *
   * `moveNodes`' committing frame *and* the rewire in one `commit`, which is what makes ⌘Z undo
   * the whole gesture — the node back where it started and the original link intact. Two commits
   * would be two undo steps, the first of which leaves the graph rewired around a node in its new
   * place, which is a state nobody was ever in.
   *
   * Unlike a plain move this **does** re-run: the dataflow changed.
   */
  spliceNode(
    nodeId: string,
    edgeId: string,
    moves: ReadonlyArray<{ id: string; position: { x: number; y: number } }>,
  ): void
  moveNodes(
    moves: Array<{ id: string; position: { x: number; y: number } }>,
    commit: boolean,
  ): void
  /** Card resize, from the drag handles. `commit` records an undo step at the drag's end. */
  resizeNodes(
    sizes: Array<{ id: string; size: { width: number; height: number } }>,
    commit: boolean,
  ): void
  setParam(nodeId: string, paramId: string, value: ParamValue): void
  renameNode(nodeId: string, title: string): void
  toggleDisabled(nodeIds: string[]): void
  toggleCollapsed(nodeIds: string[]): void
  toggleParamRows(nodeIds: string[]): void
  duplicateSelection(): void
  /**
   * The selection as clipboard text, remembered here as well as returned.
   *
   * Two answers because there are two clipboards and neither can stand in for the other. The
   * returned string is what the caller puts on the *system* one, which is the copy that survives
   * a second tab and a text editor; `clipboard` is this app's own memory of it, which is what a
   * menu row can be enabled from and what a paste falls back to on a browser that will not let a
   * page read the system clipboard outside a paste event — Firefox, and Chrome without the
   * permission. See `ui/clipboard.ts` for which route each gesture takes.
   *
   * **Not refused by the lock.** Copying takes nothing away and changes nothing; the frozen
   * canvas is about edits landing on *this* graph, and the usual reason to copy off a locked one
   * is to paste it somewhere else.
   */
  copySelection(): string | undefined
  /** Copy, then delete. Refused by the lock, because the deletion half is an edit. */
  cutSelection(): string | undefined
  /**
   * Paste clipboard text onto the canvas, and say how many nodes landed.
   *
   * `text` omitted means this app's own `clipboard`. `at` is where the fragment's top-left corner
   * goes — the pointer, usually; see `insertFragment` for what a paste with no `at` does.
   *
   * Zero is the answer for everything that did not paste: a locked canvas, an empty clipboard,
   * and text that was not a graph. The last is not an error and says nothing — most of what is on
   * a clipboard is not ours. Warnings from the read *are* surfaced: a dropped node type is
   * something the user has to know about, because the hole is in what they just pasted.
   */
  pasteFragment(text?: string, at?: Point): number
  /** The last thing copied or cut here, as clipboard text. See `copySelection`. */
  clipboard: string | undefined
  /**
   * Draw a frame around the selected cards, and return its id.
   *
   * A *canvas* edit rather than a document one in every sense that matters here: it changes no
   * param, no wire and nothing any node computes, which is why it never re-runs anything — and
   * why the lock refuses it, since a frame is graph structure the way a card's position is.
   *
   * Grouping cards that were already framed moves them out of the old frame; a frame left with
   * no members goes. See `core/groups.ts` for that rule and why it is not a refusal.
   *
   * Returns `undefined` when there was nothing to frame — an empty selection, or a locked
   * canvas — for the reason `addNode` answers a locked canvas with an empty id: the caller has
   * to have something to check that is not "did the graph change".
   */
  groupSelection(): string | undefined
  /** Remove these frames. The cards stay where they are — a frame owns nothing. */
  ungroup(groupIds: string[]): void
  /** Retitle one frame. Coalesced like `renameNode`, so typing a title is one undo step. */
  renameGroup(groupId: string, title: string): void
  /**
   * Restyle one frame: its colour, its fill, its dashes.
   *
   * Live under the lock, like `setParam` and `renameNode`: nothing moves and nothing is
   * restructured. A locked canvas is about geometry and structure, not about how things look.
   */
  styleGroup(groupId: string, patch: Omit<Partial<GraphGroup>, 'id' | 'nodeIds'>): void
  deleteNodes(nodeIds: string[]): void
  deleteEdges(edgeIds: string[]): void
  connect(edge: Omit<GraphEdge, 'id'>): boolean
  /** Move one end of an existing link to another port. One undo step; the edge keeps its id. */
  reconnect(edgeId: string, next: Omit<GraphEdge, 'id'>): boolean
  canConnect(
    from: { nodeId: string; portId: string },
    to: { nodeId: string; portId: string },
  ): { ok: boolean; reason?: string }
  setSelection(ids: string[]): void

  // --- assistant -----------------------------------------------------------
  /**
   * Apply a plan an assistant produced, as one undo step.
   *
   * The whole seam. `applyPlan` is pure and headless — it validates every wire against the
   * same `checkConnection` a drag runs and hands back a finished graph or a list of refusals —
   * so all this adds is the commit, which is the one thing only the store can do. A plan that
   * added six nodes and five wires undoes in a single Ctrl-Z, on the same rule the companion
   * card and the dataset auto-wire already follow.
   *
   * Refusals are returned rather than thrown, and nothing is committed on one: the caller is
   * expected to feed them back to the model through `repairPrompt`, which is a conversation
   * rather than an error.
   *
   * Deliberately takes a *plan*, not a request. Asking the model lives in
   * `assistant/converse.ts`, which reaches the network and pulls in the ~65k-character
   * catalogue; keeping it out of here is what lets the panel `await import()` that half and
   * leave it out of the main chunk, the same doctrine as elkjs and the exporters.
   */
  applyAssistantPlan(plan: AssistantPlan): ApplyResult

  // --- history -------------------------------------------------------------
  undo(): void
  redo(): void

  // --- evaluation ----------------------------------------------------------
  runAll(): Promise<void>
  runNode(nodeId: string): Promise<void>
  cancelRun(): void
  invalidateNode(nodeId: string): void
  /**
   * Forget the *data* this node fetched, so its next run reaches the server.
   *
   * `invalidateNode`'s second layer. See `Scheduler.clearNodeCache`: dropping a result makes a
   * node re-run, and on a node that fetches through `loadCachedTable` the re-run answers from
   * IndexedDB in milliseconds with the same bytes.
   */
  clearNodeCache(nodeId: string): void
  /** Drop every cached result, so the next Run re-fetches from scratch. */
  clearResults(): void
  /** True when running this node would actually do work. */
  needsRun(nodeId: string): boolean
  nodeInfo(nodeId: string): NodeRunInfo
  nodeOutput(nodeId: string, portId: string): Value | undefined
  /**
   * When the data behind a node's current result was read from a server, or undefined.
   *
   * Read through `runVersion` like `nodeInfo`, since it changes with the scheduler's cache rather
   * than with the graph.
   */
  nodeFetchedAt(nodeId: string): number | undefined
  /**
   * What this node warned about the result it is holding, or undefined.
   *
   * One string rather than a list, so the snapshot is a primitive (invariant 7). Read through
   * `runVersion` like `nodeInfo`: a warning is raised while the node runs and then belongs to
   * its cached result, so neither end of its life is a graph edit.
   */
  nodeWarning(nodeId: string): string | undefined
  /**
   * Realised values arriving at a node's input ports. Viewers with several inputs (the 3D
   * scene takes skeletons, meshes and points) need these, since a node's own output cache
   * only holds what it produced.
   */
  nodeInputs(nodeId: string): Record<string, Value | undefined>
  setNotice(notice: string | undefined): void
}

// ---------------------------------------------------------------------------

/**
 * The subset of `ids` that mute and collapse mean anything for.
 *
 * Both are dataflow states — muted means "produce nothing", collapsed means "hide the body and
 * show the sockets" — and an annotation has neither. Collapsing one is the dangerous half: a
 * text note draws no header, so a collapsed one would have nothing left to press to bring it
 * back. Filtered here rather than in the canvas, because `M` and `H` act on the selection and a
 * mixed selection must still do the right thing for the real nodes in it.
 */
function liveNodes(graph: CodaGraph, ids: readonly string[]): Set<string> {
  return new Set(
    ids.filter((id) => {
      const node = graph.nodes.find((n) => n.id === id)
      return node !== undefined && !isAnnotation(node.type)
    }),
  )
}

/**
 * What to do after each pass of a `For Each` — installed by the UI, absent in a headless run.
 *
 * A slot rather than a direct call, because the arrow only goes one way: the UI reads the store,
 * and a store importing `ui/useForEach` to write a file would invert that for every consumer,
 * headless tests and the export scripts included. Same shape as `registerExportSource`, and the
 * same reason — the thing being registered is a live browser capability that only exists while
 * an editor is mounted.
 *
 * Absent is a legitimate state and means the loop still runs: it iterates, the region executes,
 * a Collect accumulates. Only the files are not written, which is the half that needs a browser.
 */
let iterationHandler: ((info: IterationInfo) => Promise<void>) | undefined

export function setIterationHandler(
  handler: ((info: IterationInfo) => Promise<void>) | undefined,
): void {
  iterationHandler = handler
}

let autoRunTimer: ReturnType<typeof setTimeout> | undefined
let autosaveTimer: ReturnType<typeof setTimeout> | undefined
/** Identifies the newest run, so a superseded one cannot clear `busy` out from under it. */
let runToken = 0

export const useGraphStore = create<GraphState>((set, get) => {
  /**
   * Whether a loop is mid-flight, which only `onStateChange` asks.
   *
   * A plain closure variable rather than store state on invariant 7's terms: it changes
   * thousands of times per loop and nothing renders from it, so putting it in the store would
   * make every card re-render for a fact no card shows.
   */
  let looping = false

  /**
   * Whether the guide now running was launched from the guides dialog, and so should hand back
   * to it when it ends.
   *
   * A closure variable rather than store state, on the same terms as `looping`: nothing renders
   * from it, and it answers a question only `finishGuide` asks. It is also the whole difference
   * between the dialog's own guides and one started from the `?` menu, which ends on the canvas.
   */
  let guidesReturn = false

  /**
   * Every open workflow, keyed by id and in the order they were opened.
   *
   * Outside the store on the Scheduler's terms — see `DocRecord`. `activeDoc` names the one
   * whose state is live in the fields the rest of this file reads; `sched()` is the only way
   * anything here reaches a Scheduler, so nothing can go on holding the one it captured before
   * a switch.
   */
  const docs = new Map<string, DocRecord>()
  let activeDoc = ''

  function record(): DocRecord {
    /*
     * Non-null by construction: a record is created before `activeDoc` is ever assigned, and
     * `closeDocument` mints a replacement before dropping the last one. The `!` is the assertion
     * that says so rather than a hope — a missing record here is a programming error, and an
     * `undefined` Scheduler quietly doing nothing is the failure it would otherwise become.
     */
    return docs.get(activeDoc)!
  }

  function sched(): Scheduler {
    return record().scheduler
  }

  /**
   * Mint a document and the Scheduler it owns.
   *
   * Every host callback is gated on this document still being the active one. That is a
   * **backstop rather than the mechanism** — `switchDocument` cancels the outgoing run before it
   * moves, so nothing should arrive from a background document — but a run's `finally`, an
   * aborted fetch's rejection and a preview already in flight all land a tick later, and each
   * would otherwise publish a background workflow's state into the canvas on screen.
   */
  function createDoc(id: string): DocRecord {
    const rec: DocRecord = {
      id,
      lastObserved: {},
      viewport: undefined,
      stash: undefined,
      // Assigned on the next line; the field is not read before then.
      scheduler: undefined as unknown as Scheduler,
    }
    rec.scheduler = new Scheduler({
      resolveSource: (sourceId) => requireSource(sourceId),
      onPreview: () => {
        if (activeDoc !== id) return
        set((s) => ({ previewVersion: s.previewVersion + 1 }))
      },
      onStateChange: () => {
        if (activeDoc !== id) return
        set((s) => {
          /*
           * A finished run can reveal the shape of a node nothing could infer statically
           * (Raw Cypher). Re-infer only when that shape actually changed — this fires on
           * every node state transition, and inference walks the whole graph.
           *
           * Skipped outright while a loop is running, and that is a measured saving rather than
           * a tidy-up: a four-hundred-element loop over a ten-node region fires this eight
           * thousand times, and no pass of a loop can change an *observed schema* — the region is
           * the same nodes producing the same shape with different rows in it. Left in, the walk
           * cost more than the work.
           */
          if (looping) return { runVersion: s.runVersion + 1 }
          const next = observedSchemas(s.graph, rec.scheduler)
          if (sameObserved(rec, next)) return { runVersion: s.runVersion + 1 }
          rec.lastObserved = next
          return {
            runVersion: s.runVersion + 1,
            inference: inferGraph(s.graph, { observedSchemas: next }),
          }
        })
      },
      /*
       * One pass of a `For Each` has finished. See `ui/useForEach.ts` for why this cannot be done
       * after the run instead — in short, `executed` is a set of node ids and a picture only
       * exists while it is on screen.
       *
       * The store is the right place for the wiring and the wrong place for the work: it holds the
       * graph and the values, and `runIteration` holds everything about files and canvases, which
       * `src/store` has no business knowing.
       */
      onIteration: async (info) => {
        if (activeDoc !== id) return
        looping = true
        await iterationHandler?.(info)
      },
    })
    docs.set(id, rec)
    return rec
  }

  /**
   * Table schemas that nodes with `observesOutputSchema` actually produced.
   *
   * Only those nodes are inspected, so this stays a handful of map lookups on a graph that
   * usually has none. Comparing the result is what decides whether a finished run has to
   * trigger a re-inference — see `onStateChange`.
   */
  function observedSchemas(
    graph: CodaGraph,
    from: Scheduler,
  ): Record<string, TableSchema | undefined> {
    const observed: Record<string, TableSchema | undefined> = {}
    for (const node of graph.nodes) {
      if (!getNodeDef(node.type)?.observesOutputSchema) continue
      const outputs = from.outputs(node.id)
      if (!outputs) continue
      for (const value of Object.values(outputs)) {
        if (isTableValue(value)) {
          observed[node.id] = value.schema
          break
        }
      }
    }
    return observed
  }

  function sameObserved(
    rec: DocRecord,
    next: Record<string, TableSchema | undefined>,
  ): boolean {
    const a = Object.keys(rec.lastObserved)
    const b = Object.keys(next)
    if (a.length !== b.length) return false
    // Schemas are rebuilt per run, so compare by column names rather than identity.
    return b.every((id) => {
      const before = rec.lastObserved[id]?.columns.map((c) => `${c.name}:${c.dtype}`).join(',')
      const after = next[id]?.columns.map((c) => `${c.name}:${c.dtype}`).join(',')
      return before === after
    })
  }

  /**
   * Re-infer because a *source* learned something, not because the graph changed.
   *
   * Dataset listings and discovered schemas arrive asynchronously, and `inferOutputs` may not
   * await (invariant 2) — so inference runs against whatever is cached and degrades. Nothing
   * used to ask again. On a fresh session that left a dataset node's "Latest" resolving to no
   * dataset id at all, and the Explore widget downstream saying "Connect a Dataset" next to a
   * pipeline that had just run to completion; any edit at all fixed it, which is what a stale
   * inference looks like from the outside.
   *
   * Deliberately *not* `afterGraphChange`. This must not schedule an auto pass — the signal
   * fires from inside a run, and starting another one from a run's own side effects is a loop —
   * and it must not autosave, since nothing about the document changed. It also leaves node
   * states alone, exactly as the observed-schema branch of `onStateChange` does: a finished run
   * that immediately marks itself stale is worse than a badge that waits for the next edit.
   */
  function afterSourceLearned(): void {
    const { graph } = get()
    set({ inference: inferGraph(graph, { observedSchemas: record().lastObserved }) })
  }

  /** Re-infer, refresh badges, keep the switcher's names current, schedule a run and a save. */
  function afterGraphChange(graph: CodaGraph, options: { autoRun?: boolean } = {}): void {
    const rec = record()
    rec.lastObserved = observedSchemas(graph, rec.scheduler)
    const inference = inferGraph(graph, { observedSchemas: rec.lastObserved })
    set({ inference })
    rec.scheduler.refreshStates(graph, inference)
    /*
     * Here rather than in `setGraphName` alone, because a name is not the only way a row's label
     * moves — an undo, a paste of a whole graph and a load all reach it too, and each of those
     * forgetting would leave the switcher naming a workflow that no longer exists. `syncTabs`
     * compares before it writes, so the ordinary keystroke costs one array and no render.
     */
    syncTabs()

    if (options.autoRun !== false) {
      if (autoRunTimer) clearTimeout(autoRunTimer)
      /*
       * One timer, not two. Scheduling the cheap pass *as well* would have it supersede an
       * in-flight full run — `scheduler.run` aborts whatever is running — so a slow query would
       * be cancelled and restarted by the very keystroke that was meant to refine it.
       */
      const full = get().autoRun
      autoRunTimer = setTimeout(
        () => {
          /*
           * `automatic`, so a `For Each` still defers. Auto-run means "re-run the full pass for
           * me", which is right for an ordinary expensive node and wrong for a loop: four
           * hundred queries and four hundred files, 700ms after a keystroke. See `RunOptions`.
           */
          if (get().autoRun) void runFull(undefined, { automatic: true })
          else void sched().run(get().graph, { mode: 'auto' })
        },
        full ? AUTO_FULL_RUN_DELAY_MS : AUTO_RUN_DELAY_MS,
      )
    }

    if (autosaveTimer) clearTimeout(autosaveTimer)
    autosaveTimer = setTimeout(persistActive, AUTOSAVE_DELAY_MS)
  }

  /**
   * Run everything stale, and own `busy` while doing it.
   *
   * The token is what makes overlapping runs safe. `Scheduler.run` supersedes an in-flight run by
   * aborting it, so the *superseded* call's `finally` lands after the newer one has already set
   * `busy: true` — clearing it there would leave the UI idle with a run still going, no Cancel
   * button and an enabled Run. Only the newest run touches the shared state.
   */
  async function runFull(
    targets?: string[],
    options: { automatic?: boolean } = {},
  ): Promise<RunSummary> {
    if (autoRunTimer) clearTimeout(autoRunTimer)
    const token = ++runToken
    set({ busy: true })
    try {
      const summary = await sched().run(get().graph, {
        mode: 'full',
        ...(targets ? { targets } : {}),
        ...(options.automatic ? { automatic: true } : {}),
      })
      if (token === runToken) {
        set({
          lastRun: summary,
          notice: summary.failed.length
            ? `${summary.failed.length} node${summary.failed.length === 1 ? '' : 's'} failed`
            : undefined,
        })
      }
      return summary
    } finally {
      if (token === runToken) set({ busy: false })
      /*
       * Cleared here rather than at the end of the loop, because a run may hold several loops
       * and what the flag suppresses is worth suppressing across all of them. The one skipped
       * re-inference is taken now: a Raw Cypher inside a region really can have revealed a shape,
       * and the loop deliberately did not look.
       */
      if (looping) {
        looping = false
        afterSourceLearned()
      }
    }
  }

  function pushHistory(graph: CodaGraph, tag?: string): HistoryEntry[] {
    const { past } = get()
    const last = past.at(-1)
    const now = Date.now()
    // Collapse rapid edits to the same param into one undo step, so typing "12345" in a
    // threshold field is one undo, not five.
    if (last && tag && last.tag === tag && now - last.at < HISTORY_COALESCE_MS) {
      return [...past.slice(0, -1), { ...last, at: now }]
    }
    const entry: HistoryEntry = { graph, at: now, ...(tag ? { tag } : {}) }
    const next = [...past, entry]
    return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next
  }

  /**
   * Graph as it stood when the current pointer gesture began.
   *
   * A drag or a resize arrives as a stream of uncommitted frames and one committing frame at
   * the end. Recording history from the *last* frame therefore undid a single frame — for a
   * drag, the two were usually identical, so undo after moving a node appeared to do nothing
   * at all. The gesture's own starting graph is the only correct thing to undo to.
   */
  let gestureStart: { tag: string; graph: CodaGraph } | undefined

  /**
   * Where the last paste landed, so a repeat of it can step rather than stack. See
   * `pasteFragment`, which is the only reader and the only writer.
   */
  let lastPaste: { key: string; count: number } = { key: '', count: 0 }

  /**
   * Whether the canvas is locked, and therefore whether a structural or geometric edit may land.
   *
   * Asked by every action `locked` names, and by none of the others — the lock is about the
   * canvas, so a param edit, a mute or a collapse goes through untouched. Not folded into
   * `commit`, which is exactly where it would have caught those too.
   */
  const frozen = () => get().locked

  /** Apply a graph mutation, recording history unless told otherwise. */
  function commit(
    mutate: (graph: CodaGraph) => CodaGraph,
    options: {
      history?: boolean
      tag?: string
      autoRun?: boolean
      /** Marks this as one frame of a continuous gesture — see `gestureStart`. */
      gesture?: string
    } = {},
  ): void {
    const before = get().graph
    const after = mutate(before)
    if (after === before) return

    let undoTo = before
    if (options.gesture) {
      if (options.history === false) {
        // Mid-gesture: remember where it started, record nothing yet.
        if (gestureStart?.tag !== options.gesture) {
          gestureStart = { tag: options.gesture, graph: before }
        }
      } else {
        if (gestureStart?.tag === options.gesture) undoTo = gestureStart.graph
        gestureStart = undefined
      }
    }

    set({
      graph: after,
      ...(options.history === false
        ? {}
        : { past: pushHistory(undoTo, options.tag), future: [] }),
    })
    afterGraphChange(after, { autoRun: options.autoRun !== false })
  }

  /**
   * Switch the view, and record it on the document if there is a layout to record it on.
   *
   * One function for open, close and toggle. Three setters each spelled the pin-drop and the
   * write-through for themselves, which is three chances for them to disagree — and two of them
   * already did, spelling the same effect two ways.
   *
   * `history: false` on the write: pressing `D` changes the document under
   * `DashboardLayout.open`'s rule, but it is not an *edit*, and an undo step for it would land
   * between somebody and the change they meant to undo. The autosave still picks it up, which is
   * what makes a reload come back to the same view.
   *
   * The pin goes with the canvas it was beside — see `dashboardOpen`. Note the overlay is *not*
   * dropped: a cell's ⤢ opens it, and standing the cell down while it does is the rule a card
   * already follows.
   */
  function setDashboard(open: boolean): void {
    set({ dashboardOpen: open, ...(open ? { pinnedNodeId: undefined } : {}) })
    commit((g) => setViewOpen(g, open), { history: false, autoRun: false })
  }

  /**
   * Change a layout, and stamp the current view on it in the same commit.
   *
   * The composition is here rather than at each of the five call sites, which each had to
   * remember it: a sixth mutator that forgot would still commit the layout and leave the flag
   * stale until a save captured it — silent, and only visible as a graph opening in the wrong
   * view days later.
   *
   * Composed *around* the mutation rather than applied after it, because adding the first cell is
   * the moment a layout comes into existence, and two commits would leave a graph — briefly, but
   * an autosave tick can land there — that has a dashboard and does not know it is being looked
   * at. `autoRun: false` throughout: which cells exist and how big they are changes nothing any
   * node computes.
   */
  function commitLayout(mutate: (graph: CodaGraph) => CodaGraph, tag?: string): void {
    commit((g) => setViewOpen(mutate(g), get().dashboardOpen), {
      autoRun: false,
      ...(tag ? { tag } : {}),
    })
  }

  // --- open workflows ------------------------------------------------------

  /**
   * Rebuild the switcher's rows, and write them only if something a row shows has moved.
   *
   * The comparison is the point. This runs from `afterGraphChange`, so it fires on every
   * keystroke; returning a fresh array each time would re-render the switcher — and, because
   * `tabs` is an ordinary snapshot field, everything else selecting it — for an edit no row
   * displays.
   */
  function syncTabs(): void {
    const live = get().graph
    const next = [...docs.values()].map((rec) => ({
      id: rec.id,
      // The active record has no stash: its graph is the one live in the store.
      name: graphName(rec.stash?.graph ?? live),
    }))
    const now = get().tabs
    const same =
      now.length === next.length &&
      now.every((tab, i) => tab.id === next[i]?.id && tab.name === next[i]?.name)
    if (!same) set({ tabs: next })
  }

  // --- the open set, across a reload ---------------------------------------

  /**
   * Where the open documents are written, and the one rule about which half answers.
   *
   * The **active** document is the `localStorage` slot's, unchanged: `loadAutosave` is read
   * synchronously in this initialiser and decides the first paint, so it cannot become an
   * IndexedDB read. Every open document, active one included, is *also* a session record —
   * `saveAutosave` hands back the string it wrote, so the two copies are one serialisation and
   * cannot drift.
   *
   * Both are per tab, and for one reason rather than two: two tabs on two workflows clobbered a
   * single autosave key, and two tabs' *open sets* would clobber each other exactly the same way.
   * `tabId` is the one answer to which tab this is.
   *
   * Every call is fire-and-forget. A session write that fails is the standing `saveAutosave`
   * already has — a failure to remember is not a failure to compute — and the fallback is the one
   * document the slot holds, which is what the app did before any of this.
   */
  function persistActive(): void {
    const json = saveAutosave(get().graph)
    const tab = tabId()
    if (!tab) return
    void saveSessionDoc(tab, activeDoc, json)
  }

  /**
   * Write the document being switched away from, and the order and active id that just moved.
   *
   * The outgoing document is written here rather than left to its next autosave, because it will
   * not get one: only the document on screen is on the debounce.
   */
  function persistShape(outgoing?: DocRecord): void {
    saveActiveDocId(activeDoc)
    const tab = tabId()
    if (!tab) return
    if (outgoing) writeDoc(tab, outgoing)
    void saveSessionMeta(tab, [...docs.keys()])
  }

  /**
   * One stashed document to the session store.
   *
   * Extracted because `persistShape` and `reclaimSession` had it spelled out twice, and the
   * `{ compact: true }` in it is load-bearing — `saveAutosave` writes the same form, so a change
   * here that missed the other copy would put two serialisations of one document in two stores.
   * The active document has no stash and is `persistActive`'s.
   */
  function writeDoc(tab: string, rec: DocRecord): void {
    if (!rec.stash) return
    void saveSessionDoc(tab, rec.id, serializeGraph(rec.stash.graph, { compact: true }))
  }

  /**
   * Take the whole open set to a new tab identity, after a duplicated tab turned out to be
   * holding this one's.
   *
   * `watchTabIdentity`'s `reclaim`, and the session half of it is not optional for the reason the
   * autosave half was not: the re-mint happens *after* the copy has already written, so a tab that
   * only re-keyed would be pointing at an empty session and would come back from a reload with one
   * document where it had four. Every open document is written, not only the active one, because
   * the identity they were all filed under is the thing that just moved.
   */
  function reclaimSession(): void {
    persistActive()
    const tab = tabId()
    if (!tab) return
    // The active one is `persistActive`'s, and is the only one with no stash to read.
    for (const rec of docs.values()) if (rec.id !== activeDoc) writeDoc(tab, rec)
    persistShape()
  }

  /**
   * Bring back the documents this tab had open, around the one the autosave already restored.
   *
   * Asynchronous and deliberately *additive*: it never activates anything and never touches the
   * graph on screen, so the first paint is the autosave's and stays the autosave's. A share link
   * or a New pressed before this lands is therefore safe — the restored documents slot in around
   * whatever is there.
   *
   * The active document is skipped by id, which is why `loadActiveDocId` is read synchronously at
   * boot: the record and the already-created document have to be the *same* document, and there
   * is no chance to agree on that after the fact without re-keying a live Scheduler.
   */
  async function restoreSession(): Promise<void> {
    const tab = tabId()
    if (!tab) return
    const stored = await loadSession(tab)
    if (stored.length === 0) return

    /*
     * Take back the active document where the shared key stood in for an evicted slot.
     *
     * `loadAutosave` falls back to "the most recent graph from any tab" when this tab's own slot
     * is gone, which is a complete answer only while a tab holds one workflow. Past `MAX_SLOTS`
     * it hands over somebody else's work — and the session store, whose bound is twice as
     * generous, may still hold this tab's own copy of the very document standing on screen. The
     * result without this is a coherent-looking set with one foreign workflow in it: measured at
     * eight open tabs as `['T0-A', 'T7-B']`, under T0's own document id.
     *
     * Through `loadGraph` rather than by hand, so the fit request, the load warnings and the
     * autosave that reclaims a slot are the ones every other open gets. Guarded on the graph
     * still being the one the boot put there, because a share link or a New pressed while
     * IndexedDB was opening is a deliberate act and outranks a recovery.
     */
    if (!bootedFromSlot && get().graph === bootGraph) {
      const own = stored.find((entry) => entry.docId === activeDoc)
      if (own) {
        try {
          const read = deserializeGraph(own.json)
          get().loadGraph(read.graph, read.warnings)
        } catch {
          /* Unreadable: the foreign graph is a worse answer than nothing, but it is an answer. */
        }
      }
    }

    let restored = 0
    for (const entry of stored) {
      if (entry.docId === activeDoc || docs.has(entry.docId)) continue
      let read
      try {
        read = deserializeGraph(entry.json)
      } catch {
        // A record this build cannot read is dropped, not faulted: the rest of the session is
        // still worth having, and the alternative is a reload that comes back with nothing.
        continue
      }
      createDoc(entry.docId).stash = blankDoc(read.graph)
      restored += 1
    }
    if (restored === 0) return

    /*
     * Put them back in the stored order rather than in the order they were read.
     * `docs` is a `Map`, and its insertion order is what the switcher draws — appending the
     * restored documents after the active one would silently rearrange somebody's tabs on every
     * reload. Rebuilt in place, since `docs` is what every other function here closes over.
     */
    const rank = new Map(stored.map((entry, i) => [entry.docId, i]))
    const ranked = [...docs.values()].sort(
      (a, b) => (rank.get(a.id) ?? rank.size) - (rank.get(b.id) ?? rank.size),
    )
    docs.clear()
    for (const rec of ranked) docs.set(rec.id, rec)
    syncTabs()
  }

  /** The per-document slice as it stands on screen. One of the two definitions — see `DocStash`. */
  function stashOf(s: GraphState): DocStash {
    return {
      graph: s.graph,
      inference: s.inference,
      past: s.past,
      future: s.future,
      selection: s.selection,
      notice: s.notice,
      lastRun: s.lastRun,
      expandedNodeId: s.expandedNodeId,
      pinnedNodeId: s.pinnedNodeId,
      dashboardOpen: s.dashboardOpen,
      edgePanelNode: s.edgePanelNode,
      autoLayout: s.autoLayout,
    }
  }

  /**
   * The slice for a document nobody has touched yet: a restored one, or a brand new record.
   *
   * `dashboardOpen` is the one field read *from* the graph rather than defaulted, which is
   * `loadGraph`'s rule — a workflow saved from the grid opens into the grid.
   */
  function blankDoc(graph: CodaGraph): DocStash {
    return {
      graph,
      inference: undefined,
      past: [],
      future: [],
      selection: [],
      notice: undefined,
      lastRun: undefined,
      expandedNodeId: undefined,
      pinnedNodeId: undefined,
      dashboardOpen: graph.dashboard?.open === true,
      edgePanelNode: undefined,
      autoLayout: false,
    }
  }

  /** Set the on-screen document's state aside, whole, so coming back finds it unchanged. */
  function stashActive(): void {
    const rec = docs.get(activeDoc)
    if (rec) rec.stash = stashOf(get())
  }

  /**
   * Stop everything the outgoing document had in flight.
   *
   * Only the document on screen runs. The alternative — letting a background workflow finish —
   * needs a `busy` per document, a status bar that reports somebody else's run, and an
   * `onIteration` writing files for a canvas nobody is looking at; none of that is worth a
   * prototype's first pass, and cancelling is the honest version of not having it.
   *
   * `runToken` is bumped rather than the abort being awaited: `runFull`'s `finally` lands a tick
   * later and would otherwise clear `busy` out from under the document that has arrived since.
   * The same guard already protects two overlapping runs on one document.
   */
  function cancelActiveWork(): void {
    if (autoRunTimer) {
      clearTimeout(autoRunTimer)
      autoRunTimer = undefined
    }
    if (autosaveTimer) {
      clearTimeout(autosaveTimer)
      autosaveTimer = undefined
    }
    runToken += 1
    docs.get(activeDoc)?.scheduler.cancel()
    looping = false
    set({ busy: false })
  }

  /**
   * Put a document on screen: its stash back into the store, its badges recomputed, its viewport
   * requested.
   *
   * The badges are recomputed rather than stashed, and that is what makes a switch cheap.
   * Freshness is derived — `refreshStates` compares each cache entry's key against the one the
   * graph implies — so a Scheduler that has been sitting idle answers exactly what it answered
   * before, with no run and no fetch.
   */
  function activate(rec: DocRecord): void {
    /*
     * Captured before `activeDoc` moves: the document being left is the one whose final state has
     * to reach the session store, because only the document on screen is on the autosave debounce.
     * Undefined when the outgoing document was just closed, which `persistShape` reads as "meta
     * only" — its record is already deleted and must not be written back.
     */
    const outgoing = docs.get(activeDoc)
    activeDoc = rec.id
    const stash = rec.stash ?? blankDoc(emptyGraph())
    rec.stash = undefined
    /*
     * Computed here rather than carried, for a document restored from the session store: nothing
     * reads a background document's inference, so walking its graph at boot was work for a field
     * that would be recomputed anyway if it ever went stale. `stashOf` still keeps the live one.
     */
    const inference = stash.inference ?? inferGraph(stash.graph)
    set((s) => ({
      activeTabId: rec.id,
      ...stash,
      inference,
      viewportRequest: { seq: s.viewportRequest.seq + 1, viewport: rec.viewport },
    }))
    rec.scheduler.refreshStates(stash.graph, inference)
    syncTabs()
    /*
     * The autosave holds whichever document is on screen, so a switch has to move it — otherwise
     * a reload comes back to the workflow you switched *away* from. Scheduled rather than
     * written, on `afterGraphChange`'s terms: a run of switches costs one write.
     */
    autosaveTimer = setTimeout(persistActive, AUTOSAVE_DELAY_MS)
    persistShape(outgoing)
  }

  /**
   * Make whatever comes next land in a document of its own.
   *
   * A blank, untouched one is reused rather than left behind: a fresh visit opens on an empty
   * canvas, and every route through here would otherwise strand it beside the workflow the user
   * actually asked for. "Untouched" is the history rather than the name — a graph somebody has
   * typed a name into and then emptied still has a past, and is theirs.
   */
  function beginDocument(): void {
    const s = get()
    const disposable =
      s.graph.nodes.length === 0 && s.past.length === 0 && s.future.length === 0
    if (disposable) return
    stashActive()
    cancelActiveWork()
    activate(createDoc(newId('doc')))
  }

  const initial = loadAutosave()
  /*
   * A fresh visit opens on the start page, so the canvas behind it starts empty. It used to
   * auto-load the first example instead, which now works against itself twice over: the start
   * page is the onboarding, and a graph the newcomer never asked for would make their first
   * card click trip the replace-confirm.
   */
  const initialGraph = initial?.graph.nodes.length ? initial.graph : emptyGraph()
  /*
   * The document the session starts on. Created before `activeDoc` names it, which is safe
   * because every host callback on it is asked at run time and nothing has run yet.
   *
   * It takes the id the last visit was on where `sessionStorage` remembers one, so the session
   * record for the graph `loadAutosave` just handed over is *this* document's rather than a
   * fourth copy of it — see `loadActiveDocId`. A fresh tab mints one, which is every case that
   * has no session to restore anyway.
   */
  const rootDoc = createDoc(loadActiveDocId() ?? newId('doc'))
  activeDoc = rootDoc.id
  saveActiveDocId(rootDoc.id)
  /*
   * Whether the graph above is this tab's own, and the object it came back as.
   *
   * `restoreSession` needs both: the flag to know the shared key stood in for an evicted slot,
   * and the identity to know nothing has replaced it since — a share link resolving first, or a
   * New pressed while IndexedDB was still opening.
   */
  const bootedFromSlot = initial?.fromSlot === true
  const bootGraph = initialGraph
  /*
   * The rest of the open set, an await later — additive, never activating, so the first paint
   * stays the autosave's. See `restoreSession`.
   */
  void restoreSession()
  const startDismissed = loadStartPageDismissed()
  const layoutPrefs = loadLayoutPrefs()
  /*
   * Only *whether* there is a link, which is a regex — the reading and the fetching are
   * `useShareLink`'s, an effect later. Guarded for the environment rather than the feature:
   * `src/store` is exercised under plain Node in several suites, where there is no `location`.
   */
  const sharedLinkPresent =
    typeof window !== 'undefined' && hasShareFragment(window.location?.hash ?? '')

  /*
   * Never unsubscribed: the store is a module singleton that outlives every component, and a
   * teardown hook here would be a hook that only ever runs when the page is going away anyway.
   */
  /*
   * A tab created from another one — Duplicate Tab, `window.open` — starts with a copy of its
   * `sessionStorage`, so the two share an autosave slot and clobber each other. Same terms as
   * the subscriptions below: registered once, never unsubscribed. See `watchTabIdentity`.
   */
  watchTabIdentity(reclaimSession)
  subscribeSourceLearned(afterSourceLearned)
  /*
   * An upload's schema arrives the same way a dataset listing does — asynchronously, into
   * something `inferOutputs` reads synchronously — so it needs the same re-inference and not a
   * second mechanism. Deliberately the *same* handler: this is not a data-changed event, must
   * not schedule a run and must not autosave, all of which `afterSourceLearned` already gets
   * right for exactly the same reasons.
   */
  subscribeUploadLearned(afterSourceLearned)
  /*
   * And an annotation provider's columns, for the third time and the same reason: `peekColumns`
   * is synchronous, so a base's metadata lands after inference has already run against nothing.
   * Same handler again — three asynchronous facts that inference reads synchronously, one rule.
   */
  subscribeAnnotationsLearned(afterSourceLearned)
  /*
   * And the edge-set catalogue, for the fourth time. `peekEdgeSet` is synchronous and the
   * catalogue is an IndexedDB read, so a graph naming a set is validated against "I have not
   * looked yet" — which `edgeSetIssues` deliberately answers with silence rather than with a
   * warning it cannot substantiate. Without this the warning would then sit unshown until some
   * unrelated edit, which is the shape of the root-drift bug written up in CLAUDE.md.
   */
  subscribeEdgeSetsLearned(afterSourceLearned)
  /*
   * The fourth: whether a CAVE annotation's root ids were still current at the materialization.
   * Same terms as the three above — it is not a data-changed event, invalidates nothing and
   * schedules no run; it only tells `validate` that an answer it drew nothing from has arrived.
   */
  subscribeRootCheck(afterSourceLearned)

  return {
    graph: initialGraph,
    inference: inferGraph(initialGraph),
    selection: [],
    runVersion: 0,
    previewVersion: 0,
    past: [],
    future: [],
    notice: initial?.warnings.length ? initial.warnings.join(' · ') : undefined,
    clipboard: undefined,
    lastRun: undefined,
    busy: false,
    paletteRequest: { seq: 0, initialQuery: '' },
    requestPalette: (initialQuery = '') =>
      set((s) => ({ paletteRequest: { seq: s.paletteRequest.seq + 1, initialQuery } })),
    browserRequest: 0,
    requestNodeBrowser: () => set((s) => ({ browserRequest: s.browserRequest + 1 })),
    shareRequest: 0,
    requestShare: () => set((s) => ({ shareRequest: s.shareRequest + 1 })),
    shortcutsRequest: 0,
    requestShortcuts: () => set((s) => ({ shortcutsRequest: s.shortcutsRequest + 1 })),
    privacyRequest: 0,
    requestPrivacy: () => set((s) => ({ privacyRequest: s.privacyRequest + 1 })),
    feedbackRequest: { seq: 0, category: 'general' },
    requestFeedback: (category = 'general') =>
      set((s) => ({ feedbackRequest: { seq: s.feedbackRequest.seq + 1, category } })),
    fitRequest: 0,
    requestFitView: () => set((s) => ({ fitRequest: s.fitRequest + 1 })),
    autoRun: loadAutoRun(),
    setAutoRun: (enabled) => {
      saveAutoRun(enabled)
      set({ autoRun: enabled })
      // Turning it on runs immediately rather than waiting for the next edit: the checkbox is
      // a statement about the graph as it is now, and a stale graph that stays stale until you
      // touch something reads as the setting not working.
      if (enabled) afterGraphChange(get().graph)
    },
    notifyRuns: loadNotifyRuns(),
    setNotifyRuns: (enabled) => {
      saveNotifyRuns(enabled)
      set({ notifyRuns: enabled })
    },

    autoLayout: layoutPrefs.auto,
    setAutoLayout: (enabled) => {
      saveLayoutPrefs({
        auto: enabled,
        options: get().layoutOptions,
        edgeRouting: get().edgeRouting,
      })
      set({ autoLayout: enabled })
      // Nothing is arranged from here. The canvas owns the pass — it is the only thing holding
      // measured card sizes — and its effect is watching this flag, so flipping it is the whole
      // signal. Switching on therefore arranges immediately, same as `setAutoRun` runs
      // immediately, and for the same reason: a setting that appears to do nothing until you
      // touch something reads as broken.
    },

    // Off on every load; the field's note says why that is the design rather than a gap.
    locked: false,
    toggleLocked: () => set((s) => ({ locked: !s.locked })),

    layoutOptions: layoutPrefs.options,
    setLayoutOptions: (patch) => {
      const options = { ...get().layoutOptions, ...patch }
      saveLayoutPrefs({ auto: get().autoLayout, options, edgeRouting: get().edgeRouting })
      set({ layoutOptions: options })
    },

    edgeRouting: layoutPrefs.edgeRouting,
    toggleEdgeRouting: () => {
      const at = EDGE_ROUTINGS.indexOf(get().edgeRouting)
      // `indexOf` answers -1 for a value this build no longer has — `routed` is exactly that,
      // and anyone who used it while it existed still has it in `localStorage`. -1 + 1 is 0,
      // which lands on `curved`, so a retired mode degrades on the first press rather than
      // sticking. (`coerceEdgeRouting` already catches it at load; this is the second line.)
      const edgeRouting = EDGE_ROUTINGS[(at + 1) % EDGE_ROUTINGS.length] ?? 'curved'
      saveLayoutPrefs({ auto: get().autoLayout, options: get().layoutOptions, edgeRouting })
      set({ edgeRouting })
    },

    arrangeNodes: (positions) => {
      if (frozen()) return
      commit(
        (g) => ({
          ...g,
          nodes: g.nodes.map((n) => {
            const position = positions.get(n.id)
            return position ? { ...n, position } : n
          }),
        }),
        // One history entry for the whole arrangement, and never evaluation: a position cannot
        // change what a node computes.
        { tag: 'layout', autoRun: false },
      )
    },

    theme: loadTheme(),
    setTheme: (theme) => {
      applyTheme(theme)
      set({ theme })
    },

    panels: loadPanels(),
    togglePanel: (panel) => {
      const next = { ...get().panels, [panel]: !get().panels[panel] }
      savePanels(next)
      set({ panels: next })
    },
    /*
     * A share link wins over the welcome screen. Decided here rather than in an effect because
     * both have to be settled in the tick the store is created: a link noticed later means the
     * modal is already up, over a workflow somebody was sent and has not seen yet.
     */
    startPageOpen: !startDismissed && !sharedLinkPresent,
    startPageDismissed: startDismissed,
    edgePanelNode: undefined,
    openEdgePanel: (nodeId) => set({ edgePanelNode: nodeId }),
    closeEdgePanel: () => set({ edgePanelNode: undefined }),

    attachEdgeSet: (nodeId, edgeSet) => {
      commit(
        (g) =>
          setNodeParam(
            setNodeParam(g, nodeId, 'edgeSetId', edgeSet?.id ?? ''),
            nodeId,
            'edgeSetName',
            edgeSet?.name ?? '',
          ),
        { tag: `edges:${nodeId}` },
      )
    },

    openStartPage: () => set({ startPageOpen: true }),
    closeStartPage: () => set({ startPageOpen: false }),

    /*
     * A share link wins over the guides for the same reason it wins over the welcome page, and
     * the flag is left unwritten rather than set: somebody whose first arrival is a link
     * somebody sent them has not been introduced to anything, so their next ordinary visit is
     * still a first one.
     */
    guidesOpen: !loadGuidesSeen() && !sharedLinkPresent,
    completedGuides: loadGuidesDone(),
    closeGuides: () => set({ guidesOpen: false }),
    /*
     * `guidesOpen` stays true on purpose — see its note. Closing the *sequence* is what takes
     * the dialog off screen for the duration of the guide, and re-opening it is the whole of
     * what `finishGuide` has to do.
     */
    beginGuide: () => {
      guidesReturn = true
      set({ startPageOpen: false })
    },
    finishGuide: (id, completed) => {
      const state = get()
      const returning = guidesReturn
      guidesReturn = false
      // A new array only when the list actually changes, or invariant 7 has a fresh snapshot
      // to compare on every tour that ends.
      const done =
        completed && !state.completedGuides.includes(id)
          ? [...state.completedGuides, id]
          : state.completedGuides
      if (done !== state.completedGuides) saveGuidesDone(done)
      set({
        completedGuides: done,
        // Only for a guide the dialog launched. One started from the `?` menu ends on the
        // canvas the reader was working on, which is where they were.
        ...(returning ? { startPageOpen: true } : {}),
      })
    },

    zooOpen: false,
    // Closes the start page on the way in: both are full-screen modals, and the New menu
    // is reachable from behind one.
    addMenuOpen: false,
    addMenuCategory: null,
    // A closed menu has no band, so the category is cleared rather than remembered: reopening
    // onto the last category would be a menu that answers a question nobody asked twice.
    setAddMenu: (open, category = null) =>
      set({ addMenuOpen: open, addMenuCategory: open ? category : null }),
    openZoo: () => set({ zooOpen: true, startPageOpen: false }),
    closeZoo: () => set({ zooOpen: false }),

    sourcesOpen: false,
    openSources: () => set({ sourcesOpen: true }),
    closeSources: () => set({ sourcesOpen: false }),

    // Closes the start page on the way in, for `openZoo`'s reason: two full-screen modals is one
    // too many, and the wizard is reached *from* that page.
    wizardOpen: false,
    openWizard: () => set({ wizardOpen: true, startPageOpen: false }),
    closeWizard: () => set({ wizardOpen: false }),
    wizardNotes: loadWizardNotes(),
    setWizardNotes: (enabled) => {
      saveWizardNotes(enabled)
      set({ wizardNotes: enabled })
    },
    wizardDashboard: loadWizardDashboard(),
    setWizardDashboard: (enabled) => {
      saveWizardDashboard(enabled)
      set({ wizardDashboard: enabled })
    },
    setStartPageDismissed: (dismissed) => {
      saveStartPageDismissed(dismissed)
      set({ startPageDismissed: dismissed })
    },
    expandedNodeId: undefined,
    /*
     * Releases the pin only for the *same* node. Expanding something else is a transient look at
     * a second result, and taking the dock down for it would mean a pinned neuroglancer scene
     * lost its camera — the memo recovers that same-origin and cannot cross-origin — every time
     * somebody opened a table for a moment. What the narrow test still forbids is the case that
     * actually costs: one node mounted in two full-size surfaces at once.
     */
    expandNode: (nodeId) =>
      set((s) =>
        nodeId && s.pinnedNodeId === nodeId
          ? { expandedNodeId: nodeId, pinnedNodeId: undefined }
          : { expandedNodeId: nodeId },
      ),
    pinnedNodeId: undefined,
    /*
     * The other direction is unconditional, and the asymmetry is deliberate: pinning is a
     * request to see something *beside the graph*, and leaving a modal over it would answer that
     * request with a covered panel. Closing the dock (`undefined`) touches nothing.
     */
    pinNode: (nodeId) =>
      set(
        nodeId ? { pinnedNodeId: nodeId, expandedNodeId: undefined } : { pinnedNodeId: nodeId },
      ),

    dashboardOpen: initialGraph.dashboard?.open === true,
    setDashboardOpen: setDashboard,
    toggleDashboard: () => setDashboard(!get().dashboardOpen),

    addToDashboard: (nodeIds) => {
      if (nodeIds.length === 0) return
      commitLayout((g) => addCells(g, nodeIds))
    },

    removeFromDashboard: (nodeIds) => {
      if (nodeIds.length === 0) return
      commitLayout((g) => removeCells(g, nodeIds))
    },

    moveDashboardCell: (nodeId, toIndex) => commitLayout((g) => moveCell(g, nodeId, toIndex)),

    // Tagged, so a drag that crosses three track boundaries is one undo step rather than three —
    // the coalescing `renameNode` and `renameGroup` already use. The columns slider takes one for
    // the same reason: five steps of a drag are one decision.
    setDashboardSpan: (nodeId, span) =>
      commitLayout((g) => setCellSpan(g, nodeId, span), `cell-span:${nodeId}`),

    setDashboardColumns: (columns) =>
      commitLayout((g) => setDashboardTracks(g, columns), 'dash-columns'),
    dockFraction: loadDockFraction(),
    setDockFraction: (fraction, totalPx) => {
      const next = clampDockFraction(fraction, totalPx)
      saveDockFraction(next)
      set({ dockFraction: next })
    },
    helpType: undefined,
    openHelp: (type) => set({ helpType: type }),

    // --- open workflows ----------------------------------------------------

    tabs: [{ id: rootDoc.id, name: graphName(initialGraph) }],
    activeTabId: rootDoc.id,
    viewportRequest: { seq: 0, viewport: undefined },

    recordViewport: (viewport) => {
      const rec = docs.get(activeDoc)
      if (rec) rec.viewport = viewport
    },

    switchDocument: (id) => {
      if (id === get().activeTabId) return
      const rec = docs.get(id)
      if (!rec) return
      stashActive()
      cancelActiveWork()
      activate(rec)
    },

    closeDocument: (id) => {
      const rec = docs.get(id)
      if (!rec) return
      const wasActive = id === get().activeTabId
      // Where it sat, so the neighbour that takes its place is the one under the cursor.
      const order = [...docs.keys()]
      const at = order.indexOf(id)

      if (wasActive) cancelActiveWork()
      /*
       * The only thing that returns this document's results to the heap. A Scheduler's cache
       * holds whole tables and whole scenes, and dropping the record alone would leave them
       * reachable from the abort controller and the host closures until the page went away.
       */
      rec.scheduler.invalidateAll()
      docs.delete(id)
      // Closed means closed: a record left behind would come back as a tab on the next reload,
      // which is the one thing a close has to be trusted not to do.
      const tab = tabId()
      if (tab) void deleteSessionDoc(tab, id)

      if (!wasActive) {
        syncTabs()
        persistShape()
        return
      }
      const remaining = [...docs.keys()]
      const nextId = remaining[Math.min(at, remaining.length - 1)]
      // Never zero documents: a canvas with nothing behind it is a state nothing else can draw.
      activate(nextId ? docs.get(nextId)! : createDoc(newId('doc')))
    },

    newWorkflow: () => {
      get().openDocument(emptyGraph('Untitled'))
    },

    openDocument: (graph, warnings = []) => {
      beginDocument()
      // Through `loadGraph`, so the history reset, the load warnings, the auto-layout stand-down
      // and the fit-on-load request are the ones every other open has always got.
      get().loadGraph(graph, warnings)
    },

    // --- document ----------------------------------------------------------

    setGraph: (graph, options = {}) => {
      commit(() => graph, options)
    },

    setGraphName: (name) => {
      commit((g) => ({ ...g, meta: { ...g.meta, name } }), { tag: 'meta:name' })
    },

    /*
     * Remember which gist this workflow was shared to, so pressing Share again updates it.
     *
     * Deliberately **not** through `commit`. Bookkeeping about a link is not an edit to the
     * graph: no node can read `meta.gist`, so the inference pass, the state refresh and the
     * history entry `commit` runs unconditionally would all be work for nothing — on the largest
     * graphs, which is exactly when somebody reaches for a gist. Same narrower path
     * `afterSourceLearned` takes, and for the same reason. The autosave still happens, because
     * the id has to survive a reload for the next Share to find it.
     */
    setGraphGist: (gist) => {
      const graph = { ...get().graph, meta: { ...get().graph.meta, gist } }
      set({ graph })
      saveAutosave(graph)
    },

    newGraph: () => {
      const graph = emptyGraph('Untitled')
      set({
        graph,
        past: [],
        future: [],
        selection: [],
        notice: undefined,
        lastRun: undefined,
        expandedNodeId: undefined,
        pinnedNodeId: undefined,
        // Nothing to show in a grid, so the canvas whatever the last graph was seen through.
        dashboardOpen: false,
      })
      sched().invalidateAll()
      afterGraphChange(graph, { autoRun: false })
    },

    loadGraph: (graph, warnings = []) => {
      /*
       * Opening a graph turns auto-layout off, on the same reasoning as a drag: the positions in
       * a file are somebody's decision, and a mode that re-arranged them on open would mean a
       * saved layout could not survive being looked at.
       */
      if (get().autoLayout) get().setAutoLayout(false)
      set({
        graph,
        past: [],
        future: [],
        selection: [],
        notice: warnings.length ? warnings.join(' · ') : undefined,
        lastRun: undefined,
        expandedNodeId: undefined,
        pinnedNodeId: undefined,
        /*
         * The view the file was saved from — the one thing on this list that is *read* from the
         * document rather than reset by it.
         *
         * A graph carrying no dashboard, or one saved from the canvas, opens on the canvas, so
         * nothing that predates this feature changes. A graph whose author saved it while looking
         * at the grid opens into the grid, which is the whole point of a dashboard being
         * shareable: the link is the wall of results, not a canvas the recipient has to be told
         * to press `D` on. See `DashboardLayout.open` for why this is a different promise from
         * the lock's, which deliberately does not travel.
         */
        dashboardOpen: graph.dashboard?.open === true,
      })
      sched().invalidateAll()
      afterGraphChange(graph)
      /*
       * Frame what was just opened. Not done for `newGraph`, which has nothing to frame — and a
       * request nothing can satisfy would be left pending and fire on whatever node was added
       * next, which is worse than not fitting at all.
       */
      if (graph.nodes.length > 0) get().requestFitView()
    },

    loadStarter: (spec) => {
      get().openDocument(buildStarter(spec))
    },

    // --- library -----------------------------------------------------------

    library: [],
    libraryLoaded: false,

    refreshLibrary: async () => {
      // Reads never throw — a shelf that cannot be read is reported as an empty one, which is
      // the truth from where the user is standing. Only writes are allowed to fail loudly.
      set({ library: await listWorkflows(), libraryLoaded: true })
    },

    saveToLibrary: async (options = {}) => {
      const graph = get().graph
      const id = options.id ?? findByName(get().library, graph.meta?.name ?? '')?.id
      try {
        const summary = await saveWorkflow(graph, { id })
        await get().refreshLibrary()
        set({ notice: `Saved “${summary.name}” in this browser` })
        return { ok: true }
      } catch (err) {
        /*
         * The one place a storage failure is surfaced rather than swallowed. Everywhere else a
         * failure to remember is not a failure to compute; here the user asked for their work to
         * be kept, and reporting success would lose it silently.
         */
        const error = (err as Error).message
        set({ notice: `Could not save: ${error}` })
        return { ok: false, error }
      }
    },

    openFromLibrary: async (id) => {
      try {
        const result = await loadWorkflow(id)
        // Through `openDocument` like every other open, so the new document, the history reset,
        // the load warnings and the fit-on-load request behave exactly as they do for a file.
        get().openDocument(result.graph, result.warnings)
      } catch (err) {
        set({ notice: (err as Error).message })
        await get().refreshLibrary()
      }
    },

    renameInLibrary: async (id, name) => {
      try {
        await renameWorkflow(id, name)
        await get().refreshLibrary()
      } catch (err) {
        set({ notice: `Could not rename: ${(err as Error).message}` })
      }
    },

    deleteFromLibrary: async (id) => {
      try {
        await deleteWorkflow(id)
        await get().refreshLibrary()
      } catch (err) {
        set({ notice: `Could not delete: ${(err as Error).message}` })
      }
    },

    // --- editing -----------------------------------------------------------

    addNode: (type, position) => {
      // The empty id says "nothing was added". Every caller is gated on `locked` before it asks,
      // so nobody reads it; what this stops is a path added later that is not.
      if (frozen()) return ''
      const def = requireNodeDef(type)
      const node: GraphNode = {
        id: newId('n'),
        type,
        position,
        params: defaultParams(def),
      }
      /*
       * A dataset node arrives with its Description card, and a node with a Dataset socket
       * arrives already fed when the canvas holds exactly one dataset to feed it — both inside
       * a single `commit`, so the whole arrival is one undo step, and the selection stays on
       * the node that was actually asked for.
       *
       * The auto-wire runs *after* the companion so it sees the graph the companion left: the
       * card is wired by its own spec, which is what keeps the two from wiring the same socket
       * twice.
       */
      commit((g) => autoWireDataset(addNodeWithCompanion(g, node), node))
      set({ selection: [node.id] })
      return node.id
    },

    spliceNode: (nodeId, edgeId, moves) => {
      if (frozen()) return
      // A drag ends auto-layout, the same reason `moveNodes` says: the position is one somebody
      // chose, and the next structural edit would otherwise put the card straight back.
      if (get().autoLayout) get().setAutoLayout(false)
      const byId = new Map(moves.map((m) => [m.id, m.position]))
      commit(
        (g) => {
          const edge = g.edges.find((e) => e.id === edgeId)
          const moved = {
            ...g,
            nodes: g.nodes.map((n) => {
              const position = byId.get(n.id)
              return position ? { ...n, position } : n
            }),
          }
          /*
           * The ports are re-derived here rather than carried from the drag. The candidate was
           * computed on a pointer move and the graph could have moved under it since; and since
           * positions do not reach inference, the answer is the same one the highlight showed —
           * so passing them would be a second copy of a decision that can only disagree.
           */
          if (!edge) return moved
          const ports = spliceCandidate(moved, inferGraph(moved), nodeId, edge)
          if (!ports) return moved
          return spliceGraph(moved, nodeId, edge, ports)
        },
        // The same gesture tag the drag's own frames carried, so the undo entry reaches back to
        // where the drag began rather than to its last frame.
        { history: true, tag: 'splice', gesture: 'move' },
      )
    },

    moveNodes: (moves, commitToHistory) => {
      if (frozen()) return
      /*
       * A drag ends auto-layout.
       *
       * The mode owns every position while it is on, so the next structural edit would put this
       * node straight back where ELK wants it — and a card that springs back from where you just
       * put it is not a setting doing its job, it is the editor refusing to be edited. Cleared on
       * the *committing* frame only, so it goes at the end of the gesture rather than on its
       * first pixel. `arrangeNodes` exists precisely so the layout's own writes do not land here.
       */
      if (commitToHistory && get().autoLayout) get().setAutoLayout(false)
      const byId = new Map(moves.map((m) => [m.id, m.position]))
      commit(
        (g) => ({
          ...g,
          nodes: g.nodes.map((n) => {
            const position = byId.get(n.id)
            return position ? { ...n, position } : n
          }),
        }),
        // Positions don't affect results, so a drag never triggers evaluation, and only
        // the drag *end* becomes an undo step — back to where the drag started.
        { history: commitToHistory, tag: 'move', autoRun: false, gesture: 'move' },
      )
    },

    resizeNodes: (sizes, commitToHistory) => {
      if (frozen()) return
      const byId = new Map(sizes.map((s) => [s.id, s.size]))
      commit(
        (g) => ({
          ...g,
          nodes: g.nodes.map((n) => {
            const size = byId.get(n.id)
            return size ? { ...n, size } : n
          }),
        }),
        // Same reasoning as a drag: a card's size cannot change a result, so resizing never
        // triggers evaluation, and only the gesture's end becomes an undo step.
        { history: commitToHistory, tag: 'resize', autoRun: false, gesture: 'resize' },
      )
    },

    setParam: (nodeId, paramId, value) => {
      commit((g) => setNodeParam(g, nodeId, paramId, value), {
        tag: `param:${nodeId}:${paramId}`,
      })
    },

    renameNode: (nodeId, title) => {
      commit((g) => updateNode(g, nodeId, title ? { title } : { title: undefined }), {
        tag: `title:${nodeId}`,
        autoRun: false,
      })
    },

    toggleDisabled: (nodeIds) => {
      const ids = liveNodes(get().graph, nodeIds)
      if (ids.size === 0) return
      const graph = get().graph
      // Uniform action: if anything in the selection is enabled, disable the whole lot.
      const anyEnabled = graph.nodes.some((n) => ids.has(n.id) && !n.disabled)
      commit((g) => ({
        ...g,
        nodes: g.nodes.map((n) => (ids.has(n.id) ? { ...n, disabled: anyEnabled } : n)),
      }))
    },

    toggleCollapsed: (nodeIds) => {
      const ids = liveNodes(get().graph, nodeIds)
      if (ids.size === 0) return
      const graph = get().graph
      const anyExpanded = graph.nodes.some((n) => ids.has(n.id) && !n.collapsed)
      commit(
        (g) => ({
          ...g,
          nodes: g.nodes.map((n) => (ids.has(n.id) ? { ...n, collapsed: anyExpanded } : n)),
        }),
        { autoRun: false },
      )
    },

    /*
     * Folds the param rows away, giving the space to whatever is under them — a drawing on a
     * viewer, nothing at all on a transform node, which then simply gets shorter. `autoRun:
     * false` and no cache touched anywhere: this is a card-layout decision, and a graph that
     * re-ran because somebody tidied a card would be the same surprise a resize used to be.
     *
     * `liveNodes` for the same reason mute and collapse use it: a text note draws its own card
     * with no header and no param band, so the flag would be state nothing can see or undo.
     */
    toggleParamRows: (nodeIds) => {
      const ids = liveNodes(get().graph, nodeIds)
      if (ids.size === 0) return
      const graph = get().graph
      const anyShown = graph.nodes.some((n) => ids.has(n.id) && !n.paramsCollapsed)
      commit(
        (g) => ({
          ...g,
          nodes: g.nodes.map((n) => (ids.has(n.id) ? { ...n, paramsCollapsed: anyShown } : n)),
        }),
        { autoRun: false },
      )
    },

    /*
     * Duplicate is Copy and Paste with the clipboard taken out of the middle.
     *
     * Written out longhand first — mint the ids, copy the internal edges, clone the whole frames,
     * offset by 28 — and then written a second time, in `core/clipboard.ts`, when a paste needed
     * every one of those rules again. Two spellings of "what comes along with a selection" is the
     * shape this repo keeps paying for (`fetchText`, `canHaveCell`, `bucketParams`), and the
     * comments here claimed to *share* rules they in fact restated. So it composes the pair now:
     * `subgraphOf` is the taking and `insertFragment` the putting back, with `PASTE_OFFSET` the
     * one place the 28 lives.
     */
    duplicateSelection: () => {
      if (frozen()) return
      const { graph, selection } = get()
      const clipping = subgraphOf(graph, selection)
      if (!clipping) return
      let clones: string[] = []
      commit((g) => {
        const result = insertFragment(g, clipping)
        clones = result.nodeIds
        return result.graph
      })
      set({ selection: clones })
    },

    copySelection: () => {
      const { graph, selection } = get()
      const text = fragmentFrom(graph, selection)
      if (text) set({ clipboard: text })
      return text
    },

    cutSelection: () => {
      // Silent under the lock, like every other refusal here: the sentence a reader sees is the
      // UI's (`LOCKED_NOTICE`), and the store's own refusal strings are addressed to a model.
      if (frozen()) return undefined
      const text = get().copySelection()
      if (!text) return undefined
      get().deleteNodes([...get().selection])
      return text
    },

    pasteFragment: (text, at) => {
      if (frozen()) return 0
      const payload = text ?? get().clipboard
      if (!payload) return 0
      const read = readFragment(payload)
      if (!read) return 0

      /*
       * A repeated paste at the same point is stepped, rather than landing on top of itself.
       *
       * ⌘D cascades for free — it offsets from the selection, which is the copy it just made — but
       * a paste is placed absolutely, so pressing ⌘V twice without moving the pointer put the
       * second stack exactly over the first, with the new selection covering it. That reads as
       * nothing having happened, which is the one outcome a paste must never look like.
       *
       * Keyed on the text *and* the point, so moving the pointer or copying something else starts
       * the cascade again. Deliberately not part of the document, and deliberately not history:
       * where the last paste went is a fact about this session's pointer.
       */
      let target: Point | undefined
      if (at) {
        // Keyed on the payload's *length* rather than the payload: the counter outlives the
        // paste, and a module-scoped string built from a 200 KB fragment is a copy of it held
        // for the session. Two different fragments of exactly equal length at exactly one point
        // continue each other's cascade, which steps a paste 28px — the harmless direction.
        const key = `${payload.length}@${Math.round(at.x)},${Math.round(at.y)}`
        const step = key === lastPaste.key ? lastPaste.count + 1 : 0
        lastPaste = { key, count: step }
        target = { x: at.x + step * PASTE_OFFSET, y: at.y + step * PASTE_OFFSET }
      }

      let pasted: string[] = []
      commit((g) => {
        const result = insertFragment(g, read.graph, target)
        pasted = result.nodeIds
        return result.graph
      })
      set({
        selection: pasted,
        ...(read.warnings.length ? { notice: read.warnings.join(' · ') } : {}),
      })
      return pasted.length
    },

    groupSelection: () => {
      if (frozen()) return undefined
      const { graph, selection } = get()
      if (selection.length === 0) return undefined
      const next = createGroup(graph, selection)
      if (next === graph) return undefined
      const group = next.groups?.[next.groups.length - 1]
      // A frame changes nothing any node computes, so no cache is touched and nothing re-runs.
      commit(() => next, { autoRun: false })
      return group?.id
    },

    ungroup: (groupIds) => {
      if (frozen() || groupIds.length === 0) return
      commit((g) => removeGroups(g, groupIds), { autoRun: false })
    },

    renameGroup: (groupId, title) => {
      commit((g) => updateGroup(g, groupId, { title }), {
        // The same coalescing `renameNode` gets, and for the same reason: a title typed a
        // character at a time is one edit, not eleven undo steps.
        tag: `group-title:${groupId}`,
        autoRun: false,
      })
    },

    styleGroup: (groupId, patch) => {
      commit((g) => updateGroup(g, groupId, patch), { autoRun: false })
    },

    deleteNodes: (nodeIds) => {
      if (frozen() || nodeIds.length === 0) return
      commit((g) => removeNodes(g, nodeIds))
      set((s) => ({
        selection: s.selection.filter((id) => !nodeIds.includes(id)),
        ...(s.expandedNodeId && nodeIds.includes(s.expandedNodeId)
          ? { expandedNodeId: undefined }
          : {}),
        ...(s.pinnedNodeId && nodeIds.includes(s.pinnedNodeId)
          ? { pinnedNodeId: undefined }
          : {}),
      }))
    },

    deleteEdges: (edgeIds) => {
      if (frozen() || edgeIds.length === 0) return
      commit((g) => removeEdges(g, edgeIds))
    },

    connect: (edge) => {
      if (frozen()) return false
      const check = get().canConnect(
        { nodeId: edge.source, portId: edge.sourceHandle },
        { nodeId: edge.target, portId: edge.targetHandle },
      )
      if (!check.ok) {
        set({ notice: check.reason ?? 'Connection not allowed' })
        return false
      }
      commit((g) => addGraphEdge(g, edge))
      return true
    },

    /*
     * A rewire is validated exactly as a fresh link is, and the link being moved is left in the
     * graph while that check runs. That is safe rather than merely convenient: `createsCycle`
     * walks *forward* from the proposed target, and the edge being moved points into its old
     * target, so it can never appear on a path leading back to the source. Excluding it would
     * mean a second, near-identical validation path for the sake of a case that cannot arise.
     *
     * A refused rewire leaves the graph untouched — the wire snaps back. Unplugging is what
     * dropping on empty canvas means; a mis-aimed drop onto an incompatible socket is a miss,
     * and answering a miss by deleting the link would be a trap.
     */
    reconnect: (edgeId, next) => {
      if (frozen()) return false
      const check = get().canConnect(
        { nodeId: next.source, portId: next.sourceHandle },
        { nodeId: next.target, portId: next.targetHandle },
      )
      if (!check.ok) {
        set({ notice: check.reason ?? 'Connection not allowed' })
        return false
      }
      commit((g) => reconnectEdge(g, edgeId, next))
      return true
    },

    canConnect: (from, to) => checkConnection(get().graph, get().inference, from, to),

    setSelection: (ids) => {
      const current = get().selection
      if (current.length === ids.length && current.every((id, i) => id === ids[i])) return
      set({ selection: ids })
    },

    // --- assistant ---------------------------------------------------------

    applyAssistantPlan: (plan) => {
      /*
       * The one guard that answers back. Everything else the lock stops is a gesture or a menu
       * row, and both are disabled on screen; a plan arrives from a model that cannot see the
       * rail, so the refusal has to be something the panel can show — and `errors` is already
       * the channel it feeds back into the conversation.
       */
      if (frozen()) {
        return { ok: false, errors: ['The canvas is locked — unlock it to apply a plan.'] }
      }
      const result = applyPlan(get().graph, plan)
      if (!result.ok) return result

      /*
       * `commit` compares by identity and does nothing when the graph did not change, which is
       * what makes a declined plan — an empty one whose summary says "I cannot do that" — leave
       * no undo step behind. `applyPlan` returns the *same* object in that case for exactly this.
       *
       * Committed through the ordinary path, autoRun and all: a plan genuinely changes the
       * document, so it should mark what it touched stale and schedule the cheap pass like any
       * other edit. It must not press Run itself — the expensive nodes it just added point at a
       * shared production database, and invariant 6 exists to keep a machine from deciding that.
       *
       * **No `tag`, and that is not an omission.** A tag is purely `pushHistory`'s coalescing
       * key: two commits sharing one within `HISTORY_COALESCE_MS` collapse into a single undo
       * step, which is what makes typing "12345" into a threshold one undo rather than five.
       * A constant `'assistant'` tag therefore merged two *separate* requests whenever they
       * landed inside 700ms — so undoing the second also silently undid the first. Each plan is
       * a deliberate, discrete edit and gets its own step.
       */
      commit(() => result.graph)

      /*
       * Select what it made, so the answer to "what did you just do" is on screen rather than
       * in a panel. Only the nodes the plan named: a companion card that came along with a
       * dataset node was not asked for, and selecting it would misreport the edit.
       */
      const made = Object.values(result.created)
      if (made.length) set({ selection: made })
      return result
    },

    // --- history -----------------------------------------------------------

    undo: () => {
      if (frozen()) return
      const { past, graph, future } = get()
      const entry = past.at(-1)
      if (!entry) return
      set({
        graph: entry.graph,
        past: past.slice(0, -1),
        future: [...future, { graph, at: Date.now() }],
      })
      afterGraphChange(entry.graph)
    },

    redo: () => {
      if (frozen()) return
      const { future, graph, past } = get()
      const entry = future.at(-1)
      if (!entry) return
      set({
        graph: entry.graph,
        future: future.slice(0, -1),
        past: [...past, { graph, at: Date.now() }],
      })
      afterGraphChange(entry.graph)
    },

    // --- evaluation --------------------------------------------------------

    runAll: async () => {
      await runFull()
    },

    runNode: async (nodeId) => {
      await runFull([nodeId])
    },

    cancelRun: () => {
      sched().cancel()
    },

    invalidateNode: (nodeId) => {
      sched().invalidateNode(get().graph, nodeId)
    },

    clearNodeCache: (nodeId) => {
      sched().clearNodeCache(get().graph, nodeId)
    },

    clearResults: () => {
      sched().invalidateAll()
      afterGraphChange(get().graph, { autoRun: false })
      set({ lastRun: undefined })
    },

    /**
     * A node's provenance key includes its upstream keys, so `ok` already implies every
     * ancestor is fresh — there is nothing for a run to do. That makes this a cheap state
     * check rather than an ancestor walk.
     */
    needsRun: (nodeId) => {
      // An annotation has nothing to compute, and the scheduler gives it no state — so the
      // 'idle' below would otherwise read as "never evaluated", which is true and useless.
      const node = get().graph.nodes.find((n) => n.id === nodeId)
      if (node && isAnnotation(node.type)) return false
      const state = sched().info(nodeId).state
      return state === 'stale' || state === 'blocked' || state === 'error' || state === 'idle'
    },

    nodeInfo: (nodeId) => sched().info(nodeId),
    nodeInputs: (nodeId) => {
      const graph = get().graph
      const node = graph.nodes.find((n) => n.id === nodeId)
      const out: Record<string, Value | undefined> = {}
      for (const port of node ? nodePorts(node, 'input') : []) {
        const edge = edgeInto(graph, nodeId, port.id)
        out[port.id] = edge ? sched().output(edge.source, edge.sourceHandle) : undefined
      }
      return out
    },
    nodeOutput: (nodeId, portId) => sched().output(nodeId, portId),
    nodeFetchedAt: (nodeId) => sched().fetchedAt(nodeId),
    nodeWarning: (nodeId) => sched().warning(nodeId),
    setNotice: (notice) => set({ notice }),
  }
})

// ---------------------------------------------------------------------------
// Selectors / helpers
// ---------------------------------------------------------------------------

export function useSelectedNode(): GraphNode | undefined {
  return useGraphStore((s) => {
    if (s.selection.length !== 1) return undefined
    return s.graph.nodes.find((n) => n.id === s.selection[0])
  })
}

/** Count of nodes waiting for a Run, for the toolbar badge. */
export function useStaleCount(): number {
  return useGraphStore((s) => {
    void s.runVersion // subscribe to scheduler ticks
    return s.graph.nodes.filter((n) => {
      const state = s.nodeInfo(n.id).state
      return state === 'stale' || state === 'blocked'
    }).length
  })
}

export function useErrorCount(): number {
  return useGraphStore((s) => {
    void s.runVersion
    return s.graph.nodes.filter((n) => s.nodeInfo(n.id).state === 'error').length
  })
}
