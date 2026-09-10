/**
 * Heatmap: a matrix as a grid of coloured cells, in an order somebody chose.
 *
 * Two halves, and the split is the node's whole design. **Colour is presentational** — scale,
 * palette, printed values — and never enters the provenance key, so restyling a four-million-
 * cell picture is a repaint. **Everything else is data**: the `Labels`, `Filter` and `Order`
 * tabs each change the matrix this node *outputs*, so a Table beside the heatmap, the CSV
 * export and the notebook all show what the card shows. That is why those tabs say downstream
 * nodes go stale, and why none of their params is `presentational`.
 *
 * `Labels` is the newest of the three and the one that had to argue its way in. `out.dendrogram`
 * names its leaves from a wired annotation table and does it **presentationally** — `evaluate`
 * never reads the port, so the tree keeps the identity `Selected to Neurons` matches on. That
 * shape was considered here and refused: this node's Filter tab matches on axis labels and its
 * Order tab sorts by them, both in `evaluate`, so a name that only the drawing knew about would
 * put `LC4` on screen while a filter typed `LC4` matched nothing — the worse kind of wrong,
 * because the picture looks right. So the join runs in `evaluate`, ahead of both, and what it
 * costs is stated rather than hidden: the axis stops carrying the identity it arrived with, and
 * a `Linkage` below a relabelled Heatmap clusters lines called `LC4`. `NBLAST`'s `Label by` is
 * the precedent — "the labels are part of the matrix that leaves the port, not a way of drawing
 * it" — and the same sentence is true here.
 *
 * The clustering order is the one thing here that crosses the Python bridge, and it is the
 * clustermap's clustering rather than the Linkage node's: rows as vectors across the columns,
 * distances between vectors, leaf order. A node that stays `cheap` with a Pyodide call in it is
 * a real decision (invariant 6) and this one is made on purpose — the call is local, it runs
 * only when `clustering` is chosen, and a heatmap that needed a Run to sort itself would be a
 * viewer that stopped being live the moment somebody asked it to be useful. The first use
 * pays Pyodide's boot; after any NBLAST or Linkage it is milliseconds.
 */

import { registerNode } from '../../core/registry'
import { T, column, tableSchema } from '../../core/types'
import type { EvalContext, ParamValues } from '../../core/node'
import type { MatrixValue, TableValue } from '../../core/values'
import { isMatrixValue, isTableValue, tableFromRows } from '../../core/values'
import { runClusterOrder } from '../../pyodide/linkage'
import { decodeMatrixSelection } from '../lib/chartSelection'
import { ANNOTATIONS_INPUT } from '../lib/annotationParams'
import { displayLabels, labelPickerIssues, labelPickerParams } from '../lib/displayLabels'
import { DIVERGING_PALETTE_OPTIONS, SEQUENTIAL_PALETTE_OPTIONS } from '../lib/heatmapParams'
import { LINKAGE_METHODS, checkClusterInput, warnUnrecordedCells } from '../lib/linkageOps'
import type { MatrixAxis, MatrixOrderOptions } from '../lib/matrixShape'
import {
  CLUSTER_METRIC_OPTIONS,
  LABEL_AXIS_OPTIONS,
  axesOf,
  SORT_AXIS_OPTIONS,
  SORT_BY_OPTIONS,
  keptLabels,
  labelsOf,
  orderAxis,
  orderIndices,
  orderPlan,
  parseLabelFilter,
  readFilterOptions,
  readLabelOptions,
  readOrderOptions,
  relabelMatrix,
  reverseOrder,
  takeAxisLabels,
  takeMatrix,
} from '../lib/matrixShape'

/** Whether an order has been chosen at all — the four Order controls hang off this. */
const ordering = (p: ParamValues): boolean => p.sortBy !== 'none'

/**
 * What a selected row or column hands on.
 *
 * **Three columns always**, `out.dendrogram`'s rule: a schema that gained and lost a column as
 * the Annotations port came and went would silently empty every picker downstream that pointed
 * at it.
 *
 * `label` is what the line was called **on the way in** — the id, on every route that does not
 * name its axes — and it is spelled `label` because `Selected to Neurons` defaults its picker
 * to exactly that, so `Selected Rows → Selected to Neurons → 3D` wires with nothing to set.
 * `relabel` is what the card *showed*, which is the same string wherever the Labels tab did not
 * rename anything: the two together are how a selection made by cell type still says which
 * neurons it caught. Both `str`, invariant 8 — a neuron id is text everywhere.
 *
 * `index` is the position in the matrix this node **outputs**, so a Sort downstream can put the
 * lines back in the order the card showed them.
 */
