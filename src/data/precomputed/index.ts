/**
 * One entry point for reading precomputed meshes, whichever format a source uses.
 *
 * The format is discovered from the mesh directory's `info` rather than configured, because
 * it varies across the datasets that matter: hemibrain, MANC and optic-lobe publish sharded
 * multi-resolution Draco; male-CNS publishes flat legacy meshes. A caller asks for body ids
 * and a triangle budget and gets geometry in physical nanometres.
 *
 * Nothing here knows about neuPrint — this layer is reusable for any neuroglancer source,
 * which is the point given FlyWire and CAVE are the obvious next backends.
 */

import { decodeDracoFragment } from './draco'
import { concatMeshes, readLegacyMesh } from './legacy'
import type { MultiResInfo, MultiResManifest } from './multires'
import {
  chooseLod,
  fragmentOffset,
  fragmentTransform,
  readManifest,
  readMultiResInfo,
  shardUrl,
} from './multires'
import type { FetchOptions } from './transport'
import { fetchBytes, fetchJson } from './transport'
import { mapWithConcurrency } from '../concurrency'

export type MeshFormat = 'multilod-draco' | 'legacy'

export interface MeshSource {
  /** Absolute URL of the mesh directory. */
  base: string
  format: MeshFormat
  /** Only for multi-resolution sources. */
  info?: MultiResInfo
  /** Number of detail levels available; 1 for legacy sources. */
  levels: number
}

interface RawInfo {
  '@type'?: string
  mesh?: string
  sharding?: unknown
}

/**
 * Resolve a segmentation or mesh URL into a usable mesh source.
 *
 * A segmentation `info` names its mesh subdirectory, so a caller can pass either the volume
 * or the mesh directory and get the same answer. An `info` with no `@type` at all is treated
 * as legacy, which is what banc's bucket looks like.
 */
export async function openMeshSource(url: string, options: FetchOptions = {}): Promise<MeshSource> {
  const base = url.replace(/\/+$/, '')
  const info = await fetchJson<RawInfo>(`${base}/info`, options)

  if (info['@type'] === 'neuroglancer_multiscale_volume') {
    if (!info.mesh) throw new Error(`${base} is a volume with no mesh subdirectory`)
    return openMeshSource(`${base}/${info.mesh}`, options)
  }
  if (info['@type'] === 'neuroglancer_multilod_draco') {
    const multi = await readMultiResInfo(base, options)
    if (!multi.sharding) throw new Error(`${base} is multi-resolution but unsharded, which is unsupported`)
    return { base, format: 'multilod-draco', info: multi, levels: 0 }
  }
  // 'neuroglancer_legacy_mesh', or an info with no @type.
  return { base, format: 'legacy', levels: 1 }
}

export interface MeshResult {
  bodyId: number
  positions: Float32Array
  indices: Uint32Array
}

export interface FetchMeshesResult {
  meshes: MeshResult[]
  /** Which detail level was used; undefined for single-level sources. */
  lod?: number | undefined
  /** Levels the source offered, so the UI can say "3 of 4". */
  levels?: number | undefined
  triangles: number
  /** Body ids the source had no mesh for. */
  missing: number[]
}

/** Default budget. ~1.5M triangles renders comfortably and holds a few dozen neurons coarse. */
export const DEFAULT_TRIANGLE_BUDGET = 1_500_000

export interface FetchMeshesOptions extends FetchOptions {
  triangleBudget?: number
  /** Concurrency for per-body reads. Each mesh is several requests. */
  concurrency?: number
  /**
   * Skip any body whose chosen level still exceeds this many compressed bytes, reporting it
   * as missing instead.
   *
   * Different guard rail from `triangleBudget`, which balances a whole batch: this one bounds a
   * *single* body, for a caller that would rather show nothing than wait. It matters because
   * even the coarsest level has a long tail — sampled over hemibrain, the coarsest level is 264
   * bytes at the median but 508 kB at the maximum, and the same 2000× spread exists in every
   * dataset. The manifest carries the size, so the decision costs no download.
   */
  maxBytesPerBody?: number
  /** `phase` distinguishes the manifest sweep from the fragment fetch. */
  onProgress?: (done: number, total: number, phase: 'manifests' | 'fragments') => void
}

