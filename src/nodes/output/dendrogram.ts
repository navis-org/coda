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
 *
 * **`Annotations` names the leaves, and naming is a drawing.** Every route into Linkage but
 * NBLAST's labels its matrix axis with whatever identified the observation — a bare root id on
 * `Similarity Matrix`, `Adjacency` and `Pivot` alike — and a `LinkageValue` carries `string[]`
 * and nothing else, so by the time a tree is here the cell type that would make it readable is
 * gone. The port takes an ordinary neuron table (the one that fed the clustering, usually) and
 * `Match on` / `Label by` join it onto the leaf's own label. Four consequences, and each is a
 * decision rather than a detail:
 *
 * - **`evaluate` never reads it.** Both pickers are `presentational`, so relabelling costs no
 *   re-run of the `expensive` Linkage above and no provenance key changes — which is what makes
 *   trying `type`, then `instance`, then `hemilineage` the instant thing it should be.
 * - **`Selected` keeps carrying the tree's own label**, deliberately, and that is the whole
 *   reason this is a viewer's port and not a relabel upstream. `Selected to Neurons` matches
 *   that column against a neuron table; label the *tree* by type and one clade of fourteen
 *   neurons resolves to every neuron of those five types in the connectome. The annotation is
 *   already one node downstream anyway — `Selected to Neurons` carries the whole neuron table's
 *   columns onto its output — so nothing is lost by leaving the identity alone.
 * - **The Heatmap does not get the same port**, though the wizard pairs the two. Its row labels
 *   are *data*: the Filter tab matches on them and the Order tab sorts by them, both
 *   `affectsData`, so a presentational rename there would show `LC4` on screen while a filter
 *   typed `LC4` matched nothing. A matrix-level relabel is the answer to that one and it is a
 *   different node. See `docs/viewers.md`.
 * - **An unnamed leaf keeps its own label**, which inverts `core.relabel`'s `Unmatched` default
 *   on purpose: there, a value that passes for mapped is the confusion being prevented, where
 *   here a blank leaf is strictly worse than the id it replaced. The caption counts them.
 */

