/**
 * Reading voxels out of a neuroglancer precomputed volume.
 *
 * Coda could already find the *meshes* inside a volume and nothing else: `isVolumeInfo` existed
 * only to route past a segmentation to the mesh directory it names. This is the other half — a
 * box of nanometres in, the voxels covering it out — and it is a Coda capability with a SEAM
 * caller rather than a piece of SEAM, which is why it lives here.
 *
 * ## The three things a reader has to get right
 *
 * **The grid is anchored on `voxel_offset`, not on zero.** A scale states where its data starts,
 * and chunk boundaries are counted from there. Aedes' 32 nm scale starts at `[1024, 1536, 0]`,
 * so a reader that floors absolute coordinates by the chunk size asks for chunks that are offset
 * by part of a chunk in x and y — every one of which exists and returns data, just not the data
 * under the point asked about. Nothing 404s and nothing looks wrong.
 *
 * **A chunk's name states the clamped extent, not the nominal one.** The last chunk of an axis
 * is named for where the volume actually ends (`…_7424-7482`), so a reader that always writes
 * `start + chunkSize` 404s at exactly the three faces of the volume — which, for a brain, is
 * where nothing interesting is, so it survives a long time before anyone notices.
 *
 * **Voxels are x-fastest.** See `compressedSegmentation.ts`, which argues this at length: a
 * transposed volume is still a plausible volume.
 *
 * ## Why a box and not a chunk
 *
 * Callers want a region, and the region is never the grid. A 6 µm cutout at 32 nm is 188 voxels
 * across where chunks are 256 — so it is eight chunks, of which it uses about an eighth. The
 * fetching cannot be helped (a chunk is what the store serves) but the decoding can, so the box
 * travels all the way down to the decoder rather than being cropped out of a full decode.
 */

import { refuseIfOverCrashFloor } from '../../core/limits'
import type { FetchOptions } from './transport'
import { fetchBytes, fetchInfo, isNotFound } from './transport'
import type { ShardingSpec } from './sharded'
import { readShardedObject } from './sharded'
import type { LabelBox, Triple } from './compressedSegmentation'
import {
  canonicalLabels,
  decodeCompressedSegmentation,
  internInto,
} from './compressedSegmentation'

export type { LabelBox, Triple }

/** The encodings a chunk may be in. `compresso` and `jxl` are not read; they refuse by name. */
export const ENCODINGS = ['raw', 'compressed_segmentation', 'jpeg', 'png'] as const

export type VolumeEncoding = (typeof ENCODINGS)[number]

export interface VolumeScale {
  /** The scale's directory name under the volume, e.g. `32_32_45`. */
  readonly key: string
  /** Nanometres per voxel. */
  readonly resolution: Triple
  /** Extent in voxels. */
  readonly size: Triple
  /** Where the data starts, in voxels of this scale. The grid is anchored here. */
  readonly voxelOffset: Triple
  /** The chunk extent this reader will use — the first of `chunk_sizes`. */
  readonly chunkSize: Triple
  readonly encoding: VolumeEncoding
  /** `compressed_segmentation_block_size`, required by that encoding and absent otherwise. */
  readonly blockSize?: Triple
  /** Present where the scale's chunks are packed into shard files. */
  readonly sharding?: ShardingSpec
  /**
   * The volume's `data_type`, copied onto every scale.
   *
   * Denormalised on purpose: a scale is the unit a reader holds and decodes, and the dtype is
   * needed at the moment a chunk is decoded. Threading the `VolumeInfo` alongside every scale
   * for one string meant every caller holding two things that must match, which is the shape
   * that eventually stops matching.
   */
  readonly dataType: string
}

export interface VolumeInfo {
  readonly dataType: string
  readonly numChannels: number
  /** `segmentation` or `image`; absent on volumes published before the field was conventional. */
  readonly volumeType?: string
  readonly scales: readonly VolumeScale[]
}

/** The raw `info` shape, as far as this reader reads it. */
interface RawScale {
  key?: unknown
  resolution?: unknown
  size?: unknown
  voxel_offset?: unknown
  chunk_sizes?: unknown
  encoding?: unknown
  compressed_segmentation_block_size?: unknown
  sharding?: unknown
}

function triple(value: unknown, what: string): Triple {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(`precomputed volume: ${what} is not three numbers`)
  }
  const out = value.map(Number)
  if (out.some((v) => !Number.isFinite(v))) {
    throw new Error(`precomputed volume: ${what} is not three numbers`)
  }
  return [out[0]!, out[1]!, out[2]!]
}

/**
 * The scales of a volume `info`, checked.
 *
 * Throws rather than returning a partial answer: every field read here is one a later step
 * computes an address from, and a scale missing its `voxel_offset` would otherwise default to
 * zero and read the wrong chunks — the first failure the header names, arriving as data rather
 * than as an error.
 */
