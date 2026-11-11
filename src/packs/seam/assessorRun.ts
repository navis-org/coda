/**
 * Score one tip's candidates: patches in, a logit each out.
 *
 * The second half of stage 6. `assessorPatches.ts` cuts the 129³ windows in Pyodide; this feeds
 * them to the checkpoint on the GPU and puts the answers back in the caller's own candidate
 * order — including the candidates that never got a patch, which is the part worth reading
 * twice.
 *
 * ## A candidate with no patch is scored, not dropped
 *
 * Two of them cannot be cut: one whose root has no voxel in the box (`AssessorBox.absent`) and
 * one whose window would reach past the box's edge (`AssessorPatches.outside`). Both take the
 * checkpoint's own `missingPatchScore` — its lowest on the calibration list — which is SEAM's
 * rule and not a convention invented here.
 *
 * **Dropping them instead would be the silent failure.** The logits go on to a softmax within
 * the tip's list (`p_cand`), so a missing row changes every other row's share; and a candidate
 * that is absent from the answer is not "ranked last", it is a merge nobody was offered. The
 * count comes back so a card can say so.
 *
 * ## One patch per run, and why that is not a batching oversight
 *
 * The matmul export pins its batch axis to 1 — flattening `(N,C,X,Y,Z)` to `(C, voxels)` is
 * only the same tensor at N=1 — so the loop runs the graph once per candidate. It costs
 * nothing: batch size does not change throughput on this backend (measured,
 * `docs/seam-assessor-speed.md`), and at 133 ms a patch the per-call overhead is noise.
 *
 * What the group size does control is the Pyodide crossing and the Cancel latency, which is why
 * patches are asked for in groups rather than one at a time or all at once.
 */

import { throwIfAborted } from '../../core/slice'
import { soleGraph } from '../../ml/manifest'
import type { GraphRunner } from '../../ml/session'
import type { AssessorPatches, OpenAssessorBox } from '../../pyodide/assessorPatches'
import type { AssessorConfig } from './assessorModel'

/**
 * How many patches to ask Pyodide for at a time.
 *
 * **Not a Cancel bound.** The signal is looked at between every patch, so a Cancel waits one
 * inference — about 133 ms — whatever this is; and the cut is off the critical path, because
 * the next group is asked for before this one is scored. What the number actually trades is
 * crossings against bytes held in JavaScript: 25 crossings for a hundred-candidate tip, against
 * 8.4 MB of patches live, doubled while a prefetch is outstanding.
 */
export const PATCH_GROUP = 4

export interface AssessorRunOptions {
  readonly signal?: AbortSignal
  /** 0..1 through this tip's candidates. Called per group. */
  readonly onProgress?: (fraction: number) => void
}

export interface AssessorScores {
  /**
   * One logit per candidate, in the order the candidates were given to `openAssessorBox`.
   *
   * Higher means "more likely the same neuron". It is a raw logit, not a probability: the
   * pipeline's own stages turn it into one, and a sigmoid applied here would be a second place
   * that decision lives.
   */
  readonly logits: Float32Array
  /**
   * Which candidates took `missingPatchScore` instead of being scored, ascending.
   *
   * Carried rather than inferred from the values: `missingPatchScore` is a real number a real
   * patch could in principle reach, so comparing against it would occasionally call a scored
   * candidate missing.
   */
  readonly missing: Int32Array
  /** How many patches actually went through the graph. */
  readonly scored: number
}

/**
 * Run the assessor over every candidate of one open box.
 *
 * `candidates` is the length of the `candRoots` handed to `openAssessorBox` — the answer is that
 * long, whatever the box could cut.
 */