const SELECTION_SCHEMA = tableSchema(
  column('label', 'str'),
  column('index', 'i64'),
  column('relabel', 'str'),
)

export const heatmapNode = registerNode({
  type: 'out.heatmap',
  label: 'Heatmap',
  category: 'visualisation',
  /*
   * The description carries the Annotations port, which is `out.dendrogram`'s reason: the
   * assistant's catalogue runs at `lean`, printing a node's type, description, ports and param
   * names while dropping every `help` string — so this line is its only prose about the node,
   * and "name the rows by cell type" is exactly the thing somebody asks an agent for and cannot
   * ask for by naming a param they have never seen.
   */
  description:
    'Render a matrix as a heatmap, and name its rows and columns from an annotation table.',
  guide:
    'A matrix drawn as a grid of coloured cells — the natural end of Adjacency or Pivot. Sequential for counts and fractions, diverging when zero is a meaningful middle. Wire a neuron table to Annotations to name the axes by cell type rather than by root id. The Order tab sorts by total, name, one row or column, or clustering — and the named, filtered, sorted matrix is what the node outputs.',
  cost: 'cheap',
  inputs: [
    { id: 'in', label: 'Matrix', type: T.matrix() },
    /*
     * `ANNOTATIONS_INPUT`, the socket `out.dendrogram` and every dataset node take: an ordinary
     * table rather than `T.neurons()`, because the join is "match this column against the axis
     * label", which a two-column upload or a `Group By` answers as well as a neuron table does.
     */
    ANNOTATIONS_INPUT,
  ],
  outputs: [
    { id: 'out', label: 'Matrix', type: T.matrix() },
    /*
     * The two halves of a rectangle, as tables. Separate ports rather than one table of lines
     * with an `axis` column: the two are different populations — a row is a neuron and a column
     * may be a region — and everything downstream takes one or the other, so a single port
     * would put a `Filter Table` in front of every use.
     */
    { id: 'rows', label: 'Selected Rows', type: T.table(SELECTION_SCHEMA) },
    { id: 'columns', label: 'Selected Columns', type: T.table(SELECTION_SCHEMA) },
  ],
  /*
   * Tab order is `evaluate`'s order for the three that change data: names, then the filter that
   * matches on them, then the sort that orders by them.
   */
  paramGroups: [
    { id: 'colour', label: 'Colour' },
    { id: 'labels', label: 'Labels', affectsData: true },
    { id: 'filter', label: 'Filter', affectsData: true },
    { id: 'order', label: 'Order', affectsData: true },
    { id: 'selection', label: 'Selection', affectsData: true },
  ],
  params: [
    {
      id: 'scale',
      kind: 'enum',
      label: 'Colour scale',
      default: 'sequential',
      presentational: true,
      group: 'colour',
      options: [
        { value: 'sequential', label: 'sequential' },
        { value: 'diverging', label: 'diverging (0 centred)' },
      ],
    },
    /*
     * One palette per scale rather than one list for both: a diverging ramp has a middle and a
     * sequential one does not, so the two lists cannot mix, and a separate param is what lets a
     * choice survive toggling the scale and back. `visibleIf` keeps exactly one on screen and,
     * being excluded from the key by `presentational` anyway, costs nothing in provenance.
     */
    {
      id: 'palette',
      kind: 'enum',
      label: 'Palette',
      default: 'coda',
      presentational: true,
      group: 'colour',
      options: SEQUENTIAL_PALETTE_OPTIONS,
      visibleIf: (p) => p.scale !== 'diverging',
      help: 'Coda blue reverses with the theme, so an empty cell always recedes. The rest are matplotlib’s, drawn as published on both themes.',
    },
    {
      id: 'divergingPalette',
      kind: 'enum',
      label: 'Palette',
      default: 'coda',
      presentational: true,
      group: 'colour',
      options: DIVERGING_PALETTE_OPTIONS,
      visibleIf: (p) => p.scale === 'diverging',
      help: 'Coda’s pair puts blue on the negative arm. The ColorBrewer sets run as published — RdBu has red at the negative end.',
    },
    /*
     * The two ends of the ramp, and empty means "ask the data". `string` rather than `number`
     * because a number param has no unset state — `ParamField` coerces anything unparseable
     * back to the default, and 0 is an ordinary limit rather than a sentinel. See
     * `readColorLimits`, which is where an inverted or unreadable pair is dropped.
     */
    {
      id: 'colorMin',
      kind: 'string',
      label: 'Min',
      default: '',
      placeholder: 'auto',
      presentational: true,
      advanced: true,
      group: 'colour',
      visibleIf: (p) => p.scale !== 'diverging',
      help: 'The value at the bottom of the colour ramp. Empty lets the data decide. Cells below it are drawn in the end colour, not dropped.',
    },
    {
      id: 'colorMax',
      kind: 'string',
      label: 'Max',
      default: '',
      placeholder: 'auto',
      presentational: true,
      advanced: true,
      group: 'colour',
      help: 'The value at the top of the colour ramp; empty lets the data decide. Set both ends to hold one scale across two heatmaps. On a diverging scale this is the magnitude of both arms.',
    },
    {
      id: 'logColor',
      kind: 'boolean',
      label: 'Log colour',
      default: false,
      presentational: true,
      advanced: true,
      group: 'colour',
      visibleIf: (p) => p.scale !== 'diverging',
      help: 'Spread the colour over a log scale — the mapping only; the printed cells, the tooltip and the colour bar keep the values. Not offered on a diverging scale.',
    },
    {
      id: 'showValues',
      kind: 'boolean',
      label: 'Show values',
      help: 'Only legible on small matrices; the viewer hides them automatically when cells get too small.',
      default: false,
      presentational: true,
      group: 'colour',
    },

    // --- labels -----------------------------------------------------------
    ...labelPickerParams({
      group: 'labels',
      matchHelp:
        'Which column of the wired table is compared with the row or column label. Axis labels are whatever named the matrix, usually "neuronId". Compared as text.',
      labelHelp:
        'Which column names each row or column. Unlike the Dendrogram’s, this changes the matrix the node outputs, so the Filter and Order tabs, the CSV and the notebook all see the new names. Unmatched lines keep their own.',
    }),
    /*
     * `both` by default, because the matrix that motivated the port is square over one
     * population — an Adjacency, or a Pivot of a Connectivity result — where naming one axis and
     * not the other is the shape nobody wants. On a matrix whose columns are something else
     * (ROIs, say) the annotation table names none of them, they keep their own labels, and the
     * node says so: a message pointing at this control, which is better than a default that
     * quietly did half the job.
     */
    {
      id: 'labelAxis',
      kind: 'enum',
      label: 'Apply to',
      default: 'both',
      advanced: true,
      group: 'labels',
      options: LABEL_AXIS_OPTIONS,
      help: 'Which axis the names are written onto. "Both" is right for a square matrix over one population; narrow it when the two axes are different kinds of thing.',
    },

    // --- filter -----------------------------------------------------------
    /*
     * Two boxes rather than one filter and an "apply to" selector: the axes of a heatmap are
     * different questions even when they hold the same labels — "which neurons' outputs" and
     * "onto which partners" — and the selector would have to grow a "both" that is only ever
     * right on a square matrix. Somebody who wants both types the same expression twice, which
     * is two seconds and unambiguous.
     */
    {
      id: 'rowFilter',
      kind: 'string',
      label: 'Rows',
      default: '',
      placeholder: 'LC   or   /^LC[0-9]+$',
      group: 'filter',
      help: 'Keep only rows whose label matches. A plain term matches anywhere, ignoring case; "/" starts a regular expression; "!" or "-" negates. For several names: /^(LC4|LC6|LPLC2)$',
    },
    {
      id: 'colFilter',
      kind: 'string',
      label: 'Columns',
      default: '',
      placeholder: 'LC   or   /^LC[0-9]+$',
      group: 'filter',
      help: 'Keep only columns whose label matches, with the same spelling as the row filter.',
    },

    // --- order ------------------------------------------------------------
    {
      id: 'sortBy',
      kind: 'enum',
      label: 'Order by',
      default: 'none',
      group: 'order',
      options: SORT_BY_OPTIONS,
      help: 'Reorders the matrix this node outputs, not just the picture. "Total" sums each row or column; "clustering" is seaborn’s clustermap. To cluster a score matrix by its own scores, use Linkage.',
    },
    {
      id: 'sortKey',
      kind: 'string',
      label: 'Row or column',
      default: '',
      placeholder: 'a label',
      group: 'order',
      visibleIf: (p) => p.sortBy === 'value',
      help: 'Ordering rows, the column whose values decide; ordering columns, the row. A label the matrix lacks leaves that axis untouched and says so on the card.',
    },
    {
      id: 'sortAxis',
      kind: 'enum',
      label: 'Apply to',
      default: 'rows',
      advanced: true,
      group: 'order',
      options: SORT_AXIS_OPTIONS,
      visibleIf: ordering,
      help: 'Which axis the criterion runs on. Both sorts each axis on its own.',
    },
    {
      id: 'sortFollow',
      kind: 'boolean',
      label: 'Other axis follows',
      default: true,
      advanced: true,
      group: 'order',
      visibleIf: (p) => ordering(p) && p.sortAxis !== 'both',
      help: 'The other axis takes the same order, matched by label. Labels the sorted axis does not have keep their place after them.',
    },
    {
      id: 'sortReverse',
      kind: 'boolean',
      label: 'Reverse',
      default: false,
      advanced: true,
      group: 'order',
      visibleIf: ordering,
    },
    {
      id: 'clusterMethod',
      kind: 'enum',
      label: 'Linkage',
      default: 'average',
      advanced: true,
      group: 'order',
      options: LINKAGE_METHODS,
      visibleIf: (p) => p.sortBy === 'cluster',
      help: 'How the distance between two groups is measured. Average is seaborn’s default.',
    },
    {
      id: 'clusterMetric',
      kind: 'enum',
      label: 'Distance',
      default: 'euclidean',
      advanced: true,
      group: 'order',
      options: CLUSTER_METRIC_OPTIONS,
      visibleIf: (p) => p.sortBy === 'cluster',
      help: 'How two rows are compared. Euclidean is seaborn’s default and is swayed by how much a row connects; correlation and cosine compare the shape of its profile instead.',
    },

    // --- selection --------------------------------------------------------
    /*
     * **One param for both axes**, holding `r:`/`c:`-prefixed *positions* — see
     * `encodeMatrixSelection`, which is also where the case for positions over names is made. A
     * rectangle is one gesture, and two params would be two commits: an undo would take back the
     * columns and leave the rows, which is `attachEdgeSet`'s recorded trap. The two *outputs*
     * stay separate because a row and a column are different populations downstream.
     *
     * Not `presentational`: it decides what `Selected Rows` and `Selected Columns` carry, so a
     * stale result below must not survive a new rectangle (invariant 4). It leaves the `Matrix`
     * output untouched, which is why the tab's warning is about what is wired to the other two.
     */
    {
      id: 'selection',
      kind: 'ids',
      label: 'Selected',
      noun: 'lines',
      default: [],
      group: 'selection',
      help: 'Set by shift-dragging a rectangle on the expanded card; hold Alt to add a second block. Holds the positions it covers, so a box round one row of a repeated cell type takes that row and not its namesakes. Feeds Selected Rows and Selected Columns.',
    },
  ],

  validate: (ctx) => labelPickerIssues(ctx, { plural: 'rows and columns', singular: 'line' }),

  evaluate: async (ctx) => {
    const input = ctx.input('in')
    if (!isMatrixValue(input)) throw new Error('Input is not a matrix')

    const shaped = await reshape(ctx, input)
    const picked = decodeMatrixSelection(ctx.params.selection)
    return {
      out: shaped.matrix,
      rows: selectedLines(shaped.matrix.rowLabels, shaped.source.rows, picked.rows),
      columns: selectedLines(shaped.matrix.colLabels, shaped.source.columns, picked.columns),
    }
  },
})