export function parseVolumeInfo(raw: unknown): VolumeInfo {
  const info = (raw ?? {}) as Record<string, unknown>
  const scales = info['scales']
  if (!Array.isArray(scales) || scales.length === 0) {
    throw new Error('precomputed volume: the info names no scales')
  }
  const dataType = String(info['data_type'] ?? '')
  /*
   * A scale this reader cannot decode is **left out**, not thrown on — unlike a scale missing a
   * field an address is computed from, which is a malformed document. A volume publishing a
   * `jxl` or `compresso` mip beside readable ones is ordinary, and `scaleNear` would never pick
   * it; refusing the document made the whole volume unreadable over a mip nobody asked for.
   * Refusing happens only when nothing is left, and then the message names what was found.
   */
  const unreadable: string[] = []
  const parsed = scales.flatMap((entry: RawScale, at): VolumeScale[] => {
    const key = typeof entry.key === 'string' ? entry.key : undefined
    if (!key) throw new Error(`precomputed volume: scale ${at} has no key`)
    const chunkSizes = entry.chunk_sizes
    if (!Array.isArray(chunkSizes) || chunkSizes.length === 0) {
      throw new Error(`precomputed volume: scale ${key} names no chunk size`)
    }
    const encoding = String(entry.encoding ?? 'raw')
    const block =
      entry.compressed_segmentation_block_size === undefined
        ? undefined
        : triple(entry.compressed_segmentation_block_size, `scale ${key}'s block size`)
    if (encoding === 'compressed_segmentation' && !block) {
      throw new Error(
        `precomputed volume: scale ${key} is compressed_segmentation and states no block size`,
      )
    }
    if (!(ENCODINGS as readonly string[]).includes(encoding)) {
      unreadable.push(`${key} (${encoding})`)
      return []
    }
    return [
      {
        key,
        resolution: triple(entry.resolution, `scale ${key}'s resolution`),
        size: triple(entry.size, `scale ${key}'s size`),
        // Defaulting to the origin is the spec's own rule, and safe *because* it is the spec's:
        // the field is genuinely optional, unlike the ones above.
        voxelOffset:
          entry.voxel_offset === undefined
            ? ([0, 0, 0] as Triple)
            : triple(entry.voxel_offset, `scale ${key}'s voxel offset`),
        chunkSize: triple(chunkSizes[0], `scale ${key}'s chunk size`),
        encoding: encoding as VolumeEncoding,
        dataType,
        ...(block ? { blockSize: block } : {}),
        ...(entry.sharding ? { sharding: entry.sharding as ShardingSpec } : {}),
      },
    ]
  })
  if (parsed.length === 0) {
    throw new Error(
      'precomputed volume: none of its scales are in an encoding this reader decodes — it ' +
        `found ${unreadable.join(', ')}, and reads ${ENCODINGS.join(', ')}`,
    )
  }
  return {
    dataType,
    numChannels: Number(info['num_channels'] ?? 1) || 1,
    ...(typeof info['type'] === 'string' ? { volumeType: info['type'] } : {}),
    scales: parsed,
  }
}

/** Read and parse a volume's `info`. `base` is the volume directory, no trailing slash. */
export async function openVolume(
  base: string,
  options: FetchOptions = {},
): Promise<VolumeInfo> {
  return parseVolumeInfo(await fetchInfo<unknown>(base, options))
}

/**
 * The scale whose xy resolution is nearest `targetNm`, preferring the coarser of two.
 *
 * Coarser on a tie because the caller asking for "about 64 nm" is asking for a budget, and the
 * finer scale of a pair is four times the voxels for the same box. SEAM asks for 64 and Aedes
 * publishes 16 and 32, so this returns 32 — the coarsest there is.
 */
export function scaleNear(info: VolumeInfo, targetNm: number): VolumeScale {
  let best = info.scales[0]!
  for (const scale of info.scales) {
    const gap = Math.abs(scale.resolution[0] - targetNm)
    const bestGap = Math.abs(best.resolution[0] - targetNm)
    if (gap < bestGap || (gap === bestGap && scale.resolution[0] > best.resolution[0])) {
      best = scale
    }
  }
  return best
}

/**
 * Refuse a volume whose voxels are not a single channel.
 *
 * Both readers take channel 0 and neither offers a way to ask for another, so a multi-channel
 * volume would quietly answer about the first — `num_channels` was parsed and then read by
 * nothing at all. Saying so is the honest version until a caller needs channels; the decoder
 * already takes a channel index, so the day it matters the work is in the readers, not below.
 */
function refuseMultiChannel(
  info: Pick<VolumeInfo, 'numChannels'> | undefined,
  key: string,
): void {
  if (info && info.numChannels > 1) {
    throw new Error(
      `precomputed volume: scale ${key} has ${info.numChannels} channels, and this reader ` +
        'answers about one — nothing here can say which',
    )
  }
}

