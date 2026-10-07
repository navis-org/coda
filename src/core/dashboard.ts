/**
 * The dashboard: a second view of the same graph, laid out on a grid instead of a canvas.
 *
 * A cell is **a reference to a node id, never a copy of a node**. That is the whole design and
 * every rule below follows from it: the graph stays the one source of truth, a cell shows
 * whatever that node currently holds, and nothing here can make the dashboard and the canvas
 * disagree about what a node *is*. What the dashboard owns is which nodes are worth looking at
 * and where they sit — an editorial decision, not a second document.
 *
 * Everything about a layout lives here — the shape, the mutations, the pruning and the load-time
 * validation — and `graph.ts` imports the last two. That is **not** how `groups.ts` is arranged:
 * there the mutators are in `groups.ts` while `pruneGroups` and `validGroups` sit in `graph.ts`.
 * Keeping one sub-shape's rules in one file is the better of the two, and it is written down here
 * rather than left implicit because the repo now has both and the next feature would otherwise
 * pick by coin flip. Moving groups over is the follow-up that would settle it; nothing in this
 * feature needed it.
 *
 * Three rules run through all of it.
 *
 *  - **At most one cell per node, per tab.** A cell is a mount site, and a viewer is a renderer
 *    rather than a picture — the same measurement that made `showPreview` stand a card down while
 *    the overlay owns it (3 contexts and 3 × 170 kB for one 21-neuron scene). Two cells of one
 *    neuroglancer node is two applications fetching EM. So `addCells` skips a node already
 *    placed rather than appending a second cell, and `validDashboard` drops the duplicate. Only
 *    the active tab is mounted, which is why the rule is per tab and a node may sit on several.
 *  - **Order is position.** There is no `x`/`y`: cells flow across `columns` tracks in list
 *    order, so a reorder is a splice and CSS decides the geometry. Explicit coordinates would
 *    be a second thing to keep valid when `columns` changes, and a hole nobody can see is how
 *    a layout starts lying about itself. The cost is real and stated: a cell too wide for the
 *    room left on a row moves to the next one and leaves a gap, because flow is not `dense` —
 *    dense packing would silently reorder the list the user just dragged.
 *  - **A span is clamped or snapped, never refused.** `w` is bounded by the column count, and a
 *    stored layout whose columns came down clamps on load; `h` snaps to the nearest of the four
 *    heights on offer. A refusal here would have to be explained on a drag handle, which is
 *    nowhere to explain anything.
 *
 * `w` and `h` are optional, for `groups`' reason: a dashboard nobody has resized must round trip
 * byte-identically. Note the two absences do **not** mean the same number — see
 * `DEFAULT_ROW_SPAN` for why a row has no natural unit and a column does.
 */

import type { CodaGraph, GraphNode } from './graph'
import { isAnnotation } from './registry'

/**
 * How many columns a dashboard may have.
 *
 * Six because a cell narrower than about a sixth of a window is not a view of anything — it is a
 * legend and a scrollbar, which is the same floor `.app[data-dock='open']` puts under the dock in
 * pixels. The floor is one rather than two: a single full-width cell is a legitimate dashboard,
 * and it is what "just show me the network" looks like.
 */
export const MIN_COLUMNS = 1
export const MAX_COLUMNS = 6
/** The default for a dashboard nobody has configured. Two up reads on a laptop. */
export const DEFAULT_COLUMNS = 2
/**
 * How many row tracks the visible grid area is divided into.
 *
 * Six, and the number is the lowest common denominator of the heights on offer rather than a
 * taste: a cell may be **a third, a half, two thirds or the whole** of the screen, which needs
 * sixths to express. The tracks themselves are never a size somebody chooses — `ROW_SPANS` is —
 * so six is an implementation detail of the arithmetic and not a control.
 *
 * The first version made a row `44vh` and let `h` span up to three. Two things were wrong with
 * it and both were only visible on a real screen: `vh` is the *window*, not the area left after
 * the toolbar, the dashboard's own bar, the status bar and the padding, so the grid was always a
 * little taller than its box and every dashboard had a scrollbar it had not earned — with the
 * bottom row's resize corner behind the status bar. And two rows of 44vh is the only layout that
 * fits, so the four heights were really two.
 */
export const ROW_TRACKS = 6

/**
 * The heights a cell may be, in tracks: a third, a half, two thirds, the whole area.
 *
 * A short list of *meaningful* stops rather than every integer up to six. A drag is continuous
 * and snaps to the nearest, so what the gesture offers is four sizes that mean something against
 * the screen instead of six that mean something against a track nobody can see. One track alone
 * is not on the list because a sixth of a window is a header and a scrollbar.
 */
