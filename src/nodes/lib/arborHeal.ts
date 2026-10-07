/**
 * A skeleton that arrived in pieces, joined into one tree — for the Neuron Dendrogram, which can
 * only lay out one.
 *
 * Apart from `arborOps.ts` because this calls Python: `arborOps` is pure and reachable from the
 * daylight worker, and a value import of `src/pyodide` there would put the Pyodide engine in that
 * worker's graph (`topologyOps.ts`' rule; `src/test/importGraph.test.ts` holds it).
 *
 * The join is navis-fastcore's `heal_skeleton` through the Clean Skeletons capability, every other
 * step off and no distance cap. The card and the node's Run both come through here, and the answer
 * is memoised per skeleton object — the session geometry cache hands both the same object — so
 * "beyond the clicked point" means the same tree on both and a Run after the card has drawn the
 * neuron does not heal it again.
 */

import type { SkeletonGeometry, SkeletonsValue } from '../../core/values'
import { memoPromise, untilAborted } from '../../data/memoPromise'
import { runCleanSkeletons } from '../../pyodide/skeletons'
import { healedBridges, skeletonRoots } from './arborOps'
import { HEAL_ONLY, cleanRequestFrom } from './cleanOps'

/** A skeleton joined into one tree, and what the join added. */
export interface Healed {
  readonly skeleton: SkeletonGeometry
  /** Per node, whether its edge to its parent was added by the heal. Absent when nothing was. */
  readonly bridges?: Uint8Array
  /** How many pieces were joined; 1 for a skeleton that was whole. */
  readonly pieces: number
}

const memory = new WeakMap<SkeletonGeometry, Healed>()

/**
 * The answer where it needs no Python: a whole skeleton as it is, or one healed before. The
 * runtime is ~10 MB, so a card asking this first never downloads it for a neuron with nothing to
 * heal. `pieces` is the count of fragments otherwise, for a caller saying what it is waiting on.
 */
export function healedNow(skeleton: SkeletonGeometry): Healed | { pieces: number } {
  const hit = memory.get(skeleton)
  if (hit) return hit
  const pieces = skeletonRoots(skeleton.parents).length
  if (pieces > 1) return { pieces }
  const whole = { skeleton, pieces }
  memory.set(skeleton, whole)
  return whole
}

/** Heals under way, shared by everybody asking while one runs; the answer goes to `memory`. */
const inflight = new Map<SkeletonGeometry, Promise<Healed>>()

/**
 * `skeleton` (an item of `value`) joined into one tree where it arrived in pieces. A heal already
 * under way for it — the card's, when Run arrives first — is joined rather than started again, and
 * `signal` stops only this caller waiting, never a heal somebody else is still waiting on.
 */
export function healSkeleton(
  value: SkeletonsValue,
  skeleton: SkeletonGeometry,
  signal?: AbortSignal,
): Promise<Healed> {
  const now = healedNow(skeleton)
  if ('skeleton' in now) return Promise.resolve(now)
  const shared = memoPromise(
    inflight,
    skeleton,
    async () => {
      const result = await runCleanSkeletons(
        cleanRequestFrom({ ...value, items: [skeleton] }, HEAL_ONLY),
      )
      // Healing renumbers nothing, so the coordinates and radii are the ones already held — which
      // is checked rather than trusted, a renumbered tree being a wrong arbour with no error.
      if (result.parents.length !== skeleton.parents.length) {
        throw new Error('Joining the skeleton’s fragments changed its node count.')
      }
      const healed: Healed = {
        skeleton: { ...skeleton, parents: result.parents },
        bridges: healedBridges(skeleton.parents, result.parents),
        pieces: now.pieces,
      }
      memory.set(skeleton, healed)
      return healed
    },
    { keep: 'inflight' },
  )
  return untilAborted(shared, signal)
}
