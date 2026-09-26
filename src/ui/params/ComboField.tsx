/**
 * A text field with a filterable list under it: the widget behind `StringParam.suggestions`.
 *
 * It replaced a `<datalist>`, which fails in the two cases the widget is used for. A CAVE
 * datastack holds hundreds of tables and the browser's popup has no scroll position, no count and
 * no way to style a long list. Worse, it filters on whatever the field holds, so a field showing
 * the table already chosen offers *only that table*, and seeing the alternatives means erasing the
 * answer first. Here the list opens unfiltered, and filters once somebody types.
 *
 * **The value is still free text**, which is the whole difference from a `select`, for the reason
 * `StringParam.suggestions` records. A listing needs a credential and may not have landed, and a
 * name not on it is a name somebody may still mean. Commit rules are `useDraftText`'s, shared with
 * `TextField`: blur and Enter commit, and a debounce commits while typing.
 *
 * **One element type whatever the list holds.** The listing answers `undefined` on the first
 * render and arrives a beat later, and swapping the input for another element mid-session takes
 * the caret, the focus and a pending commit with it. So the input is always this input, and an
 * empty list is simply a popup that never opens: no arrow, nothing to open onto.
 *
 * **The list is portalled to the body**, or to the fullscreen element when there is one, where a
 * portal to the body is placed correctly and invisible. A card clips (`.coda-node` is `overflow:
 * hidden`) and is scaled by the canvas zoom, so a list drawn inside it would be cut off at the
 * card's foot and shrink to illegibility when zoomed out. Fixed to the window, it tracks the input
 * once per frame while open, since a pan moves the input without firing any event on it
 * (`useHoverPanel`'s finding). The position is written onto the element rather than into state,
 * so a pan does not re-render up to `MAX_SHOWN` rows every frame.
 */

import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { suggestionOption } from '../../core/node'
import type { Suggestion, SuggestionOption } from '../../core/node'
import { layoutViewport, menuShift } from '../menu/placement'
import { useListNav } from '../useListNav'
import { useDraftText } from './useDraftText'

/** Past this many matches the list stops and says how many more there are. Typing narrows it. */
const MAX_SHOWN = 300
/** The list's narrowest, so a field squeezed onto a card still opens onto readable names. */
const MIN_WIDTH = 220

export interface ComboFieldProps {
  label: string
  value: string
  options: readonly Suggestion[]
  placeholder?: string | undefined
  mono?: boolean | undefined
  title?: string | undefined
  /**
   * Adds one entry at a time rather than holding a value: the adder of a chip list
   * (`StringParam.chips`). A pick or an Enter hands the name over and the field clears, ready for
   * the next, and the list stays open. Nothing is committed while typing, since a half-typed name
   * would become a chip. A name left typed is still added on blur, which is what a text field
   * does with text somebody walked away from.
   */
  adder?: boolean
  onChange: (value: string) => void
}

/**
 * Case-insensitive substring match on every whitespace-separated term, in any order.
 *
 * Deliberately not the palette's `fuzzyRank`, which reorders by score: the lists here arrive in an
 * order that means something (a source's own ordering, which the caller chose), and a filter keeps
 * it.
 *
 * Matches the value only, never a `mark` (`Suggestion`).
 */
export function filterOptions(
  options: readonly SuggestionOption[],
  query: string,
): readonly SuggestionOption[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return options
  return options.filter((option) => {
    const lower = option.value.toLowerCase()
    return terms.every((term) => lower.includes(term))
  })
}

/**
 * Where the list goes, as the style that puts it there: under the input, or above it when there
 * is more room above, and shifted sideways to stay inside the window (`menuShift`).
 */
function placeUnder(input: HTMLElement): Partial<CSSStyleDeclaration> {
  const rect = input.getBoundingClientRect()
  const viewport = layoutViewport()
  const width = Math.max(rect.width, MIN_WIDTH)
  const left =
    rect.left +
    menuShift({ width, rowLeft: rect.left, rowRight: rect.right, viewport: viewport.width })
  const below = viewport.height - rect.bottom - 8
  const above = rect.top - 8
  const up = below < 160 && above > below
  return {
    left: `${left}px`,
    width: `${width}px`,
    maxHeight: `${Math.max(80, Math.min(260, up ? above : below))}px`,
    top: up ? '' : `${rect.bottom + 2}px`,
    bottom: up ? `${viewport.height - rect.top + 2}px` : '',
  }
}

