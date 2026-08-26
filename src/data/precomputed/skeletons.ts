/**
 * Neuroglancer precomputed skeletons.
 *
 * The sibling of `index.ts`: same buckets, same transport, same sharding, a different payload.
 * One binary blob per segment, and the layout is fixed —
 *
 *     uint32   numVertices
 *     uint32   numEdges
 *     float32  positions[numVertices][3]
 *     uint32   edges[numEdges][2]
 *     …        one contiguous array per entry of `info.vertex_attributes`
 *
 * — which is the whole format. What makes it worth a module is the three things that are *not*
 * in the bytes.
 *
 * ## The edges are a graph and `SkeletonGeometry` is a tree
 *
 * Nothing in the format says otherwise: the edge list is undirected, unordered, and may hold
 * cycles or disconnected components. `parents` is a rooted tree in visit order. The conversion is
 * `spanningForest` in `data/skeletonTree.ts`, shared with CAVE's level-2 reader rather than
 * written twice — a cycle surviving into `parents` makes every consumer that walks to a root
 * loop forever, which is not a bug worth two chances at.
 *
 * ## Radius is an attribute, and usually there is not one
 *
 * `radius` is a *convention* in `vertex_attributes`, not a field. male-CNS publishes
 * `{"@type": "neuroglancer_skeletons"}` and nothing else — no transform, no attributes — so
 * every radius is 0, which is the same answer `cave/l2.ts` gives for a chunk with no
 * distance-transform value: 0 rather than a guess. Attributes that are not `radius` are skipped
 * by *size* rather than ignored, because they sit between the ones that are.
 *
 * ## Units are whatever the source says, and usually already nanometres
 *
 * Measured against male-CNS: vertex coordinates come out around 3.6e5, and the volume is ~93,800
 * voxels of 8 nm across — so these are nanometres, not voxels, and a source that scaled them
 * would put every skeleton 8× away from the mesh of the same neuron. An `info` *may* carry a
 * `transform`, and this applies the **full** 3×4 affine where the mesh reader
 * (`fragmentTransform`) uses only its diagonal. That is not an inconsistency: the mesh transform
 * runs per vertex over millions of quantised vertices and every mesh source in reach is a pure
 * scale, where a skeleton is hundreds of points and the full matrix costs nothing.
 */

import type { SkeletonGeometry } from '../../core/values'
import { mapWithConcurrency } from '../concurrency'
import { byteLengthOf, cachedGeometry } from '../geometryCache'
import type { TreePoint } from '../skeletonTree'
import { spanningForest } from '../skeletonTree'
import type { ShardingSpec } from './sharded'
import { readShardedObject } from './sharded'
import type { FetchOptions } from './transport'
import { PrecomputedFetchError, fetchBytes, fetchInfo } from './transport'

/** One entry of `info.vertex_attributes`. */
interface VertexAttribute {
  id: string
  data_type: string
  num_components: number
}

interface RawSkeletonInfo {
  '@type'?: string
  transform?: number[]
  sharding?: ShardingSpec
  vertex_attributes?: VertexAttribute[]
}

export interface SkeletonSource {
  /** Absolute URL of the skeleton directory, no trailing slash. */
  base: string
  /** Present when the segments live in shard files rather than one object each. */
  sharding?: ShardingSpec
  /** Row-major 3×4 affine to physical nanometres, when the source declares one. */
  transform?: number[]
  /** In file order, which is what makes a `radius` after another attribute findable. */
  vertexAttributes: VertexAttribute[]
}

/** Bytes per value, for the attribute types the format allows. */
const WIDTHS: Readonly<Record<string, number>> = {
  int8: 1,
  uint8: 1,
  int16: 2,
  uint16: 2,
  int32: 4,
  uint32: 4,
  float32: 4,
}

