/**
 * The inline marks on an expanded row.
 *
 * Plain SVG and no library: each is a handful of rectangles, and `rowPlots.ts` has already decided
 * what they mean. Colour comes from `CHART_INK` and the categorical palette rather than from
 * anything chosen here — see `src/ui/colors.ts` for why hues are not picked by eye.
 *
 * The theme arrives as a prop rather than being read per mark. Four `currentMode()` calls a row is
 * a hundred a page, and on the default `system` preference — no `data-theme` stamped — every one
 * mints a fresh `MediaQueryList`; it also means the marks repaint on a theme flip, which reading
 * during render does not.
 *
 * Every one of them is **labelled as well as drawn**. A bar in a list is a scanning aid, not the
 * value: the hover preview (`MarkPreview.tsx`) carries the numbers and names each part, the
 * `aria-label` says the same in words, and the figure columns beside them carry the same facts as
 * text. That is the same doctrine as the socket colours and the chip slots — colour and shape plus
 * a readable label, never a mark alone.
 *
 * **No `<title>`, and that is the preview's doing.** Each mark used to carry its numbers in one,
 * which the browser shows about a second after the pointer stops — so with a preview opening at a
 * quarter of that, the native tooltip arrived on top of the panel saying less than it.
 *
 * **The split marks and the ring are drawn at any size**, because the preview draws the very same
 * picture larger: a second drawing of "the same" bar is a copy, and a copy goes stale silently.
 * The row's size is the default everywhere, so only the preview names another.
 */

import type React from 'react'

import type { Mode } from '../colors'
import { CHART_INK, seriesColor } from '../colors'
import { MARK_W } from './rowPlots'
import type { RegionShare } from './rowRois'
import { donutArcs } from './rowRois'
import { formatMeasure, formatNumber, formatShare } from '../format'
import type { Part, Percentile } from './rowPlots'

/** Bar geometry. `MARK_W` is `rowPlots`', which is also what sizes the grid track and the labels. */
const W = MARK_W
const H = 8

/**
 * The frame every mark shares: size, role and label.
 *
 * Four copies of an eight-line SVG shell is four places for the accessibility contract this
 * file's header rests on to drift — and the marks differ only in their size and their contents.
 */
function Mark({
  label,
  width = W,
  height = H,
  children,
}: {
  label: string
  width?: number
  height?: number
  children: React.ReactNode
}) {
  return (
    <svg
      className="explore-plot"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
    >
      {children}
    </svg>
  )
}

/** A mark's box: the row's by default, the preview's where it asks. A ring's height is its diameter. */
interface MarkSize {
  width?: number
  height?: number
}

/**
 * Several counts as one split bar, each drawn as its share of their sum.
 *
 * The pre/post balance bar was the first of these and is now simply the automatic two-part one.
 * A shared baseline at the left makes the *proportion* the thing that varies down the column,
 * where a centred diverging mark would make the total vary instead — which the figures already
 * say. Parts are coloured by position, so part one is one colour on every row of the column.
 */
export function StackedBar({
  parts,
  mode,
  width = W,
  height = H,
}: { parts: readonly Part[]; mode: Mode } & MarkSize) {
  let at = 0
  return (
    <Mark label={partsLabel(parts)} width={width} height={height}>
      {parts.map((part, i) => {
        // Rounded at the running edge rather than per segment, so two parts meant to touch
        // cannot open a hairline between them — `donutArcs`' rule for the same reason.
        const x = Math.round(at * width)
        at += part.share
        const w = Math.round(at * width) - x
        return (
          <rect
            key={part.name}
            x={x}
            y={0}
            width={w}
            height={height}
            fill={seriesColor(i, mode)}
          />
        )
      })}
    </Mark>
  )
}

/**
 * The same parts as bars side by side on one baseline, each as tall as its share of their sum.
 *
 * Where the stacked bar answers "which way does it lean", this answers "how do the parts compare":
 * four stacked segments are four lengths with four different starting points, which the eye
 * compares badly, and four bars on one baseline it compares well. Heights are shares rather than
 * the largest part scaled to full, so one height means one fraction on every row of the column —
 * the property the stacked bar's shared left edge buys, kept.
 */