import { registerNode } from '../../core/registry'
import { ID_COLUMN_NAME } from '../../core/ids'
import { T, column, findColumn, schemaOf, tableSchema } from '../../core/types'
import { isLinkageValue, tableFromRows } from '../../core/values'
import { TYPE_COLUMN_NAME } from '../../data/annotations/types'
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
  /*
   * The description carries the Annotations port, and that is a decision about a *reader* who
   * is not a person: `catalogue.ts` runs at `lean` by default, which prints a node's type,
   * description, ports and param names and **drops every `help` string**. So the one line here
   * is the assistant's only prose about this node — and "name the leaves by cell type" is
   * exactly the thing somebody asks an agent for and cannot ask for by naming a param they have
   * never seen. The ports render as `annotations? (Table)` beside it, and the two defaults as
   * `matchColumn column default=neuronId` / `labelColumn column default=type`.
   */
  description:
    'Draw a merge tree, select branches of it, and name its leaves from an annotation table.',
  guide:
    'A diagram of the hierarchical relationship between objects. Typically an output from ' +
    'hierarchical clustering (see linkage). Wire a neuron table to Annotations to label the ' +
    'leaves by cell type — or by anything else the table carries — without changing the tree. ' +
    'Expand the card to scroll-zoom into a big one; the names come back as there is room.',
  cost: 'cheap',
  defaultSize: { width: 560, height: 420 },
  inputs: [
    { id: 'in', label: 'Tree', type: T.linkage() },
    /*
     * An ordinary table, not `T.neurons()`. Everything wanted here is a neuron table in
     * practice, but the join is "match this column against the leaf's label" and a two-column
     * upload or a `Group By` answers it just as well — the standing `core.relabel`'s `Mapping`
     * port takes, and declaring `neurons` would refuse those for a rule nothing here relies on.
     */
    { id: 'annotations', label: 'Annotations', type: T.table(), required: false },
  ],
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
    /*
     * Both `optional`, and that is the load-bearing half rather than a shrug.
     *
     * `resolveColumn`'s rule 3 substitutes the *first compatible column* for a required picker
     * whose declared default the schema does not have — which here would name every leaf after
     * whatever column happens to come first in somebody's annotation table, silently and
     * plausibly. `optional` answers "off" instead, and off draws the tree's own labels. The
     * declared defaults still land at creation through `defaultParams`, so wiring a neuron
     * table and getting cell types needs nothing set; a stored graph from before this port
     * existed has neither key, reads as off, and draws exactly what it drew before — absence and
     * the default agreeing, which is why this is not `absentMeans`' case.
     */
    {
      id: 'matchColumn',
      kind: 'column',
      label: 'Match on',
      from: 'annotations',
      default: ID_COLUMN_NAME,
      optional: true,
      presentational: true,
      help:
        'Which column of the wired table is compared with the leaf label. Leaf labels are ' +
        'whatever named the matrix, so this is `neuronId` unless NBLAST was told to label by ' +
        'something else — set it to the same column in that case. Compared as text.',
    },
    {
      id: 'labelColumn',
      kind: 'column',
      label: 'Label by',
      from: 'annotations',
      default: TYPE_COLUMN_NAME,
      optional: true,
      presentational: true,
      help:
        'Which column names each leaf on the drawing — `type` for cell types, or any other ' +
        'annotation the table carries. Only the picture changes: the tree, its Selected output ' +
        'and everything downstream keep the labels the matrix arrived with. A leaf the table ' +
        'says nothing about keeps its own label, and the caption counts those.',
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

  /**
   * The one thing a wired-but-useless Annotations port can be told at edit time.
   *
   * Nothing here can tell an unannotated tree from a mistyped one — the leaf labels are data
   * the run decided and `T.linkage()` carries none — so what is checkable is the *table*: a
   * picker that resolves to nothing, and invariant 8's dtype trap, which presents identically
   * to "no annotations wired" and is the reason this is worth a line at all.
   */
  validate: (ctx) => {
    const annotations = schemaOf(ctx.inputs.annotations)
    // A port that is not wired is not a port whose columns are missing, and an unwired one is
    // the ordinary state of this node. Nothing to say until a table has actually arrived.
    if (!annotations) return []

    const issues: string[] = []
    const match = ctx.column('matchColumn')
    const label = ctx.column('labelColumn')
    if (!match || !label) {
      issues.push(
        'Annotations is wired but Match on and Label by are not both set, so the leaves keep ' +
          'the labels the matrix arrived with',
      )
      return issues
    }

    const key = findColumn(annotations, match)
    if (key && key.dtype !== 'str') {
      /*
       * `relabelTable`'s warning, one node over and for the same reason: this is never fatal,
       * because a narrow id read as a number still resolves. What it is about is the wide one —
       * an 18-digit root id in an `i64` column is a float64 that has already lost the digits
       * identifying it, so `idText` **drops** it rather than naming whichever neuron owns the
       * rounded value (invariant 8). The leaf keeps its own label, which is indistinguishable
       * from having wired no annotations at all: hence a line here rather than silence.
       */
      issues.push(
        `"${match}" is ${key.dtype} — a wide neuron id read as a number has already lost the ` +
          `digits that identified it, so those leaves keep their own labels (see invariant 8)`,
      )
    }
    if (match === label) {
      issues.push(`Match on and Label by are both "${match}" — every leaf keeps its own name`)
    }
    return issues
  },

  /*
   * **Nothing here reads `annotations`**, which is the property the port was designed around
   * rather than an omission. A leaf's drawn name is a fact about the picture; `label` below is
   * the handle `Selected to Neurons` matches on, and the two being the same column is what
   * would turn one clade into every neuron of its types. See the header.
   */
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
