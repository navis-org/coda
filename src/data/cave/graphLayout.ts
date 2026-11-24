/**
 * How a chunkedgraph lays out its node ids, and the chunk a node sits in.
 *
 * A chunkedgraph id is not an opaque number: its top bits name the node's **layer**, the next
 * three groups its **chunk** coordinates, and the rest a counter within the chunk. The server
 * reads the chunk off the id wherever it needs one — and one place it needs one is the merge
 * handler's long-range guard, which refuses two supervoxels more than three chunks apart. Coda
 * decodes the same bits so that refusal is known before anything is sent (`merge.ts`).
 *
 * Read off pychunkedgraph v2.20.0, the version Aedes runs, rather than recalled —
 * `graph/chunks/utils.py`:
 *
 * ```py
 * layer = int(node_id) >> 64 - LAYER_ID_BITS
 * x_offset = 64 - LAYER_ID_BITS - bits_per_dim     # bits_per_dim = bitmasks[layer]
 * y_offset = x_offset - bits_per_dim
 * z_offset = y_offset - bits_per_dim
 * x = int(node_id) >> x_offset & 2 ** bits_per_dim - 1
 * ```
 *
 * The widths are the graph's own, published in its segmentation `info` under `graph`
 * (`n_bits_for_layer_id`, `spatial_bit_masks` keyed by layer as text, `cv_mip`), which
 * `supervoxelVolumeOf` (`volumes.ts`) already holds — so nothing here fetches.
 * Both Aedes and the FANC sandbox publish 8 layer bits and 10 bits per axis at layer 1
 * (measured 2026-11-16), but nothing here assumes it.
 *
 * `bigint` throughout: an id is eighteen digits, and a double loses the low bits that are the
 * counter — and, at these widths, some of the chunk too (invariant 8).
 */

import { idText, isSegmentId } from '../../core/ids'
import type { Triple } from '../precomputed/volume'

/**
 * Whether text is an id a chunkedgraph could have minted: a uint64 (`isSegmentId`) other than 0,
 * which is "no object". Checked before an id is sent anywhere that writes, because the server's
 * own refusal of a wider number is numpy's `OverflowError`, unhandled — a 500, which a writer has
 * to read as "may have happened" rather than as a refusal.
 */
export function isNodeId(text: string): boolean {
  return text !== '0' && isSegmentId(text)
}

/**
 * One id from a chunkedgraph reply: text under `int64_as_str`, a safe integer if a server ignores
 * it (`parseCaveJson` quotes any wider one), undefined for anything else or anything `valid`
 * refuses.
 */
export function replyId(value: unknown, valid: (text: string) => boolean): string | undefined {
  const text = typeof value === 'string' || typeof value === 'number' ? idText(value) : null
  return text !== null && valid(text) ? text : undefined
}

/** The id layout of one chunkedgraph table. */
export interface GraphLayout {
  /** How many of an id's top bits name its layer. */
  readonly layerBits: number
  /** Bits per spatial axis, by layer. */
  readonly bitsPerAxis: ReadonlyMap<number, number>
  /** Which scale of the supervoxel volume the graph was built on — the merge points' scale. */
  readonly baseMip: number
  /**
   * That scale's voxel size in nanometres, from the same `info`'s own `scales` list. A reader
   * picks the bucket's scale **by this**, never by `baseMip` as a position: a scale list parsed by
   * a reader that skips encodings it cannot decode no longer lines up with mip numbers, and the
   * server divides merge positions by exactly this resolution.
   */
  readonly baseResolutionNm: Triple
  /**
   * A level-2 chunk's extent in base voxels (`graph.chunk_size`), and where chunk 0 starts (the
   * base scale's `voxel_offset`) — what turns a chunk index into a `bounds` box. Undefined where
   * the info omits either.
   */
  readonly chunkSize?: Triple
  readonly voxelOffset?: Triple
}

/** The `graph` block of a chunkedgraph's segmentation `info`, as far as this reads it. */
interface RawGraph {
  n_bits_for_layer_id?: unknown
  spatial_bit_masks?: unknown
  cv_mip?: unknown
  chunk_size?: unknown
}

/**
 * The layout out of a segmentation `info`, or undefined where it does not publish a whole one.
 *
 * Undefined rather than a guess: every number here changes which chunk an id decodes to, and a
 * plausible default would decode every id to a plausible wrong chunk.
 */
