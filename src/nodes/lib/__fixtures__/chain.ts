/**
 * The one straight skeleton both Distance between suites measure against.
 *
 * A fixture module rather than a builder in each file, which is `cube.ts`' arrangement next door.
 * The reason here is weaker than that one's — nothing about a straight chain is subtle — but the
 * two copies were byte-identical, and a fixture whose two spellings can drift is how the numbers
 * worked out by hand in one suite stop describing the geometry the other one builds.
 *
 * Straight, evenly spaced and axis-aligned on purpose: every distance, cable length and weighted
 * statistic over it can be worked out by hand, which is what `geometryDistance.test.ts` asserts.
 */

import type { SkeletonGeometry } from '../../../core/values'

/** A chain along x at `y`, `nodes` nodes spaced `step` nanometres apart. */
export function chain(id: string, nodes: number, step: number, y = 0): SkeletonGeometry {
  const positions = new Float32Array(nodes * 3)
  const parents = new Int32Array(nodes)
  for (let i = 0; i < nodes; i++) {
    positions[i * 3] = i * step
    positions[i * 3 + 1] = y
    parents[i] = i - 1
  }
  return { id, positions, radii: new Float32Array(nodes), parents }
}