export const ROW_SPANS: readonly number[] = [2, 3, 4, 6]

/**
 * What a cell is when nobody has resized it: half the visible area.
 *
 * **Absent means this, not one** — the one place the dashboard's "absent means the smallest
 * thing" rule does not hold, and deliberately. A column span of 1 is a natural unit (one of
 * however many columns you asked for); a row track is not, because rows are a subdivision of the
 * screen rather than something chosen. So `h` is stored only when it differs from this, which
 * keeps a dashboard nobody has resized round-tripping byte-identically while making the default
 * cell a usable size.
 */
export const DEFAULT_ROW_SPAN = 3

/** The nearest height on offer. Ties go to the shorter, which never grows a cell unasked. */
export function snapRowSpan(tracks: number): number {
  if (!Number.isFinite(tracks)) return DEFAULT_ROW_SPAN
  let best = ROW_SPANS[0]!
  for (const span of ROW_SPANS) {
    if (Math.abs(span - tracks) < Math.abs(best - tracks)) best = span
  }
  return best
}

export interface DashboardCell {
  /** The node this cell draws. Never a copy of it — see the file note. */
  nodeId: string
  /** Columns spanned. Absent means 1. */
  w?: number
  /** Height in row tracks, one of `ROW_SPANS`. Absent means `DEFAULT_ROW_SPAN` — see there. */
  h?: number
  /**
   * The cell's control rail is open. Absent means closed, and only `true` is ever written.
   *
   * In the document beside the cell's size rather than in component state, because a cell is
   * unmounted every time the grid gives way to the canvas, and a rail somebody opened to tune a
   * node — Split Axon/Dendrite's thresholds beside a 3D View — is part of how they arranged the
   * page. So it survives switching views, a reload and a share link alike.
   */
  rail?: true
}

/**
 * One page of the dashboard: its own grid, its own column count, its own cells.
 *
 * **A node may have a cell on several tabs, and at most one on each.** The one-cell rule exists
 * because a cell is a mount site, and only the active tab is mounted — the others are unmounted,
 * never hidden — so a node on two tabs is still one live renderer at a time.
 *
 * **A tab may be empty.** A new one starts that way, and one somebody named must not vanish
 * because the last node on it was deleted from the canvas. What is dropped is the layout as a
 * whole, and only once it has come down to the one thing that is indistinguishable from having no
 * dashboard: a single untitled tab with nothing on it. See `normalized`.
 */
export interface DashboardTab {
  /**
   * Stable within the layout, never shown. A tab is addressed by this rather than by position
   * because its position is exactly what a reorder changes, and an undo tag or an `active` naming
   * a position would silently start naming a neighbour.
   */
  id: string
  /** What the strip shows. Absent means a generated label — see `tabLabel`. */
  title?: string
  /** Track count, `MIN_COLUMNS`..`MAX_COLUMNS`. */
  columns: number
  /** The cells, in the order they flow. */
  cells: DashboardCell[]
}

/**
 * The id of the first tab of a layout that was never given a second — and of the one tab a file
 * in the single-tab form loads as. Fixed rather than minted, so a load involves no randomness and
 * the same file always produces the same graph.
 */
export const FIRST_TAB_ID = 'main'

/** Longest title a tab may carry. A strip of tabs is a row, and a title is a label, not prose. */
export const MAX_TAB_TITLE = 40

