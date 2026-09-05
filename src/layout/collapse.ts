/**
 * A collapsed group, as a card and a set of wires: what the canvas draws instead of the members,
 * and what the layout pass arranges instead of them.
 *
 * **One table, two readers.** The canvas needs a box to draw, a set of cards to withhold and a
 * set of wires to redraw; ELK needs a node to place, a size for it and edges that reach it.
 * Written per surface those two would be the same derivation twice, and the half that goes wrong
 * silently is the second: an arrangement made against the members while the canvas draws a box
 * moves cards nobody can see and leaves a hole where they used to be. So `collapsedView` answers
 * both, and `condense` is the four lines that turn its answer into a graph.
 *
 * **Everything here is derived, nothing is stored.** The document holds one boolean per group
 * (`GraphGroup.collapsed`) and the membership it already had. The box's position is the frame's
 * top-left corner, its size is a constant, and which wires cross its boundary is read off the
 * edges each time — for `groupBox`'s reason, which is that six things move a frame's contents
 * and none of them knows the frame exists.
 *
 * ## The pseudo card is a `GraphNode` that is not in the graph
 *
 * `COLLAPSED_TYPE` is not registered, so `getNodeDef` answers undefined for it and every
 * registry-driven path — the inspector, the exporters, `inferOutputs` — simply never sees one,
 * because it is never in `graph.nodes`. What it *is* structurally a `GraphNode` for is the two
 * places that take a list of them and ask only about geometry: `toElkGraph` and `place.ts`.
 * `layoutPorts` in `elkGraph.ts` is the one place that has to know the type by name, and it is
 * a compile error away from being noticed if this constant moves.
 *
 * ## Merged wires
 *
 * Several cards inside one box, each wired to the same socket outside it, are **one** wire on
 * screen. The alternative — keeping every real edge and letting them all terminate at the same
 * coordinate — draws one line and leaves N hit targets stacked under it, any of which deletes a
 * real edge into a card the reader cannot see. So a crossing edge becomes a stand-in keyed by
 * its two visible ends, it carries the real ids it stands for (`merged`) and the real source
 * sockets (`origins`, so a caller can colour it from its own inference), and it is drawn
 * un-interactive.
 */

import type { CodaGraph, GraphEdge, GraphGroup, GraphNode } from '../core/graph'
import { nodesById } from '../core/graph'
import type { ExposedControl } from '../core/groups'
import { exposedControls } from '../core/groups'
import type { LayoutNode, MeasuredSizes, NodeSize } from './elkGraph'
import { FALLBACK_NODE_SIZE, resolveSize } from './elkGraph'
import { GROUP_PADDING } from './groupBounds'
import type { Rect, XY } from './place'
import { union } from './place'

/** The pseudo card's only input, taking every wire that enters the box. */
export const COLLAPSED_IN = 'in'
/** The pseudo card's only output, carrying every wire that leaves it. */
export const COLLAPSED_OUT = 'out'

/**
 * The type on a pseudo card — its React Flow node type *and* the value stamped on the node, one
 * constant rather than two names for one card.
 *
 * Deliberately not a registered node type: no definition answers to it, `isAnnotation` says
 * false, and it never reaches a document because a pseudo card is minted per render and thrown
 * away. Dotless where every real type has a dot (`core.filterTable`), which is also what keeps
 * React Flow's generated `.react-flow__node-groupBox` class a usable selector.
 */
export const COLLAPSED_TYPE = 'groupBox'

/** Prefixes, so a pseudo id can never be mistaken for a document id — `newId` mints `n…`/`g…`. */
const NODE_PREFIX = 'collapsed:'
const EDGE_PREFIX = 'collapsed-edge:'

/**
 * How big a collapsed group draws with nothing promoted onto it, in flow units.
 *
 * `FALLBACK_NODE_SIZE`'s width on purpose — the box is meant to read as *a card*, so it is the
 * width every card is until somebody resizes one. The height is a header plus a mini-map with
 * room to show a shape rather than a smear; it is fixed rather than fitted to the members'
 * aspect, because a row of boxes that are each a different height is a worse canvas than a
 * letterboxed mini-map is a drawing.
 */
