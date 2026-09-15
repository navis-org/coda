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
import {
  publishedNeurons,
  requireDataset,
  schemasFromType,
  sourceLabel,
  sourceSupports,
} from '../lib/datasetParam'
import { ID_COLUMN_NAME, idText } from '../../core/ids'
import { selectPoints } from '../lib/iterables'
import type { Warner } from '../../core/limits'
import { warnOverThreshold } from '../../core/limits'
import { warnAboveParam } from '../lib/limitParams'
import {
  SKELETON_SOURCE_PARAM,
  skeletonSourceParam,
  skeletonSourceProblem,
} from '../lib/skeletonParams'
import { asSkeletonRoute } from '../../data/skeletonRoutes'
import { resolveSynapseUnit } from '../../data/synapseUnits'
import { SYNAPSES_BETWEEN_SCHEMA, synapseUnitsOf } from '../../data/source'
import {
  SYNAPSE_UNIT_PARAM,
  minConfidenceParam,
  minSynapseConfidence,
  pinnedSynapseUnit,
  synapseUnitParam,
  synapseUnitProblem,
} from '../lib/synapseParams'
import { idColumn } from '../lib/tableOps'
import { carriedMorphology, carryParam, carrying } from '../lib/carryParams'

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
// Exported for `out.topology`, which fetches the same two things for the same reason and would
// otherwise carry a second copy of the ceiling, the message and the empty-input rule.
export function neuronIdsFrom(
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
    'Neuron surface meshes. Where they come from and the level(s) of detail available varies by source. **Detail** is a triangle budget for the whole batch, so asking for more neurons gets you coarser ones. A collection carries only the fetch’s own attributes, so use Carry fields for anything else you want to filter or colour by.',
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
      'Each mesh is a separate fetch, and a source without levels of detail sends full resolution.',
    )
    ctx.progress(0.02, `${neuronIds.length} neurons`)
    const carry = carrying(ctx)
    const meshes = await source.fetchMeshes({
      ...datasetRequest(dataset),
      neuronIds,
      triangleBudget: Number(ctx.params.detail) || 1_500_000,
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

registerNode({
  type: 'neuron.synapses',
  label: 'Synapses',
  category: 'query',
  description: 'Fetch synapse locations as a 3D point cloud.',
  guide:
    'Synapse locations as a 3D point cloud, one point per synapse with its polarity in the attribute table — and its partner where the data source carries one. Drawn in the same space as skeletons and meshes, so a scene can colour neurons by cell type and their synapses by direction at once. This is the node that turns “these two are connected” into “and here is where”. Backends count synapses differently, so Rows says whether a point is a connection or a site.',
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
    synapseUnitParam(),
    /*
     * **A confidence, and it was called a weight until the mistake surfaced in the open.** Every
     * backend read the old `minWeight` as its own per-synapse confidence column, and the control
     * was an integer floored at 1 — so the *default* compiled to `s.confidence >= 1` against
     * neuPrint's 0..1 predictor score. On `male-cns:v1.0` body 10001 that returned 13,617 of
     * 19,597 synapses and not one presynaptic site; on MANC and optic-lobe it returned no
     * presynaptic site at all, and on hemibrain about a thousandth of the cloud.
     *
     * `0` is off, which is why the type had to change with the name: an `int` floored at 1 has no
     * spelling for "keep everything", and the values that matter on neuPrint are all fractions.
     * There is no `max`, because the scale is the backend's own and they do not agree — see
     * `SynapseRequest.minConfidence`. Renaming the id is what carries stored graphs across:
     * `normalizeParams` reads only declared params, so an old `minWeight: 1` stops being in the
     * provenance key, and the absent `minConfidence` falls to this default. That is deliberate.
     * The old value meant a filter nobody asked for.
     *
     * Inspector-only: dataset-level confidence floors are already applied at ingest
     * (`Meta.postHighAccuracyThreshold` is 0.5 on male-CNS, which is why nothing in that cloud
     * scores below 0.5004), so this is a control for cutting *further* and not one a card needs
     * to carry.
     */
    minConfidenceParam('Drop synapses scoring below this; 0 keeps every one.'),
    warnAboveParam({
      threshold: MAX_NEURONS,
      min: 1,
      counting: 'fetching synapses for more than this many neurons',
    }),
  ],

  inferOutputs: (ctx) => ({
    points: T.points(schemasFromType(ctx.inputs.dataset).synapses),
  }),

  validate: (ctx) => {
    if (ctx.inputs.dataset && !sourceSupports(ctx.inputs.dataset, 'synapses')) {
      return ['This data source has no synapse locations']
    }
    const pinned = synapseUnitProblem(
      ctx.inputs.dataset,
      String(ctx.params[SYNAPSE_UNIT_PARAM] ?? ''),
    )
    return pinned ? [pinned] : []
  },

  evaluate: async (ctx) => {
    const dataset = requireDataset(ctx.input('dataset'))
    const source = ctx.resolveSource(dataset.sourceId)
    if (!source.fetchSynapses) throw new Error(`${source.label} does not provide synapses`)

    const neuronIds = neuronIdsFrom(
      ctx,
      ctx.input('neurons'),
      Number(ctx.params.limit),
      'These arrive in one query, but it returns a row per synapse — thousands per neuron.',
    )
    const polarity = String(ctx.params.polarity)
    /*
     * **Resolved here, at the one door.** `fetchSynapses` has exactly this caller, and a unit
     * varies with nothing — so a copy of this inside each backend was three re-derivations of a
     * static fact, discarding the answer in all three, plus a fourth place for a new backend to
     * forget. `SynapseRequest.unit` is required instead, which makes "the caller decided" a thing
     * the type says. A source with no `synapseUnits` at all lands here rather than silently
     * serving whatever it felt like.
     */
    const units = synapseUnitsOf(source)
    if (!units) throw new Error(`${source.label} does not say what its synapse rows count.`)
    const unit = resolveSynapseUnit(source.label, pinnedSynapseUnit(ctx.params), units)
    ctx.progress(0.1, `${neuronIds.length} neurons`)

    const points = await source.fetchSynapses({
      ...datasetRequest(dataset),
      neuronIds,
      onProgress: ctx.progress,
      // A cost only the backend knows: see `GeometryRequest.onWarn`.
      onWarn: ctx.warn,
      ...(polarity === 'pre' || polarity === 'post' ? { polarity } : {}),
      minConfidence: minSynapseConfidence(ctx.params),
      unit,
      signal: ctx.signal,
    })
    return { points }
  },
})

/**
 * The synapses between two neuron sets — neuprint-python's `fetch_synapse_connections`.
 *
 * **A node of its own rather than a filter on Synapses**, for two reasons that are both about
 * cost and meaning rather than taste. Restricting a Synapses cloud to a partner makes every row a
 * connection, which leaves that node's `Rows` control meaning nothing once the port is wired. And
 * filtering afterwards cannot shrink the download: neuPrint drops partner columns from the site
 * cloud because resolving them is a join, and a CAVE query narrowed on one end can hit the row cap
 * that one narrowed on both ends would not. So `fetchSynapsesBetween` binds both ends at the
 * server.
 *
 * **The columns are oriented and never swap.** `neuronId` is the source and `partnerId` the
 * target whatever `Location` says; `polarity` is the one column that follows it. Letting the
 * point "own" `neuronId` — Synapses' rule — would re-point every colour-by and join downstream on
 * a change to where a dot is drawn.
 */
registerNode({
  type: 'neuron.synapsesBetween',
  label: 'Synapses Between',
  category: 'query',
  description: 'Fetch the synapses from one set of neurons onto another as a 3D point cloud.',
  guide:
    'Where two populations actually connect: every synapse from the Sources onto the Targets, one point per synapse connection, narrowed at the server rather than fetched for one side and filtered. Wire only Sources for everything they synapse onto, or only Targets for everything onto them — the open side then counts published neurons unless Include fragments is on. Each point carries its source as neuronId and its target as partnerId, so counting points per pair gives the Connectivity weight; Location picks whether a point sits at the presynaptic or the postsynaptic site.',
  cost: 'expensive',
  /*
   * Both optional, at least one wired — `fetch_synapse_connections(sources, None)` and its mirror.
   * Neither is refused in `validate`, since both open is the whole synapse table. A port wired to
   * a node that cannot run is *not* an open side: the scheduler blocks an optional port whose
   * upstream is unavailable (`gatherInputs`), so a failed Sources can never quietly turn into
   * every synapse onto the Targets.
   */
  inputs: [
    { id: 'dataset', label: 'Dataset', type: T.dataset() },
    { id: 'sources', label: 'Sources', type: T.neurons(), required: false },
    { id: 'targets', label: 'Targets', type: T.neurons(), required: false },
  ],
  outputs: [{ id: 'points', label: 'Points', type: T.points() }],
  params: [
    /*
     * In the key, not presentational: it moves every coordinate `evaluate` returns. `pre` first
     * because it is what both neuPrint's T-bar and FlyWire's configured position column draw.
     */
    {
      id: 'location',
      kind: 'enum',
      label: 'Location',
      default: 'pre',
      options: [
        { value: 'pre', label: 'presynaptic site' },
        { value: 'post', label: 'postsynaptic site' },
      ],
      help: 'Which end of each connection a point is drawn at. neuPrint and CAVE have both; CATMAID has one position per connector and draws it for either. The columns do not change — neuronId stays the source, partnerId the target, and polarity says which end this is.',
    },
    /*
     * Connectivity's control, with Connectivity's answer, for the side left open.
     *
     * An open side is a far end, and a far end is mostly fragments: body 10003's downstream
     * synapses are 30,020 rows over every partner and 17,085 over `:Neuron` ones. So off by
     * default, and "published" is asked of the Dataset card's population through
     * `publishedNeurons` — `findNeurons`, as Connectivity asks it — rather than of a label, so the
     * two nodes on one card cannot disagree about what a neuron is. neuprint-python's own open
     * side (`NeuronCriteria()` with no body id) is `:Neuron` too, so the default is also that
     * library's.
     *
     * A bound side is never filtered: those ids were asked for, and a fragment somebody wired in
     * is one they meant — Connectivity's seed exemption. Which is also why this does nothing
     * with both ports wired, and the help says so rather than `visibleIf` hiding it: `visibleIf`
     * reads params, not wires. No `absentMeans` — no stored node predates it.
     */
    {
      id: 'includeFragments',
      kind: 'boolean',
      label: 'Include fragments',
      default: false,
      help: 'Only matters with Sources or Targets unwired. Off, the open side counts only published neurons — set what counts on the Dataset node. On, fragments count too, and they are most of a neuron’s partners.',
    },
    minConfidenceParam(
      'Drop a connection when either of its synapses scores below this; 0 keeps every one.',
    ),
    warnAboveParam({
      threshold: MAX_NEURONS,
      min: 1,
      counting: 'fetching synapses for more than this many sources or targets',
    }),
  ],

  inferOutputs: () => ({ points: T.points(SYNAPSES_BETWEEN_SCHEMA) }),

  validate: (ctx) => {
    if (ctx.inputs.sources === undefined && ctx.inputs.targets === undefined) {
      return ['Wire Sources, Targets or both']
    }
    const dataset = ctx.inputs.dataset
    if (!dataset) return []
    if (!sourceSupports(dataset, 'synapses'))
      return ['This data source has no synapse locations']
    if (!sourceSupports(dataset, 'synapsesBetween')) {
      return [
        `${sourceLabel(dataset) ?? 'This data source'} cannot fetch the synapses between two neuron sets`,
      ]
    }
    return []
  },

  evaluate: async (ctx) => {
    const dataset = requireDataset(ctx.input('dataset'))
    const source = ctx.resolveSource(dataset.sourceId)
    if (!source.fetchSynapsesBetween) {
      throw new Error(`${source.label} cannot fetch the synapses between two neuron sets`)
    }
    const limit = Number(ctx.params.limit)
    const cost = 'These arrive in one query, but it returns a row per synapse connection.'
    // `input` is undefined only for an unwired port here: a wired one whose upstream could not
    // run has already blocked this node.
    const sources = ctx.input('sources')
    const targets = ctx.input('targets')
    if (sources === undefined && targets === undefined) {
      throw new Error('Wire Sources, Targets or both')
    }
    const sourceIds =
      sources === undefined ? undefined : neuronIdsFrom(ctx, sources, limit, cost)
    const targetIds =
      targets === undefined ? undefined : neuronIdsFrom(ctx, targets, limit, cost)
    ctx.progress(
      0.1,
      sourceIds && targetIds
        ? `${sourceIds.length} → ${targetIds.length} neurons`
        : sourceIds
          ? `${sourceIds.length} neurons → any`
          : `any → ${targetIds!.length} neurons`,
    )

    let points = await source.fetchSynapsesBetween({
      ...datasetRequest(dataset),
      ...(sourceIds ? { sourceIds } : {}),
      ...(targetIds ? { targetIds } : {}),
      location: ctx.params.location === 'post' ? 'post' : 'pre',
      minConfidence: minSynapseConfidence(ctx.params),
      onProgress: ctx.progress,
      onWarn: ctx.warn,
      signal: ctx.signal,
    })

    // The open side's fragments, asked of the Dataset card's population — see the param.
    const open =
      sourceIds === undefined
        ? ID_COLUMN_NAME
        : targetIds === undefined
          ? 'partnerId'
          : undefined
    if (open && ctx.params.includeFragments !== true && points.attributes.length > 0) {
      // One `idText` pass, read by both the lookup and the filter.
      const ids = (points.attributes.data[open] ?? []).map((cell) => idText(cell))
      const partners = [...new Set(ids.filter((id): id is string => id !== null))]
      ctx.progress(0.9, `checking ${partners.length} partners`)
      const published = await publishedNeurons(source, dataset, ctx.signal)(partners)
      points = selectPoints(points, (i) => {
        const id = ids[i]
        return typeof id === 'string' && published.has(id)
      })
    }
    return { points }
  },
})
