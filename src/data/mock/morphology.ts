/**
 * Synthetic neuron morphologies.
 *
 * Not biologically accurate — but structurally plausible, which is what the 3D viewer and
 * future morphometric nodes need: a rooted tree with a soma, a primary neurite, a dendritic
 * arbor and an axonal arbor, tapering radii, and points that live where the neuron's ROIs
 * are. That gives real branch structure to prune, measure and colour by.
 *
 * Everything is seeded off the body id, so a neuron's shape is stable across reloads and
 * the provenance cache stays valid.
 */

import type { MeshGeometry, SkeletonGeometry } from '../../core/values'
import { mulberry32 } from './generate'

export interface MorphologyOptions {
  /** Roughly how many points the arbor should have. */
  targetPoints?: number
}

/** Where each ROI sits in the synthetic brain, in arbitrary "nm-like" units. */
const ROI_CENTERS: Record<string, [number, number, number]> = {
  'ME(R)': [-9000, 2000, 1000],
  'LO(R)': [-6500, -1000, 2000],
  'LOP(R)': [-6000, 2500, 3500],
  'AOTU(R)': [-1500, 5000, 1000],
  'PVLP(R)': [-2500, 1000, 2500],
  'PLP(R)': [-2000, 2500, 4000],
  'AL(R)': [1500, -3500, 500],
  'CA(R)': [4500, 2500, 3000],
  'PED(R)': [2500, 500, 2000],
  'aL(R)': [1000, 2000, 500],
  "a'L(R)": [1200, 2600, 900],
  'bL(R)': [800, -500, 1200],
  "b'L(R)": [1100, -200, 1600],
  'gL(R)': [600, 300, 400],
  'LH(R)': [5000, -1500, 2500],
  'SLP(R)': [4000, 3500, 3500],
  'SMP(R)': [2500, 4000, 2500],
}

const DEFAULT_CENTER: [number, number, number] = [0, 0, 0]


export function roiCenter(roi: string): [number, number, number] {
  return ROI_CENTERS[roi] ?? DEFAULT_CENTER
}

interface Branch {
  /** Index of the point this branch grows from. */
  from: number
  direction: [number, number, number]
  radius: number
  /** Remaining recursion budget. */
  depth: number
  /** Target the arbor drifts toward — the ROI this compartment innervates. */
  target: [number, number, number]
}

/**
 * Grow one neuron.
 *
 * Structure: soma at the first ROI centre, a primary neurite toward the second (or a jitter
 * of the first when the neuron only innervates one), then a recursive arbor at each end.
 * That produces the compartmentalised shape real neurons have, so a downstream "split by
 * compartment" node would have something to find.
 */
export function generateSkeleton(
  bodyId: number,
  rois: string[],
  options: MorphologyOptions = {},
): SkeletonGeometry {
  const rand = mulberry32(bodyId >>> 0)
  const targetPoints = options.targetPoints ?? 420

  const positions: number[] = []
  const radii: number[] = []
  const parents: number[] = []

  const push = (x: number, y: number, z: number, radius: number, parent: number): number => {
    positions.push(x, y, z)
    radii.push(radius)
    parents.push(parent)
    return parents.length - 1
  }

  const jitter = (scale: number) => (rand() - 0.5) * scale

  const somaRoi = rois[0] ?? 'AL(R)'
  const arborRoi = rois[1] ?? rois[0] ?? 'AL(R)'
  const somaCenter = roiCenter(somaRoi)
  const arborCenter = roiCenter(arborRoi)

  const soma: [number, number, number] = [
    somaCenter[0] + jitter(1400),
    somaCenter[1] + jitter(1400),
    somaCenter[2] + jitter(1400),
  ]
  const somaRadius = 260 + rand() * 200
  const root = push(soma[0], soma[1], soma[2], somaRadius, -1)

  // Primary neurite: a slightly wandering cable from soma toward the arbor territory.
  const segments = 12
  let current = root
  for (let i = 1; i <= segments; i++) {
    const t = i / segments
    positions.push(
      soma[0] + (arborCenter[0] - soma[0]) * t + jitter(320),
      soma[1] + (arborCenter[1] - soma[1]) * t + jitter(320),
      soma[2] + (arborCenter[2] - soma[2]) * t + jitter(320),
    )
    radii.push(somaRadius * 0.32 * (1 - t * 0.4))
    parents.push(current)
    current = parents.length - 1
  }

  // Two arbors: one where the primary neurite lands, one back near the soma.
  const budget = Math.max(40, targetPoints)
  const queue: Branch[] = [
    {
      from: current,
      direction: normalize([jitter(1), jitter(1), jitter(1)]),
      radius: somaRadius * 0.22,
      depth: 5,
      target: arborCenter,
    },
    {
      from: Math.floor(segments * 0.35),
      direction: normalize([jitter(1), jitter(1), jitter(1)]),
      radius: somaRadius * 0.18,
      depth: 4,
      target: somaCenter,
    },
  ]

  while (queue.length > 0 && parents.length < budget) {
    const branch = queue.shift()!
    const length = 3 + Math.floor(rand() * 4)
    let parent = branch.from
    let direction = branch.direction

    for (let i = 0; i < length && parents.length < budget; i++) {
      const px = positions[parent * 3]!
      const py = positions[parent * 3 + 1]!
      const pz = positions[parent * 3 + 2]!

      // Steer gently toward the compartment centre so arbors stay localised, with noise so
      // they don't collapse into a straight line.
      const toTarget = normalize([
        branch.target[0] - px,
        branch.target[1] - py,
        branch.target[2] - pz,
      ])
      direction = normalize([
        direction[0] * 0.7 + toTarget[0] * 0.12 + jitter(0.55),
        direction[1] * 0.7 + toTarget[1] * 0.12 + jitter(0.55),
        direction[2] * 0.7 + toTarget[2] * 0.12 + jitter(0.55),
      ])

      const step = 260 + rand() * 260
      parent = push(
        px + direction[0] * step,
        py + direction[1] * step,
        pz + direction[2] * step,
        Math.max(18, branch.radius),
        parent,
      )
    }

    if (branch.depth > 1) {
      const children = rand() < 0.75 ? 2 : 1
      for (let c = 0; c < children; c++) {
        queue.push({
          from: parent,
          direction: normalize([
            direction[0] + jitter(0.9),
            direction[1] + jitter(0.9),
            direction[2] + jitter(0.9),
          ]),
          radius: branch.radius * 0.78,
          depth: branch.depth - 1,
          target: branch.target,
        })
      }
    }
  }

  return {
    bodyId,
    positions: Float32Array.from(positions),
    radii: Float32Array.from(radii),
    parents: Int32Array.from(parents),
  }
}

