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

import { memo } from 'react'

import { idText } from '../../core/ids'
import type { CellValue, TableValue } from '../../core/values'
import { formatCell, formatExact, formatMeasure } from '../format'
import { NeuronThumbnail } from './NeuronThumbnail'
import type { RowFields } from './rowFields'
import { chipKey, chipSlots, splitTags, statUnit } from './rowFields'

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
}

/**
 * How many tags a row draws before it starts counting.
 *
 * Small on purpose. These are the least structured thing on the row and the least likely to be
 * what somebody is scanning for, so they get the least width — four is about what fits beside a
 * name without the row becoming a paragraph.
 */
const MAX_ROW_TAGS = 4

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
    <div className="explore-row" data-selected={selected || undefined}>
      <label className="explore-row__pick" title={selected ? 'Deselect' : 'Select'}>
        <input type="checkbox" checked={selected} onChange={() => onToggle(neuronIdText)} />
      </label>

      <NeuronThumbnail
        sourceId={sourceId}
        datasetId={datasetId}
        neuronId={neuronIdText}
        size={compact ? 56 : 76}
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

      <div className="explore-row__stats">
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
              <span className="explore-stat__label">{name}</span>
            </span>
          )
        })}
      </div>
    </div>
  )
}

export const NeuronRow = memo(NeuronRowImpl)
