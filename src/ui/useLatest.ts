/**
 * The latest value, readable from a listener that is bound once.
 *
 * For a callback a long-lived listener calls. Listed as an effect dependency instead, a caller's
 * inline arrow re-binds the listener on every render — which for `useOverlayEscape` also moves
 * the surface to the top of its stack. Written from an effect rather than during render, so a
 * render React throws away cannot leave its callback behind.
 */

import { useEffect, useRef } from 'react'

export function useLatest<T>(value: T) {
  const ref = useRef(value)
  useEffect(() => {
    ref.current = value
  })
  return ref
}