export interface DashboardLayout {
  /**
   * The pages, in strip order. Never empty. In memory this is always a list, even for one tab;
   * on disk a single untitled tab keeps the form every dashboard had before tabs existed — see
   * `storedDashboard`.
   */
  tabs: DashboardTab[]
  /**
   * The tab on screen, and so the one a graph saved from the grid opens on. Absent means the
   * first. Written only when it is not the first, for `open`'s reason.
   *
   * The document is the **only** place this is held — no live copy in the store beside it, unlike
   * `dashboardOpen`. That is what makes an undo land on the tab where the undone edit happened:
   * history holds whole graphs, so the snapshot from before an edit on tab A says A. A second
   * copy would have to choose between agreeing with the snapshot and agreeing with the screen.
   */
  active?: string
  /**
   * Whether this graph was **saved while the dashboard was the view**, and therefore opens into
   * it. Absent means the canvas, which is every graph that has never had one.
   *
   * A past-tense fact about the document rather than live UI state — the store's `dashboardOpen`
   * is the truth while running, and this is what the last save saw. `setViewOpen` is the only
   * writer, and it is called from the mode setters *and* from every layout mutator, because
   * adding the first cell is the other moment at which a layout that can carry the flag comes
   * into existence.
   *
   * **This is the one place a document decides what the app shows on open, and it is deliberate
   * rather than an oversight against `locked`'s rule that a graph somebody sends you never
   * arrives frozen.** The two are not the same promise: a lock takes editing away and says so
   * only in a padlock, while a dashboard takes nothing away — the graph is intact behind it, the
   * bar carries `← Canvas`, and `D` is one keypress. What a lock would inherit is a disability;
   * what this inherits is the author's answer to "which of these two views is this workflow
   * *for*". A dashboard nobody chose to save from is exactly the graph where the flag is absent.
   *
   * Written only when true, so a graph that has never been looked at as a dashboard round trips
   * byte-identically — `GraphGroup.filled`'s idiom.
   */
  open?: true
}

export function clampColumns(columns: number): number {
  if (!Number.isFinite(columns)) return DEFAULT_COLUMNS
  return Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, Math.round(columns)))
}

/**
 * A cell's spans, clamped against the tab it is in.
 *
 * Takes the column count rather than reading it off a tab so that `setColumns` can re-clamp
 * every cell against the *new* count in one pass — the case where an unclamped `w` would
 * otherwise reach a stylesheet as `grid-column: span 6` in a four-column grid, where CSS quietly
 * truncates it and the drag handle then disagrees with what is on screen.
 */
export function clampSpan(cell: DashboardCell, columns: number): DashboardCell {
  const w = Math.min(columns, Math.max(1, Math.round(cell.w ?? 1)))
  // Snapped rather than clamped, because the row axis offers four heights and not a range — an
  // `h` off the list (a hand-edited file, or the version of this that allowed three) would
  // otherwise reach the stylesheet as a track count no drag could ever reproduce.
  const h = snapRowSpan(Math.round(cell.h ?? DEFAULT_ROW_SPAN))
  return {
    nodeId: cell.nodeId,
    ...(w > 1 ? { w } : {}),
    ...(h !== DEFAULT_ROW_SPAN ? { h } : {}),
    // Carried, not clamped: every cell this builds goes through here, a resize included.
    ...(cell.rail ? { rail: true as const } : {}),
  }
}

/** A title as stored: trimmed, capped, and absent rather than empty. */
function cleanTitle(title: unknown): string | undefined {
  if (typeof title !== 'string') return undefined
  const clean = title.trim().slice(0, MAX_TAB_TITLE).trim()
  return clean || undefined
}

/**
 * The layout of a graph with no dashboard: one empty first tab.
 *
 * A module constant rather than a literal per call, so a selector reading through `dashboardOf`
 * or `activeTab` on such a graph returns the same object every time — invariant 7. Nothing here
 * mutates a layout, so sharing it is safe.
 */
const NO_DASHBOARD: DashboardLayout = {
  tabs: [{ id: FIRST_TAB_ID, columns: DEFAULT_COLUMNS, cells: [] }],
}

/** The layout on a graph, or an empty one. Never `undefined`, so callers need no branch. */
export function dashboardOf(graph: CodaGraph): DashboardLayout {
  return graph.dashboard ?? NO_DASHBOARD
}

/** Where a tab sits in the strip, or -1. The one place a tab is looked up by id. */
function tabIndex(layout: DashboardLayout, tabId: string | undefined): number {
  return tabId === undefined ? -1 : layout.tabs.findIndex((t) => t.id === tabId)
}

function activeIndex(layout: DashboardLayout): number {
  return Math.max(0, tabIndex(layout, layout.active))
}

/** The tab on screen: the one `active` names, else the first. Never `undefined`. */
export function activeTab(graph: CodaGraph): DashboardTab {
  const layout = dashboardOf(graph)
  return layout.tabs[activeIndex(layout)]!
}

/** Where a tab sits — the active one when no id is given, -1 for an id with no tab. */
function tabAt(layout: DashboardLayout, tabId: string | undefined): number {
  return tabId === undefined ? activeIndex(layout) : tabIndex(layout, tabId)
}

/** A tab by id, or the active one when no id is given. `undefined` for an id with no tab. */
function tabOf(graph: CodaGraph, tabId?: string): DashboardTab | undefined {
  const layout = dashboardOf(graph)
  return layout.tabs[tabAt(layout, tabId)]
}

