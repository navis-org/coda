/**
 * `neuroglancer_multilod_draco` — multi-resolution Draco meshes.
 *
 * Each segment has a small manifest describing a pyramid of levels of detail. For one
 * hemibrain LC4 the pyramid runs from 2.0 MB at LOD 0 (43 fragments) down to 10.8 kB at
 * LOD 3 (3 fragments) — a 185× range for the same neuron, which is the entire reason to
 * bother with this format instead of a flat mesh.
 *
 * Geometry arrives quantised into a chunk grid, so a fragment's vertices are integers in
 * `[0, 2^bits - 1]` relative to its own chunk. `fragmentTransform` turns those back into
 * physical nanometres. That chain was checked against ground truth: LOD 3 of body
 * 1158187240 reconstructs to a bounding box matching that neuron's skeleton to well under a
 * percent.
 */

import type { ShardingSpec } from './sharded'
import { locate, readMinishard, readObject } from './sharded'
import type { FetchOptions } from './transport'
import { fetchJson } from './transport'

export interface MultiResInfo {
  '@type': 'neuroglancer_multilod_draco'
  vertex_quantization_bits: number
  /** Row-major 3×4: maps model space to physical space, in the volume's units. */
  transform: number[]
  lod_scale_multiplier: number
  sharding?: ShardingSpec
}

export interface LodLevel {
  lod: number
  /** Scale factor for this level's chunk size, from the manifest (typically 2^lod). */
  scale: number
  /** Chunk grid coordinates per fragment, xyz interleaved. */
  positions: Uint32Array
  /** Compressed byte length per fragment. */
  sizes: Uint32Array
  totalBytes: number
}

export interface MultiResManifest {
  chunkShape: [number, number, number]
  gridOrigin: [number, number, number]
  /**
   * Per-LOD model-space offset, three floats per level.
   *
   * Not decoration and not zero: hemibrain uses 1 at LOD 1 and 4 at LOD 3 (half the level's
   * scale), which lands geometry 16–64 nm off if dropped. Small enough to look like
   * rounding, which is exactly why it is easy to skip.
   */
  vertexOffsets: number[]
  levels: LodLevel[]
  /** Absolute offset of the first fragment byte within the shard file. */
  dataStart: number
}

export async function readMultiResInfo(
  base: string,
  options: FetchOptions = {},
): Promise<MultiResInfo> {
  return fetchJson<MultiResInfo>(`${base}/info`, options)
}

/**
 * Parse a manifest.
 *
 * Layout, all little-endian: chunk shape (3×f32), grid origin (3×f32), LOD count (u32), per-LOD
 * scales (f32), per-LOD vertex offsets (3×f32), fragment counts (u32), then for each LOD the
 * fragment grid positions (3×u32 each) followed by the fragment byte sizes (u32 each).
 *
 * `manifestOffset` is where the manifest itself starts in the shard. The fragment data sits
 * *immediately before* it, so the start of the data is the manifest offset minus the total of
 * every fragment size — there is no separate pointer to find it by.
 */
export function parseMultiResManifest(buffer: ArrayBuffer, manifestOffset: number): MultiResManifest {
  const view = new DataView(buffer)
  const chunkShape: [number, number, number] = [
    view.getFloat32(0, true),
    view.getFloat32(4, true),
    view.getFloat32(8, true),
  ]
  const gridOrigin: [number, number, number] = [
    view.getFloat32(12, true),
    view.getFloat32(16, true),
    view.getFloat32(20, true),
  ]
  const lodCount = view.getUint32(24, true)

  let at = 28
  const scales: number[] = []
  for (let i = 0; i < lodCount; i++, at += 4) scales.push(view.getFloat32(at, true))
  const vertexOffsets: number[] = []
  for (let i = 0; i < lodCount * 3; i++, at += 4) vertexOffsets.push(view.getFloat32(at, true))
  const counts: number[] = []
  for (let i = 0; i < lodCount; i++, at += 4) counts.push(view.getUint32(at, true))

  const levels: LodLevel[] = []
  let total = 0
  for (let lod = 0; lod < lodCount; lod++) {
    const count = counts[lod]!
    /*
     * Grid positions are stored as three consecutive arrays — every x, then every y, then
     * every z — not as interleaved triples. Reading them as triples still produces valid
     * coordinates, just the wrong ones, and it is invisible at the coarsest level: three
     * fragments at `0,0,0,0,0,1,0,1,1` decode identically under both layouts. It only shows
     * up a level or two down, as fragments scattered across the whole volume.
     */
    const positions = new Uint32Array(count * 3)
    for (let axis = 0; axis < 3; axis++) {
      for (let f = 0; f < count; f++, at += 4) positions[f * 3 + axis] = view.getUint32(at, true)
    }
    const sizes = new Uint32Array(count)
    let bytes = 0
    for (let i = 0; i < count; i++, at += 4) {
      sizes[i] = view.getUint32(at, true)
      bytes += sizes[i]!
    }
    total += bytes
    levels.push({ lod, scale: scales[lod] ?? 2 ** lod, positions, sizes, totalBytes: bytes })
  }

  return { chunkShape, gridOrigin, vertexOffsets, levels, dataStart: manifestOffset - total }
}

