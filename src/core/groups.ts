/**
 * Group frames: the edits, headless.
 *
 * The *shape* lives in `graph.ts` beside the rest of the document (`GraphGroup`, `GROUP_COLORS`,
 * `pruneGroups`), because that is what a `.coda.json` is. What lives here is everything that
 * *changes* one, so the store adds a commit and nothing else — the same split `splice.ts` and
 * `companion.ts` already follow.
 *
 * Two rules run through all of it, and both come from the same decision — **a node belongs to at
 * most one group, and groups do not nest**:
 *
 *  - `createGroup` moves a node out of its old frame rather than refusing to take it. A refusal
 *    would have to be explained on a menu row, and "regroup these four" is what somebody
 *    selecting four cards and pressing ⌘G means whatever they did last time.
 *  - A frame emptied by that move is dropped on the spot. A frame with one member is legitimate
 *    — a labelled box around a single card — so the floor is one, not two.
 *
 * Geometry is deliberately absent: the box a frame draws is derived from the cards inside it,
 * and that computation needs their measured sizes, which only the canvas has. See
 * `layout/groupBounds.ts`.
 */

import type { CodaGraph, GraphGroup, GraphNode } from './graph'
import { newId, withMembers } from './graph'
import type { NodeDefinition, ParamDef } from './node'
import { configurableParams, findParam } from './node'
import { getNodeDef } from './registry'

/**
 * The frame with this id, or undefined.
 *
 * A one-liner with six callers across the store, the canvas, the menu and the peek — the point
 * is that `groups?` optionality is answered in one place. `groupOf` below is its by-member twin.
 */
export function groupById(graph: CodaGraph, groupId: string): GraphGroup | undefined {
  return graph.groups?.find((g) => g.id === groupId)
}

/** The group a node is in, or undefined. At most one, by construction. */
export function groupOf(graph: CodaGraph, nodeId: string): GraphGroup | undefined {
  return graph.groups?.find((g) => g.nodeIds.includes(nodeId))
}

/**
 * Every group any of these nodes belongs to.
 *
 * What "Ungroup" acts on: a selection spanning two frames means both, and a selection of one
 * card in a frame of six means that frame — the alternative reading, "take this card out of its
 * group", is a different operation and is not what the word says.
 */
export function groupsTouching(graph: CodaGraph, nodeIds: readonly string[]): GraphGroup[] {
  if (!graph.groups?.length) return []
  const ids = new Set(nodeIds)
  return graph.groups.filter((g) => g.nodeIds.some((id) => ids.has(id)))
}

/**
 * Frame these nodes, taking them out of whatever frames they were in.
 *
 * Returns the graph unchanged when there is nothing to frame, so the store's `commit` — which
 * compares by identity — leaves no undo step behind for a ⌘G with an empty selection.
 *
 * Membership is stored in the graph's own node order rather than in selection order, so two
 * people who selected the same four cards in a different sequence get the same document.
 */
export function createGroup(
  graph: CodaGraph,
  nodeIds: readonly string[],
  init: Omit<Partial<GraphGroup>, 'id' | 'nodeIds'> = {},
): CodaGraph {
  const wanted = new Set(nodeIds)
  const members = graph.nodes.filter((n) => wanted.has(n.id)).map((n) => n.id)
  if (members.length === 0) return graph

  const taken = new Set(members)
  const kept: GraphGroup[] = []
  for (const group of graph.groups ?? []) {
    const rest = group.nodeIds.filter((id) => !taken.has(id))
    if (rest.length === 0) continue
    if (rest.length === group.nodeIds.length) {
      kept.push(group)
      continue
    }
    // A card that leaves takes its promoted controls with it — `withMembers` is the one place
    // that narrows a frame's membership and its `exposed` list together.
    kept.push(withMembers(group, rest))
  }

  return {
    ...graph,
    groups: [...kept, { id: newId('g'), nodeIds: members, ...init }],
  }
}

/** Remove these frames. The cards stay exactly where they are — a frame owns nothing. */
export function removeGroups(graph: CodaGraph, groupIds: readonly string[]): CodaGraph {
  if (!graph.groups?.length) return graph
  const dead = new Set(groupIds)
  const groups = graph.groups.filter((g) => !dead.has(g.id))
  if (groups.length === graph.groups.length) return graph
  const next = { ...graph }
  if (groups.length) next.groups = groups
  else delete next.groups
  return next
}

/**
 * Retitle or restyle one frame.
 *
 * An empty title clears the key rather than storing `''`, for the reason `renameNode` does the
 * same: a title nobody typed is an absence, and an empty string is a label that draws a chip
 * with nothing in it.
 */
