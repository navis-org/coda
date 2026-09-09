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
import type { Distributions, MarkSlot, PlotSpec } from './rowPlots'
import { MARK_GAP, MARK_PAD, MARK_W, balanceOf, percentileOf } from './rowPlots'
import { BalanceBar, ConfidenceBar, PercentileTick, RegionBar } from './RowMarks'
import type { RegionShare } from './rowRois'

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
  onContextMenu?: (row: number, at: { x: number; y: number }) => void
  /**
   * The theme, read once for the whole page rather than per mark — see `RowMarks`. Also what makes
   * the marks repaint on a flip, which reading during render does not.
   */
  mode: Mode
  /** Which inline marks this dataset supports, and the spread they are read against. */
  plots?: { spec: PlotSpec; slots: readonly MarkSlot[]; distributions: Distributions }
  /**
   * This page's region bars, keyed by neuron id.
   *
   * Separate from `plots` because it arrives *later* — everything else on a row is already in the
   * index, and this is one query per page. A row simply draws no bar until it lands.
   */
  regions?: Map<string, RegionShare[]>
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
export function rowTemplate(
  columns: number,
  stats: number,
  /** How many marks the *dataset* draws — not how many this row happens to have. */
  marks = 0,
): React.CSSProperties {
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
   * different amount per row. Fixed, so it cannot.
   */
  return {
    gridTemplateColumns:
      `1.25rem ${TILE_PX}px minmax(0, 1fr) repeat(${columns}, 8rem)` +
      `${marks ? ` ${marksWidth(marks)}px` : ''} repeat(${stats}, 4.5rem)`,
    // Handed to CSS rather than repeated in it — see `MARK_W`.
    '--mark-w': `${MARK_W}px`,
    '--mark-gap': `${MARK_GAP}px`,
    '--mark-pad': `${MARK_PAD}px`,
  } as React.CSSProperties
}

/**
 * The marks' track, sized from how many the *dataset* draws.
 *
 * Fixed and not `auto`, which is the third time that distinction has bitten in this template: an
 * `auto` track sizes to its own row's content, so the header's empty span measured 28px against a
 * row's 124px and every column after it sat 96px out. It also has to be the dataset's mark count
 * rather than the row's — a neuron missing `pre` draws no balance bar, and a track that shrank
 * for it would pull that one row's figures left of everybody else's.
 *
 * The numbers are `rowPlots`', which is also where the marks themselves read them and where the
 * custom properties below take them from: one home, three readers.
 */