/**
 * Refuse a box that is not wholly inside the scale.
 *
 * `boxAround` clamps, so the ordinary path never trips this — but both readers take a `VoxelBox`
 * directly and a caller can build one. Outside the grid, `chunksCovering` mints names whose
 * start is past their clamped end (`22784-22016`), which 404 and are then read as **absent**, so
 * the box comes back with a band of zeros along the face: a region of "no object" that looks
 * exactly like the real edge of a segmentation. On a sharded scale it is worse — the compressed
 * morton code of an out-of-grid position can alias onto a key that exists, and the box is filled
 * with another part of the volume.
 *
 * Refused rather than clamped, so the answer is always the box that was asked for; this is the
 * same rule `decodeCompressedSegmentation` applies to a sub-box past its chunk.
 */
function refuseOutsideScale(scale: VolumeScale, box: VoxelBox): void {
  for (let axis = 0; axis < 3; axis++) {
    // Empty before anything is fetched. A degenerate box otherwise cost a round trip and then
    // either returned a box with a zero-length axis or blamed the chunk for being too small.
    if (box.hi[axis]! <= box.lo[axis]!) {
      throw new Error(
        `precomputed volume: the box ${box.lo.join(', ')} to ${box.hi.join(', ')} is empty ` +
          `along ${'xyz'[axis]}`,
      )
    }
    const start = scale.voxelOffset[axis]!
    const end = start + scale.size[axis]!
    if (box.lo[axis]! < start || box.hi[axis]! > end) {
      throw new Error(
        `precomputed volume: the box ${box.lo.join(', ')} to ${box.hi.join(', ')} is not inside ` +
          `scale ${scale.key}, which covers ${scale.voxelOffset.join(', ')} to ` +
          `${scale.voxelOffset.map((v, i) => v + scale.size[i]!).join(', ')} voxels — ` +
          '`boxAround` clamps a box to the scale',
      )
    }
  }
}

/** A box's extent in voxels. Written four times before it was written once. */
function extentOf(box: VoxelBox): Triple {
  return [box.hi[0]! - box.lo[0]!, box.hi[1]! - box.lo[1]!, box.hi[2]! - box.lo[2]!]
}

/**
 * Refuse a box no runtime can allocate.
 *
 * `src/data/nrrd.ts` makes the same refusal for the same shape. A box is sized by its caller, so
 * a mistaken centre or half-width otherwise reaches `new Uint32Array` with a number that throws
 * `RangeError: Invalid array length` — an unexplained crash where `docs/limits.md` asks for a
 * sentence. The **wait** is not refused and is not this module's to price: a reader doing many
 * cutouts prices them over the set, the way `checkAffinitySize.ts` does.
 */
function refuseUnallocatable(size: Triple, bytesPerVoxel: number): void {
  refuseIfOverCrashFloor(
    `A ${size[0]}×${size[1]}×${size[2]} cutout`,
    size[0] * size[1] * size[2] * bytesPerVoxel,
    'Ask for a smaller box, or read a coarser scale.',
  )
}

/**
 * Copy one chunk's cuboid into the box, x fastest.
 *
 * Shared because it was the last piece of per-axis arithmetic written twice, in two different
 * conventions — the label reader walked the decoded part from its own origin, the scalar reader
 * walked absolute voxels and subtracted twice. `ChunkOverlap` exists because that class of
 * duplication produces a box shifted along one axis, which this module's header says nobody
 * notices; leaving the paste in two idioms kept the hazard alive one line below the fix.
 *
 * `lookup` is the label reader's remap from the chunk's table to the box's; the scalar reader
 * passes none and the values go across unchanged.
 */
function pasteBox(
  into: { [at: number]: number },
  boxSize: Triple,
  origin: Triple,
  from: ArrayLike<number>,
  fromSize: Triple,
  fromLo: Triple,
  runs: Triple,
  lookup?: Uint32Array,
): void {
  for (let z = 0; z < runs[2]; z++) {
    for (let y = 0; y < runs[1]; y++) {
      const at =
        (z + fromLo[2]) * fromSize[0] * fromSize[1] + (y + fromLo[1]) * fromSize[0] + fromLo[0]
      const to =
        (origin[2] + z) * boxSize[0] * boxSize[1] + (origin[1] + y) * boxSize[0] + origin[0]
      if (lookup) {
        for (let x = 0; x < runs[0]; x++) into[to + x] = lookup[from[at + x]!]!
      } else {
        for (let x = 0; x < runs[0]; x++) into[to + x] = from[at + x]!
      }
    }
  }
}

/** A half-open box in a scale's voxels: `lo` inclusive, `hi` exclusive. */
export interface VoxelBox {
  readonly lo: Triple
  readonly hi: Triple
}

/**
 * The box of voxels covering a cube of nanometres, clamped to what the scale actually holds.
 *
 * Clamped rather than refused: a tip near the edge of a volume is an ordinary thing, and a box
 * that reaches past the data is answered by the part that exists. A box entirely outside throws,
 * because that is a caller asking about somewhere this volume is not.
 */
