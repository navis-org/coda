/**
 * The skeleton a tip is a leaf of — SEAM's stage 1, as `scripts/pilots/tip_skeletons.py` runs it.
 *
 * Three steps, and not one of them is a tidy-up: each decides what counts as an open end, and
 * `p_tip`, the cutoff and `r` were all fitted with them in place.
 *
 * 1. **Skeletonize**, `mesh2skeleton(shave=True)` — which since navis 27a93c477 is the bristle
 *    pass and then the radius-based twig one, Coda's `twigs`.
 * 2. **Heal**, `LEAFS` with a 1 µm cap. A wavefront skeleton of a segmentation comes back as many
 *    disconnected pieces, and `SkeletonsValue` cannot say so — a forest and a tree are the same
 *    parent array with more `-1`s in it. Every fragment otherwise contributes *two* ends that are
 *    nothing but where the reconstruction was cut; measured at 4,418 of them on a neuron SEAM
 *    finds 548 ends on. The cap is the load-bearing half: a long heal invents topology, and two
 *    of the thirteen misses in SEAM's own review were a 3–4 µm healing edge sitting exactly where
 *    the tip should have been.
 * 3. **Prune** twigs under 1 µm, non-recursively, which is what `tips_of` prunes before taking
 *    leaves. A wavefront skeleton sprouts single-node spurs along the backbone and every one of
 *    them is a false open end.
 *
 * **Every request goes through the shared builder for its call** — `skeletonizeRequestFrom`,
 * `cleanRequestFrom`, `simplifyRequestFrom` — rather than being written out here. That is not
 * only about duplication: those builders own the micrometre-to-nanometre convention, so a hand
 * written request means two conventions in one pack and a `shaveCutoff: 1000` that reads as
 * 1000 µm to anyone who knows the card. `HEAL_ONLY`'s own comment states the rule this follows —
 * a step added to Clean Skeletons should be a field this has to state, not a default it silently
 * inherits.
 */

import type { MeshesValue, SkeletonsValue } from '../../core/values'
import type { SkeletonCleanParams } from '../../nodes/lib/cleanOps'
import { HEAL_ONLY, cleanRequestFrom, skeletonsFromResult } from '../../nodes/lib/cleanOps'
import type { SkeletonSimplifyParams } from '../../nodes/lib/simplifyOps'
import { simplifyRequestFrom, skeletonsFromKeep } from '../../nodes/lib/simplifyOps'
import type { SkeletonizeParams } from '../../nodes/lib/skeletonizeOps'
import { skeletonizeRequestFrom, skeletonsFromMeshes } from '../../nodes/lib/skeletonizeOps'
import { runCleanSkeletons, runSimplifySkeletons } from '../../pyodide/skeletons'
import { runSkeletonize } from '../../pyodide/skeletonize'
import type { TipRule } from './tips'

/**
 * SEAM's wavefront settings, in the units the card asks for.
 *
 * `shave: 'twigs'` is the whole of what `mesh2skeleton(shave=True)` means today. The soma
 * controls are all off: SEAM masks tips near the soma afterwards rather than reshaping the
 * skeleton around it, and a collapse would move the nodes a tip is measured from.
 */
export const SEAM_SKELETONIZE: SkeletonizeParams = {
  waves: 1,
  stepSize: 1,
  radiusAgg: 'mean',
  minFragment: 0,
  shave: 'twigs',
  shaveCutoff: 1,
  fixZeroRadii: true,
  somaCleanup: false,
  somaRadius: 0,
  detectSoma: false,
  minSomaRadius: 0,
}

/** `HEAL_ONLY` with SEAM's two choices stated: end-to-end bridges, and a cap on their length. */
export function seamHeal(healUm: number): SkeletonCleanParams {
  return { ...HEAL_ONLY, healMethod: 'LEAFS', healMaxDist: healUm }
}

/** `tips_of`'s prune: one pass, so a long chain of short twigs is not eaten to the backbone. */
export function seamPrune(pruneUm: number): SkeletonSimplifyParams {
  return { prune: pruneUm, repeat: false, method: 'none', factor: 1, tolerance: 0, area: 0 }
}

/**
 * The skeletons whose leaves are these meshes' tips: the wired ones where given, else made here,
 * and in **either case** healed and pruned.
 *
 * Doing both to a skeleton the reader wired is deliberate, and is why the two are settings on the
 * card rather than something left to Clean Skeletons: SEAM's `p_tip` was fitted on tips taken
 * after a 1 µm non-recursive prune of a healed skeleton, so a node that skipped either on a wired
 * skeleton would answer a different question with the same numbers. The heal matters most — a
 * wired wavefront skeleton is fragmented in exactly the same way as one made here. Setting both
 * to 0 is how to say "the skeleton I gave you is the one I mean".
 */
export async function tipSkeletons(
  meshes: MeshesValue,
  given: SkeletonsValue | undefined,
  rule: Pick<TipRule, 'healUm' | 'pruneUm'>,
  signal?: AbortSignal,
): Promise<SkeletonsValue> {
  let skeletons = given
  if (!skeletons) {
    const made = await runSkeletonize(skeletonizeRequestFrom(meshes, SEAM_SKELETONIZE), {
      signal,
    })
    skeletons = skeletonsFromMeshes(meshes, made)
  }
  if (rule.healUm > 0 && skeletons.items.some((item) => item.parents.length > 0)) {
    const healed = await runCleanSkeletons(cleanRequestFrom(skeletons, seamHeal(rule.healUm)), {
      signal,
    })
    skeletons = skeletonsFromResult(skeletons, healed)
  }
  if (rule.pruneUm > 0 && skeletons.items.some((item) => item.parents.length > 0)) {
    const pruned = await runSimplifySkeletons(
      simplifyRequestFrom(skeletons, seamPrune(rule.pruneUm)),
      { signal },
    )
    skeletons = skeletonsFromKeep(skeletons, pruned)
  }
  return skeletons
}
