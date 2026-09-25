/**
 * Lets a trackpad pinch over a scrolling card zoom the canvas, while two-finger scrolling still
 * scrolls the card.
 *
 * A pinch is a `wheel` event with `ctrlKey` set, and React Flow drops every wheel inside a
 * `nowheel` element, pinch included (and prevents the browser's page zoom there). React Flow reads
 * the class at dispatch time, so it is lifted for the one event and put back in a task after the
 * dispatch; React Flow then zooms with its own sensitivity, limits and focal point.
 *
 * One listener, on `.react-flow__viewport`: on the way up it runs after every card's own listeners
 * and before React Flow's on the renderer above. A viewer that zooms itself (`useWheelZoom`, the 3D
 * view's OrbitControls, sigma) has already called `preventDefault`, and that is the whole opt-out.
 */

import { useEffect } from 'react'
import type { RefObject } from 'react'

export function usePinchToCanvas(wrapper: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const viewport = wrapper.current?.querySelector('.react-flow__viewport')
    if (!viewport) return
    let lifted: Element[] = []
    const putBack = () => {
      for (const node of lifted) node.classList.add('nowheel')
      lifted = []
    }
    const onWheel = (event: Event) => {
      if (!(event as WheelEvent).ctrlKey || event.defaultPrevented) return
      for (let node = event.target as Element | null; node; node = node.parentElement) {
        if (node === viewport) break
        if (node.classList.contains('nowheel')) {
          node.classList.remove('nowheel')
          lifted.push(node)
        }
      }
      setTimeout(putBack)
    }
    viewport.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      viewport.removeEventListener('wheel', onWheel)
      putBack()
    }
  }, [wrapper])
}
