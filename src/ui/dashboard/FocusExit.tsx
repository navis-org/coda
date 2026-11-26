/**
 * The way out of focus mode, which has taken away every other control.
 *
 * Shown while the pointer moves and for `FOCUS_EXIT_IDLE_MS` after it stops, then faded — so a
 * wall of results left on a screen is only results, and the first nudge of the mouse finds the
 * exit. Overlaid rather than laid out, for the run bar's reason: `--dash-row` is measured from the
 * grid's content box, and a control that took height would resize every cell each time it came
 * and went.
 *
 * **Faded, not removed.** At rest it is transparent and ignores the pointer, but it stays in the
 * tab order and a keyboard focus brings it back — a fade is the mouse's affordance, and the
 * keyboard needs a way out as much as anybody.
 *
 * **Top centre unless that covers a control.** Where the cells' buttons fall along the top edge
 * depends on the column count, the widths and what each strip draws, so each time the pill wakes
 * it measures the controls and the cells' titles in its band, and `placePill` slides it to the
 * nearest spot that covers neither (or, with no such spot, no control). Faded controls count: they
 * are the ones the pointer is about to reveal.
 *
 * Moving the pointer over an `<iframe>` (a Neuroglancer cell) sends nothing to this document, so
 * the pill does not wake there; moving off the embed does.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { useGraphStore } from '../../store/graphStore'
import { placePill, type Span } from './focusExitPlacement'

/** What the pill must not cover: anything a pointer can act on. */
const CONTROLS =
  'button, a[href], input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"]), .dash-cell__grip, .dash-cell__resize'

/** How long the pill stays after the pointer stops. */
export const FOCUS_EXIT_IDLE_MS = 2000

export function FocusExit() {
  const setDashboardFocus = useGraphStore((s) => s.setDashboardFocus)
  /* Up on entry, so the way out is seen once before it fades. */
  const [awake, setAwake] = useState(true)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pill = useRef<HTMLButtonElement>(null)
  const [left, setLeft] = useState<number | undefined>(undefined)
  // A ref and a state setter only, so one function for the life of the pill. A pointer resting
  // on the pill holds it up through `:hover` in the stylesheet, so it cannot fade under a click.
  const wake = useCallback(() => {
    setAwake(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setAwake(false), FOCUS_EXIT_IDLE_MS)
  }, [])

  useEffect(() => {
    wake()
    // `pointerdown` as well, so a tap on a touch screen — which moves nothing — finds it too.
    window.addEventListener('pointermove', wake, { passive: true })
    window.addEventListener('pointerdown', wake, { passive: true })
    return () => {
      clearTimeout(timer.current)
      window.removeEventListener('pointermove', wake)
      window.removeEventListener('pointerdown', wake)
    }
  }, [wake])

  const place = useCallback(() => {
    const el = pill.current
    const host = el?.closest<HTMLElement>('.dashboard')
    if (!el || !host) return
    const box = host.getBoundingClientRect()
    const own = el.getBoundingClientRect()
    if (box.width === 0) return // no layout (jsdom, or not on screen): keep the CSS centre
    // Only what shares the pill's band along the top edge.
    const inBand = (r: DOMRect): Span | undefined =>
      r.width === 0 || r.bottom <= own.top || r.top >= own.bottom
        ? undefined
        : { left: r.left - box.left, right: r.right - box.left }
    const controls: Span[] = []
    for (const c of host.querySelectorAll<HTMLElement>(CONTROLS)) {
      if (c === el) continue
      const span = inBand(c.getBoundingClientRect())
      if (span) controls.push(span)
    }
    // The name's text, not its box: the title is a column of flex items, so the box runs the
    // length of the strip (and `scrollWidth` is never less than the box). A range over the text
    // is the text, clamped to the box for a name cut short by an ellipsis. jsdom has no
    // `Range.getBoundingClientRect`.
    const titles: Span[] = []
    const range = document.createRange()
    if (typeof range.getBoundingClientRect === 'function') {
      for (const t of host.querySelectorAll('.dash-cell .overlay__title > strong')) {
        range.selectNodeContents(t)
        const span = inBand(t.getBoundingClientRect())
        const text = range.getBoundingClientRect()
        if (span)
          titles.push({ left: span.left, right: Math.min(span.right, text.right - box.left) })
      }
    }
    setLeft(placePill(own.width, { left: 0, right: box.width }, controls, titles))
  }, [])

  // On each wake rather than each move: the layout cannot change under a resting pointer, and a
  // query over every control per `pointermove` would be paid continuously.
  useLayoutEffect(() => {
    if (awake) place()
  }, [awake, place])
  useEffect(() => {
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [place])

  return (
    <button
      ref={pill}
      type="button"
      style={left === undefined ? undefined : { left, transform: 'none' }}
      className="btn dashboard__focusExit"
      data-awake={awake ? 'true' : undefined}
      onClick={() => setDashboardFocus(false)}
      title="Show the toolbar, the panels and the dashboard's controls again"
    >
      Exit focus
    </button>
  )
}
