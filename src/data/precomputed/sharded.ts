/**
 * `neuroglancer_uint64_sharded_v1` lookups.
 *
 * A sharded store packs millions of objects into ~1000 files of a couple of hundred
 * megabytes each, so reading one mesh means three Range requests rather than one GET:
 *
 *   1. one 16-byte entry from the shard index at the head of the file, giving the byte range
 *      of the minishard index;
 *   2. the minishard index, gzipped, listing every key in that minishard with its offset;
 *   3. the object itself.
 *
 * Verified against `gs://neuroglancer-janelia-flyem-hemibrain/v1.2/segmentation/mesh`: body
 * 1158187240 resolves to shard 151, minishard 103, and the manifest found there decodes to a
 * mesh whose bounding box matches that neuron's skeleton.
 */

import { hashUint64 } from './murmur'
import type { FetchOptions } from './transport'
import { fetchBytes, gunzip } from './transport'

export interface ShardingSpec {
  '@type': 'neuroglancer_uint64_sharded_v1'
  hash: 'identity' | 'murmurhash3_x86_128'
  preshift_bits: number
  minishard_bits: number
  shard_bits: number
  data_encoding?: 'raw' | 'gzip'
  minishard_index_encoding?: 'raw' | 'gzip'
}

export interface ShardLocation {
  /** Absolute URL of the `.shard` file. */
  url: string
  shard: number
  minishard: number
}

/**
 * Which shard and minishard a key lives in.
 *
 * `preshift_bits` low bits are dropped before hashing, which is what makes neighbouring ids
 * cluster into the same shard — that is the point of the scheme, and getting the shift
 * backwards produces plausible-looking but always-empty lookups.
 */
export function locate(base: string, key: bigint, spec: ShardingSpec): ShardLocation {
  const shifted = key >> BigInt(spec.preshift_bits)
  const hashed = spec.hash === 'identity' ? shifted : hashUint64(shifted)
  const minishard = Number(hashed & ((1n << BigInt(spec.minishard_bits)) - 1n))
  const shard = Number(
    (hashed >> BigInt(spec.minishard_bits)) & ((1n << BigInt(spec.shard_bits)) - 1n),
  )
  // Shard files are named with ceil(shard_bits / 4) lowercase hex digits.
  const digits = Math.max(1, Math.ceil(spec.shard_bits / 4))
  return {
    url: `${base}/${shard.toString(16).padStart(digits, '0')}.shard`,
    shard,
    minishard,
  }
}

/** Byte offset of the first data byte: the shard index occupies the head of the file. */
function dataStart(spec: ShardingSpec): number {
  return (1 << spec.minishard_bits) * 16
}

export interface MinishardEntry {
  key: bigint
  /** Absolute offset within the shard file. */
  offset: number
  length: number
}

/**
 * Minishard indices, keyed by shard URL and minishard number.
 *
 * The sharding scheme exists to cluster neighbouring ids into the same minishard, and both
 * callers walk ids in order — a page of thumbnails, a Meshes node over a body range — so
 * without this every body re-issues two Range requests and a gunzip for an index its
 * neighbour just read. Promises rather than values, so the six concurrent workers share one
 * in-flight read instead of racing for the same bytes.
 *
 * Insertion-ordered eviction, not LRU: a traversal moves forward through id space and never
 * returns, so recency and age say the same thing here.
 */
const minishardCache = new Map<string, Promise<readonly MinishardEntry[]>>()

const MAX_CACHED_MINISHARDS = 64

/** Test-only: drop cached indices so a suite can re-observe the fetches. */
export function resetShardCache(): void {
  minishardCache.clear()
}

/**
 * Read a minishard index and return its entries.
 *
 * The on-disk form is three parallel uint64 arrays — keys, offsets, sizes — where keys are
 * delta-encoded and each offset is relative to the *end of the previous object*, not to the
 * file. Decoding it as absolute offsets yields garbage that still parses, so this is written
 * to make the accumulation obvious.
 */
export function readMinishard(
  location: ShardLocation,
  spec: ShardingSpec,
  options: FetchOptions = {},
): Promise<readonly MinishardEntry[]> {
  const key = `${location.url}#${location.minishard}`
  const hit = minishardCache.get(key)
  if (hit) return hit
  const pending = loadMinishard(location, spec, options)
  minishardCache.set(key, pending)
  // A rejection must not be remembered: an abort or a transient network failure says nothing
  // about the bytes, and a poisoned entry would make every later reader fail for free.
  void pending.catch(() => {
    if (minishardCache.get(key) === pending) minishardCache.delete(key)
  })
  if (minishardCache.size > MAX_CACHED_MINISHARDS) {
    const oldest = minishardCache.keys().next()
    if (!oldest.done) minishardCache.delete(oldest.value)
  }
  return pending
}

async function loadMinishard(
  location: ShardLocation,
  spec: ShardingSpec,
  options: FetchOptions,
): Promise<readonly MinishardEntry[]> {
  const start = dataStart(spec)
  const header = await fetchBytes(location.url, {
    ...options,
    range: [location.minishard * 16, location.minishard * 16 + 15],
  })
  const headerView = new DataView(header)
  const indexStart = headerView.getBigUint64(0, true)
  const indexEnd = headerView.getBigUint64(8, true)
  if (indexStart === indexEnd) return []

  let raw = await fetchBytes(location.url, {
    ...options,
    range: [start + Number(indexStart), start + Number(indexEnd) - 1],
  })
  if (spec.minishard_index_encoding === 'gzip') raw = await gunzip(raw)

  const count = Math.floor(raw.byteLength / 24)
  const view = new DataView(raw)
  const entries: MinishardEntry[] = []
  let key = 0n
  let cursor = 0
  for (let i = 0; i < count; i++) {
    key += view.getBigUint64(i * 8, true)
    const delta = Number(view.getBigUint64((count + i) * 8, true))
    const length = Number(view.getBigUint64((count * 2 + i) * 8, true))
    const offset = cursor + delta
    cursor = offset + length
    entries.push({ key, offset: start + offset, length })
  }
  return entries
}


/** Fetch and decode one object out of a shard. */
export async function readObject(
  shardUrl: string,
  entry: MinishardEntry,
  spec: ShardingSpec,
  options: FetchOptions = {},
): Promise<ArrayBuffer> {
  const bytes = await fetchBytes(shardUrl, {
    ...options,
    range: [entry.offset, entry.offset + entry.length - 1],
  })
  return spec.data_encoding === 'gzip' ? gunzip(bytes) : bytes
}
