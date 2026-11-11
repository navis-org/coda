/**
 * The patch box: SEAM's three numbers, and the containment the box promises.
 *
 * The first half is the point of the file — `patchBox.ts` declares `PATCH`, `PATCH_NM` and
 * `MARGIN_NM` on this side so that a box can be sized before Pyodide is reached, and this reads
 * the vendored Python and holds them to it. Without this the copy is a hand-kept one with
 * nothing checking it, which is the arrangement `VENDORED.md` exists to forbid.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import type { Triple, VolumeScale } from '../../data/precomputed/volume'
import {
  PATCH_MARGIN_NM,
  PATCH_NM,
  PATCH_REACH_NM,
  PATCH_VOXELS,
  boxHoldsPatch,
  patchBoxFor,
} from './patchBox'

/** The vendored file itself, read rather than imported: it is Python. */
const PATCHES_PY = readFileSync(
  new URL('../../pyodide/seam/patches.py', import.meta.url),
  'utf8',
)

/** `NAME = value`, at the start of a line — the form every constant in that file takes. */
function constantOf(name: string): number {
  const found = new RegExp(`^${name} = ([0-9.]+)`, 'm').exec(PATCHES_PY)
  expect(found, `${name} is no longer a module-level constant of patches.py`).toBeTruthy()
  return Number(found![1])
}

/** A scale like Aedes' coarsest, which is the one an assessor patch is cut from. */
const AEDES: VolumeScale = {
  key: '32_32_45',
  resolution: [32, 32, 45],
  size: [10_000, 10_000, 10_000],
  voxelOffset: [1024, 1536, 0],
  chunkSize: [256, 256, 64],
  encoding: 'compressed_segmentation',
  dataType: 'uint64',
  blockSize: [8, 8, 8],
}

describe('the constants are SEAM’s', () => {
  it('matches PATCH', () => {
    expect(PATCH_VOXELS).toBe(constantOf('PATCH'))
  })

  it('matches PATCH_NM', () => {
    expect(PATCH_NM).toBe(constantOf('PATCH_NM'))
  })

  it('matches MARGIN_NM', () => {
    expect(PATCH_MARGIN_NM).toBe(constantOf('MARGIN_NM'))
  })

  /*
   * The derived one, spelled out rather than recomputed from the three above — which would
   * agree with itself whatever they said. SEAM's `patch_box` writes this as
   * `size * res[0] / 2 + MARGIN_NM`.
   */
  it('reaches a patch’s half-width plus the margin', () => {
    expect(PATCH_REACH_NM).toBe(2264)
  })
})

describe('patchBoxFor', () => {
  const centre: Triple = [250_000, 310_000, 278_000]

  it('holds the patch around a single centre', () => {
    const box = patchBoxFor(AEDES, [centre])
    expect(boxHoldsPatch(box, AEDES, centre)).toBe(true)
  })

  it('holds every patch of a spread-out list', () => {
    /* Contacts within the own-tip rule's 2 µm of a tip, which is the real spread. */
    const centres: Triple[] = [
      [248_000, 308_000, 276_000],
      [252_000, 312_000, 280_000],
      [250_000, 310_000, 278_000],
    ]
    const box = patchBoxFor(AEDES, centres)
    for (const one of centres) expect(boxHoldsPatch(box, AEDES, one)).toBe(true)
  })

  /*
   * The reason one box is read instead of one per candidate. A list spread over 4 µm is about
   * 2.8 times the volume of the 6 µm search box — not 38 times, which is what reading a box per
   * candidate would fetch.
   */
  it('grows with the spread, not with the count', () => {
    const near = patchBoxFor(AEDES, [centre, [250_100, 310_100, 278_100]])
    const alone = patchBoxFor(AEDES, [centre])
    const volume = (box: { lo: Triple; hi: Triple }) =>
      (box.hi[0]! - box.lo[0]!) * (box.hi[1]! - box.lo[1]!) * (box.hi[2]! - box.lo[2]!)
    expect(volume(near) / volume(alone)).toBeLessThan(1.1)
  })

  /*
   * The clamp, and why `boxHoldsPatch` is worth having: at the border the box is the part that
   * exists, so a caller must ask rather than assume. A centre one voxel inside the volume's
   * corner cannot have a whole patch around it.
   */
  it('clamps at the edge of the volume, and says the patch does not fit', () => {
    const corner: Triple = [1024 * 32 + 32, 1536 * 32 + 32, 32]
    const box = patchBoxFor(AEDES, [corner])
    expect(box.lo).toEqual([1024, 1536, 0])
    expect(boxHoldsPatch(box, AEDES, corner)).toBe(false)
  })

  it('refuses a scale that is not the patch’s resolution', () => {
    const coarse = { ...AEDES, key: '64_64_45', resolution: [64, 64, 45] as Triple }
    expect(() => patchBoxFor(coarse, [centre])).toThrow(/32 nm/)
  })

  it('refuses no centres at all', () => {
    expect(() => patchBoxFor(AEDES, [])).toThrow(/at least one centre/)
  })
})
