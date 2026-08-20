/**
 * Morphology fetch nodes: skeletons, meshes and synapse point clouds.
 *
 * All three are collection-level and expensive — one batched request for the whole neuron
 * set, deferred until an explicit Run. They report progress because a few hundred
 * skeletons is the first thing in Coda that takes visible time.
 */

import type { Value } from '../../core/values'
import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { isTableValue } from '../../core/values'
import { requireDataset, schemasFromType, sourceSupports } from '../lib/datasetParam'
import { idColumn } from '../lib/tableOps'

/** Ceiling on every morphology node's `Max neurons`, so one number governs all three. */
const MAX_NEURONS = 500

/**
 * Read body ids off the incoming table, refusing an oversized set.
 *
 * `cost` names what actually gets expensive, because it differs per node and the limit is
 * otherwise unexplainable. The old message blamed "this viewer", which was wrong twice
 * over: the viewer has no cap of its own, and drawing is not the constraint — fetching is.
 */
function bodyIdsFrom(value: Value | undefined, limit: number, cost: string): number[] {
  if (!isTableValue(value)) throw new Error('Neurons input is not a table')
  const ids = idColumn(value, 'bodyId')
  if (ids.length === 0) throw new Error('No bodyIds in the incoming neuron table')
  if (ids.length > limit) {
    throw new Error(
      `${ids.length} neurons exceeds this node's Max neurons (${limit}). ${cost} ` +
        `Raise the limit if you mean it, or filter upstream.`,
    )
  }
  return ids
}

export const skeletonsNode = registerNode({
  type: 'neuron.skeletons',
  label: 'Skeletons',
  category: 'query',
  description: 'Fetch branching morphologies for the incoming neurons.',
  guide:
    'Branching morphologies for the incoming neurons — the wire-frame shape of the cell, ready for the 3D View. Each skeleton arrives with an attribute row of its own, so colouring by cell type is a column picker rather than a special case in the viewer. Coordinates come out in nanometres, converted from the dataset’s voxels, so a skeleton and a mesh of the same neuron sit in the same space.',
  cost: 'expensive',
  inputs: [
    { id: 'dataset', label: 'Dataset', type: T.dataset() },
    { id: 'neurons', label: 'Neurons', type: T.neurons() },
  ],
  outputs: [{ id: 'skeletons', label: 'Skeletons', type: T.skeletons() }],
  params: [
    {
      id: 'limit',
      kind: 'int',
      label: 'Max neurons',
      help: 'Refuse to fetch more than this many, rather than locking up the tab.',
      default: 100,
      min: 1,
      max: MAX_NEURONS,
      step: 10,
      advanced: true,
    },
  ],

  // Advertising the attribute schema at edit time is what lets the 3D viewer's
  // "colour by [type]" picker populate before anything has been fetched.
  inferOutputs: (ctx) => ({
    skeletons: T.skeletons(schemasFromType(ctx.inputs.dataset).morphology),
  }),

  validate: (ctx) => {
    const source = ctx.inputs.dataset
    if (source && !sourceSupports(ctx, 'skeletons'))
      return ['This data source has no skeletons']
    return []
  },

  evaluate: async (ctx) => {
    const dataset = requireDataset(ctx.input('dataset'))
    const source = ctx.resolveSource(dataset.sourceId)
    if (!source.fetchSkeletons) throw new Error(`${source.label} does not provide skeletons`)

    const bodyIds = bodyIdsFrom(
      ctx.input('neurons'),
      Number(ctx.params.limit ?? 100),
      'Each skeleton is a separate request.',
    )
    ctx.progress(0.02, `${bodyIds.length} neurons`)
    const skeletons = await source.fetchSkeletons({
      datasetId: dataset.datasetId,
      bodyIds,
      onProgress: ctx.progress,
      signal: ctx.signal,
    })
    return { skeletons }
  },
})

