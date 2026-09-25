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
/** The device's pixel ratio, 1 where there is none to read (a test, a worker). */
export function deviceRatio(): number {
  return typeof devicePixelRatio === 'number' ? devicePixelRatio : 1
}

export function prepareCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  /**
   * Further magnification the canvas is drawn at, beyond the device's: a card on a zoomed canvas
   * is scaled by React Flow's transform, and a backing store sized for CSS pixels alone is then
   * stretched and blurred. 1 everywhere nothing transforms the canvas.
   */
  scale = 1,
): CanvasRenderingContext2D | null {
  const ratio = deviceRatio() * scale
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
  // Not cleared here: a resize resets the store, but a redraw at the same size keeps the last frame
  // — so a caller whose drawing does not cover every pixel clears it itself. Not every caller
  // needs to: the heatmap paints an opaque background over the whole box instead, a clear being a
  // second full pass it measured and chose not to pay (`drawHeatmap`).
  return context
}

/**
 * A canvas `font` in the app's own UI face. A canvas font string does not resolve CSS variables,
 * so `var(--font-ui)` in one silently falls back to the browser default; the family has to be
 * read off the document — once, `--font-ui` not changing with the theme, rather than a style
 * recalculation per label.
 */
export function canvasFont(px: number): string {
  return `${px}px ${uiFontFamily()}`
}

/**
 * The app's UI font family, read once — `canvasFont`'s, and an SVG export's, which is detached from
 * the document and so resolves no CSS variable either.
 */
export function uiFontFamily(): string {
  uiFamily ??=
    (typeof document === 'undefined'
      ? ''
      : getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim()) ||
    'system-ui, sans-serif'
  return uiFamily
}

let uiFamily: string | undefined
