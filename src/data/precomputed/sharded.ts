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

import { groupBy } from '../../core/collections'
import { inFlight } from '../concurrency'
import { memoPromise } from '../memoPromise'
import { hashUint64 } from './murmur'
import type { FetchOptions } from './transport'
import { fetchBytes, gunzip, isNotFound } from './transport'

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
  // A rejection is not remembered (`memoPromise`): an abort or a transient network failure says
  // nothing about the bytes, and a poisoned entry would make every later reader fail for free.
  const pending = memoPromise(
    minishardCache,
    key,
    () => loadMinishard(location, spec, options),
    { keep: 'resolved' },
  )
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

/**
 * An object's stored bytes as its reader wants them.
 *
 * One rule, because both readers below need it: if `data_encoding` ever grows a third value, a
 * second copy would hand back still-compressed bytes, and compressed bytes decode as garbage
 * rather than failing.
 */
function decodeObject(
  spec: ShardingSpec,
  bytes: ArrayBuffer,
): ArrayBuffer | Promise<ArrayBuffer> {
  return spec.data_encoding === 'gzip' ? gunzip(bytes) : bytes
}

/** Fetch and decode one object out of a shard. */
export async function readObject(
  shardUrl: string,
  entry: MinishardEntry,
  spec: ShardingSpec,
  options: FetchOptions = {},
): Promise<ArrayBuffer> {
  return decodeObject(
    spec,
    await fetchBytes(shardUrl, {
      ...options,
      range: [entry.offset, entry.offset + entry.length - 1],
    }),
  )
}

/**
 * One object out of a sharded store, or undefined when the store holds no such key.
 *
 * `locateMany`'s one-key case plus `readObject`, so there is a single spelling of the lookup
 * walk. Both the mesh manifests and the skeleton blobs need this, and each had written the walk
 * out; a missing key is an ordinary answer in both (not every segment is reconstructed), so the
 * undefined is the shared part rather than an afterthought.
 *
 * It stays beside `readShardedObjects` rather than being expressed through it: a caller of this
 * wants one object and its `entry`, and would otherwise pay for a run list and a callback to
 * get them.
 */
export async function readShardedObject(
  base: string,
  key: bigint,
  spec: ShardingSpec,
  options: FetchOptions = {},
): Promise<{ buffer: ArrayBuffer; entry: MinishardEntry } | undefined> {
  const [found] = await locateMany(base, [key], spec, options, 1)
  if (!found) return undefined
  return { buffer: await readObject(found.url, found.entry, spec, options), entry: found.entry }
}

/** Where one key's bytes are: its shard file and the entry naming the byte range. */
export interface Located {
  readonly key: bigint
  readonly url: string
  readonly entry: MinishardEntry
}

/**
 * Where each of `keys` has its bytes: `locate` → `readMinishard` → find the key, for many keys.
 *
 * **Grouped by minishard first**, so a box whose chunks share an index reads it once and then
 * looks each key up in a map. Per key it was `locate` plus a linear scan of every entry in that
 * index — thousands of BigInt comparisons each, hundreds of thousands for one cutout.
 *
 * A key the store does not hold is simply missing from the answer, not an error: not every id
 * in a key space was written.
 *
 * The index reads are inside `concurrency` too. They were a bare `Promise.all` over every key,
 * which on a cold cache is up to two range requests per distinct minishard with no limit at all
 * — and the per-chunk path it replaced had no such hole, because its lookups happened inside the
 * caller's own pool. One number should describe what the reader does.
 */