/** A named, filtered, ordered matrix, and what each surviving line arrived called. */
interface Shaped {
  matrix: MatrixValue
  /**
   * The arrival names, carried beside the matrix through both reshaping steps.
   *
   * A `MatrixValue` has one set of axis labels, and after the Labels tab those are the drawn
   * names — so `Selected Rows` would have no way back to the id it was asked for. Tracking the
   * pair through the *same* index lists is the only alignment that survives a filter and a
   * sort; deriving it at the end from the drawn name cannot, since naming by type is
   * one-to-many by design.
   */
  source: Record<MatrixAxis, string[]>
}

/**
 * The last answer for one input matrix, so a gesture that reshapes nothing costs nothing.
 *
 * **The selection is in the provenance key** — it decides two output ports, so it has to be
 * (invariant 4) — which means every drag, every alt-add and every ⌫ re-enters `evaluate`. What
 * it must not do is re-*run* the reshaping, and the top of that bill is not the filter: with
 * `Order by: clustering` it is `runClusterOrder`, which marshals the whole matrix across the
 * Pyodide bridge and has no cache of its own. Dragging a rectangle on a clustered heatmap would
 * re-cluster it, once per gesture.
 *
 * Keyed on the input value's identity in a `WeakMap` and on a signature of the params that
 * actually reshape — `editTable.ts`'s `PLANS` idiom, and `describeOps.ts`' beside it. The
 * warnings are cached with the answer and replayed, or a card would drop the "12 of 40 rows are
 * not named" line it had been showing the moment somebody selected something.
 *
 * It also holds the *identity* of the reshaped matrix steady across a selection-only change,
 * which is worth more than the arithmetic: the viewer keys its extent scan, its fold and its
 * zoom window on `matrix`, so a fresh object per drag would rescan and re-fold four million
 * cells to draw the picture already on screen.
 */