/**
 * Read a skeleton directory's `info`.
 *
 * Refuses anything that is not `neuroglancer_skeletons`, rather than trying to read a mesh
 * directory as skeletons and reporting the result as a neuron with four points in the wrong
 * place. An `info` with no `@type` is *not* given the benefit of the doubt here, which is the
 * opposite of `openMeshSource`'s rule for the same shape — a typeless `info` is a legacy *mesh*
 * directory by convention, so reading one as skeletons is the mistake, not the fallback.
 */
export async function openSkeletonSource(
  url: string,
  options: FetchOptions = {},
): Promise<SkeletonSource> {
  const base = url.replace(/\/+$/, '')
  const info = await fetchInfo<RawSkeletonInfo>(base, options)
  if (info['@type'] !== 'neuroglancer_skeletons') {
    throw new Error(
      `${base} is ${info['@type'] ?? 'an info with no @type'}, not a skeleton source`,
    )
  }
  return {
    base,
    ...(info.sharding ? { sharding: info.sharding } : {}),
    ...(Array.isArray(info.transform) && info.transform.length >= 12
      ? { transform: info.transform }
      : {}),
    vertexAttributes: (info.vertex_attributes ?? []).filter(
      (attribute): attribute is VertexAttribute =>
        Boolean(attribute) && typeof attribute.id === 'string',
    ),
  }
}

/** One decoded skeleton without its id — what the cache holds, keyed by the id. */
type SkeletonBody = Omit<SkeletonGeometry, 'id'>

/**
 * Decode one segment's blob.
 *
 * Every read goes through a `DataView` rather than a typed-array view over the buffer. The
 * positions start at byte 8 and the edges at a multiple of 12 after that, neither of which is
 * guaranteed to be 4-byte aligned once a Range request hands back a slice — and a misaligned
 * typed-array view throws. `legacy.ts` records the same trap for the same reason.
 */
export function parseSkeleton(bytes: ArrayBuffer, source: SkeletonSource): SkeletonBody | undefined {
  if (bytes.byteLength < 8) return undefined
  const view = new DataView(bytes)
  const vertexCount = view.getUint32(0, true)
  const edgeCount = view.getUint32(4, true)
  if (vertexCount === 0) return undefined

  const edgesAt = 8 + vertexCount * 12
  const attributesAt = edgesAt + edgeCount * 8
  if (bytes.byteLength < attributesAt) return undefined

  const radii = readRadii(view, source, attributesAt, vertexCount)
  const points: TreePoint[] = []
  for (let i = 0; i < vertexCount; i++) {
    const x = view.getFloat32(8 + i * 12, true)
    const y = view.getFloat32(8 + i * 12 + 4, true)
    const z = view.getFloat32(8 + i * 12 + 8, true)
    points.push({ at: apply(source.transform, x, y, z), radius: radii?.[i] ?? 0 })
  }

  const edges: Array<readonly [number, number]> = []
  for (let i = 0; i < edgeCount; i++) {
    edges.push([view.getUint32(edgesAt + i * 8, true), view.getUint32(edgesAt + i * 8 + 4, true)])
  }
  return spanningForest(points, edges)
}

/** The row-major 3×4 affine, or the point unchanged when the source declares none. */
function apply(
  transform: readonly number[] | undefined,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  if (!transform) return [x, y, z]
  return [
    transform[0]! * x + transform[1]! * y + transform[2]! * z + transform[3]!,
    transform[4]! * x + transform[5]! * y + transform[6]! * z + transform[7]!,
    transform[8]! * x + transform[9]! * y + transform[10]! * z + transform[11]!,
  ]
}

/**
 * The `radius` attribute, if this source publishes one where this reader can find it.
 *
 * Attributes are contiguous per-attribute arrays in declared order, so reaching `radius` means
 * stepping over whatever precedes it — hence walking the list rather than looking it up. Only a
 * single-component `float32` is read: `radius` is a convention rather than a typed field, and a
 * `uint8` one would be in some quantised unit this has no scale for, which is a plausible number
 * in the wrong units — worse than the honest 0.
 */
