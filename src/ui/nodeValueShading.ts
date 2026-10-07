/**
 * The 3D View's skeleton channel under `nodeValue`: each node coloured by one of its computed
 * per-node numbers (`SkeletonGeometry.nodeValues`) — synapse flow, today.
 *
 * Colour comes from `valueRamp`, the function `by value` uses, so a palette, a typed end and a log
 * mean the same thing whether they are applied to a column of neurons or to the nodes along one.
 * The extent is taken over every node of every skeleton carrying the value, so two neurons in one
 * scene share one scale — which is why flow is stored as a fraction of each neuron's own peak.
 */

import type { SkeletonsValue } from '../core/values'
import { NODE_VALUES } from '../core/values'
import type { ColorSpec } from '../nodes/lib/encodingParams'
import type { Mode } from '../style/colors'
import type { ResolvedColor } from '../style/encoding'
import { MUTED, valueRamp } from '../style/encoding'

/**
 * Colour every skeleton node by the per-node value `spec.nodeValue` names.
 *
 * A node without one — every node of a skeleton that does not carry it, and any non-finite entry —
 * falls back to `at`, the grey `by value` gives a missing cell. No `labelAt`, the key being a ramp.
 */
export function nodeValueShading(
  skeletons: SkeletonsValue | undefined,
  spec: ColorSpec,
  mode: Mode,
): ResolvedColor {
  const name = spec.nodeValue
  const values = (skeletons?.items ?? []).map((item) =>
    name ? item.nodeValues?.[name] : undefined,
  )

  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const array of values) {
    if (!array) continue
    for (const v of array) {
      if (!Number.isFinite(v)) continue
      if (v < min) min = v
      if (v > max) max = v
    }
  }

  // The key says what the picker said, not the stored name.
  const title = NODE_VALUES.find((v) => v.value === name)?.label ?? name ?? ''
  const ramp = valueRamp({ min, max }, spec.scale, mode, title)
  if (!ramp) return { at: () => MUTED, legend: undefined }
  return {
    at: () => MUTED,
    legend: ramp.legend,
    nodeAt: (itemIndex, nodeIndex) => {
      const v = values[itemIndex]?.[nodeIndex]
      return v !== undefined && Number.isFinite(v) ? ramp.colorOf(v) : undefined
    },
  }
}
