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
 * above the card where the plot is out of sight. Which is why the plot params are all `advanced` —
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

import type { ReactNode } from 'react'
import { useMemo } from 'react'

import type { Mode } from '../colors'
import { CHART_INK, currentMode, seriesColor } from '../colors'
import { resolveColor, resolveShape, resolveSize } from '../encoding'
import { tableToCsvParts } from '../export'
import { formatCompact, formatNumber, formatShare, labelStep, plural } from '../format'
import type { CellValue, ColumnData, NetworkValue, TableValue } from '../../core/values'
import type { ColumnSchema, DType } from '../../core/types'
import { NUMERIC_DTYPES, column, columnsOfType, tableSchema } from '../../core/types'
import { getRow, makeTable } from '../../core/values'
import type { ColorAs } from '../../nodes/lib/networkMetrics'
import {
  CATEGORICAL_DTYPES,
  COLOR_AS_OPTIONS,
  COMPONENT_SIZE_COLUMN,
  HISTOGRAM_MAX_BINS,
  histogramChoices,
  networkMetrics,
  parseHistogramChoice,
} from '../../nodes/lib/networkMetrics'
import { ID_COLUMN_NAME } from '../../core/ids'
import { ColorKey, ShapeKey, SizeKey } from './LegendKeys'
import { markPath } from './scatterDraw'
import { buildMarks, viewAffine } from './scatterPlot'
import type { BarRow } from './Tiles'
import { Bars, Columns, Facts, Tile } from './Tiles'
import type { ExportSource } from './ViewerActions'
import { ViewerActions } from './ViewerActions'
import type { Histogram } from './histogramBins'
import { binScan, columnStats, scanValues } from './histogramBins'
import { useElementSize } from './useElementSize'

