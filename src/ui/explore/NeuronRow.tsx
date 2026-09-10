/**
 * One neuron in the Explore list.
 *
 * Deliberately dumb: every column it shows comes from the `RowFields` spec, so it never names a
 * dataset property and adding `hemilineage` to a row is a one-line edit in `rowFields.ts` rather
 * than a change here.
 *
 * Layout is thumbnail, then a name block, then annotation chips, then figures — the shape a
 * cell browser has because it works: the eye scans names down the left edge and only crosses to
 * the numbers when a candidate looks right.
 */

import type React from 'react'
import { memo } from 'react'

import { idText } from '../../core/ids'
import type { CellValue, TableValue } from '../../core/values'
import { formatCell, formatExact, formatMeasure } from '../format'
import { NeuronThumbnail, TILE_COMPACT_PX, TILE_PX } from './NeuronThumbnail'
import type { RowFields } from './rowFields'
import { chipKey, chipSlots, splitTags, statUnit } from './rowFields'
import type { Mode } from '../colors'
import type { Distributions } from './rowPlots'
import { barFraction, percentileOf, sharesOf } from './rowPlots'
import {
  ConfidenceBar,
  PartsDonut,
  PercentileTick,
  ShareRing,
  SideBars,
  StackedBar,
  ValueBar,
} from './RowMarks'
import type { RegionShare } from './rowRois'
import type { ColumnSpec } from './rowColumns'
import { columnWidth } from './rowColumns'

export interface NeuronRowProps {
  table: TableValue
  /** Row index into the index table, not a neuron id. */
  row: number
  fields: RowFields
  sourceId: string | undefined
  datasetId: string | undefined
  selected: boolean
  /**
   * Takes the neuron id rather than closing over it, so the parent can pass one stable
   * function for the whole page — a fresh `() => toggle(id)` per row defeated `memo`
   * outright, and every row re-rendered (thumbnail subtree included) on every tick.
   */
  /** Text, never a number: a wide root id does not survive a double. See invariant 8. */
  onToggle: (neuronId: string) => void
  /** Inside a node card rather than the full-size overlay: a smaller thumbnail. */
  compact: boolean
  /**
   * Right-click on this row, in client coordinates. Absent on a card, which has no menu.
   *
   * Takes the row index rather than the neuron id, unlike `onToggle`: the menu needs the row's
   * type as well, and the index is what reaches every column. Stable for the whole page for the
   * same reason `onToggle` is — a fresh arrow per row defeats `memo` outright.
   */
  onContextMenu?: (row: number, at: { x: number; y: number }, chip: string | undefined) => void
  /**
   * The theme, read once for the whole page rather than per mark — see `RowMarks`. Also what makes
   * the marks repaint on a flip, which reading during render does not.
   */
  mode: Mode
  /**
   * The expanded view's columns, and the spread its ranks and bars are read against.
   *
   * Present means aligned: the row is a grid and a header names its tracks. Absent is a card,
   * which has no width to align in and keeps its flex row of figures with their labels.
   */
  layout?: RowLayout
  /**
   * This page's region bars, keyed by neuron id.
   *
   * Separate from `layout` because it arrives *later* — everything else on a row is already in the
   * index, and this is one query per page. A row simply draws no bar until it lands.
   */
  regions?: Map<string, RegionShare[]>
}

/** What an aligned row draws, shared by every row of a page — see `NeuronRowProps.layout`. */
export interface RowLayout {
  columns: readonly ColumnSpec[]
  distributions: Distributions
  /** `rowTemplate(columns)`, built once for the page and its header rather than once per row. */
  style: React.CSSProperties
}

/**
 * How many tags a row draws before it starts counting.
 *
 * Small on purpose. These are the least structured thing on the row and the least likely to be
 * what somebody is scanning for, so they get the least width — four is about what fits beside a
 * name without the row becoming a paragraph.
 */
const MAX_ROW_TAGS = 4

/**
 * The grid template a row and the header share.
 *
 * Exported because the header must use the *same* one — two spellings of a column layout is how
 * a header comes to sit half a column left of the values under it. The name block is the only
 * flexible track: it takes what the fixed ones leave, so a narrow window squeezes the name rather
 * than crushing every column equally.
 */
