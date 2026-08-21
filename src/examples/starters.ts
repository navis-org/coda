/**
 * Starter graphs — what "New ▸ hemibrain" builds.
 *
 * An empty canvas is a poor first screen: it asks the newcomer to know both which nodes exist
 * and which dataset they want, before they have seen a single neuron. A starter answers the
 * second question from the menu and the first by example, and lands you somewhere you can
 * immediately look around.
 *
 * The smallest arrangement that teaches the shape of the tool:
 *
 *   Dataset ─┬─▸ Explore ──(Selected)─┬─▸ Table
 *            └────────────────────────┴─▸ Neuroglancer
 *
 * Two viewers off one selection, because that is the answer to "what did I just tick?" in both
 * the forms people want it: the numbers, and the neurons. The Neuroglancer node appears only
 * where the source publishes a scene — the mock generates its geometry in the browser and has
 * no bucket for an external viewer to read, so on a mock starter it would open as a node that
 * can only ever warn.
 *
 * A published dataset also opens with the Description card its dataset node comes with anywhere
 * else — see `core/companion.ts`. It is built here through the same helper rather than placed by
 * hand, so a starter cannot end up being the one surface where the credit is missing.
 *
 * The Table is wired to `Selected` rather than `Hits` on purpose. `Hits` with an empty search is
 * the entire dataset — 165,122 rows for male-CNS — and a starter graph whose first Run pushes
 * that into a table viewer would teach the wrong lesson about what to connect. `Selected` starts
 * empty, fills as you tick rows, and shows the browse-then-act flow the widget exists for.
 *
 * Built programmatically from each node's own defaults, exactly like the examples, so a starter
 * cannot drift out of sync with a node's param set.
 */

import type { CodaGraph, GraphNode } from '../core/graph'
import { addNodeWithCompanion } from '../core/companion'
import { addEdge, emptyGraph } from '../core/graph'
import type { ParamValues } from '../core/node'
import { defaultParams } from '../core/node'
import { requireNodeDef } from '../core/registry'
import { capabilityOf, getSource } from '../data/source'

export interface StarterSpec {
  /** Dataset node type to open with, e.g. `dataset.malecns`. */
  nodeType: string
  /** Display label, used for the graph's name. */
  label: string
  /** Which registered source it belongs to, so the starter can ask what that source can do. */
  sourceId?: string
  /** Params for the dataset node — a pinned version, or a custom server and dataset. */
  params?: Record<string, unknown>
}

/** Explore is 520px wide, so columns are spaced for it rather than for a default node. */
const COLUMNS = [60, 340, 940]

function place(
  id: string,
  type: string,
  column: number,
  options: { params?: Record<string, unknown>; y?: number } = {},
): GraphNode {
  const def = requireNodeDef(type)
  return {
    id,
    type,
    position: { x: COLUMNS[column] ?? 60, y: options.y ?? 90 },
    params: { ...defaultParams(def), ...options.params } as ParamValues,
  }
}

export function buildStarter(spec: StarterSpec): CodaGraph {
  const name = spec.label
  let graph = emptyGraph(name)
  graph = {
    ...graph,
    meta: {
      ...graph.meta,
      name,
      description: `Browsing ${spec.label}. Search in the Explore node, tick neurons, then Run.`,
    },
  }

  /*
   * No dataset id: a starter is a node type and some params, and which dataset that resolves to
   * is not known until the node runs. So this gets the source-level answer, which is the honest
   * one here — through `capabilityOf` rather than `capabilities.viewerScene` so it picks up a
   * per-dataset override the day a starter can name its dataset.
   */
  const withScene = spec.sourceId
    ? capabilityOf(getSource(spec.sourceId), undefined, 'viewerScene')
    : false

  for (const node of [
    place('dataset', spec.nodeType, 0, { ...(spec.params ? { params: spec.params } : {}) }),
    place('explore', 'neuron.explore', 1),
    place('picked', 'out.table', 2),
    ...(withScene ? [place('ngl', 'out.neuroglancer', 2, { y: 430 })] : []),
  ]) {
    // Through the companion helper, so the dataset node opens with its Description card here
    // exactly as it does when someone adds one by hand. A starter is the first graph most
    // people see, which makes it the least defensible place to leave the credit out.
    graph = addNodeWithCompanion(graph, node)
  }

  graph = addEdge(graph, {
    source: 'dataset',
    sourceHandle: 'dataset',
    target: 'explore',
    targetHandle: 'dataset',
  })
  graph = addEdge(graph, {
    source: 'explore',
    sourceHandle: 'selected',
    target: 'picked',
    targetHandle: 'in',
  })
  if (withScene) {
    graph = addEdge(graph, {
      source: 'dataset',
      sourceHandle: 'dataset',
      target: 'ngl',
      targetHandle: 'dataset',
    })
    graph = addEdge(graph, {
      source: 'explore',
      sourceHandle: 'selected',
      target: 'ngl',
      targetHandle: 'neurons',
    })
  }
  return graph
}
