/**
 * The two colour modes only a network can answer.
 *
 * `resolveColor` maps one table's column onto the palette, which is every encoding in this app
 * except these two. A **component** is not in the table at all — it is derived from the link
 * set — and a link coloured **by its upstream node** does not resolve against the edge table
 * either: its answer is the *node* encoding's answer for a different table's row. Neither can
 * be a column, so neither can be a column picker; both are modes, in the way `hash` is.
 *
 * Headless and beside the viewer rather than inside it, for the reason `networkStyle.ts` is:
 * sigma needs WebGL, jsdom has none, and a colour that comes out wrong here is wrong in a way
 * only a person looking at the picture would notice.
 *
 * Everything else is delegated. `resolveColor` still does the palette, the eight slots, the
 * achromatic `Other`, the null grey, the overrides and the legend — this module's whole job is
 * to hand it something it can already answer.
 */

import { column, tableSchema } from '../../core/types'
import type { NetworkValue } from '../../core/values'
import { getColumn, makeTable } from '../../core/values'
import { connectedComponents } from '../../nodes/lib/networkOps'
import type { ColorSpec } from '../../nodes/lib/encodingParams'
import { CHART_INK } from '../colors'
import type { Mode } from '../colors'
import type { ResolvedColor } from '../encoding'
import { resolveColor } from '../encoding'

/**
 * The derived column's name, which is also the legend group's title.
 *
 * Node keys are otherwise unnamed in the network legend — nodes being the default subject of a
 * node-link drawing — but a strip reading `1 2 3 4` with nothing saying what the numbers are is
 * the one case where that economy costs more than it saves.
 */
export const COMPONENT_CHANNEL = 'component'

const COMPONENT_SCHEMA = tableSchema(column(COMPONENT_CHANNEL, 'str'))

/** Does this spec name the node channel a link is borrowing its colour from? */
export function isEndpointMode(spec: ColorSpec): boolean {
  return spec.mode === 'sourceNode' || spec.mode === 'targetNode'
}

/**
 * Node colours, with `component` folded into the categorical machinery.
 *
 * The component numbers are turned into a one-column table and handed to `resolveColor` as an
 * ordinary categorical encoding. That is the whole trick, and it is what makes the mode inherit
 * every rule the palette already enforces — including the ranking, which puts the largest
 * component in the leading slot because `connectedComponents` numbers by size and `resolveColor`
 * ranks by frequency. Two orderings that agree by construction rather than by coincidence.
 */
export function resolveNetworkNodeColor(
  network: NetworkValue,
  spec: ColorSpec,
  mode: Mode,
): ResolvedColor {
  if (spec.mode !== 'component') return resolveColor(network.nodes, spec, mode)
  const labels = connectedComponents(network).map(String)
  const table = makeTable(COMPONENT_SCHEMA, { [COMPONENT_CHANNEL]: labels })
  return resolveColor(table, { ...spec, mode: 'categorical', column: COMPONENT_CHANNEL }, mode)
}

/**
 * Link colours, with the two endpoint modes reading through the node encoding.
 *
 * `nodeColors` is the *resolved* node channel rather than its spec, which is what keeps the two
 * halves from having to agree twice: whatever a node ended up painted — palette slot, folded
 * `Other`, hand-picked override — is what a link borrows, by construction.
 *
 * **No legend.** The node key already names every colour on screen, and a second strip
 * repeating those swatches under the word "links" says nothing the first did not. `labelAt`
 * *is* carried through, so a link is still addressable by the key its endpoint belongs to.
 *
 * A link whose endpoint the node table does not have falls back to muted ink — the colour links
 * have always been drawn in. It should not happen on a network from `BuildNetwork`, and it is
 * not worth a blank link if it does.
 */
export function resolveNetworkEdgeColor(
  network: NetworkValue,
  spec: ColorSpec,
  mode: Mode,
  nodeColors: ResolvedColor,
): ResolvedColor {
  if (!isEndpointMode(spec)) return resolveColor(network.edges, spec, mode)

  const rowOf = new Map<string, number>()
  getColumn(network.nodes, 'id').forEach((cell, row) => {
    const id = String(cell ?? '')
    if (!rowOf.has(id)) rowOf.set(id, row)
  })
  const ends = getColumn(network.edges, spec.mode === 'sourceNode' ? 'source' : 'target')
  const nodeRow = (edgeRow: number): number | undefined =>
    rowOf.get(String(ends[edgeRow] ?? ''))

  return {
    at: (edgeRow) => {
      const row = nodeRow(edgeRow)
      return row === undefined ? CHART_INK[mode].muted : nodeColors.at(row)
    },
    legend: undefined,
    labelAt: (edgeRow) => {
      const row = nodeRow(edgeRow)
      return row === undefined ? undefined : nodeColors.labelAt?.(row)
    },
  }
}