export function boxAround(scale: VolumeScale, centreNm: Triple, halfWidthNm: number): VoxelBox {
  const lo: number[] = []
  const hi: number[] = []
  for (let axis = 0; axis < 3; axis++) {
    const res = scale.resolution[axis]!
    const centre = Math.floor(centreNm[axis]! / res)
    const reach = Math.ceil(halfWidthNm / res)
    const start = scale.voxelOffset[axis]!
    const end = start + scale.size[axis]!
    const from = Math.max(start, centre - reach)
    const to = Math.min(end, centre + reach)
    if (to <= from) {
      // Both numbers in nanometres, which is the unit the caller asked in — a bound stated in
      // voxels beside a centre stated in nanometres cannot be compared in one reading.
      throw new Error(
        `precomputed volume: a box around ${centreNm.join(', ')} nm lies outside scale ` +
          `${scale.key}, which covers ${scale.voxelOffset.map((v, i) => v * scale.resolution[i]!).join(', ')}` +
          ` to ${scale.voxelOffset.map((v, i) => (v + scale.size[i]!) * scale.resolution[i]!).join(', ')} nm`,
      )
    }
    lo.push(from)
    hi.push(to)
  }
  return { lo: [lo[0]!, lo[1]!, lo[2]!], hi: [hi[0]!, hi[1]!, hi[2]!] }
}

/** One chunk of the grid: where it sits, and what it is called. */
export interface ChunkRef {
  /** The chunk's own box in the scale's voxels, clamped to the volume — this is its name. */
  readonly lo: Triple
  readonly hi: Triple
  /** The grid position, which is what a sharded store keys on. */
  readonly grid: Triple
  /** `<x0>-<x1>_<y0>-<y1>_<z0>-<z1>`, the object's name under the scale directory. */
  readonly name: string
}

/**
 * Every chunk the box touches.
 *
 * The grid is counted from `voxelOffset`, and each chunk's extent is clamped to the end of the
 * volume — both of which the file header argues are silent when wrong.
 */
export function chunksCovering(scale: VolumeScale, box: VoxelBox): ChunkRef[] {
  const out: ChunkRef[] = []
  const first: number[] = []
  const last: number[] = []
  for (let axis = 0; axis < 3; axis++) {
    const origin = scale.voxelOffset[axis]!
    const step = scale.chunkSize[axis]!
    first.push(Math.floor((box.lo[axis]! - origin) / step))
    last.push(Math.floor((box.hi[axis]! - 1 - origin) / step))
  }
  for (let gz = first[2]!; gz <= last[2]!; gz++) {
    for (let gy = first[1]!; gy <= last[1]!; gy++) {
      for (let gx = first[0]!; gx <= last[0]!; gx++) {
        const grid: Triple = [gx, gy, gz]
        const lo: number[] = []
        const hi: number[] = []
        for (let axis = 0; axis < 3; axis++) {
          const origin = scale.voxelOffset[axis]!
          const step = scale.chunkSize[axis]!
          const start = origin + grid[axis]! * step
          lo.push(start)
          // Clamped to the volume's end, which is how the last chunk of an axis is named.
          hi.push(Math.min(start + step, origin + scale.size[axis]!))
        }
        out.push({
          lo: [lo[0]!, lo[1]!, lo[2]!],
          hi: [hi[0]!, hi[1]!, hi[2]!],
          grid,
          name: `${lo[0]}-${hi[0]}_${lo[1]}-${hi[1]}_${lo[2]}-${hi[2]}`,
        })
      }
    }
  }
  return out
}

/**
 * The compressed morton code of a grid position — a sharded volume's object key.
 *
 * **Only the key differs from a sharded mesh's**, which is worth stating precisely: a mesh keys
 * on its segment id, so the key cannot be shared, but the read that follows it is the same walk
 * and is `readShardedObject`'s. The code interleaves the bits of the three grid coordinates
 * low-to-high, **skipping an axis once its own grid has no more bits** — that skip is the
 * "compressed" part and the whole difficulty: a plain Morton code agrees with it exactly while
 * all three axes are the same size, which is the case every hand-written test uses.
 */
export function compressedMortonCode(grid: Triple, gridShape: Triple): bigint {
  let code = 0n
  let out = 0
  /*
   * `2 ** bit < extent` is cloudvolume's own test, and it is kept rather than the equivalent
   * `bit < ceil(log2(extent))` so that no `Math.log2` result has to be exactly right at a power
   * of two. The two agree for every extent; one of them depends on a float.
   */
  const most = Math.max(...gridShape.map((n) => Math.ceil(Math.log2(Math.max(1, n)))))
  for (let bit = 0; bit < most; bit++) {
    for (let axis = 0; axis < 3; axis++) {
      if (2 ** bit >= gridShape[axis]!) continue
      const value = (BigInt(grid[axis]!) >> BigInt(bit)) & 1n
      code |= value << BigInt(out)
      out += 1
    }
  }
  return code
}

/** How many chunks the scale's grid holds in each axis. */
export function gridShapeOf(scale: VolumeScale): Triple {
  return [
    Math.ceil(scale.size[0]! / scale.chunkSize[0]!),
    Math.ceil(scale.size[1]! / scale.chunkSize[1]!),
    Math.ceil(scale.size[2]! / scale.chunkSize[2]!),
  ]
}

