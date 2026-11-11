/**
 * Which box to read before cutting a tip's assessor patches.
 *
 * The one piece of stage 6 that has to happen **before** the vendored code can run: the patches
 * are cut from a box of supervoxels, and somebody has to say how big that box is in order to
 * fetch it. SEAM's `patch_box` answers exactly this question — but in numpy, on the far side of
 * a worker, after the read it is deciding the size of.
 *
 * ## So the numbers are declared here, and a test holds them to the vendored file
 *
 * `patchBox.test.ts` reads `src/pyodide/seam/patches.py` and asserts the three constants below
 * are the ones in it. That is the same bargain `ownTip.ts` made and for the same reason: a
 * Pyodide crossing to ask three numbers, before every read, is a worse trade than a test — and
 * a hand-kept copy with nothing checking it is the trade neither of them made.
 *
 * ## Why an approximate box is exactly right
 *
 * SEAM states the property this rests on, in `patch_box`'s own docstring: *"A patch is cut from
 * absolute voxels, so any box that holds it gives the same patch."* The cut is addressed in the
 * volume's own coordinates, not relative to the box, so this does not have to reproduce SEAM's
 * `floor`/`ceil` — it has to be big enough. That turns a byte-for-byte agreement problem into a
 * containment one, which a test can check directly and which clamping at the edge of a volume
 * cannot silently break.
 *
 * What it must not be is *too* big. The box is read over the network and labelled voxel by
 * voxel, so a generous margin is paid twice per tip.
 */

import type { Triple, VolumeScale, VoxelBox } from '../../data/precomputed/volume'
import { boxAroundAll, voxelSpan } from '../../data/precomputed/volume'

/**
 * A patch's extent in voxels — `patches.PATCH`.
 *
 * It is the network's input shape, not a preference: the exported graph's `lab` input is
 * `(n, 129, 129, 129)` and onnxruntime refuses anything else outright, which is at least loud.
 */
export const PATCH_VOXELS = 129

/**
 * The resolution a patch is cut at, in nanometres — `patches.PATCH_NM`, flyCLR's.
 *
 * **The box must be read at a scale whose xy resolution is this.** Not "at least this fine": a
 * patch cut from a 64 nm box covers four times the volume at half the detail, and every voxel
 * of it is a plausible label. Aedes' coarsest scale is `32_32_45`, so there the right scale is
 * also the only one — which is a coincidence of this dataset rather than a rule.
 *
 * z is resampled by the vendored code (Aedes sections are 45 nm), so only xy must match.
 */
export const PATCH_NM = 32

/** How far past the patch's own half-width a box reaches, each side — `patches.MARGIN_NM`. */
export const PATCH_MARGIN_NM = 200

/**
 * How far a patch box must reach from a cut point, in nanometres.
 *
 * `PATCH_VOXELS * PATCH_NM / 2` is the patch's half-width, and the z half-width is the same
 * *in nanometres* — the vendored sampler resamples z to the xy spacing, so a 45 nm section
 * volume needs fewer z voxels for the same reach rather than a different reach.
 */
export const PATCH_REACH_NM = (PATCH_VOXELS * PATCH_NM) / 2 + PATCH_MARGIN_NM

/**
 * The box holding every patch of one tip's candidate list.
 *
 * `centresNm` are the **contacts** — where each candidate comes nearest the query — which is
 * what SEAM centres a patch on. They sit within the own-tip rule's 2 µm of the tip, so their
 * shared box is a little over 8 µm across: about 2.8 times the volume of the 6 µm box the
 * search itself reads, at the same resolution.
 *
 * One box for the list, rather than one per candidate, because the read is the expensive part:
 * forty overlapping 4 µm boxes fetch the same chunks forty times.
 */
export function patchBoxFor(scale: VolumeScale, centresNm: readonly Triple[]): VoxelBox {
  if (
    Math.abs(scale.resolution[0]! - PATCH_NM) > 1e-9 ||
    scale.resolution[0] !== scale.resolution[1]
  ) {
    throw new Error(
      `seam: an assessor patch is cut at ${PATCH_NM} nm with square xy, and scale ` +
        `${scale.key} is ${scale.resolution.join(' × ')} nm. The patch would cover a different ` +
        'volume from the one the network was trained on.',
    )
  }
  return boxAroundAll(scale, centresNm, PATCH_REACH_NM)
}

/**
 * Whether a box certainly holds the patch around one centre — `patchBoxFor`'s own promise.
 *
 * **One-sided on purpose.** True means the vendored sampler will cut this patch; false means
 * only that this cannot promise it, because the reach checked here includes `PATCH_MARGIN_NM`
 * of slack the sampler does not need. Predicting the sampler's refusal exactly would mean
 * reimplementing its z resampling here — a second copy of the arithmetic the whole file exists
 * to avoid owning, to answer a question whose honest answer is "ask it".
 *
 * What it is for is the edge of a volume: `patchBoxFor` clamps rather than refusing, so a tip
 * near the border gets a box that holds some of its patches and not others. Knowing which
 * **before** the read is the difference between a counted `outside` and a wasted fetch.
 */
export function boxHoldsPatch(box: VoxelBox, scale: VolumeScale, centreNm: Triple): boolean {
  // Asked of `volume.ts` rather than recomputed here. This predicate's whole claim is "the box
  // `patchBoxFor` would have asked for, unclamped, is inside the box you have" — so it must be
  // the same mapping, and a second copy of `floor`/`ceil` here would keep compiling after that
  // mapping moved.
  const want = voxelSpan(scale, [centreNm], PATCH_REACH_NM)
  for (let axis = 0; axis < 3; axis++) {
    if (want.lo[axis]! < box.lo[axis]! || want.hi[axis]! > box.hi[axis]!) return false
  }
  return true
}