/** Byte offset of a fragment within the shard file. */
export function fragmentOffset(
  manifest: MultiResManifest,
  lod: number,
  fragment: number,
): number {
  let offset = manifest.dataStart
  for (let l = 0; l < lod; l++) offset += manifest.levels[l]!.totalBytes
  const sizes = manifest.levels[lod]!.sizes
  for (let f = 0; f < fragment; f++) offset += sizes[f]!
  return offset
}

/**
 * Scale and offset that map a fragment's quantised integer vertices to physical units.
 *
 * `physical = (vertex * scale) + offset`, applied per axis. Folding the chunk grid, the
 * quantisation range and the volume transform into six numbers keeps the decode loop tight —
 * it runs per vertex, and there can be millions.
 */
export function fragmentTransform(
  info: MultiResInfo,
  manifest: MultiResManifest,
  lod: number,
  fragment: number,
): { scale: [number, number, number]; offset: [number, number, number] } {
  const level = manifest.levels[lod]!
  const maxQuant = 2 ** info.vertex_quantization_bits - 1
  const scale: [number, number, number] = [0, 0, 0]
  const offset: [number, number, number] = [0, 0, 0]

  for (let axis = 0; axis < 3; axis++) {
    const chunk = manifest.chunkShape[axis]! * level.scale
    const gridPosition = level.positions[fragment * 3 + axis]!
    const model = manifest.gridOrigin[axis]! + (manifest.vertexOffsets[lod * 3 + axis] ?? 0)
    // The transform is row-major 3×4; only its diagonal is used because every source seen so
    // far is a pure scale. A rotated transform would need the full matrix here.
    const unit = info.transform[axis * 4 + axis] ?? 1
    scale[axis] = (chunk / maxQuant) * unit
    offset[axis] = (model + gridPosition * chunk) * unit
  }
  return { scale, offset }
}

/**
 * Pick the finest level of detail whose combined size fits a budget.
 *
 * Selection has to happen before anything is decoded, and the manifest records compressed
 * bytes rather than triangle counts — so the budget is converted using a measured
 * bytes-per-triangle ratio. It is an estimate, and the caller reports the *actual* triangle
 * count once the fragments are decoded rather than repeating the guess.
 */
export const DRACO_BYTES_PER_TRIANGLE = 1.7

/*
 * That constant is a rough average, and how rough varies by dataset: hemibrain sits near it,
 * while optic-lobe packs denser and overshot a 300k-triangle budget by 2× at its coarsest
 * level. Overshooting is not a failure — there is no finer knob than "coarsest" — but it is
 * why the result reports the triangle count it actually decoded instead of the estimate.
 */

export function chooseLod(
  manifests: readonly MultiResManifest[],
  triangleBudget: number,
): number {
  const byteBudget = triangleBudget * DRACO_BYTES_PER_TRIANGLE
  const deepest = Math.max(0, ...manifests.map((m) => m.levels.length - 1))
  // Coarsest first, stopping at the finest level that still fits. LOD 0 is the finest.
  for (let lod = 0; lod <= deepest; lod++) {
    const total = manifests.reduce(
      (sum, m) => sum + (m.levels[Math.min(lod, m.levels.length - 1)]?.totalBytes ?? 0),
      0,
    )
    if (total <= byteBudget) return lod
  }
  return deepest
}

/** Fetch a segment's manifest, or undefined when the store has no mesh for it. */
export async function readManifest(
  base: string,
  bodyId: bigint,
  info: MultiResInfo,
  options: FetchOptions = {},
): Promise<MultiResManifest | undefined> {
  if (!info.sharding) {
    // Unsharded multi-res: the manifest is a plain `<id>.index` object and the fragments
    // live in `<id>`. No source in use here is built this way, so rather than ship an
    // untested path, say so.
    throw new Error('Unsharded multi-resolution meshes are not supported yet')
  }
  const location = locate(base, bodyId, info.sharding)
  const entries = await readMinishard(location, info.sharding, options)
  const entry = entries.find((e) => e.key === bodyId)
  if (!entry) return undefined
  const buffer = await readObject(location.url, entry, info.sharding, options)
  // The manifest's own offset is what locates the fragment data that precedes it.
  return parseMultiResManifest(buffer, entry.offset)
}

/** Shard file a segment's fragments live in — the same file as its manifest. */
export function shardUrl(base: string, bodyId: bigint, spec: ShardingSpec): string {
  return locate(base, bodyId, spec).url
}
