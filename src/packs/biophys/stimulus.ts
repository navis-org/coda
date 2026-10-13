/**
 * Spike trains for Simulate's partners: NEURON's `NetStim`, seeded.
 *
 * `NetStim`'s vocabulary — start, number, interval, noise — because one knob spans regular to
 * Poisson: at `noise = 0` the spikes fall at `start`, `start + interval`, …; at `noise = 1` every
 * interval is exponential with that mean; in between, each interval is `(1 − noise)·interval +
 * noise·interval·E` for a unit exponential `E`. The first spike follows `NetStim.mod`'s `init`:
 * `start + noise·interval·E`, so it is exactly `start` when there is no noise.
 *
 * **Seeded per partner, by id.** Each partner's stream is `seededRandom` of a hash of the seed and
 * its id, so a partner's train is the same whichever other partners fire and in whatever order the
 * model lists them — ticking a second partner must not move the first one's spikes. And seeded at
 * all, which navis's `NetStim` is not: a seed in the params is what makes a noisy run reproducible
 * and invariant 4 hold without a nonce.
 */

import { fnv1a32 } from '../../core/hash'
import { seededRandom } from '../../nodes/lib/tableOps'

export interface TrainShape {
  /** ms */
  readonly start: number
  readonly number: number
  /** Mean interval, ms. */
  readonly interval: number
  /** 0 = regular, 1 = Poisson; clamped to that range, as `NetStim` clamps it. */
  readonly noise: number
}

/**
 * One partner's spike times, ms, ascending — stopping at `until`, the run's end, so a long train
 * is never generated past it. The spikes before it are the same whatever `until` is: the stream
 * is drawn in order and only cut.
 */
export function partnerTrain(
  shape: TrainShape,
  seed: number,
  partnerId: string,
  until = Infinity,
): number[] {
  const noise = Math.min(1, Math.max(0, shape.noise))
  const count = Math.max(0, Math.floor(shape.number))
  // A stream per partner that does not depend on its index.
  const random = seededRandom(fnv1a32(`${seed}:${partnerId}`))
  // Noise times a unit exponential; 1 − U keeps the logarithm off zero.
  const jitter = () => (noise > 0 ? -noise * shape.interval * Math.log(1 - random()) : 0)
  const times: number[] = []
  let t = shape.start + jitter()
  for (let i = 0; i < count && t < until; i++) {
    times.push(t)
    t += (1 - noise) * shape.interval + jitter()
  }
  return times
}