function readRadii(
  view: DataView,
  source: SkeletonSource,
  attributesAt: number,
  vertexCount: number,
): Float32Array | undefined {
  let at = attributesAt
  for (const attribute of source.vertexAttributes) {
    const width = WIDTHS[attribute.data_type]
    if (width === undefined) return undefined // Unknown width: every later offset is a guess.
    const bytes = vertexCount * attribute.num_components * width
    if (attribute.id === 'radius' && attribute.data_type === 'float32' && attribute.num_components === 1) {
      if (view.byteLength < at + bytes) return undefined
      const radii = new Float32Array(vertexCount)
      for (let i = 0; i < vertexCount; i++) radii[i] = view.getFloat32(at + i * 4, true)
      return radii
    }
    at += bytes
  }
  return undefined
}

/**
 * One segment's skeleton, or undefined where the source has none for it.
 *
 * A missing skeleton is an answer rather than a failure — not every segment is reconstructed, and
 * a 404 for one body must not fail a batch of five hundred. Anything other than a missing object
 * propagates.
 */
export async function readSkeleton(
  source: SkeletonSource,
  segmentId: bigint,
  options: FetchOptions = {},
): Promise<SkeletonBody | undefined> {
  try {
    const bytes = source.sharding
      ? (await readShardedObject(source.base, segmentId, source.sharding, options))?.buffer
      : await fetchBytes(`${source.base}/${segmentId}`, options)
    return bytes ? parseSkeleton(bytes, source) : undefined
  } catch (error) {
    if (error instanceof PrecomputedFetchError && error.status === 404) return undefined
    throw error
  }
}

export interface FetchSkeletonsOptions extends FetchOptions {
  /** Concurrency for per-segment reads; defaults to the bucket number. */
  concurrency?: number
  onProgress?: (done: number, total: number) => void
  /** Clear Cache, passed straight through to `geometryCache`. */
  refresh?: boolean
  /** When the geometry came from a server; see `GeometryRequest.onFetched`. */
  onFetched?: (at: number) => void
  /** Skeletons decoded so far, in final order — see `FetchMeshesOptions.onPartial`. */
  onPartial?: (skeletons: SkeletonGeometry[]) => void
}

export interface FetchSkeletonsResult {
  skeletons: SkeletonGeometry[]
  /** Segment ids the source had no skeleton for. */
  missing: string[]
}

/**
 * How many segments are read at once.
 *
 * The mesh number, and for the mesh reason: these are Range-free GETs against the same public
 * buckets, so there is no reason to be more timid than the tool that wrote the files. Unlike the
 * mesh path there is no manifest sweep — one request per body, and the first arrival can be drawn
 * — so this streams from the start rather than after a barrier.
 */
const BUCKET_CONCURRENCY = 100

/** Fetch skeletons for a set of segment ids, in the order asked for. */
export async function fetchSkeletons(
  source: SkeletonSource,
  segmentIds: readonly string[],
  options: FetchSkeletonsOptions = {},
): Promise<FetchSkeletonsResult> {
  let done = 0
  const named = (pairs: ReadonlyArray<[string, SkeletonBody]>): SkeletonGeometry[] =>
    pairs.map(([id, body]) => ({ id, ...body }))

  const { ordered, missing } = await cachedGeometry<SkeletonBody>({
    ids: segmentIds,
    key: (id) => `skel:${source.base}:${id}`,
    bytes: (s) => byteLengthOf(s.positions, s.radii, s.parents),
    ...(options.refresh ? { refresh: true } : {}),
    ...(options.onFetched ? { onFetched: options.onFetched } : {}),
    ...(options.onPartial ? { onPartial: (pairs) => options.onPartial?.(named(pairs)) } : {}),
    fetch: async (want, deliver) => {
      await mapWithConcurrency(want, options.concurrency ?? BUCKET_CONCURRENCY, async (id) => {
        const skeleton = await readSkeleton(source, BigInt(id), options)
        options.onProgress?.(++done, want.length)
        if (skeleton) deliver(id, skeleton)
      })
    },
  })
  return { skeletons: named(ordered), missing: [...missing] }
}