/**
 * Whether the dashboard is in use as *pages* — more than one tab, or one somebody named — rather
 * than the single grid every dashboard was before tabs existed.
 *
 * The one rule for that question: it decides the form a layout is written in (`storedDashboard`)
 * and every surface whose wording or rows change between "the dashboard" and "this tab". Written
 * per surface it had become `tabs.length > 1` in the UI and "several, or titled" on disk, so a
 * lone tab named *Overview* drew its name in the strip and was "the dashboard" everywhere else.
 */
export function isTabbed(layout: DashboardLayout): boolean {
  return layout.tabs.length > 1 || !!layout.tabs[0]?.title
}

/**
 * What a sentence calls the page on screen: "the dashboard" until it is in use as pages, then
 * "this tab". Here beside `isTabbed` so a surface words it by calling this rather than writing
 * its own ternary — the cell's ✕ was the one that still said "the dashboard" while removing a
 * node from one page of several.
 */
export function pageNoun(layout: DashboardLayout): 'this tab' | 'the dashboard' {
  return isTabbed(layout) ? 'this tab' : 'the dashboard'
}

/**
 * What the strip calls a tab.
 *
 * An untitled tab is "Dashboard" while it is the only one — which is every dashboard made before
 * tabs existed, so nothing they show changes — and "Tab n" by position once there are several.
 * By position, not by id: ids are never shown, and "Tab 3" in third place is the label that
 * means something.
 */
export function tabLabel(
  layout: DashboardLayout,
  tab: DashboardTab,
  /** Its position, when the caller is walking the strip and already has it. */
  index = layout.tabs.indexOf(tab),
): string {
  if (tab.title) return tab.title
  if (layout.tabs.length === 1) return 'Dashboard'
  return `Tab ${index + 1}`
}

/**
 * Whether every one of `ids` has a cell on this tab — what decides whether a gesture over a
 * selection reads Add or Remove, so the context menu and the palette ask it here and cannot
 * disagree. `every`, not `some`: with a mixed selection the useful act is to finish putting them
 * all on. No ids is never "all on", or an empty selection would offer to remove nothing.
 */
export function allOnTab(tab: DashboardTab, ids: readonly string[]): boolean {
  if (ids.length === 0) return false
  const placed = new Set(tab.cells.map((c) => c.nodeId))
  return ids.every((id) => placed.has(id))
}

/**
 * Whether a node can be drawn in a cell at all.
 *
 * An annotation cannot: a text note is never evaluated and has no body registered for the
 * full-size surfaces, so a cell for one draws a header over an empty box.
 *
 * **Here, and enforced in `addCells` and `validDashboard`**, rather than as a filter in each
 * surface that offers the gesture. Written per surface it was three spellings of one editorial
 * rule and already had two holes: the "Add the N selected" row and the context menu's
 * multi-select both passed the whole selection, having checked only the *clicked* node — so a
 * note picked up by a rubber band got a cell. That is the same class of rule as one-cell-per-node,
 * which is enforced in both places for the same reason: a hand-edited file is the other way a
 * bad cell arrives.
 */
export function canHaveCell(node: GraphNode): boolean {
  return !isAnnotation(node.type)
}

/**
 * The subset of `ids` that could have a cell, in the order given.
 *
 * One `Map` rather than a `find` per id: the palette rebuilds its rows on every store tick while
 * it is open, and the obvious nested form is O(selection × nodes) — which with ⌘A on a large
 * graph is tens of thousands of comparisons per mesh fragment streaming in.
 */
export function placeableIds(graph: CodaGraph, ids: readonly string[]): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  return ids.filter((id) => {
    const node = byId.get(id)
    return node !== undefined && canHaveCell(node)
  })
}

/** Nodes that could be added to a tab — the active one unless another is named. */
export function unplacedNodes(graph: CodaGraph, tabId?: string): GraphNode[] {
  const placed = new Set(tabOf(graph, tabId)?.cells.map((c) => c.nodeId))
  return graph.nodes.filter((n) => !placed.has(n.id) && canHaveCell(n))
}

/**
 * A layout with its two derived facts settled, or `undefined` when nothing is left of it.
 *
 * `active` is dropped when it names the first tab (absence already means that) or no tab at all
 * (a stale id must not decide anything). And a layout that has come down to **one untitled tab
 * with no cells** is no layout: it is the state of every graph nobody has put on a dashboard, so
 * it must serialise as one — `pruneGroups`' rule, or every file in the Zoo changes bytes on its
 * next save for a feature it does not use. A second tab, or a name, is somebody's decision and is
 * kept even empty.
 */