async function locateMany(
  base: string,
  keys: readonly bigint[],
  spec: ShardingSpec,
  options: FetchOptions,
  concurrency: number,
): Promise<Located[]> {
  // Keyed by the index's address, not by the `ShardLocation` object: `locate` mints a fresh one
  // per call, and a Map keyed on those compares by identity, so every key would get its own
  // group and the grouping would silently do nothing.
  const byIndex = new Map<string, { location: ShardLocation; keys: bigint[] }>()
  for (const key of keys) {
    const location = locate(base, key, spec)
    const at = `${location.url}#${location.minishard}`
    const group = byIndex.get(at)
    if (group) group.keys.push(key)
    else byIndex.set(at, { location, keys: [key] })
  }
  const located: Located[] = []
  await inFlight([...byIndex.values()], concurrency, async ({ location, keys: mine }) => {
    /*
     * A shard file that is not there has no index either, and that is where the 404 lands first.
     * Tolerated here as well as at the data read below, because the per-chunk path this replaced
     * turned *any* not-found in the walk into an absent chunk — catching it only on the data
     * read left the commonest half of the case failing the whole cutout.
     */
    const entries = await readMinishard(location, spec, options).catch((error: unknown) => {
      if (isNotFound(error)) return []
      throw error
    })
    const byKey = new Map(entries.map((entry) => [entry.key, entry]))
    for (const key of mine) {
      const entry = byKey.get(key)
      if (entry) located.push({ key, url: location.url, entry })
    }
  })
  return located
}

/**
 * How far apart two objects may sit and still be fetched in one request.
 *
 * **This is a speed/bytes trade and it was measured, not chosen.** A sharded request costs a
 * round trip — 0.21 s of time-to-first-byte against this store, flat whatever the range — so a
 * cutout that asks for its chunks one at a time pays that per chunk. One SEAM scene window's 100
 * EM chunks, timed in Chrome through `fetchBytes`:
 *
 *   | fetched                       | requests | MB   | wall   |
 *   |-------------------------------|----------|------|--------|
 *   | one request an object         | 100      | 13.7 | 14.2 s |
 *   | coalesced, touching only      | 30       | 13.7 |  3.4 s |
 *   | coalesced, gaps up to 1 MiB   | 10       | 17.9 |  2.0 s |
 *
 * The gap distribution is **bimodal**: 64 KiB of tolerance still leaves 30 runs, and only about
 * a megabyte reaches 10. So the choice is effectively binary, and the user took the second row's
 * 1.7× for a 31% over-read (2026-11-14).
 *
 * Raising this further buys nothing — past a megabyte the next gaps are enormous — and lowering
 * it to zero costs 1.7× to save bytes nobody is short of.
 */
const MAX_COALESCE_GAP = 1 << 20

/**
 * The most one coalesced request may span, bridged gaps included.
 *
 * `MAX_COALESCE_GAP` alone does not bound a run: a hundred objects each a megabyte apart would
 * merge into one hundred-megabyte read, held whole in memory to be sliced up. This caps that.
 * Splitting a run costs one extra round trip, which is the cheap failure.
 *
 * **It is the product with the pool that matters, and that is why this is 4 and not more.** Runs
 * are fetched `concurrency` at a time, and the `maxBytes` guard below puts each one through
 * `transport.ts`'s streaming `readCapped`, which holds the body twice at its peak — a list of
 * chunks and then the concatenation of them. So the bytes that can be live at once are
 * `concurrency × this × 2`: at `volume.ts`'s measured 32 that is 256 MiB, and nothing prices it
 * (`refuseUnallocatable` sees the output array, not the buffers being sliced into it).
 *
 * A measured window's runs are about 1.8 MB each, so this binds only on a pathological layout,
 * and splitting such a run costs one extra round trip. It is a ceiling, not a working set.
 */
const MAX_RUN_BYTES = 4 << 20

/** One request: a byte range of one shard file, and the objects that lie inside it. */
export interface Run {
  readonly url: string
  readonly start: number
  /** Exclusive. */
  readonly end: number
  readonly wanted: readonly Located[]
}

/**
 * Group located objects into the fewest requests that `MAX_COALESCE_GAP` and `MAX_RUN_BYTES`
 * allow — per shard file, in offset order.
 *
 * Exported for its test: the merging rule is arithmetic on offsets, and the failure it has to be
 * held to (a run that forgets an object, or claims bytes it did not fetch) is invisible in a
 * cutout, which would simply come back holding the wrong picture.
 */
