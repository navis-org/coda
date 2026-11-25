/**
 * Bounding Box: a box typed as two corners, as a mesh and as a neuroglancer annotation.
 *
 * The node (`nodes/query/boundingBox.ts`) and both exporters read the params through `readBox`, so
 * the card's warning, the run's refusal and a notebook's `TODO` are one sentence about one parse.
 *
 * ## Corners as text, not six number fields
 *
 * The coordinates somebody wants are almost always on screen somewhere else — neuroglancer's
 * position readout, a row of a synapse table — and they arrive by paste. A field per axis takes
 * three pastes per corner and, on a typo, silently a box on the wrong axis. So a corner is one
 * string read as three numbers, in whichever of the spellings neuroglancer copies (`x, y, z`,
 * tab- or space-separated, or a JSON `[x, y, z]`). Which corner is which does not matter: the box
 * is the min and max of the two on each axis.
 *
 * ## Voxels are converted here, and nothing downstream sees them
 *
 * Coda works in nanometres and every value says so (`units: 'nm'`), which is what lets `Points in
 * Volumes`' frame check stop a box in one unit meeting points in another. Neuroglancer's readout is
 * in *voxels* on most datasets (4 × 4 × 40 nm on FlyWire), so `Units: voxels` multiplies by the
 * voxel size before anything is built. The voxel size has no default: one right for one dataset is
 * silently wrong for the next (8 × 8 × 8 on MANC), and a box ten times too small reads as "nothing
 * is inside it".
 */

import type { Bounds3, MeshGeometry } from '../../core/values'
import { localAnnotationLayer } from '../../data/neuroglancer/scene'
import { IDENTITY_SCALE } from '../../data/units'

type Triple = [number, number, number]

/**
 * A typed corner as three numbers, or `undefined`.
 *
 * Looser than `parseScale` (`data/units.ts`) on purpose: a corner may be zero or negative, and
 * arrives in whichever spelling neuroglancer copies, brackets and all. The voxel size is read by
 * the same parser and must also be positive.
 */
export function parseTriple(text: string): Triple | undefined {
  const numbers = text
    .trim()
    .replace(/^[[(]|[\])]$/g, '')
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map(Number)
  return numbers.length === 3 && numbers.every(Number.isFinite)
    ? (numbers as Triple)
    : undefined
}

/** The node's params (`cornerA`, `cornerB`, `units`, `voxelSize`, `name`), as the exporters hold them too. */
type BoxParams = Readonly<Record<string, unknown>>

type BoxReading =
  | { readonly box: Bounds3; readonly name: string; readonly warning?: string }
  | { readonly error: string }

/**
 * The box in nanometres, or one sentence saying why there is none.
 *
 * `warning` is set when the two corners agree on some axis: such a box encloses nothing, so
 * `Points in Volumes` would put every point outside without an error. A warning rather than a
 * refusal (a guard rail warns), since a flat box still draws in neuroglancer as a rectangle.
 */
export function readBox(params: BoxParams): BoxReading {
  const a = String(params.cornerA).trim()
  const b = String(params.cornerB).trim()
  if (!a || !b) {
    return {
      error:
        'Type two opposite corners of the box, each as `x, y, z`. They can be pasted from ' +
        'neuroglancer’s position readout.',
    }
  }
  const pa = parseTriple(a)
  if (!pa) return { error: cornerError('Corner 1', a) }
  const pb = parseTriple(b)
  if (!pb) return { error: cornerError('Corner 2', b) }

  let scale = IDENTITY_SCALE
  if (params.units === 'voxels') {
    const size = parseTriple(String(params.voxelSize))
    if (!size || !size.every((v) => v > 0)) {
      return {
        error:
          '`Voxel size` must be three positive numbers, as `x, y, z` nanometres per voxel — ' +
          '`4, 4, 40` for 4x4x40 nm voxels. Or switch `Units` to nm.',
      }
    }
    scale = size
  }

  const min: Triple = [0, 0, 0]
  const max: Triple = [0, 0, 0]
  const flat: string[] = []
  for (let axis = 0; axis < 3; axis++) {
    const p = toNm(pa[axis]!, scale[axis]!)
    const q = toNm(pb[axis]!, scale[axis]!)
    min[axis] = Math.min(p, q)
    max[axis] = Math.max(p, q)
    if (p === q) flat.push('xyz'[axis]!)
  }
  return {
    box: { min, max },
    name: String(params.name).trim() || 'box',
    ...(flat.length > 0
      ? {
          warning:
            `Both corners have the same ${flat.join(' and ')}, so the box has no volume and no ` +
            'point can be inside it.',
        }
      : {}),
  }
}

/**
 * A coordinate times its scale, to a millionth of a nanometre: `3 * 0.1` is 0.30000000000000004,
 * which both exporters would otherwise print into the notebook as typed.
 */
function toNm(value: number, scale: number): number {
  return Math.round(value * scale * 1e6) / 1e6
}

function cornerError(label: string, text: string): string {
  return `\`${label}\` reads "${text}", which is not three numbers. Type it as \`x, y, z\`.`
}

/*
 * Corner `i` takes x from bit 0, y from bit 1 and z from bit 2. Each face is a quad listed
 * anticlockwise seen from outside, so every triangle's normal points away from the centre —
 * `boundingBox.test.ts` checks it. The inside test does not need a winding (it answers the same
 * for a mesh turned inside out), but the 3D View's lighting does.
 */
const QUADS = [
  [0, 2, 3, 1], // -z
  [4, 5, 7, 6], // +z
  [0, 1, 5, 4], // -y
  [2, 6, 7, 3], // +y
  [0, 4, 6, 2], // -x
  [1, 3, 7, 5], // +x
] as const

/** The 8 corners of a box, `QUADS`' numbering, as nested triples (the exporters' form). */
export function boxVertices(box: Bounds3): Triple[] {
  const out: Triple[] = []
  for (let i = 0; i < 8; i++) {
    out.push([
      i & 1 ? box.max[0] : box.min[0],
      i & 2 ? box.max[1] : box.min[1],
      i & 4 ? box.max[2] : box.min[2],
    ])
  }
  return out
}

/** The 12 triangles over `boxVertices`, zero-based. */
export const BOX_FACES: readonly Triple[] = QUADS.flatMap(([a, b, c, d]): Triple[] => [
  [a, b, c],
  [a, c, d],
])

/** The box as a closed mesh, which is all `Points in Volumes` and the 3D View need. */
export function boxMesh(box: Bounds3, name: string): MeshGeometry {
  return {
    id: name,
    positions: Float32Array.from(boxVertices(box).flat()),
    indices: Uint32Array.from(BOX_FACES.flat()),
  }
}

/**
 * The box as a neuroglancer annotation layer, in nanometres like every local layer Coda builds.
 *
 * One annotation of neuroglancer's own `axis_aligned_bounding_box` type, so the viewer draws it as
 * a wireframe box and lists it in the layer's annotation tab, where clicking it moves the camera
 * there.
 */
export function boxLayer(box: Bounds3, name: string): Readonly<Record<string, unknown>> {
  return localAnnotationLayer(name, '', [
    {
      type: 'axis_aligned_bounding_box',
      id: 'box',
      pointA: [...box.min],
      pointB: [...box.max],
      description: name,
    },
  ])
}