export function updateGroup(
  graph: CodaGraph,
  groupId: string,
  patch: Omit<Partial<GraphGroup>, 'id' | 'nodeIds'>,
): CodaGraph {
  if (!graph.groups?.some((g) => g.id === groupId)) return graph
  return {
    ...graph,
    groups: graph.groups.map((g) => {
      if (g.id !== groupId) return g
      const next: GraphGroup = { ...g, ...patch }
      if (!next.title) delete next.title
      if (!next.filled) delete next.filled
      if (!next.dashed) delete next.dashed
      if (!next.collapsed) delete next.collapsed
      if (!next.exposed?.length) delete next.exposed
      if (!next.color || next.color === 'grey') delete next.color
      return next
    }),
  }
}

/**
 * Put one member's param on the frame's folded box, or take it off again.
 *
 * Appends rather than inserting in document order, unlike `createGroup`'s membership: the list
 * is a small panel somebody arranges, so the order they picked them in is the order they meant.
 *
 * Refuses a node that is not in this group — a frame may only promote its own cards, which is
 * what makes "which box owns this control" answerable — and refuses a param the node's type does
 * not declare. Both by returning the graph unchanged, so the store's identity check leaves no
 * undo step behind.
 */
export function toggleExposedParam(
  graph: CodaGraph,
  groupId: string,
  nodeId: string,
  paramId: string,
): CodaGraph {
  const group = groupById(graph, groupId)
  if (!group || !group.nodeIds.includes(nodeId)) return graph
  const node = graph.nodes.find((n) => n.id === nodeId)
  const def = node ? getNodeDef(node.type) : undefined
  if (!def || !findParam(def, paramId)) return graph

  const current = group.exposed ?? []
  const without = current.filter((e) => !(e.node === nodeId && e.param === paramId))
  const exposed =
    without.length === current.length ? [...current, { node: nodeId, param: paramId }] : without
  return updateGroup(graph, groupId, { exposed })
}

/** One promoted param, resolved: the card it belongs to, its definition and the param itself. */
export interface ExposedControl {
  node: GraphNode
  /** Resolved here so the surface drawing the row cannot fail to find one. */
  def: NodeDefinition
  param: ParamDef
}

/**
 * The promoted params of one frame, resolved against the graph and filtered to the drawable.
 *
 * The **third** of the checks that keep `exposed` describing something real, and the one that
 * cannot be settled anywhere else: `validExposed` refuses a non-member or an undeclared param
 * when a file is read, `withMembers` drops a card that leaves, and `visibleIf` is a function of
 * the node's *current* values, so it answers differently a keystroke later. All three live in
 * `core` now; only the count's *use* is the layout's, since it decides the box's size.
 *
 * `configurableParams` runs every `visibleIf` a node has, so it is asked once per *card* rather
 * than once per promoted param — two controls off one card is the ordinary case.
 */
export function exposedControls(
  group: GraphGroup,
  nodes: ReadonlyMap<string, GraphNode>,
): ExposedControl[] {
  if (!group.exposed?.length) return []
  const controls: ExposedControl[] = []
  const offered = new Map<
    string,
    { node: GraphNode; def: NodeDefinition; params: ParamDef[] }
  >()
  for (const { node: nodeId, param: paramId } of group.exposed) {
    let entry = offered.get(nodeId)
    if (!entry) {
      const node = nodes.get(nodeId)
      const def = node ? getNodeDef(node.type) : undefined
      if (!node || !def) continue
      entry = { node, def, params: configurableParams(def, node.params) }
      offered.set(nodeId, entry)
    }
    const param = entry.params.find((p) => p.id === paramId)
    if (param) controls.push({ node: entry.node, def: entry.def, param })
  }
  return controls
}

/** Whether this frame already promotes that param. */
export function isExposed(group: GraphGroup, nodeId: string, paramId: string): boolean {
  return (group.exposed ?? []).some((e) => e.node === nodeId && e.param === paramId)
}

/**
 * Clone the frames whose members are *entirely* inside a duplicated set, remapped to the clones.
 *
 * Entirely, and the partial case is deliberately dropped rather than half-copied: a frame around
 * three of six cards is a claim about a set nobody selected. Same rule the edge copy in
 * `duplicateSelection` already follows — an edge is copied only when both of its ends were
 * duplicated.
 */
export function cloneGroups(
  graph: CodaGraph,
  idMap: ReadonlyMap<string, string>,
): GraphGroup[] {
  if (!graph.groups?.length) return []
  const clones: GraphGroup[] = []
  for (const group of graph.groups) {
    if (!group.nodeIds.every((id) => idMap.has(id))) continue
    const clone: GraphGroup = {
      ...group,
      id: newId('g'),
      nodeIds: group.nodeIds.map((id) => idMap.get(id)!),
    }
    // The promoted params are node ids too, and a clone that kept the originals' would draw a
    // copy's controls onto the original's cards — an edit in one box landing in the other.
    // Every member is in the map by the test above, so no entry can fail to remap.
    if (group.exposed?.length) {
      clone.exposed = group.exposed.map((e) => ({ node: idMap.get(e.node)!, param: e.param }))
    }
    clones.push(clone)
  }
  return clones
}