const SHAPED = new WeakMap<MatrixValue, Map<string, { shaped: Shaped; warnings: string[] }>>()

/** How many reshapings of one input matrix are worth holding. */
const SHAPED_KEPT = 4

/**
 * What the reshaping depends on, as one string.
 *
 * The three readers rather than `ctx.params`, because the colour tab is in `ctx.params` too and a
 * palette flip must not evict a clustering. The **resolved** columns rather than the raw pickers
 * (invariant 5), and `inputKey('annotations')` beside them: a new annotation table with the same
 * two column names is a different set of *names*, and without it this would serve the old ones
 * for as long as the input matrix stayed the same object.
 *
 * `heatmap.test.ts` walks the definition and asserts this reads every non-presentational param
 * outside the Selection tab, which is the one thing that cannot be checked from here — a fifth
 * data param added later and not added to this line serves a stale matrix in silence.
 */
export function reshapingKey(ctx: EvalContext): string {
  return JSON.stringify([
    readLabelOptions(ctx),
    readFilterOptions(ctx.params),
    readOrderOptions(ctx.params),
    ctx.inputKey('annotations'),
  ])
}

async function reshape(ctx: EvalContext, input: MatrixValue): Promise<Shaped> {
  const key = reshapingKey(ctx)
  let held = SHAPED.get(input)
  if (!held) {
    held = new Map()
    SHAPED.set(input, held)
  }

  let entry = held.get(key)
  if (!entry) {
    // The pipeline warns into the entry rather than at the card, so a hit can replay them: a
    // card that dropped its "12 of 40 rows are not named" line the moment somebody selected
    // something would be the cache showing through.
    const warnings: string[] = []
    const shaped = await shapeOnce({ ...ctx, warn: (m) => warnings.push(m) }, input)
    entry = { shaped, warnings }
    /*
     * A few per input rather than one. Keyed on the input alone, two Heatmaps reading one
     * upstream matrix with different tabs evicted each other on every gesture — and a miss under
     * `Order by: clustering` is a full marshal across the Pyodide bridge, which is the cost this
     * exists to avoid. `JOINS` in `displayLabels.ts` is the same nesting.
     *
     * What it retains is worth saying: a filtered or ordered matrix is a second `Float64Array`
     * of the whole grid, and these are held for as long as the *input* matrix is reachable —
     * past this node being deleted. The bound is `SHAPED_KEPT` copies of something the scheduler
     * is already holding one of, and the input dying takes them with it.
     */
    if (held.size >= SHAPED_KEPT) held.delete(held.keys().next().value!)
    held.set(key, entry)
  }

  for (const warning of entry.warnings) ctx.warn(warning)
  return entry.shaped
}