function normalized(layout: DashboardLayout): DashboardLayout | undefined {
  const [first] = layout.tabs
  if (!first) return undefined
  if (!isTabbed(layout) && !first.cells.length) return undefined
  const { active, ...rest } = layout
  return tabIndex(layout, active) > 0 ? layout : rest
}

/** Write a layout back, dropping it entirely when nothing is left — see `normalized`. */
function withDashboard(graph: CodaGraph, layout: DashboardLayout): CodaGraph {
  const kept = normalized(layout)
  const next = { ...graph }
  if (kept) next.dashboard = kept
  else delete next.dashboard
  return next
}

/**
 * Replace one tab — the active one unless another is named — through `edit`.
 *
 * Unchanged by identity when the tab does not exist or `edit` hands it back unchanged, which is
 * what every mutator below relies on to keep a gesture that did nothing from costing an undo step.
 */
function updateTab(
  graph: CodaGraph,
  tabId: string | undefined,
  edit: (tab: DashboardTab) => DashboardTab,
): CodaGraph {
  const layout = dashboardOf(graph)
  const at = tabAt(layout, tabId)
  const tab = layout.tabs[at]
  if (!tab) return graph
  const next = edit(tab)
  if (next === tab) return graph
  const tabs = layout.tabs.map((t, i) => (i === at ? next : t))
  return withDashboard(graph, { ...layout, tabs })
}

/** The smallest `t<n>` not already an id here, from 2 — the first tab being `FIRST_TAB_ID`. */
function nextTabId(taken: Iterable<string>): string {
  const used = new Set(taken)
  for (let n = 2; ; n++) if (!used.has(`t${n}`)) return `t${n}`
}

/**
 * Record which of the two views the document was last seen through.
 *
 * Unchanged by identity when there is nothing to record, which is both of the cases that matter:
 * a graph with no layout at all — where writing the flag would mint a dashboard nobody asked for
 * and break the byte-identical round trip — and a flag that already says what it is being told.
 *
 * Composed *around* the mutators rather than called after them (`setViewOpen(addCells(g, ids),
 * open)`), so a graph gains its first cell and its view flag in one commit. Two commits would
 * leave a state where the dashboard exists and does not know it is being looked at, which is
 * exactly the state a save in between would capture.
 */
export function setViewOpen(graph: CodaGraph, open: boolean): CodaGraph {
  const layout = graph.dashboard
  if (!layout) return graph
  if (open === (layout.open === true)) return graph
  const { open: _open, ...rest } = layout
  return { ...graph, dashboard: open ? { ...rest, open: true } : rest }
}

/**
 * Append cells for nodes not already on the tab, in the order given.
 *
 * Returns the graph **unchanged by identity** when every node was already there — what lets the
 * store skip an undo step for a gesture that did nothing, the same contract `pruneGroups` offers.
 */
export function addCells(
  graph: CodaGraph,
  nodeIds: readonly string[],
  tabId?: string,
): CodaGraph {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  return updateTab(graph, tabId, (tab) => {
    const present = new Set(tab.cells.map((c) => c.nodeId))
    const added: DashboardCell[] = []
    for (const id of nodeIds) {
      const node = byId.get(id)
      if (!node || present.has(id) || !canHaveCell(node)) continue
      present.add(id)
      added.push({ nodeId: id })
    }
    return added.length ? { ...tab, cells: [...tab.cells, ...added] } : tab
  })
}

export function removeCells(
  graph: CodaGraph,
  nodeIds: readonly string[],
  tabId?: string,
): CodaGraph {
  const dead = new Set(nodeIds)
  return updateTab(graph, tabId, (tab) => {
    const cells = tab.cells.filter((c) => !dead.has(c.nodeId))
    return cells.length === tab.cells.length ? tab : { ...tab, cells }
  })
}

/**
 * Move one cell to `toIndex`, counted in the list **after** the cell has been lifted out.
 *
 * That is the convention a drop between two cells produces naturally — "put it before the cell
 * currently at index n" — and getting it the other way round makes dragging a cell one place to
 * the right do nothing, which reads as the drag having missed.
 */
export function moveCell(
  graph: CodaGraph,
  nodeId: string,
  toIndex: number,
  tabId?: string,
): CodaGraph {
  return updateTab(graph, tabId, (tab) => {
    const cells = moved(tab.cells, (c) => c.nodeId === nodeId, toIndex)
    return cells ? { ...tab, cells } : tab
  })
}