export const meshesNode = registerNode({
  type: 'neuron.meshes',
  label: 'Meshes',
  category: 'query',
  description: 'Fetch surface meshes for the incoming neurons.',
  guide:
    'Surface meshes for the incoming neurons: the filled shape rather than the wire frame, which is what you want for a figure and for seeing where a neurite actually thickens. Meshes come from public object stores rather than from neuPrint, so they need no token and work in a static deploy. Detail picks the finest level of the published multi-resolution mesh that fits a triangle budget across the whole batch — the caption says which level it settled on.',
  cost: 'expensive',
  inputs: [
    { id: 'dataset', label: 'Dataset', type: T.dataset() },
    { id: 'neurons', label: 'Neurons', type: T.neurons() },
  ],
  outputs: [{ id: 'meshes', label: 'Meshes', type: T.meshes() }],
  params: [
    {
      id: 'limit',
      kind: 'int',
      label: 'Max neurons',
      /*
       * Was 25, chosen before levels of detail existed and never re-derived. Detail now
       * governs weight: at the coarsest level a hemibrain neuron is ~11 kB, so refusing 30
       * of them was refusing a few hundred kilobytes. What the count still bounds is
       * *requests* — roughly three round trips each for a sharded source — and transfer on
       * a source with no levels at all, where every neuron arrives at full resolution.
       */
      help: 'Detail governs how heavy each mesh is; this bounds how many are fetched. Sources with no levels of detail (male-CNS) send full resolution regardless — a few megabytes per neuron.',
      default: MAX_NEURONS,
      min: 1,
      max: MAX_NEURONS,
      step: 10,
      advanced: true,
    },
    {
      id: 'detail',
      kind: 'enum',
      label: 'Detail',
      default: '1500000',
      help: 'Triangle budget for the whole set. Sources with levels of detail pick the finest level that fits, so asking for more neurons gets you coarser ones.',
      options: [
        { value: '150000', label: 'low — many neurons' },
        { value: '1500000', label: 'balanced' },
        { value: '6000000', label: 'high — a few neurons' },
      ],
    },
  ],

  inferOutputs: (ctx) => ({
    meshes: T.meshes(schemasFromType(ctx.inputs.dataset).morphology),
  }),

  validate: (ctx) => {
    if (ctx.inputs.dataset && !sourceSupports(ctx, 'meshes')) {
      return ['This data source has no meshes']
    }
    return []
  },

  evaluate: async (ctx) => {
    const dataset = requireDataset(ctx.input('dataset'))
    const source = ctx.resolveSource(dataset.sourceId)
    if (!source.fetchMeshes) throw new Error(`${source.label} does not provide meshes`)

    const bodyIds = bodyIdsFrom(
      ctx.input('neurons'),
      Number(ctx.params.limit ?? MAX_NEURONS),
      'Each mesh is a separate fetch, and a source without levels of detail sends full resolution.',
    )
    ctx.progress(0.02, `${bodyIds.length} neurons`)
    const meshes = await source.fetchMeshes({
      datasetId: dataset.datasetId,
      bodyIds,
      triangleBudget: Number(ctx.params.detail ?? 1_500_000) || 1_500_000,
      onProgress: ctx.progress,
      signal: ctx.signal,
    })
    return { meshes }
  },
})

export const synapsesNode = registerNode({
  type: 'neuron.synapses',
  label: 'Synapses',
  category: 'query',
  description: 'Fetch synapse locations as a 3D point cloud.',
  guide:
    'Synapse locations as a 3D point cloud, one point per synapse with its polarity and partner in the attribute table. Drawn in the same space as skeletons and meshes, so a scene can colour neurons by cell type and their synapses by direction at once. This is the node that turns “these two are connected” into “and here is where”.',
  cost: 'expensive',
  inputs: [
    { id: 'dataset', label: 'Dataset', type: T.dataset() },
    { id: 'neurons', label: 'Neurons', type: T.neurons() },
  ],
  outputs: [{ id: 'points', label: 'Points', type: T.points() }],
  params: [
    {
      id: 'polarity',
      kind: 'enum',
      label: 'Polarity',
      default: '',
      options: [
        { value: '', label: 'both' },
        { value: 'pre', label: 'presynaptic (outputs)' },
        { value: 'post', label: 'postsynaptic (inputs)' },
      ],
    },
    {
      id: 'minWeight',
      kind: 'int',
      label: 'Min weight',
      default: 1,
      min: 1,
      step: 1,
    },
    {
      id: 'limit',
      kind: 'int',
      label: 'Max neurons',
      default: 100,
      min: 1,
      max: MAX_NEURONS,
      step: 10,
      advanced: true,
    },
  ],

  inferOutputs: (ctx) => ({
    points: T.points(schemasFromType(ctx.inputs.dataset).synapses),
  }),

  validate: (ctx) => {
    if (ctx.inputs.dataset && !sourceSupports(ctx, 'synapses')) {
      return ['This data source has no synapse locations']
    }
    return []
  },

  evaluate: async (ctx) => {
    const dataset = requireDataset(ctx.input('dataset'))
    const source = ctx.resolveSource(dataset.sourceId)
    if (!source.fetchSynapses) throw new Error(`${source.label} does not provide synapses`)

    const bodyIds = bodyIdsFrom(
      ctx.input('neurons'),
      Number(ctx.params.limit ?? 100),
      'These arrive in one query, but it returns a row per synapse — thousands per neuron.',
    )
    const polarity = String(ctx.params.polarity ?? '')
    ctx.progress(0.1, `${bodyIds.length} neurons`)

    const points = await source.fetchSynapses({
      datasetId: dataset.datasetId,
      bodyIds,
      onProgress: ctx.progress,
      ...(polarity === 'pre' || polarity === 'post' ? { polarity } : {}),
      minWeight: Number(ctx.params.minWeight ?? 1),
      signal: ctx.signal,
    })
    return { points }
  },
})