/** The reshaping itself, warning through whatever context it is handed. */
async function shapeOnce(ctx: EvalContext, input: MatrixValue): Promise<Shaped> {
  const options = readOrderOptions(ctx.params)

  // Names first, then the filter that matches on them, then the order that sorts by them. Any
  // other sequence makes the two boxes read labels a reader cannot see. The relabel moves no
  // line, so `source` is still aligned after it.
  const named = nameAxes(ctx, input)
  // Filter next: an order is computed against what is left, since a row total taken over
  // columns somebody has just excluded is not the number they asked for.
  const filtered = filterMatrix(ctx, named)
  let source = takeAxisLabels(
    { rows: input.rowLabels, columns: input.colLabels },
    filtered.kept,
  )

  let matrix = filtered.matrix
  if (options.by !== 'none') {
    const plan = orderPlan(options)
    // Once, not per axis: it walks every cell and the answer is the same for both.
    if (options.by === 'cluster') warnUnrecordedCells(ctx, matrix)
    const orders: Partial<Record<MatrixAxis, Int32Array>> = {}
    for (const axis of plan.lead) {
      if (options.by === 'cluster') {
        const order = await clusterAxis(ctx, matrix, axis, options)
        if (order) orders[axis] = order
        continue
      }
      const result = orderAxis(matrix, axis, options)
      if (result.order) orders[axis] = result.order
      else ctx.warn(result.problem)
    }
    // The index lists rather than a reshaped matrix, so the follower's derived list reaches the
    // arrival names too — computing it twice is how the two come to disagree.
    const indices = orderIndices(matrix, plan, orders)
    matrix = takeMatrix(matrix, indices.rows, indices.columns)
    source = takeAxisLabels(source, indices)
  }

  return { matrix, source }
}

