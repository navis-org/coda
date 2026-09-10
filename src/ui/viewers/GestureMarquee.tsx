/**
 * The dashed box a drag leaves behind while it is being dragged.
 *
 * Two viewers draw a selection rectangle — `ScatterViewer` under ⌘/Ctrl and `HeatmapViewer`
 * under Shift — and the corner arithmetic is the same both times: a drag records where it
 * started and where the pointer is, either of which may be the smaller. Written out per caller
 * it is four `Math.min`/`Math.abs` expressions each, which is exactly the shape that comes to
 * differ by a pixel between two charts on one canvas.
 *
 * **An overlay rather than part of the repaint**, which is the reason both callers keep it out
 * of their canvas: a gesture that redrew fifty thousand marks — or re-folded a four-million-cell
 * matrix — per pointer move is not a gesture. `.chart-gesture` is the shared rule; the lasso
 * trail beside it on the scatter is the same class and is not shared, being one `<polygon>` with
 * no arithmetic in it.
 */

interface GestureMarqueeProps {
  /** The press, in box coordinates. */
  x0: number
  y0: number
  /** Where the pointer is now. */
  x1: number
  y1: number
  /** The overlay's own size — the plot box, not the rectangle. */
  width: number
  height: number
}

export function GestureMarquee({ x0, y0, x1, y1, width, height }: GestureMarqueeProps) {
  return (
    <svg className="chart-gesture" width={width} height={height}>
      <rect
        x={Math.min(x0, x1)}
        y={Math.min(y0, y1)}
        width={Math.abs(x1 - x0)}
        height={Math.abs(y1 - y0)}
      />
    </svg>
  )
}
