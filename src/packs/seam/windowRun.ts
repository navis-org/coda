/**
 * Scoring a neuron's windows: one graph, run in batches.
 *
 * `affinityRun.ts`' counterpart for the merge-window task, and simpler in the way that matters —
 * the model is **one** graph, so there is nothing to hold between calls and no pair tensor to
 * build. What is left is batching, and the reason it exists is Cancel.
 *
 * ## Why a batch rather than the whole neuron
 *
 * The graph's point axis and its batch axis are both dynamic, so a neuron's 543 windows could go
 * in one call. Two reasons not to. A call is inside ONNX Runtime with no interrupt point a
 * message could reach, so the signal can only be read **between** calls — the same argument
 * `affinityRun.ts` makes about chunks, and a whole-neuron call would make Cancel mean "in a
 * minute". And one call's input would be 543 × 4,096 × 3 floats of points plus as many normals,
 * 53 MB of tensor handed to a GPU in one go.
 *
 * `WINDOW_BATCH` is the Cancel latency: eight windows at ~49 ms each is about 0.4 s.
 *
 * ## The two heads
 *
 * `window_logit` is one number per window — the model's confidence that the window holds a false
 * merge. `point_logits` is one per point: **which side of the bipartition** that point fell on,
 * not a confidence about the merge. They are not the same quantity and a caller that colours by
 * the wrong one gets a picture that looks informative and is not, which is why they are returned
 * under names rather than as a tuple.
 */

import { throwIfAborted } from '../../core/slice'
import { soleGraph } from '../../ml/manifest'
import type { GraphRunner } from '../../ml/session'

/** Windows per call. The Cancel latency, and the size of one tensor. See the header. */
export const WINDOW_BATCH = 8

export interface WindowRunOptions {
  readonly signal?: AbortSignal
  /** 0..1 through this neuron's windows. Called per batch. */
  readonly onProgress?: (fraction: number) => void
}

export interface WindowScores {
  /** One per window: the logit that it holds a false merge. */
  readonly windowLogits: Float32Array
  /** `windows × nPoints`: which side of the bipartition each point fell on. */
  readonly pointLogits: Float32Array
}

/**
 * Score every window of one neuron.
 *
 * `points` and `feats` are `windows × nPoints × 3`, flat, as `runSeamWindows` returns them.
 */
export async function scoreWindows(
  session: GraphRunner,
  points: Float32Array,
  feats: Float32Array,
  windows: number,
  nPoints: number,
  options: WindowRunOptions = {},
): Promise<WindowScores> {
  const { id } = session.loaded.manifest
  const { part, signature } = soleGraph(session.loaded.manifest)
  const [pointsInput, featsInput] = signature.inputs
  const [pointOutput, windowOutput] = signature.outputs
  if (!pointsInput || !featsInput || !pointOutput || !windowOutput) {
    throw new Error(`${id} does not take two inputs and return two outputs`)
  }
  const stride = nPoints * 3
  if (points.length !== windows * stride || feats.length !== windows * stride) {
    throw new Error(
      `${windows} windows of ${nPoints} points need ${windows * stride} values, not ` +
        `${points.length} points and ${feats.length} features`,
    )
  }

  const windowLogits = new Float32Array(windows)
  const pointLogits = new Float32Array(windows * nPoints)
  for (let from = 0; from < windows; from += WINDOW_BATCH) {
    throwIfAborted(options.signal)
    const count = Math.min(WINDOW_BATCH, windows - from)
    const at = from * stride
    const span = count * stride
    const answer = await session.run({
      part,
      feeds: [
        // `slice`, not `subarray`: what crosses the worker boundary is **transferred**, so a view
        // would detach the whole neuron's buffer on the first batch and leave every later one
        // reading an empty array.
        {
          name: pointsInput,
          type: 'float32',
          dims: [count, nPoints, 3],
          data: points.slice(at, at + span).buffer,
        },
        {
          name: featsInput,
          type: 'float32',
          dims: [count, nPoints, 3],
          data: feats.slice(at, at + span).buffer,
        },
      ],
    })
    const byName = new Map(answer.map((tensor) => [tensor.name, tensor]))
    const perWindow = byName.get(windowOutput)
    const perPoint = byName.get(pointOutput)
    if (!perWindow || !perPoint) throw new Error(`${id} returned neither head by name`)
    const scores = new Float32Array(perWindow.data)
    const sides = new Float32Array(perPoint.data)
    if (scores.length !== count || sides.length !== count * nPoints) {
      throw new Error(
        `${id} answered ${scores.length} windows and ${sides.length} point logits for a batch ` +
          `of ${count} × ${nPoints}`,
      )
    }
    windowLogits.set(scores, from)
    pointLogits.set(sides, from * nPoints)
    options.onProgress?.((from + count) / windows)
  }
  return { windowLogits, pointLogits }
}
