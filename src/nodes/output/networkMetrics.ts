import { warnOverThreshold } from '../../core/limits'
import type { CodaType } from '../../core/types'
import { registerNode } from '../../core/registry'
import { NUMERIC_DTYPES, T, attributeSchema } from '../../core/types'
import { isNetworkValue } from '../../core/values'
import {
  CATEGORICAL_DTYPES,
  COLOR_AS_OPTIONS,
  HISTOGRAM_MAX_BINS,
  DEFAULT_HISTOGRAM_CHOICE,
  METRIC_COLUMNS,
  TRIANGLE_WORK_WARN,
  histogramChoices,
  metricNodeSchema,
  networkMetrics,
  networkSummarySchema,
  nodeStatsSchema,
} from '../lib/networkMetrics'
import { ROLLUPS } from '../lib/networkOps'

/**
 * The node schema this node produces, written once.
 *
 * Read by `inferOutputs` and by both scatter pickers' `schemaFrom`. Invariant 5's point is that
 * infer, validate, evaluate and the cache key all resolve a column the same way — held here by
 * one expression rather than by three copies of it agreeing.
 */
const outputNodeSchema = (inputs: Readonly<Record<string, CodaType | undefined>>) =>
  metricNodeSchema(attributeSchema(inputs['in'], 'nodes'))

/**
 * What shape is this graph? — asked of the topology rather than of the picture.
 *
 * The question somebody asks of a connectivity network before reading anything off it: how much
 * of it is one connected piece, whether the degree distribution has a tail or a bulge, whether
 * partners connect to each other or only through hubs, and how much of the link weight sits in
 * the top few percent. The network viewer answers those by drawing them, which works up to the
 * point where the drawing is a hairball and the interesting fact is that 60% of the nodes are
 * in components of size two.
 *
 * A **tap** with a card, on `out.describe`'s model, and the parallel is close enough to be worth
 * naming: `Network` is the input carrying on (with the metric columns written onto it), and
 * `Node stats` and `Summary` are real tables rather than drawings, so they sort, filter, join
 * and export like anything else. The one difference is that this tap's pass-through is *not*
 * unchanged — it carries the metrics, which is what makes `size by clustering` in a viewer
 * downstream a column picker rather than a second node.
 *
 * **`cheap`, and every metric here is chosen to keep that true.** One pass over the links for
 * the degrees, one CSR build, a linear peel for k-core, a breadth-first walk for the components
 * — all O(V + E). The single exception is the triangle count behind `clustering` and
 * `transitivity`, which is measured before it is run and warns rather than refusing; see
 * `TRIANGLE_WORK_WARN`. Everything that is genuinely not linear — betweenness, closeness,
 * PageRank, communities — is `net.centrality`, a separate node marked `expensive`, whose columns
 * this card will happily plot when it is wired upstream.
 *
 * **Five settings, all presentational, and none of them on the param band.** They decide what
 * the card draws and nothing else: the three ports carry the same values whatever they are set
 * to, which is what makes marking them `presentational: true` correct rather than convenient
 * (invariant 4). Being *only* what the card draws is also why every one of them is `advanced` —
 * the controls are in the card body, beside the plot each one changes, and a second copy of the
 * scatter's axes in a band above it is two controls for one decision. The inspector keeps them
 * for the surface that has no card.
 *
 * There is deliberately no control that turns a metric off — the statistics are what the node
 * *is*, the same call `out.describe` makes, and a summary missing whichever numbers somebody
 * unticked is a table that no longer matches its own name.
 */
