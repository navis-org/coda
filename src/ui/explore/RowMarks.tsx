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
import { formatMeasure, formatNumber } from '../format'
import type { Balance, Percentile } from './rowPlots'

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
 * Presynaptic against postsynaptic, as one split bar.
 *
 * Two segments and not a centred diverging mark: what a reader wants from a list is "which way
 * does this one lean", and a shared baseline at the left makes the *proportion* the thing that
 * varies down the column. A diverging bar makes the total the thing that varies instead, which
 * the figures already say.
 */
export function BalanceBar({ balance, mode }: { balance: Balance; mode: Mode }) {
  const pre = Math.round(W * balance.pre)
  return (
    <Mark
      label={`${formatNumber(balance.preCount)} presynaptic, ${formatNumber(balance.postCount)} postsynaptic`}
      title={
        `${formatNumber(balance.preCount)} pre · ${formatNumber(balance.postCount)} post — ` +
        `${Math.round(balance.pre * 100)}% outgoing`
      }
    >
      <rect x={0} y={0} width={W} height={H} rx={2} fill={seriesColor(1, mode)} opacity={0.5} />
      <rect x={0} y={0} width={pre} height={H} rx={2} fill={seriesColor(0, mode)} />
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
 * Where this neuron's synapses are, as a donut.
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

export function RegionBar({ shares, mode }: { shares: RegionShare[]; mode: Mode }) {
  const arcs = donutArcs(shares, CIRCUMFERENCE)
  return (
    <Mark
      height={RING}
      label={shares.map((s) => `${s.roi} ${Math.round(s.share * 100)}%`).join(', ')}
      title={shares
        .map((s) => `${s.roi} — ${formatNumber(s.count)} (${Math.round(s.share * 100)}%)`)
        .join('\n')}
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