export function ComboField({
  label,
  value,
  options,
  placeholder,
  mono,
  title,
  adder = false,
  onChange,
}: ComboFieldProps) {
  const draft = useDraftText(value, onChange, { debounce: !adder })
  const [open, setOpen] = useState(false)
  /*
   * Whether the list is filtered by the text. Opening clears it, so a field holding a chosen name
   * lists everything rather than only that name; typing sets it.
   */
  const [typed, setTyped] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()

  const showing = open && options.length > 0
  const query = typed ? draft.text : ''
  // Only while open: a card renders far more often than anybody opens its list.
  const matches = useMemo(
    () => (showing ? filterOptions(options.map(suggestionOption), query) : []),
    [showing, options, query],
  )
  const shown = matches.length > MAX_SHOWN ? matches.slice(0, MAX_SHOWN) : matches
  const nav = useListNav(shown.length, `${query}|${showing}`)

  // Placed before paint, then followed each frame while open. See the header on why a ref.
  useLayoutEffect(() => {
    if (!showing) return
    let frame = 0
    const follow = () => {
      const input = inputRef.current
      const list = nav.listRef.current
      if (input && list) Object.assign(list.style, placeUnder(input))
      frame = requestAnimationFrame(follow)
    }
    follow()
    return () => cancelAnimationFrame(frame)
  }, [showing, nav.listRef])

  const openList = () => {
    setTyped(false)
    setOpen(true)
  }

  const pick = (option: string) => {
    if (adder) {
      draft.setText('')
      setTyped(false)
    } else {
      draft.setText(option)
      setOpen(false)
    }
    draft.commit(option)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (showing && nav.onKeyDown(event)) return
    if (event.key === 'ArrowDown' && !showing && options.length > 0) {
      event.preventDefault()
      openList()
      return
    }
    if (event.key === 'Enter') {
      const active = showing ? shown[nav.activeIndex]?.value : undefined
      const typedName = draft.text.trim()
      if (active !== undefined) {
        event.preventDefault()
        pick(active)
      } else if (adder) {
        event.preventDefault()
        if (typedName) pick(typedName)
      } else {
        event.currentTarget.blur()
      }
      return
    }
    if (event.key === 'Escape') {
      // One press closes the list, the next reverts. Neither reaches the surface underneath,
      // because the input claims the key through `data-owns-escape` while it has either to do.
      if (showing) {
        setOpen(false)
        return
      }
      draft.setText(value)
      if (!adder) event.currentTarget.blur()
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        /*
         * `useOverlayEscape` listens on the window's capture phase, ahead of this input, so a
         * `stopPropagation` here cannot keep an Escape from closing the viewer the field sits in.
         * Claimed only while there is a list to close or an edit to revert; a clean, closed field
         * leaves the key to the surface.
         */
        data-owns-escape={showing || draft.text !== value || undefined}
        className={
          adder
            ? 'columns-field__input nodrag'
            : `field nodrag${mono ? ' field--mono' : ''}${options.length > 0 ? ' field--combo' : ''}`
        }
        type="text"
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={showing}
        aria-controls={showing ? listId : undefined}
        aria-activedescendant={
          showing && shown.length > 0 ? `${listId}-${nav.activeIndex}` : undefined
        }
        title={title}
        value={draft.text}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onFocus={() => {
          draft.focus()
          openList()
        }}
        onClick={() => {
          if (!open) openList()
        }}
        onChange={(e) => {
          draft.edit(e.target.value)
          setTyped(true)
          setOpen(true)
        }}
        onBlur={(e) => {
          setOpen(false)
          if (!adder) {
            draft.blur(e.target.value)
            return
          }
          // A name left typed is added; the field clears either way, ready for the next.
          draft.setText('')
          draft.blur(e.target.value.trim() || undefined)
        }}
        onKeyDown={onKeyDown}
      />
      {showing &&
        createPortal(
          <div
            className="combo-list nowheel nodrag"
            id={listId}
            role="listbox"
            aria-label={label}
            ref={nav.listRef}
            // Keep the focus in the input, so a press on a row or the scrollbar is not a blur
            // that closes the list and commits half-typed text before the pick lands.
            onMouseDown={(e) => e.preventDefault()}
          >
            {shown.length === 0 ? (
              <div className="combo-list__empty">No match — the typed name is kept as is</div>
            ) : (
              shown.map(({ value: name, label: text, mark }, i) => (
                <div
                  key={name}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === nav.activeIndex}
                  // The mark is a glyph; the word it stands for is what is heard and hovered.
                  aria-label={mark ? `${text}, ${mark.kind}` : undefined}
                  title={mark ? `${text} (${mark.kind})` : undefined}
                  data-current={name === value || undefined}
                  className="combo-list__option"
                  onMouseEnter={() => nav.setActiveIndex(i)}
                  onClick={() => pick(name)}
                >
                  {mark && (
                    <span className="combo-list__mark" aria-hidden="true">
                      {mark.text}
                    </span>
                  )}
                  {text}
                </div>
              ))
            )}
            {matches.length > shown.length && (
              <div className="combo-list__more">
                {matches.length - shown.length} more — type to narrow
              </div>
            )}
          </div>,
          document.fullscreenElement ?? document.body,
        )}
    </>
  )
}
