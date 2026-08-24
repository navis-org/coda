/**
 * What the canvas lock says, in one place.
 *
 * The lock is refused at a dozen surfaces — the rail, the toolbar, both context menus, the
 * palette, the keyboard and two pane gestures — and the sentence each one shows *is* the whole
 * user-visible explanation of the feature. Written out at each site it drifted immediately:
 * three wordings inside one change, one of them naming the button and its neighbour not.
 *
 * Three forms, because the surfaces differ in what they can carry:
 *
 *   `LOCKED_NOTICE`  the status bar — the only one with room to say where the way out is
 *   `LOCKED_HINT`    a tooltip or palette hint on a row that names itself already
 *   `lockedTitle()`  a tooltip on a button whose own name has to lead
 *
 * In `src/ui` rather than the store: `src/store` is not headless the way `core` and `data` are,
 * but copy shown to a user is the UI's business, and the store's one refusal string is addressed
 * to a model rather than to a reader (see `applyAssistantPlan`).
 */

/** For the status bar: a refused key or gesture has nowhere else to explain itself. */
export const LOCKED_NOTICE =
  'The canvas is locked — use the lock button in the bottom-left rail'

/** For a row or button whose label already says what it would have done. */
export const LOCKED_HINT = 'The canvas is locked'

/** For a button whose own name has to come first: `Zoom in — the canvas is locked`. */
export function lockedTitle(label: string): string {
  return `${label} — the canvas is locked`
}
