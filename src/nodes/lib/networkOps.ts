/**
 * Filtering a network down to what is worth drawing.
 *
 * Headless, like the rest of `src/nodes/lib`, and deliberately a *data* operation rather
 * than a view one: the network viewer's filter params change what its `out` port carries, so
 * a downstream node sees the same graph the picture shows. The alternative — filtering only
 * in the viewer — makes the drawing disagree with everything wired after it.
 *
 * Three knobs, applied in a fixed order that matters:
 *
 *   1. drop links below a weight,
 *   2. keep the top N nodes, ranked over the links that survived step 1,
 *   3. drop nodes left with nothing attached.
 *
 * Ranking after the weight cut rather than before is the whole point of the order: "the ten
 * biggest players in the graph I am looking at" is the useful question, and ranking on links
 * that were about to be discarded answers a different one.
 */

import type { TableSchema } from '../../core/types'
import type { ColumnData, NetworkValue, TableValue } from '../../core/values'
import { getColumn, makeTable, selectRows } from '../../core/values'

export interface NetworkFilter {
  /** Drop links weighing less than this. 0 keeps everything. */
  minWeight: number
  /** Keep only this many nodes, by total attached weight. 0 keeps everything. */
  topNodes: number
  /** Drop nodes with no links left. */
  hideIsolated: boolean
}

export interface FilteredNetwork {
  network: NetworkValue
  /** What the filter removed, for the viewer to admit in its caption. */
  dropped: { nodes: number; links: number }
}

export const NO_FILTER: NetworkFilter = { minWeight: 0, topNodes: 0, hideIsolated: false }

/**
 * Roll-ups `BuildNetwork` derives from the link set.
 *
 * They are recomputed after filtering, because they describe the graph rather than the
 * neurons: a node still claiming `degreeOut: 7` in a network where four of those links have
 * been cut is not merely stale, it is driving a size encoding and a tooltip that say
 * something untrue about the picture beside them.
 */
const ROLLUPS = ['degreeIn', 'degreeOut', 'weightIn', 'weightOut'] as const

function hasColumn(schema: TableSchema, name: string): boolean {
  return schema.columns.some((c) => c.name === name)
}

/** Weight column read defensively — a network need not come from `BuildNetwork`. */
function weights(edges: TableValue): number[] {
  const missing = !hasColumn(edges.schema, 'weight')
  const data = missing ? [] : getColumn(edges, 'weight')
  return Array.from({ length: edges.length }, (_, i) => {
    // A network with no weights ranks by plain degree, which is what weighting every link
    // as 1 amounts to. One rule, degrading to the obvious thing.
    const value = Number(data[i] ?? 1)
    return Number.isFinite(value) ? value : 1
  })
}

export function isFiltering(filter: NetworkFilter): boolean {
  return filter.minWeight > 0 || filter.topNodes > 0 || filter.hideIsolated
}

export function filterNetwork(network: NetworkValue, filter: NetworkFilter): FilteredNetwork {
  const none = { network, dropped: { nodes: 0, links: 0 } }
  if (!isFiltering(filter)) return none

  const ids = getColumn(network.nodes, 'id').map((cell) => String(cell ?? ''))
  const sources = getColumn(network.edges, 'source').map((cell) => String(cell ?? ''))
  const targets = getColumn(network.edges, 'target').map((cell) => String(cell ?? ''))
  const weight = weights(network.edges)

  // --- 1. weight cut -------------------------------------------------------
  let links: number[] = []
  for (let i = 0; i < network.edges.length; i++) {
    if (weight[i]! >= filter.minWeight) links.push(i)
  }

  // --- 2. top nodes, ranked over what survived -----------------------------
  const known = new Set(ids)
  let keptNodes = new Set(ids)
  if (filter.topNodes > 0 && filter.topNodes < ids.length) {
    const score = new Map<string, number>()
    for (const i of links) {
      const from = sources[i]!
      const to = targets[i]!
      if (known.has(from)) score.set(from, (score.get(from) ?? 0) + weight[i]!)
      if (known.has(to)) score.set(to, (score.get(to) ?? 0) + weight[i]!)
    }
    // Ties break on id so the result is deterministic — the provenance key depends on it.
    const ranked = [...ids].sort(
      (a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0) || a.localeCompare(b),
    )
    keptNodes = new Set(ranked.slice(0, filter.topNodes))
    links = links.filter((i) => keptNodes.has(sources[i]!) && keptNodes.has(targets[i]!))
  }

  // --- 3. isolated nodes ---------------------------------------------------
  if (filter.hideIsolated) {
    const attached = new Set<string>()
    for (const i of links) {
      attached.add(sources[i]!)
      attached.add(targets[i]!)
    }
    keptNodes = new Set([...keptNodes].filter((id) => attached.has(id)))
  }

  const nodeRows: number[] = []
  ids.forEach((id, row) => {
    if (keptNodes.has(id)) nodeRows.push(row)
  })

  if (nodeRows.length === ids.length && links.length === network.edges.length) return none

  const nodes = recomputeRollups(
    selectRows(network.nodes, nodeRows),
    nodeRows.map((row) => ids[row]!),
    links.map((i) => ({ source: sources[i]!, target: targets[i]!, weight: weight[i]! })),
  )

  return {
    network: {
      ...network,
      nodes,
      edges: selectRows(network.edges, links),
    },
    dropped: {
      nodes: ids.length - nodeRows.length,
      links: network.edges.length - links.length,
    },
  }
}

/** Rewrite the derived degree columns over the surviving links, where the schema has them. */
function recomputeRollups(
  nodes: TableValue,
  order: string[],
  links: Array<{ source: string; target: string; weight: number }>,
): TableValue {
  const present = ROLLUPS.filter((name) => hasColumn(nodes.schema, name))
  if (present.length === 0) return nodes

  const acc = new Map(
    order.map((id) => [id, { degreeIn: 0, degreeOut: 0, weightIn: 0, weightOut: 0 }]),
  )
  for (const link of links) {
    const from = acc.get(link.source)
    const to = acc.get(link.target)
    if (from) {
      from.degreeOut += 1
      from.weightOut += link.weight
    }
    if (to) {
      to.degreeIn += 1
      to.weightIn += link.weight
    }
  }

  const data: Record<string, ColumnData> = { ...nodes.data }
  for (const name of present) {
    data[name] = order.map((id) => acc.get(id)?.[name] ?? 0)
  }
  return makeTable(nodes.schema, data, nodes.kind)
}