export function parseGraphLayout(info: unknown): GraphLayout | undefined {
  const graph = (info as { graph?: RawGraph } | null)?.graph
  if (!graph || typeof graph !== 'object') return undefined
  const layerBits = graph.n_bits_for_layer_id
  if (!isWholeIn(layerBits, 1, 63)) return undefined
  const masks = graph.spatial_bit_masks
  if (!masks || typeof masks !== 'object') return undefined
  const bitsPerAxis = new Map<number, number>()
  for (const [layer, bits] of Object.entries(masks as Record<string, unknown>)) {
    const n = Number(layer)
    // Three axes and the layer must fit in 64 bits, or the decode below shifts by a negative.
    if (!isWholeIn(n, 1, 255) || !isWholeIn(bits, 0, Math.floor((64 - layerBits) / 3))) {
      return undefined
    }
    bitsPerAxis.set(n, bits)
  }
  if (!bitsPerAxis.has(1)) return undefined
  const baseMip = graph.cv_mip ?? 0
  if (!isWholeIn(baseMip, 0, 64)) return undefined
  const scales = (info as { scales?: unknown }).scales
  const resolution = Array.isArray(scales)
    ? (scales[baseMip] as { resolution?: unknown } | undefined)?.resolution
    : undefined
  if (!isResolution(resolution)) return undefined
  // A chunk extent is three positive numbers, which is `isResolution`'s test; an offset may be 0.
  const chunkSize = graph.chunk_size
  const voxelOffset = Array.isArray(scales)
    ? (scales[baseMip] as { voxel_offset?: unknown } | undefined)?.voxel_offset
    : undefined
  const isOffset = (v: unknown): v is Triple =>
    Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(x))
  return {
    layerBits,
    bitsPerAxis,
    baseMip,
    baseResolutionNm: resolution,
    ...(isResolution(chunkSize) ? { chunkSize } : {}),
    ...(isOffset(voxelOffset) ? { voxelOffset } : {}),
  }
}

/** A layout that can be boxed: one whose `info` publishes the chunk grid. */
export type BoxableLayout = GraphLayout & {
  readonly chunkSize: Triple
  readonly voxelOffset: Triple
}

export function isBoxable(layout: GraphLayout | undefined): layout is BoxableLayout {
  return Boolean(layout?.chunkSize && layout.voxelOffset)
}

/** The grid cell holding a point, nm, along one axis — `cellBox`'s inverse for a position. */
export function cellAt(layout: BoxableLayout, nm: number, axis: number): number {
  return Math.floor(
    (nm / layout.baseResolutionNm[axis]! - layout.voxelOffset[axis]!) / layout.chunkSize[axis]!,
  )
}

/**
 * The box in base voxels covering chunk cells `lo`…`hi` (inclusive) — `chunkOf`'s inverse, for a
 * `subgraph` read. The high corner is the last voxel of the last cell: the server floors the low
 * corner to a chunk and ceils the high one (`normalize_bounding_box`), so this is the cells exactly.
 */
export function cellBox(
  layout: BoxableLayout,
  lo: readonly number[],
  hi: readonly number[],
): readonly [Triple, Triple] {
  const corner = (cell: readonly number[], end: 0 | 1): Triple =>
    [0, 1, 2].map(
      (a) => layout.voxelOffset[a]! + (cell[a]! + end) * layout.chunkSize[a]! - end,
    ) as unknown as Triple
  return [corner(lo, 0), corner(hi, 1)]
}

/** The grid cell holding a point, nm — `cellAt` on each axis. */
export function cellOf(layout: BoxableLayout, nm: readonly number[]): Triple {
  return [cellAt(layout, nm[0]!, 0), cellAt(layout, nm[1]!, 1), cellAt(layout, nm[2]!, 2)]
}

/**
 * A chunk cell's centre, nm — where a level-2 chunk is placed when the datastack has no L2 cache to
 * give its own point (`readSplitNeuron`). Every chunk of a neuron in one cell lands on the same spot.
 */
export function cellCentreNm(layout: BoxableLayout, cell: readonly number[]): Triple {
  const [lo, hi] = cellBox(layout, cell, cell)
  const mid = (a: 0 | 1 | 2) => ((lo[a] + hi[a] + 1) / 2) * layout.baseResolutionNm[a]
  return [mid(0), mid(1), mid(2)]
}

/** The layer an id names. */
export function layerOf(layout: GraphLayout, id: bigint): number {
  return Number(id >> BigInt(64 - layout.layerBits))
}

/**
 * The chunk an id sits in, as the server reads it — or undefined for an id whose layer the graph
 * does not list, which is not a node of this graph.
 */
export function chunkOf(layout: GraphLayout, id: bigint): Triple | undefined {
  return chunkAt(layout, id, layerOf(layout, id))
}

function chunkAt(layout: GraphLayout, id: bigint, layer: number): Triple | undefined {
  const bits = layout.bitsPerAxis.get(layer)
  if (bits === undefined) return undefined
  const mask = (1n << BigInt(bits)) - 1n
  const x = 64 - layout.layerBits - bits
  const y = x - bits
  const z = y - bits
  return [
    Number((id >> BigInt(x)) & mask),
    Number((id >> BigInt(y)) & mask),
    Number((id >> BigInt(z)) & mask),
  ]
}

/**
 * How many chunks apart two ids are, by the server's measure: the largest per-axis difference
 * (Chebyshev). Undefined where either id is not a node of this graph, or the two are on
 * different layers — chunk coordinates on two layers are on two grids.
 */
export function chunkDistance(layout: GraphLayout, a: bigint, b: bigint): number | undefined {
  const layer = layerOf(layout, a)
  if (layer !== layerOf(layout, b)) return undefined
  const ca = chunkAt(layout, a, layer)
  const cb = chunkAt(layout, b, layer)
  if (!ca || !cb) return undefined
  return Math.max(Math.abs(ca[0] - cb[0]), Math.abs(ca[1] - cb[1]), Math.abs(ca[2] - cb[2]))
}

function isResolution(value: unknown): value is Triple {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((nm) => typeof nm === 'number' && Number.isFinite(nm) && nm > 0)
  )
}

function isWholeIn(value: unknown, lo: number, hi: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= lo && value <= hi
}