export const COLLAPSED_SIZE: NodeSize = { width: FALLBACK_NODE_SIZE.width, height: 124 }

/**
 * What a box carrying promoted controls grows to, and the three numbers that decide it.
 *
 * Wider, because a promoted row is labelled `Find Neurons · Limit` — the card's name and the
 * param's — and at 232 that ellipsises to nothing useful.
 *
 * **The stylesheet is handed these rather than told to agree with them.** The card writes them
 * onto its own element as `--collapsed-header`, `--collapsed-row` and `--collapsed-rows-pad`,
 * which is `AddMenu`'s arrangement: the arithmetic has to live here, because the size is what
 * the canvas and ELK are both told, and only CSS can draw it — so the few numbers both languages
 * need go *that* way rather than being written twice with a comment between them.
 */
/**
 * The box's corner, in px — the frame's, not a card's.
 *
 * A folded frame is drawn as the frame it folded, so its radius is `GroupLayer`'s outline radius
 * rather than `--radius`. One constant because four things have to agree on it: the outline's
 * three `rx`es, the box's `border-radius`, and the running ring drawn concentric with it.
 */
export const COLLAPSED_RADIUS = 14

export const COLLAPSED_WIDE = 288
export const COLLAPSED_HEADER_HEIGHT = 26
export const COLLAPSED_ROW_HEIGHT = 26
export const COLLAPSED_ROWS_PADDING = 8

export function collapsedNodeId(groupId: string): string {
  return `${NODE_PREFIX}${groupId}`
}

/**
 * A merged wire's id, minted from the two ends it is drawn between.
 *
 * Derived rather than random because React Flow keys on it: a fresh id per render remounts every
 * merged edge. Named here beside the node's minter so the two conventions live together and
 * nothing downstream is tempted to assemble one — nothing parses either back.
 */
function collapsedEdgeId(from: PortEnd, to: PortEnd): string {
  return `${EDGE_PREFIX}${from.node}#${from.handle}>${to.node}#${to.handle}`
}

/** One end of a wire after folding: a real socket, or a box's single one. */
interface PortEnd {
  node: string
  handle: string
}

/** One member, as the mini-map needs it: a rectangle and enough to tint it. */
export interface CollapsedMember extends Rect {
  id: string
  type: string
}

export type { ExposedControl }

/** A pseudo card standing in for one collapsed group. Structurally a `GraphNode`; never in one. */
export interface CollapsedBox extends LayoutNode {
  type: typeof COLLAPSED_TYPE
  size: NodeSize
  /**
   * The two sockets, declared on the node itself.
   *
   * `toElkGraph` asks a node for its ports and falls back to the registry, exactly as
   * `resolveSize` asks a node for its size and falls back to `defaultSize` — so the layout
   * adapter needs to know nothing about this feature, and the two modules do not have to import
   * each other. An ELK edge naming a port its node does not declare is a *rejected graph*, not a
   * degraded layout, which is why the box carries them rather than leaving them to be inferred.
   */
  ports: { inputs: ReadonlyArray<{ id: string }>; outputs: ReadonlyArray<{ id: string }> }
  group: GraphGroup
  /** In document order, in absolute flow units — the mini-map's whole input. */
  members: CollapsedMember[]
  /**
   * The promoted controls, in the order the group lists them, resolved and filtered to the ones
   * that can actually be drawn right now.
   *
   * `visibleIf` is asked *here* rather than in `validGroups`, and that split is the point: a
   * param the node's current values have switched off is not a param it has *at the moment*, and
   * a file is not where that question can be answered. The same call decides the box's height,
   * so the card cannot draw a row the size did not account for.
   */
  exposed: ExposedControl[]
}

/** A stand-in for one or more real wires crossing a collapsed boundary. */
export interface CollapsedEdge extends GraphEdge {
  /**
   * The real source sockets this one stands for, so a caller can colour it from its own
   * inference — and, being one entry per merged wire, how many it stands for.
   */
  origins: Array<{ nodeId: string; portId: string }>
}

