/**
 * Neuron Dendrogram: one neuron's arbour drawn flat, with its synapses on it, and what lies
 * distal to any point you click.
 *
 * Neuron Topology's sibling, and the two share their fetch — `useNeuronTopology` is called by both
 * cards with the same key, so paging one neuron in either fills the cache for the other. Where
 * Topology measures the arbour and draws it in 3D, this lays it out in the plane against a real
 * distance axis, geodesic or electrotonic, which is what makes "how far out on this branch do the
 * inputs from X sit" a question the picture answers.
 *
 * ## `expensive`, for one port
 *
 * The card is live and fetches for itself, Topology's arrangement; `evaluate` passes the table
 * through and slices the pinned row, as Profile's does. What made the node `expensive` is the
 * Points port: the synapses beyond the clicked point, with their distances, which needs the
 * neuron's skeleton and synapses at Run. The skeleton is a session-cache hit after the card has
 * shown the neuron (`data/geometryCache.ts`), and so is its heal where it arrived in pieces
 * (`arborHeal.ts`, shared with the card); the synapses are one request. Invariant 6 is why it
 * cannot be `cheap` — every click would be a request.
 *
 * Three params are therefore data rather than presentation: the clicked point (which carries
 * its own neuron, so paging stays free), the root choice and the picked root node, since what
 * counts as "beyond" depends on the root. Clicking a branch marks the graph stale; Run fills
 * the port.
 *
 * Every other control — layout, distance, the membrane constants, the twig threshold, the lit
 * partners and the styling — changes what the card draws and nothing any port carries, so none of
 * them is in the provenance key and none marks the graph stale. The electrotonic constants in
 * particular are *not* data here — a change of Rm re-scales an axis on a card, it does not change
 * a value downstream — which is the opposite of what they would be on a node that emitted the
 * distances.
 *
 * The heavy lifting is headless: `nodes/lib/arborOps.ts` (re-rooting, distances, synapse
 * placement, the distal query), `nodes/lib/arborLayout.ts` (the four layouts) and
 * `nodes/lib/arborHeal.ts` (joining a fragmented skeleton, in Python).
 */

import { registerNode } from '../../core/registry'
import { T, columnNames, isTabular, schemaOf } from '../../core/types'
import type { PointsValue } from '../../core/values'
import { EMPTY_BOUNDS, isTableValue, makeTable } from '../../core/values'
import { canFetchSynapseLinks, synapseUnitsOf } from '../../data/source'
import { resolveSynapseUnit } from '../../data/synapseUnits'
import { healSkeleton } from '../lib/arborHeal'
import {
  DEFAULT_CABLE,
  buildArbor,
  distalPoints,
  distalPointsSchema,
  distalSynapses,
  orientPlacement,
  parseFocus,
  pointOnArbor,
  projectSynapses,
  resolveRoot,
  rootChoiceOf,
} from '../lib/arborOps'
import { DAYLIGHT_PASSES, SUBWAY_DEFAULTS } from '../lib/arborLayout'
import {
  datasetRequest,
  neuronSchemaOf,
  requireDataset,
  schemasFromType,
  sourceSupports,
} from '../lib/datasetParam'
import { SEQUENTIAL_PALETTE_OPTIONS } from '../lib/heatmapParams'
import { rowsWithIds } from '../lib/tableOps'
import { namesPartners, sitesFrom } from '../lib/topologyOps'

/** Synapse columns the colour picker leaves out: the drawn neuron's own, or offered already. */
const OWN_NEURON_COLUMNS = new Set(['neuronId', 'type', 'polarity', 'partnerType'])

/** No point clicked: an empty cloud, with the synapse columns the port promises. */
const EMPTY_POINTS: PointsValue = {
  kind: 'points',
  positions: new Float32Array(0),
  attributes: makeTable(distalPointsSchema({ columns: [] }), {
    distanceFromPoint: [],
    distanceFromRoot: [],
  }),
  bounds: EMPTY_BOUNDS,
}

export const NEURON_DENDROGRAM = 'out.neuronDendrogram'

/**
 * The branch ramps. Coda red first and default: blue is what the card spends on lit partners and
 * the clicked subtree. The rest are the Heatmap's sequential ramps, transcribed and validated there.
 */
export const BRANCH_PALETTE_OPTIONS = [
  { value: 'red', label: 'Coda red' },
  ...SEQUENTIAL_PALETTE_OPTIONS,
] as const