export interface NetworkMetricsViewerProps {
  /** The node's *input* network — see the header on why not its output. */
  network: NetworkValue
  /** Scatter axes, resolved columns of the node table (metrics included). */
  plotX?: string
  plotY?: string
  /** The scatter's other channels, resolved columns; undefined is "not encoded". */
  plotColor?: string
  /** Whether an integer colour column is a ramp or a palette — see `scatterColorMode`. */
  plotColorAs: ColorAs
  plotSize?: string
  plotShape?: string
  /** The histogram's `source:column` pair. See `parseHistogramChoice`. */
  histColumn: string
  /** Bars in the histogram; 0 is the automatic rule. */
  bins: number
  /** Columns rather than rows. See the node's param on why rows are the default. */
  histVertical: boolean
  logScale: boolean
  /*
   * One writer per control rather than one `onParamChange`, which is `DatasetSummaryViewer`'s call and
   * keeps the param ids in the dispatcher where the rest of this node's are. Optional, because
   * a surface that cannot write params still draws the card — the controls then show the state
   * and refuse to change it, rather than the plots losing their headings.
   */
  onPlotX?: (column: string) => void
  onPlotY?: (column: string) => void
  onPlotColor?: (column: string) => void
  onPlotColorAs?: (as: string) => void
  onPlotSize?: (column: string) => void
  onPlotShape?: (column: string) => void
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

/*
 * What a column's two labels need, in px. A count is 8.5px monospace, about 5.2px a character;
 * a range key is set vertically in 9px type, so it needs a line's height across, not its length.
 */
const VALUE_CHAR_PX = 5.2
const KEY_LINE_PX = 14
/** Below this many px per bar a 1px gap is a fifth of the bar or more, so the bars touch. */
const DENSE_BAR_PX = 4

/** How a column chart at this width is labelled. Primitives, so a resize that changes none of them costs nothing. */
export interface ThinPlan {
  /** Print the counts above the bars. */
  values: boolean
  /** Print every `stride`-th range key. */
  stride: number
  /** Bars too narrow for a gap between them. */
  dense: boolean
}

const UNTHINNED: ThinPlan = { values: true, stride: 1, dense: false }

/**
 * Columns at a bin count their labels cannot all fit, labelled with the ones that do.
 *
 * The counts above the bars go **all or nothing**: a row holding every third count reads as
 * three-in-a-row being empty. The range keys under them are an axis, so they thin to every
 * `stride`-th bar through `labelStep`, the rule the heatmap, dendrogram and Histogram node thin
 * their axes by. Nothing is lost either way — each bar keeps its full `title`, range and count,
 * for the hover.
 *
 * `width` 0 is "not measured yet" (and jsdom, always), and draws everything: thinning before
 * the first measurement would flash a bare axis on every mount.
 */
export function thinPlan(rows: BarRow[], width: number): ThinPlan {
  if (width <= 0 || rows.length === 0) return UNTHINNED
  const cell = width / rows.length
  let longest = 0
  for (const row of rows) longest = Math.max(longest, row.value.length)
  return {
    values: longest * VALUE_CHAR_PX <= cell,
    stride: labelStep(rows.length, width, KEY_LINE_PX),
    dense: cell < DENSE_BAR_PX,
  }
}

/** The rows with what `plan` leaves out blanked. The same array when it leaves out nothing. */
export function thinColumns(
  rows: BarRow[],
  { values, stride }: Pick<ThinPlan, 'values' | 'stride'>,
): BarRow[] {
  if (values && stride === 1) return rows
  return rows.map((row, i) => ({
    ...row,
    value: values ? row.value : '',
    label: i % stride === 0 ? row.label : '',
  }))
}

/** `Columns` at whatever width it is given — see `thinPlan`. */
function ThinnedColumns({ rows, color }: { rows: BarRow[]; color: string }) {
  const [ref, size] = useElementSize<HTMLDivElement>()
  const { values, stride, dense } = thinPlan(rows, size.width)
  // Keyed on the plan's fields rather than the width, so a resize re-maps the rows only when the
  // stride actually steps.
  const bars = useMemo(() => thinColumns(rows, { values, stride }), [rows, values, stride])
  /*
   * Wrapped in a class rather than given a prop, which is the dashboard's rule for the same
   * situation: density is CSS's, and the frame restyles the inside without the shared component
   * learning a caller by name. Three of `Columns`' numbers are sized for a six-region
   * completeness chart and wrong for a histogram — see the stylesheet.
   */
  return (
    <div ref={ref} className="metrics__columns" data-dense={dense || undefined}>
      <Columns bars={bars} color={color} />
    </div>
  )
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
      action={
        <>
          <Picker
            label="Distribution column"
            value={choice}
            options={options}
            onChange={onChoose}
          />
          {/*
           * A number rather than a second `<select>` of preset counts: the useful range runs from
           * 4 to a few hundred and somebody comparing two graphs wants the same count on both, which a
           * list of presets can only approximate. 0 is the automatic rule — see the node's own
           * note on why that is a sentinel rather than a mode param beside it.
           */}
          <input
            className="tile__bins"
            type="number"
            min={0}
            max={HISTOGRAM_MAX_BINS}
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
          <ThinnedColumns rows={rows} color={color} />
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
 * Point diameters in px: the smallest and largest value's marks under a size column, and the
 * smallest for every point without one — `resolveSize`'s own answer to "no column".
 */
const SIZE_RANGE = { min: 3, max: 12 }
/** Before the plot is measured, and in jsdom, which measures nothing. */
const FALLBACK_PLOT = { width: 300, height: 120 }

type Option = { value: string; label: string }
const NONE: Option = { value: '', label: 'none' }

/**
 * How the scatter colours a column of this dtype.
 *
 * A float is a value and text a category whatever `plotColorAs` says; an integer is either, and
 * only the reader knows which — `degree` is a count, `component` a label. Which is also why the
 * card offers the switch beside an integer column and nowhere else.
 */
export function scatterColorMode(
  dtype: DType | undefined,
  as: ColorAs,
): 'sequential' | 'categorical' {
  if (dtype === 'f64') return 'sequential'
  if (dtype === 'i64') return as === 'category' ? 'categorical' : 'sequential'
  return 'categorical'
}

/** Every `stride`-th cell — the scatter's sample of a column. */
function sampled(data: ColumnData, stride: number): ColumnData {
  if (stride === 1) return data
  const out: ColumnData = []
  for (let row = 0; row < data.length; row += stride) out.push(data[row]!)
  return out
}

/** A channel's picker, with its name written out beside it. */
function ChannelPicker({
  name,
  value,
  options,
  onChange,
  children,
}: {
  name: string
  value: string | undefined
  options: Option[]
  onChange?: ((column: string) => void) | undefined
  children?: ReactNode
}) {
  return (
    <label>
      {name}
      <Picker
        label={`Scatter ${name}`}
        value={value ?? ''}
        options={[NONE, ...options]}
        onChange={onChange}
      />
      {children}
    </label>
  )
}

/**
 * Two per-node columns against each other, with colour, size and marker as three more.
 *
 * Hand-drawn rather than `ScatterViewer` in a tile: that component owns a canvas, a selection,
 * an export registration and an axis pair sized for a card of its own, none of which a grid
 * cell has room for. What is wanted here is the *shape* — whether the hubs are the clustered
 * ones, and now whether they are one component's or one community's.
 *
 * **The marks are the Scatter Plot's**: `resolveColor` / `resolveSize` / `resolveShape` for the
 * encodings, `buildMarks` for the points and their colour-and-shape buckets — whose order is the
 * stacking order every scatter painter shares — `viewAffine` for where a value lands, and
 * `LegendKeys` for the keys. So a categorical column cycles the palette and a seventh category
 * folds to a dash here exactly as it does there.
 */
function Scatter({
  nodes,
  x,
  y,
  plotColor,
  plotColorAs,
  plotSize,
  plotShape,
  columns,
  colorColumns,
  shapeColumns,
  onX,
  onY,
  onColor,
  onColorAs,
  onSize,
  onShape,
  mode,
}: {
  nodes: TableValue
  x: string | undefined
  y: string | undefined
  plotColor: string | undefined
  plotColorAs: ColorAs
  plotSize: string | undefined
  plotShape: string | undefined
  columns: Option[]
  colorColumns: Option[]
  shapeColumns: Option[]
  onX?: ((column: string) => void) | undefined
  onY?: ((column: string) => void) | undefined
  onColor?: ((column: string) => void) | undefined
  onColorAs?: ((as: string) => void) | undefined
  onSize?: ((column: string) => void) | undefined
  onShape?: ((column: string) => void) | undefined
  mode: Mode
}) {
  const [ref, measured] = useElementSize<HTMLDivElement>()
  const box = measured.width > 0 && measured.height > 0 ? measured : FALLBACK_PLOT

  const colorDtype = plotColor
    ? nodes.schema.columns.find((c) => c.name === plotColor)?.dtype
    : undefined
  const colorMode = plotColor ? scatterColorMode(colorDtype, plotColorAs) : 'constant'

  /*
   * The three channels, each resolved over the *whole* node table rather than the strided rows,
   * so a ramp's ends and a palette's ranking do not move when the stride does — and each on its
   * own, so picking a size column does not re-rank the colours.
   */
  const colors = useMemo(
    () =>
      resolveColor(
        nodes,
        { mode: colorMode, column: plotColor, constant: seriesColor(3, mode) },
        mode,
      ),
    [nodes, colorMode, plotColor, mode],
  )
  const sizes = useMemo(
    () => resolveSize(nodes, { column: plotSize, ...SIZE_RANGE }),
    [nodes, plotSize],
  )
  const shapes = useMemo(
    () => resolveShape(nodes, { mode: 'categorical', column: plotShape, constant: 'circle' }),
    [nodes, plotShape],
  )

  /*
   * The data half, apart from the box: which points, where in value space, and how each is marked.
   * A resize re-places the marks below and must not re-scan, re-resolve or re-bucket a column.
   */
  const stride = Math.max(1, Math.ceil(nodes.length / MAX_POINTS))
  const marks = useMemo(() => {
    if (!x || !y || !nodes.data[x] || !nodes.data[y]) return undefined
    const xs = sampled(nodes.data[x]!, stride)
    // Indices into the sample; the resolvers are over the whole table, hence the stride back.
    return buildMarks({
      xValues: xs,
      yValues: sampled(nodes.data[y]!, stride),
      length: xs.length,
      xScale: 'linear',
      yScale: 'linear',
      style: {
        colorAt: (i) => colors.at(i * stride),
        radiusAt: (i) => sizes.at(i * stride) / 2,
        shapeAt: (i) => shapes.at(i * stride),
      },
    })
  }, [nodes, x, y, stride, colors, sizes, shapes])

  /*
   * One path per colour-and-shape bucket rather than one element per point, in pixel space:
   * a stretched unit box would draw a triangle as a different triangle on every card. Inset by
   * the largest mark, so a point at an extreme is drawn whole inside the frame.
   */
  const plot = useMemo(() => {
    if (!marks?.extent) return undefined
    const pad = marks.largestRadius + 2
    const { sx, ox, sy, oy } = viewAffine(marks.extent, {
      x: pad,
      y: pad,
      width: Math.max(1, box.width - 2 * pad),
      height: Math.max(1, box.height - 2 * pad),
    })
    const paths = marks.buckets.map((bucket, key) => ({
      key,
      fill: bucket.color,
      d: bucket.indices
        .map((i) =>
          markPath(
            bucket.shape,
            marks.xt[i]! * sx + ox,
            marks.yt[i]! * sy + oy,
            marks.radius[i]!,
          ),
        )
        .join(''),
    }))
    return { paths, extent: marks.extent, drawn: marks.rows.length }
  }, [marks, box.width, box.height])

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

  const ink = CHART_INK[mode].muted
  return (
    <div className="metrics__grow">
      <Tile label="Scatter" qualifier={x && y ? `${y} × ${x}` : undefined} action={action}>
        {/*
          The other three channels on a row of their own, with their names written out: the
          qualifier already says which column each axis is, and three more unlabelled selects
          reading `none` in the heading would not say which channel each one is.
        */}
        <div className="metrics__encodings">
          <ChannelPicker
            name="colour"
            value={plotColor}
            options={colorColumns}
            onChange={onColor}
          >
            {colorDtype === 'i64' && (
              <Picker
                label="Scatter colour as"
                value={plotColorAs}
                options={COLOR_AS_OPTIONS}
                onChange={onColorAs}
              />
            )}
          </ChannelPicker>
          <ChannelPicker name="size" value={plotSize} options={columns} onChange={onSize} />
          <ChannelPicker
            name="marker"
            value={plotShape}
            options={shapeColumns}
            onChange={onShape}
          />
        </div>
        {!x || !y ? (
          <p className="tile__pending">Pick two numeric node columns</p>
        ) : !plot ? (
          <p className="tile__pending">No node has both</p>
        ) : (
          <>
            <div ref={ref} className="metrics__plot">
              <svg
                className="metrics__scatter"
                viewBox={`0 0 ${box.width} ${box.height}`}
                role="img"
                aria-label={`${y} against ${x}`}
              >
                <rect
                  x="0.5"
                  y="0.5"
                  width={box.width - 1}
                  height={box.height - 1}
                  fill="none"
                  stroke={ink}
                />
                {plot.paths.map((path) => (
                  <path key={path.key} d={path.d} fill={path.fill} fillOpacity="0.7" />
                ))}
              </svg>
            </div>
            {(colors.legend || sizes.domain || shapes.legend) && (
              <div className="legend metrics__legend">
                {/* A ramp names its own column; a set of keys needs the name given. */}
                <ColorKey
                  colors={colors}
                  {...(colors.legend?.kind === 'categorical' ? { name: plotColor! } : {})}
                />
                <SizeKey
                  channel={{ spec: { column: plotSize, ...SIZE_RANGE }, resolved: sizes }}
                  name="size"
                />
                {shapes.legend && (
                  <ShapeKey column={shapes.legend.column} entries={shapes.legend.entries} />
                )}
              </div>
            )}
            <dl className="tile__facts">
              <div className="tile__fact">
                <dt>{x}</dt>
                <dd>
                  {formatCompact(plot.extent.x.min)} – {formatCompact(plot.extent.x.max)}
                </dd>
              </div>
              <div className="tile__fact">
                <dt>{y}</dt>
                <dd>
                  {formatCompact(plot.extent.y.min)} – {formatCompact(plot.extent.y.max)}
                </dd>
              </div>
              <div className="tile__fact">
                <dt>drawn</dt>
                <dd>
                  {plot.drawn < nodes.length
                    ? `${formatNumber(plot.drawn)} of ${plural(nodes.length, 'node')}`
                    : plural(plot.drawn, 'node')}
                </dd>
              </div>
            </dl>
          </>
        )}
      </Tile>
    </div>
  )
}

const SIZE_SCHEMA = tableSchema(column(COMPONENT_SIZE_COLUMN, 'i64'))

export function NetworkMetricsViewer({
  network,
  plotX,
  plotY,
  plotColor,
  plotColorAs,
  plotSize,
  plotShape,
  histColumn,
  bins,
  histVertical,
  logScale,
  onPlotX,
  onPlotY,
  onPlotColor,
  onPlotColorAs,
  onPlotSize,
  onPlotShape,
  onHistColumn,
  onBins,
  onHistVertical,
  compact,
  baseName,
  onExpand,
  onError,
}: NetworkMetricsViewerProps) {
  const mode = currentMode()
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
  /*
   * The scatter's three column vocabularies, by the node params' own rules: axes and size take
   * numbers, a marker the categorical dtypes, colour anything — and none offering the column
   * `excludeIds` drops, so the card and the inspector offer the same lists. (On the numeric two
   * that is a no-op: the id is text.)
   */
  const { nodeColumns, colorColumns, shapeColumns } = useMemo(() => {
    const options = (cols: readonly ColumnSchema[]) =>
      cols
        .filter((col) => col.name !== ID_COLUMN_NAME)
        .map((col) => ({ value: col.name, label: col.name }))
    return {
      nodeColumns: options(columnsOfType(nodes.schema, NUMERIC_DTYPES)),
      colorColumns: options(nodes.schema.columns),
      shapeColumns: options(columnsOfType(nodes.schema, CATEGORICAL_DTYPES)),
    }
  }, [nodes.schema])

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
      {/*
        Two layers rather than one grid, so the scatter can take the card's spare height.

        The tile grid's rows are content-sized, and which row the scatter lands on depends on how
        many columns the width allows — so no track can be named `1fr`. The fact tiles stay a
        grid; the two plots stack under it in a flex column, where the scatter grows and the
        histogram keeps its own height. The scroll container is the outer layer, so a short card
        still scrolls rather than squeezing the plot below its floor.
      */}
      <div className="metrics__body nowheel">
        <div className="tiles">
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
        </div>

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
          plotColor={plotColor}
          plotColorAs={plotColorAs}
          plotSize={plotSize}
          plotShape={plotShape}
          columns={nodeColumns}
          colorColumns={colorColumns}
          shapeColumns={shapeColumns}
          onX={onPlotX}
          onY={onPlotY}
          onColor={onPlotColor}
          onColorAs={onPlotColorAs}
          onSize={onPlotSize}
          onShape={onPlotShape}
          mode={mode}
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