/**
 * Fetch one chunk's bytes, by whichever route the scale is published through.
 *
 * A sharded scale's chunk is **absent rather than missing** where no object exists: an unwritten
 * region of a sharded volume simply has no key, where an unsharded one 404s. Both mean "no data
 * here", and both come back as `undefined` so the caller fills the region with zero.
 */
async function fetchChunk(
  base: string,
  scale: VolumeScale,
  chunk: ChunkRef,
  options: FetchOptions,
): Promise<ArrayBuffer | undefined> {
  if (!scale.sharding) {
    return fetchBytes(`${base}/${scale.key}/${chunk.name}`, options)
  }
  const key = compressedMortonCode(chunk.grid, gridShapeOf(scale))
  const found = await readShardedObject(`${base}/${scale.key}`, key, scale.sharding, options)
  return found?.buffer
}

/**
 * The part of `chunk` that `box` wants, in both coordinate systems at once.
 *
 * Written once because it was written three times — chunk-local in `readLabelBox`, box-local a
 * few lines further down in the same function, and absolute in `readScalarBox` — which is
 * eighteen hand-typed per-axis expressions whose only plausible failure is pairing `box.lo[0]`
 * with `chunk.lo[1]`. That produces a box shifted along one axis, which is exactly the failure
 * this module's header says nobody notices.
 */
export interface ChunkOverlap {
  /** The wanted part, in the chunk's own voxels: `lo` inclusive, `hi` exclusive. */
  readonly lo: Triple
  readonly hi: Triple
  /** Where that part starts in the box's voxels. */
  readonly origin: Triple
  /** The chunk's full extent, which is what a decoder must be told to read it. */
  readonly extent: Triple
}

export function overlapOf(chunk: ChunkRef, box: VoxelBox): ChunkOverlap {
  const lo: number[] = []
  const hi: number[] = []
  const origin: number[] = []
  const extent: number[] = []
  for (let axis = 0; axis < 3; axis++) {
    const from = Math.max(box.lo[axis]!, chunk.lo[axis]!)
    const to = Math.min(box.hi[axis]!, chunk.hi[axis]!)
    lo.push(from - chunk.lo[axis]!)
    hi.push(to - chunk.lo[axis]!)
    origin.push(from - box.lo[axis]!)
    extent.push(chunk.hi[axis]! - chunk.lo[axis]!)
  }
  return {
    lo: [lo[0]!, lo[1]!, lo[2]!],
    hi: [hi[0]!, hi[1]!, hi[2]!],
    origin: [origin[0]!, origin[1]!, origin[2]!],
    extent: [extent[0]!, extent[1]!, extent[2]!],
  }
}

export interface CutoutOptions extends FetchOptions {
  /** How many chunks to have in flight. The default is what one cutout usually needs. */
  readonly concurrency?: number
  /**
   * Called as chunks land, for a progress bar on a long read.
   *
   * `(done, total)` and named `onProgress` because that is what the two sibling readers in this
   * directory already call the identical callback — `FetchSkeletonsOptions.onProgress` and
   * `FetchMeshesOptions.onProgress` — and `meshProgress` is the shared adapter that turns one
   * into a source-level `(fraction, note)`. A third spelling would not be greppable with them.
   */
  readonly onProgress?: (done: number, total: number) => void
  /**
   * The volume the scale came from, where the caller has it.
   *
   * Only `numChannels` is read, and only to refuse a volume this reader would answer about
   * wrongly. Optional because a scale is enough to address a box, and a caller holding one by
   * hand should not have to invent a volume to read it.
   */
  readonly info?: Pick<VolumeInfo, 'numChannels'>
}

const DEFAULT_CONCURRENCY = 8

/**
 * Fetch every chunk the box touches and hand each to `paste`, at most `concurrency` at a time.
 *
 * The scaffolding both readers need and neither should own: the chunk list, the pool, the
 * progress counter, and — the part that matters — the rule that **a 404 is "nothing is written
 * here" and anything else is not an answer about the data**. That rule was stated in two places
 * and had already drifted into two spellings of the overlap arithmetic beside it. A fix applied
 * to one copy passes every test while the other stays wrong.
 */
async function overChunks(
  base: string,
  scale: VolumeScale,
  box: VoxelBox,
  options: CutoutOptions,
  paste: (part: ChunkOverlap, buffer: ArrayBuffer) => void | Promise<void>,
): Promise<void> {
  const chunks = chunksCovering(scale, box)
  let done = 0
  await inFlight(chunks, options.concurrency ?? DEFAULT_CONCURRENCY, async (chunk) => {
    const buffer = await fetchChunk(base, scale, chunk, options).catch((error: unknown) => {
      // Absent, not failed: an unwritten chunk is ordinary at the edge of a volume. A CORS
      // refusal or a 500 is not an answer about the data, and still throws.
      if (isNotFound(error)) return undefined
      throw error
    })
    done += 1
    options.onProgress?.(done, chunks.length)
    if (buffer) await paste(overlapOf(chunk, box), buffer)
  })
}