export function rowTemplate(columns: readonly ColumnSpec[]): React.CSSProperties {
  /*
   * **Every track is a fixed size except the name block, and that is the whole of what makes the
   * columns line up.** The first version wrote `auto auto minmax(0, 1fr) repeat(n, minmax(0,
   * 8rem)) auto` and nothing aligned, in two ways a browser shows and jsdom cannot:
   *
   *  - An `auto` track sizes to *its own row's* content. The header has no checkbox and no
   *    thumbnail, so its first two tracks collapsed to zero and its labels sat 110px right of the
   *    values they named.
   *  - The trailing `auto` held the figures, whose width follows the digits — `400` against
   *    `1,496` — so the row's own columns drifted a few pixels against each other.
   *
   * `minmax(0, 8rem)` was the third mistake: a column that may shrink to nothing shrinks by a
   * different amount per row. Fixed, so it cannot — and a mark's track is fixed from what the
   * *column* draws rather than from what this row has a value for, so a neuron missing `pre` keeps
   * its figures under their labels. The last track is the header's `+`, empty on every row.
   */
  return {
    gridTemplateColumns:
      `1.25rem ${TILE_PX}px minmax(0, 1fr)` +
      columns.map((column) => ` ${columnWidth(column)}`).join('') +
      ` ${ADD_TRACK}`,
  }
}

/** The header's trailing `+`, a track of its own so adding a column never shifts the others. */
const ADD_TRACK = '1.25rem'

function cellOf(table: TableValue, name: string, row: number): CellValue {
  const column = table.data[name]
  const value = column?.[row]
  return value === undefined ? null : value
}

function NeuronRowImpl({
  table,
  row,
  fields,
  sourceId,
  datasetId,
  selected,
  onToggle,
  compact,
  onContextMenu,
  layout,
  regions,
  mode,
}: NeuronRowProps) {
  // `idText` keeps a wide id exactly; `Number(cell)` would round it before the thumbnail
  // cache key and the 3D fetch ever see it.
  const neuronIdText = idText(cellOf(table, 'neuronId', row)) ?? ''
  const primary = fields.primary ? cellOf(table, fields.primary, row) : null
  /*
   * The card shows the same chips as the overlay, and `compact` reaches only the thumbnail.
   *
   * There was a cap here, on the grounds that a card is a preview. It was wrong twice over: it
   * cut the seventh chip on male-CNS, so a field in the default list was invisible in the place
   * the list is actually read, and it truncated a list chosen in the inspector, which is the
   * one thing a control like that must not do. `rowFields` already bounds the automatic list;
   * anything past that someone asked for by name.
   */
  // Slots resolved from the fields the *row spec* offers rather than from the ones this neuron
  // happens to have filled in, so a colour does not shift between two rows of the same list
  // because one of them is missing a value.
  /** Aligned mode: the row is a grid and a header names its columns. */
  const aligned = layout !== undefined
  /** This row's region segments, if the page's query has answered for it. */
  const shares = regions?.get(neuronIdText)
  const slots = chipSlots(fields.chips)
  const chips = fields.chips
    .map((name) => ({
      name,
      value: cellOf(table, name, row),
      slot: slots.get(name),
      key: chipKey(name),
    }))
    .filter((chip) => chip.value !== null && chip.value !== '')

  const secondary = fields.secondary
    .map((name) => cellOf(table, name, row))
    .filter((value): value is string => typeof value === 'string' && value.length > 0)

  /*
   * Community tags: free-form text somebody typed, not a controlled vocabulary.
   *
   * Capped rather than wrapped, so every row in the list keeps the same height — which is the
   * whole reason a list is scannable, and a neuron with forty tags would otherwise push several
   * others off the page. The counter says how many were held back and carries all of them in
   * its `title`, so nothing is hidden without saying so.
   */
  const tags = fields.tags ? splitTags(cellOf(table, fields.tags, row)) : []
  const shownTags = tags.slice(0, MAX_ROW_TAGS)
  const hiddenTags = tags.length - shownTags.length

  return (
    <div
      className="explore-row"
      data-selected={selected || undefined}
      data-aligned={aligned || undefined}
      // One template per row, from the same list the header uses — which is what makes the
      // columns line up at all. A card has no columns and falls back to the flex layout.
      style={layout?.style}
      onContextMenu={
        onContextMenu &&
        ((event) => {
          // The browser's own menu offers nothing about a neuron, and leaving it is how a
          // right-click ends up meaning two different things on one surface.
          event.preventDefault()
          // Which chip, if the press landed on one — the menu then offers to make it a column.
          const chip = (event.target as Element).closest?.('[data-field]')
          onContextMenu(
            row,
            { x: event.clientX, y: event.clientY },
            chip?.getAttribute('data-field') ?? undefined,
          )
        })
      }
    >
      <label className="explore-row__pick" title={selected ? 'Deselect' : 'Select'}>
        <input type="checkbox" checked={selected} onChange={() => onToggle(neuronIdText)} />
      </label>

      {/*
        The hover preview runs on a card too, and `compact` reaches only the tile's size.

        It was the overlay's alone on two objections, and the first turned out to be already
        answered: a card's preview has `.coda-node`'s clip to escape as well as the list's, from
        inside React Flow's transformed pane — which is exactly what the portal to
        `document.fullscreenElement ?? document.body` does, and `getBoundingClientRect` reports
        viewport coordinates through a transformed ancestor, which is what a `fixed` box on an
        untransformed host wants. Measured on a card rather than reasoned: see
        `pnpm probe:explore-preview`.

        What compact really costs is a softer *stand-in*, and only until the fine body lands. The
        tile's own mask is `56 × RASTER_SCALE` = 224 against the overlay's 304, so the picture
        held up in the meantime is upscaled 1.43× rather than 1.05×. The settled picture is the
        same on both — a 640 raster drawn at `PREVIEW_SIZE`, off a body neither tile fetched.
      */}
      <NeuronThumbnail
        sourceId={sourceId}
        datasetId={datasetId}
        neuronId={neuronIdText}
        size={compact ? TILE_COMPACT_PX : TILE_PX}
        hoverPreview
      />

      <div className="explore-row__main">
        <div className="explore-row__name">
          {/* A neuron with no type is normal in an unfinished dataset, and saying so beats an
              empty row that looks like a rendering bug. */}
          <strong>
            {primary === null || primary === ''
              ? 'untyped'
              : formatCell(primary, fields.primary)}
          </strong>
          <span className="explore-row__id">{neuronIdText}</span>
        </div>
        {secondary.length > 0 && (
          <div className="explore-row__sub">{secondary.join(' · ')}</div>
        )}
        {chips.length > 0 && (
          <div className="explore-row__chips">
            {chips.map((chip) => (
              <span
                key={chip.name}
                className="explore-chip"
                data-field={chip.name}
                // The hue is resolved in CSS rather than computed here, so a theme switch
                // recolours every chip without re-rendering a memoised row.
                data-slot={chip.slot}
                title={chip.name}
              >
                {chip.key && <span className="explore-chip__key">{chip.key}</span>}
                {formatCell(chip.value, chip.name)}
              </span>
            ))}
          </div>
        )}
        {shownTags.length > 0 && (
          <div className="explore-row__tags">
            {shownTags.map((tag, at) => (
              // Keyed by position as well as text: a base can hold the same tag twice, and two
              // children with one key is a React warning and a dropped node.
              <span key={`${at}:${tag}`} className="explore-tag" title={tag}>
                {tag}
              </span>
            ))}
            {hiddenTags > 0 && (
              <span className="explore-tag explore-tag--more" title={tags.join('\n')}>
                +{hiddenTags} more
              </span>
            )}
          </div>
        )}
      </div>

      {/*
        The aligned half: one grid child per column on *every* row, blank included — a missing
        value says "not annotated", which is the whole reason a column beats a chip for a field
        most neurons carry, and a mark with nothing to draw keeps its track empty rather than
        letting the next column slide under the wrong label.
      */}
      {layout ? (
        layout.columns.map((column, at) => (
          <ColumnCell
            // Position is the key: a cell holds no state, and one list may hold a column twice.
            key={at}
            column={column}
            distributions={layout.distributions}
            table={table}
            row={row}
            shares={shares}
            mode={mode}
          />
        ))
      ) : (
        /*
         * A card: no header, so each figure carries its own label beneath it — which on an aligned
         * row would be the same word twenty-five times down a column that already says it once.
         */
        <div className="explore-row__stats">
          {fields.stats.map((name) => (
            <Figure key={name} table={table} row={row} name={name} labelled />
          ))}
        </div>
      )}
    </div>
  )
}