/**
 * Fetch meshes for a set of body ids.
 *
 * For a multi-resolution source this reads every manifest first — they are a few hundred
 * bytes each — then picks a single detail level for the whole batch so the scene is
 * internally consistent, then fetches only that level's fragments.
 */
export async function fetchMeshes(
  source: MeshSource,
  bodyIds: readonly number[],
  options: FetchMeshesOptions = {},
): Promise<FetchMeshesResult> {
  const budget = options.triangleBudget ?? DEFAULT_TRIANGLE_BUDGET
  const concurrency = options.concurrency ?? 6

  if (source.format === 'legacy') {
    const meshes: MeshResult[] = []
    const missing: number[] = []
    let done = 0
    await mapWithConcurrency(bodyIds, concurrency, async (bodyId) => {
      const mesh = await readLegacyMesh(source.base, BigInt(bodyId), options)
      options.onProgress?.(++done, bodyIds.length, 'fragments')
      if (!mesh) missing.push(bodyId)
      else meshes.push({ bodyId, ...mesh })
    })
    meshes.sort((a, b) => bodyIds.indexOf(a.bodyId) - bodyIds.indexOf(b.bodyId))
    return {
      meshes,
      levels: 1,
      triangles: meshes.reduce((n, m) => n + m.indices.length / 3, 0),
      missing,
    }
  }

  const info = source.info!
  const manifests = new Map<number, MultiResManifest>()
  const missing: number[] = []
  let read = 0
  await mapWithConcurrency(bodyIds, concurrency, async (bodyId) => {
    const manifest = await readManifest(source.base, BigInt(bodyId), info, options)
    options.onProgress?.(++read, bodyIds.length, 'manifests')
    if (manifest) manifests.set(bodyId, manifest)
    else missing.push(bodyId)
  })

  const present = bodyIds.filter((id) => manifests.has(id))
  const lod = chooseLod([...manifests.values()], budget)
  const levels = Math.max(1, ...[...manifests.values()].map((m) => m.levels.length))

  const meshes: MeshResult[] = []
  let done = 0
  await mapWithConcurrency(present, concurrency, async (bodyId) => {
    const manifest = manifests.get(bodyId)!
    const level = Math.min(lod, manifest.levels.length - 1)
    if (
      options.maxBytesPerBody !== undefined &&
      (manifest.levels[level]?.totalBytes ?? 0) > options.maxBytesPerBody
    ) {
      missing.push(bodyId)
      options.onProgress?.(++done, present.length, 'fragments')
      return
    }
    const mesh = await readLodFragments(source, info, manifest, bodyId, level, options)
    options.onProgress?.(++done, present.length, 'fragments')
    if (mesh) meshes.push({ bodyId, ...mesh })
  })
  meshes.sort((a, b) => bodyIds.indexOf(a.bodyId) - bodyIds.indexOf(b.bodyId))

  return {
    meshes,
    lod,
    levels,
    triangles: meshes.reduce((n, m) => n + m.indices.length / 3, 0),
    missing,
  }
}

async function readLodFragments(
  source: MeshSource,
  info: MultiResInfo,
  manifest: MultiResManifest,
  bodyId: number,
  lod: number,
  options: FetchOptions,
): Promise<{ positions: Float32Array; indices: Uint32Array } | undefined> {
  const level = manifest.levels[lod]
  if (!level || level.sizes.length === 0) return undefined
  const url = shardUrl(source.base, BigInt(bodyId), info.sharding!)

  // One Range request spanning the whole level, then sliced locally: the fragments are
  // contiguous, and one request for 300 kB beats forty for 8 kB each.
  const start = fragmentOffset(manifest, lod, 0)
  const bytes = await fetchBytes(url, {
    ...options,
    range: [start, start + level.totalBytes - 1],
  })

  const parts: Array<{ positions: Float32Array; indices: Uint32Array }> = []
  let at = 0
  for (let fragment = 0; fragment < level.sizes.length; fragment++) {
    const size = level.sizes[fragment]!
    if (size === 0) continue
    const { scale, offset } = fragmentTransform(info, manifest, lod, fragment)
    parts.push(await decodeDracoFragment(bytes.slice(at, at + size), scale, offset))
    at += size
  }
  return parts.length ? concatMeshes(parts) : undefined
}


export { parseLegacyFragment } from './legacy'
export { chooseLod, parseMultiResManifest } from './multires'
export { locate } from './sharded'
export { proxied, resetTransport, transportModes } from './transport'
