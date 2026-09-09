/**
 * Right-click menu for one neuron in the Explore list.
 *
 * Wears `NodeContextMenu`'s clothes — `.context-menu` and its rows — for the reason
 * `NetworkContextMenu` states: a right-click should not look like a different kind of thing
 * depending on which surface it landed on. `useDismissOnOutside` is the same dismissal, and
 * `ViewerOverlay`'s capture-phase Escape already stands aside for anything matching
 * `.context-menu`, so Escape closes the menu rather than the whole overlay with no work here.
 *
 * Deliberately dumb, like the network's: it is handed labels and counts and reports which row was
 * pressed. What each command *does* — which ids, which rows, what goes on the clipboard — is
 * `ExploreBody`'s, where the index and the selection already live.
 *
 * **Copy is two rows rather than one, and that is a decision against the network menu's rule.**
 * There, a right-click inside the selection acts on the whole selection and one outside it acts
 * on the mark alone. That rule is right for a canvas, where the selection is visible as an
 * outline under the pointer. Here the selection is a column of ticks that may be scrolled off
 * screen entirely, so the same gesture would silently copy one id or four hundred depending on
 * something the reader cannot see. Both rows, always, and the count is in the label.
 */

import { useRef } from 'react'

import { useDismissOnOutside } from '../useDismiss'

/** Rough menu box, for keeping it on screen. Mirrors `.context-menu`'s min-width. */
const MENU_WIDTH = 220
const MENU_HEIGHT = 210

export interface RowContextMenuProps {
  /** Where the pointer was, in client coordinates. */
  at: { x: number; y: number }
  /** What was right-clicked, said in words — the row's label and id. */
  caption: string
  /** The row's own type, or null where it has none. Drives the three type-shaped rows. */
  type: string | null
  /** How many neurons are ticked, for the second copy row's label and its disabled state. */
  selected: number
  /** How many hits share this row's type — the count `Select all` would add. */
  sharing: number
  onCopyId: () => void
  onCopySelected: () => void
  onCopyType: () => void
  onSelectSharing: () => void
  onSearchType: () => void
  onClose: () => void
}

export function RowContextMenu({
  at,
  caption,
  type,
  selected,
  sharing,
  onCopyId,
  onCopySelected,
  onCopyType,
  onSelectSharing,
  onSearchType,
  onClose,
}: RowContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  useDismissOnOutside(ref, onClose, { onEscape: true })

  const act = (fn: () => void) => () => {
    fn()
    onClose()
  }

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{
        /*
         * `documentElement.clientWidth`, never `window.innerWidth`. On a phone `innerWidth` is
         * the visual viewport at minimum scale, so a panel hanging off the right widens the
         * document, the browser zooms out, and the number grows to include the overflow being
         * measured — `ui-shell.md` records that costing a menu 8px of correction instead of 60.
         * The four older context menus still clamp the other way; this is not the diff to fix
         * them in.
         */
        left: Math.min(at.x, document.documentElement.clientWidth - MENU_WIDTH),
        top: Math.min(at.y, document.documentElement.clientHeight - MENU_HEIGHT),
      }}
      role="menu"
    >
      <div className="context-menu__caption">{caption}</div>

      <button
        type="button"
        className="context-menu__item"
        title="Put this neuron's id on the clipboard"
        onClick={act(onCopyId)}
      >
        Copy ID
      </button>
      {/*
       * Always drawn, disabled when nothing is ticked — rather than hidden, so the menu does not
       * change height between two right-clicks and so the row says the selection exists at all.
       * The count is the whole point of it being separate from Copy ID.
       */}
      <button
        type="button"
        className="context-menu__item"
        title={
          selected > 0
            ? 'Put every ticked neuron’s id on the clipboard, one per line'
            : 'Nothing is ticked yet'
        }
        disabled={selected === 0}
        onClick={act(onCopySelected)}
      >
        Copy selected <kbd>{selected.toLocaleString()}</kbd>
      </button>
      <button
        type="button"
        className="context-menu__item"
        title={type ? `Put “${type}” on the clipboard` : 'This neuron has no type'}
        disabled={!type}
        onClick={act(onCopyType)}
      >
        Copy type
      </button>

      <div className="context-menu__sep" />

      {/*
       * Every *hit* sharing the type, not every row on the page — the page is where you happened
       * to stop scrolling, and a command that means one thing per page is a command nobody can
       * predict. Counted so the number is visible before it is committed to, since a selection
       * travels in every downstream cache key.
       */}
      <button
        type="button"
        className="context-menu__item"
        title={
          type
            ? `Tick every matching neuron of type “${type}”, across all pages`
            : 'This neuron has no type to match on'
        }
        disabled={!type || sharing === 0}
        onClick={act(onSelectSharing)}
      >
        Select all of this type <kbd>{sharing.toLocaleString()}</kbd>
      </button>
      <button
        type="button"
        className="context-menu__item"
        title={
          type ? `Search for “${type}”, replacing the current query` : 'This neuron has no type'
        }
        disabled={!type}
        onClick={act(onSearchType)}
      >
        Search for this type
      </button>
    </div>
  )
}
