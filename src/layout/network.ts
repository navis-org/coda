/**
 * ELK layered over a NetworkValue — the arrangement a *connectome* wants, not a workspace.
 *
 * Separate from `elkGraph.ts` because almost nothing carries over. That module maps editor
 * cards: measured sizes, one ELK port per socket, a fixed port order so wires arrive into the
 * right handle. A network node is a disc of a few pixels drawn by sigma from its centre, has
 * no sockets at all, and its "size" is whatever the size encoding says at render time. What
 * the two share is the engine, which is why `runElk` is exported rather than this file
 * rebuilding one.
 *
 * Headless, like the rest of `src/layout`: no React, no store, no DOM. That is what lets a
 * node's `evaluate` call it.
 */

import type { ElkNode } from 'elkjs/lib/elk-api'

import type { NetworkValue } from '../core/values'
import { getColumn } from '../core/values'
import { runElk } from './engine'

/**
 * The box ELK reserves per node, in layout units.
 *
 * Not a real measurement — nothing here knows what size encoding the viewer will apply, and
 * sigma rescales the whole field to the canvas anyway, so only the *ratio* of box to spacing
 * survives. It is wide and short because the thing that actually collides on screen is the
 * label, which sigma draws to the right of the disc.
 */
export const NETWORK_NODE_SIZE = { width: 120, height: 36 } as const

/** Gap within a layer, and between one layer and the next. */
export const NETWORK_SPACING = { node: 28, layer: 140 } as const

export interface NetworkLayoutOptions {
  /** Flow direction. Feed-forward circuits are read left to right. */
  direction?: 'RIGHT' | 'DOWN'
}

/**
 * Positions for every node of a network, keyed by node id.
 *
 * Returned as **centres**, not ELK's top-left origins: sigma places a node at its centre, and
 * handing it corners shifts the whole picture by half a box — invisible on a dense graph and
 * obvious as a systematic offset between the nodes and the arrowheads on a sparse one.
 *
 * Deliberately no layer constraints pinning sources to the first layer and targets to the
 * last. ELK's own layering already does that for a feed-forward path graph — every kept edge
 * runs source-wards to target-wards — and `FIRST` on a node that turns out to have an
 * incoming edge is an ELK error rather than a hint, which a network assembled from real data
 * can trigger with one recurrent connection.
 */
export async function layoutNetwork(
  network: NetworkValue,
  options: NetworkLayoutOptions = {},
): Promise<Record<string, { x: number; y: number }>> {
  const ids = getColumn(network.nodes, 'id').map((cell) => String(cell ?? ''))
  if (ids.length === 0) return {}

  const known = new Set(ids)
  const sources = getColumn(network.edges, 'source')
  const targets = getColumn(network.edges, 'target')

  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': options.direction ?? 'RIGHT',
      'elk.spacing.nodeNode': String(NETWORK_SPACING.node),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(NETWORK_SPACING.layer),
      // Disconnected pieces packed rather than spread through one shared field: a path graph
      // is usually one component, and when it is not the extras are strays worth seeing apart.
      'elk.separateConnectedComponents': 'true',
      'elk.spacing.componentComponent': String(NETWORK_SPACING.layer),
      // Straightens the long runs, which is what makes a pathway readable as a pathway.
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    },
    children: ids.map((id) => ({ id, ...NETWORK_NODE_SIZE })),
    edges: [],
  }

  // Node-to-node edges: a network node has no sockets, so there is nothing to fix an order
  // against and ELK's port coordinates would be discarded regardless.
  const edges: NonNullable<ElkNode['edges']> = []
  for (let i = 0; i < network.edges.length; i++) {
    const from = String(sources[i] ?? '')
    const to = String(targets[i] ?? '')
    // A dangling endpoint makes ELK reject the whole graph, so it is dropped rather than
    // taking the layout down with it — the same rule `readTopology` applies in the viewer.
    if (!known.has(from) || !known.has(to) || from === to) continue
    edges.push({ id: `e${i}`, sources: [from], targets: [to] })
  }
  graph.edges = edges

  const laid = await runElk(graph)
  const positions: Record<string, { x: number; y: number }> = {}
  for (const child of laid.children ?? []) {
    positions[child.id] = {
      x: (child.x ?? 0) + (child.width ?? NETWORK_NODE_SIZE.width) / 2,
      y: (child.y ?? 0) + (child.height ?? NETWORK_NODE_SIZE.height) / 2,
    }
  }
  return positions
}
