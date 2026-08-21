/**
 * Sizing a canvas for the screen it is on, and handing back a context in CSS pixels.
 *
 * Extracted at the second consumer (`ScatterViewer`, `HeatmapViewer`), which is this codebase's
 * standing trigger — and the trap it closes is a real one: get `setTransform` wrong and the
 * chart is correct on the author's screen and half-size on a retina one, which is exactly the
 * class of bug nothing in jsdom can see.
 *
 * **The backing store is only re-sized when it actually changes.** Assigning `canvas.width`
 * resets the drawing surface even when the value is identical, so a repaint triggered by a theme
 * flip or a new palette — where the geometry has not moved — was reallocating the whole buffer:
 * 2800 x 1400 x 4 bytes ≈ 15.7 MB on a retina 1400x700 plot, to draw the same box again.
 */
export function prepareCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): CanvasRenderingContext2D | null {
  const ratio = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1
  const deviceWidth = Math.max(1, Math.round(width * ratio))
  const deviceHeight = Math.max(1, Math.round(height * ratio))
  if (canvas.width !== deviceWidth) canvas.width = deviceWidth
  if (canvas.height !== deviceHeight) canvas.height = deviceHeight
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`

  const context = canvas.getContext('2d')
  if (!context) return null
  // Every draw pass downstream is written in CSS pixels; this is the only place the ratio
  // appears, which is what keeps the two viewers agreeing about what a coordinate means.
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  return context
}
