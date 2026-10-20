/**
 * The VFB Line Gallery's large view: one image at full resolution, zoomable, as a projection or as
 * slices through its stack.
 *
 * **The projection is VFB's own "thumbnail"**, which turned out to be no thumbnail at all: for a
 * JRC2018U brain image it is a 1212×566 PNG, the stack's full width and height, a colour-depth
 * maximum projection over the template. So the default view costs one image request and no
 * decoding.
 *
 * **Without the template it is the stack's own maximum projection.** VFB publishes no projection
 * without the template — `thumbnailT.png` is not one: only its background is transparent
 * (2026-10-14). The stack holds the signal channel alone, so its projection is exact; it is grey,
 * like a slice.
 *
 * **Some templates' stacks are stored a quarter turn from VFB's pictures**
 * (`VfbTemplate.turnedClockwise`, the nerve cord's), so what is drawn from the stack is turned to
 * match the tile it was opened from.
 *
 * **One stack load at a time, held only while it is needed** (`data/vfb/stacks.ts` has its sizes):
 * for Slices, or until the projection is made from it. The projection stays for as long as the
 * image is open, so the template toggle redraws at once. Going back to Slices after the stack was
 * let go loads it again, which VFB's file server lets the browser cache for a year
 * (`max-age=31536000`), so that costs the inflate rather than a download.
 *
 * Zoom is the wheel about the pointer and pan a drag once zoomed — `useWheelZoom` and
 * `usePanGesture`, the heatmap's and dendrogram's gestures — with a double click to fit again.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import type { ImageStack } from '../../data/nrrd'
import { maxProjection, planePixels, slicePlane, turnedPlanePixels } from '../../data/nrrd'
import { fetchImageStack } from '../../data/vfb/stacks'
import type { GalleryView } from '../../packs/vfb/ops'
import { usePanGesture } from '../viewers/usePanGesture'
import { useSettledFetch } from '../viewers/useSettledFetch'
import { useWheelZoom } from '../viewers/useWheelZoom'

const MAX_ZOOM = 16
const FIT = { scale: 1, x: 0, y: 0 }

/** Grey values, `width × height`, to draw. */
interface Plane {
  readonly width: number
  readonly height: number
  readonly values: Uint8Array
}

const planeOf = (stack: ImageStack, values: Uint8Array): Plane => ({
  width: stack.width,
  height: stack.height,
  values,
})

export function ImageStage({
  thumbnail,
  nrrd,
  alt,
  mode,
  withTemplate,
  turned,
}: {
  thumbnail: string | undefined
  nrrd: string | undefined
  alt: string
  mode: GalleryView
  withTemplate: boolean
  /** Turn what is drawn from the stack a quarter clockwise, as VFB draws this template's images. */
  turned: boolean
}) {
  const frame = useRef<HTMLDivElement>(null)
  const [view, setView] = useState(FIT)
  const zoomed = view.scale > 1
  const fromImage = mode === 'projection' && withTemplate
  const projecting = mode === 'projection' && !withTemplate
  // Made once from the stack and then kept for as long as the image is open, so ticking the
  // template back and unticking it again redraws without a second download.
  const [projection, setProjection] = useState<Plane | undefined>(undefined)
  // One load serves both uses — never two downloads of one stack at once — and it is held only
  // while something still needs it: Slices, or a projection not yet made.
  const wanted = mode === 'slices' || (projecting && !projection) ? nrrd : undefined
  // No cache, so the download is cancelled when it stops being wanted (`useSettledFetch`).
  const loaded = useSettledFetch(wanted, (signal) => fetchImageStack(wanted!, signal))
  const stack = loaded.status === 'ready' ? loaded.data : undefined
  useEffect(() => {
    if (projecting && stack && !projection) setProjection(planeOf(stack, maxProjection(stack)))
  }, [projecting, stack, projection])
  // Unset until the slider moves, so a stack opens at its middle slice with no effect to put it there.
  const [chosenZ, setZ] = useState<number | undefined>(undefined)
  const z = stack ? (chosenZ ?? Math.floor(stack.depth / 2)) : 0
  // Memoised so a zoom or pan render hands the canvas the same values, and it does not redraw.
  const slice = useMemo(
    () => (mode === 'slices' && stack ? planeOf(stack, slicePlane(stack, z)) : undefined),
    [mode, stack, z],
  )
  const plane = projecting ? projection : slice

  useWheelZoom(frame, true, (factor, px, py) =>
    setView((v) => {
      const scale = Math.min(MAX_ZOOM, Math.max(1, v.scale / factor))
      if (scale === 1) return FIT
      // Keep the point under the pointer where it is.
      const k = scale / v.scale
      return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k }
    }),
  )
  const pan = usePanGesture(zoomed, (dx, dy) =>
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy })),
  )

  const content = (() => {
    const muted = (text: string) => <span className="image-tile__muted">{text}</span>
    if (fromImage) {
      if (!thumbnail) return muted('no projection for this image')
      return <img src={thumbnail} alt={alt} draggable={false} />
    }
    if (!nrrd) return muted('no image stack for this image')
    if (plane) return <PlaneCanvas plane={plane} turned={turned} />
    if (loaded.status === 'error') return muted(loaded.message)
    return muted('Loading the image stack…')
  })()

  return (
    <div className="vfb-stage">
      <div
        ref={frame}
        className="vfb-stage__frame nodrag nowheel"
        data-zoomed={zoomed || undefined}
        data-panning={pan.panning || undefined}
        onDoubleClick={() => setView(FIT)}
        {...pan.handlers}
      >
        <div
          className="vfb-stage__zoom"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        >
          {content}
        </div>
        {zoomed && (
          <span className="vfb-stage__hint">
            {view.scale.toFixed(1)}× · double-click to fit
          </span>
        )}
      </div>
      {stack && mode === 'slices' && (
        <label className="vfb-stage__slider nodrag">
          <span>
            z {z + 1} / {stack.depth}
          </span>
          <input
            type="range"
            min={0}
            max={stack.depth - 1}
            value={z}
            onChange={(e) => setZ(Number(e.target.value))}
          />
        </label>
      )}
    </div>
  )
}

/**
 * A plane drawn grey, turned a quarter clockwise when asked, into one `ImageData` per size that
 * each new plane fills in place. Turned here rather than with CSS, so `contain` fits the picture as
 * it is drawn.
 */
function PlaneCanvas({ plane, turned }: { plane: Plane; turned: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const width = turned ? plane.height : plane.width
  const height = turned ? plane.width : plane.height
  const image = useMemo(
    () => new ImageData(new Uint8ClampedArray(width * height * 4), width, height),
    [width, height],
  )
  useEffect(() => {
    if (turned) turnedPlanePixels(plane.values, plane.width, plane.height, image.data)
    else planePixels(plane.values, image.data)
    canvas.current?.getContext('2d')?.putImageData(image, 0, 0)
  }, [plane, turned, image])
  return <canvas ref={canvas} width={width} height={height} className="vfb-stage__slice" />
}
