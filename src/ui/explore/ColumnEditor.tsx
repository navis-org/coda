/**
 * The popover a header cell opens: which fields a column reads, and how it draws them.
 *
 * Clicking a header edits that column, and "Combine several fields into one column…" in the `+`
 * menu opens the same editor empty — one editor, because adding is editing a column that does not
 * exist yet. **Merging is ticking a second field**: a column holding several counts draws them as
 * shares of their sum, so `axonIn`, `axonOut`, `dendriteIn` and `dendriteOut` become one split bar
 * by ticking four boxes. Drag-to-merge was the other shape on the table, and it cannot reach a
 * field the header does not already show — which on fish2 is all four of those.
 *
 * A `ContextMenu` (through `FieldPopover`), so Escape closes this rather than the whole overlay.
 * Changes are held in a draft until **Apply**, because every write is a param write and an undo
 * step — ticking four boxes live would be four of them, three describing a column nobody wanted.
 *
 * A column can also be **named**. The field's placeholder is the name it would otherwise get, so an
 * empty field is visibly "automatic" rather than blank, and a name equal to that is not stored.
 */

import { useId, useState } from 'react'

import type { TableSchema } from '../../core/types'
import { FieldPopover, FilterInput, KindBadge, matching, NoMatch } from './fieldPopover'
import type { ColumnSpec, Renderer } from './rowColumns'
import {
  LAST_FIELD_HINT,
  MAX_PARTS,
  automaticLabel,
  columnLabel,
  isBuiltin,
  printsFigures,
  rendererLabel,
  renderersFor,
  toggleField,
} from './rowColumns'

export interface ColumnEditorProps {
  /** Where the header cell sits, in client coordinates — the popover hangs below its left edge. */
  anchor: { left: number; bottom: number }
  /** The column being edited, or undefined to add one. */
  column: ColumnSpec | undefined
  schema: TableSchema | undefined
  /** The fields it may offer — `offerableFields`, handed down so both popovers offer one list. */
  offered: readonly string[]
  /** Which of them are numbers; the widget's own set, so the two popovers cannot disagree. */
  numeric: ReadonlySet<string>
  canMoveLeft: boolean
  canMoveRight: boolean
  /** False where removing it would leave the list empty — see `isEmptyLayout`. */
  canRemove: boolean
  /** Demote a one-field column to a chip. Absent for merged columns and the built-ins. */
  onShowAsChip?: () => void
  /** Whether a hand-built list is in force, so there is something to reset. */
  explicit: boolean
  onApply: (column: ColumnSpec) => void
  onMove: (delta: -1 | 1) => void
  onRemove: () => void
  onReset: () => void
  onClose: () => void
}