/**
 * A box of labels out of a segmentation volume.
 *
 * The box is in the scale's own voxels (`boxAround` builds one from nanometres). The result is
 * factored — distinct labels plus an index per voxel — for the reasons `LabelBox` gives.
 *
 * **A chunk that is absent reads as zero**, not as a failure; `overChunks` owns that rule.
 */
export async function readLabelBox(
  base: string,
  scale: VolumeScale,
  box: VoxelBox,
  options: CutoutOptions = {},
): Promise<LabelBox> {
  if (scale.encoding !== 'compressed_segmentation' && scale.encoding !== 'raw') {
    throw new Error(
      `precomputed volume: scale ${scale.key} is \`${scale.encoding}\`, which is an image ` +
        'encoding — read it with `readScalarBox`',
    )
  }
  /*
   * Checked, because the decode below reads anything that is not `uint32` as `uint64`. A raw
   * `uint16` segmentation then reports a truncated chunk (the lengths disagree), but a
   * `compressed_segmentation` one has no length to disagree with and would come back holding
   * plausible 18-digit labels assembled from pairs of 32-bit words. The format allows two.
   */
  if (scale.dataType !== 'uint32' && scale.dataType !== 'uint64') {
    throw new Error(
      `precomputed volume: scale ${scale.key} holds \`${scale.dataType}\`, and a label volume ` +
        'is uint32 or uint64 — read it with `readScalarBox` if it is an image',
    )
  }
  refuseMultiChannel(options.info, scale.key)
  refuseOutsideScale(scale, box)
  const size = extentOf(box)
  // Four bytes a voxel is the honest figure: the label table beside it is thousands of entries.
  refuseUnallocatable(size, 4)
  const index = new Uint32Array(size[0] * size[1] * size[2])
  /*
   * Label 0 holds slot 0 from the start, so a chunk that is absent needs no special case: the
   * index array is already zero there, and `0` is what an unwritten region of a segmentation
   * means. It may therefore end up in the table unused, which the final pass below removes.
   */
  const labels: bigint[] = [0n]
  const intern = internInto(labels, new Map([[0n, 0]]))

  await overChunks(base, scale, box, options, (part, buffer) => {
    const decoded =
      scale.encoding === 'compressed_segmentation'
        ? decodeCompressedSegmentation(
            buffer,
            { size: part.extent, block: scale.blockSize! },
            scale.dataType === 'uint32' ? 'uint32' : 'uint64',
            part.lo,
            part.hi,
          )
        : decodeRawLabels(buffer, part.extent, scale.dataType, part.lo, part.hi)

    // Folded into the box's own table as it arrives, so the labels are the box's rather than any
    // one chunk's — and so two chunks naming the same object share an index.
    const remap = new Uint32Array(decoded.labels.length)
    for (let i = 0; i < decoded.labels.length; i++) remap[i] = intern(decoded.labels[i]!)
    // The decoded part starts at its own origin, so `fromLo` is zero and its size is the run.
    pasteBox(
      index,
      size,
      part.origin,
      decoded.index,
      decoded.size,
      [0, 0, 0],
      decoded.size,
      remap,
    )
  })

  /*
   * Sorted, and stripped of the one slot that can be left unused.
   *
   * **The sort is not cosmetic.** Chunks are fetched concurrently, so the order labels were
   * first seen in is the order the responses happened to land — which means two reads of the
   * same box could return the same voxels under different indices, and anything that cached,
   * hashed or compared a cutout would see them differ for no reason. Sorting makes the answer a
   * function of the data, which is what `readLabelBox` is supposed to be.
   *
   * The unused slot is `0n`, seeded above so an absent chunk needs no special case. Every other
   * label came out of a decoded part, and a decoder only tables a label some voxel resolved — so
   * slot 0 is the only one `canonicalLabels` can ever drop here.
   */
  return canonicalLabels(labels, index, size)
}

/**
 * A `raw` chunk of labels, read as the same factored shape the other encoding produces.
 *
 * **This is the one per-voxel `bigint` path in the file**, and it is the one to look at if a
 * `raw` segmentation ever becomes a real caller: measured at 173 ms for a 4.7 M-voxel cutout
 * against 66 ms for a `Map` keyed on a `number`. Keying on the bigint is invariant 8 and stays
 * until something needs the 100 ms; the uint32 arm is where a number-keyed table could go
 * safely, converting only the few thousand table entries at the end.
 */