/** A presentational control the card draws itself, which the inspector still lists. */
const SHOWN = { presentational: true, advanced: true } as const

/** The same, for one nothing should advertise — a pager, a clicked point, a tab. */
const OWN = { ...SHOWN, internal: true } as const

registerNode({
  type: NEURON_DENDROGRAM,
  label: 'Neuron Dendrogram',
  category: 'visualisation',
  description:
    'Draw one neuron flat — as a dendrogram, radially, navis’s subway layout or unrooted — with its synapses on it, against geodesic or electrotonic distance. Click a point to list the inputs and outputs distal to it; Run puts those synapses on the Points output.',
  guide:
    'Lays out one neuron’s arbour in the plane, with distance from the root on a real axis — ' +
    'geodesic, or electrotonic from the skeleton’s radii — and marks every synapse on it. Click ' +
    'a branch point to list the inputs and outputs beyond it and how far out they sit. ' +
    'Electrotonic distance needs a radius on every node, which CATMAID skeletons lack.',
  cost: 'expensive',
  dataCache: true,
  defaultSize: { width: 760, height: 560 },
  /*
   * The card draws every control it has — a layout and distance switch over the stage, a partner
   * list, the distal summary and a settings tab in the rail — so the generic rail would be each
   * of them a second time. Topology's call, for Topology's reason.
   */
  ownControls: true,
  inputs: [
    { id: 'dataset', label: 'Dataset', type: T.dataset() },
    // `table` rather than `neurons`, on Profile's reasoning: what is needed is a `neuronId`
    // column, which `validate` reports with the columns the table does have.
    { id: 'neurons', label: 'Neurons', type: T.table() },
    /*
     * Partners to light before anyone clicks: a Connectivity → Filter chain can say "these", and
     * the card shows where they synapse. Their ids are read in the card's grouping, so a wired set
     * of neurons lights their types when the list is grouped by type. It only *seeds* the lit set:
     * once somebody toggles a partner in the list, the card's own choice stands.
     */
    { id: 'partners', label: 'Partners', type: T.table(), required: false },
  ],
  outputs: [
    { id: 'out', label: 'Neurons', type: T.table() },
    { id: 'current', label: 'Current', type: T.neurons() },
    /*
     * The synapses beyond the clicked point, as the Distal tab lists them — on neuPrint one row per
     * connection, since that is the cloud that names partners there. Empty until a point is
     * clicked and the graph Run.
     */
    { id: 'distal', label: 'Points', type: T.points() },
  ],
  params: [
    { id: 'page', kind: 'int', label: 'Neuron', default: 0, min: 0, ...OWN },
    {
      // `selection`, Profile's and Topology's name: the param every viewer writes, so the pin
      // travels the write-back path the UI already has.
      id: 'selection',
      kind: 'ids',
      label: 'Pinned',
      noun: 'neurons',
      help: 'The neuron the Current output emits. Set by the pin control.',
      default: [],
      advanced: true,
    },
    {
      id: 'layout',
      kind: 'enum',
      label: 'Layout',
      options: [
        { value: 'rectangular', label: 'Dendrogram' },
        { value: 'radial', label: 'Radial' },
        { value: 'subway', label: 'Subway' },
        { value: 'equalAngle', label: 'Unrooted' },
      ],
      help: 'Dendrogram puts distance on the horizontal axis; Radial makes it the radius; Subway is navis’s plot_flat layout; Unrooted draws every segment at its true length without crossings.',
      default: 'rectangular',
      ...SHOWN,
    },
    {
      id: 'metric',
      kind: 'enum',
      label: 'Distance',
      options: [
        { value: 'geodesic', label: 'Geodesic (µm)' },
        { value: 'electrotonic', label: 'Electrotonic (λ)' },
      ],
      help: 'Geodesic is cable length. Electrotonic divides each stretch of cable by its length constant, which depends on its radius and the two membrane constants.',
      default: 'geodesic',
      ...SHOWN,
    },
    {
      id: 'rm',
      kind: 'number',
      label: 'Membrane resistance',
      help: 'Specific membrane resistance, Ω·cm². The default is Gouwens & Wilson (2009), fitted to Drosophila projection neurons.',
      default: DEFAULT_CABLE.rm,
      min: 1,
      step: 100,
      ...SHOWN,
      visibleIf: (params) => params['metric'] === 'electrotonic',
    },
    {
      id: 'ri',
      kind: 'number',
      label: 'Axial resistivity',
      help: 'Axial (cytoplasmic) resistivity, Ω·cm. The default is Gouwens & Wilson (2009).',
      default: DEFAULT_CABLE.ri,
      min: 1,
      step: 1,
      ...SHOWN,
      visibleIf: (params) => params['metric'] === 'electrotonic',
    },
    {
      id: 'root',
      kind: 'enum',
      label: 'Root',
      options: [
        { value: 'soma', label: 'Soma' },
        { value: 'source', label: 'As delivered' },
        { value: 'picked', label: 'Picked point' },
      ],
      help: 'Where distance is measured from. Soma falls back to the delivered root where the source labels none, and the card says so.',
      default: 'soma',
      // Data: what is "beyond" a point depends on which way is out. See the header.
      advanced: true,
    },
    // The node a reader picked with "Make root". A skeleton index, so it is clamped on read.
    {
      id: 'rootNode',
      kind: 'int',
      label: 'Root node',
      default: -1,
      advanced: true,
      internal: true,
    },
    {
      id: 'order',
      kind: 'enum',
      label: 'Branch order',
      options: [
        { value: 'balanced', label: 'Balanced' },
        { value: 'ladder', label: 'Longest first' },
      ],
      help: 'How the dendrogram and radial layouts order a branch point’s children. Balanced keeps the main trunk near the middle; longest-first runs it to one edge.',
      default: 'balanced',
      ...SHOWN,
    },
    {
      id: 'minTwig',
      kind: 'number',
      label: 'Hide twigs under',
      help: 'Leave out end branches shorter than this many µm of cable. Only the drawing changes: distances and the distal summary still count every branch.',
      default: 0,
      min: 0,
      step: 0.5,
      ...SHOWN,
    },
    {
      id: 'angleChange',
      kind: 'number',
      label: 'Branch angle',
      help: 'Subway layout: the angle a branch leaves its parent path at, in degrees. navis’s angle_change.',
      default: SUBWAY_DEFAULTS.angleChange,
      min: 0,
      max: 90,
      step: 5,
      ...SHOWN,
      visibleIf: (params) => params['layout'] === 'subway',
    },
    {
      id: 'angleDecrease',
      kind: 'number',
      label: 'Angle decrease',
      help: 'Subway layout: how much the branch angle shrinks per branch point above it. navis’s angle_decrease.',
      default: SUBWAY_DEFAULTS.angleDecrease,
      min: 0,
      max: 45,
      step: 1,
      ...SHOWN,
      visibleIf: (params) => params['layout'] === 'subway',
    },
    {
      id: 'daylight',
      kind: 'int',
      label: 'Daylight passes',
      help: 'Unrooted layout: how many times to even out the gaps between branches. Each pass rotates whole branches and never changes a length.',
      default: DAYLIGHT_PASSES,
      min: 0,
      max: 5,
      ...SHOWN,
      visibleIf: (params) => params['layout'] === 'equalAngle',
    },
    {
      id: 'colorBy',
      kind: 'enum',
      label: 'Colour synapses by',
      /*
       * Polarity, the partner's type, or any other column the dataset's synapse rows carry. Lit
       * partners override all of them, Topology's rule: what somebody picked in the list is what the
       * picture shows.
       *
       * `Partner type` is offered whatever the schema says, because the card resolves it itself —
       * through the connectivity tables where the rows carry only a partner id (CAVE), and by asking
       * for the partner-resolved rows where they carry neither (neuPrint). `neuronId` and `type` are
       * left out: they describe the neuron being drawn, so on one card every synapse has the same
       * value and every tick the same colour, which is what offering `type` looked like.
       */
      options: (ctx) => [
        { value: 'polarity', label: 'Input / output' },
        { value: 'partnerType', label: 'Partner type' },
        ...schemasFromType(ctx.inputs.dataset)
          .synapses.columns.filter((c) => !OWN_NEURON_COLUMNS.has(c.name))
          .map((c) => ({ value: c.name, label: c.name })),
      ],
      default: 'polarity',
      ...SHOWN,
    },
    {
      id: 'branchColor',
      kind: 'enum',
      label: 'Colour branches by',
      options: [
        { value: 'flat', label: 'Nothing (one colour)' },
        { value: 'strahler', label: 'Strahler order' },
        { value: 'flow', label: 'Synapse flow centrality' },
        { value: 'distance', label: 'Distance to root' },
      ],
      help: 'Strahler order and flow centrality are computed on the tree as rooted here, so they follow the Root setting. Flow centrality is navis’s, summing both directions.',
      default: 'flat',
      ...SHOWN,
    },
    {
      id: 'branchPalette',
      kind: 'enum',
      label: 'Branch palette',
      options: [...BRANCH_PALETTE_OPTIONS],
      help: 'The colour ramp for Colour branches by.',
      default: 'red',
      ...SHOWN,
      visibleIf: (params) => params['branchColor'] !== 'flat',
    },
    {
      id: 'widthBy',
      kind: 'enum',
      label: 'Branch width',
      options: [
        { value: 'uniform', label: 'Uniform' },
        { value: 'radius', label: 'By radius' },
      ],
      help: 'By radius draws each stretch of cable as wide as its radius, scaled so the 95th-percentile radius is twice the line width. A skeleton without radii is drawn uniform.',
      default: 'uniform',
      ...SHOWN,
    },
    {
      id: 'lineWidth',
      kind: 'number',
      label: 'Line width',
      help: 'Branch line width, in screen pixels.',
      default: 1.2,
      min: 0.25,
      max: 8,
      step: 0.25,
      ...SHOWN,
    },
    {
      id: 'synapseSize',
      kind: 'number',
      label: 'Synapse size',
      help: 'Length of a synapse tick, in screen pixels.',
      default: 5,
      min: 1,
      max: 24,
      step: 1,
      ...SHOWN,
    },
    {
      /*
       * Topology's `dimOpacity` at a different default: a tick here is a short line on a dark
       * surface, not a dot in a cloud whose alpha accumulates, and at 0.25 the unlit ones
       * disappeared outright in a real browser.
       */
      id: 'unlitOpacity',
      kind: 'number',
      label: 'Unlit synapses',
      help: 'How visible the other synapses stay while partners are lit. 0 hides them.',
      default: 0.4,
      min: 0,
      max: 1,
      step: 0.05,
      ...SHOWN,
    },
    {
      id: 'partners',
      kind: 'ids',
      label: 'Lit partners',
      noun: 'partners',
      default: [],
      ...OWN,
    },
    {
      /*
       * Set on the first toggle in the partner list. The Partners port only seeds the lit set until
       * then: once somebody has chosen, an empty list is their choice, and seeding again would put
       * back the partner they had just unlit.
       */
      id: 'partnersChosen',
      kind: 'boolean',
      label: 'Lit partners chosen',
      default: false,
      ...OWN,
    },
    {
      id: 'grouping',
      kind: 'enum',
      label: 'Group partners',
      options: [
        { value: 'type', label: 'Cell type' },
        { value: 'typed', label: 'Cell type, untyped apart' },
        { value: 'neuron', label: 'One row per neuron' },
      ],
      default: 'type',
      ...OWN,
    },
    {
      id: 'direction',
      kind: 'enum',
      label: 'Partners',
      options: [
        { value: 'inputs', label: 'Inputs' },
        { value: 'outputs', label: 'Outputs' },
      ],
      default: 'inputs',
      ...OWN,
    },
    { id: 'partnerQuery', kind: 'string', label: 'Partner filter', default: '', ...OWN },
    {
      /*
       * Data, for the Points port: `neuronId:node:t` (`writeFocus`). Text rather than numbers so
       * one gesture is one write and one undo; the neuron rides along so paging the card does not
       * move what the port carries.
       */
      id: 'focus',
      kind: 'string',
      label: 'Clicked point',
      default: '',
      advanced: true,
      internal: true,
    },
    { id: 'tab', kind: 'string', label: 'Tab', default: 'partners', ...OWN },
    { id: 'railOpen', kind: 'boolean', label: 'Data rail', default: true, ...OWN },
  ],

  inferOutputs: (ctx) => {
    const input = ctx.inputs.neurons
    return {
      // Passed through as whatever came in, so this between two nodes does not downgrade a
      // Neurons edge into a Table one.
      out: input?.kind === 'neurons' ? T.neurons(schemaOf(input)) : T.table(schemaOf(input)),
      current: T.neurons(neuronSchemaOf(ctx.inputs)),
      distal: T.points(distalPointsSchema(schemasFromType(ctx.inputs.dataset).synapses)),
    }
  },

  validate: (ctx) => {
    const problems: string[] = []
    for (const [port, label] of [
      ['neurons', 'Neurons'],
      ['partners', 'Partners'],
    ] as const) {
      const input = ctx.inputs[port]
      // Only when the schema is known: an unknown one may well have a neuronId.
      if (!isTabular(input) || !input.schema) continue
      const names = columnNames(input.schema)
      if (!names.includes('neuronId')) {
        problems.push(
          `The ${label} input needs a "neuronId" column. This table has: ` +
            `${names.length ? names.join(', ') : '(no columns)'}`,
        )
      }
    }
    if (ctx.inputs.dataset && !sourceSupports(ctx.inputs.dataset, 'skeletons')) {
      problems.push('This dataset has no skeletons')
    }
    if (
      ctx.params.focus &&
      ctx.inputs.dataset &&
      !sourceSupports(ctx.inputs.dataset, 'synapses')
    ) {
      problems.push('This dataset has no synapse locations, so the Points output stays empty')
    }
    return problems
  },

  evaluate: async (ctx) => {
    const table = ctx.input('neurons')
    if (!isTableValue(table)) throw new Error('Neurons input is not a table')
    const passed = { out: table, current: rowsWithIds(table, ctx.params.selection) }

    const focus = parseFocus(String(ctx.params.focus))
    if (!focus) return { ...passed, distal: EMPTY_POINTS }
    const dataset = requireDataset(ctx.input('dataset'))
    const source = ctx.resolveSource(dataset.sourceId)
    if (!source.fetchSkeletons) throw new Error(`${source.label} does not provide skeletons`)
    if (!source.fetchSynapses)
      throw new Error(`${source.label} does not provide synapse locations`)
    const { neuronId, point: clicked } = focus
    const neuronIds = [neuronId]
    const units = synapseUnitsOf(source)
    if (!units) throw new Error(`${source.label} does not say what its synapse rows count.`)
    const unit = resolveSynapseUnit(source.label, undefined, units)

    /*
     * The two halves are independent and both slow, so they run together, Topology's arrangement,
     * under one signal: whichever fails first stops the other, rather than a failed synapse query
     * waiting on a skeleton fetch and a heal nobody will read (`bigclust.ts`' pattern).
     */
    const failed = new AbortController()
    const signal = AbortSignal.any([ctx.signal, failed.signal])

    // The cloud that names partners: the site cloud where it does, the link cloud on neuPrint.
    const synapsesFor = async () => {
      const sites = await source.fetchSynapses!({
        ...datasetRequest(dataset),
        neuronIds,
        unit,
        onWarn: ctx.warn,
        signal,
      })
      return namesPartners(sites.attributes.schema) ||
        !canFetchSynapseLinks(source, dataset.datasetId)
        ? sites
        : source.fetchSynapseLinks!({ ...datasetRequest(dataset), neuronIds, signal })
    }

    // The arbour exactly as the card built it: the same skeleton, healed the same way, rooted the
    // same way — or "beyond the clicked point" would mean something else here than on screen.
    const arbourAtPoint = async () => {
      const skeletons = await source.fetchSkeletons!({
        ...datasetRequest(dataset),
        neuronIds,
        onWarn: ctx.warn,
        ...(ctx.refresh ? { refresh: true } : {}),
        onFetched: ctx.reportFetched,
        signal,
      })
      const raw = skeletons.items[0]
      if (!raw) throw new Error(`${source.label} returned no skeleton for neuron ${neuronId}`)
      ctx.progress(0.3, 'arbour')
      const { skeleton, bridges } = await healSkeleton(raw, signal)
      const rooted = resolveRoot(
        skeleton,
        rootChoiceOf(String(ctx.params.root), Number(ctx.params.rootNode)),
      )
      const arbor = buildArbor(skeleton, rooted.node, bridges)
      const point = pointOnArbor(arbor, clicked)
      if (!point) {
        throw new Error(
          `The clicked point is no longer on neuron ${neuronId}'s skeleton. Click it again.`,
        )
      }
      return { skeleton, arbor, point }
    }

    ctx.progress(0.05, 'skeleton and synapses')
    const [cloud, { skeleton, arbor, point }] = await Promise.all([
      synapsesFor(),
      arbourAtPoint(),
    ]).catch((error: unknown) => {
      failed.abort()
      throw error
    })

    ctx.progress(0.8, 'placing synapses')
    const placement = orientPlacement(arbor, projectSynapses(skeleton, sitesFrom(cloud)))
    const distal = distalSynapses(arbor, placement, arbor.geodesic, point)
    return { ...passed, distal: distalPoints(cloud, arbor, placement, distal) }
  },
})
