/**
 * Cortical Depth: where each point of a cloud sits in the cortex — depth below the pia, the
 * layer, the lateral position — and, for a synapse cloud, the cell type at each end.
 *
 * The gallery's `soma_depth` made into a node of its own, because **once "which layer" is a
 * column, the rest of the canvas can answer laminar questions**: Group By counts per layer, Filter
 * Table keeps one layer's synapses, Laminar Profile draws the input profile against the layers. No
 * CAVE table stores a layer per anything; it is computed from a position through the dataset's
 * cortical frame (`frames.ts`), which is why this takes the Dataset as well as the points.
 *
 * **Two outputs, the cloud and its table.** A point cloud reaches the 3D View and nothing else —
 * every chart takes a table — so the table is the attributes as their own value, the same rows.
 *
 * **`expensive` because of the typing, not the arithmetic.** Placing half a million points is tens
 * of milliseconds; reading a typing table is a request on first use, and a `cheap` node runs on
 * being wired. Upstream is a Synapses fetch, which needs a Run anyway.
 */

import type { ParamValues } from '../../core/node'
import { packNode } from '../../core/registry'
import { T, datasetRef } from '../../core/types'
import { ID_COLUMN_NAME } from '../../core/ids'
import { isPointsValue } from '../../core/values'
import { TYPE_COLUMN_NAME } from '../../data/annotations/types'
import { displayLabels } from '../../nodes/lib/displayLabels'
import { requireDataset } from '../../nodes/lib/datasetParam'
import { checkGeometryUnits } from '../../nodes/lib/transformOps'
import {
  NO_CELL_TYPES,
  cellTypeAnnotations,
  cellTypeRefs,
  cellTypeSourceParam,
} from './cellTypes'
import { frameIssue, frameOf } from './frames'
import { pointDepthSchema, pointDepthValue } from './pointDepth'

/** Whether a typing is read at all — `None` reads none, and the columns are then not minted. */
const typed = (params: ParamValues) => params.cellTypes !== NO_CELL_TYPES

export const depthNode = packNode({
  type: 'cortex:depth',
  label: 'Cortical Depth',
  category: 'transform',
  description:
    'Adds each point’s depth below the pia, its layer and its lateral position, and the cell type at each end of a synapse.',
  guide:
    'Places a point cloud in the cortex through the dataset’s cortical frame: each point gets its depth below the pia in µm, its layer and its lateral position. On a synapse cloud it adds the cell type of the neuron and of its partner. Hands on the cloud, and the same rows as a table for Laminar Profile, Group By or any chart.',
  cost: 'expensive',
  inputs: [
    { id: 'points', label: 'Points', type: T.points() },
    { id: 'dataset', label: 'Dataset', type: T.dataset() },
  ],
  outputs: [
    { id: 'points', label: 'Points', type: T.points() },
    { id: 'table', label: 'Table', type: T.table() },
  ],
  params: [
    cellTypeSourceParam(
      'The table cell types are read from, for the neuron and its partner. None adds no types.',
    ),
  ],

  inferOutputs: (ctx) => {
    const schema = pointDepthSchema(ctx.attributes('points'), typed(ctx.params))
    return { points: T.points(schema), table: T.table(schema) }
  },

  validate: (ctx) => {
    const noFrame = frameIssue(datasetRef(ctx.inputs.dataset))
    return noFrame ? [noFrame] : []
  },

  evaluate: async (ctx) => {
    const points = ctx.input('points')
    if (!isPointsValue(points)) {
      throw new Error('Wire a point cloud — Synapses, or any node handing one on — to Points.')
    }
    const dataset = requireDataset(ctx.input('dataset'))
    const frame = frameOf(dataset)
    if (!frame) throw new Error(frameIssue(dataset))
    checkGeometryUnits(
      'The',
      points,
      'points',
      'Synapses',
      'no depth below the pia can be read off them: a cortical frame is in nanometres.',
    )

    let types: Map<string, string> | undefined
    if (typed(ctx.params)) {
      ctx.progress(0.1, 'cell types')
      const annotations = await cellTypeAnnotations(
        dataset.annotations,
        cellTypeRefs(frame, dataset, String(ctx.params.cellTypes), { proofreading: false }),
        {
          ...(ctx.refresh ? { refresh: true } : {}),
          onFetched: ctx.reportFetched,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        },
      )
      // The shared reader of an annotation table: first row per id wins, as Relabel's does.
      types = displayLabels(annotations?.table, ID_COLUMN_NAME, TYPE_COLUMN_NAME) ?? new Map()
    }

    ctx.progress(0.8, 'placing')
    const { points: placed, outside } = pointDepthValue(points, frame, types)
    // A point far above the pia is a position from another volume, or in other units — not L1.
    if (outside > 0) {
      ctx.warn(
        `${outside.toLocaleString()} of ${placed.attributes.length.toLocaleString()} points sit more than ` +
          `${frame.aboveTolerance} µm above the pia, so have a depth and no layer. Check they ` +
          `are from this dataset.`,
      )
    }
    return { points: placed, table: placed.attributes }
  },
})
