/**
 * The assessor's input patches: a typed wrapper over `assessorPatches.py`.
 *
 * Stage 6 of SEAM's pipeline, the half before any model runs. A box of supervoxels and a tip's
 * candidate list go in; a 129³ label patch per candidate comes out, which is what the mask
 * assessor was trained to read.
 *
 * ## Three calls, not one
 *
 * A patch is 2.1 MB and a list is up to a hundred of them, so the box is labelled once
 * (`openAssessorBox`), patches are asked for in groups the caller sizes (`cutAssessorPatches`),
 * and the box is dropped when the tip is done (`closeAssessorBox`). The Python header says why
 * in full; the short version is that a whole list in one message is 215 MB crossing at once, to
 * feed a graph that takes one patch per run anyway.
 *
 * `useAssessorBox` wraps the three so a caller cannot leave a box held — which is the failure
 * worth designing against here, since a held box is 11 MB in a heap that never shrinks.
 *
 * ## It does not fetch, and it does not decide the box
 *
 * The cutout is a public bucket read and the roots an authenticated chunkedgraph call, so both
 * stay on this side; `patchBoxAround` says which box to read and nothing here calls it. That
 * split is `cutoutSummary.ts`' and exists for the same reason: no credential in the worker.
 */

import type { LabelBoxRequest } from './cutoutSummary'
import { callPython } from './engine'
import type { CallOptions } from './engine'
import { int32From, numberFrom, uint8From } from './types'

/**
 * How many candidates one labelled box holds.
 *
 * `label_box` writes `uint8` labels and keeps `0` for "no object", so a box holds the query and
 * 254 candidates. **Grouping is the caller's**, which is why this is exported: SEAM's search
 * keeps 100 and the own-tip rule only takes rows away, so a real list never reaches it — but a
 * list that did would otherwise be a tip nothing can score.
 */
export const MAX_CANDIDATES_PER_BOX = 254

/**
 * A box of supervoxels with their roots, plus the candidates to cut patches for.
 *
 * **The box half is `LabelBoxRequest`, not a second spelling of it.** Those seven fields are one
 * agreement with the Python side — what `size` is ordered as, what `0` in `roots` means, which
 * arrays are transferred — and `cutoutSummary.ts` names it for the three requests that share
 * it. Spelled out again here it would have to be changed twice, and a divergence is a silently
 * mis-shaped box.
 *
 * The `roots` are **at the snapshot**, which matters more here than it does for a summary: they
 * decide which voxels become label `1` and which `2`, so roots read at head would describe a
 * different agglomeration from the one the candidate list was built against — and the patch
 * would still look exactly like a patch.
 *
 * A `type`, not an `interface`: only an alias gets the implicit index signature `PyArg` needs.
 */
export type AssessorBoxRequest = LabelBoxRequest & {
  /** One candidate root per patch wanted — label `2` in its own patch, absent from the others. */
  candRoots: BigUint64Array
  /**
   * Each candidate's contact point in nanometres, `3 × candRoots.length`, in the same order.
   *
   * The **contact**, not the candidate's centre: SEAM centres the patch where the two objects
   * come nearest, which is what the network was trained to look at. `runCandidateSearch`
   * publishes it as `contact_x_nm` and friends.
   */
  centresNm: Float64Array
}

/**
 * Which patches to cut: a window along `AssessorBox.present`.
 *
 * Both of them default: no `from` is the start, no `count` is the rest. Named because the
 * wrapper and the handle take the same thing, and spelling it twice let them drift — one
 * required its argument while the other defaulted it to `{}`.
 *
 * A `type`, not an `interface`, and for this file's own stated reason: only an alias gets the
 * implicit index signature `PyArg` needs, and this one crosses the bridge.
 */
export type PatchGroupRequest = {
  /** Which open box this is about — `AssessorBox.id`, refused if another tip has replaced it. */
  box: number
  from?: number
  /**
   * How many patches to cut. **Required**, and the header says why: a list is up to a hundred
   * 2.1 MB patches, and "the rest of them" is not a size a caller should get by saying nothing.
   */
  count: number
}

/** What a labelled box can answer for. */
export interface AssessorBox {
  /**
   * Which box this is, counted by the worker.
   *
   * **The bridge holds one box and nothing in a cut said which.** Two overlapping tips — a
   * cancelled one whose close has not landed, a caller that forgot to await — and the second
   * `open` replaces the first's labels, so the first's next cut answers from it: patches of the
   * right shape, for the wrong neuron. Every later call carries this back and a stale one is
   * refused by name.
   */
  readonly id: number
  /**
   * The candidates that have voxels in the box, as indices into `candRoots`, ascending.
   *
   * `cutAssessorPatches`' `from` counts along *this* list, not along `candRoots`.
   */
  readonly present: Int32Array
  /**
   * The candidates with no voxel in the box — **a real state, not a failure.**
   *
   * The box is cut around the contacts, so a candidate that reaches the search's wider box only
   * at its rim can be absent from this one. SEAM scores such a candidate with its seed's fixed
   * `missing_patch_score`, so a caller must carry these rather than drop them: a dropped row is
   * a candidate silently ranked below everything instead of at its floor.
   */
  readonly absent: Int32Array
  /** The patch's extent in voxels — SEAM's `PATCH`, read from the vendored file, never 129 here. */
  readonly patchSize: number
  /** The resolution a patch is cut at, in nanometres — SEAM's `PATCH_NM`. */
  readonly patchNm: number
  /** How many voxels were labelled, for a caller pricing the read that produced them. */
  readonly boxVoxels: number
  readonly ms: number
}