registerNode({
  type: 'net.metrics',
  label: 'Network Metrics',
  category: 'visualisation',
  description:
    'Graph statistics for a network: degree, clustering and components per node, and density for the whole graph.',
  guide:
    'Computes graph statistics for a network from Build Network: degree, clustering, k-core and ' +
    'components per node, plus density, reciprocity and more for the whole graph. The network ' +
    'passes through with the per-node metrics attached, so a viewer downstream can colour by them.',
  cost: 'cheap',
  /*
   * Wider and taller than the chart viewers: this is a tile grid with two plots under it, and
   * Dataset Summary — the other card of that shape — opens at 560 × 620. Wider here because the
   * histogram is horizontal bars with a label and a value on each row.
   *
   * The height is measured rather than chosen. Five fact tiles come to two grid rows at this
   * width (~250px), the scatter with its axis readout is ~190, and ten bars with a heading is
   * ~175: 640 and a caption. At 620 the histogram opened with two bars showing and the rest
   * below the fold, which for a plot that is now the card's one question is the same as not
   * drawing it.
   */
  defaultSize: { width: 620, height: 700 },
  inputs: [{ id: 'in', label: 'Network', type: T.network() }],
  outputs: [
    /*
     * The network first, so a link dragged off this node continues the chain — `out.table`'s
     * call and `out.describe`'s, and here it is also the value the card draws.
     */
    { id: 'out', label: 'Network', type: T.network() },
    { id: 'nodes', label: 'Node stats', type: T.table(nodeStatsSchema()) },
    { id: 'summary', label: 'Summary', type: T.table(networkSummarySchema()) },
  ],
  params: [
    {
      /*
       * The scatter's two axes, offered over the *output* node schema rather than the input's.
       *
       * `from: 'in'` still says which port has to be connected — that is what it is for — while
       * `schemaFrom` says where the columns come from, which here is the schema this node is
       * about to produce. Without it the picker would offer whatever the incoming network
       * happened to carry and none of the metrics, which is the entire content of the plot.
       */
      id: 'plotX',
      kind: 'column',
      label: 'Plot x',
      from: 'in',
      schemaFrom: outputNodeSchema,
      dtypes: NUMERIC_DTYPES,
      // Named rather than empty: `degree` against `clustering` is the plot somebody would draw
      // first, and "first compatible column" would give `degreeIn` against `degreeIn`.
      default: 'degree',
      presentational: true,
      advanced: true,
      help: 'The x axis of the card’s scatter. Any numeric node column, including the metrics.',
    },
    {
      id: 'plotY',
      kind: 'column',
      label: 'Plot y',
      from: 'in',
      schemaFrom: outputNodeSchema,
      dtypes: NUMERIC_DTYPES,
      default: 'clustering',
      presentational: true,
      advanced: true,
      help: 'The y axis of the card’s scatter.',
    },
    /*
     * The scatter's three other channels, all `optional`: empty is "not encoded", and on an
     * optional picker that is a decision rather than an unset default (rule 3 would otherwise
     * hand each the first compatible column). Presentational for the axes' reason — the ports
     * carry the same values whatever the card draws.
     */
    {
      id: 'plotColor',
      kind: 'column',
      label: 'Plot colour',
      from: 'in',
      schemaFrom: outputNodeSchema,
      // Any kind of column: a number takes a ramp, text a palette. A carried `neuronId` is left
      // out, being one colour per point and a legend of eighteen-digit numbers.
      excludeIds: true,
      default: '',
      optional: true,
      presentational: true,
      advanced: true,
      help: 'Colour the scatter’s points by a node column. Numbers take a colour ramp, text a palette.',
    },
    {
      /*
       * Whether an *integer* colour column is a quantity or a set of labels.
       *
       * The dtype cannot say: `degree` and `coreness` are quantities, while `component` and
       * Centrality's `community` are labels, and a ramp over labels makes neighbouring ids look
       * related. A float is always a value and text always a category, so this applies to `i64`
       * alone — which is why the card shows it only beside an integer column. `visibleIf` cannot
       * see a schema, so the inspector shows it whenever a colour column is set at all.
       */
      id: 'plotColorAs',
      kind: 'enum',
      label: 'Integer colour as',
      default: 'value',
      options: COLOR_AS_OPTIONS,
      visibleIf: (params) => typeof params.plotColor === 'string' && params.plotColor !== '',
      presentational: true,
      advanced: true,
      help: 'For a whole-number colour column: a ramp (`by value`, for counts like `degree`) or one colour per value (`by category`, for labels like `component`).',
    },
    {
      id: 'plotSize',
      kind: 'column',
      label: 'Plot size',
      from: 'in',
      schemaFrom: outputNodeSchema,
      dtypes: NUMERIC_DTYPES,
      default: '',
      optional: true,
      presentational: true,
      advanced: true,
      help: 'Size the scatter’s points by a numeric node column. The value scales with the point’s area.',
    },
    {
      id: 'plotShape',
      kind: 'column',
      label: 'Plot marker',
      from: 'in',
      schemaFrom: outputNodeSchema,
      // Categorical: text, booleans and whole numbers. A float has no categories to give a mark.
      dtypes: CATEGORICAL_DTYPES,
      excludeIds: true,
      default: '',
      optional: true,
      presentational: true,
      advanced: true,
      help: 'Give each value of a node column its own marker. Six markers; any further values share a dash.',
    },
    {
      /*
       * Which of the three tables the histogram bins, as a `source:column` pair.
       *
       * One plot rather than the three fixed ones this card had, because the fixed three were
       * an arbitrary three: degree, link weight and component size are the distributions worth
       * looking at first, but `clustering`, `coreness`, `strength` and every column
       * `net.centrality` writes are distributions too, and none of them had a picture. Three
       * tiles that could not answer a fourth question is worse than one that answers any.
       *
       * `enum` with an options *function*, not a `column` param: the three tables are three
       * different row counts, so there is no single schema to resolve against.
       * `histogramChoices` is the vocabulary, shared with the card — see its note.
       */
      id: 'histColumn',
      kind: 'enum',
      label: 'Distribution',
      default: DEFAULT_HISTOGRAM_CHOICE,
      optionsWithoutPeek: true,
      options: (ctx) =>
        histogramChoices(
          attributeSchema(ctx.inputs['in'], 'nodes'),
          attributeSchema(ctx.inputs['in'], 'edges'),
        ),
      advanced: true,
      presentational: true,
      help: 'Which distribution the card’s histogram draws. Any numeric node column, any link column, or the component sizes.',
    },
    {
      id: 'bins',
      kind: 'int',
      label: 'Bins',
      /*
       * 0 is automatic, which is Freedman–Diaconis as `out.histogram` uses it.
       *
       * A single number rather than that node's `binMode` enum plus a count: two controls for
       * one decision is one too many on a tile heading, and there is no bin count of zero for
       * the sentinel to collide with.
       *
       * The default is a fixed ten rather than automatic, and that is about this card rather
       * than about binning. A bar here is a labelled *row*, so the tile's height is the bin
       * count — and Freedman–Diaconis on a heavy-tailed degree column asks for its ceiling,
       * which would open every card on a tile taller than the card.
       *
       * `max` is a few hundred because binning is one pass whatever the count, and the drawing
       * is what has to cope: as columns the card thins its labels to the ones that fit and puts
       * every bar's count in its tooltip. As rows each bin is a line of its own, so hundreds of
       * them make a very tall tile; that is the reader's choice to make, and the help says so.
       */
      default: 10,
      min: 0,
      max: HISTOGRAM_MAX_BINS,
      advanced: true,
      presentational: true,
      help: 'Number of histogram bars, or 0 for automatic. Past a few dozen, draw them as vertical bars.',
    },
    {
      /*
       * Vertical or horizontal, and horizontal is the default because of the labels.
       *
       * A bin's label is a *range* — `11–17` — where a completeness column's is a region name,
       * and `Columns` sets its keys in vertical text. Rotated, ten of those are legible and
       * forty are a picket fence; as rows they are a fixed-width column that stays readable at
       * any bin count. So the shape that survives the control above it is the default, and the
       * other is a checkbox for when a histogram should look like one.
       */
      id: 'histVertical',
      kind: 'boolean',
      label: 'Vertical bars',
      default: false,
      advanced: true,
      presentational: true,
      help: 'Draw the histogram as vertical columns.',
    },
    {
      /*
       * Log-scaled *bars*, not a log axis.
       *
       * A connectome's degree distribution is heavy-tailed enough that the modal bin is three
       * orders of magnitude above the tail, and on a linear scale every bar past the second is
       * an invisible sliver — which reads as "there is nothing out there" rather than as the
       * tail that is the whole reason to look.
       *
       * Left in the inspector rather than put on the tile with the other two: it is a fact
       * about how the bars are drawn rather than about which numbers they are, and a heading
       * with four controls on it is a toolbar.
       */
      id: 'logScale',
      kind: 'boolean',
      label: 'Log counts',
      default: false,
      advanced: true,
      presentational: true,
      help: 'Scale the distribution bars logarithmically, so a long tail stays visible.',
    },
  ],

  /*
   * Exact before anything runs, all three. The two tables are constants (see `networkMetrics.ts`
   * on why), and the network's node schema is the input's with the metric names folded in — so a
   * picker downstream of any of the three fills the moment the wire is drawn.
   */
  inferOutputs: (ctx) => ({
    out: T.network(outputNodeSchema(ctx.inputs), attributeSchema(ctx.inputs['in'], 'edges')),
    nodes: T.table(nodeStatsSchema()),
    summary: T.table(networkSummarySchema()),
  }),

  evaluate: (ctx) => {
    const network = ctx.input('in')
    if (!isNetworkValue(network)) throw new Error('Input is not a network')

    /*
     * The guard rails are raised here rather than inside `networkMetrics`, which is
     * `out.describe`'s arrangement and not a stylistic echo of it.
     *
     * `networkMetrics` is memoised on the network object, and the *card* calls it too — from
     * this node's input, so that the two calls share one triangle count. Warning from inside
     * therefore hands the message to whichever caller arrived first, and on the ordinary chain
     * that is the card, with a silent warner. `triangleWork` is an O(E) pass the library runs
     * before the nested loop, so the cost is still stated before it is paid.
     */
    const result = networkMetrics(network)
    if (result.triangleWork > TRIANGLE_WORK_WARN) {
      warnOverThreshold(ctx, {
        count: result.triangleWork,
        threshold: TRIANGLE_WORK_WARN,
        unit: 'neighbour comparisons',
        control: 'what a clustering coefficient is usually computed over',
        cost:
          'Counting triangles compares the neighbours of every pair of linked nodes, and a ' +
          'few highly connected nodes make that very slow.',
      })
    }
    if (result.dangling > 0) {
      ctx.warn(
        `${result.dangling.toLocaleString()} of ${network.edges.length.toLocaleString()} ` +
          `links point to a node that is not in this network and were not counted. This is ` +
          `normal after a filter, but unexpected straight out of Build Network.`,
      )
    }

    /*
     * Said once, and only when it is true: these names are being written over.
     *
     * `net.build` emits `ROLLUPS` itself, so on the ordinary chain this is silent — and that
     * list is imported rather than retyped, because a second spelling of a documented set is how
     * the two come to disagree. It is the network carrying a *joined* `component` or `strength`
     * column that the reader needs to know about, because the column they picked yesterday now
     * holds something else.
     */
    const overwritten = network.nodes.schema.columns
      .map((c) => c.name)
      .filter((name) => METRIC_COLUMNS.includes(name))
      .filter((name) => !(ROLLUPS as readonly string[]).includes(name))
    if (overwritten.length > 0) {
      ctx.warn(
        `The node table already had ${overwritten.join(', ')}. The new metric` +
          `${overwritten.length > 1 ? 's replaced them' : ' replaced it'}, so pickers ` +
          `downstream see only the new values.`,
      )
    }

    return { out: result.network, nodes: result.nodeStats, summary: result.summary }
  },
})