function decodeRawLabels(
  buffer: ArrayBuffer,
  extent: Triple,
  dtype: string,
  lo: Triple,
  hi: Triple,
): LabelBox {
  const wide = dtype === 'uint64'
  const voxels = extent[0] * extent[1] * extent[2]
  const expected = voxels * (wide ? 8 : 4)
  if (buffer.byteLength < expected) {
    throw new Error(
      `precomputed volume: a raw chunk holds ${buffer.byteLength} bytes where ${expected} were ` +
        'expected — the object is truncated or the scale states the wrong dtype',
    )
  }
  const source = wide
    ? new BigUint64Array(buffer, 0, voxels)
    : new Uint32Array(buffer, 0, voxels)
  const size: Triple = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]
  const index = new Uint32Array(size[0] * size[1] * size[2])
  const labels: bigint[] = []
  const intern = internInto(labels)
  let at = 0
  for (let z = lo[2]; z < hi[2]; z++) {
    for (let y = lo[1]; y < hi[1]; y++) {
      for (let x = lo[0]; x < hi[0]; x++) {
        const raw = source[x + y * extent[0] + z * extent[0] * extent[1]]!
        index[at] = intern(typeof raw === 'bigint' ? raw : BigInt(raw))
        at += 1
      }
    }
  }
  return { labels: BigUint64Array.from(labels), index, size }
}

/**
 * Run `work` over `items`, at most `limit` at a time.
 *
 * A pool rather than `Promise.all`: eight chunks is 25 MB and a browser will happily open all of
 * them at once, but a caller reading a hundred boxes would then have eight hundred requests in
 * flight at a shared public bucket. The limit is the politeness, and it is the caller's to set.
 *
 * **Deliberately not `mapWithConcurrency`** (`src/data/concurrency.ts`), which is the house pool
 * and would otherwise be the obvious call. It forgives a failed item — `undefined` in its place,
 * throwing only if every item failed — and that rule is exactly wrong here: one 500 would become
 * a silently zero-filled eighth of the box, which is the ordinary-looking-but-wrong answer this
 * module is written against. Here the first failure fails the read, though its siblings still
 * run to completion before the rejection surfaces.
 */
async function inFlight<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const runners = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      for (;;) {
        const at = next
        next += 1
        // `at >= length` rather than `items[at] === undefined`, so an array holding an `undefined`
        // does not end the work early — a trap for the next caller rather than a bug today.
        if (at >= items.length) return
        await work(items[at]!)
      }
    },
  )
  await Promise.all(runners)
}

/** A box of scalar values — an image volume, or a `raw` scale a caller wants unfactored. */
export interface ScalarBox {
  readonly values: InstanceType<(typeof DTYPES)[ScalarDtype]>
  readonly size: Triple
  /**
   * Chunks that were not there, and whose voxels are therefore 0.
   *
   * Counted here and not on `LabelBox` because the two differ in what 0 *means*. For a
   * segmentation 0 is "no object", which is exactly what an unwritten chunk says. For an image
   * 0 is **black** — a real intensity — so a reader that filled an absent chunk with zeros and
   * said nothing would hand back a box with a black slab in it that looks like data.
   */
  readonly missingChunks: number
}

/**
 * The typed array each `data_type` is read and written through — one table, not three.
 *
 * It was three: a width table, an "array to allocate" table and a "view to read" table, each
 * enumerating the same seven strings. They had already gone out of step. `scalarViewOf('int8')`
 * read through an `Int8Array` while `scalarArray('int8')` allocated a `Uint8Array`, so a voxel
 * of `-1` in a signed `raw` scale was read correctly and then stored as `255` — no error, no
 * log, just an image that is wrong wherever the data is negative. One table makes the
 * disagreement unrepresentable rather than unlikely.
 *
 * **`skeletons.ts` has a second table of this name over the same `data_type` vocabulary**, and
 * the two are not merged on purpose: this one views an aligned chunk buffer and so wants a typed
 * array, where a vertex attribute sits at an arbitrary byte offset inside a row and so wants a
 * `DataView` getter — a typed-array view would throw on the misalignment. They are named here so
 * that whichever grows `float64` first, the other is known to exist.
 */
const DTYPES = {
  uint8: Uint8Array,
  int8: Int8Array,
  uint16: Uint16Array,
  int16: Int16Array,
  uint32: Uint32Array,
  int32: Int32Array,
  float32: Float32Array,
} as const

type ScalarDtype = keyof typeof DTYPES

function scalarKind(dtype: string): ScalarDtype | undefined {
  return dtype in DTYPES ? (dtype as ScalarDtype) : undefined
}

/**
 * Decode an image-encoded chunk into one plane of grey values.
 *
 * **Neuroglancer stores a 3-D chunk as a tall 2-D image**: the width is the chunk's x, and the
 * z sections are stacked down the height, so row `y + z * chunkY` is section `z`'s row `y`.
 * Reading it as a single `chunkX × chunkY` image gets section 0 right and silently drops the
 * rest, which on a volume viewer looks like a working reader with a thin dataset.
 *
 * This goes through `createImageBitmap` and a canvas rather than a bundled JPEG decoder: it
 * costs nothing in bundle size and handles every encoding the browser does. The specification
 * permits a browser to colour-manage on the way in, which would make the readback inexact —
 * `colorSpaceConversion: 'none'` and `premultiplyAlpha: 'none'` are what prevent it.
 *
 * **Measured, rather than argued** (`pnpm probe:volume`): one MaleCNS EM chunk read this way is
 * byte-identical to Pillow's decode of the same bytes — all thirty sampled voxels, and the mean
 * and standard deviation to four decimals. The spec still only *permits* exactness, so a reader
 * that cannot tolerate a browser disagreeing should use a `raw` scale; in Chrome, with these
 * options, it is exact.
 */
