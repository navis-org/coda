/**
 * What the network viewer's context menu selects.
 *
 * Headless, for the reason `networkDrag.ts` is: sigma needs WebGL and jsdom has none, so a
 * command that picks the wrong nodes would go unnoticed by every test in the suite.
 *
 * **The walk is `net.filter`'s, not a second one.** `expandSelection` already knows the two
 * rules that are easy to get wrong and hard to see: a *connected component* that respected
 * arrows would be a reachable set, and an **undirected** network's `source`/`target` are an
 * arbitrary order, so honouring "downstream" on one would walk half of each pair by
 * construction order. A menu with its own BFS would have to rediscover both, and would
 * disagree with the node wired downstream of it about what "the component" means.
 *
 * What is added here is the *ordering*. `expandSelection` answers with a set, and the answer
 * goes into an `ids` param that lives in the saved file and takes part in the provenance key
 * (invariant 4) — so it has to be a deterministic sequence, not whatever order a Set was
 * filled in. Network node order is the one order that is already meaningful.
 */

import type { NetworkValue } from '../../core/values'
import { getColumn } from '../../core/values'
import { expandSelection } from '../../nodes/lib/networkOps'

/** How far past the anchors a menu command reaches. */
export type SelectScope = 'connected' | 'downstream' | 'upstream' | 'component'

/**
 * What a gesture on `node` acts on: the whole selection when the gesture landed *in* it,
 * otherwise that node alone.
 *
 * One function because the rule is asked twice — the context menu here and the drag in
 * `networkDrag.ts` — and the two reading it differently is the kind of inconsistency nobody
 * reports as a bug and everybody feels. It is also the rule `NodeContextMenu` follows on the
 * canvas, so a right-click means the same thing in both places.
 *
 * Note it never *changes* the selection: grabbing or right-clicking an unselected node acts on
 * it without selecting it, which is what keeps the gesture from silently redefining what is
 * selected.
 */
export function seedsFor(node: string, selection: ReadonlySet<string>): string[] {
  return selection.has(node) ? [...selection] : [node]
}

/** Every node of the network, in the order its attribute table has them. */
function allNodeIds(network: NetworkValue): string[] {
  return getColumn(network.nodes, 'id').map((cell) => String(cell ?? ''))
}

/** Narrow a set of ids to the network's own nodes, in the network's own order. */
export function orderByNode(network: NetworkValue, ids: ReadonlySet<string>): string[] {
  return allNodeIds(network).filter((id) => ids.has(id))
}

/**
 * The anchors, grown by one scope.
 *
 * `connected` and the two directed scopes are one hop, so running one of them again on its own
 * result grows the selection by another hop — which is the useful behaviour and the reason
 * there is no `Select within N hops` asking for a number. `component` needs no repeat.
 *
 * The result always contains the anchors, so every one of these replaces the selection with a
 * strictly larger one rather than trading it for a neighbourhood.
 */
export function expandedSelection(
  network: NetworkValue,
  seeds: Iterable<string>,
  scope: SelectScope,
): string[] {
  const kept = expandSelection(network, {
    seeds: new Set(seeds),
    expand: scope === 'component' ? 'component' : 'hops',
    hops: 1,
    direction:
      scope === 'downstream' ? 'downstream' : scope === 'upstream' ? 'upstream' : 'any',
  })
  return orderByNode(network, kept)
}
