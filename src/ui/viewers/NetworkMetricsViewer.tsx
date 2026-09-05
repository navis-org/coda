/**
 * The Network Metrics card: a graph's numbers as tiles, with the one histogram and the one
 * scatter that a number cannot stand in for.
 *
 * Tiles rather than a chart, on `DatasetSummaryViewer`'s model and sharing its primitives — a
 * `Tile`, a `Facts` list, a `Bars` row set — because the subject is the same shape: twenty
 * unrelated quantities, each read on its own, none of them comparable with the one beside it. A
 * chart of "density, reciprocity, transitivity" is three bars sharing an axis that means nothing.
 *
 * ## Why any plots at all
 *
 * Because several of these numbers are summaries of a distribution that is not remotely normal,
 * and the summary is where connectomics goes wrong. A mean degree of 14 describes a lattice and
 * a graph with four 3,000-partner hubs equally well; a median link weight of 3 says nothing
 * about whether the top percent of links carries a third of the synapses; and a component count
 * of 11,936 does not say whether that is one big graph with dust around it or genuine
 * fragmentation. So the card draws a histogram of whichever of those columns is asked for, and
 * a scatter of any two per-node columns — the thing that answers "do the hubs cluster?" without
 * another node.
 *
 * ## Four decisions
 *
 * **One histogram with a picker, not three fixed ones.** The card drew degree, link weight and
 * component size, which are the right three to look at first and an arbitrary three to be able
 * to look at *only*: `clustering`, `coreness`, `strength` and every column `net.centrality`
 * writes are distributions too, and none of them had a picture. The three tiles are still there
 * as numbers — nothing left the card — and the plot became a question anybody can point
 * anywhere. `histogramChoices` is the vocabulary, and it is in `networkMetrics.ts` because the
 * node offers the same list from the input's schema before anything has run.
 *
 * **The controls are on the tiles they change.** `CompletenessTile`'s arrangement, for its
 * reason: a control that changes what a plot *says* belongs where the plot is, not in a band
 * above the card where the plot is out of sight. Which is why all five params are `advanced` —
 * they are inspector-only precisely so that the card is the only place they appear twice.
 *
 * **The card reads the node's *input*, not its output.** Both carry the same topology, but
 * `networkMetrics` is memoised on the network object and `evaluate` was handed the input — so
 * reading the input is a cache hit and reading the output is a second triangle count on every
 * render. That is the same reason `out.describe`'s card rebuilds its summary from the value it
 * is given rather than being handed one.
 *
 * **One log switch, and it does two things, because on this data they are one thing.** A
 * connectome's degree, weight and component-size distributions are heavy-tailed enough to defeat
 * a linear histogram twice over: linear *bins* put nine tenths of the rows in the first bar and
 * leave four of the ten empty, and linear *bar lengths* then draw everything past the second bar
 * as an invisible sliver. Fixing one and not the other still reads as "there is nothing out
 * there", which is the opposite of what the tail says. So `logScale` bins in log10 and scales the
 * bars by `log1p` together — and the tile says how many rows a log axis had nothing to say about,
 * because a degree of 0 has no logarithm and an isolated node is exactly the sort of row that
 * should not leave a picture silently.
 *
 * **The scatter subsamples by stride and says so.** 36,000 SVG circles is not a picture and is
 * not a frame budget either; a stride is deterministic, which a random draw in a render function
 * would not be, and the caption names what was dropped. Nothing here silently truncates: the
 * house rule is that a cap is stated (docs/limits.md).
 */

import { useMemo } from 'react'

