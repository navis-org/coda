/**
 * A wheel that zooms a chart, without the four things that go wrong.
 *
 * The third viewer wanted this and the second had already drifted from the first, which is the
 * point at which `paramPairs.ts` says to stop copying — its "second consumer rule", recorded
 * there against `uniqueName`, `rowKey` and `routeMemory`, "all of which record copies that had
 * already drifted before anyone noticed".
 *
 * Four rules, each of which the obvious version gets wrong:
 *
 * - **A native, non-passive listener.** React routes `onWheel` through a passive root listener,
 *   so `preventDefault` there is ignored and whatever the chart sits in scrolls behind it.
 *   There is no way to opt a React handler out; the listener has to be attached by hand.
 * - **Coalesced to one step per animation frame.** A trackpad delivers wheel events faster than
 *   frames, and each one is a re-render of a whole chart. The factors *multiply* while the frame
 *   is pending and the last pointer position wins — which is exactly what one larger step about
 *   the same point would have been, rather than an approximation of it.
 * - **One sensitivity constant.** `Math.exp(deltaY * 0.0015)` lived in three files; two charts
 *   zooming at visibly different speeds off the same wheel is the kind of difference nobody
 *   reports and everybody feels.
 * - **The callback is read through a ref.** The zoom step needs the *current* window, which is a
 *   fresh object every render, so a caller passing it in a dependency array tears the listener
 *   down and puts it back on every render — and the cleanup cancels any queued frame with it,
 *   discarding an accumulated gesture mid-scroll. Held in a ref, the listener is attached once
 *   per element and still sees this render's closure.
 *
 * Coordinates are handed over **relative to the element's own box**; a caller that draws inside
 * a padded or gutter-offset plot subtracts its own origin.
 */

import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

/** How fast a wheel zooms. One constant, because two charts must not differ. */
const WHEEL_SENSITIVITY = 0.0015

export function useWheelZoom(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
  /** `factor` above 1 zooms out; `x`/`y` are pixels from the element's top-left. */
  onZoom: (factor: number, x: number, y: number) => void,
): void {
  const latest = useRef(onZoom)
  latest.current = onZoom

  useEffect(() => {
    const element = ref.current
    if (!element || !enabled) return
    let pending: { factor: number; x: number; y: number; frame: number } | undefined
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      const factor = Math.exp(event.deltaY * WHEEL_SENSITIVITY)
      const x = event.clientX - rect.left
      const y = event.clientY - rect.top
      if (pending) {
        pending.factor *= factor
        pending.x = x
        pending.y = y
        return
      }
      pending = {
        factor,
        x,
        y,
        frame: requestAnimationFrame(() => {
          const step = pending!
          pending = undefined
          latest.current(step.factor, step.x, step.y)
        }),
      }
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      element.removeEventListener('wheel', onWheel)
      if (pending) cancelAnimationFrame(pending.frame)
    }
  }, [ref, enabled])
}
