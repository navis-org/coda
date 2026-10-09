/**
 * The Neuron Dendrogram's layout: drawn at once, refined off the main thread where that pays.
 *
 * Three of the four layouts take a few milliseconds and are simply memoised. The fourth, equal-
 * angle, is exact and crossing-free on its own but bunches branches together until its daylight
 * passes have run, and those are quadratic — a third of a second on a large neuron. So the card
 * draws plain equal-angle immediately and swaps in the daylight answer from the worker when it
 * lands; a newer request aborts the older one, so paging fast never shows a stale arbour.
 */

import { useEffect, useMemo, useState } from 'react'

import { daylightLayout } from '../../nodes/lib/arborDaylight'
import type {
  ArborLayoutKind,
  ArborOrder,
  ArborShape,
  SubwayOptions,
} from '../../nodes/lib/arborLayout'
import { arborLayout, equalAngleLayout } from '../../nodes/lib/arborLayout'
import type { KeyTree } from '../../nodes/lib/arborOps'

export interface ArborLayoutOptions {
  readonly order: ArborOrder
  readonly subway: SubwayOptions
  readonly daylight: number
}

export function useArborLayout(
  kind: ArborLayoutKind,
  tree: KeyTree | undefined,
  distance: Float64Array | undefined,
  options: ArborLayoutOptions,
): { shape: ArborShape | undefined; refining: boolean } {
  const { order, subway, daylight } = options
  const { angleChange, angleDecrease, switchShare } = subway

  const immediate = useMemo(() => {
    if (!tree || !distance) return undefined
    if (kind === 'equalAngle') return equalAngleLayout(tree, distance, 0)
    return arborLayout(kind, tree, distance, {
      order,
      subway: { angleChange, angleDecrease, switchShare },
    })
  }, [kind, tree, distance, order, angleChange, angleDecrease, switchShare])

  const [refined, setRefined] = useState<{ from: ArborShape; shape: ArborShape } | undefined>()

  useEffect(() => {
    if (kind !== 'equalAngle' || !tree || !distance || !immediate || daylight <= 0) return
    const controller = new AbortController()
    daylightLayout(tree, distance, daylight, { signal: controller.signal })
      .then((shape) => {
        if (!controller.signal.aborted) setRefined({ from: immediate, shape })
      })
      // An aborted job rejects; a failed one leaves the exact, unrefined drawing on screen.
      .catch(() => undefined)
    return () => controller.abort()
  }, [kind, tree, distance, daylight, immediate])

  // Only an answer for the drawing on screen counts: a refinement of the previous neuron does not.
  const current = refined && refined.from === immediate ? refined.shape : undefined
  return {
    shape: current ?? immediate,
    refining: kind === 'equalAngle' && daylight > 0 && immediate !== undefined && !current,
  }
}
