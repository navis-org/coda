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
import type { FeedbackCategory } from '../data/feedback'
import type { ApplyResult } from '../assistant/apply'
import { applyPlan } from '../assistant/apply'
import type { AssistantPlan } from '../assistant/planShape'
import {
  addEdge as addGraphEdge,
  edgeInto,
  emptyGraph,
  newId,
  reconnectEdge,
  removeEdges,
  removeNodes,
  setNodeParam,
  updateNode,
} from '../core/graph'
import { cloneGroups, createGroup, removeGroups, updateGroup } from '../core/groups'
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
import { getExample } from '../examples'
import type { StarterSpec } from '../examples/starters'
import { buildStarter } from '../examples/starters'
import type { WorkflowSummary } from './library'
import {
  deleteWorkflow,
  findByName,
  listWorkflows,
  loadWorkflow,
  renameWorkflow,
  saveWorkflow,
} from './library'
import { hasShareFragment } from '../data/share/fragment'
import type { EdgeRouting, LayoutOptions } from '../layout/options'
import { EDGE_ROUTINGS } from '../layout/options'
import type { PanelState, ThemePreference } from './persistence'
import {
  applyTheme,
  loadAutoRun,
  loadNotifyRuns,
  loadAutosave,
  loadLayoutPrefs,
  loadPanels,
  loadStartPageDismissed,
  loadTheme,
  saveAutoRun,
  saveNotifyRuns,
  saveLayoutPrefs,
  savePanels,
  saveAutosave,
  saveStartPageDismissed,
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
   * Whether the Zoo browser is up.
   *
   * A plain boolean owned by the store, like `startPageOpen` and unlike the palette's request
   * counter, because two unrelated surfaces open it — the toolbar's Examples menu and the
   * command palette — and neither is an ancestor of the other or of where it mounts.
   */
  zooOpen: boolean
  openZoo(): void
  closeZoo(): void
  setStartPageDismissed(dismissed: boolean): void
  /**
   * Node whose output is open in the full-size viewer overlay, if any. In the store because
   * it is triggered from the node body, the inspector and the command palette alike.
   */
  expandedNodeId: string | undefined
  expandNode(nodeId: string | undefined): void
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

  // --- document ------------------------------------------------------------
  setGraph(graph: CodaGraph, options?: { history?: boolean; tag?: string }): void
  setGraphName(name: string): void
  /** Record (or clear) the gist this workflow was last shared to. See `CodaGraph.meta.gist`. */
  setGraphGist(gist: { id: string; owner?: string } | undefined): void
  newGraph(): void
  loadGraph(graph: CodaGraph, warnings?: string[]): void
  loadExample(id: string): void
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

  const scheduler = new Scheduler({
    resolveSource: (id) => requireSource(id),
    onPreview: () => set((s) => ({ previewVersion: s.previewVersion + 1 })),
    onStateChange: () =>
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
        const next = observedSchemas(s.graph)
        if (sameObserved(next)) return { runVersion: s.runVersion + 1 }
        lastObserved = next
        return {
          runVersion: s.runVersion + 1,
          inference: inferGraph(s.graph, { observedSchemas: next }),
        }
      }),
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
      looping = true
      await iterationHandler?.(info)
    },
  })

  /**
   * Table schemas that nodes with `observesOutputSchema` actually produced.
   *
   * Only those nodes are inspected, so this stays a handful of map lookups on a graph that
   * usually has none. Comparing the result is what decides whether a finished run has to
   * trigger a re-inference — see `onStateChange`.
   */
  function observedSchemas(graph: CodaGraph): Record<string, TableSchema | undefined> {
    const observed: Record<string, TableSchema | undefined> = {}
    for (const node of graph.nodes) {
      if (!getNodeDef(node.type)?.observesOutputSchema) continue
      const outputs = scheduler.outputs(node.id)
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

  let lastObserved: Record<string, TableSchema | undefined> = {}

  function sameObserved(next: Record<string, TableSchema | undefined>): boolean {
    const a = Object.keys(lastObserved)
    const b = Object.keys(next)
    if (a.length !== b.length) return false
    // Schemas are rebuilt per run, so compare by column names rather than identity.
    return b.every((id) => {
      const before = lastObserved[id]?.columns.map((c) => `${c.name}:${c.dtype}`).join(',')
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
    set({ inference: inferGraph(graph, { observedSchemas: lastObserved }) })
  }

  /** Re-infer, refresh badges, schedule an auto pass and an autosave. */
  function afterGraphChange(graph: CodaGraph, options: { autoRun?: boolean } = {}): void {
    lastObserved = observedSchemas(graph)
    const inference = inferGraph(graph, { observedSchemas: lastObserved })
    set({ inference })
    scheduler.refreshStates(graph, inference)

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
          else void scheduler.run(get().graph, { mode: 'auto' })
        },
        full ? AUTO_FULL_RUN_DELAY_MS : AUTO_RUN_DELAY_MS,
      )
    }

    if (autosaveTimer) clearTimeout(autosaveTimer)
    autosaveTimer = setTimeout(() => saveAutosave(get().graph), AUTOSAVE_DELAY_MS)
  }

  /**
   * Run everything stale, and own `busy` while doing it.
   *
   * The token is what makes overlapping runs safe. `scheduler.run` supersedes an in-flight run by
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
      const summary = await scheduler.run(get().graph, {
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

  const initial = loadAutosave()
  /*
   * A fresh visit opens on the start page, so the canvas behind it starts empty. It used to
   * auto-load the first example instead, which now works against itself twice over: the start
   * page is the onboarding, and a graph the newcomer never asked for would make their first
   * card click trip the replace-confirm.
   */
  const initialGraph = initial?.graph.nodes.length ? initial.graph : emptyGraph()
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
  watchTabIdentity(() => saveAutosave(get().graph))
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

    zooOpen: false,
    // Closes the start page on the way in: both are full-screen modals, and the Examples menu
    // is reachable from behind one.
    openZoo: () => set({ zooOpen: true, startPageOpen: false }),
    closeZoo: () => set({ zooOpen: false }),
    setStartPageDismissed: (dismissed) => {
      saveStartPageDismissed(dismissed)
      set({ startPageDismissed: dismissed })
    },
    expandedNodeId: undefined,
    expandNode: (nodeId) => set({ expandedNodeId: nodeId }),
    helpType: undefined,
    openHelp: (type) => set({ helpType: type }),

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
      })
      scheduler.invalidateAll()
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
      })
      scheduler.invalidateAll()
      afterGraphChange(graph)
      /*
       * Frame what was just opened. Not done for `newGraph`, which has nothing to frame — and a
       * request nothing can satisfy would be left pending and fire on whatever node was added
       * next, which is worse than not fitting at all.
       */
      if (graph.nodes.length > 0) get().requestFitView()
    },

    loadExample: (id) => {
      const example = getExample(id)
      if (!example) {
        set({ notice: `No example "${id}"` })
        return
      }
      get().loadGraph(example.build())
    },

    loadStarter: (spec) => {
      get().loadGraph(buildStarter(spec))
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
        // Through `loadGraph` like every other open, so the history reset, the load warnings
        // and the fit-on-load request all behave exactly as they do for a file.
        get().loadGraph(result.graph, result.warnings)
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

    duplicateSelection: () => {
      if (frozen()) return
      const { graph, selection } = get()
      if (selection.length === 0) return
      const selected = new Set(selection)
      const idMap = new Map<string, string>()
      const clones: GraphNode[] = []
      for (const node of graph.nodes) {
        if (!selected.has(node.id)) continue
        const id = newId('n')
        idMap.set(node.id, id)
        clones.push({
          ...node,
          id,
          position: { x: node.position.x + 28, y: node.position.y + 28 },
          params: { ...node.params },
        })
      }
      // Only internal edges are copied — a clone should not silently steal external
      // inputs, and duplicating a subgraph is the common case.
      const cloneEdges: GraphEdge[] = graph.edges
        .filter((e) => idMap.has(e.source) && idMap.has(e.target))
        .map((e) => ({
          ...e,
          id: newId('e'),
          source: idMap.get(e.source)!,
          target: idMap.get(e.target)!,
        }))

      /*
       * A frame is copied only when the *whole* of it was duplicated — the rule the edge copy
       * above already follows, for the same reason: a frame around three of six cards is a
       * claim about a set nobody selected. See `cloneGroups`.
       */
      const groupClones = cloneGroups(graph, idMap)

      commit((g) => ({
        ...g,
        nodes: [...g.nodes, ...clones],
        edges: [...g.edges, ...cloneEdges],
        ...(groupClones.length ? { groups: [...(g.groups ?? []), ...groupClones] } : {}),
      }))
      set({ selection: clones.map((n) => n.id) })
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
      scheduler.cancel()
    },

    invalidateNode: (nodeId) => {
      scheduler.invalidateNode(get().graph, nodeId)
    },

    clearNodeCache: (nodeId) => {
      scheduler.clearNodeCache(get().graph, nodeId)
    },

    clearResults: () => {
      scheduler.invalidateAll()
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
      const state = scheduler.info(nodeId).state
      return state === 'stale' || state === 'blocked' || state === 'error' || state === 'idle'
    },

    nodeInfo: (nodeId) => scheduler.info(nodeId),
    nodeInputs: (nodeId) => {
      const graph = get().graph
      const node = graph.nodes.find((n) => n.id === nodeId)
      const out: Record<string, Value | undefined> = {}
      for (const port of node ? nodePorts(node, 'input') : []) {
        const edge = edgeInto(graph, nodeId, port.id)
        out[port.id] = edge ? scheduler.output(edge.source, edge.sourceHandle) : undefined
      }
      return out
    },
    nodeOutput: (nodeId, portId) => scheduler.output(nodeId, portId),
    nodeFetchedAt: (nodeId) => scheduler.fetchedAt(nodeId),
    nodeWarning: (nodeId) => scheduler.warning(nodeId),
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
