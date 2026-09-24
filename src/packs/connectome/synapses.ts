/**
 * Synapses, and the synapses between two sets of neurons: the Connectome pack's point clouds.
 *
 * Split out of `nodes/query/morphology.ts` when these two moved into the pack, Skeletons and Meshes
 * staying built in. The neuron-count ceiling and id reading all four share are in
 * `nodes/lib/limitParams.ts`, where a pack can read them without importing a module that registers
 * nodes.
 */

import { packNode } from '../../core/registry'
import { T } from '../../core/types'
import {
  datasetRequest,
  publishedNeurons,
  requireDataset,
  schemasFromType,
  sourceLabel,
  sourceSupports,
} from '../../nodes/lib/datasetParam'
import { ID_COLUMN_NAME, idText } from '../../core/ids'
import { selectPoints } from '../../nodes/lib/iterables'
import { warnAboveParam } from '../../nodes/lib/limitParams'
import { resolveSynapseUnit } from '../../data/synapseUnits'
import { SYNAPSES_BETWEEN_SCHEMA, synapseUnitsOf } from '../../data/source'
import {
  SYNAPSE_UNIT_PARAM,
  minConfidenceParam,
  minSynapseConfidence,
  pinnedSynapseUnit,
  synapseUnitParam,
  synapseUnitProblem,
} from '../../nodes/lib/synapseParams'
import { MAX_NEURONS, neuronIdsFrom } from '../../nodes/lib/limitParams'

export const synapsesNode = packNode({
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
export const synapsesBetweenNode = packNode({
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
        `${sourceLabel(dataset) ?? 'This data source'} cannot fetch the synapses between ` +
          `two neuron sets.`,
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
