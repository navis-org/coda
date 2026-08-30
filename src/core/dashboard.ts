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
 *  - **At most one cell per node.** A cell is a mount site, and a viewer is a renderer rather
 *    than a picture — the same measurement that made `showPreview` stand a card down while the
 *    overlay owns it (3 contexts and 3 × 170 kB for one 21-neuron scene). Two cells of one
 *    neuroglancer node is two applications fetching EM. So `addCells` skips a node already
 *    placed rather than appending a second cell, and `validDashboard` drops the duplicate.
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
}

export interface DashboardLayout {
  /** Track count, `MIN_COLUMNS`..`MAX_COLUMNS`. */
  columns: number
  /**
   * The cells, in the order they flow. Never empty — an emptied dashboard is dropped, the way
   * `pruneGroups` drops an emptied frame, so "has a dashboard" and "has cells" are one question.
   */
  cells: DashboardCell[]
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
 * A cell's spans, clamped against the layout it is in.
 *
 * Takes the column count rather than reading it off a layout so that `setColumns` can re-clamp
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
  }
}

/** The layout on a graph, or an empty one. Never `undefined`, so callers need no branch. */
export function dashboardOf(graph: CodaGraph): DashboardLayout {
  return graph.dashboard ?? { columns: DEFAULT_COLUMNS, cells: [] }
}

