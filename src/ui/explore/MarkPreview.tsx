/**
 * A mark's hover preview: the row's little picture, drawn large enough to name its parts.
 *
 * The thumbnail's gesture pointed at a different question. A 54-pixel mark is a scanning aid —
 * which way a neuron leans, roughly where it sits — and the moment somebody stops on one they want
 * what it cannot say at that size: which colour is which part, what the counts are, what "the
 * dataset" it is ranked against looks like. So a rest on a mark opens a panel beside it that is
 * one of three things:
 *
 *  - **A split** (stacked, side-by-side, donut, regions) is the *same* drawing larger — the row's
 *    own components at a bigger size, never a second rendering of them — above a legend of name,
 *    count and share, swatches in the colours the row uses.
 *  - **A bar or a rank** is the neuron against the whole column: a histogram of every row, this
 *    neuron's bin marked and everything at or below it filled. That is the picture a rank *means*
 *    and the one thing Explore can draw that no other surface can without a query — it already
 *    holds the column. A bar's axis is the bar's own scale, from zero; a rank's is chosen from the
 *    column (`spreadOf`'s `auto`).
 *  - **A confidence** is its bar enlarged, with the prediction it qualifies.
 *
 * **Regions itemise their `Other`.** The ring folds its tail into one grey segment and so does the
 * legend — a sixth colour would have to mean one region on this row and another on the next — but
 * grey names under the legend are not a mark, and the tail is exactly what somebody hovering a
 * ring with a large grey slice wants to know.
 *
 * The gesture is `useHoverPanel`'s: mouse only, the rect watch, the right-click. **Local state per
 * cell**, for `NeuronThumbnail`'s reason — a hovered-cell id in the list would re-render every row
 * of a memoised page to change one.
 */

import type React from 'react'
import { useRef } from 'react'
import { createPortal } from 'react-dom'

import type { Mode } from '../colors'
import { CHART_INK, OTHER_LABEL, seriesColor } from '../colors'
import { formatMeasure, formatNumber, formatShare, plural } from '../format'
import type { Rect } from '../hoverPlacement'
import { HOVER_DELAY_MS, useHoverPanel, usePlacedPanel } from '../useHoverPanel'
import type { Part, Spread } from './rowPlots'
import { axisAt } from './rowPlots'
import type { RegionShare } from './rowRois'
import type { PartsShape } from './RowMarks'
import { ConfidenceBar, LOW, PartsMark, ShareRing, confidenceText } from './RowMarks'

/** Gap between the mark and the panel. */
const GAP = 10

/** How close to the window's edge the panel may sit. */
const MARGIN = 8

/**
 * The drawing's width inside the panel, which is also the panel's content width.
 *
 * Written onto the panel from here rather than into the stylesheet, so the legend under the
 * drawing is exactly as wide as the drawing and there is one spelling of the number.
 */
export const PREVIEW_W = 240

/** A bar's thickness in the preview — the stacked bar's and the confidence bar's. */
const BAR_H = 14

/** The ring's diameter, the regions ring's and a merged donut's alike. */
const RING_D = 112

/** Each split shape's height in the preview. */
const PARTS_H: Record<PartsShape, number> = { stacked: BAR_H, bars: 64, donut: RING_D }

/** A spread's height. */
const SPREAD_H = 56

/** How many folded regions are named before the rest are counted. */
const MAX_FOLDED = 8

export interface HoverMarkProps {
  /** The mark, as the row draws it. */
  children: React.ReactNode
  /** The column's header label — what the reader hovered, in the header's words. */
  title: string
  /** Which neuron: its type and id, since the panel may cover the row's own name. */
  subject: string
  /** Built only while the panel is open, so a page of cells pays nothing for it. */
  preview: () => React.ReactNode
}

/**
 * A mark's grid cell: the hover target, holding the mark.
 *
 * The cell rather than the SVG takes the pointer, which is the whole track: a ring is 22 pixels of
 * a 54-pixel slot and a bar 8 pixels tall, and a target that is only the ink is one a pointer
 * slides off while resting. Marks are dense targets — several abreast, crossed on the way to
 * another — hence the longer delay.
 */