function marksWidth(marks: number): number {
  return marks * MARK_W + (marks - 1) * MARK_GAP + MARK_PAD
}

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
  plots,
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
  const aligned = fields.columns.length > 0
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
      style={
        aligned
          ? rowTemplate(fields.columns.length, fields.stats.length, plots?.slots.length ?? 0)
          : undefined
      }
      onContextMenu={
        onContextMenu &&
        ((event) => {
          // The browser's own menu offers nothing about a neuron, and leaving it is how a
          // right-click ends up meaning two different things on one surface.
          event.preventDefault()
          onContextMenu(row, { x: event.clientX, y: event.clientY })
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
        The aligned half. One cell per column on *every* row, blank included — a missing value
        here says "not annotated", which is the whole reason a column beats a chip for a field
        most neurons carry. `fields.columns` is empty on a card, so this renders nothing there.
      */}
      {fields.columns.map((name) => {
        const value = cellOf(table, name, row)
        const empty = value === null || value === ''
        return (
          <div
            key={name}
            className="explore-cell"
            data-empty={empty || undefined}
            title={empty ? `${name}: not annotated` : `${name}: ${formatCell(value, name)}`}
          >
            {empty ? '—' : formatCell(value, name)}
          </div>
        )
      })}

      {/*
        One slot per mark the *dataset* draws, in `markSlots`' order — the header lays its labels
        out on the same pitch, so slot `i` is named by label `i` and nothing else ties them
        together. A row with no value for a mark keeps its slot empty rather than dropping the
        child: `regions` is absent for the first settle of every page, and a row that packed left
        put the confidence bar under the `regions` label on ordinary pages.
      */}
      {plots && (
        <div className="explore-marks">
          {plots.slots.map((slot) => (
            <MarkSlotView
              key={slot.kind}
              slot={slot}
              spec={plots.spec}
              distributions={plots.distributions}
              table={table}
              row={row}
              shares={shares}
              mode={mode}
            />
          ))}
        </div>
      )}

      {/*
        Each figure is its own grid track when the row is aligned, so it sits under its header —
        wrapped in one box, they would share a single track and drift with the digits.
      */}
      <StatsWrap aligned={aligned}>
        {fields.stats.map((name) => {
          const value = cellOf(table, name, row)
          const unit = statUnit(table.schema, name)
          /*
           * Glanceable on screen, exact on hover. The figure is scaled into the unit a reader
           * thinks in — a cable length is millimetres of arbor, not three million nanometres —
           * and the title carries the stored number **verbatim**, which is the one to copy into
           * anything else: `formatNumber` would group and round it, so the hover would answer
           * the one question it exists for with a different number.
           *
           * The unit stays on the label rather than after the value, so it survives an absent
           * one. What a column is *in* is the one thing an empty cell can still say, and it is
           * what the title said before any of this.
           */
          const label = unit ? `${name} (${unit})` : name
          const title = typeof value === 'number' ? `${label}: ${formatExact(value)}` : label
          return (
            <span key={name} className="explore-stat" title={title}>
              <span className="explore-stat__value">
                {typeof value === 'number' ? formatMeasure(value, unit) : '—'}
              </span>
              {/*
                The label is the header's job wherever there is one — repeating it under every
                figure is the same word twenty-five times down a column that already says it.
                Without columns (a card) there is no header, so it stays.
              */}
              {!aligned && <span className="explore-stat__label">{name}</span>}
            </span>
          )
        })}
      </StatsWrap>
    </div>
  )
}

/**
 * One mark's slot: the mark where this row has the values for it, an empty box of the same width
 * where it does not. Never nothing — see the call site.
 */
function MarkSlotView(props: MarkSlotProps) {
  return drawMark(props) ?? <span className="explore-mark--empty" aria-hidden="true" />
}

interface MarkSlotProps {
  slot: MarkSlot
  spec: PlotSpec
  distributions: Distributions
  table: TableValue
  row: number
  shares: RegionShare[] | undefined
  /** Read once for the page and handed down — see `RowMarks`. */
  mode: Mode
}

function drawMark({ slot, spec, distributions, table, row, shares, mode }: MarkSlotProps) {
  if (slot.kind === 'balance' && spec.balance) {
    const balance = balanceOf(
      cellOf(table, spec.balance.pre, row),
      cellOf(table, spec.balance.post, row),
    )
    return balance ? <BalanceBar balance={balance} mode={mode} /> : null
  }
  if (slot.kind === 'percentile' && spec.percentile) {
    const at = percentileOf(distributions, spec.percentile, cellOf(table, spec.percentile, row))
    return at ? (
      <PercentileTick
        percentile={at}
        unit={statUnit(table.schema, spec.percentile)}
        name={spec.percentile}
        mode={mode}
      />
    ) : null
  }
  if (slot.kind === 'regions') return shares ? <RegionBar shares={shares} mode={mode} /> : null
  if (slot.kind === 'confidence' && spec.confidence) {
    const value = cellOf(table, spec.confidence.value, row)
    const label = cellOf(table, spec.confidence.label, row)
    return typeof value === 'number' ? (
      <ConfidenceBar value={value} label={String(label ?? 'prediction')} mode={mode} />
    ) : null
  }
  return null
}

/** A flex box on a card, nothing at all on an aligned row — see the call site. */
function StatsWrap({ aligned, children }: { aligned: boolean; children: React.ReactNode }) {
  if (aligned) return <>{children}</>
  return <div className="explore-row__stats">{children}</div>
}

export const NeuronRow = memo(NeuronRowImpl)
