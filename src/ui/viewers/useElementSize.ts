import { useEffect, useRef, useState } from 'react'

export interface Size {
  width: number
  height: number
}

/**
 * Observe an element's content box. Charts need real pixel dimensions to lay out axes,
 * and they render at two very different sizes here (inline node preview vs the
 * inspector panel), so nothing can be hard-coded.
 */
export function useElementSize<T extends HTMLElement>(): [React.RefObject<T | null>, Size] {
  const ref = useRef<T>(null)
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const box = entry.contentRect
      // Round to whole pixels: sub-pixel churn would re-render on every zoom tick.
      const width = Math.round(box.width)
      const height = Math.round(box.height)
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return [ref, size]
}