import { CHART_INK, currentMode, seriesColor } from '../colors'
import { tableToCsvParts } from '../export'
import { formatCompact, formatNumber, formatShare } from '../format'
import type { CellValue, NetworkValue, TableValue } from '../../core/values'
import { column, isNumericDType, tableSchema } from '../../core/types'
import { getRow, makeTable } from '../../core/values'
import { numericCell } from '../../nodes/lib/chartSelection'
import {
  COMPONENT_SIZE_COLUMN,
  histogramChoices,
  networkMetrics,
  parseHistogramChoice,
} from '../../nodes/lib/networkMetrics'
import type { BarRow } from './Tiles'
import { Bars, Columns, Facts, Tile } from './Tiles'
import type { ExportSource } from './ViewerActions'
import { ViewerActions } from './ViewerActions'
import type { Histogram } from './histogramBins'
import { binScan, columnStats, scanValues } from './histogramBins'

export interface NetworkMetricsViewerProps {
  /** The node's *input* network — see the header on why not its output. */
  network: NetworkValue
  /** Scatter axes, resolved columns of the node table (metrics included). */
  plotX?: string
  plotY?: string
  /** The histogram's `source:column` pair. See `parseHistogramChoice`. */
  histColumn: string
  /** Bars in the histogram; 0 is the automatic rule. */
  bins: number
  /** Columns rather than rows. See the node's param on why rows are the default. */
  histVertical: boolean
  logScale: boolean
  /*
   * Four writers rather than one `onParamChange`, which is `DatasetSummaryViewer`'s call and
   * keeps the param ids in the dispatcher where the rest of this node's are. Optional, because
   * a surface that cannot write params still draws the card — the controls then show the state
   * and refuse to change it, rather than the plots losing their headings.
   */
  onPlotX?: (column: string) => void
  onPlotY?: (column: string) => void
  onHistColumn?: (choice: string) => void
  onBins?: (bins: number) => void
  onHistVertical?: (vertical: boolean) => void
  compact?: boolean
  baseName?: string
  onExpand?: () => void
  onError?: (message: string) => void
}

/** Points drawn before the scatter starts striding. Past this it is ink, not information. */
const MAX_POINTS = 3000

/*
 * Three readers, and all three answer `undefined` to a null.
 *
 * That is what makes the tiles honest without a branch per row: `reciprocity` is null on an
 * undirected graph and `assortativity` is null on a regular one, and `Facts` drops a row with no
 * value — so the Structure tile shows the three facts that apply rather than three em-dashes and
 * a reader wondering which of them is a zero.
 *
 * Module-level rather than rebuilt inside the component, and `formatShare` rather than a fourth
 * spelling of "a number as a percentage": `DatasetSummaryViewer` prints its shares through that
 * function, and two tile grids disagreeing about how many decimal places a percentage has is
 * exactly the kind of difference nobody files and everybody notices.
 */
const reading =
  <T,>(format: (value: number) => T) =>
  (value: CellValue | undefined): T | undefined =>
    typeof value === 'number' ? format(value) : undefined

const percent = reading(formatShare)
const count = reading(formatNumber)
const decimal = (value: CellValue | undefined, places = 3) =>
  reading((n: number) => n.toFixed(places))(value)

/**
 * The one control shape on this card, in a tile's heading.
 *
 * **A value the options do not hold gets an option of its own.** Otherwise `<select>` shows
 * whichever option happens to be first while the node holds something else — a control that
 * silently misreports what is stored, and on a card whose whole subject is which column is being
 * drawn. Naming it as missing is the same call a column picker makes: keep what was chosen, say
 * that it is not there, and let the schema arrive.
 */
