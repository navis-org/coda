import { useEffect, useRef, useState } from 'react'

export interface Size {
  width: number
  height: number
}

/**
 * Observe an element's content box. Charts need real pixel dimensions to lay out axes,
 * and they render at two very different sizes here (inline node preview vs the
 * inspector panel), so nothing can be hard-coded.
 *
 * **Whichever element is under the ref is observed, whenever it mounts** — checked after every
 * commit, one comparison. Observing once on mount measured only an element present at the first
 * commit, and every chart returns its empty state *before* drawing the element that carries the
 * ref: a Sankey mounted before its columns were picked, a profile whose first result had no
 * depths, stayed a blank box once there was something to draw, until something remounted it.
 * That was patched in two callers before it was fixed here.
 */
export function useElementSize<T extends HTMLElement>(): [React.RefObject<T | null>, Size] {
  const ref = useRef<T>(null)
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })
  const observed = useRef<{ element: T; observer: ResizeObserver } | null>(null)

  // No dependency list, on purpose: the element can appear, change or go on any commit.
  useEffect(() => {
    const element = ref.current
    if (observed.current?.element === element) return
    observed.current?.observer.disconnect()
    observed.current = null
    if (!element) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const box = entry.contentRect
      // Round to whole pixels: sub-pixel churn would re-render on every zoom tick.
      const width = Math.round(box.width)
      const height = Math.round(box.height)
      setSize((prev) =>
        prev.width === width && prev.height === height ? prev : { width, height },
      )
    })
    observer.observe(element)
    observed.current = { element, observer }
  })
  useEffect(
    () => () => {
      observed.current?.observer.disconnect()
      observed.current = null
    },
    [],
  )

  return [ref, size]
}
