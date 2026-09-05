/**
 * The tile primitives two dashboard viewers share.
 *
 * Extracted from `ProfileViewer` when the Dataset Summary arrived, rather than copied — the same
 * call `LegendKeys` records, and for the same reason. Two viewers drawing their own tiles is how
 * two viewers end up disagreeing about what "loading" looks like, or about whether a bar is
 * scaled against the row above it or against the total.
 *
 * The stylesheet block was renamed with them: `.profile__tile` and friends became `.tile*` at the
 * same time, since a prefix naming one of two consumers is a claim that goes stale. Same call, and
 * the same wording, as `.labels-body` becoming `.list-body` when `InputIdsBody` joined it.
 *
 * What is deliberately *not* here is anything that knows what a tile is about. `Chips`, the shape
 * preview and the pager stayed in `ProfileViewer`, because they are that viewer's subject rather
 * than its furniture.
 */

import type { ReactNode } from 'react'

import type { CellValue } from '../../core/values'
import { formatCell, formatShare } from '../format'

export function Tile({
  label,
  qualifier,
  action,
  wide,
  span,
  collapsible,
  children,
}: {
  label: string
  qualifier?: string
  /**
   * A control in the heading — a pager, a measure switch.
   *
   * In the heading rather than under the content, because the content is what scrolls: a
   * control below a twelve-row chart is off screen exactly when the chart is long enough to
   * need one. Same reasoning that puts the card's fold button in the node header.
   */
  action?: ReactNode
  /** Full width of the grid, however many columns it has. */
  wide?: boolean
  /**
   * Tracks this tile covers, in both directions — `2` makes it 2×2.
   *
   * For content that a one-cell tile cannot hold rather than for emphasis. A grid column is
   * ~190px, which is not a 3D viewer; it is barely neuroglancer's layer bar.
   */
  span?: 2
  collapsible?: boolean
  children: ReactNode
}) {
  const heading = (
    <>
      {label}
      {qualifier && <span className="tile__qualifier">{qualifier}</span>}
      {action && <span className="tile__action">{action}</span>}
    </>
  )

  if (collapsible) {
    return (
      <details className="tile" data-wide={wide || undefined} data-span={span}>
        <summary className="tile__label">{heading}</summary>
        {children}
      </details>
    )
  }

  return (
    <section className="tile" data-wide={wide || undefined} data-span={span}>
      <h4 className="tile__label">{heading}</h4>
      {children}
    </section>
  )
}

/**
 * A tile's body while its data is in flight.
 *
 * The tile keeps its heading throughout, so the layout does not reflow as three requests land
 * — a grid that reshuffles on every page turn is far more distracting than a moment of
 * "loading".
 */

export function Loadable({
  state,
  empty,
  emptyLabel,
  children,
}: {
  state: 'none' | 'loading' | 'ready' | 'error'
  empty?: boolean
  /**
   * What to say instead of the bare "None".
   *
   * A tile with one possible reason for being empty can leave this out. A tile whose emptiness
   * has several — no regions published, none matching the chosen measure, a metadata call that
   * has not landed — has to say which, or the reader is told a dataset has no regions when the
   * truth is that this app has not finished asking.
   */
  emptyLabel?: string
  children: ReactNode
}) {
  if (state === 'loading') return <p className="tile__pending">Loading…</p>
  if (state === 'error') return <p className="tile__pending">Unavailable</p>
  if (state === 'none') return <p className="tile__pending">No dataset</p>
  if (empty) return <p className="tile__pending">{emptyLabel ?? 'None'}</p>
  return <>{children}</>
}

export function Facts({ rows }: { rows: Array<[string, CellValue | undefined]> }) {
  const present = rows.filter(
    ([, value]) => value !== null && value !== undefined && value !== '',
  )
  if (present.length === 0) return null
  return (
    <dl className="tile__facts">
      {present.map(([key, value]) => (
        <div key={key} className="tile__fact">
          <dt>{key}</dt>
          <dd title={String(value)}>{formatCell(value as CellValue)}</dd>
        </div>
      ))}
    </dl>
  )
}

export interface BarRow {
  /**
   * Identity, and the label unless `label` says otherwise.
   *
   * The two were one field until the metrics card wanted histogram bins, where they genuinely
   * differ: two adjacent bins of a heavy-tailed column round to the same printed range at the
   * low end, so the text repeats while the rows are distinct. React reuses a row's DOM for
   * whatever shares its key, so one bin was drawing another's count — and disambiguating the
   * *key* put `3:` in front of every label on screen.
   */
  key: string
  /** What to print, where that is not the key. */
  label?: string
  /**
   * This bar's own colour, overriding the set's.
   *
   * For a series whose colour carries meaning rather than identity — Neuron Topology's cable per
   * Strahler order, where the ramp *is* the order. Absent, every bar takes the shared `color`,
   * which is what every other caller wants.
   */
  color?: string
  title?: string
  /** 0..1 of the tile's width. */
  fraction: number
  value: string
  detail?: string
}

