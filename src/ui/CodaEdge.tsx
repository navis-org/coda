/**
 * The wire. One component for all three routings, chosen per edge from `data.route`.
 *
 * Coda drew React Flow's stock bezier until this existed, which is why there was no `edgeTypes`
 * entry at all. Registering one costs nothing that was being relied on: `EdgeWrapper` renders
 * this *and* `EdgeUpdateAnchors` as siblings inside a `<g>` that carries the click, the
 * right-click and the focus handlers — so the drag-off rewire, `reconnectRadius`, the edge menu,
 * selection and the Delete key all still belong to React Flow and are untouched by anything here.
 * What the component owns is the `d` attribute and nothing else.
 *
 * `BaseEdge` draws a second, invisible, fat copy of that same path as the hit target, so the
 * right-click target follows a detour rather than staying on the straight line the wire no
 * longer takes.
 */

import { memo } from 'react'
import { BaseEdge, getBezierPath, getSmoothStepPath, type EdgeProps } from '@xyflow/react'

import type { XY } from '../layout/place'
import { CORNER_RADIUS, roundedPath, routeWaypoints } from './edgeRoute'

/**
 * What the canvas attaches to an edge for this component to read.
 *
 * `route` is present only on a wire ELK actually bent, only under `orthogonal`, and only while
 * the arrangement it was computed for is still on screen — `useArrange` drops the whole set the
 * moment `routeKey` stops matching. So an absent route is the **ordinary** case rather than a
 * failure: most wires are never bent, and a canvas nobody has arranged has no routes at all.
 * Every branch below has to read well without one, which is the property that made a mode keyed
 * solely to routes untenable. See `EdgeRouting`.
 */
export interface CodaEdgeData extends Record<string, unknown> {
  route?: readonly XY[]
  /** Whether the canvas is in `orthogonal`. Per-canvas, where `route` is per-wire. */
  step?: boolean
}

function CodaEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  markerStart,
  interactionWidth,
  data,
}: EdgeProps) {
  const held = data as CodaEdgeData | undefined
  const route = held?.route

  if (route && route.length > 0) {
    const points = routeWaypoints({ x: sourceX, y: sourceY }, route, { x: targetX, y: targetY })
    return (
      <BaseEdge
        id={id}
        path={roundedPath(points)}
        style={style}
        markerEnd={markerEnd}
        markerStart={markerStart}
        interactionWidth={interactionWidth}
        /*
         * Says the wire followed ELK's waypoints rather than a computed step. Nothing styles it;
         * it exists so a test can ask, and it exists because the alternatives are all unreliable.
         * Corner count is not a discriminator — measured, `getSmoothStepPath` produces between 0
         * and 4 of them depending only on where the sockets landed, so a plain step path
         * routinely scores higher than a routed one. What is left is telling the two path
         * *strings* apart by their punctuation, which is a real difference and an accident of
         * two generators' formatting, so it would keep a genuine regression green the day either
         * one changed a space. A flag the component sets deliberately cannot drift like that.
         */
        data-routed=""
      />
    )
  }

  /*
   * No route. Under `orthogonal` that still has to be a step, or the mode would draw most of the
   * canvas curved — only 10 of 32 edges across the bundled examples carry bend points at all, so
   * "ELK gave me nothing" is the common case and cannot be the one that falls back to the other
   * style. It is also what lets the mode work on a graph nobody has arranged.
   *
   * `getSmoothStepPath` rather than a fourth path builder of our own: it already solves leaving
   * a socket on the correct side and turning by `borderRadius`, and a second implementation is
   * how the two shapes on screen would come to disagree about a corner.
   */
  const [path] = held?.step
    ? getSmoothStepPath({
        sourceX,
        sourceY,
        targetX,
        targetY,
        sourcePosition,
        targetPosition,
        borderRadius: CORNER_RADIUS,
      })
    : getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })

  return (
    <BaseEdge
      id={id}
      path={path}
      style={style}
      markerEnd={markerEnd}
      markerStart={markerStart}
      interactionWidth={interactionWidth}
    />
  )
}

/**
 * Memoised, because React Flow re-renders every edge on any store tick and the path arithmetic
 * is per-waypoint. The default shallow compare is enough: `data` is rebuilt in `Editor`'s
 * `rfEdges` memo only when the graph, the inference or the route set actually changes.
 */
export const CodaEdge = memo(CodaEdgeComponent)