const BARS_H = 16
const BAR_GAP = 2

export function SideBars({
  parts,
  mode,
  width = W,
  height = BARS_H,
}: { parts: readonly Part[]; mode: Mode } & MarkSize) {
  const each = (width - BAR_GAP * (parts.length - 1)) / parts.length
  const top = height - 1
  return (
    <Mark label={partsLabel(parts)} width={width} height={height}>
      <rect x={0} y={top} width={width} height={1} fill={CHART_INK[mode].muted} opacity={0.5} />
      {parts.map((part, i) => {
        // A part that exists is never drawn as nothing — a pixel says "some", which zero does not.
        const h = part.count > 0 ? Math.max(1, Math.round(part.share * top)) : 0
        return (
          <rect
            key={part.name}
            x={i * (each + BAR_GAP)}
            y={top - h}
            width={each}
            height={h}
            fill={seriesColor(i, mode)}
          />
        )
      })}
    </Mark>
  )
}

/** The same parts as a ring — `ShareRing`, with each part in the slot its position gives it. */
export function PartsDonut({
  parts,
  mode,
  ...size
}: { parts: readonly Part[]; mode: Mode } & MarkSize) {
  return (
    <ShareRing
      shares={parts.map((part, i) => ({
        roi: part.name,
        share: part.share,
        count: part.count,
        rank: i,
      }))}
      mode={mode}
      {...size}
    />
  )
}

/** The renderers that draw a merged column's parts. */
export type PartsShape = 'stacked' | 'bars' | 'donut'

const PARTS_SHAPES = { stacked: StackedBar, bars: SideBars, donut: PartsDonut } as const

/** A merged column's parts in the shape its renderer names — one choice, for the row and the preview. */
export function PartsMark({
  shape,
  ...props
}: { shape: PartsShape; parts: readonly Part[]; mode: Mode } & MarkSize) {
  const Shape = PARTS_SHAPES[shape]
  return <Shape {...props} />
}

function partsLabel(parts: readonly Part[]): string {
  return parts.map((p) => `${p.name} ${formatNumber(p.count)}`).join(', ')
}

/**
 * One quantity against the largest of its kind in the dataset.
 *
 * A filled bar, because here the quantity *is* the point — where `PercentileTick` is a rank and
 * deliberately not filled. The track is the dataset's maximum, so a full bar means "the largest
 * neuron here", which the label says in words.
 */
export function ValueBar({
  fraction,
  value,
  name,
  unit,
  log,
  mode,
}: {
  fraction: number
  value: number
  name: string
  unit: string | undefined
  log: boolean
  mode: Mode
}) {
  const width = Math.max(fraction > 0 ? 1 : 0, Math.round(W * fraction))
  return (
    <Mark
      label={
        `${name} ${formatMeasure(value, unit)} — ` +
        (log
          ? 'on a log scale against the largest in this dataset'
          : `${formatShare(fraction)} of the largest in this dataset`)
      }
    >
      <rect
        x={0}
        y={0}
        width={W}
        height={H}
        rx={2}
        fill={CHART_INK[mode].muted}
        opacity={0.25}
      />
      <rect x={0} y={0} width={width} height={H} rx={2} fill={seriesColor(0, mode)} />
    </Mark>
  )
}

/**
 * Where this neuron sits in the dataset's own spread.
 *
 * A track with a tick rather than a filled bar: a filled bar reads as a *quantity*, and this is a
 * rank. The track is the whole dataset, the tick is this one neuron, and the label says the
 * value so the mark never has to carry it.
 */
