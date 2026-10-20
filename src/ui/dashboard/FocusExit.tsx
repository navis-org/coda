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
 * Moving the pointer over an `<iframe>` (a Neuroglancer cell) sends nothing to this document, so
 * the pill does not wake there; moving off the embed does.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { useGraphStore } from '../../store/graphStore'

/** How long the pill stays after the pointer stops. */
export const FOCUS_EXIT_IDLE_MS = 2000

export function FocusExit() {
  const setDashboardFocus = useGraphStore((s) => s.setDashboardFocus)
  /* Up on entry, so the way out is seen once before it fades. */
  const [awake, setAwake] = useState(true)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
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

  return (
    <button
      type="button"
      className="btn dashboard__focusExit"
      data-awake={awake ? 'true' : undefined}
      onClick={() => setDashboardFocus(false)}
      title="Show the toolbar, the panels and the dashboard's controls again"
    >
      Exit focus
    </button>
  )
}
