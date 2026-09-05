/**
 * The style that gives a card back its pointer when React Flow has taken it away.
 *
 * **`NodeWrapper` sets `pointer-events: none` on any node that is neither selectable nor
 * draggable and carries no mouse handlers of its own** (`hasPointerEvents`). That is a sensible
 * default for decoration and a trap for every surface here that draws a card which is not meant
 * to be *moved*: the card is then inert as well, and both failures read as something else
 * entirely — a drag falls through to the pane and pans the canvas, which looks exactly like a
 * drag that worked, and a click or a keystroke goes to the canvas's own shortcuts (typing into a
 * peeked card opened the dashboard, because `d` reached the window).
 *
 * `node.style` is spread *after* that line in the wrapper, so this is the seam that puts it back.
 * Two consumers so far — the box a folded group draws, whose gestures are its own, and the cards
 * inside the peek, which are read-only in position and live in every other way. Written once
 * because the second one was found the hard way after the first was already documented.
 */
export const CARD_POINTERS = { pointerEvents: 'all' } as const
