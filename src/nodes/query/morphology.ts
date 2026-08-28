/**
 * Morphology fetch nodes: skeletons, meshes and synapse point clouds.
 *
 * All three are collection-level and expensive — one batched request for the whole neuron
 * set, deferred until an explicit Run. They report progress because a few hundred
 * skeletons is the first thing in Coda that takes visible time.
 */

import type { Value } from '../../core/values'
import { datasetRequest } from '../lib/datasetParam'
import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { isTableValue } from '../../core/values'
import { requireDataset, schemasFromType, sourceSupports } from '../lib/datasetParam'
import type { Warner } from '../../core/limits'
import { warnOverThreshold } from '../../core/limits'
import { warnAboveParam } from '../lib/limitParams'
import { idColumn } from '../lib/tableOps'

/**
 * Where every neuron-count control starts warning, so one number governs all of them.
 *
 * Exported because it governs more than the three nodes here: nothing can reach the NBLAST
 * nodes that these did not fetch, so their threshold is this one. Restating the literal there
 * made "parity with the Skeletons node" a comment rather than a fact.
 *
 * It used to be a **refusal** at 500 — and 25 for meshes, and 100 for synapses, each picked
 * before the thing that governs the cost existed. It is now the point at which the node says
 * what it is about to do and then does it (see `core/limits.ts`), which is why the same number
 * can be both the default and the maximum of the control: past ten thousand neurons every
 * backend in the tree is into tens of minutes, and that is worth a sentence on the card
 * whatever anybody set.
 */
export const MAX_NEURONS = 10000

/**
 * Read neuron ids off the incoming table, saying so when the set is a large one.
 *
 * `cost` names what actually gets expensive, because it differs per node and the number is
 * otherwise unexplainable. Two earlier versions of this message were wrong in ways worth
 * keeping in view: the first blamed "this viewer", which has no cap of its own and is not what
 * was refusing, and the second refused at all — a fetch of four thousand skeletons is a long
 * wait, not an impossibility, and the node's job is to say which.
 *
 * An empty input still throws. That is not a guard rail: there is nothing to fetch, so there
 * is no result to warn about.
 */