export function isOnDashboard(graph: CodaGraph, nodeId: string): boolean {
  return graph.dashboard?.cells.some((c) => c.nodeId === nodeId) ?? false
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

/** Nodes that could be added: everything placeable that is not already a cell. */
export function unplacedNodes(graph: CodaGraph): GraphNode[] {
  const placed = new Set(graph.dashboard?.cells.map((c) => c.nodeId))
  return graph.nodes.filter((n) => !placed.has(n.id) && canHaveCell(n))
}

/**
 * Write a layout back, dropping it entirely when nothing is left.
 *
 * The `delete` rather than a stored empty layout is `pruneGroups`' rule: a graph nobody has put
 * on a dashboard must serialise exactly as it did before this feature existed, or every file in
 * the Zoo changes bytes on its next save for a feature it does not use.
 */
function withDashboard(graph: CodaGraph, layout: DashboardLayout): CodaGraph {
  const next = { ...graph }
  if (layout.cells.length) next.dashboard = layout
  else delete next.dashboard
  return next
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
  const next: DashboardLayout = { columns: layout.columns, cells: layout.cells }
  if (open) next.open = true
  return { ...graph, dashboard: next }
}

/**
 * Append cells for nodes not already placed, in the order given.
 *
 * Returns the graph **unchanged by identity** when every node was already on the dashboard —
 * what lets the store skip an undo step for a gesture that did nothing, the same contract
 * `pruneGroups` offers.
 */
export function addCells(graph: CodaGraph, nodeIds: readonly string[]): CodaGraph {
  const layout = dashboardOf(graph)
  const present = new Set(layout.cells.map((c) => c.nodeId))
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const added: DashboardCell[] = []
  for (const id of nodeIds) {
    const node = byId.get(id)
    if (!node || present.has(id) || !canHaveCell(node)) continue
    present.add(id)
    added.push({ nodeId: id })
  }
  if (!added.length) return graph
  return withDashboard(graph, { ...layout, cells: [...layout.cells, ...added] })
}

export function removeCells(graph: CodaGraph, nodeIds: readonly string[]): CodaGraph {
  const layout = graph.dashboard
  if (!layout) return graph
  const dead = new Set(nodeIds)
  const cells = layout.cells.filter((c) => !dead.has(c.nodeId))
  if (cells.length === layout.cells.length) return graph
  return withDashboard(graph, { ...layout, cells })
}

/**
 * Move one cell to `toIndex`, counted in the list **after** the cell has been lifted out.
 *
 * That is the convention a drop between two cells produces naturally — "put it before the cell
 * currently at index n" — and getting it the other way round makes dragging a cell one place to
 * the right do nothing, which reads as the drag having missed.
 */
export function moveCell(graph: CodaGraph, nodeId: string, toIndex: number): CodaGraph {
  const layout = graph.dashboard
  if (!layout) return graph
  const from = layout.cells.findIndex((c) => c.nodeId === nodeId)
  if (from < 0) return graph
  const rest = layout.cells.filter((_, i) => i !== from)
  const to = Math.min(rest.length, Math.max(0, Math.round(toIndex)))
  if (to === from) return graph
  const cells = [...rest.slice(0, to), layout.cells[from]!, ...rest.slice(to)]
  return withDashboard(graph, { ...layout, cells })
}

export function setSpan(
  graph: CodaGraph,
  nodeId: string,
  span: { w?: number; h?: number },
): CodaGraph {
  const layout = graph.dashboard
  if (!layout) return graph
  let changed = false
  const cells = layout.cells.map((cell) => {
    if (cell.nodeId !== nodeId) return cell
    const next = clampSpan({ nodeId, w: span.w ?? cell.w, h: span.h ?? cell.h }, layout.columns)
    if (
      (next.w ?? 1) === (cell.w ?? 1) &&
      (next.h ?? DEFAULT_ROW_SPAN) === (cell.h ?? DEFAULT_ROW_SPAN)
    )
      return cell
    changed = true
    return next
  })
  return changed ? withDashboard(graph, { ...layout, cells }) : graph
}

/** Re-track the grid, clamping every cell that was wider than the new count. */
export function setColumns(graph: CodaGraph, columns: number): CodaGraph {
  const layout = graph.dashboard
  if (!layout) return graph
  const next = clampColumns(columns)
  if (next === layout.columns) return graph
  // Spread, so re-tracking the grid does not quietly drop the view flag — the one layout
  // literal in this file that is not built from `...layout`, and the only place that could.
  return withDashboard(graph, {
    ...layout,
    columns: next,
    cells: layout.cells.map((c) => clampSpan(c, next)),
  })
}

/**
 * Drop cells naming nodes that are not in the graph.
 *
 * Called from `removeNodes` beside `pruneGroups`, and for that function's reason: deletion
 * arrives by four routes, and a cell holding a dead id is invisible until somebody opens the
 * dashboard and finds a hole — by which time the deletion is several undo steps back.
 *
 * Unchanged by identity when there was nothing to prune.
 */
export function pruneDashboard(graph: CodaGraph): CodaGraph {
  const layout = graph.dashboard
  if (!layout?.cells.length) return graph
  const alive = new Set(graph.nodes.map((n) => n.id))
  const cells = layout.cells.filter((c) => alive.has(c.nodeId))
  if (cells.length === layout.cells.length) return graph
  return withDashboard(graph, { ...layout, cells })
}

/**
 * A stored layout, with anything malformed dropped.
 *
 * The same lenient-but-checked pass `validGroups` and `validMeta` give the rest of a loaded
 * file, and silent for the same reason: the document still means what it said minus decoration,
 * and a warning per stale cell on a graph somebody was sent would bury the warnings that are
 * about their data.
 *
 * A cell naming a node that was dropped as an unknown type goes, as does the second cell for a
 * node named twice, as does one naming a node that cannot be drawn — all three rules are enforced
 * *here* as well as in `addCells`, because a hand-edited file is the other way each of them
 * arrives, and what they cause (two live WebGL contexts, a header over an empty box) reads as a
 * broken cell rather than a bad file.
 */
export function validDashboard(
  raw: unknown,
  /** The surviving nodes by id — their *types* matter here, not only that they exist. */
  alive: ReadonlyMap<string, GraphNode>,
): DashboardLayout | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const { columns, cells, open } = raw as Record<string, unknown>
  if (!Array.isArray(cells)) return undefined
  const tracks = clampColumns(typeof columns === 'number' ? columns : DEFAULT_COLUMNS)
  const seen = new Set<string>()
  const kept: DashboardCell[] = []
  for (const cell of cells) {
    if (!cell || typeof cell !== 'object') continue
    const { nodeId, w, h } = cell as Record<string, unknown>
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
        },
        tracks,
      ),
    )
  }
  if (!kept.length) return undefined
  // `=== true` rather than truthiness, and only then written: a `"open": "yes"` from a
  // hand-edited file must not decide which view somebody's app opens in.
  return { columns: tracks, cells: kept, ...(open === true ? { open: true as const } : {}) }
}