export function coalesceRuns(
  located: readonly Located[],
  maxGap: number = MAX_COALESCE_GAP,
  maxRun: number = MAX_RUN_BYTES,
): Run[] {
  const runs: { url: string; start: number; end: number; wanted: Located[] }[] = []
  for (const [url, list] of groupBy(located, (one) => one.url)) {
    // In place: `groupBy` built this array for us and nobody else holds it.
    list.sort((a, b) => a.entry.offset - b.entry.offset)
    let run: (typeof runs)[number] | undefined
    for (const one of list) {
      const stop = one.entry.offset + one.entry.length
      if (!run || one.entry.offset - run.end > maxGap || stop - run.start > maxRun) {
        run = { url, start: one.entry.offset, end: stop, wanted: [] }
        runs.push(run)
      } else {
        // `Math.max`, not `stop`: objects may nest or repeat, and a shorter one must not
        // shorten the run that already covers it.
        run.end = Math.max(run.end, stop)
      }
      run.wanted.push(one)
    }
  }
  return runs
}

/** `readShardedObjects`' options: `FetchOptions` plus how many requests it may have in flight. */
export interface ShardedReadOptions extends FetchOptions {
  /**
   * Requests in flight, over the index reads and the data reads alike.
   *
   * **Required, with no default here.** A default would be a second, unmeasured number claiming
   * to say what a sharded read's budget is, beside `volume.ts`'s `DEFAULT_CONCURRENCY` — which
   * has a measurement behind it and is what every call passes. Two such numbers, one of them
   * dead, is how a reader ends up tuning the one that does not bind.
   */
  readonly concurrency: number
}

/**
 * Many objects out of one sharded store, in as few requests as their layout allows, each handed
 * over as it arrives.
 *
 * `readShardedObject` for a whole cutout at once. A box's chunks are neighbours in morton order
 * and a sharded store packs neighbours together, so they come back as a handful of runs rather
 * than one request each. See `MAX_COALESCE_GAP` for the measurement that is about.
 *
 * **`onObject` rather than a returned map, and that is the load-bearing part.** A map would not
 * resolve until the last run landed, which costs three things at once: every object's bytes are
 * held simultaneously (tens of megabytes for one cutout, against the `concurrency × one run` the
 * old per-chunk path held); a caller's decode is serialised *after* the network instead of
 * overlapping it; and a progress callback sits at nothing and then jumps to done. Handing each
 * object over inside its run's read gives all three back, and lets a streaming caller — the mesh
 * and skeleton readers deliver per id so partials reach the canvas — use this at all.
 *
 * A key the store does not hold is simply never handed over, exactly as `readShardedObject`
 * answers `undefined`: an unwritten region is an ordinary answer. **So is a shard file that is
 * not there** — its run's objects are absent and the rest of the read is unaffected, which is
 * the same blast radius a 404 has on an unsharded store. Anything else throws.
 */
export async function readShardedObjects(
  base: string,
  keys: readonly bigint[],
  spec: ShardingSpec,
  onObject: (key: bigint, buffer: ArrayBuffer) => void | Promise<void>,
  options: ShardedReadOptions,
): Promise<void> {
  const { concurrency } = options
  const located = await locateMany(base, keys, spec, options, concurrency)
  await inFlight(coalesceRuns(located), concurrency, async (run) => {
    const bytes = await fetchBytes(run.url, {
      ...options,
      range: [run.start, run.end - 1],
      /*
       * A store that ignores `Range` answers 200 with the whole shard — hundreds of megabytes,
       * from which every offset below would then be sliced at the wrong place with no error at
       * all. `bytes.ts` and `zapbench/traces.ts` each guard their own ranged read this way; this
       * is the third site, and coalescing is what takes the blast radius from one object to a
       * whole run.
       */
      maxBytes: run.end - run.start,
    }).catch((error: unknown) => {
      if (isNotFound(error)) return undefined
      throw error
    })
    if (!bytes) return
    for (const { key, entry } of run.wanted) {
      const from = entry.offset - run.start
      /*
       * `slice` copies, and the copy is the point: it is what lets the run buffer — up to
       * `MAX_RUN_BYTES` — be collected while a caller is still working on one object out of it.
       * A view would pin the whole run, and `readScalarBox` needs an offset-0 buffer anyway.
       */
      const slice = bytes.slice(from, from + entry.length)
      await onObject(key, await decodeObject(spec, slice))
    }
  })
}