interface ColumnCellProps {
  column: ColumnSpec
  distributions: Distributions
  table: TableValue
  row: number
  shares: RegionShare[] | undefined
  /** Read once for the page and handed down — see `RowMarks`. */
  mode: Mode
}

/** One column's cell: text, a figure, or a mark — or an empty box of the mark's width. */
function ColumnCell(props: ColumnCellProps) {
  const { column, table, row } = props
  const name = column.fields[0] ?? ''
  if (column.render === 'text' && column.fields.length > 1) {
    return (
      <Values
        table={table}
        row={row}
        fields={column.fields}
        readable={column.readable === true}
      />
    )
  }
  if (column.render === 'text') {
    const value = cellOf(table, name, row)
    const empty = value === null || value === ''
    return (
      <div
        className="explore-cell"
        data-empty={empty || undefined}
        title={empty ? `${name}: not annotated` : `${name}: ${formatCell(value, name)}`}
      >
        {empty ? '—' : formatCell(value, name)}
      </div>
    )
  }
  if (column.render === 'number') {
    return <Figure table={table} row={row} name={name} readable={column.readable === true} />
  }
  return drawMark(props) ?? <span className="explore-mark--empty" aria-hidden="true" />
}

/**
 * The mark a column draws. An explicit return type and no `default`, so a renderer added to
 * `rowColumns.ts` without a case here is a compile error rather than an empty box on every row.
 */