function neuronIdsFrom(
  ctx: Warner,
  value: Value | undefined,
  limit: number,
  cost: string,
): string[] {
  if (!isTableValue(value)) throw new Error('Neurons input is not a table')
  const ids = idColumn(value, 'neuronId')
  if (ids.length === 0) throw new Error('No neuronIds in the incoming neuron table')
  if (ids.length > limit) {
    warnOverThreshold(ctx, {
      count: ids.length,
      threshold: limit,
      unit: 'neurons',
      control: "this node's Warn above",
      cost,
    })
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
  /*
   * There is a cache behind this node now — `data/geometryCache.ts`, per neuron, for the session
   * — so the declaration is the pairing `NodeDefinition.dataCache` documents: the Clear Cache
   * button appears *and* `evaluate` honours `ctx.refresh`. A node holding downloads with no way
   * to drop them is the control-that-does-nothing this flag exists to prevent, and it matters
   * most on CATMAID, whose skeletons are live tracing data rather than a released dataset's
   * fixed geometry.
   */
  dataCache: true,
  params: [
    warnAboveParam({
      threshold: MAX_NEURONS,
      min: 1,
      cost: 'the fetch goes ahead either way, one request per skeleton.',
    }),
  ],

  // Advertising the attribute schema at edit time is what lets the 3D viewer's
  // "colour by [type]" picker populate before anything has been fetched.
  inferOutputs: (ctx) => ({
    skeletons: T.skeletons(schemasFromType(ctx.inputs.dataset).morphology),
  }),

  validate: (ctx) => {
    /*
     * "This *dataset*", not "this source". `sourceSupports` now asks the dataset first, and CAVE
     * answers per datastack — six of thirteen have the level-2 cache a skeleton is built from —
     * so a message naming the backend was telling a FlyWire-production user something false
     * about a datastack that can perfectly well answer.
     */
    if (ctx.inputs.dataset && !sourceSupports(ctx.inputs.dataset, 'skeletons')) {
      return ['This dataset has no skeletons']
    }
    return []
  },

  evaluate: async (ctx) => {
    const dataset = requireDataset(ctx.input('dataset'))
    const source = ctx.resolveSource(dataset.sourceId)
    if (!source.fetchSkeletons) throw new Error(`${source.label} does not provide skeletons`)

    const neuronIds = neuronIdsFrom(
      ctx,
      ctx.input('neurons'),
      Number(ctx.params.limit ?? MAX_NEURONS),
      'Each skeleton is a separate request, and a few thousand of them is minutes rather than seconds.',
    )
    ctx.progress(0.02, `${neuronIds.length} neurons`)
    const skeletons = await source.fetchSkeletons({
      ...datasetRequest(dataset),
      neuronIds,
      onProgress: ctx.progress,
      // A cost only the backend knows: see `GeometryRequest.onWarn`.
      onWarn: ctx.warn,
      // Clear Cache reaching the session's geometry cache, and the age it reports coming back —
      // see `EvalContext.refresh` and `reportFetched`.
      ...(ctx.refresh ? { refresh: true } : {}),
      onFetched: ctx.reportFetched,
      /*
       * Straight onto the wire as bodies land. The port name has to be this node's own output
       * port, because that is what the 3D viewer reads through `nodeInputs` — nothing downstream
       * re-runs, so the value on the port *is* the scene. See `EvalContext.publish`.
       */
      onPartial: (partial) => ctx.publish({ skeletons: partial }),
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
  // Same pairing as Skeletons, and the cache matters more here: one graphene mesh is several
  // hundred requests.
  dataCache: true,
  params: [
    /*
     * Was 25, chosen before levels of detail existed and never re-derived. Detail now governs
     * weight: at the coarsest level a hemibrain neuron is ~11 kB, so refusing 30 of them was
     * refusing a few hundred kilobytes. What the count still bounds is *requests* — roughly
     * three round trips each for a sharded source — and transfer on a source with no levels at
     * all, where every neuron arrives at full resolution.
     */
    warnAboveParam({
      threshold: MAX_NEURONS,
      min: 1,
      cost:
        'the fetch goes ahead either way. Detail governs how heavy each mesh is and this is ' +
        'about how many — a source with no levels of detail (male-CNS) sends full resolution ' +
        'regardless, a few megabytes per neuron.',
    }),
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
    if (ctx.inputs.dataset && !sourceSupports(ctx.inputs.dataset, 'meshes')) {
      return ['This data source has no meshes']
    }
    return []
  },

  evaluate: async (ctx) => {
    const dataset = requireDataset(ctx.input('dataset'))
    const source = ctx.resolveSource(dataset.sourceId)
    if (!source.fetchMeshes) throw new Error(`${source.label} does not provide meshes`)

    const neuronIds = neuronIdsFrom(
      ctx,
      ctx.input('neurons'),
      Number(ctx.params.limit ?? MAX_NEURONS),
      'Each mesh is a separate fetch, and a source without levels of detail sends full resolution.',
    )
    ctx.progress(0.02, `${neuronIds.length} neurons`)
    const meshes = await source.fetchMeshes({
      ...datasetRequest(dataset),
      neuronIds,
      triangleBudget: Number(ctx.params.detail ?? 1_500_000) || 1_500_000,
      onProgress: ctx.progress,
      // A cost only the backend knows: see `GeometryRequest.onWarn`.
      onWarn: ctx.warn,
      ...(ctx.refresh ? { refresh: true } : {}),
      onFetched: ctx.reportFetched,
      // As above. On a multi-resolution source nothing arrives until the manifest sweep is done,
      // because the level cannot be chosen before then — see `fetchMeshes`' `onPartial`.
      onPartial: (partial) => ctx.publish({ meshes: partial }),
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
    warnAboveParam({
      threshold: MAX_NEURONS,
      min: 1,
      cost: 'the query goes ahead either way, and it returns a row per synapse.',
    }),
  ],

  inferOutputs: (ctx) => ({
    points: T.points(schemasFromType(ctx.inputs.dataset).synapses),
  }),

  validate: (ctx) => {
    if (ctx.inputs.dataset && !sourceSupports(ctx.inputs.dataset, 'synapses')) {
      return ['This data source has no synapse locations']
    }
    return []
  },

  evaluate: async (ctx) => {
    const dataset = requireDataset(ctx.input('dataset'))
    const source = ctx.resolveSource(dataset.sourceId)
    if (!source.fetchSynapses) throw new Error(`${source.label} does not provide synapses`)

    const neuronIds = neuronIdsFrom(
      ctx,
      ctx.input('neurons'),
      Number(ctx.params.limit ?? MAX_NEURONS),
      'These arrive in one query, but it returns a row per synapse — thousands per neuron.',
    )
    const polarity = String(ctx.params.polarity ?? '')
    ctx.progress(0.1, `${neuronIds.length} neurons`)

    const points = await source.fetchSynapses({
      ...datasetRequest(dataset),
      neuronIds,
      onProgress: ctx.progress,
      // A cost only the backend knows: see `GeometryRequest.onWarn`.
      onWarn: ctx.warn,
      ...(polarity === 'pre' || polarity === 'post' ? { polarity } : {}),
      minWeight: Number(ctx.params.minWeight ?? 1),
      signal: ctx.signal,
    })
    return { points }
  },
})
