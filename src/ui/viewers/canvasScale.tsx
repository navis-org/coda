/**
 * How much sharper than CSS pixels a canvas must draw to stay sharp where it is — for a canvas on a
 * card, React Flow's zoom.
 *
 * A card is magnified by the pane's transform, so a backing store sized for CSS pixels × device
 * ratio is stretched the moment somebody zooms in to look, and reads as low resolution. Provided
 * once per card (`CardCanvasScale`, in `CodaNodeView`), read with `useCanvasScale()` and handed to
 * `prepareCanvas`; everywhere else — the full-size surfaces, which nothing transforms — it is 1
 * with no special case. A context rather than each canvas asking React Flow's store, which exists
 * only on a card and throws everywhere else.
 *
 * **Provided around a card's body only, so far.** The viewer previews blur the same way (the
 * heatmap's and the scatter's canvases take no scale), and are deliberately not wired yet: a
 * heatmap's backing store grows up to nine-fold in area under the cap and it redraws at every
 * half-octave step, which wants measuring in a browser before it ships. Wiring one is wrapping
 * `ValuePreview` in `CardCanvasScale` and passing `useCanvasScale()` to its `prepareCanvas`.
 */

import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import { useStore } from '@xyflow/react'

import { deviceRatio } from './canvas2d'

/**
 * The most a canvas is magnified, device ratio included. Memory is the limit: a backing store
 * grows with the square of the ratio, and a card may hold many canvases — the Cortex gallery
 * mounts one per cell, scrolled into view or not, roughly 60 MB at 3 (estimated from the sizes).
 */
const MAX_PIXEL_RATIO = 3

const CanvasScaleContext = createContext(1)

export function useCanvasScale(): number {
  return useContext(CanvasScaleContext)
}

/**
 * Provides the pane's zoom to the canvases on one card, rounded **up** to half-powers of two so a
 * wheel gesture redraws at a few steps rather than on every tick, never below 1 (zooming out needs
 * no fewer pixels), and capped so the ratio with the device's stays under `MAX_PIXEL_RATIO`.
 */
export function CardCanvasScale({ children }: { children: ReactNode }) {
  const step = useStore((s) => {
    const zoom = s.transform[2]
    return zoom <= 1 ? 1 : 2 ** (Math.ceil(Math.log2(zoom) * 2) / 2)
  })
  const scale = Math.max(1, Math.min(step, MAX_PIXEL_RATIO / deviceRatio()))
  return <CanvasScaleContext.Provider value={scale}>{children}</CanvasScaleContext.Provider>
}
