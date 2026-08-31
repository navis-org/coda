/**
 * One coordinate space for everything in a 3D scene: nanometres.
 *
 * The two geometry sources disagree natively. neuPrint returns skeleton nodes and synapse
 * locations in **dataset voxels** — a hemibrain skeleton point is `(12926, 18152, 26752)` —
 * while precomputed meshes come out in **physical nanometres** after their transform, which
 * for the same neuron puts the surface around `(103408, 145216, 214016)`. Drawn together
 * without conversion the mesh sits 8× away from the skeleton it should wrap.
 *
 * Nanometres win as the common space rather than voxels because they are the physical truth,
 * they make `cableLength` a real length, and they let two datasets with different voxel sizes
 * share a scene. The cost is that skeleton coordinates no longer match the numbers neuPrint
 * returned, which is why this is a named, documented conversion instead of a stray `* 8`.
 *
 * **Under `data/` rather than `data/neuprint/`, because DVID made it a second backend** — and
 * DVID splits the same way inside one repo, which is the sharpest illustration of why this is
 * named: `AL-VA1v` body 1010 has a mesh in nanometres and a skeleton in voxels, and the two
 * differ by exactly the factor below. `voxelScale` reads DVID's `Extended.VoxelSize` as
 * happily as neuPrint's `Meta.voxelSize`; nothing here was ever neuPrint-specific but its
 * address. Four other files cite this path in prose as the canonical statement of the rule, and
 * they were updated with it.
 */

import type { GeometryUnits } from '../core/values'

/** Scale factors that take dataset voxels to nanometres, per axis. */
export type VoxelScale = readonly [number, number, number]

export const IDENTITY_SCALE: VoxelScale = [1, 1, 1]

const TO_NANOMETRES: Record<string, number> = {
  nanometers: 1,
  nanometres: 1,
  nm: 1,
  micrometers: 1000,
  micrometres: 1000,
  microns: 1000,
  um: 1000,
  µm: 1000,
}

/**
 * Read `Meta.voxelSize` / `Meta.voxelUnits` into a per-axis nm scale.
 *
 * **Answers `undefined` rather than the identity when it cannot tell**, and the distinction is
 * the whole reason this returns an option. A dataset that does not say what its voxels measure
 * is better left in its own units — where at least skeletons and synapses still agree with each
 * other — than scaled by a number nobody checked. But the caller then has two very different
 * facts to publish: coordinates in nanometres, or coordinates in voxels of unknown size. An
 * identity scale conflates them, and a consumer whose answer depends on physical scale (NBLAST
 * is the one that does) cannot recover the difference afterwards. Note that identity is also a
 * perfectly ordinary *success*: a dataset publishing 1 nm voxels scales by exactly 1.
 */
export function voxelScale(voxelSize: unknown, voxelUnits: unknown): VoxelScale | undefined {
  if (!Array.isArray(voxelSize) || voxelSize.length < 3) return undefined
  const unit =
    typeof voxelUnits === 'string' ? TO_NANOMETRES[voxelUnits.toLowerCase()] : undefined
  if (unit === undefined) return undefined

  const scale = [0, 1, 2].map((axis) => {
    const size = Number(voxelSize[axis])
    return Number.isFinite(size) && size > 0 ? size * unit : 1
  }) as [number, number, number]
  return scale
}

/**
 * What coordinates scaled by this are in — the other half of `voxelScale`'s answer.
 *
 * Kept beside it rather than at the call sites, on the same reasoning as invariant 3: the two
 * halves have to agree, and they cannot drift while they are three lines apart. neuPrint hands
 * back dataset voxels, so a scale it could not read leaves them voxels; anything else has been
 * multiplied into nanometres.
 */
export function geometryUnitsFor(scale: VoxelScale | undefined): GeometryUnits {
  return scale ? 'nm' : 'voxels'
}

/** True when the scale would leave coordinates untouched — lets callers skip the work. */
export function isIdentity(scale: VoxelScale): boolean {
  return scale[0] === 1 && scale[1] === 1 && scale[2] === 1
}

/** Scale an interleaved xyz array in place. */
export function scalePositions(positions: Float32Array, scale: VoxelScale): Float32Array {
  if (isIdentity(scale)) return positions
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = positions[i]! * scale[0]
    positions[i + 1] = positions[i + 1]! * scale[1]
    positions[i + 2] = positions[i + 2]! * scale[2]
  }
  return positions
}

/**
 * Scale radii by the mean axis scale.
 *
 * A radius is one number describing something spherical, so an anisotropic voxel has no
 * exactly right answer. Every dataset in use here is isotropic (8×8×8 nm), which makes the
 * mean exact; it stays approximate rather than wrong if that ever changes.
 */
export function scaleRadii(radii: Float32Array, scale: VoxelScale): Float32Array {
  const mean = (scale[0] + scale[1] + scale[2]) / 3
  if (mean === 1) return radii
  for (let i = 0; i < radii.length; i++) radii[i] = radii[i]! * mean
  return radii
}
