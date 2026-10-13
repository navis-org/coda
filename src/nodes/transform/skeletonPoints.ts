/**
 * Skeleton to Points: a skeleton's cable as a point cloud, so a question asked of points — which
 * layer, which region, how deep — can be asked of an arbour.
 *
 * The op and its reasoning are `lib/skeletonPoints.ts`. What belongs here is the card.
 *
 * **`cheap`, because it is arithmetic on geometry already in memory** — two walks per skeleton, no
 * fetch and no Python — and so a Spacing edit redraws without a Run. Both walks are inside `sliced`,
 * so a set of a thousand neurons stays cancellable.
 */

import { registerNode } from '../../core/registry'
import { sliced } from '../../core/slice'
import { T } from '../../core/types'
import { isSkeletonsValue } from '../../core/values'
import { NM_PER_UM } from '../../data/units'
import { SNAP_NM } from '../lib/anchors'
import type { ManualPoint, OnEdge, Placement } from '../lib/skeletonPoints'
import { plural } from '../../style/format'
import {
  MANUAL_PARAM,
  checkPointsSize,
  placeManual,
  pointCount,
  readManualPoints,
  skeletonPointsSchema,
  skeletonPointsValue,
} from '../lib/skeletonPoints'
import { checkGeometryUnits } from '../../data/units'

