/**
 * Neuron Topology: what the arbour itself measures, and where a partner lands on it.
 *
 * Neuron Profile's sibling one level down. Profile reports what the *dataset* already knows —
 * classification, partner counts, region breakdown, all of it published. This one measures the
 * geometry: cable, branch points, Strahler order, tortuosity, and the axon/dendrite split. The
 * two are not variants of each other, and the give-away is what they fetch: Profile issues three
 * small connectivity queries, this pulls skeletons.
 *
 * ## `expensive`, with a live widget — Explore Dataset's split, not Profile's
 *
 * Profile is `cheap` because its `evaluate` touches no network at all: it passes the table
 * through and slices out the pinned row, and every fetch belongs to the widget. That is not
 * available here, because the whole point is a `Morphometrics` port, and measuring a neuron means
 * having its skeleton. Invariant 6 then settles it: a `cheap` node that fetches fires a request
 * per keystroke at a shared server.
 *
 * So this is `expensive` and the widget is live, which is exactly what `out.explore` does. The
 * consequence worth knowing is that the two halves can disagree in one direction and only one:
 * the card draws the neuron you are looking at the moment its skeleton lands, while the ports
 * stay honestly stale until Run. Paging, highlighting a partner and re-colouring are all free and
 * invalidate nothing.
 *
 * ## The split is the only thing here that needs Python
 *
 * Everything on the Morphology tab is a tree walk in `nodes/lib/topologyOps.ts` — exact, instant,
 * no download. The axon/dendrite split goes to `pyodide/topology.ts`, because matching navis's
 * synapse flow centrality is what makes the number citable and a re-derivation would be Coda's
 * answer rather than navis's. `pnpm probe:split` runs both and asserts they agree node for node.
 *
 * That is why `Split axon/dendrite` is a param and defaults **off**. It is the one control here
 * that costs a ~10 MB first-use download (see [docs/python-pyodide.md](../../../docs/python-pyodide.md)),
 * and a node whose first Run always paid it would be a node nobody drops on a canvas to look at a
 * cable length. It is also, unlike everything else on the card, **data**: it adds columns to
 * `Morphometrics`, so it sits in the provenance key and marks the graph stale — the same
 * Order/Colour line the Heatmap draws.
 */

import { registerNode } from '../../core/registry'
import type { TableSchema } from '../../core/types'
import { T, columnNames, isTabular, schemaOf } from '../../core/types'
import type { PointsValue } from '../../core/values'
import { isSkeletonsValue, isTableValue } from '../../core/values'
import { resolveSynapseUnit } from '../../data/synapseUnits'
import { synapseUnitsOf } from '../../data/source'
import { asSkeletonRoute } from '../../data/skeletonRoutes'
import {
  datasetRequest,
  requireDataset,
  schemasFromType,
  sourceSupports,
} from '../lib/datasetParam'
import { warnAboveParam } from '../lib/limitParams'
import {
  SKELETON_SOURCE_PARAM,
  skeletonSourceParam,
  skeletonSourceProblem,
} from '../lib/skeletonParams'
import {
  SYNAPSE_UNIT_PARAM,
  pinnedSynapseUnit,
  synapseUnitParam,
  synapseUnitProblem,
} from '../lib/synapseParams'
import { MAX_NEURONS, neuronIdsFrom } from '../query/morphology'
import { UNIDENTIFIED, groupSynapses } from '../lib/synblastOps'
import { rowsWithIds } from '../lib/tableOps'
import type { TopologyRow } from '../lib/topologyOps'
import {
  assignSynapses,
  compartmentStats,
  flattenForSplit,
  morphometrics,
  parentDistances,
  polarityColumn,
  siteAt,
  topologySchema,
  topologyTable,
} from '../lib/topologyOps'
import type { SynapseSite } from '../lib/topologyOps'
import { runSplitCompartments, splitStatusOf } from '../../pyodide/topology'

/** Whether the split is on, read once — three places ask and they must agree. */
function splitting(params: Record<string, unknown>): boolean {
  return params['split'] === true
}