function drawMark({
  column,
  distributions,
  table,
  row,
  shares,
  mode,
}: ColumnCellProps): React.ReactElement | null {
  const [first = '', second = ''] = column.fields
  switch (column.render) {
    case 'bar':
    case 'logBar': {
      const value = cellOf(table, first, row)
      const log = column.render === 'logBar'
      const fraction = barFraction(distributions, first, value, log)
      return fraction === null ? null : (
        <ValueBar
          fraction={fraction}
          value={value as number}
          name={first}
          unit={statUnit(table.schema, first)}
          log={log}
          mode={mode}
        />
      )
    }
    case 'rank': {
      const at = percentileOf(distributions, first, cellOf(table, first, row))
      return at ? (
        <PercentileTick
          percentile={at}
          unit={statUnit(table.schema, first)}
          name={first}
          mode={mode}
        />
      ) : null
    }
    case 'stacked':
    case 'bars':
    case 'donut': {
      const parts = sharesOf(
        column.fields,
        column.fields.map((name) => cellOf(table, name, row)),
      )
      if (!parts) return null
      if (column.render === 'stacked') return <StackedBar parts={parts} mode={mode} />
      if (column.render === 'bars') return <SideBars parts={parts} mode={mode} />
      return <PartsDonut parts={parts} mode={mode} />
    }
    case 'regions':
      return shares ? <ShareRing shares={shares} mode={mode} /> : null
    case 'confidence': {
      const value = cellOf(table, second, row)
      const label = cellOf(table, first, row)
      return typeof value === 'number' ? (
        <ConfidenceBar value={value} label={String(label ?? 'prediction')} mode={mode} />
      ) : null
    }
    case 'text':
    case 'number':
      // Drawn as text and figures by `ColumnCell`, before it asks for a mark.
      return null
  }
}

/**
 * Several numbers as one line of text, `12 / 340`, each scaled into its own unit.
 *
 * A missing value is a dash *in its own position* rather than dropped: `12 / 340` with the first
 * absent would otherwise read `340`, which is the same two fields saying something else. The title
 * carries every value verbatim, one per line, for `Figure`'s reason.
 */
function Values({
  table,
  row,
  fields,
  readable,
}: {
  table: TableValue
  row: number
  fields: readonly string[]
  /** Scaled and grouped, or each value verbatim — see `ColumnSpec.readable`. */
  readable: boolean
}) {
  const cells = fields.map((name) => cellOf(table, name, row))
  const empty = cells.every((value) => typeof value !== 'number')
  const text = cells
    .map((value, i) => formatFigure(value, statUnit(table.schema, fields[i]!), readable))
    .join(' / ')
  const title = fields
    .map((name, i) => {
      const value = cells[i]
      return `${name}: ${typeof value === 'number' ? formatExact(value) : 'no value'}`
    })
    .join('\n')
  return (
    <div
      className="explore-cell explore-cell--values"
      data-empty={empty || undefined}
      title={title}
    >
      {text}
    </div>
  )
}

/**
 * One figure: glanceable on screen, exact on hover.
 *
 * The figure is scaled into the unit a reader thinks in — a cable length is millimetres of arbor,
 * not three million nanometres — and the title carries the stored number **verbatim**, which is
 * the one to copy into anything else: `formatNumber` would group and round it, so the hover would
 * answer the one question it exists for with a different number.
 *
 * The unit stays on the label rather than after the value, so it survives an absent one. What a
 * column is *in* is the one thing an empty cell can still say.
 */
function Figure({
  table,
  row,
  name,
  labelled = false,
  readable = true,
}: {
  table: TableValue
  row: number
  name: string
  /** A card's figure names itself; an aligned one leaves that to the header. */
  labelled?: boolean
  /**
   * Scaled and grouped, or the stored number verbatim — see `ColumnSpec.readable`. On by default,
   * which is the card: its figures are not columns anybody configured.
   */
  readable?: boolean
}) {
  const value = cellOf(table, name, row)
  const unit = statUnit(table.schema, name)
  const label = unit ? `${name} (${unit})` : name
  const title = typeof value === 'number' ? `${label}: ${formatExact(value)}` : label
  return (
    <span className="explore-stat" data-exact={!readable || undefined} title={title}>
      <span className="explore-stat__value">{formatFigure(value, unit, readable)}</span>
      {labelled && <span className="explore-stat__label">{name}</span>}
    </span>
  )
}

/**
 * A number as a cell prints it — verbatim, or scaled into its unit (`ColumnSpec.readable`) — and a
 * dash where there is none. One spelling for a figure and for merged numbers as text.
 */
function formatFigure(value: CellValue, unit: string | undefined, readable: boolean): string {
  if (typeof value !== 'number') return '—'
  return readable ? formatMeasure(value, unit) : formatExact(value)
}

export const NeuronRow = memo(NeuronRowImpl)
