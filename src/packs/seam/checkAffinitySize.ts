/**
 * What a run will cost, said before it is paid.
 *
 * Two rails, on the two tiers `limits.md` allows, and the split between them is the whole content
 * of this file: **time warns, an allocation refuses.** Neither number is minted here — the wait
 * comes out of `docs/ml.md`'s measurements and the refusal out of `CRASH_FLOOR_BYTES`, so there is
 * no `MAX_POINTS` for somebody to raise.
 *
 * **The wait is priced over the set.** `MESH_WARN_SECONDS`' recorded lesson is that a cost warning
 * measured on one item is measured on the wrong thing: ten seconds a neuron is unremarkable and
 * forty neurons of it is seven minutes. So the estimate multiplies, and the sentence names the
 * control that shrinks it.
 */

import { refuseIfOverCrashFloor, warnOverWait } from '../../core/limits'
import type { Warner } from '../../core/limits'
import { plural } from '../../style/format'

/**
 * Decode throughput, measured: ~90,000 pairs per second on an Apple M-series GPU with the `mixed`
 * variant. `docs/ml.md` has the table and how it was taken.
 *
 * One GPU, so it is an order of magnitude rather than a promise — which is all a five-minute
 * threshold needs it to be. A slower machine warns later than it should, never earlier.
 */
export const PAIRS_PER_SECOND = 90_000

/** The encoder, paid once per neuron: ~0.5 s measured, against ~12 s of decode at N = 1024. */
export const ENCODE_SECONDS = 0.5

/** Roughly how long `neurons` neurons at `points` points each will take, in seconds. */
export function affinitySeconds(points: number, neurons: number): number {
  return neurons * (ENCODE_SECONDS + (points * points) / PAIRS_PER_SECOND)
}

/**
 * What one neuron's affinities allocate: the matrix, and the clustering's working copy of it.
 *
 * **Two**, not one — `clusterAffinities` builds its own `distance` array rather than writing over
 * the caller's, so a refusal computed from one would be half the real peak.
 */
export function affinityBytes(points: number): number {
  return 2 * 4 * points * points
}

/**
 * Warn about the wait, refuse an impossible allocation.
 *
 * Called at the **top** of `evaluate`, before the model is opened: `EvalContext.warn`'s own rule
 * is that a warning raised after the wait tells somebody about something they have already had.
 */
export function checkAffinitySize(ctx: Warner, points: number, neurons: number): void {
  // Per neuron, because that is what is held at once: the matrices are built and dropped one
  // neuron at a time, so a set of forty does not allocate forty of them.
  refuseIfOverCrashFloor(
    `Predicting affinities between ${points.toLocaleString()} points`,
    affinityBytes(points),
    'Lower `Points`.',
  )
  warnOverWait(ctx, {
    seconds: affinitySeconds(points, neurons),
    what:
      `Predicting affinities for ${plural(neurons, 'neuron')} at ` +
      `${points.toLocaleString()} points each`,
    lever: 'Lower `Points` — the work grows with its square — or send fewer neurons.',
  })
}
