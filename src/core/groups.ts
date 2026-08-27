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

import type { CodaGraph, GraphGroup } from './graph'
import { newId } from './graph'

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
    kept.push(rest.length === group.nodeIds.length ? group : { ...group, nodeIds: rest })
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
      if (!next.color || next.color === 'grey') delete next.color
      return next
    }),
  }
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
    clones.push({ ...group, id: newId('g'), nodeIds: group.nodeIds.map((id) => idMap.get(id)!) })
  }
  return clones
}
