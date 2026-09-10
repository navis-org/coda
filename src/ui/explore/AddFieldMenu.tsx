/**
 * What the header's `+` opens: every field, each with a choice of **column** or **chip**.
 *
 * The decision used to be the fill rule's alone — a field on at least half the neurons became a
 * column, anything sparser a chip — so somebody adding a sparse field got a chip and then had to
 * find one on a row before they could promote it. Here the choice is made where the field is
 * added, and the list doubles as a map of where every field already is: the pressed half of each
 * pair is its current place, which is also what stops a click from placing a field twice.
 *
 * Clicking the pressed half again **hides** the field, which is the one thing the row itself could
 * never do before the list held chips too.
 *
 * One gesture per click, and the menu stays open: placing four fields is four clicks, not four
 * trips through a menu. Merging several fields into one column is a different question — which
 * fields, drawn how — and keeps its own editor behind "Combine…".
 */

import { useRef, useState } from 'react'

import { useDismissOnOutside } from '../useDismiss'
import {
  FilterInput,
  KindBadge,
  NoMatch,
  matching,
  popoverStyle,
  stopCanvasKeys,
} from './fieldPopover'
import type { Place } from './rowColumns'
import { LAST_FIELD_HINT } from './rowColumns'

export interface FieldPlace {
  name: string
  numeric: boolean
  place: Place
}

export interface AddFieldMenuProps {
  anchor: { left: number; bottom: number }
  fields: readonly FieldPlace[]
  /** Whether hiding a field leaves anything shown — `isEmptyLayout`, asked of the result. */
  canHide: (name: string) => boolean
  onColumn: (name: string) => void
  onChip: (name: string) => void
  onHide: (name: string) => void
  onCombine: () => void
  onClose: () => void
}

const MERGED_HINT = 'Part of a merged column — edit that column to take it out'

/** What one half of a field's pair says on hover, given where the field is now. */
function halfTitle(half: 'column' | 'chip', place: Place, refused: boolean): string {
  if (place === 'merged') return MERGED_HINT
  if (place === half) return refused ? LAST_FIELD_HINT : `A ${half} now — click to hide it`
  return half === 'column'
    ? 'Line it up in a column of its own, on every row'
    : 'Show it as a chip, on the rows that have a value'
}

export function AddFieldMenu({
  anchor,
  fields,
  canHide,
  onColumn,
  onChip,
  onHide,
  onCombine,
  onClose,
}: AddFieldMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  useDismissOnOutside(ref, onClose, { onEscape: true })
  const [filter, setFilter] = useState('')
  const shown = matching(fields, filter, (f) => f.name)
  const place = { column: onColumn, chip: onChip }

  return (
    <div
      ref={ref}
      className="context-menu explore-colmenu explore-fieldmenu"
      role="dialog"
      aria-label="Add a field"
      style={popoverStyle(anchor)}
      onKeyDown={stopCanvasKeys}
    >
      <div className="context-menu__caption">Add a field</div>
      <FilterInput value={filter} onChange={setFilter} />
      <div className="explore-colmenu__fields" role="list" aria-label="Fields">
        {shown.map((field) => (
          <div
            key={field.name}
            className="explore-place"
            role="listitem"
            data-place={field.place}
          >
            <span className="explore-colmenu__name" title={field.name}>
              {field.name}
            </span>
            <KindBadge numeric={field.numeric} />
            <span className="explore-place__choice">
              {(['column', 'chip'] as const).map((half) => {
                // A merged field is "in a column", so that half is pressed and neither is live.
                const pressed =
                  field.place === half || (half === 'column' && field.place === 'merged')
                const refused = pressed && !canHide(field.name)
                return (
                  <button
                    key={half}
                    type="button"
                    aria-label={`Show ${field.name} as a ${half}`}
                    aria-pressed={pressed}
                    disabled={field.place === 'merged' || refused}
                    title={halfTitle(half, field.place, refused)}
                    onClick={() => (pressed ? onHide(field.name) : place[half](field.name))}
                  >
                    {half}
                  </button>
                )
              })}
            </span>
          </div>
        ))}
        {shown.length === 0 && <NoMatch filter={filter} />}
      </div>
      <p className="explore-colmenu__hint">
        A column lines a field up down the list; a chip appears on a row only where that neuron
        has a value. Click the highlighted half again to hide a field.
      </p>
      <div className="context-menu__sep" />
      <button
        type="button"
        className="context-menu__item explore-fieldmenu__combine"
        onClick={onCombine}
      >
        Combine several fields into one column…
      </button>
    </div>
  )
}