export function ColumnEditor({
  anchor,
  column,
  schema,
  offered,
  numeric,
  canMoveLeft,
  canMoveRight,
  canRemove,
  onShowAsChip,
  explicit,
  onApply,
  onMove,
  onRemove,
  onReset,
  onClose,
}: ColumnEditorProps) {
  const radioName = useId()

  // A built-in reads no field anybody could re-point, so it offers only a name, move and remove.
  const builtin = column !== undefined && isBuiltin(column)
  const [picked, setPicked] = useState<string[]>(builtin ? [] : [...(column?.fields ?? [])])
  const [chosen, setChosen] = useState<Renderer | undefined>(column?.render)
  const [filter, setFilter] = useState('')
  const shown = matching(offered, filter, (name) => name)

  const options = renderersFor(picked, schema)
  // What was chosen, while it can still draw the ticked fields; the best that can otherwise.
  const render = chosen && options.includes(chosen) ? chosen : options[0]
  const pickedNumbers = picked.filter((name) => numeric.has(name))
  const full = pickedNumbers.length >= MAX_PARTS

  const [name, setName] = useState(column?.label ?? '')
  // A column being added starts exact — see `ColumnSpec.readable`.
  const [readable, setReadable] = useState(column?.readable === true)
  /*
   * What Apply would write. A built-in keeps its own render and fields, since the editor offers it
   * nothing but a name; everything else is the draft. Left raw on purpose — `encodeColumn` drops a
   * name equal to the automatic one and a `readable` a column cannot use, so the editor cannot
   * store a shape nothing else would.
   */
  const target: ColumnSpec | undefined = builtin
    ? column
    : render
      ? { render, fields: picked }
      : undefined
  const automatic = target ? automaticLabel(target) : ''
  const named = name.trim()
  const draft: ColumnSpec | undefined = target && {
    render: target.render,
    fields: target.fields,
    ...(named ? { label: named } : {}),
    ...(readable ? { readable: true } : {}),
  }

  // The order ticked is the order the parts draw in, which is why it is kept and shown.
  const toggle = (name: string) => setPicked((held) => toggleField(held, name, numeric))

  const act = (fn: () => void) => () => {
    fn()
    onClose()
  }

  const title = column ? `Column · ${columnLabel(column)}` : 'Add a column'

  return (
    <FieldPopover anchor={anchor} label={title} className="explore-colmenu" onClose={onClose}>
      <div className="context-menu__caption">{title}</div>

      {!builtin && (
        <>
          <FilterInput value={filter} onChange={setFilter} />
          <div className="explore-colmenu__fields" role="group" aria-label="Fields">
            {shown.map((name) => {
              const at = picked.indexOf(name)
              const isNumber = numeric.has(name)
              return (
                <label
                  key={name}
                  className="explore-colmenu__field"
                  data-picked={at >= 0 || undefined}
                >
                  <input
                    type="checkbox"
                    checked={at >= 0}
                    // Only a *further* number is refused at the cap; a text field still swaps.
                    disabled={at < 0 && isNumber && full}
                    onChange={() => toggle(name)}
                  />
                  <span className="explore-colmenu__name" title={name}>
                    {name}
                  </span>
                  <KindBadge
                    numeric={isNumber}
                    order={at >= 0 && picked.length > 1 ? at + 1 : undefined}
                  />
                </label>
              )
            })}
            {shown.length === 0 && <NoMatch filter={filter} />}
          </div>

          <div className="explore-colmenu__renders" role="radiogroup" aria-label="Draw as">
            {options.length === 0 ? (
              <span className="explore-colmenu__hint">
                Tick a field to choose how it draws.
              </span>
            ) : (
              options.map((option) => (
                <label key={option} className="explore-colmenu__render">
                  <input
                    type="radio"
                    name={radioName}
                    checked={option === render}
                    onChange={() => setChosen(option)}
                  />
                  {rendererLabel(option)}
                </label>
              ))
            )}
          </div>
          {pickedNumbers.length > 1 && render !== 'text' && (
            <p className="explore-colmenu__hint">
              Each part is drawn as its share of their sum
              {full ? ` — ${MAX_PARTS} at most, one per colour.` : '.'}
            </p>
          )}
        </>
      )}

      {target && printsFigures(target) && (
        <label className="explore-colmenu__readable">
          <input
            type="checkbox"
            checked={readable}
            onChange={(event) => setReadable(event.target.checked)}
          />
          Human-readable formatting — 15.4K, not 15417
        </label>
      )}
      <label className="explore-colmenu__rename">
        <span>Name</span>
        <input
          className="explore-colmenu__filter"
          type="text"
          value={name}
          placeholder={automatic || 'Automatic'}
          aria-label="Column name"
          spellCheck={false}
          autoComplete="off"
          // A built-in has no field list, so the name is what it opens on.
          autoFocus={builtin}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && draft) act(() => onApply(draft))()
          }}
        />
      </label>
      <button
        type="button"
        className="explore-colmenu__apply"
        disabled={!draft}
        onClick={act(() => draft && onApply(draft))}
      >
        {column ? 'Apply' : 'Add column'}
      </button>

      {column && (
        <>
          <div className="context-menu__sep" />
          <button
            type="button"
            className="context-menu__item"
            disabled={!canMoveLeft}
            onClick={act(() => onMove(-1))}
          >
            Move left
          </button>
          <button
            type="button"
            className="context-menu__item"
            disabled={!canMoveRight}
            onClick={act(() => onMove(1))}
          >
            Move right
          </button>
          {onShowAsChip && (
            <button
              type="button"
              className="context-menu__item"
              title="Take it out of the header and show it as a chip on each row that has a value"
              onClick={act(onShowAsChip)}
            >
              Show as chip instead
            </button>
          )}
          <button
            type="button"
            className="context-menu__item context-menu__item--danger"
            disabled={!canRemove}
            title={canRemove ? undefined : LAST_FIELD_HINT}
            onClick={act(onRemove)}
          >
            Remove column
          </button>
        </>
      )}
      {explicit && (
        <>
          <div className="context-menu__sep" />
          <button
            type="button"
            className="context-menu__item"
            title="Forget this list and let Explore choose this dataset’s fields again"
            onClick={act(onReset)}
          >
            Reset to automatic fields
          </button>
        </>
      )}
    </FieldPopover>
  )
}