function Picker({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  onChange?: ((value: string) => void) | undefined
}) {
  const known = options.some((option) => option.value === value)
  return (
    <select
      className="tile__measure"
      value={value}
      aria-label={label}
      disabled={!onChange}
      onChange={(event) => onChange?.(event.target.value)}
    >
      {!known && <option value={value}>{value || '—'} (missing)</option>}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

/**
 * `4–8`, or the single value where a bin holds one.
 *
 * **Rounded on screen, exact in the tooltip**, and the split is about a fixed-width column
 * rather than about precision. A bar's label track is 4.5em of monospace — `11.4–16.6` is nine
 * characters and arrives as `11.4–16…`, which is a label that has stopped distinguishing itself
 * from the next one. Every column this card bins with a bin wider than 1 is a count of something
 * (partners, synapses, nodes in a component), so the tenths are an artefact of dividing an
 * integer range into ten and never a fact anybody reads off. Below that width — `clustering`,
 * `density` — the decimals are the whole number and are kept.
 */
function rangeLabel(lo: number, hi: number, exact = false): string {
  const round = !exact && hi - lo >= 1
  const a = formatCompact(round ? Math.round(lo) : lo)
  const b = formatCompact(round ? Math.round(hi) : hi)
  return a === b ? a : `${a}–${b}`
}

function binRows(histogram: Histogram, log: boolean): BarRow[] {
  let max = 0
  for (const bar of histogram.bars) if (bar.count > max) max = bar.count
  if (max === 0) return []
  return histogram.bars.map((bar, i) => ({
    /*
     * The bin's index is the key; the range is the label.
     *
     * Two bins round to the same printed range routinely at the low end of a heavy tail — `1–1`
     * and `1–2` both print as `1` — and `Bars` keys its rows on `key`, so a repeat has React
     * reuse one bin's row for another's count. Folding the index into the *label* instead is
     * what put `3:` in front of every bin on the card, which is how this came to be two fields.
     */
    key: `${i}`,
    label: rangeLabel(bar.lo, bar.hi),
    // `log1p`, so an empty bin is still 0 and a bin holding one is visible rather than being
    // `log(1)/log(max)`, which is also 0.
    fraction: log ? Math.log1p(bar.count) / Math.log1p(max) : bar.count / max,
    value: formatCompact(bar.count),
    title: `${rangeLabel(bar.lo, bar.hi, true)}: ${formatNumber(bar.count)}`,
  }))
}

/**
 * The histogram, pointed wherever the picker says.
 *
 * Horizontal rows rather than the vertical `Columns` next to it, and the choice survives the bin
 * count going up: a row carries its own range label at any length, where eighty columns is
 * eighty labels of four characters in about seven pixels each. `Columns` is also a *fixed*
 * 0–100% axis by construction — right for completeness, which is a fraction of something, and
 * wrong for counts, which have no ceiling to be a fraction of.
 */
function Distribution({
  choice,
  options,
  onChoose,
  table,
  valueColumn,
  bins,
  onBins,
  vertical,
  onVertical,
  log,
  color,
}: {
  choice: string
  options: Array<{ value: string; label: string }>
  onChoose?: ((choice: string) => void) | undefined
  table: TableValue | undefined
  valueColumn: string
  bins: number
  onBins?: ((bins: number) => void) | undefined
  vertical: boolean
  onVertical?: ((vertical: boolean) => void) | undefined
  log: boolean
  color: string
}) {
  /*
   * Three memos, which is what `histogramBins` prescribes and for its measured reason:
   * `scanValues` and `columnStats` are the only O(rows) halves, and `bins` is `presentational`,
   * so scrubbing it does not re-run the node — the scan *is* the whole cost of the drag. Keyed
   * together, the link-weight distribution re-walked every link on every pointer-move.
   */
  const scan = useMemo(
    () => (table ? scanValues(table, valueColumn, undefined, log) : undefined),
    [table, valueColumn, log],
  )
  const histogram = useMemo(
    () =>
      scan
        ? binScan(scan, bins > 0 ? { binMode: 'fixed', bins } : { binMode: 'auto' })
        : undefined,
    [scan, bins],
  )
  const rows = useMemo(() => (histogram ? binRows(histogram, log) : []), [histogram, log])
  // In value space whatever the axis is doing, and computed for this column alone — see
  // `columnStats` on why not `describeTable`.
  const stats = useMemo(
    () => (table ? columnStats(table, valueColumn) : undefined),
    [table, valueColumn],
  )

  /*
   * The numbers on the heading line rather than in a `Facts` block above the bars, which is
   * where they started and is worth writing down because it looks like the smaller decision.
   *
   * Four rows is about 70px, and it bought a *duplicate*: pointed at `degree` or `link weight` —
   * two of the three things anybody opens this on — every one of those numbers is already on a
   * tile a few inches up. What the block was actually for is the third case, `clustering` or
   * `coreness` or a centrality column, where the card holds no summary of the column at all. One
   * line does that job, and the 70px is the difference between ten bars clearing the fold and
   * two.
   *
   * `dropped` joins the same line rather than replacing anything: under a log axis a zero has no
   * bin, and on a degree column those are the isolated nodes — the rows most worth knowing about
   * are then missing from the picture, silently.
   */
  const note = [
    stats ? `mean ${stats.mean.toFixed(1)}` : undefined,
    stats ? `median ${stats.median.toFixed(1)}` : undefined,
    stats ? `max ${formatCompact(stats.max)}` : undefined,
    rows.length > 0 ? `${rows.length} bins` : undefined,
    log && histogram && histogram.dropped > 0
      ? `${formatNumber(histogram.dropped)} at 0`
      : undefined,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <Tile
      label="Distribution"
      qualifier={note || undefined}
      wide
      action={
        <>
          <Picker
            label="Distribution column"
            value={choice}
            options={options}
            onChange={onChoose}
          />
          {/*
           * A number rather than a second `<select>` of preset counts: the useful range is 4 to
           * about 40 and somebody comparing two graphs wants the same count on both, which a
           * list of presets can only approximate. 0 is the automatic rule — see the node's own
           * note on why that is a sentinel rather than a mode param beside it.
           */}
          <input
            className="tile__bins"
            type="number"
            min={0}
            max={80}
            step={1}
            value={bins}
            aria-label="Bin count"
            title="Bars in the histogram — 0 for the automatic rule"
            disabled={!onBins}
            onChange={(event) =>
              onBins?.(Math.max(0, Math.round(Number(event.target.value) || 0)))
            }
          />
          {/*
           * A checkbox rather than a two-option `<select>`, because the two shapes are one
           * property of one plot rather than a choice between two things — and because the
           * heading already carries two dropdowns, where a third would read as a third subject.
           */}
          <label className="tile__toggle" title="Draw the histogram as vertical columns">
            <input
              type="checkbox"
              checked={vertical}
              disabled={!onVertical}
              aria-label="Vertical bars"
              onChange={(event) => onVertical?.(event.target.checked)}
            />
            vertical
          </label>
        </>
      }
    >
      {rows.length > 0 ? (
        // One row set, two shapes: `ColumnBar` is `BarRow` minus the fields the rows use, so the
        // binning does not have to know which way up the tile is drawing it.
        vertical ? (
          /*
           * Wrapped in a class rather than given a prop, which is the dashboard's rule for the
           * same situation: density is CSS's, and the frame restyles the inside without the
           * shared component learning a caller by name. Three of `Columns`' numbers are sized
           * for a six-region completeness chart and wrong for a histogram — see the stylesheet.
           */
          <div className="metrics__columns">
            <Columns bars={rows} color={color} />
          </div>
        ) : (
          <Bars rows={rows} color={color} />
        )
      ) : (
        // Two different nothings, and the difference is the reader's next move: a column the
        // network does not carry is a picker to change, and an empty one is a graph to look at.
        <p className="tile__pending">{table ? 'Nothing to bin' : `No ${valueColumn} column`}</p>
      )}
    </Tile>
  )
}

/**
 * Two per-node columns against each other.
 *
 * Hand-drawn rather than `ScatterViewer` in a tile: that component owns a canvas, a selection,
 * an export registration and an axis pair sized for a card of its own, none of which a 190px
 * grid cell has room for. What is wanted here is the *shape* — whether the hubs are the
 * clustered ones — at a size where a legend would not fit anyway.
 */
function Scatter({
  nodes,
  x,
  y,
  columns,
  onX,
  onY,
  color,
  ink,
}: {
  nodes: TableValue
  x: string | undefined
  y: string | undefined
  columns: Array<{ value: string; label: string }>
  onX?: ((column: string) => void) | undefined
  onY?: ((column: string) => void) | undefined
  color: string
  ink: string
}) {
  const plot = useMemo(() => {
    if (!x || !y || !nodes.data[x] || !nodes.data[y]) return undefined
    const xs = nodes.data[x]!
    const ys = nodes.data[y]!
    const stride = Math.max(1, Math.ceil(nodes.length / MAX_POINTS))
    const points: Array<[number, number]> = []
    let skipped = 0
    for (let row = 0; row < nodes.length; row += stride) {
      const a = numericCell(xs[row])
      const b = numericCell(ys[row])
      // A null on either axis is a point with no position, not a point at zero. Counted, so the
      // caption can say a third of the nodes are missing from the picture.
      if (a === undefined || b === undefined) {
        skipped++
        continue
      }
      points.push([a, b])
    }
    if (points.length === 0) return undefined
    let loX = Infinity
    let hiX = -Infinity
    let loY = Infinity
    let hiY = -Infinity
    for (const [a, b] of points) {
      if (a < loX) loX = a
      if (a > hiX) hiX = a
      if (b < loY) loY = b
      if (b > hiY) hiY = b
    }
    const spanX = hiX > loX ? hiX - loX : 1
    const spanY = hiY > loY ? hiY - loY : 1
    /*
     * One path string rather than 3,000 elements.
     *
     * The marks were `<line>` elements built in the render body, so every store tick created
     * 3,000 elements and reconciled them against 3,000 fibers — including ticks that changed
     * nothing about this node. Built here, the string is memoised with the points it describes
     * and the DOM holds one node.
     *
     * A zero-length subpath with a round cap is a dot, and `vector-effect` keeps the stroke in
     * screen pixels — which is the whole trick, since `preserveAspectRatio="none"` scales x and
     * y by different factors and would draw a `<circle>` as an ellipse.
     */
    const marks = points
      .map(([a, b]) => {
        const px = ((a - loX) / spanX) * 96 + 2
        // SVG's y runs down and a plot's runs up.
        const py = 60 - (((b - loY) / spanY) * 56 + 2)
        return `M${px.toFixed(2)} ${py.toFixed(2)}l0 0`
      })
      .join('')
    return { marks, loX, hiX, loY, hiY, skipped, shown: points.length, total: nodes.length }
  }, [nodes, x, y])

  /*
   * The axis pickers ride on the tile whatever state the plot is in, and that is the point of
   * moving them here: "pick two numeric node columns" with no picker on screen is an instruction
   * to go and find one.
   */
  const action = (
    <>
      <Picker label="Scatter x axis" value={x ?? ''} options={columns} onChange={onX} />
      <Picker label="Scatter y axis" value={y ?? ''} options={columns} onChange={onY} />
    </>
  )

  if (!x || !y) {
    return (
      <Tile label="Scatter" wide action={action}>
        <p className="tile__pending">Pick two numeric node columns</p>
      </Tile>
    )
  }
  if (!plot) {
    return (
      <Tile label="Scatter" qualifier={`${y} × ${x}`} wide action={action}>
        <p className="tile__pending">No node has both</p>
      </Tile>
    )
  }

  // A unit box the CSS scales; `preserveAspectRatio="none"` because the axes are unrelated
  // quantities and forcing them square would waste most of a wide tile.
  const note =
    plot.shown < plot.total
      ? `${formatNumber(plot.shown)} of ${formatNumber(plot.total)} nodes`
      : `${formatNumber(plot.shown)} nodes`

  return (
    <Tile label="Scatter" qualifier={`${y} × ${x}`} wide action={action}>
      <svg
        className="metrics__scatter"
        viewBox="0 0 100 60"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${y} against ${x}`}
      >
        <rect x="0" y="0" width="100" height="60" fill="none" stroke={ink} strokeWidth="0.3" />
        {/* The marks, as one path. See `marks` in the memo above for why it is a path. */}
        <path
          d={plot.marks}
          fill="none"
          stroke={color}
          strokeWidth="3"
          strokeLinecap="round"
          strokeOpacity="0.55"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <dl className="tile__facts">
        <div className="tile__fact">
          <dt>{x}</dt>
          <dd>
            {formatCompact(plot.loX)} – {formatCompact(plot.hiX)}
          </dd>
        </div>
        <div className="tile__fact">
          <dt>{y}</dt>
          <dd>
            {formatCompact(plot.loY)} – {formatCompact(plot.hiY)}
          </dd>
        </div>
        <div className="tile__fact">
          <dt>drawn</dt>
          <dd>{note}</dd>
        </div>
      </dl>
    </Tile>
  )
}

const SIZE_SCHEMA = tableSchema(column(COMPONENT_SIZE_COLUMN, 'i64'))

export function NetworkMetricsViewer({
  network,
  plotX,
  plotY,
  histColumn,
  bins,
  histVertical,
  logScale,
  onPlotX,
  onPlotY,
  onHistColumn,
  onBins,
  onHistVertical,
  compact,
  baseName,
  onExpand,
  onError,
}: NetworkMetricsViewerProps) {
  const mode = currentMode()
  const ink = CHART_INK[mode]
  const metrics = useMemo(() => networkMetrics(network), [network])
  // `getRow` rather than a local re-spelling of it; the summary is always exactly one row.
  const row = useMemo(() => getRow(metrics.summary, 0), [metrics])
  const nodes = metrics.network.nodes
  const edges = metrics.network.edges

  /**
   * One row per component, so the third source has something to bin.
   *
   * The sizes come off the result rather than being re-grouped from the per-node `component`
   * column: the walk that numbered the components already counted them, and re-deriving them
   * here was a pass over every node to rebuild a map the library had thrown away.
   */
  const componentSizes = useMemo(
    () => makeTable(SIZE_SCHEMA, { [COMPONENT_SIZE_COLUMN]: metrics.componentSizes }),
    [metrics],
  )

  /*
   * The two vocabularies the pickers offer, both from the tables actually in hand.
   *
   * `histogramChoices` is shared with the node, which builds the same list from the input's
   * schema — the card's copy is the one that can see a column the schema did not carry, so the
   * two agreeing is a property of the function rather than of two lists being kept in step.
   */
  const histOptions = useMemo(
    () => histogramChoices(nodes.schema, edges.schema),
    [nodes.schema, edges.schema],
  )
  const nodeColumns = useMemo(
    () =>
      nodes.schema.columns
        .filter((col) => isNumericDType(col.dtype))
        .map((col) => ({ value: col.name, label: col.name })),
    [nodes.schema],
  )

  const choice = parseHistogramChoice(histColumn)
  const histTable =
    choice.source === 'nodes' ? nodes : choice.source === 'links' ? edges : componentSizes

  /*
   * CSV of the summary row, which is what the card is *of*.
   *
   * The per-node numbers are a port an inch away and export like any other table, so offering
   * them here as well would be two routes to one file. There is no SVG: the card is a grid of
   * tiles, several drawing their own picture, and a vector export would have to invent a
   * composite that nothing renders — `DatasetSummaryViewer`'s call, for its reason.
   */
  const exportSource: ExportSource = {
    csv: () => tableToCsvParts(metrics.summary),
  }

  const caption = [
    `${count(row['nodes'])} nodes`,
    `${count(row['links'])} links`,
    row['directed'] ? 'directed' : 'undirected',
    `${count(row['components'])} components`,
    metrics.dangling > 0 ? `${formatNumber(metrics.dangling)} links dropped` : undefined,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="viewer summary">
      <div className="tiles nowheel">
        <Tile label="Graph">
          <Facts
            rows={[
              ['nodes', count(row['nodes'])],
              ['links', count(row['links'])],
              ['density', decimal(row['density'], 4)],
              ['isolated', count(row['isolated'])],
              ['self-loops', count(row['selfLoops'])],
              // Only when there are some: a `0` here is a row spent saying nothing, and a
              // network out of Build Network with merging on can never have any.
              [
                'parallel',
                Number(row['parallelLinks']) > 0 ? count(row['parallelLinks']) : undefined,
              ],
            ]}
          />
        </Tile>

        {/*
          Degree and link weight are tiles of their own because the histogram is now a question
          rather than three fixed answers: pointed at `clustering`, it would otherwise take the
          only mean degree on the card with it. Numbers a reader compares across graphs should
          not depend on which plot happens to be open.
        */}
        <Tile label="Degree" qualifier="in + out">
          <Facts
            rows={[
              ['mean', decimal(row['meanDegree'], 1)],
              ['median', decimal(row['medianDegree'], 1)],
              ['max', count(row['maxDegree'])],
            ]}
          />
        </Tile>

        <Tile label="Link weight">
          <Facts
            rows={[
              ['total', count(row['totalWeight'])],
              ['mean', decimal(row['meanWeight'], 1)],
              ['median', decimal(row['medianWeight'], 1)],
              ['max', count(row['maxWeight'])],
            ]}
          />
        </Tile>

        <Tile label="Structure" qualifier={row['directed'] ? 'directed' : 'undirected'}>
          <Facts
            rows={[
              // Null where the question does not apply — undirected reciprocity, a regular
              // graph's assortativity — and `Facts` drops a row with no value, so the tile
              // shows three facts rather than three em-dashes.
              ['reciprocity', percent(row['reciprocity'])],
              ['clustering', decimal(row['meanClustering'])],
              ['transitivity', decimal(row['transitivity'])],
              ['assortativity', decimal(row['assortativity'])],
            ]}
          />
        </Tile>

        <Tile label="Components">
          <Facts
            rows={[
              ['count', count(row['components'])],
              ['largest', count(row['largestComponent'])],
              [
                'in largest',
                Number(row['nodes']) > 0
                  ? percent(Number(row['largestComponent']) / Number(row['nodes']))
                  : undefined,
              ],
            ]}
          />
        </Tile>

        {/*
          The scatter sits above the histogram, and that order is a measurement rather than a
          preference. The distributions were three tiles of ten bins each, about 900px of card,
          and below them the scatter started off the bottom of a 620px default and stayed there —
          a plot nobody scrolls to is a plot that is not on the card. One histogram makes that
          less acute and not untrue: at forty bins it is still the taller of the two.
        */}
        <Scatter
          nodes={nodes}
          x={plotX}
          y={plotY}
          columns={nodeColumns}
          onX={onPlotX}
          onY={onPlotY}
          color={seriesColor(3, mode)}
          ink={ink.muted}
        />

        <Distribution
          choice={histColumn}
          options={histOptions}
          onChoose={onHistColumn}
          table={histTable.data[choice.column] ? histTable : undefined}
          valueColumn={choice.column}
          bins={bins}
          onBins={onBins}
          vertical={histVertical}
          onVertical={onHistVertical}
          log={logScale}
          color={seriesColor(0, mode)}
        />
      </div>

      <div className="viewer__caption">
        <span>{caption}</span>
        <ViewerActions
          baseName={baseName ?? 'network-metrics'}
          source={exportSource}
          compact={compact}
          {...(onExpand ? { onExpand } : {})}
          {...(onError ? { onError } : {})}
        />
      </div>
    </div>
  )
}