export function HoverMark({ children, title, subject, preview }: HoverMarkProps) {
  const ref = useRef<HTMLDivElement>(null)
  const { open, handlers } = useHoverPanel({ anchorRef: ref, delayMs: HOVER_DELAY_MS.dense })
  return (
    <div ref={ref} className="explore-mark" {...handlers}>
      {children}
      {open &&
        createPortal(
          /*
           * Portalled for the thumbnail preview's two reasons: `.explore__list` scrolls, which
           * clips both axes, and `.overlay__panel` is `overflow: hidden`. The host is the
           * fullscreen root where there is one, or ⛶ would leave it built and invisible.
           */
          <MarkPreviewPanel anchor={open.anchor} title={title} subject={subject}>
            {preview()}
          </MarkPreviewPanel>,
          open.host,
        )}
    </div>
  )
}

/**
 * The panel: a head naming the column and the neuron, then whatever the mark previews as.
 *
 * Opens **right**, which is the thumbnail's rule turned round rather than broken: open into what
 * the reader is not comparing against. The thumbnail's comparison is the row's name, to its right;
 * a mark's is the same column on the rows above and below and the row's own name to its left, so
 * the side that costs least is the columns further along this row. Clamped, never flipped —
 * `hoverPlacement` records why.
 */
function MarkPreviewPanel({
  anchor,
  title,
  subject,
  children,
}: {
  anchor: Rect
  title: string
  subject: string
  children: React.ReactNode
}) {
  const { ref, style } = usePlacedPanel(
    anchor,
    { prefer: 'right', gap: GAP, margin: MARGIN },
    children,
  )
  return (
    <div
      ref={ref}
      className="hover-panel explore-mark-preview"
      style={{ ...style, width: PREVIEW_W }}
      // The mark under the pointer already says this in its `aria-label`; a panel only a mouse
      // can open would read it out a second time for nobody.
      aria-hidden="true"
    >
      <div className="explore-mark-preview__head">
        <span className="explore-mark-preview__title">{title}</span>
        <span className="explore-mark-preview__subject">{subject}</span>
      </div>
      {children}
    </div>
  )
}

/** One legend row: the name and its numbers, keyed by a swatch in the mark's own colour. */
interface LegendRow {
  key: string
  name: string
  count: number
  share: number
  /** Absent for a row the mark folded — named, but not a colour on the drawing. */
  color?: string
}

/** Name, count and share per row; a foot where the rows are a whole worth totalling. */
function Legend({
  rows,
  foot,
}: {
  rows: readonly LegendRow[]
  foot?: { label: string; total: number }
}) {
  return (
    <table className="explore-mark-preview__legend">
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            {row.color !== undefined && (
              <td>
                <span className="legend__swatch" style={{ background: row.color }} />
              </td>
            )}
            <td className="explore-mark-preview__name">{row.name}</td>
            <td className="explore-mark-preview__num">{formatNumber(row.count)}</td>
            <td className="explore-mark-preview__num">{formatShare(row.share)}</td>
          </tr>
        ))}
      </tbody>
      {foot && (
        <tfoot>
          <tr>
            <td />
            <td className="explore-mark-preview__name">{foot.label}</td>
            <td className="explore-mark-preview__num">{formatNumber(foot.total)}</td>
            <td className="explore-mark-preview__num">100%</td>
          </tr>
        </tfoot>
      )}
    </table>
  )
}

/** A merged column's parts: the row's drawing, larger, and a legend in its colours. */
export function PartsPreview({
  parts,
  shape,
  mode,
}: {
  parts: readonly Part[]
  shape: PartsShape
  mode: Mode
}) {
  return (
    <>
      <div className="explore-mark-preview__figure">
        <PartsMark
          shape={shape}
          parts={parts}
          mode={mode}
          width={PREVIEW_W}
          height={PARTS_H[shape]}
        />
      </div>
      <Legend
        rows={parts.map((part, i) => ({
          key: part.name,
          name: part.name,
          count: part.count,
          share: part.share,
          color: seriesColor(i, mode),
        }))}
        // A share of the parts' own sum, which is not necessarily any column's total — see
        // `sharesOf`. Saying "sum" is what stops somebody reading it as `pre`.
        foot={{
          label: 'Sum of these',
          total: parts.reduce((sum, part) => sum + part.count, 0),
        }}
      />
    </>
  )
}