export async function scoreCandidates(
  session: GraphRunner,
  config: AssessorConfig,
  open: OpenAssessorBox,
  options: AssessorRunOptions = {},
): Promise<AssessorScores> {
  const { box, cut } = open
  const { id } = session.loaded.manifest
  const { part, signature } = soleGraph(session.loaded.manifest)
  const input = signature.inputs[0]
  const output = signature.outputs[0]
  if (!input || !output) throw new Error(`${id} does not take one input and return one output`)

  /*
   * **The patch's size comes from the box, which is where the bytes came from.** The config's
   * own `patchVoxels` is the network's expectation and was already checked against this build's
   * constants when the manifest was read; the box's is the vendored cutter's. They agree, and
   * the one thing that must not happen is slicing a buffer by a number that did not produce it.
   * Refused rather than preferred, because the two disagreeing means one of three places moved.
   */
  if (box.patchSize !== config.patchVoxels) {
    throw new Error(
      `${id} reads ${config.patchVoxels}³ patches and the box cut ${box.patchSize}³. ` +
        'One of the checkpoint, this build and the vendored cutter has moved.',
    )
  }

  /*
   * **Every candidate the box knows about**, which is the whole list: `_labelled` partitions
   * `candRoots` into these two, so asking the box is asking the side that cut them. Taking a
   * count from the caller instead let a third state exist — a candidate in neither list, floor
   * -filled and absent from `missing` — which is the exact silence this file exists to prevent.
   */
  const candidates = box.present.length + box.absent.length

  /*
   * Everything starts at the floor, so a candidate the loop below never reaches keeps a real
   * score rather than a zero — which would be a *good* logit, and would rank an unscorable
   * fragment above half the list.
   */
  const logits = new Float32Array(candidates).fill(config.missingPatchScore)
  const missing = new Set<number>(box.absent)
  const voxels = box.patchSize ** 3

  /*
   * **The next group is asked for before this one is scored.** The cut happens in the Pyodide
   * worker and the run on the GPU, so sequencing them leaves one idle throughout: ~40 ms a
   * group against ~530 ms, which over a hundred-candidate tip is a second of GPU idle. One deep
   * is the whole win — the groups never coexist in the Python heap, because the previous
   * result's proxy is destroyed once it has been copied out.
   */
  const groupAt = (from: number): Promise<AssessorPatches> | undefined => {
    if (from >= box.present.length) return undefined
    const asked = cut({ from, count: Math.min(PATCH_GROUP, box.present.length - from) })
    /*
     * **The handler goes on here, where the promise is made, not where it is abandoned.** A
     * prefetch nobody awaits is an unhandled rejection — "Uncaught (in promise)" in a browser,
     * a failed run under vitest — and the window opens the instant a Cancel fires, which is
     * typically while the loop is parked on a 133 ms inference and cannot yet react. Guarding
     * at the unwind would be too late by exactly that long. A handler on this branch does not
     * swallow the one the loop awaits: that copy still rejects normally.
     */
    void asked.catch(() => {})
    return asked
  }
  let ahead = groupAt(0)

  for (let from = 0; ahead; from += PATCH_GROUP) {
    throwIfAborted(options.signal)
    const group = await ahead
    ahead = groupAt(from + PATCH_GROUP)
    for (const at of group.outside) missing.add(at)

    for (let k = 0; k < group.given.length; k++) {
      throwIfAborted(options.signal)
      const candidate = group.given[k]!
      /*
       * A copy, and it has to be: `WireTensor.data` is **transferred** to the worker, so a
       * subarray view would hand over the whole group's buffer and detach the patches after
       * it. The copy is 2.1 MB against a 133 MB model and a 133 ms run.
       */
      const patch = Float32Array.from(group.patches.subarray(k * voxels, (k + 1) * voxels))
      const answered = await session.run({
        part,
        feeds: [
          {
            name: input,
            type: 'float32',
            dims: [1, box.patchSize, box.patchSize, box.patchSize],
            data: patch.buffer,
          },
        ],
      })
      const got = answered.find((one) => one.name === output)
      if (!got) throw new Error(`${id} returned no ${output}`)
      const value = new Float32Array(got.data)[0]
      if (value === undefined || !Number.isFinite(value)) {
        /*
         * Refused rather than carried: a NaN would sort unpredictably and then poison the
         * softmax over the whole list, taking every other candidate's share with it.
         */
        throw new Error(`${id} answered ${String(value)} for candidate ${candidate}`)
      }
      logits[candidate] = value
    }
    options.onProgress?.(Math.min(from + PATCH_GROUP, box.present.length) / box.present.length)
  }
  // A tip whose box could cut nothing never enters the loop, and a progress bar that never
  // reaches its end reads as a run that stalled rather than one with no work in it.
  if (box.present.length === 0) options.onProgress?.(1)

  return {
    logits,
    missing: Int32Array.from([...missing].sort((a, b) => a - b)),
    /*
     * Derived, not counted. Every candidate is in exactly one of the two — `_labelled`
     * partitions them, and a present one lands in `given` or in `outside` — so a counter kept
     * in the loop would be a second spelling of that, and a `continue` added between the two
     * could desynchronise it from `missing` in silence.
     */
    scored: candidates - missing.size,
  }
}
