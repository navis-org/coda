/**
 * VFB's `volume.obj` for a light-microscopy image, read as points.
 *
 * Despite the extension it is a point cloud, not a mesh: one `v x y z intensity` line per voxel
 * kept, no faces (16,640 vertices and no `f` lines on MB077B, measured 2026-10-14; `live.test.ts`
 * checks it). Coordinates are µm in the template; intensity is VFB's normalisation, in (0, 1].
 * Coda's geometry is in nm, so positions are scaled here, once.
 *
 * A plain line split, not `data/obj.ts`' `parseObj` (it drops the fourth value) nor a hand-written
 * scanner (40 ms against 30 ms on a 7.3 MB cloud, measured 2026-10-14).
 */

import { fetchText } from '../fetchText'
import { NM_PER_UM } from '../units'
import { vfbFileUrl } from './common'

const HINT = 'Virtual Fly Brain’s file server answers cross-origin reads; check that it is up.'

export interface PointCloud {
  /** xyz interleaved, nm. */
  readonly positions: Float32Array
  readonly intensity: Float32Array
}

/** Every `v` line at or above `minIntensity`. A line without a fourth value counts as 1. */
export function readPointCloud(text: string, minIntensity = 0): PointCloud {
  const xyz: number[] = []
  const level: number[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('v ')) continue
    const parts = line.trim().split(/\s+/)
    const x = Number(parts[1])
    const y = Number(parts[2])
    const z = Number(parts[3])
    const i = parts[4] === undefined ? 1 : Number(parts[4])
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(z) ||
      !(i >= minIntensity)
    ) {
      continue
    }
    xyz.push(x * NM_PER_UM, y * NM_PER_UM, z * NM_PER_UM)
    level.push(i)
  }
  return { positions: Float32Array.from(xyz), intensity: Float32Array.from(level) }
}

/**
 * At most `max` points, kept at an even stride so the cloud keeps its shape; `max` of 0 keeps all.
 * Deterministic, so a cache key built from the cap means one answer (invariant 4).
 */
export function capPoints(cloud: PointCloud, max: number): PointCloud {
  const n = cloud.intensity.length
  if (max <= 0 || n <= max) return cloud
  const stride = Math.ceil(n / max)
  const kept = Math.ceil(n / stride)
  const positions = new Float32Array(kept * 3)
  const intensity = new Float32Array(kept)
  for (let k = 0, i = 0; i < n; i += stride, k++) {
    positions[k * 3] = cloud.positions[i * 3]!
    positions[k * 3 + 1] = cloud.positions[i * 3 + 1]!
    positions[k * 3 + 2] = cloud.positions[i * 3 + 2]!
    intensity[k] = cloud.intensity[i]!
  }
  return { positions, intensity }
}

/**
 * Download and read one cloud. Only VFB's own file server is fetched, checked here at the fetch
 * rather than trusted from wherever the URL came from: a node's picker can read any table.
 */
export async function fetchPointCloud(
  url: string,
  minIntensity: number,
  signal?: AbortSignal,
): Promise<{ cloud: PointCloud; bytes: number }> {
  const text = await fetchText(vfbFileUrl(url), { hint: HINT, signal })
  // A parse cannot be interrupted, so a Cancel that landed during the download stops here.
  signal?.throwIfAborted()
  return { cloud: readPointCloud(text, minIntensity), bytes: text.length }
}