/**
 * The incoming table's own schema first, then the dataset's.
 *
 * `profileSchema`'s rule and for its reason: a table that has been through Select carries fewer
 * columns than the dataset publishes, and advertising the dataset's full set would promise
 * fields the card then draws as blanks.
 */
function neuronSchema(ctx: { inputs: { neurons?: unknown; dataset?: unknown } }): TableSchema {
  return (
    schemaOf(ctx.inputs.neurons as never) ??
    schemasFromType(ctx.inputs.dataset as never).neurons
  )
}

export const topologyNode = registerNode({
  type: 'out.topology',
  label: 'Neuron Topology',
  category: 'visualisation',
  description: 'Measure one neuron’s arbour and see where its partners synapse onto it.',
  guide:
    'Morphometrics for the neurons you feed it — cable length, branch points, Strahler order, ' +
    'tortuosity — beside a 3D view of the cell, and a partner list that lights up exactly where ' +
    'a chosen partner synapses onto the arbour. Turning on Split axon/dendrite runs navis’s ' +
    'synapse flow centrality and adds per-compartment columns, which is the one control here ' +
    'that costs a download and marks the graph stale; everything else you can touch is free.',
  cost: 'expensive',
  /*
   * Wide rather than tall. The card is the Stage layout — the 3D view *is* the surface, with the
   * data rail folded over it — so the width buys picture rather than rows, and a neuron is
   * usually wider than it is tall once its axon is in frame.
   */
  defaultSize: { width: 720, height: 560 },
  dataCache: true,
  /*
   * The card is a control surface, not a picture with knobs above it: a pager in the identity
   * bar, a layer toolbar and a colour select over the stage, and three tabs of sliders in the
   * rail. Every one of its seventeen presentational params is drawn by one of those, so the
   * generic rail `ViewerSurface` builds was the same seventeen controls a second time, in the
   * header of the expanded card. See `NodeDefinition.ownControls`.
   */
  ownControls: true,
  inputs: [
    { id: 'dataset', label: 'Dataset', type: T.dataset() },
    // `table` rather than `neurons`, on Profile's reasoning: `neurons` is a subtype so both
    // connect, and what is actually needed — a `neuronId` column — is reported by `validate`
    // with the columns the table does have, which is far easier to act on than a refused link.
    { id: 'neurons', label: 'Neurons', type: T.table() },
  ],
  outputs: [
    { id: 'out', label: 'Neurons', type: T.table() },
    { id: 'current', label: 'Current', type: T.neurons() },
    { id: 'morphometrics', label: 'Morphometrics', type: T.table() },
  ],
  params: [
    {
      id: 'split',
      kind: 'boolean',
      label: 'Split axon/dendrite',
      help:
        'Run navis’s synapse flow centrality and label every node axon, dendrite or linker. ' +
        'Adds per-compartment columns to Morphometrics, so it marks the graph stale — and it ' +
        'needs the Python runtime, which is a one-off download the first time anything uses it.',
      default: false,
      /*
       * `advanced`, like every other control on this node, and for the reason the three
       * presentational ones below already record: the card *is* the viewer, and a param row above
       * it is a second copy of a control the Compartments tab already draws — with the reader's
       * eye landing on whichever is nearer rather than on the picture. This one is data where
       * those are presentation, which changes where it belongs in the inspector and not whether
       * it belongs on the card.
       */
      advanced: true,
    },
    /*
     * navis's two tuning knobs, and the pair is deliberate: between them they cover both ways a
     * split comes out wrong. `flowThresh` decides *where* the neuron is cut, `splitVal` decides
     * *which side is which*. The Compartments tab draws both as sliders, because the honest way
     * to set either is to move it and look at the arbour.
     *
     * Both stay `visibleIf` the split — which is not tidying, it is invariant 4. `normalizeParams`
     * drops a hidden param from the provenance key, so with the checkbox off these two are out of
     * the key and tuning the *live* split on the card marks nothing stale. Turn the checkbox on
     * and they enter the key, because now they decide what `Morphometrics` carries.
     */
    {
      id: 'flowThresh',
      kind: 'number',
      label: 'Linker threshold',
      help:
        'The linker is every node at or above this fraction of peak synapse flow. navis’s ' +
        'default is 0.9; lower it to cut more of the arbour away as linker, which is what ' +
        'separates a poorly segregated neuron into compartments at all.',
      default: 0.9,
      min: 0.1,
      max: 1,
      step: 0.05,
      advanced: true,
      visibleIf: (params) => params['split'] === true,
    },
    {
      /*
       * navis's `split='prepost:X'`, which its docstring documents and its signature hides — the
       * argument reads as a plain enum until you notice the colon. Worth exposing because it is
       * the knob for the failure that looks most like a bug: a neuron whose axon and dendrite
       * come out swapped, or whose linker-adjacent twigs all land on one side. Lowering it calls
       * more of the cell axon, raising it calls more of it dendrite.
       */
      id: 'splitVal',
      kind: 'number',
      label: 'Axon threshold',
      help:
        'A fragment is called axon when it holds at least this much of the neuron’s outputs ' +
        'for each unit of its inputs. navis’s default is 1 — an even share both ways; below 1 ' +
        'biases towards axon, above 1 towards dendrite.',
      default: 1,
      min: 0.1,
      max: 3,
      step: 0.05,
      advanced: true,
      visibleIf: (params) => params['split'] === true,
    },
    /*
     * Both `advanced`, which is a departure from `neuron.skeletons` and `neuron.synapses` where
     * the same two helpers are the card's only real controls and belong on it. Here the card is a
     * 3D stage with a data rail over it, and a route picker and a row-unit picker stacked above
     * that are two rows of chrome between the reader and the neuron. Spread rather than given an
     * option on the helpers, because this is one node's judgement about its own card and not a
     * new fact about what these params are.
     */
    { ...skeletonSourceParam(), advanced: true },
    { ...synapseUnitParam(), advanced: true },
    warnAboveParam({
      threshold: MAX_NEURONS,
      min: 1,
      cost: 'each skeleton is a separate request, and the split adds a synapse query on top.',
    }),
    {
      /*
       * Which neuron the widget is showing. Presentational and `internal`, exactly as Profile's
       * pager is: browsing is looking, not deciding, so it stays out of the provenance key and
       * every downstream result survives it.
       */
      id: 'page',
      kind: 'int',
      label: 'Neuron',
      help: 'Which neuron of the incoming table is shown. Browsing never invalidates anything.',
      default: 0,
      min: 0,
      presentational: true,
      advanced: true,
      internal: true,
    },
    {
      // Named `selection` for the reason Profile records: it is the param every viewer writes,
      // so it travels the write-back path the UI already has and reads the same way everywhere.
      id: 'selection',
      kind: 'ids',
      label: 'Pinned',
      noun: 'neurons',
      help: 'The neuron the Current port emits. Written by the widget’s pin control.',
      default: [],
      // The stage's Pin button is this control; a second copy on the card is a row saying
      // "no neurons" where the picture should be.
      advanced: true,
    },
    {
      /*
       * Synapse dot diameter **in screen pixels**, which is where this card parts company with
       * `out.viewer3d` — and the departure is the point rather than an inconsistency.
       *
       * `PointCloud` draws with `sizeAttenuation` by default, so its size is nanometres of world
       * space. That is right there, where a synapse cloud is an annotation on a scene of neurons
       * and a dot that ignored distance would stop being part of the anatomy. It cannot work
       * here, because there is no nanometre value that is right twice: this shipped at `5` with a
       * help string saying "pixels" and drew every synapse at a hundredth of a pixel, and the
       * obvious repair — 250 nm, about a T-bar — is a legible dot on a 15 µm optic-lobe cell and
       * sub-pixel again on a 250 µm descending neuron. Paging between the two is the ordinary
       * gesture on this card, so the setting has to survive it.
       *
       * The cost, said plainly: a dot here has no physical size and cannot be compared with one
       * in a 3D View card. What it has instead is a constant meaning — "a synapse is here".
       */
      id: 'pointSize',
      kind: 'number',
      label: 'Synapse size',
      help:
        'Diameter of a synapse dot, in screen pixels — it stays the same size whatever the ' +
        'neuron’s extent, unlike the 3D View card’s nanometre dots.',
      default: 6,
      min: 1,
      max: 24,
      step: 1,
      presentational: true,
      advanced: true,
      group: 'Visuals',
    },
    {
      /*
       * How far back the un-lit synapses go while a partner is lit.
       *
       * A control rather than a constant because the right value depends on the cell: on a sparse
       * optic-lobe neuron 0.5 keeps useful context, and on body 10003 — 57,000 connections, of
       * which a typical partner is a few dozen — anything above about 0.2 is a grey sea the lit
       * dots disappear into. That was the reported symptom even once the *right* synapses were
       * being lit.
       *
       * **0.1, not 0.2, and the difference is that alpha accumulates.** Normal blending over k
       * overlapping dots gives `1 - (1 - a)^k`, so on a dense cloud the shipped 0.2 composited to
       * effectively solid and every value above it looked identical — the control appeared to do
       * nothing across four fifths of its range, which is what it was reported as doing. The real
       * repair is `DIM_SCALE` in `viewer3dScene.ts`, which shrinks the dim half so alpha has
       * something to work with; this default moves too because the useful band is lower than it
       * looked.
       */
      id: 'dimOpacity',
      /*
       * Named `dimOpacity` and labelled "Others" once, which said nothing at all on a tab where
       * it sits between a synapse size and a line width — "others" than *what*? The id stays,
       * because renaming it would drop the value out of every stored graph that has set it
       * (`normalizeParams` reads only declared params); the label is what a reader sees.
       */
      kind: 'number',
      label: 'Unlit synapses',
      help:
        'How visible the synapses of every other partner stay while one partner is lit. 0 hides ' +
        'them; 1 draws them as solidly as the lit ones. Does nothing until a partner is lit.',
      default: 0.1,
      min: 0,
      max: 1,
      step: 0.05,
      presentational: true,
      advanced: true,
      group: 'Visuals',
    },
    {
      /*
       * The skeleton's flat colour, as a hex the Visuals tab's picker writes.
       *
       * A free colour rather than `colorParams`' nine validated slots, which is the departure
       * worth naming: those slots exist so a *categorical* encoding cannot put two series in
       * colours that fail the colourblind gate, and this channel has one key. What somebody
       * picking a single neuron colour wants is their figure's existing convention, which is
       * `LegendKeys`' reasoning for offering the OS picker on an override.
       *
       * Black, because the arbour reads as a drawing rather than as one series among several.
       * Note it is a *literal* black, not the theme's ink: on the dark scene surface #000000 is
       * 1.2:1, so a dark-mode reader will want the picker. `#ffffff` is the other end of it.
       */
      id: 'skeletonColor',
      kind: 'string',
      label: 'Skeleton colour',
      help:
        'The colour a flat-coloured skeleton is drawn in. Compartment and Strahler colouring ' +
        'override it per node.',
      default: '#000000',
      presentational: true,
      advanced: true,
      group: 'Visuals',
    },
    {
      id: 'skeletonWidth',
      kind: 'number',
      label: 'Line width',
      help: 'Skeleton line width, in pixels.',
      default: 2,
      min: 1,
      max: 10,
      step: 0.5,
      presentational: true,
      advanced: true,
      group: 'Visuals',
    },
    {
      /*
       * Opaque by default, unlike the mesh: the arbour is the subject here, and the reason to
       * fade it is to look at something it is standing in front of — the synapse cloud inside a
       * dense branch, or the mesh shell around it.
       *
       * Both line paths honour it, which is not free: the hairline is a declarative
       * `lineBasicMaterial` and the fat one is a patched `LineMaterial` whose opacity is a shader
       * uniform written from an effect. A control that worked only above `Line width` 1 would be
       * a control that stopped working when somebody made the lines thinner.
       *
       * Unlike `Unlit synapses` this needs no size correction, and that was checked rather than
       * assumed: rendered on a 4,000-node arbour in a real browser, p95 luminance came out 245 /
       * 135 / 70 for alpha 1.0 / 0.5 / 0.2 — close to linear, because strands of a tree overlap
       * in projection far less than dots of a cloud do. See `DIM_SCALE` for the case where that
       * is not true.
       */
      id: 'skeletonOpacity',
      kind: 'number',
      label: 'Skeleton opacity',
      help:
        'How solid the skeleton is drawn. Below 1 it stops hiding what is behind it, which is ' +
        'the point — a synapse inside a thick branch, or the mesh shell around the arbour.',
      default: 1,
      min: 0,
      max: 1,
      step: 0.05,
      presentational: true,
      advanced: true,
      group: 'Visuals',
    },
    {
      id: 'colorBy',
      kind: 'enum',
      label: 'Colour by',
      options: [
        { value: 'compartment', label: 'Compartment' },
        { value: 'strahler', label: 'Strahler order' },
        { value: 'flat', label: 'Flat' },
      ],
      default: 'compartment',
      presentational: true,
      /*
       * `advanced`, and that is not tidying. The stage has this control in its own toolbar, so
       * left off `advanced` it is drawn *twice* on an on-canvas card — once as a param row and
       * once over the picture — and the two are a rename away from disagreeing about what the
       * options are called. Advanced keeps it in the inspector, where a reader looking for every
       * setting will still find it. Same call for the two layer toggles and the pin below.
       */
      advanced: true,
      group: 'Style',
    },
    {
      id: 'showSynapses',
      kind: 'boolean',
      label: 'Synapses',
      default: true,
      presentational: true,
      advanced: true,
      group: 'Style',
    },
    {
      id: 'showSkeleton',
      kind: 'boolean',
      label: 'Skeleton',
      default: true,
      presentational: true,
      advanced: true,
      group: 'Style',
    },
    {
      /*
       * The mesh layer, and the one layer toggle that is not free.
       *
       * Skeleton and synapses are already in hand — the card fetched both to measure the neuron —
       * so those two decide only what is drawn. This one decides whether a mesh is *fetched*, per
       * neuron paged to, which is why `useNeuronMesh` is gated on it and asks for a tenth of the
       * Meshes node's triangle budget. Default on because a translucent shell around the arbour
       * is what this card was drawn as from the start; off is one click and it persists.
       */
      id: 'showMesh',
      kind: 'boolean',
      label: 'Mesh',
      help:
        'Draw the neuron’s mesh as a translucent shell around the skeleton. It is fetched while ' +
        'this is on, once per neuron you page to, so turning it off is a real saving.',
      default: true,
      presentational: true,
      advanced: true,
      group: 'Style',
    },
    {
      /*
       * Very transparent by default: the mesh is context for the skeleton and the synapses, not
       * the subject. Past about 0.3 it starts swallowing the synapse cloud inside it, which is
       * the thing this card exists to show — and a closed surface is seen twice, front and back,
       * so its alpha composites with itself before anything inside it is reached.
       */
      id: 'meshOpacity',
      kind: 'number',
      label: 'Mesh opacity',
      help: 'How solid the mesh shell is. 0 is invisible; 1 hides everything inside it.',
      default: 0.05,
      min: 0,
      max: 1,
      step: 0.05,
      presentational: true,
      advanced: true,
      group: 'Visuals',
    },
    {
      /*
       * Which partners are lit, by name. A list of strings rather than `ids` because a partner
       * here is a *type* as often as a body, and the widget groups by either.
       *
       * Presentational, and that is the one judgement call in this list worth naming: lighting a
       * partner changes nothing any port carries, so marking it otherwise would make looking at
       * a second partner invalidate every downstream result. What it does cost is a connectivity
       * query, which the widget owns and caches — the same trade Profile's `minWeight` makes.
       */
      id: 'partners',
      kind: 'ids',
      label: 'Highlighted partners',
      noun: 'partners',
      help: 'Partners whose synapses are drawn on the arbour. Lighting one is free.',
      default: [],
      presentational: true,
      advanced: true,
      internal: true,
    },
    {
      /*
       * How finely the partner list rolls up. Presentational and `internal`, for `partners`'
       * reasons exactly: it changes what the rail lists and what a lit partner *means*, and
       * nothing any port carries.
       *
       * Three settings rather than two checkboxes — see `PartnerGrouping`. The default is `type`
       * because that is the question most people arrive with ("which cell types drive this
       * neuron"), and because on a dense cell the ungrouped list is fifteen thousand rows: a
       * reachable list, thanks to the filter, but not one to open on.
       */
      id: 'grouping',
      kind: 'enum',
      label: 'Group partners',
      options: [
        { value: 'type', label: 'Cell type' },
        { value: 'typed', label: 'Cell type, untyped apart' },
        { value: 'neuron', label: 'One row per neuron' },
      ],
      help:
        'How the partner list is rolled up. Cell type puts every untyped partner in one “—” ' +
        'row; the other two give those partners, or all of them, a row each keyed by id.',
      default: 'type',
      presentational: true,
      advanced: true,
      internal: true,
    },
    {
      id: 'direction',
      kind: 'enum',
      label: 'Partners',
      options: [
        { value: 'outputs', label: 'Outputs' },
        { value: 'inputs', label: 'Inputs' },
      ],
      default: 'outputs',
      presentational: true,
      advanced: true,
      internal: true,
    },
    {
      /*
       * The partner filter box. Presentational and `internal`, like `tab` and `railOpen`: it
       * decides what the rail *lists*, never what any port carries.
       *
       * A param rather than component state so it survives expanding the card to the overlay —
       * which is exactly the moment somebody who has just found a partner in a list of fifteen
       * thousand wants a bigger picture of it.
       */
      id: 'partnerQuery',
      kind: 'string',
      label: 'Partner filter',
      default: '',
      presentational: true,
      advanced: true,
      internal: true,
    },
    {
      id: 'tab',
      kind: 'string',
      label: 'Tab',
      default: 'partners',
      presentational: true,
      advanced: true,
      internal: true,
    },
    {
      /*
       * Whether the data rail is folded away over the 3D view — the Stage layout's one piece of
       * state. Stored so a dashboard cell saved showing the picture alone opens that way, which
       * is `DashboardLayout.open`'s reasoning at the scale of one card.
       */
      id: 'railOpen',
      kind: 'boolean',
      label: 'Data rail',
      default: true,
      presentational: true,
      advanced: true,
      internal: true,
    },
  ],

  inferOutputs: (ctx) => {
    const input = ctx.inputs.neurons
    return {
      // Passed through as whatever came in, so dropping this between two nodes does not
      // downgrade a Neurons edge into a Table one.
      out: input?.kind === 'neurons' ? T.neurons(schemaOf(input)) : T.table(schemaOf(input)),
      current: T.neurons(neuronSchema(ctx)),
      /*
       * Advertised at edit time, split columns included when the param is on — which is what
       * lets a downstream column picker offer `cableAxon` before anything has run. Both halves
       * read the same flag; see `topologySchema`'s note on why that is invariant 3's risk here.
       */
      morphometrics: T.table(topologySchema(splitting(ctx.params))),
    }
  },

  validate: (ctx) => {
    const problems: string[] = []
    const input = ctx.inputs.neurons
    if (isTabular(input) && input.schema) {
      const names = columnNames(input.schema)
      if (!names.includes('neuronId')) {
        problems.push(
          `Neuron Topology needs a "neuronId" column to identify a neuron. This table has: ${
            names.length ? names.join(', ') : '(no columns)'
          }`,
        )
      }
    }
    if (ctx.inputs.dataset && !sourceSupports(ctx.inputs.dataset, 'skeletons')) {
      problems.push('This dataset has no skeletons')
    }
    /*
     * Only when the split is on. Synapses are what the split is computed from, so a dataset
     * without them is a refusal for that control and not for the node — the morphometrics and
     * the 3D view are perfectly available, and a message about synapses on a card nobody asked
     * to split is a guard rail complaining about a feature that is switched off.
     */
    if (
      splitting(ctx.params) &&
      ctx.inputs.dataset &&
      !sourceSupports(ctx.inputs.dataset, 'synapses')
    ) {
      problems.push(
        'This dataset has no synapse locations, so it cannot be split into axon and dendrite',
      )
    }
    const route = skeletonSourceProblem(
      ctx.inputs.dataset,
      String(ctx.params[SKELETON_SOURCE_PARAM] ?? ''),
    )
    if (route) problems.push(route)
    if (splitting(ctx.params)) {
      const unit = synapseUnitProblem(
        ctx.inputs.dataset,
        String(ctx.params[SYNAPSE_UNIT_PARAM] ?? ''),
      )
      if (unit) problems.push(unit)
    }
    return problems
  },

  evaluate: async (ctx) => {
    const table = ctx.input('neurons')
    if (!isTableValue(table)) throw new Error('Neurons input is not a table')
    const dataset = requireDataset(ctx.input('dataset'))
    const source = ctx.resolveSource(dataset.sourceId)
    if (!source.fetchSkeletons) throw new Error(`${source.label} does not provide skeletons`)

    const withSplit = splitting(ctx.params)
    const neuronIds = neuronIdsFrom(
      ctx,
      table,
      Number(ctx.params.limit ?? MAX_NEURONS),
      'Each skeleton is a separate request, and a few thousand of them is minutes rather than seconds.',
    )

    /**
     * The synapse leg, as a closure so it can be started before the skeletons are awaited.
     *
     * Every check it needs — the method, the declared units, a pinned unit this source cannot
     * serve — happens here, so a dataset that cannot answer still fails before either fetch
     * rather than after the skeletons have been paid for.
     */
    function startSynapses(): Promise<PointsValue> {
      if (!source.fetchSynapses) {
        throw new Error(`${source.label} does not provide synapse locations`)
      }
      const units = synapseUnitsOf(source)
      if (!units) throw new Error(`${source.label} does not say what its synapse rows count.`)
      const unit = resolveSynapseUnit(source.label, pinnedSynapseUnit(ctx.params), units)
      return source.fetchSynapses({
        ...datasetRequest(dataset),
        neuronIds,
        onWarn: ctx.warn,
        unit,
        signal: ctx.signal,
      })
    }

    ctx.progress(0.02, `${neuronIds.length} neurons`)

    /*
     * The synapse query starts *before* the skeletons are awaited when the split is on.
     *
     * They are independent — both keyed only on `neuronIds`, which is settled above — and both
     * are slow in their own right: a few thousand skeletons is minutes, and a synapse cloud is a
     * multi-second query per neuron. Serialised, the run waited for the sum; started together it
     * waits for the longer. The rejection is parked with a `catch` so a skeleton failure cannot
     * surface as an unhandled rejection before this function gets to throw its own error, and the
     * real failure is re-raised at the `await` below.
     */
    const synapsesPending = withSplit ? startSynapses() : undefined
    synapsesPending?.catch(() => undefined)

    const skeletonSource = asSkeletonRoute(ctx.params[SKELETON_SOURCE_PARAM])
    const skeletons = await source.fetchSkeletons({
      ...datasetRequest(dataset),
      neuronIds,
      ...(skeletonSource ? { skeletonSource } : {}),
      onProgress: (fraction, note) =>
        ctx.progress(0.02 + fraction * (withSplit ? 0.5 : 0.9), note),
      onWarn: ctx.warn,
      ...(ctx.refresh ? { refresh: true } : {}),
      onFetched: ctx.reportFetched,
      signal: ctx.signal,
    })
    if (!isSkeletonsValue(skeletons)) throw new Error('Skeleton fetch returned no geometry')

    /*
     * One `parentDistances` per neuron, threaded through. `morphometrics`, `assignSynapses` and
     * `compartmentStats` each default that argument, so left alone the same `Math.hypot` pass
     * over every node ran three times per neuron — twice of it thrown away, across the whole set.
     */
    const distances = skeletons.items.map((item) => parentDistances(item))
    const rows: TopologyRow[] = skeletons.items.map((item) => ({
      metrics: morphometrics(item),
    }))

    if (!withSplit) {
      return {
        out: table,
        current: rowsWithIds(table, ctx.params.selection),
        morphometrics: topologyTable(rows, false),
      }
    }

    /*
     * The split's three steps, in the order the cost falls: one synapse query for the whole set,
     * a nearest-node assignment per neuron here, then one crossing of the Python bridge.
     */
    ctx.progress(0.55, 'synapses')
    const points = await synapsesPending!

    ctx.progress(0.78, 'assigning synapses to nodes')
    const byNeuron = groupSites(points)
    const assignments = skeletons.items.map((item, i) =>
      assignSynapses(item, byNeuron.get(item.id) ?? [], distances[i]),
    )

    const { parents, offsets, presynapses, postsynapses } = flattenForSplit(
      skeletons,
      assignments,
    )
    // Read before the call: `transferable` detaches every buffer the moment it is posted.
    const neuronCount = skeletons.items.length

    ctx.progress(0.82, 'splitting')
    const split = await runSplitCompartments(
      {
        parents,
        presynapses,
        postsynapses,
        offsets,
        flowThresh: Number(ctx.params.flowThresh ?? 0.9),
        splitVal: Number(ctx.params.splitVal ?? 1),
      },
      {
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        onProgress: (fraction, note) => ctx.progress(0.82 + fraction * 0.16, note),
      },
    )

    let unsplit = 0
    const withCompartments: TopologyRow[] = rows.map((row, i) => {
      const status = splitStatusOf(split.status[i])
      if (status !== 'ok') unsplit++
      const item = skeletons.items[i]!
      const from = offsets[i]!
      const to = offsets[i + 1]!
      return {
        metrics: row.metrics,
        split: compartmentStats(
          item,
          split.compartment.subarray(from, to),
          assignments[i],
          status,
          distances[i],
        ),
      }
    })

    /*
     * Said out loud rather than left in a column nobody reads. navis refuses a multi-rooted
     * neuron outright; reporting it instead is only an improvement if the count reaches the card
     * — otherwise a run that silently split three of forty neurons looks exactly like one that
     * split all forty.
     */
    if (unsplit > 0 && neuronCount > 0) {
      ctx.warn(
        `${unsplit} of ${neuronCount} neurons could not be split — see the splitStatus column. ` +
          'A fragmented reconstruction has to be healed first (Clean Skeletons ▸ Heal).',
      )
    }

    return {
      out: table,
      current: rowsWithIds(table, ctx.params.selection),
      morphometrics: topologyTable(withCompartments, true),
    }
  },
})

/**
 * Synapse sites grouped by the neuron they belong to.
 *
 * The bucketing is `groupSynapses` from `synblastOps.ts` — a cloud is one flat table with the
 * neuron in a column, and "which neuron is this row" is a question that already had one answer,
 * including the `idText` rule invariant 8 asks for. Written again here the two immediately
 * differed on unidentified rows.
 *
 * What is local is only the projection: syNBLAST wants row *indices* into the cloud it scores,
 * this wants `SynapseSite`s for the nearest-node pass. `UNIDENTIFIED` is dropped rather than
 * kept as a bucket, because the id is the join key against a skeleton and there is no skeleton
 * for a row whose neuron could not be read.
 */
function groupSites(points: PointsValue): Map<string, SynapseSite[]> {
  const polarity = polarityColumn(points)
  const out = new Map<string, SynapseSite[]>()
  for (const group of groupSynapses(points)) {
    if (group.id === UNIDENTIFIED) continue
    out.set(
      group.id,
      group.rows.map((row) => siteAt(points, row, polarity)),
    )
  }
  return out
}