/** `list` with the first match moved to `toIndex` (counted after lifting), or `undefined` if no move. */
function moved<T>(
  list: readonly T[],
  match: (item: T) => boolean,
  toIndex: number,
): T[] | undefined {
  const from = list.findIndex(match)
  if (from < 0) return undefined
  const rest = list.filter((_, i) => i !== from)
  const to = Math.min(rest.length, Math.max(0, Math.round(toIndex)))
  if (to === from) return undefined
  return [...rest.slice(0, to), list[from]!, ...rest.slice(to)]
}

export function setSpan(
  graph: CodaGraph,
  nodeId: string,
  span: { w?: number; h?: number },
  tabId?: string,
): CodaGraph {
  return updateTab(graph, tabId, (tab) => {
    let changed = false
    const cells = tab.cells.map((cell) => {
      if (cell.nodeId !== nodeId) return cell
      // From the cell, so whatever else it carries (an open rail) rides through the resize.
      const next = clampSpan({ ...cell, w: span.w ?? cell.w, h: span.h ?? cell.h }, tab.columns)
      if (
        (next.w ?? 1) === (cell.w ?? 1) &&
        (next.h ?? DEFAULT_ROW_SPAN) === (cell.h ?? DEFAULT_ROW_SPAN)
      )
        return cell
      changed = true
      return next
    })
    return changed ? { ...tab, cells } : tab
  })
}

/** Open or close one cell's control rail. Unchanged returns the same graph. */
export function setRail(
  graph: CodaGraph,
  nodeId: string,
  open: boolean,
  tabId?: string,
): CodaGraph {
  return updateTab(graph, tabId, (tab) => {
    let changed = false
    const cells = tab.cells.map((cell) => {
      if (cell.nodeId !== nodeId || (cell.rail === true) === open) return cell
      changed = true
      const { rail: _was, ...rest } = cell
      return open ? { ...rest, rail: true as const } : rest
    })
    return changed ? { ...tab, cells } : tab
  })
}

/** Re-track a tab's grid, clamping every cell that was wider than the new count. */
export function setColumns(graph: CodaGraph, columns: number, tabId?: string): CodaGraph {
  // Needed here, unlike the cell mutators above: a column count is a change even on the empty
  // tab of a graph with no dashboard, and would hand back a new graph that says nothing new.
  if (!graph.dashboard) return graph
  const next = clampColumns(columns)
  return updateTab(graph, tabId, (tab) =>
    next === tab.columns
      ? tab
      : { ...tab, columns: next, cells: tab.cells.map((c) => clampSpan(c, next)) },
  )
}

// --- tabs --------------------------------------------------------------------

/**
 * Put a tab on screen. Unchanged by identity for a tab that does not exist or is already active.
 *
 * Not an undo step at the store (`history: false`), for `open`'s reason — looking at another page
 * is not an edit — and never mints a layout: switching tabs on a graph with no dashboard has
 * nothing to switch between.
 */
export function setActiveTab(graph: CodaGraph, tabId: string): CodaGraph {
  const layout = graph.dashboard
  if (!layout || tabIndex(layout, tabId) < 0) return graph
  if (activeTab(graph).id === tabId) return graph
  return withDashboard(graph, { ...layout, active: tabId })
}

/**
 * Append an empty tab and put it on screen.
 *
 * It takes the active tab's column count rather than the default, because a second page of the
 * same dashboard is far likelier to want the first one's grid than a laptop default. On a graph
 * with no dashboard this mints a layout of two tabs — the first empty — which is the one way
 * a layout comes into existence without a cell: asking for a second page is a decision.
 */
export function addTab(graph: CodaGraph, title?: string): CodaGraph {
  return insertTab(graph, dashboardOf(graph).tabs.length, {
    title,
    columns: activeTab(graph).columns,
    cells: [],
  })
}

/** Put a new tab at `at` with a fresh id, and put it on screen. `addTab` and `duplicateTab`. */
function insertTab(graph: CodaGraph, at: number, page: Omit<DashboardTab, 'id'>): CodaGraph {
  const layout = dashboardOf(graph)
  const id = nextTabId(layout.tabs.map((t) => t.id))
  const title = cleanTitle(page.title)
  const tab: DashboardTab = {
    id,
    ...(title ? { title } : {}),
    columns: page.columns,
    cells: page.cells,
  }
  const tabs = [...layout.tabs.slice(0, at), tab, ...layout.tabs.slice(at)]
  return withDashboard(graph, { ...layout, tabs, active: id })
}