/**
 * The selected lines of one axis, in the order the card shows them.
 *
 * **Positions into the matrix this node outputs**, which is what a rectangle means: the lines
 * under it, and no others. Resolving by *name* was the first shape and it is the bug it was
 * reported as — the Labels tab exists to put one name on many lines, so a box round one cell of
 * a fourteen-row `LC4` block selected all fourteen.
 *
 * The lines are walked rather than the selection, so the result is in the card's own order
 * whatever order the gesture recorded. An index the matrix no longer has — a sort or a filter
 * moved under a standing selection, or the upstream matrix changed shape — contributes nothing,
 * which is invariant 5's corollary applied to a stale control rather than a reason to throw.
 */
function selectedLines(drawn: string[], source: string[], picked: Set<number>): TableValue {
  const rows: Array<Record<string, string | number>> = []
  for (let i = 0; i < drawn.length; i++) {
    if (!picked.has(i)) continue
    const label = drawn[i]!
    rows.push({ label: source[i] ?? label, index: i, relabel: label })
  }
  return tableFromRows(SELECTION_SCHEMA, rows)
}

/**
 * The Labels tab applied, with what it could not name said out loud.
 *
 * The join is `displayLabels`, shared with `out.dendrogram` — an annotation column matched
 * against the line's own label, another column supplying the name — so its rules come with it:
 * ids resolve through `idText`, a blank is no name, and the first row wins a repeated key. Its
 * four ways of answering nothing (no table, either picker unset, either column absent from the
 * table that arrived) are all "keep the labels the matrix came with", which is what an
 * `evaluate` that may not throw on a half-wired port needs — invariant 5's corollary.
 *
 * **Two messages, and they are different states.** *Nothing* named on an axis is a control
 * pointed at the wrong place — the wrong `Match on`, or `Apply to` covering an axis of ROI names
 * — and the message names the two controls that fix it. *Some* named is an incomplete
 * annotation table, which is ordinary and worth a count: an axis where a third of the lines are
 * still root ids looks like a broken join and usually is one. All named says nothing at all.
 *
 * Deliberately no warning about the names that now repeat. Relabelling by type is *meant* to put
 * fourteen rows called `LC4` on one axis — that is what makes a filter of `/^LC4$` useful — and
 * the only thing it costs is that `Order by: one row or column` resolves a repeated key to the
 * first of them, which `axisVector` already documents and the help says.
 */
