/**
 * A skeleton as the point cloud the affinity model was trained on.
 *
 * **This is not `nodes/lib/skeletonPoints.ts`, and the difference is the whole point.** That
 * module samples for *analysis*: equal spacing so that counting rows means something and a
 * `cable` column that sums exactly. This one reproduces whatever the model's training sampler
 * produced, because the model's answers are only meaningful on its own input distribution. The
 * two are different jobs and only this one is checked against the checkpoint.
 *
 * The sampler, from upstream's `NeuronDataset.__getitem__`:
 *
 *   1. take the skeleton's nodes, in micrometres
 *   2. draw `points` node indices **uniformly with replacement**, and sort them
 *   3. centre the cloud on its centroid
 *   4. divide by `globalScale`
 *
 * Steps 3 and 4 are `affinity_reference.py`'s `prepare_cloud`, and `pnpm probe:affinity-parity`
 * checks this against it point for point. The jitter, random translate and rotation in that file
 * are **training augmentations** and must not appear here: applying them would rotate the
 * reader's neuron before predicting on it.
 *
 * Sampling *with replacement* is not a mistake to tidy up. A 1,024-point draw from an 800-node
 * skeleton contains duplicates, and that is what the checkpoint saw.
 */

import { geometryUnitsProblem, NM_PER_UM } from '../../data/units'
import { seededRandom } from '../../nodes/lib/tableOps'

/**
 * The seed every reader's answer is drawn from.
 *
 * Fixed rather than a param: a fixed seed is deterministic and so satisfies invariant 4, and a
 * param would offer a knob whose only effect is to reshuffle an answer nobody asked to reshuffle.
 * **Changing this number is a breaking edit** — every cached provenance key stays valid while the
 * output underneath it changes. `probe-affinity-parity` uses it too, so the parity check tests
 * the configuration the product actually runs.
 */
export const DEFAULT_SEED = 1

/**
 * The fewest skeleton nodes worth asking the model about.
 *
 * Not a sampling constraint — the draw is *with replacement*, so 1,024 points come out of three
 * nodes perfectly well. It is a judgement that an answer about a stub means nothing: the model
 * reasons about a neuron's global shape, and a dozen nodes do not have one.
 */
export const MIN_SKELETON_NODES = 50

export interface CloudOptions {
  /**
   * The manifest's `preprocessing.globalScale`, in µm, by its own name.
   *
   * The one field of that block this function reads. Taking the block whole carried `jitter` and
   * `translate` — training augmentations that must never be applied — into a signature that then
   * had to document them as ignored, and put `samplesPerNeuron` beside `points` meaning the same
   * thing. The caller resolves that; here there is one number for one job.
   */
  readonly globalScale: number
  /** How many points to draw. */
  readonly points: number
  readonly seed: number
}

export interface PointCloud {
  /** xyz interleaved, centred and scaled — exactly what the encoder is fed. */
  readonly positions: Float32Array
  /** Which skeleton node each drawn point came from, so a result can be put back. */
  readonly sourceIndex: Int32Array
}

/**
 * Why this neuron is skipped, or undefined.
 *
 * **A third verdict, and the node needs it by construction**: a run holds several neurons, and
 * one unusable skeleton must not refuse the others. `limits.md`'s tiers are warn (it is going
 * ahead and costing something) and refuse (it cannot be allocated); this is neither. The node
 * collects skipped neurons and says so once, naming the count and the reason — the shape
 * `MeshDetail`'s tolerated per-item failures already use.
 */
export function skipReason(
  skeleton: { positions: Float32Array },
  units: { units?: string },
  sourceNode: string,
): string | undefined {
  // The shared sentence, so this says what every other node says about units and names the same
  // remedy -- a bespoke one-liner here would drop the half that tells a reader what to do.
  const wrongUnits = geometryUnitsProblem(
    'These',
    units,
    'coordinates',
    sourceNode,
    'there is nothing to scale them into the micrometres the model was trained on.',
  )
  if (wrongUnits) return wrongUnits
  const nodes = skeleton.positions.length / 3
  if (nodes < MIN_SKELETON_NODES) {
    return (
      `this skeleton has ${nodes} nodes; below ${MIN_SKELETON_NODES} there is not enough shape ` +
      `for the model to reason about, whatever it answers`
    )
  }
  return undefined
}

/**
 * Draw one skeleton's cloud.
 *
 * Positions arrive in nanometres and leave scaled into roughly [-1, 1]; the `globalScale` is in
 * µm, which is why the conversion happens here rather than being folded into it — the manifest's
 * number has to stay the number upstream wrote.
 */
export function pointCloud(
  skeleton: { positions: Float32Array },
  options: CloudOptions,
): PointCloud {
  const { points, seed } = options
  const nodes = skeleton.positions.length / 3
  const random = seededRandom(seed)
  const sourceIndex = new Int32Array(points)
  for (let i = 0; i < points; i++) sourceIndex[i] = Math.floor(random() * nodes)
  // Sorted, as upstream sorts: it changes nothing about which points are drawn, and keeping it
  // means a cloud built here and one built there are comparable row for row.
  sourceIndex.sort()

  // One pass for the centroid, a second to centre and scale. The source positions are read twice
  // through `sourceIndex` rather than gathered into a buffer in between: the gather bought one
  // array and cost a concept.
  let cx = 0
  let cy = 0
  let cz = 0
  for (let i = 0; i < points; i++) {
    const at = sourceIndex[i]! * 3
    cx += skeleton.positions[at]!
    cy += skeleton.positions[at + 1]!
    cz += skeleton.positions[at + 2]!
  }
  cx /= points
  cy /= points
  cz /= points

  // Centre in nm, then convert to µm and divide by the model's scale, in one step.
  const divisor = NM_PER_UM * options.globalScale
  const positions = new Float32Array(points * 3)
  for (let i = 0; i < points; i++) {
    const at = sourceIndex[i]! * 3
    positions[i * 3] = (skeleton.positions[at]! - cx) / divisor
    positions[i * 3 + 1] = (skeleton.positions[at + 1]! - cy) / divisor
    positions[i * 3 + 2] = (skeleton.positions[at + 2]! - cz) / divisor
  }
  return { positions, sourceIndex }
}
