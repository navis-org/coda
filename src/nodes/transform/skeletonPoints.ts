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
    'Turn skeletons into a point cloud, one point per piece of cable or per skeleton node, with `neuronId`, `compartment`, `cable`, `radius`, `strahler` and `rootDistance` per point.',
  guide:
    'Cuts each skeleton into pieces of at most Spacing µm and puts a point in the middle of ' +
    'each, for Cortical Depth, Laminar Profile or Points in Volumes. The `cable` column is ' +
    'the cable each point stands for and sums to the total cable length. `compartment` comes ' +
    'from the source: CAVE skeleton-service and SWC skeletons have one; neuPrint, CATMAID and ' +
    'level-2 skeletons do not.',
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
      help: '"even pieces of cable" places a point every `Spacing (µm)`, so each point stands for the same length of cable. "one per skeleton node" uses the skeleton’s own nodes, and `cable` gives each half of its edges.',
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

  inferOutputs: (ctx) => ({
    out: T.points(skeletonPointsSchema(ctx.attributes('in'), ctx.columns('carry'))),
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
    const spacingUm = Number(ctx.params.spacing)
    const spacingNm = spacingUm * NM_PER_UM
    if (placement === 'resample' && !(spacingNm > 0)) {
      throw new Error('`Spacing (µm)` must be more than 0.')
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
        `${unlabelled.toLocaleString()} of ${items.length.toLocaleString()} skeletons have no compartment labels, so \`compartment\` is empty on their points. The source does not publish compartments for them; CAVE skeleton-service and SWC skeletons do.`,
      )
    }
    const empty = counts.filter((n) => n === 0).length
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
      ),
    }
  },
})