/**
 * Three fields, because the other two were spellings of the first.
 *
 * A wire is withheld exactly when either of its ends is `hidden`, and which box a member belongs
 * to is `boxes` read the other way round — carrying either as a field of its own is a second
 * answer to a question that already has one, kept in step by hand.
 */
export interface CollapsedView {
  /** Members of collapsed groups: cards that are not drawn and not measured. */
  hidden: ReadonlySet<string>
  /** One pseudo card per collapsed group that still has a member on the canvas. */
  boxes: CollapsedBox[]
  /** The stand-ins drawn instead of the wires crossing a boundary, merged by their visible ends. */
  edges: CollapsedEdge[]
}

/** Whether this wire has an end inside a folded group, and so is not drawn as itself. */
export function isFolded(view: CollapsedView, edge: GraphEdge): boolean {
  return view.hidden.has(edge.source) || view.hidden.has(edge.target)
}

/**
 * The answer for a graph with nothing collapsed, shared.
 *
 * Identity-stable because it lands in React memo dependencies and in `rfNodes`: a fresh empty
 * view per render would rebuild every card on every store change for a feature nobody is using.
 */
export const NO_COLLAPSE: CollapsedView = { hidden: new Set(), boxes: [], edges: [] }

/**
 * What to draw instead of the collapsed groups' members.
 *
 * `positions` overrides the document's, for the one caller that has a better answer: while an
 * arrange animation is gliding, the cards are drawn from the animation rather than from the
 * store, and a box read off the document would sit still and then jump at the end.
 */
export function collapsedView(
  graph: CodaGraph,
  measured?: MeasuredSizes,
  positions?: ReadonlyMap<string, XY>,
): CollapsedView {
  // Before any allocation: this runs from a memo on every graph change, and on almost every
  // graph the answer is the shared empty one.
  if (!graph.groups?.some((g) => g.collapsed)) return NO_COLLAPSE

  const nodes = nodesById(graph)
  const hidden = new Set<string>()
  const ownerOf = new Map<string, string>()
  const boxes: CollapsedBox[] = []

  for (const group of graph.groups) {
    if (!group.collapsed) continue
    const members: CollapsedMember[] = []
    for (const id of group.nodeIds) {
      const node = nodes.get(id)
      if (!node) continue
      const at = positions?.get(id) ?? node.position
      members.push({ id, type: node.type, x: at.x, y: at.y, ...resolveSize(node, measured) })
    }
    // A frame naming nothing that is on the canvas draws no box, for the reason `groupBox`
    // returns undefined rather than a zero-sized rectangle at the flow origin.
    const bounds = union(members)
    if (!bounds) continue

    const boxId = collapsedNodeId(group.id)
    for (const member of members) {
      hidden.add(member.id)
      ownerOf.set(member.id, boxId)
    }
    const exposed = exposedControls(group, nodes)
    boxes.push({
      id: boxId,
      type: COLLAPSED_TYPE,
      // The frame's own top-left corner — `union` plus `GROUP_PADDING` is what `groupBox` does,
      // so the box folds into the corner the outline was already drawn at.
      position: { x: bounds.x - GROUP_PADDING, y: bounds.y - GROUP_PADDING },
      params: {},
      size: boxSize(exposed.length),
      ports: { inputs: [{ id: COLLAPSED_IN }], outputs: [{ id: COLLAPSED_OUT }] },
      group,
      members,
      exposed,
    })
  }

  if (boxes.length === 0) return NO_COLLAPSE

  const merged = new Map<string, CollapsedEdge>()
  for (const edge of graph.edges) {
    const fromBox = ownerOf.get(edge.source)
    const toBox = ownerOf.get(edge.target)
    // Both ends in the same box: an internal wire, drawn by nothing. Between two *different*
    // boxes it is still a wire, and one somebody needs to see.
    if (!fromBox && !toBox) continue
    if (fromBox && fromBox === toBox) continue

    const from = {
      node: fromBox ?? edge.source,
      handle: fromBox ? COLLAPSED_OUT : edge.sourceHandle,
    }
    const to = { node: toBox ?? edge.target, handle: toBox ? COLLAPSED_IN : edge.targetHandle }
    const id = collapsedEdgeId(from, to)
    const origin = { nodeId: edge.source, portId: edge.sourceHandle }

    const existing = merged.get(id)
    if (existing) {
      existing.origins.push(origin)
      continue
    }
    merged.set(id, {
      id,
      source: from.node,
      sourceHandle: from.handle,
      target: to.node,
      targetHandle: to.handle,
      origins: [origin],
    })
  }

  return { hidden, boxes, edges: [...merged.values()] }
}