registerNode({
  type: 'neuron.skeletonPoints',
  label: 'Skeleton to Points',
  category: 'transform',
  description:
    'Turn skeletons into a point cloud, one point per piece of cable, per skeleton node or wherever you place one by hand, with `neuronId`, `compartment`, `cable`, `radius`, `strahler` and `rootDistance` per point, and a `name` for each placed by hand.',
  guide:
    'Cuts each skeleton into pieces of at most Spacing µm and puts a point in the middle of ' +
    'each, for Cortical Depth, Laminar Profile or Points in Volumes. The `cable` column is ' +
    'the cable each point stands for and sums to the total cable length. `compartment` comes ' +
    'from the source: CAVE skeleton-service and SWC skeletons have one; neuPrint, CATMAID and ' +
    'level-2 skeletons do not. "placed by hand" takes points clicked onto each neuron in the ' +
    'expanded view instead — record sites for Simulate, say, or synapses of your own for a ' +
    'Compartment Model.',
  cost: 'cheap',
  inputs: [{ id: 'in', label: 'Skeletons', type: T.skeletons() }],
  outputs: [{ id: 'out', label: 'Points', type: T.points() }],
  params: [
    {
      id: 'placement',
      kind: 'enum',
      label: 'Points',
      default: 'resample',
      options: [
        { value: 'resample', label: 'even pieces of cable' },
        { value: 'nodes', label: 'one per skeleton node' },
        { value: 'manual', label: 'placed by hand' },
      ],
      help: '"even pieces of cable" places a point every `Spacing (µm)`, so each point stands for the same length of cable. "one per skeleton node" uses the skeleton’s own nodes, and `cable` gives each half of its edges. "placed by hand" is the points you click onto each neuron’s dendrogram in the expanded view (⤢); they stand for no cable, so `cable` is empty.',
    },
    {
      id: MANUAL_PARAM,
      kind: 'ids',
      label: 'Points',
      noun: 'points',
      default: [],
      visibleIf: (params) => params.placement === 'manual',
      help: 'The points placed by hand, each kept as a position on its neuron, with a name if you give it one (the `name` column). Place, name and remove them in the expanded view (⤢).',
    },
    {
      id: 'spacing',
      kind: 'number',
      label: 'Spacing (µm)',
      default: 1,
      min: 0.01,
      step: 0.5,
      visibleIf: (params) => params.placement === 'resample',
      help: 'The most cable one point stands for. Pieces never cross a branch point.',
    },
    {
      id: 'carry',
      kind: 'columns',
      label: 'Carry fields',
      from: 'in',
      excludeIds: true,
      optional: true,
      default: [],
      help: 'Columns of the skeletons’ attributes, e.g. cell type, to copy onto every point of that neuron. Columns this node adds replace carried ones of the same name.',
    },
  ],

  // Placed by hand with nothing placed yet: an empty cloud, and the card says where the placing is.
  validate: (ctx) =>
    ctx.params.placement === 'manual' && readManualPoints(ctx.params[MANUAL_PARAM]).length === 0
      ? ['Expand the node (⤢) to place points on the skeletons.']
      : [],

  inferOutputs: (ctx) => ({
    out: T.points(
      skeletonPointsSchema(
        ctx.attributes('in'),
        ctx.columns('carry'),
        ctx.params.placement as Placement,
      ),
    ),
  }),

  evaluate: async (ctx) => {
    const skeletons = ctx.input('in')
    if (!isSkeletonsValue(skeletons)) {
      throw new Error(
        'Nothing is wired into `Skeletons`. Wire in skeletons, e.g. from the Skeletons node.',
      )
    }
    checkGeometryUnits(
      'The',
      skeletons,
      'skeletons',
      'Skeletons',
      'a spacing in µm cannot be applied and no cable length can be measured.',
    )
    const placement = ctx.params.placement as Placement
    const manual = placement === 'manual'
    const spacingUm = Number(ctx.params.spacing)
    const spacingNm = spacingUm * NM_PER_UM
    if (placement === 'resample' && !(spacingNm > 0)) {
      throw new Error('`Spacing (µm)` must be more than 0.')
    }

    const schema = skeletonPointsSchema(
      skeletons.attributes.schema,
      ctx.columns('carry'),
      placement,
    )
    const items = skeletons.items
    // Under `resample` counting builds each skeleton's run lengths, so it is sliced as the writing is.
    const counts = new Array<number>(items.length)
    const half = (from: number) => ({
      signal: ctx.signal,
      progress: (fraction: number) => ctx.progress(from + fraction / 2),
    })
    // Under `manual`, each neuron's stored points placed on its skeleton; the count is what landed.
    const byNeuron = new Map<string, ManualPoint[]>()
    if (manual) {
      for (const point of readManualPoints(ctx.params[MANUAL_PARAM])) {
        const list = byNeuron.get(point.neuron)
        if (list) list.push(point)
        else byNeuron.set(point.neuron, [point])
      }
    }
    const placed: OnEdge[][] = []
    let stale = 0
    await sliced(items.length, half(0), (i) => {
      const skeleton = items[i]!
      if (placement !== 'manual') {
        counts[i] = pointCount(skeleton, placement, spacingNm)
        return
      }
      const landed = placeManual(skeleton, byNeuron.get(skeleton.id) ?? [])
      placed[i] = landed.placed
      counts[i] = landed.placed.length
      stale += landed.stale
    })
    // A neuron no longer wired is not stale: its points wait for it, as a split's corrections do.
    if (stale > 0) {
      ctx.warn(
        `${plural(stale, 'point')} placed by hand no longer ${stale === 1 ? 'lands' : 'land'} on its neuron — more than ${SNAP_NM / NM_PER_UM} µm from its cable, so the skeleton has changed. They are kept; remove them in the expanded view.`,
      )
    }
    const total = counts.reduce((a, b) => a + b, 0)
    const what =
      ` from ${items.length.toLocaleString()} skeletons` +
      (placement === 'resample' ? ` at ${spacingUm.toLocaleString()} µm` : '')
    checkPointsSize(ctx, total, schema.columns.length, what)

    const unlabelled = items.filter((s) => !s.compartments).length
    if (unlabelled > 0) {
      ctx.warn(
        `${unlabelled.toLocaleString()} of ${items.length.toLocaleString()} skeletons have no compartment labels, so \`compartment\` is empty on their points. The source does not publish compartments for them; CAVE skeleton-service and SWC skeletons do.`,
      )
    }
    const empty = manual ? 0 : counts.filter((n) => n === 0).length
    if (empty > 0) {
      ctx.warn(
        `${empty.toLocaleString()} of ${items.length.toLocaleString()} skeletons have no cable to cut (a single node, or none) and gave no points.`,
      )
    }

    return {
      out: await skeletonPointsValue(
        skeletons,
        counts,
        placement,
        spacingNm,
        schema,
        half(0.5),
        placed,
      ),
    }
  },
})