async function decodeImageChunk(
  buffer: ArrayBuffer,
  extent: Triple,
  encoding: VolumeEncoding,
): Promise<Uint8Array> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    throw new Error(
      `precomputed volume: a \`${encoding}\` scale needs \`createImageBitmap\` and ` +
        '`OffscreenCanvas`, which this runtime does not have — read it in a browser, or use a ' +
        '`raw` or `compressed_segmentation` scale',
    )
  }
  const type = encoding === 'png' ? 'image/png' : 'image/jpeg'
  /*
   * `colorSpaceConversion: 'none'` and `premultiplyAlpha: 'none'` make the readback as close to
   * exact as this route gets — without them the browser is permitted to colour-manage on the way
   * in, which is the inexactness this function's doc admits to. They do not make it guaranteed,
   * so the caveat stands; they remove the avoidable part of it.
   */
  const bitmap = await createImageBitmap(new Blob([buffer], { type }), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  })
  try {
    const wanted = extent[1] * extent[2]
    if (bitmap.width !== extent[0] || bitmap.height !== wanted) {
      throw new Error(
        `precomputed volume: a ${encoding} chunk decoded to ${bitmap.width}×${bitmap.height} ` +
          `where ${extent[0]}×${wanted} was expected (x by y·z) — the scale's chunk size and ` +
          'the stored image disagree',
      )
    }
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('precomputed volume: no 2d context to decode an image chunk')
    context.drawImage(bitmap, 0, 0)
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data
    // One channel out of RGBA. A grey image has r = g = b, so the red channel is the value.
    const out = new Uint8Array(extent[0] * extent[1] * extent[2])
    for (let i = 0; i < out.length; i++) out[i] = pixels[i * 4]!
    return out
  } finally {
    bitmap.close()
  }
}

/**
 * A box of scalar values out of an image volume — EM, or any `raw` scale.
 *
 * The sibling of `readLabelBox`, split from it because the two answer genuinely different
 * questions: a segmentation is a set of objects and is best handed over factored, while an image
 * is a field of numbers where every voxel is its own value and a lookup table would be larger
 * than the data.
 *
 * jsdom has neither `createImageBitmap` nor `OffscreenCanvas`, so the tests here reach only the
 * image arm's refusals; `pnpm probe:volume` drives it in Chrome against the MaleCNS EM, which is
 * `jpeg` **and** sharded and so covers both of this reader's otherwise-untested paths at once.
 */
export async function readScalarBox(
  base: string,
  scale: VolumeScale,
  box: VoxelBox,
  options: CutoutOptions = {},
): Promise<ScalarBox> {
  refuseMultiChannel(options.info, scale.key)
  const kind = scalarKind(scale.dataType)
  const image = scale.encoding === 'jpeg' || scale.encoding === 'png'
  if (!image && scale.encoding !== 'raw') {
    throw new Error(
      `precomputed volume: scale ${scale.key} is \`${scale.encoding}\`, which holds labels — ` +
        'read it with `readLabelBox`',
    )
  }
  if (!kind) {
    throw new Error(
      `precomputed volume: scale ${scale.key} holds \`${scale.dataType}\`, which this reader ` +
        `has no array for (it reads ${Object.keys(DTYPES).join(', ')})`,
    )
  }
  if (image && scale.dataType !== 'uint8') {
    throw new Error(
      `precomputed volume: scale ${scale.key} is ${scale.encoding} but says it holds ` +
        `\`${scale.dataType}\` — an image chunk decodes to 8-bit values`,
    )
  }
  refuseOutsideScale(scale, box)
  const width = DTYPES[kind].BYTES_PER_ELEMENT
  const size = extentOf(box)
  refuseUnallocatable(size, width)
  const values = new DTYPES[kind](size[0] * size[1] * size[2])

  let present = 0
  await overChunks(base, scale, box, options, async (part, buffer) => {
    present += 1
    const voxels = part.extent[0] * part.extent[1] * part.extent[2]
    let source: ArrayLike<number>
    if (image) {
      source = await decodeImageChunk(buffer, part.extent, scale.encoding)
    } else {
      if (buffer.byteLength < voxels * width) {
        throw new Error(
          `precomputed volume: a chunk holds ${buffer.byteLength} bytes where ` +
            `${voxels * width} were expected`,
        )
      }
      source = new DTYPES[kind](buffer, 0, voxels)
    }
    const runs: Triple = [
      part.hi[0]! - part.lo[0]!,
      part.hi[1]! - part.lo[1]!,
      part.hi[2]! - part.lo[2]!,
    ]
    pasteBox(values, size, part.origin, source, part.extent, part.lo, runs)
  })

  return { values, size, missingChunks: chunksCovering(scale, box).length - present }
}