/** One group of cut patches. */
export interface AssessorPatches {
  /**
   * The patches end to end, `given.length × patchSize³` bytes, `(x, y, z)` within each.
   *
   * `1` is the query neuron, `2` the candidate, `0` neither — and that is the exported graph's
   * `lab` input, which takes float32 of exactly these values.
   */
  readonly patches: Uint8Array
  /** Which candidates those are, as indices into `candRoots`, in the order they are packed. */
  readonly given: Int32Array
  /**
   * Candidates whose patch would have left the box, so none was cut.
   *
   * The second half of `AssessorBox.absent`, and it means the same thing downstream: SEAM's
   * `missing_patch_score`. Two states rather than one because they are fixed differently — an
   * absent candidate is about the agglomeration, one outside the box is about the box.
   */
  readonly outside: Int32Array
  readonly ms: number
}

/**
 * Label a box and hold it.
 *
 * **The arrays are transferred, not copied** — `callPython`'s own rule — so a caller holding a
 * `LabelBox` it means to keep must copy first. Nothing here copies on its behalf: a patch box is
 * tens of megabytes of index and the common case is a caller that is finished with it.
 */
export async function openAssessorBox(
  request: AssessorBoxRequest,
  options: CallOptions = {},
): Promise<AssessorBox> {
  const result = await callPython(
    { module: 'assessorPatches', fn: 'coda_assessor_open', args: [request] },
    options,
  )
  return {
    id: numberFrom(result, 'box'),
    present: int32From(result, 'present'),
    absent: int32From(result, 'absent'),
    patchSize: numberFrom(result, 'patchSize'),
    patchNm: numberFrom(result, 'patchNm'),
    boxVoxels: numberFrom(result, 'boxVoxels'),
    ms: numberFrom(result, 'ms'),
  }
}

/** Cut `count` patches from the open box, starting at `from` along `AssessorBox.present`. */
export async function cutAssessorPatches(
  request: PatchGroupRequest,
  options: CallOptions = {},
): Promise<AssessorPatches> {
  const result = await callPython(
    { module: 'assessorPatches', fn: 'coda_assessor_patches', args: [request] },
    options,
  )
  return {
    patches: uint8From(result, 'patches'),
    given: int32From(result, 'given'),
    outside: int32From(result, 'outside'),
    ms: numberFrom(result, 'ms'),
  }
}

/**
 * Drop the held box — 11 MB that a caller between tips should not be keeping.
 *
 * `box` for the same reason every other call takes one: closing without it would let a late
 * close drop the labels of whichever tip is open *now*.
 */
export async function closeAssessorBox(box: number, options: CallOptions = {}): Promise<void> {
  await callPython(
    { module: 'assessorPatches', fn: 'coda_assessor_close', args: [{ box }] },
    options,
  )
}

/**
 * One open box: what it can answer for, and the way to cut from it.
 *
 * The pair travels together because the bridge holds **one** box and `cutAssessorPatches`
 * addresses it implicitly — so a caller given only an `AssessorBox` has to reach for the cutter
 * separately, and nothing can say the two mean the same box. `useAssessorBox` is what makes
 * "left held" unrepresentable; this is what makes "cut from a box that is no longer open"
 * unrepresentable alongside it.
 */
export interface OpenAssessorBox {
  readonly box: AssessorBox
  /** `box` is filled in from the open box, so a caller cannot cut from a different one. */
  readonly cut: (request: Omit<PatchGroupRequest, 'box'>) => Promise<AssessorPatches>
}

/**
 * Open a box, do something with it, and close it however that ends.
 *
 * The shape every caller should use. A thrown error or a cancelled run would otherwise leave the
 * labels held until the next tip replaced them, and "11 MB stays allocated when a run fails" is
 * exactly the kind of leak nothing reports.
 */
export async function useAssessorBox<T>(
  request: AssessorBoxRequest,
  use: (open: OpenAssessorBox) => Promise<T>,
  options: CallOptions = {},
): Promise<T> {
  const box = await openAssessorBox(request, options)
  try {
    return await use({
      box,
      cut: (ask) => cutAssessorPatches({ ...ask, box: box.id }, options),
    })
  } finally {
    /*
     * **Without the caller's signal**, which is the whole point of closing in a `finally`. The
     * commonest reason to get here is a Cancel, and `callPython` throws `Aborted` at its first
     * line when handed an aborted signal — so passing `options` straight through would refuse
     * the close, the `catch` below would swallow the refusal, and the labelled box would stay
     * held in the worker. That is exactly the leak this wrapper exists to prevent, arriving by
     * the path most likely to reach it. `onProgress` is dropped with it: a close is not work a
     * reader is watching.
     *
     * The `catch` stays for the other failures — a worker already gone, say. Its own failure
     * must not replace the caller's: after the work threw it would report the wrong thing, and
     * after the work succeeded it costs memory, not an answer.
     */
    await closeAssessorBox(box.id).catch(() => {})
  }
}