/** Where this neuron's synapses are: the ring, its legend, and what `Other` folded. */
export function RegionsPreview({
  shares,
  mode,
}: {
  shares: readonly RegionShare[]
  mode: Mode
}) {
  const total = shares.reduce((sum, share) => sum + share.count, 0)
  const folded = shares.find((share) => share.folded)?.folded ?? []
  return (
    <>
      <div className="explore-mark-preview__figure">
        <ShareRing shares={shares} mode={mode} width={PREVIEW_W} height={RING_D} />
      </div>
      <Legend
        rows={shares.map((share) => ({
          key: share.roi,
          name: share.roi,
          count: share.count,
          share: share.share,
          color: seriesColor(share.rank, mode),
        }))}
        foot={{ label: 'Primary regions', total }}
      />
      {folded.length > 0 && (
        <div className="explore-mark-preview__folded">
          <div className="explore-mark-preview__caption">
            {OTHER_LABEL} · {plural(folded.length, 'region')}
          </div>
          <Legend
            rows={folded.slice(0, MAX_FOLDED).map((region) => ({
              key: region.roi,
              name: region.roi,
              count: region.count,
              share: region.count / total,
            }))}
          />
          {folded.length > MAX_FOLDED && (
            <div className="explore-mark-preview__note">+{folded.length - MAX_FOLDED} more</div>
          )}
        </div>
      )}
    </>
  )
}

/**
 * One neuron against its whole column: a histogram, this neuron's value marked.
 *
 * Everything at or below the value is filled in the bar's colour and everything above it muted,
 * so the filled area *is* the fraction a rank reports — the picture and the sentence under it say
 * the same thing. Heights are counts against the tallest bin, and a bin holding anybody is never
 * drawn as nothing: `SideBars`' pixel rule, since the rare neurons in a long tail are the ones a
 * reader went looking for.
 */
export function SpreadPreview({
  spread,
  value,
  unit,
  caption,
  mode,
}: {
  spread: Spread
  value: number
  unit: string | undefined
  caption: string
  mode: Mode
}) {
  const { counts } = spread
  const peak = Math.max(...counts)
  const pitch = PREVIEW_W / counts.length
  const x = axisAt(spread, value) * PREVIEW_W
  const top = SPREAD_H - 1
  const ink = CHART_INK[mode]
  return (
    <>
      <div className="explore-mark-preview__value">{formatMeasure(value, unit)}</div>
      <div className="explore-mark-preview__figure">
        <svg
          className="explore-plot"
          width={PREVIEW_W}
          height={SPREAD_H}
          viewBox={`0 0 ${PREVIEW_W} ${SPREAD_H}`}
          role="img"
          aria-label={caption}
        >
          <rect x={0} y={top} width={PREVIEW_W} height={1} fill={ink.muted} opacity={0.5} />
          {counts.map((count, i) => {
            const h = count > 0 ? Math.max(1, Math.round((count / peak) * top)) : 0
            const below = (i + 0.5) * pitch <= x
            return (
              <rect
                key={i}
                data-below={below || undefined}
                x={i * pitch}
                y={top - h}
                width={Math.max(1, pitch - 1)}
                height={h}
                fill={below ? seriesColor(0, mode) : ink.muted}
                opacity={below ? 1 : 0.45}
              />
            )
          })}
          <rect
            className="explore-mark-preview__marker"
            x={Math.min(Math.max(x - 1, 0), PREVIEW_W - 2)}
            y={0}
            width={2}
            height={SPREAD_H}
            fill={ink.primary}
          />
        </svg>
      </div>
      <div className="explore-mark-preview__axis">
        <span>{formatMeasure(spread.lo, unit)}</span>
        {spread.scale === 'log' && <span>log scale</span>}
        <span>{formatMeasure(spread.hi, unit)}</span>
      </div>
      <div className="explore-mark-preview__note">{caption}</div>
    </>
  )
}

/** A prediction and how far to trust it, the bar enlarged. */
export function ConfidencePreview({
  value,
  label,
  mode,
}: {
  value: number
  label: string
  mode: Mode
}) {
  return (
    <>
      <div className="explore-mark-preview__value">{confidenceText(label, value)}</div>
      <div className="explore-mark-preview__figure">
        <ConfidenceBar
          value={value}
          label={label}
          mode={mode}
          width={PREVIEW_W}
          height={BAR_H}
        />
      </div>
      {value < LOW && (
        <div className="explore-mark-preview__note">
          Drawn grey: under {Math.round(LOW * 100)}%, a prediction too weak to read as a
          category.
        </div>
      )}
    </>
  )
}
