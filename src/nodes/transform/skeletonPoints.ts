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
import { NM_PER_UM } from '../lib/nblastOps'
import type { Placement } from '../lib/skeletonPoints'
import {
  checkPointsSize,
  pointCount,
  skeletonPointsSchema,
  skeletonPointsValue,
} from '../lib/skeletonPoints'
import { checkGeometryUnits } from '../lib/transformOps'

registerNode({
  type: 'neuron.skeletonPoints',
  label: 'Skeleton to Points',
  category: 'transform',
  description:
    'Turn skeletons into a point cloud, one point per piece of cable, with `neuronId`, `compartment`, `cable`, `radius`, `strahler` and `rootDistance` per point.',
  guide:
    'Cuts each skeleton into pieces of at most Spacing µm along the cable and puts a point at the middle of each, so the cloud can go wherever points go: Cortical Depth and Laminar Profile for where an arbour sits in the cortex, Points in Volumes for how much of it is in each region. Every point says how much cable it stands for in `cable`, which sums back to the cable length exactly; counting rows is only as even as Spacing is fine, since a twig shorter than Spacing still gets a point. The compartment is the source’s own label — CAVE skeleton-service and SWC skeletons carry one, neuPrint, CATMAID and level-2 skeletons do not.',
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
      ],
      help: '"Even pieces" cuts every unbranched run into equal pieces no longer than Spacing, one point each, so a row count stands for cable. "One per node" keeps the skeleton’s own nodes, whose spacing is however finely it was traced; `cable` then gives each node half of each edge it touches.',
    },
    {
      id: 'spacing',
      kind: 'number',
      label: 'Spacing (µm)',
      default: 1,
      min: 0.01,
      step: 0.5,
      visibleIf: (params) => params.placement === 'resample',
      help: 'The most cable one point stands for. Pieces never straddle a branch point, so each run is cut into equal pieces of at most this length.',
    },
    {
      id: 'carry',
      kind: 'columns',
      label: 'Carry fields',
      from: 'in',
      excludeIds: true,
      optional: true,
      default: [],
      help: 'Columns of the skeletons’ own attribute table — a cell type, a status — to copy onto every point of that neuron. A column named like one this node adds is replaced by it.',
    },
  ],

  inferOutputs: (ctx) => ({
    out: T.points(skeletonPointsSchema(ctx.attributes('in'), ctx.columns('carry'))),
  }),

  evaluate: async (ctx) => {
    const skeletons = ctx.input('in')
    if (!isSkeletonsValue(skeletons)) {
      throw new Error(
        'Wire skeletons — the Skeletons node, or anything handing them on — to Skeletons.',
      )
    }
    checkGeometryUnits(
      'The',
      skeletons,
      'skeletons',
      'Skeletons',
      'a spacing in µm means nothing on them and no cable length can be read off them.',
    )
    const placement = ctx.params.placement as Placement
    const spacingUm = Number(ctx.params.spacing)
    const spacingNm = spacingUm * NM_PER_UM
    if (placement === 'resample' && !(spacingNm > 0)) {
      throw new Error('Spacing must be more than 0 µm.')
    }

    const schema = skeletonPointsSchema(skeletons.attributes.schema, ctx.columns('carry'))
    const items = skeletons.items
    // Under `resample` counting builds each skeleton's run lengths, so it is sliced as the writing is.
    const counts = new Array<number>(items.length)
    const half = (from: number) => ({
      signal: ctx.signal,
      progress: (fraction: number) => ctx.progress(from + fraction / 2),
    })
    await sliced(items.length, half(0), (i) => {
      counts[i] = pointCount(items[i]!, placement, spacingNm)
    })
    const total = counts.reduce((a, b) => a + b, 0)
    const what =
      ` from ${items.length.toLocaleString()} skeletons` +
      (placement === 'resample' ? ` at ${spacingUm.toLocaleString()} µm` : '')
    checkPointsSize(ctx, total, schema.columns.length, what)

    const unlabelled = items.filter((s) => !s.compartments).length
    if (unlabelled > 0) {
      ctx.warn(
        `${unlabelled.toLocaleString()} of ${items.length.toLocaleString()} skeletons carry no compartment labels, so \`compartment\` is empty on their points. The source publishes none for them — CAVE skeleton-service and SWC skeletons are the ones that do.`,
      )
    }
    const empty = counts.filter((n) => n === 0).length
    if (empty > 0) {
      ctx.warn(
        `${empty.toLocaleString()} of ${items.length.toLocaleString()} skeletons have no cable to cut — a single node, or none — and gave no points.`,
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
      ),
    }
  },
})