function normalize(v: [number, number, number]): [number, number, number] {
  const length = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / length, v[1] / length, v[2] / length]
}

// ---------------------------------------------------------------------------
// Meshes
// ---------------------------------------------------------------------------

/**
 * A coarse tube mesh around a skeleton.
 *
 * `radialSegments` is deliberately low: a mesh here is context, not the analysis surface,
 * and a full dataset of smooth tubes would be millions of triangles for no extra insight.
 */
export function skeletonToTubeMesh(skeleton: SkeletonGeometry, radialSegments = 5): MeshGeometry {
  const pointCount = skeleton.parents.length
  const positions: number[] = []
  const indices: number[] = []

  // One ring of vertices per skeleton point, oriented on the segment toward its parent.
  const ringStart = new Int32Array(pointCount).fill(-1)

  for (let i = 0; i < pointCount; i++) {
    const parent = skeleton.parents[i]!
    const px = skeleton.positions[i * 3]!
    const py = skeleton.positions[i * 3 + 1]!
    const pz = skeleton.positions[i * 3 + 2]!

    let axis: [number, number, number] = [0, 0, 1]
    if (parent >= 0) {
      axis = normalize([
        px - skeleton.positions[parent * 3]!,
        py - skeleton.positions[parent * 3 + 1]!,
        pz - skeleton.positions[parent * 3 + 2]!,
      ])
    }
    const [u, v] = perpendicularBasis(axis)
    const radius = Math.max(12, skeleton.radii[i]!)

    ringStart[i] = positions.length / 3
    for (let s = 0; s < radialSegments; s++) {
      const angle = (s / radialSegments) * Math.PI * 2
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      positions.push(
        px + (u[0] * cos + v[0] * sin) * radius,
        py + (u[1] * cos + v[1] * sin) * radius,
        pz + (u[2] * cos + v[2] * sin) * radius,
      )
    }
  }

  // Stitch each point's ring to its parent's.
  for (let i = 0; i < pointCount; i++) {
    const parent = skeleton.parents[i]!
    if (parent < 0) continue
    const a = ringStart[i]!
    const b = ringStart[parent]!
    for (let s = 0; s < radialSegments; s++) {
      const next = (s + 1) % radialSegments
      indices.push(a + s, b + s, a + next)
      indices.push(a + next, b + s, b + next)
    }
  }

  return {
    bodyId: skeleton.bodyId,
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
  }
}

/** Two unit vectors perpendicular to `axis`, for building a ring around it. */
function perpendicularBasis(
  axis: [number, number, number],
): [[number, number, number], [number, number, number]] {
  // Pick a reference that is not parallel to the axis, or the cross product degenerates.
  const reference: [number, number, number] =
    Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  const u = normalize(cross(axis, reference))
  const v = normalize(cross(axis, u))
  return [u, v]
}

function cross(
  a: [number, number, number],
  b: [number, number, number],
): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

// ---------------------------------------------------------------------------
// Synapse placement
// ---------------------------------------------------------------------------

/**
 * Place a synapse on a skeleton, deterministically for a given (bodyId, index) pair so the
 * same connection always lands in the same place.
 */
export function synapsePosition(
  skeleton: SkeletonGeometry,
  index: number,
): [number, number, number] {
  const count = skeleton.parents.length
  if (count === 0) return [0, 0, 0]
  const rand = mulberry32((skeleton.bodyId ^ (index * 2654435761)) >>> 0)
  // Bias away from the soma: synapses sit on the arbor, not on the cell body.
  const at = Math.min(count - 1, Math.floor(count * (0.2 + rand() * 0.8)))
  const jitter = () => (rand() - 0.5) * 90
  return [
    skeleton.positions[at * 3]! + jitter(),
    skeleton.positions[at * 3 + 1]! + jitter(),
    skeleton.positions[at * 3 + 2]! + jitter(),
  ]
}