export function PercentileTick({
  percentile,
  unit,
  name,
  mode,
}: {
  mode: Mode
  percentile: Percentile
  /** The column's unit, where it declares one — a raw count has none. */
  unit: string | undefined
  name: string
}) {
  const at = Math.round((W - 2) * percentile.at) + 1
  return (
    <Mark
      label={
        `${name} ${formatMeasure(percentile.value, unit)} — larger than ` +
        `${Math.round(percentile.at * 100)}% of neurons in this dataset`
      }
    >
      <rect
        x={0}
        y={H / 2 - 1}
        width={W}
        height={2}
        rx={1}
        fill={CHART_INK[mode].muted}
        opacity={0.5}
      />
      <rect x={at - 1} y={0} width={2.5} height={H} rx={1} fill={CHART_INK[mode].primary} />
    </Mark>
  )
}

/**
 * How far to trust the label beside it.
 *
 * Drawn only where the dataset publishes a confidence *and* the prediction it belongs to, so the
 * mark can never appear next to a value it does not describe. Below `LOW`, the bar takes the
 * achromatic ink rather than a hue: a weak prediction should not look like a category.
 */
export const LOW = 0.5

/** A confidence in words, the mark's label and the preview's line alike. */
export function confidenceText(label: string, value: number): string {
  return `${label} — ${Math.round(value * 100)}% confidence`
}

export function ConfidenceBar({
  value,
  label,
  mode,
  width = W,
  height = H,
}: {
  value: number
  label: string
  mode: Mode
} & MarkSize) {
  const filled = Math.max(1, Math.round(width * Math.min(Math.max(value, 0), 1)))
  return (
    <Mark label={confidenceText(label, value)} width={width} height={height}>
      <rect
        x={0}
        y={0}
        width={width}
        height={height}
        rx={2}
        fill={CHART_INK[mode].muted}
        opacity={0.25}
      />
      <rect
        x={0}
        y={0}
        width={filled}
        height={height}
        rx={2}
        fill={value < LOW ? CHART_INK[mode].muted : seriesColor(2, mode)}
      />
    </Mark>
  )
}

/**
 * Shares as a donut: where this neuron's synapses are, or the parts of a merged column.
 *
 * A ring rather than a pie because the slices are small: a pie's segments all meet at the centre,
 * where the three narrowest are a few pixels of shared point and unreadable, while a ring gives
 * every segment the same radial thickness however thin its arc. It also leaves a hole, which at
 * this size is what keeps the mark legible as a *proportion* rather than a coloured blob.
 *
 * Segments are drawn in the page's rank order and coloured by that rank, so a region is the same
 * colour on every row and the column can be read down — see `rowRois.ts`. The tail is one folded
 * segment at the palette's own fold position, which is `seriesColor`'s achromatic `Other`: **fold
 * where the mark folds**, and a ring folds.
 *
 * Drawn in the same `MARK_W`-wide slot every other mark occupies, centred, so the header's labels
 * keep sitting over the marks they name and `rowTemplate`'s arithmetic does not learn about a
 * mark of its own shape. The stroke keeps its proportion to the diameter at any size, so the
 * preview's ring is the row's, larger — not a thinner ring with a bigger hole.
 */
const RING = 22
const RING_STROKE = 6.5

export function ShareRing({
  shares,
  mode,
  height: size = RING,
  width = W,
}: { shares: readonly RegionShare[]; mode: Mode } & MarkSize) {
  const stroke = (size * RING_STROKE) / RING
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const arcs = donutArcs(shares, circumference)
  return (
    <Mark
      width={width}
      height={size}
      label={shares.map((s) => `${s.roi} ${formatShare(s.share)}`).join(', ')}
    >
      {/* Centred in the slot, and started at twelve o'clock rather than three. */}
      <g transform={`translate(${width / 2} ${size / 2}) rotate(-90)`}>
        {arcs.map((arc) => (
          <circle
            key={arc.roi}
            r={radius}
            fill="none"
            stroke={seriesColor(arc.rank, mode)}
            strokeWidth={stroke}
            strokeDasharray={`${arc.length} ${circumference}`}
            strokeDashoffset={arc.offset}
          />
        ))}
      </g>
    </Mark>
  )
}
