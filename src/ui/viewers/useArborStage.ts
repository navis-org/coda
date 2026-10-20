/**
 * The stage an arbour editor draws its dendrogram on: the box it measures, the fitted transform,
 * the pieces a click is picked against, wheel zoom and drag pan, and the canvas the scene is
 * painted onto.
 *
 * Shared by Split Axon/Dendrite's editor and Skeleton to Points' hand placement; the Neuron
 * Dendrogram keeps its own copy, its stage being entangled with its distal selection and
 * refinement. What an editor draws (`buildScene`'s input) and what a click does stay the editor's.
 */

import type { RefObject } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { ArborShape } from '../../nodes/lib/arborLayout'
import type { ArborView, PieceGeometry, PlotTransform } from './arborPlot'
import { fitTransform, panBy, pieceGeometry, zoomAbout } from './arborPlot'
import type { Scene } from './arborScene'
import { paintScene } from './arborScene'
import { prepareCanvas } from './canvas2d'
import { useElementSize } from './useElementSize'
import { usePanGesture } from './usePanGesture'
import { useWheelZoom } from './useWheelZoom'

export interface ArborStage {
  /** On the element the dendrogram fills, with `handlers` spread onto it. */
  readonly stageRef: RefObject<HTMLDivElement | null>
  readonly canvasRef: RefObject<HTMLCanvasElement | null>
  /** Undefined while unmeasured or with no shape yet. */
  readonly transform: PlotTransform | undefined
  readonly pieces: PieceGeometry | undefined
  /** Whether the reader has zoomed or panned off the fitted view. */
  readonly zoomed: boolean
  /** Back to the fitted view: a double-click's. */
  readonly resetView: () => void
  readonly panning: boolean
  readonly handlers: ReturnType<typeof usePanGesture>['handlers']
}

/**
 * The stage for `shape`. The view returns to fitted whenever `resetKey` changes — another neuron
 * starts fitted, an edit to this one keeps the view.
 */
export function useArborStage(shape: ArborShape | undefined, resetKey: unknown): ArborStage {
  const [stageRef, size] = useElementSize<HTMLDivElement>()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [view, setView] = useState<ArborView | undefined>()
  useEffect(() => setView(undefined), [resetKey])

  const transform = useMemo(
    () =>
      shape && size.width > 0 && size.height > 0
        ? fitTransform(shape, size.width, size.height, view)
        : undefined,
    [shape, size.width, size.height, view],
  )
  const pieces = useMemo(
    () => (shape && transform ? pieceGeometry(shape, transform) : undefined),
    [shape, transform],
  )
  useWheelZoom(stageRef, transform !== undefined, (factor, x, y) => {
    if (!transform) return
    const next = zoomAbout(transform, factor, x, y)
    setView(next.zoom <= 1 ? undefined : next)
  })
  const { panning, handlers } = usePanGesture(view !== undefined, (dx, dy) => {
    if (transform) setView(panBy(transform, dx, dy))
  })

  return {
    stageRef,
    canvasRef,
    transform,
    pieces,
    zoomed: view !== undefined,
    resetView: () => setView(undefined),
    panning,
    handlers,
  }
}

/** Paint `scene` onto the stage's canvas whenever it changes. */
export function usePaintedScene(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  scene: Scene | undefined,
): void {
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !scene) return
    const ctx = prepareCanvas(canvas, scene.width, scene.height)
    if (ctx) paintScene(ctx, scene)
  }, [canvasRef, scene])
}
