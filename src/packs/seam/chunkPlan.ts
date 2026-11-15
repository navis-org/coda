/**
 * Which chunks each open end will want, worked out before the first one is fetched.
 *
 * ## Why a search can see its own future
 *
 * Every tip's position is in the table before anything is read, and the two boxes an end reads
 * are both functions of that position: the search box is `halfWidthNm` around the tip, and the
 * patch box is drawn around contacts that the own-tip rule keeps within `ownNm` of it. So the
 * whole sequence of chunk reads is knowable up front — which is unusual enough to be worth
 * saying plainly, because it is what lets the cache stop guessing. `ChunkCache` without a plan
 * is least-recently-used, which is a guess about the future; with one it is Bélády's, which is
 * the best any policy can do. Measured over one 505-end neuron at a 512 MB budget, a tip read
 * 13.7 MB under LRU and 9.3 MB under this.
 *
 * ## The patch box is bounded, not predicted
 *
 * An end's real patch box is drawn around the contacts its search *found*, which is not known
 * until the search has run. This uses the widest box those contacts can produce — `ownNm` plus
 * the patch's own reach — so the plan names every chunk the end could ask for and some it will
 * not. That is the safe direction: a chunk wrongly thought to be wanted is kept a little too
 * long, where one wrongly thought to be finished with would be evicted and fetched again.
 *
 * ## Per neuron, not per run
 *
 * A run can be hundreds of neurons and a quarter of a million ends, and an index over all of
 * them would be millions of entries held for the whole run to answer about chunks two neurons
 * never share. A neuron's ends are what overlap — that is the premise `SearchVolume.roots` is
 * built on — so the plan is rebuilt per neuron, where it is hundreds of entries.
 */

import type { NextUse } from '../../data/precomputed/chunkCache'
import type { ChunkRef, Triple, VolumeScale, VoxelBox } from '../../data/precomputed/volume'
import {
  boxAround,
  boxAroundAll,
  chunkKeyOf,
  chunksCovering,
} from '../../data/precomputed/volume'

/** What one end will read, as the cache names it. */
export interface ChunkPlan {
  /**
   * Where the walk is. The run moves this on as each end finishes, and everything the plan says
   * is relative to it.
   */
  advance(): void
  /** When this chunk is next wanted, counting in ends; `Infinity` for never again. */
  /**
   * **`chunkCache`'s own `NextUse`, not a second declaration of it.** The plan exists to be the
   * cache's eviction policy, so the two must agree on the signature *and* on what the argument
   * is — a key, which on a sharded scale is a Morton code and not a URL. Restated here, the two
   * would type-check whichever copy was stale, which is the failure `EndReach` is derived to
   * avoid one file over.
   */
  readonly nextUse: NextUse
  /**
   * How many distinct chunks the plan covers. **For tests.**
   *
   * Not for a run's report: `reportOnReads` speaks about the *cache*'s `asked` and `hits`, and
   * nothing in a run holds a `ChunkPlan` — the volume keeps it private behind `planEnds`.
   */
  readonly chunks: number
}

export interface ChunkPlanBoxes {
  readonly base: string
  /** The scale the search box is read at. */
  readonly scale: VolumeScale
  readonly halfWidthNm: number
  /**
   * The scale a patch box is read at, where one is read at all — the same volume, not always
   * the same scale.
   *
   * **Absent means no assessor**, and then the plan is the search boxes alone: a geometry-only
   * run reads no patch box, so naming its chunks would hold bytes nothing is going to ask for
   * and evict bytes something is. It is absent together with `patchReachNm` because neither
   * means anything without the other.
   */
  readonly patchScale?: VolumeScale
  /** The own-tip rule's reach plus a patch's own, which bounds the patch box. */
  readonly patchReachNm?: number
}

/**
 * The plan for one neuron's ends, **in the order the run will search them**.
 *
 * The order is the argument rather than something this file decides, because it is the run's:
 * the ends arrive in the table's order, which a `Sort` above the node may have made score order.
 * A plan built in a different order from the walk would answer about the wrong future, which is
 * the one way this can be quietly useless rather than loudly wrong.
 */
export function chunkPlanFor(tipsNm: readonly Triple[], boxes: ChunkPlanBoxes): ChunkPlan {
  /*
   * Ascending positions per chunk, which is what makes `nextUse` a look at the front rather than
   * a search. Built once: a tip touches a couple of dozen chunks and a neuron a few hundred, so
   * this is thousands of entries against the gigabytes it is spent to avoid.
   */
  const when = new Map<string, number[]>()
  for (let at = 0; at < tipsNm.length; at++) {
    const tip = tipsNm[at]!
    for (const key of keysFor(tip, boxes)) {
      const seen = when.get(key)
      if (seen) {
        // One entry per end, not per box: the two boxes of one end are one position.
        if (seen[seen.length - 1] !== at) seen.push(at)
      } else when.set(key, [at])
    }
  }

  let at = 0
  return {
    advance() {
      at += 1
    },
    nextUse(key) {
      const seen = when.get(key)
      if (!seen) return Infinity
      /*
       * Positions already passed are dropped here rather than when the walk advances, which
       * would be a pass over every chunk per end. Idempotent for a given `at`, so asking twice
       * about one chunk in one eviction costs nothing the second time.
       */
      while (seen.length > 0 && seen[0]! < at) seen.shift()
      return seen[0] ?? Infinity
    },
    get chunks() {
      return when.size
    },
  }
}

/** Both boxes this end can read, as cache keys. */
function keysFor(tip: Triple, boxes: ChunkPlanBoxes): string[] {
  const search = boxAround(boxes.scale, tip, boxes.halfWidthNm)
  const keys = keysOf(boxes.base, boxes.scale, search)
  if (!boxes.patchScale || boxes.patchReachNm === undefined) return keys
  // The widest patch box this end's contacts can produce — see the header.
  const patch = boxAroundAll(boxes.patchScale, [tip], boxes.patchReachNm)
  return [...keys, ...keysOf(boxes.base, boxes.patchScale, patch)]
}

function keysOf(base: string, scale: VolumeScale, box: VoxelBox): string[] {
  return chunksCovering(scale, box).map((chunk: ChunkRef) => chunkKeyOf(base, scale, chunk))
}
