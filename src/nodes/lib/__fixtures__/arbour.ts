import type { SkeletonGeometry } from '../../../core/values'
import { rng } from './rng'

/** How `arbour` grows a tree. */
export interface ArbourOptions {
  /** Where the root sits: 0 puts it at the origin. */
  readonly spread?: number
  /** Chance per node of branching back to an earlier node rather than continuing the current one. */
  readonly jump?: number
  /** Largest step per axis between a node and its parent, in nanometres. */
  readonly step?: number
  /** Every node's radius; 0 leaves the skeleton without radii. */
  readonly radius?: number
}

/**
 * A seeded random branching skeleton — a thin tree in a big box, which is what a neuron is, and
 * the hard case for anything that indexes space: a k-d tree over uniform noise is the easy one.
 *
 * Shared by `probe-distance.ts` and the arbour layout tests, which had written it twice.
 */
export function arbour(nodes: number, seed = 1, options: ArbourOptions = {}): SkeletonGeometry {
  const { spread = 0, jump = 0.02, step = 600, radius = 0 } = options
  const next = rng(seed)
  const positions = new Float32Array(nodes * 3)
  const parents = new Int32Array(nodes)
  parents[0] = -1
  for (let a = 0; a < 3; a++) positions[a] = next() * spread
  for (let i = 1; i < nodes; i++) {
    // Mostly continue the current branch; occasionally jump back to an earlier node.
    const parent = next() < jump ? Math.floor(next() * i) : i - 1
    parents[i] = parent
    for (let a = 0; a < 3; a++) {
      positions[i * 3 + a] = positions[parent * 3 + a]! + (next() - 0.5) * step
    }
  }
  return { id: 'n', positions, radii: new Float32Array(nodes).fill(radius), parents }
}