/**
 * How many cards are folded away, without deriving anything else.
 *
 * `collapsedView(graph).hidden.size` is the same number and the wrong way to ask for it on the
 * path that wants it: auto-layout checks it on every commit, which during a drag is every
 * pointer-move frame, and the full view also walks the edges and mints a merged wire per
 * crossing — all discarded. Same rule, stated once here and read by the loop above.
 */
export function foldedNodeCount(graph: CodaGraph): number {
  if (!graph.groups?.some((g) => g.collapsed)) return 0
  const alive = new Set(graph.nodes.map((n) => n.id))
  let count = 0
  for (const group of graph.groups) {
    if (!group.collapsed) continue
    for (const id of group.nodeIds) if (alive.has(id)) count += 1
  }
  return count
}

/** The box's size for a given number of promoted rows. See `COLLAPSED_WIDE`. */
export function boxSize(rows: number): NodeSize {
  if (rows === 0) return COLLAPSED_SIZE
  return {
    width: COLLAPSED_WIDE,
    height: COLLAPSED_SIZE.height + COLLAPSED_ROWS_PADDING + rows * COLLAPSED_ROW_HEIGHT,
  }
}

/**
 * A set of nodes and edges with every collapsed group folded into its pseudo card.
 *
 * Takes a scope rather than the whole graph, because an arrange over a selection is scoped
 * before it is condensed: a box joins the pass when any of its members was in scope, and a
 * stand-in wire joins it when both of its ends did.
 */
export function condense(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  view: CollapsedView,
): { nodes: LayoutNode[]; edges: GraphEdge[] } {
  if (view.boxes.length === 0) return { nodes: [...nodes], edges: [...edges] }

  const boxOf = new Map<string, CollapsedBox>()
  for (const box of view.boxes) for (const member of box.members) boxOf.set(member.id, box)

  const kept: LayoutNode[] = []
  const included = new Set<string>()
  for (const node of nodes) {
    const box = boxOf.get(node.id)
    if (!box) {
      kept.push(node)
      included.add(node.id)
      continue
    }
    if (included.has(box.id)) continue
    kept.push(box)
    included.add(box.id)
  }

  const keptEdges: GraphEdge[] = edges.filter((e) => !isFolded(view, e))
  for (const edge of view.edges) {
    if (included.has(edge.source) && included.has(edge.target)) keptEdges.push(edge)
  }
  return { nodes: kept, edges: keptEdges }
}

/**
 * Positions for the real cards, from an arrangement made over pseudo ones.
 *
 * A box's move is its members' move: the whole set shifts by the delta the layout gave the box,
 * which is what keeps the arrangement inside a collapsed group exactly as its author left it. An
 * expanded group's members would each have been placed individually — folding a group is
 * therefore also a way of telling auto-layout to leave part of a graph alone, which is a
 * property worth knowing about rather than a side effect to design away.
 */
export function expandPositions(
  positions: ReadonlyMap<string, XY>,
  view: CollapsedView,
): Map<string, XY> {
  const out = new Map<string, XY>()
  const boxById = new Map(view.boxes.map((b) => [b.id, b]))
  for (const [id, at] of positions) {
    const box = boxById.get(id)
    if (!box) {
      out.set(id, at)
      continue
    }
    const dx = at.x - box.position.x
    const dy = at.y - box.position.y
    for (const member of box.members) out.set(member.id, { x: member.x + dx, y: member.y + dy })
  }
  return out
}