/** Name a tab. An empty or blank title removes the name rather than storing an empty one. */
export function renameTab(graph: CodaGraph, tabId: string, title: string): CodaGraph {
  if (!graph.dashboard) return graph
  const clean = cleanTitle(title)
  return updateTab(graph, tabId, (tab) => {
    if (clean === tab.title) return tab
    const { title: _title, ...rest } = tab
    return clean ? { ...tab, title: clean } : rest
  })
}

/**
 * Take a tab off — its cells, never its nodes.
 *
 * The only tab cannot be removed: the gesture for an emptied dashboard is taking its cells off,
 * and a dashboard with no tab is not a state the grid can draw. When the removed tab was on
 * screen its right-hand neighbour takes its place, else its left — the convention every tab strip
 * follows, so the strip does not jump somewhere unrelated.
 */
export function removeTab(graph: CodaGraph, tabId: string): CodaGraph {
  const layout = graph.dashboard
  if (!layout || layout.tabs.length < 2) return graph
  const at = tabIndex(layout, tabId)
  if (at < 0) return graph
  const tabs = layout.tabs.filter((_, i) => i !== at)
  const current = activeTab(graph)
  const active = current.id === tabId ? tabs[Math.min(at, tabs.length - 1)]! : current
  return withDashboard(graph, { ...layout, tabs, active: active.id })
}

/** Move a tab in the strip, `toIndex` counted after it is lifted out — `moveCell`'s convention. */
export function moveTab(graph: CodaGraph, tabId: string, toIndex: number): CodaGraph {
  const layout = graph.dashboard
  if (!layout) return graph
  const tabs = moved(layout.tabs, (t) => t.id === tabId, toIndex)
  if (!tabs) return graph
  // `active` is an id, so it follows the tab — but absence means "the first", and the first is
  // what just changed, so the tab on screen is pinned by id across the move.
  return withDashboard(graph, { ...layout, tabs, active: activeTab(graph).id })
}

/**
 * Copy a tab — same cells, same spans, same grid — into place beside it, and put the copy on
 * screen. Legal only because the one-cell rule is per tab: the copy holds the same nodes.
 */
export function duplicateTab(graph: CodaGraph, tabId: string): CodaGraph {
  const layout = graph.dashboard
  if (!layout) return graph
  const at = tabIndex(layout, tabId)
  const source = layout.tabs[at]
  if (!source) return graph
  return insertTab(graph, at + 1, {
    title: source.title && `${source.title} copy`,
    columns: source.columns,
    // Shared, not copied: no mutator edits a cell in place.
    cells: source.cells,
  })
}

/**
 * Drop cells naming nodes that are not in the graph, on every tab.
 *
 * Called from `removeNodes` beside `pruneGroups`, and for that function's reason: deletion
 * arrives by four routes, and a cell holding a dead id is invisible until somebody opens the
 * dashboard and finds a hole — by which time the deletion is several undo steps back. An emptied
 * tab is **kept** (see `DashboardTab`); only the layout that has become no layout goes.
 *
 * Unchanged by identity when there was nothing to prune.
 */
export function pruneDashboard(graph: CodaGraph): CodaGraph {
  const layout = graph.dashboard
  if (!layout) return graph
  const alive = new Set(graph.nodes.map((n) => n.id))
  let changed = false
  const tabs = layout.tabs.map((tab) => {
    const cells = tab.cells.filter((c) => alive.has(c.nodeId))
    if (cells.length === tab.cells.length) return tab
    changed = true
    return { ...tab, cells }
  })
  return changed ? withDashboard(graph, { ...layout, tabs }) : graph
}

// --- on disk -----------------------------------------------------------------

/** The single-tab form: every dashboard written before tabs existed. */
interface StoredSingle {
  columns: number
  cells: DashboardCell[]
  open?: true
}

/**
 * A layout as it is written to a file.
 *
 * **A single untitled tab keeps the form every dashboard had before tabs existed** —
 * `{ columns, cells, open }`, in that key order — so a dashboard that does not use tabs round
 * trips byte-identically, the same idea as an absent `w` meaning 1. Anything else — a second tab,
 * or a title — is written as `{ tabs, active, open }`.
 *
 * `serializeGraph` calls this, and every writer of graph JSON goes through `serializeGraph` (or
 * `fragmentBody`, which drops the dashboard). `validDashboard` reads both forms.
 *
 * A build from before tabs reading the list form finds no `cells` and drops the whole dashboard
 * without a word. Accepted: the deployed app and the MCP bundle ship together, so the reader of a
 * file this build wrote is this build or a later one.
 */
