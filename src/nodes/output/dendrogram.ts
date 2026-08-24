/**
 * Dendrogram: the merge tree, drawn.
 *
 * The viewer half of the clustering pair. A linkage matrix is `n - 1` rows of four numbers and
 * is unreadable as such; the tree is the thing anyone actually wants to look at, and looking
 * at it is how the cut gets chosen.
 *
 * **A tap, like every other viewer here**: `Tree` passes through unchanged, so a Dendrogram
 * can be dropped into the middle of a chain rather than at the end of one. `Selected` is the
 * leaves of whatever branch was clicked — which is the gesture this drawing is *for*, since a
 * clade is exactly the thing somebody wants to pull out and look at in 3D, and it is the one
 * selection a table cannot express because it is a fact about the tree.
 *
 * **A branch selects; it does not cut.** The cut lives in `cluster.cut`, one node upstream,
 * where it is a stored number that everything downstream can see. A viewer that also cut would
 * be a second answer to the same question with nothing saying which one won.
 */

import { registerNode } from '../../core/registry'
import { T, column, tableSchema } from '../../core/types'
import { isLinkageValue, tableFromRows } from '../../core/values'
import { leafPositions } from '../lib/linkageOps'
/*
 * The one `nodes -> ui` edge this node has, and the same one `out.neuroglancer` takes for the
 * same stated reason: "never re-implement colour mapping" applies to a downstream consumer as
 * much as to a viewer, and importing the rule is what makes a neuron the colour of the branch
 * it hung off. Both modules are pure, so it stays testable headlessly.
 */
import { clusterColor } from '../../ui/encoding'

/**
 * What a selected branch hands on.
 *
 * **All four columns always**, even with nothing cut. A schema that gained and lost `cluster`
 * and `color` as a Cut Tree came and went would silently empty every picker downstream that
 * pointed at them — the rule `neuron.connectivity` records for its own `hop` and `direction`.
 * Uncut, `cluster` is 0 and `color` is the achromatic ink, which is exactly what the tree draws.
 */
function selectionSchema(): ReturnType<typeof tableSchema> {
  return tableSchema(
    column('label', 'str'),
    column('order', 'i64'),
    column('cluster', 'i64'),
    column('color', 'str'),
  )
}

/**
 * Which palette the emitted hex comes from, and why it is not the one on screen.
 *
 * Pinned, because `evaluate` has to be deterministic (invariant 4): a cache key does not change
 * when somebody flips the theme, so a colour resolved from `currentMode()` would go stale with
 * nothing to invalidate it. Dark is the one to pin — it is where these colours are going, since
 * neuroglancer renders on black, and it is the same call `out.neuroglancer` makes for
 * `resolveColor`. The cost is small and worth stating: on a light canvas the tree's own
 * branches take the light ramp, a shade off the hex in the column.
 */
const EMITTED_MODE = 'dark' as const

export const dendrogramNode = registerNode({
  type: 'out.dendrogram',
  label: 'Dendrogram',
  category: 'visualisation',
  description: 'Draw a merge tree, and select branches of it.',
  guide: 'A diagram of the hierarchical relationship between objects. Typically an output from hierarchical clustering (see linkage).',
  cost: 'cheap',
  defaultSize: { width: 560, height: 420 },
  inputs: [{ id: 'in', label: 'Tree', type: T.linkage() }],
  outputs: [
    { id: 'out', label: 'Tree', type: T.linkage() },
    { id: 'selected', label: 'Selected', type: T.table(selectionSchema()) },
  ],
  params: [
    {
      id: 'orientation',
      kind: 'enum',
      label: 'Orientation',
      default: 'right',
      presentational: true,
      options: [
        { value: 'right', label: 'leaves on the right' },
        { value: 'down', label: 'leaves at the bottom' },
      ],
      help:
        'Leaves on the right reads labels horizontally and takes as many as the card is tall, ' +
        'which is the one that scales. Leaves at the bottom is the conventional orientation ' +
        'and the one to export.',
    },
    {
      id: 'showLabels',
      kind: 'boolean',
      label: 'Leaf labels',
      default: true,
      presentational: true,
      help: 'Dropped automatically where there is not room for them; the caption says so.',
    },
    {
      id: 'selection',
      kind: 'ids',
      label: 'Selected',
      noun: 'leaves',
      default: [],
      help:
        'Set by clicking a branch in the viewer. Holds leaf positions rather than names, ' +
        'because a label column can name two neurons the same thing. Feeds Selected.',
    },
  ],

  inferOutputs: () => ({ out: T.linkage(), selected: T.table(selectionSchema()) }),

  evaluate: (ctx) => {
    const tree = ctx.input('in')
    if (!isLinkageValue(tree)) throw new Error('Input is not a tree — wire a Linkage node in')

    /*
     * **The selection holds observation indices, not labels**, which is the opposite of the
     * call `rowIds.ts` makes for the scatter — and it is forced rather than chosen. A leaf's
     * label is whatever named the matrix, and `NBLAST → Label by: type` makes those repeat:
     * fourteen neurons come back as five distinct names. Held as labels, selecting one clade
     * lights every branch sharing a name with it, and `Selected` carries rows nobody picked.
     * Found in a browser; the drawing is the only place it shows.
     *
     * The cost is the one `core.selectOne` records: a position is not an identity, so an
     * upstream change that reorders the observations re-points the selection. A tree is
     * recomputed whenever anything above it moves anyway, so there was no stabler handle to
     * choose — only a less honest one.
     *
     * An index this tree does not have simply carries no row. A stale control is no reason for
     * `evaluate` to block everything downstream — invariant 5's corollary.
     */
    // Numbers once, so the loop below neither stringifies an index per leaf nor builds a row
    // and a colour for every observation to keep the handful that were clicked.
    const wanted = new Set(((ctx.params.selection as string[] | undefined) ?? []).map(Number))
    const position = leafPositions(tree)

    const rows = []
    for (const i of wanted) {
      const label = tree.labels[i]
      if (label === undefined) continue
      const cluster = tree.clusters?.[i] ?? 0
      rows.push({
        label,
        order: position[i]!,
        cluster,
        // The hue the branch was drawn in, through the shared rule rather than a second copy
        // of it — so a Neuroglancer segment and the bracket it came from cannot disagree.
        color: clusterColor(cluster, EMITTED_MODE),
      })
    }
    rows.sort((a, b) => a.order - b.order)

    return { out: tree, selected: tableFromRows(selectionSchema(), rows) }
  },
})