export function Bars({ rows, color }: { rows: BarRow[]; color: string }) {
  if (rows.length === 0) return null
  return (
    <div className="tile__bars">
      {rows.map((row) => (
        <div key={row.key} className="tile__bar" title={row.title ?? row.key}>
          <span className="tile__bar-key">{row.label ?? row.key}</span>
          <span className="tile__bar-track">
            <span
              className="tile__bar-fill"
              style={{
                width: `${Math.max(0, Math.min(1, row.fraction)) * 100}%`,
                background: row.color ?? color,
              }}
            />
          </span>
          <span className="tile__bar-value">
            {row.value}
            {row.detail && <span className="tile__bar-detail">{row.detail}</span>}
          </span>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Donut
// ---------------------------------------------------------------------------

export interface Slice {
  key: string
  value: number
  /** 0..1 of the whole. Passed in rather than derived, so the caller decides the denominator. */
  share: number
  color: string
  title?: string
}

/**
 * A few categories as a ring, with the total in the middle.
 *
 * A ring rather than a pie because the hole is what makes the total readable — and the total is
 * the thing a reader needs to judge every slice against, which a pie has nowhere to put. Codex
 * draws its Side and Flow panels the same way and its longer lists as bars, which is the right
 * split: a ring is a *part-of-whole* claim and stops being legible somewhere around five slices,
 * where a ranked bar chart keeps working at fifty.
 *
 * The labels are beside the ring rather than on it. Slice text has to shrink with the slice, so a
 * 3% category is either illegible or leadered out to somewhere it fits; a legend row is the same
 * width whatever the share. That also means the colour is never the only identification — the
 * same rule the socket palette and the Explore chips follow.
 */
export function Donut({ slices, total }: { slices: Slice[]; total: string }) {
  const drawn = slices.filter((s) => s.share > 0)
  if (drawn.length === 0) return null

  return (
    <div className="tile__donut">
      <svg className="tile__donut-ring" viewBox="0 0 42 42" role="presentation">
        {/*
         * Drawn with `stroke-dasharray` on one circle per slice rather than with arc paths.
         * The circumference is 2πr, so a slice is `share * C` of dash followed by the rest as
         * gap, rotated to where the previous slice ended — which means a slice covering the
         * whole ring is an ordinary full-length dash rather than the degenerate arc an
         * `A`-command path produces when its start and end coincide.
         */}
        {drawn.map((slice, i) => {
          const offset = drawn.slice(0, i).reduce((sum, s) => sum + s.share, 0)
          return (
            <circle
              key={slice.key}
              className="tile__donut-slice"
              cx="21"
              cy="21"
              r={RADIUS}
              fill="none"
              stroke={slice.color}
              strokeWidth="6"
              strokeDasharray={`${slice.share * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
              // -90deg so the first slice starts at twelve o'clock, which is where a reader
              // looks first; SVG's own zero is three o'clock.
              transform={`rotate(${offset * 360 - 90} 21 21)`}
            >
              <title>{slice.title ?? slice.key}</title>
            </circle>
          )
        })}
        <text className="tile__donut-total" x="21" y="21" textAnchor="middle" dy="0.36em">
          {total}
        </text>
      </svg>

      <ul className="tile__donut-keys">
        {drawn.map((slice) => (
          <li key={slice.key} className="tile__donut-key" title={slice.title ?? slice.key}>
            <span className="tile__donut-swatch" style={{ background: slice.color }} />
            <span className="tile__donut-name">{slice.key}</span>
            <span className="tile__donut-share">{formatShare(slice.share)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

const RADIUS = 15.9155
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export interface ColumnBar {
  /**
   * Identity, not text — `BarRow`'s split, for `BarRow`'s reason. Two adjacent histogram bins
   * round to the same printed range at the low end of a heavy tail, and React reuses a cell's
   * DOM for whatever shares its key, so one bin would draw another's count.
   */
  key: string
  /** What to print under the column, where that is not the key. */
  label?: string
  /** 0..1 of the axis. What the axis *is* is the caller's — see below. */
  fraction: number
  value: string
  title?: string
}

export interface ColumnReference {
  /** 0..1 on the same axis as the bars. */
  fraction: number
  /** Printed at the end of the line, e.g. `mean 42%`. */
  label: string
  title?: string
}

/**
 * A vertical bar chart on an axis the caller decides.
 *
 * **A quantity with a ceiling is drawn against its ceiling.** Completeness is a *fraction of
 * something*, so 90% has to look like nine tenths of the plot — normalising against the best
 * region would draw the best one full height whether it were 90% or 9%, and a reader comparing
 * two datasets would be comparing two different scales with nothing on screen saying so. That is
 * the rule, and it is why this is not `Bars` rotated.
 *
 * A **count** has no such ceiling, so the Network Metrics histogram scales its bars against the
 * tallest one — which is not the same mistake, because there is no external scale left to
 * misrepresent and the tallest bar is the only thing a count can be a fraction of. The rule
 * forbids inventing a scale for a quantity that already has one, not having a scale at all.
 *
 * **Three aligned bands, not one element per column**, and that structure is load-bearing twice
 * over. Values, tracks and labels are three flex rows of equally-sized cells, so the tracks all
 * begin and end at the same two lines whatever the labels do.
 *
 * The first version nested all three inside one per-column flex box, and the labels are vertical
 * text of wildly differing length — `AL(R)` against `mVAC(T3)(R)` — so a long name ate its own
 * column's track and lifted that bar's baseline above its neighbours'. Two regions 1% apart drew
 * a centimetre apart, which is a chart that is wrong rather than untidy.
 *
 * It is also what lets a reference line be correct. Positioned against the *band*, `bottom: 42%`
 * is the same 42% the bars are drawn to; the earlier gridlines sat in the outer plot, where the
 * value and label rows shortened the bars' own box and the 50% line landed nowhere near the
 * middle of a 50% bar. A rule that disagrees with its bars is worse than no rule, so that one was
 * removed — this one shares their box by construction.
 */
export function Columns({
  bars,
  color,
  reference,
}: {
  bars: ColumnBar[]
  color: string
  reference?: ColumnReference | undefined
}) {
  if (bars.length === 0) return null
  return (
    <div className="tile__columns">
      <div className="tile__columns-grid">
        <div className="tile__columns-row">
          {bars.map((bar) => (
            <span key={bar.key} className="tile__column-cell tile__column-value">
              {bar.value}
            </span>
          ))}
        </div>

        <div className="tile__columns-band">
          {bars.map((bar) => (
            <span
              key={bar.key}
              className="tile__column-cell tile__column-track"
              title={bar.title ?? bar.key}
            >
              <span
                className="tile__column-fill"
                style={{
                  height: `${Math.max(0, Math.min(1, bar.fraction)) * 100}%`,
                  background: color,
                }}
              />
            </span>
          ))}
          {reference && (
            <span
              className="tile__columns-mean"
              style={{ bottom: `${Math.max(0, Math.min(1, reference.fraction)) * 100}%` }}
              title={reference.title ?? reference.label}
            >
              <span className="tile__columns-mean-label">{reference.label}</span>
            </span>
          )}
        </div>

        <div className="tile__columns-row">
          {bars.map((bar) => (
            <span
              key={bar.key}
              className="tile__column-cell tile__column-key"
              title={bar.title ?? bar.label ?? bar.key}
            >
              {bar.label ?? bar.key}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pager
// ---------------------------------------------------------------------------

/**
 * Step through a list a tile can only show part of.
 *
 * In the tile's heading rather than under the chart, so a tile that is scrolled to shows its
 * controls without hunting — and so the count sits beside the label it qualifies.
 *
 * Deliberately **not** a node param, unlike Profile's pager. That one writes `page` because the
 * widget it belongs to feeds a `Current` port and the index has to survive a reload; nothing
 * here feeds anything, so which slice of a chart is on screen is not a fact about the document.
 * A param per chart would also mean one per column name, which is a schema this node cannot know.
 */
export function Pager({
  page,
  pages,
  onPage,
  label,
}: {
  page: number
  pages: number
  onPage: (page: number) => void
  /** Read out for assistive tech, e.g. "class". */
  label: string
}) {
  if (pages <= 1) return null
  return (
    <span className="tile__pager">
      <button
        type="button"
        className="tile__page-btn"
        disabled={page <= 0}
        aria-label={`Previous ${label}`}
        onClick={() => onPage(page - 1)}
      >
        ‹
      </button>
      <span className="tile__page-count">
        {page + 1}/{pages}
      </span>
      <button
        type="button"
        className="tile__page-btn"
        disabled={page >= pages - 1}
        aria-label={`More ${label}`}
        onClick={() => onPage(page + 1)}
      >
        ›
      </button>
    </span>
  )
}