export function storedDashboard(layout: DashboardLayout): StoredSingle | DashboardLayout {
  const flag = layout.open ? { open: true as const } : {}
  const [only] = layout.tabs
  if (only && !isTabbed(layout)) return { columns: only.columns, cells: only.cells, ...flag }
  return {
    tabs: layout.tabs.map((t) => ({
      id: t.id,
      ...(t.title ? { title: t.title } : {}),
      columns: t.columns,
      cells: t.cells,
    })),
    ...(layout.active !== undefined ? { active: layout.active } : {}),
    ...flag,
  }
}

/**
 * A stored tab's grid: its column count and the cells that survive, per the rules below.
 * A `cells` that is not a list is a tab with nothing on it, not a reason to drop the tab.
 */
function validGrid(
  columns: unknown,
  cells: unknown,
  alive: ReadonlyMap<string, GraphNode>,
): { columns: number; cells: DashboardCell[] } {
  const tracks = clampColumns(typeof columns === 'number' ? columns : DEFAULT_COLUMNS)
  const seen = new Set<string>()
  const kept: DashboardCell[] = []
  for (const cell of Array.isArray(cells) ? cells : []) {
    if (!cell || typeof cell !== 'object') continue
    const { nodeId, w, h, rail } = cell as Record<string, unknown>
    if (typeof nodeId !== 'string' || seen.has(nodeId)) continue
    const node = alive.get(nodeId)
    if (!node || !canHaveCell(node)) continue
    seen.add(nodeId)
    kept.push(
      clampSpan(
        {
          nodeId,
          ...(typeof w === 'number' && Number.isFinite(w) ? { w } : {}),
          ...(typeof h === 'number' && Number.isFinite(h) ? { h } : {}),
          // `=== true`, the `open` flag's rule: a hand-edited `"rail": "yes"` decides nothing.
          ...(rail === true ? { rail: true as const } : {}),
        },
        tracks,
      ),
    )
  }
  return { columns: tracks, cells: kept }
}

/**
 * A stored layout, in either form, with anything malformed dropped.
 *
 * The same lenient-but-checked pass `validGroups` and `validMeta` give the rest of a loaded
 * file, and silent for the same reason: the document still means what it said minus decoration,
 * and a warning per stale cell on a graph somebody was sent would bury the warnings that are
 * about their data.
 *
 * A cell naming a node that was dropped as an unknown type goes, as does the second cell for a
 * node named twice on one tab, as does one naming a node that cannot be drawn — all three rules
 * are enforced *here* as well as in `addCells`, because a hand-edited file is the other way each
 * of them arrives, and what they cause (two live WebGL contexts, a header over an empty box)
 * reads as a broken cell rather than a bad file.
 *
 * In the list form a tab with a missing or repeated id is given a fresh one rather than dropped —
 * its cells are what somebody arranged, and the id is bookkeeping. A list form holding a list
 * wins over stray single-form keys beside it.
 */
export function validDashboard(
  raw: unknown,
  /** The surviving nodes by id — their *types* matter here, not only that they exist. */
  alive: ReadonlyMap<string, GraphNode>,
): DashboardLayout | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const { columns, cells, tabs, active, open } = raw as Record<string, unknown>
  // `=== true` rather than truthiness, and only then written: a `"open": "yes"` from a
  // hand-edited file must not decide which view somebody's app opens in.
  const flag = open === true ? { open: true as const } : {}

  if (Array.isArray(tabs)) {
    const ids = new Set<string>()
    const kept: DashboardTab[] = []
    for (const tab of tabs) {
      if (!tab || typeof tab !== 'object') continue
      const t = tab as Record<string, unknown>
      const id = typeof t.id === 'string' && t.id && !ids.has(t.id) ? t.id : nextTabId(ids)
      ids.add(id)
      const title = cleanTitle(t.title)
      kept.push({ id, ...(title ? { title } : {}), ...validGrid(t.columns, t.cells, alive) })
    }
    return normalized({
      tabs: kept,
      // Kept only if it names a tab past the first — `normalized` drops anything else.
      active: typeof active === 'string' ? active : undefined,
      ...flag,
    })
  }

  if (!Array.isArray(cells)) return undefined
  const grid = validGrid(columns, cells, alive)
  if (!grid.cells.length) return undefined
  return { tabs: [{ id: FIRST_TAB_ID, ...grid }], ...flag }
}