function nameAxes(
  ctx: Pick<EvalContext, 'warn' | 'params' | 'column' | 'input'>,
  matrix: MatrixValue,
): MatrixValue {
  const options = readLabelOptions(ctx)
  const table = ctx.input('annotations')
  const names = displayLabels(
    isTableValue(table) ? table : undefined,
    options.match,
    options.label,
  )
  if (!names) return matrix

  const { matrix: renamed, counts } = relabelMatrix(matrix, names, options.axis)
  for (const axis of axesOf(options.axis)) {
    const count = counts[axis]
    if (!count || count.total === 0 || count.named === count.total) continue
    if (count.named === 0) {
      ctx.warn(
        `No ${axis} are named by "${options.label}", so they keep the labels the matrix ` +
          `arrived with. Check Match on, or narrow Apply to.`,
      )
      continue
    }
    ctx.warn(
      `${(count.total - count.named).toLocaleString()} of ${count.total.toLocaleString()} ` +
        `${axis} are not named by the annotation table and keep their own labels.`,
    )
  }
  return renamed
}

/**
 * The Filter tab applied, saying out loud anything it could not do.
 *
 * Two things are warnings rather than refusals, and they are different states. **A pattern that
 * will not compile** leaves that axis whole — a half-typed `/^LC[` must not empty the picture
 * while somebody is still typing it. **A filter that matches nothing** is honoured and the
 * result is empty, because that is the honest answer to what was asked and the viewer already
 * says "Matrix is empty"; leaving the axis whole there would show a full matrix under a filter
 * that claims to have narrowed it.
 */
function filterMatrix(
  ctx: Pick<EvalContext, 'warn' | 'params'>,
  matrix: MatrixValue,
): { matrix: MatrixValue; kept: Partial<Record<MatrixAxis, Int32Array>> } {
  const filters = readFilterOptions(ctx.params)
  const kept: Partial<Record<MatrixAxis, Int32Array>> = {}

  for (const axis of ['rows', 'columns'] as const) {
    const { filter, error } = parseLabelFilter(axis === 'rows' ? filters.rows : filters.columns)
    if (error) {
      ctx.warn(
        `The ${axis} filter is not a valid regular expression (${error}), so every ` +
          `${axis === 'rows' ? 'row is' : 'column is'} kept.`,
      )
      continue
    }
    if (!filter) continue

    const labels = labelsOf(matrix, axis)
    const indices = keptLabels(labels, filter)
    if (indices.length === labels.length) continue
    if (indices.length === 0) {
      ctx.warn(`No ${axis} match "${filter.source}", so the result is empty.`)
    }
    kept[axis] = indices
  }

  // The lists come back with the matrix: the arrival names have to go through exactly the
  // same ones, and recomputing them against the filtered matrix is not possible at all.
  return { matrix: takeMatrix(matrix, kept.rows, kept.columns), kept }
}

/** One axis in clustermap order, or nothing to do for an axis with fewer than two lines. */
async function clusterAxis(
  ctx: Pick<EvalContext, 'warn' | 'progress' | 'signal'>,
  matrix: MatrixValue,
  axis: MatrixAxis,
  options: MatrixOrderOptions,
): Promise<Int32Array | undefined> {
  const n = labelsOf(matrix, axis).length
  if (n < 2) return undefined
  // Warns and refuses *before* anything is marshalled, which is where a warning is useful.
  checkClusterInput(ctx, matrix, axis)
  ctx.progress(0.01, `clustering ${n.toLocaleString()} ${axis}`)
  const order = await runClusterOrder(
    {
      // A copy: `callPython` transfers the buffer and this one is the upstream node's result.
      values: new Float64Array(matrix.values),
      rows: matrix.rowLabels.length,
      cols: matrix.colLabels.length,
      axis,
      method: options.method,
      metric: options.metric,
    },
    { onProgress: ctx.progress, signal: ctx.signal },
  )
  return options.reverse ? reverseOrder(order) : order
}
