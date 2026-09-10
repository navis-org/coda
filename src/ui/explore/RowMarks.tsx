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
 * value: the `title` carries the numbers, and the figure columns beside them carry the same facts
 * as text. That is the same doctrine as the socket colours and the chip slots — colour and shape
 * plus a readable label, never a mark alone.
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
 * The frame every mark shares: size, role, label and title.
 *
 * Four copies of an eight-line SVG shell is four places for the accessibility contract this
 * file's header rests on to drift — and the marks differ only in their height and their contents.
 */
function Mark({
  title,
  label = title,
  height = H,
  children,
}: {
  title: string
  /** Defaults to the title — passed apart only where the two genuinely say different things. */
  label?: string
  height?: number
  children: React.ReactNode
}) {
  return (
    <svg
      className="explore-plot"
      width={W}
      height={height}
      viewBox={`0 0 ${W} ${height}`}
      role="img"
      aria-label={label}
    >
      <title>{title}</title>
      {children}
    </svg>
  )
}

/**
 * Several counts as one split bar, each drawn as its share of their sum.
 *
 * The pre/post balance bar was the first of these and is now simply the automatic two-part one.
 * A shared baseline at the left makes the *proportion* the thing that varies down the column,
 * where a centred diverging mark would make the total vary instead — which the figures already
 * say. Parts are coloured by position, so part one is one colour on every row of the column.
 */
export function StackedBar({ parts, mode }: { parts: readonly Part[]; mode: Mode }) {
  let at = 0
  return (
    <Mark label={partsLabel(parts)} title={partsTitle(parts)}>
      {parts.map((part, i) => {
        // Rounded at the running edge rather than per segment, so two parts meant to touch
        // cannot open a hairline between them — `donutArcs`' rule for the same reason.
        const x = Math.round(at * W)
        at += part.share
        const width = Math.round(at * W) - x
        return (
          <rect
            key={part.name}
            x={x}
            y={0}
            width={width}
            height={H}
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

export function SideBars({ parts, mode }: { parts: readonly Part[]; mode: Mode }) {
  const width = (W - BAR_GAP * (parts.length - 1)) / parts.length
  const top = BARS_H - 1
  return (
    <Mark height={BARS_H} label={partsLabel(parts)} title={partsTitle(parts)}>
      <rect x={0} y={top} width={W} height={1} fill={CHART_INK[mode].muted} opacity={0.5} />
      {parts.map((part, i) => {
        // A part that exists is never drawn as nothing — a pixel says "some", which zero does not.
        const height = part.count > 0 ? Math.max(1, Math.round(part.share * top)) : 0
        return (
          <rect
            key={part.name}
            x={i * (width + BAR_GAP)}
            y={top - height}
            width={width}
            height={height}
            fill={seriesColor(i, mode)}
          />
        )
      })}
    </Mark>
  )
}

/** The same parts as a ring — `ShareRing`, with each part in the slot its position gives it. */
export function PartsDonut({ parts, mode }: { parts: readonly Part[]; mode: Mode }) {
  return (
    <ShareRing
      shares={parts.map((part, i) => ({
        roi: part.name,
        share: part.share,
        count: part.count,
        rank: i,
      }))}
      mode={mode}
    />
  )
}

function partsLabel(parts: readonly Part[]): string {
  return parts.map((p) => `${p.name} ${formatNumber(p.count)}`).join(', ')
}

function partsTitle(parts: readonly Part[]): string {
  return parts.map((p) => shareLine(p.name, p.count, p.share)).join('\n')
}

/**
 * One part's line in a split mark's title, for the bars and the ring alike. `formatShare`, not a
 * rounded percent: a part under half a percent read "0%" beside a side-by-side bar that draws it
 * a pixel tall precisely so it does not read as none.
 */
function shareLine(name: string, count: number, share: number): string {
  return `${name} — ${formatNumber(count)} (${formatShare(share)})`
}

/**
 * One quantity against the largest of its kind in the dataset.
 *
 * A filled bar, because here the quantity *is* the point — where `PercentileTick` is a rank and
 * deliberately not filled. The track is the dataset's maximum, so a full bar means "the largest
 * neuron here", which the title says in words.
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
      title={
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
 * rank. The track is the whole dataset, the tick is this one neuron, and the caption says the
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
      title={
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
const LOW = 0.5

export function ConfidenceBar({
  value,
  label,
  mode,
}: {
  value: number
  label: string
  mode: Mode
}) {
  const width = Math.max(1, Math.round(W * Math.min(Math.max(value, 0), 1)))
  return (
    <Mark title={`${label} — ${Math.round(value * 100)}% confidence`}>
      <rect
        x={0}
        y={0}
        width={W}
        height={H}
        rx={2}
        fill={CHART_INK[mode].muted}
        opacity={0.25}
      />
      <rect
        x={0}
        y={0}
        width={width}
        height={H}
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
 * mark of its own shape.
 */
const RING = 22
const RING_STROKE = 6.5
const RADIUS = (RING - RING_STROKE) / 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export function ShareRing({ shares, mode }: { shares: RegionShare[]; mode: Mode }) {
  const arcs = donutArcs(shares, CIRCUMFERENCE)
  return (
    <Mark
      height={RING}
      label={shares.map((s) => `${s.roi} ${formatShare(s.share)}`).join(', ')}
      title={shares.map((s) => shareLine(s.roi, s.count, s.share)).join('\n')}
    >
      {/* Centred in the slot, and started at twelve o'clock rather than three. */}
      <g transform={`translate(${W / 2} ${RING / 2}) rotate(-90)`}>
        {arcs.map((arc) => (
          <circle
            key={arc.roi}
            r={RADIUS}
            fill="none"
            stroke={seriesColor(arc.rank, mode)}
            strokeWidth={RING_STROKE}
            strokeDasharray={`${arc.length} ${CIRCUMFERENCE}`}
            strokeDashoffset={arc.offset}
          />
        ))}
      </g>
    </Mark>
  )
}
