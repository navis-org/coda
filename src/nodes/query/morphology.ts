/**
 * Morphology fetch nodes: skeletons and meshes. The synapse point clouds that were here are in the
 * Connectome pack (`packs/connectome/synapses.ts`). The ceiling and the id rule all of them read
 * are `lib/limitParams.ts`' `MAX_NEURONS` and `neuronIdsFrom`.
 *
 * Both are collection-level and expensive — one batched request for the whole neuron
 * set, deferred until an explicit Run. They report progress because a few hundred
 * skeletons is the first thing in Coda that takes visible time.
 */

import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { datasetRequest, requireDataset, sourceSupports } from '../lib/datasetParam'
import { MAX_NEURONS, neuronIdsFrom, warnAboveParam } from '../lib/limitParams'
import {
  SKELETON_SOURCE_PARAM,
  skeletonSourceParam,
  skeletonSourceProblem,
} from '../lib/skeletonParams'
import { asSkeletonRoute } from '../../data/skeletonRoutes'
import { fetchMeshesFor } from '../../data/source'
import { carriedMorphology, carryParam, carrying } from '../lib/carryParams'
import { detailParam, downsampleParam, meshDetailRequest } from '../lib/meshDetailParams'

registerNode({
  type: 'neuron.skeletons',
  label: 'Skeletons',
  category: 'query',
  description: 'Fetch centerline tracings for the incoming neurons.',
  guide:
    'Centerline tracings for the incoming neurons — encode both the 3D shape and topology of the cell. Coordinates come out in nanometres, so a skeleton and a mesh of the same neuron sit in the same space. Some datasets have more than one place to get a skeleton. A collection carries only the fetch’s own attributes, so use Carry fields for anything else you want to filter or colour by.',
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
    /*
     * Which route, and it is deliberately *not* `presentational`: it changes what `evaluate`
     * returns — a chunk-graph skeleton and a traced one are different geometry with different
     * cable lengths — so it belongs in the provenance key (invariant 4). Marking it
     * presentational would leave a scene showing one route's skeletons under a card claiming the
     * other.
     */
    skeletonSourceParam(),
    /*
     * Columns of the incoming neuron table, carried onto the skeletons' own attribute table —
     * which is otherwise the source's seven-column morphology schema and nothing else. See
     * `nodes/lib/carryParams.ts` for why a collection does not simply inherit the table that
     * named its neurons, and for the join's rules.
     */
    carryParam('skeleton'),
    warnAboveParam({
      threshold: MAX_NEURONS,
      min: 1,
      counting: 'fetching more than this many skeletons',
    }),
  ],

  // Advertising the attribute schema at edit time is what lets the 3D viewer's
  // "colour by [type]" picker populate before anything has been fetched — including the
  // carried columns, which is what puts them in every picker downstream before a Run.
  inferOutputs: (ctx) => ({ skeletons: T.skeletons(carriedMorphology(ctx)) }),

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
    // A pinned route this dataset cannot take. Reported rather than substituted — see
    // `skeletonParams.ts`, and `GeometryRequest.skeletonSource` for the run-time half.
    const pinned = skeletonSourceProblem(
      ctx.inputs.dataset,
      String(ctx.params[SKELETON_SOURCE_PARAM] ?? ''),
    )
    return pinned ? [pinned] : []
  },

  evaluate: async (ctx) => {
    const dataset = requireDataset(ctx.input('dataset'))
    const source = ctx.resolveSource(dataset.sourceId)
    if (!source.fetchSkeletons) throw new Error(`${source.label} does not provide skeletons`)

    const neuronIds = neuronIdsFrom(
      ctx,
      ctx.input('neurons'),
      Number(ctx.params.limit),
      'Each skeleton is a separate request, and a few thousand of them is minutes rather than seconds.',
    )
    ctx.progress(0.02, `${neuronIds.length} neurons`)
    // Bound once rather than per publish — see `carrying`.
    const carry = carrying(ctx)
    // Narrowed once, here: a document can name a route this build has never heard of, and
    // reading that as "nobody chose" is the degradation every other unknown param value gets.
    const skeletonSource = asSkeletonRoute(ctx.params[SKELETON_SOURCE_PARAM])
    const skeletons = await source.fetchSkeletons({
      ...datasetRequest(dataset),
      neuronIds,
      // Empty means *nobody chose* rather than "the first one", which is what lets a source fall
      // back when its preferred route turns out to answer for nothing. See the field's doc.
      ...(skeletonSource ? { skeletonSource } : {}),
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
      onPartial: (partial) =>
        // Carried onto the partial too, or the streamed scene is coloured by a column the
        // finished one has and this one does not — a picker that draws nothing until the last
        // body lands.
        ctx.publish({ skeletons: carry(partial) }),
      signal: ctx.signal,
    })
    return { skeletons: carry(skeletons) }
  },
})

registerNode({
  type: 'neuron.meshes',
  label: 'Meshes',
  category: 'query',
  description: 'Fetch surface meshes for the incoming neurons.',
  guide:
    'Neuron surface meshes; where they come from varies by source. **Detail** spends a triangle budget among the levels a source publishes, and does nothing where there is only one — **Downsample** reduces the geometry itself, anywhere. A collection carries only the fetch’s own attributes, so use Carry fields for anything else.',
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
      counting: 'fetching more than this many meshes',
    }),
    carryParam('mesh'),
    detailParam(),
    downsampleParam(),
  ],

  inferOutputs: (ctx) => ({ meshes: T.meshes(carriedMorphology(ctx)) }),

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
      Number(ctx.params.limit),
      'Each mesh is a separate fetch, and a source without levels of detail sends full resolution unless Downsample is set.',
    )
    ctx.progress(0.02, `${neuronIds.length} neurons`)
    const carry = carrying(ctx)
    // Through the seam rather than the method: `fetchMeshesFor` is what makes `downsample` a
    // request a source cannot silently decline, and what stamps the receipt whichever route ran.
    const meshes = await fetchMeshesFor(source, {
      ...datasetRequest(dataset),
      neuronIds,
      ...meshDetailRequest(ctx.params),
      onProgress: ctx.progress,
      // A cost only the backend knows: see `GeometryRequest.onWarn`.
      onWarn: ctx.warn,
      ...(ctx.refresh ? { refresh: true } : {}),
      onFetched: ctx.reportFetched,
      // As above. On a multi-resolution source nothing arrives until the manifest sweep is done,
      // because the level cannot be chosen before then — see `fetchMeshes`' `onPartial`.
      onPartial: (partial) => ctx.publish({ meshes: carry(partial) }),
      signal: ctx.signal,
    })
    return { meshes: carry(meshes) }
  },
})
