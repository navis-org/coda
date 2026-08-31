/**
 * The neuroglancer precomputed mesh readers.
 *
 * Two kinds of check here, and the split matters:
 *
 *  - **Pinned against reality.** The manifest fixture is a real gunzipped manifest for
 *    hemibrain body 1158187240, and the expected shard, minishard, fragment layout and
 *    transform are all numbers observed from the live bucket — then confirmed by decoding
 *    the geometry and matching its bounding box against that neuron's skeleton. A synthetic
 *    fixture would only prove this code agrees with itself.
 *  - **Constructed.** Byte-level parsing and the transport fallback, where hand-built input
 *    exercises the edges that real data happens not to contain.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import fragmentFixture from './__fixtures__/dracoFragment.json'
import manifestFixture from './__fixtures__/hemibrainManifest.json'
import type { RestoreFetch } from '../../test/precomputedStubs'
import { serveDracoWasmFromDisk } from '../../test/precomputedStubs'
import { meshProgress } from './index'
import { concatMeshes, parseLegacyFragment } from './legacy'
import type { MultiResInfo } from './multires'
import { chooseLod, fragmentOffset, fragmentTransform, parseMultiResManifest } from './multires'
import { hashUint64, murmurHash3x86_128 } from './murmur'
import type { ShardingSpec } from './sharded'
import { locate } from './sharded'
import {
  PrecomputedFetchError,
  fetchBytes,
  gcsJsonApiUrl,
  proxied,
  resetTransport,
  transportModes,
} from './transport'
import { resetShardCache } from './sharded'

const HEMIBRAIN_SHARDING = manifestFixture.info.sharding as ShardingSpec
const HEMIBRAIN_INFO: MultiResInfo = {
  '@type': 'neuroglancer_multilod_draco',
  vertex_quantization_bits: manifestFixture.info.vertex_quantization_bits,
  transform: manifestFixture.info.transform,
  lod_scale_multiplier: 1,
  sharding: HEMIBRAIN_SHARDING,
}

function manifestBytes(): ArrayBuffer {
  const raw = Buffer.from(manifestFixture.manifestBase64, 'base64')
  return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
}

// Minishard indices are memoised per shard URL, so a case that reads one would otherwise
// hand its bytes to the next.
afterEach(resetShardCache)

describe('murmurhash3_x86_128', () => {
  it('is deterministic and mixes the whole key', () => {
    expect(hashUint64(1158187240n)).toBe(hashUint64(1158187240n))
    expect(hashUint64(1158187240n)).not.toBe(hashUint64(1158187241n))
  })

  it('returns four 32-bit words', () => {
    const words = murmurHash3x86_128(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
    expect(words).toHaveLength(4)
    for (const word of words) {
      expect(Number.isInteger(word)).toBe(true)
      expect(word).toBeGreaterThanOrEqual(0)
      expect(word).toBeLessThanOrEqual(0xffffffff)
    }
  })

  it('handles keys long enough to use the block path', () => {
    // Keys here are 8 bytes so the 16-byte block loop never runs in production; exercise it
    // anyway, because a broken loop would be invisible until some other source used it.
    const long = new Uint8Array(40).map((_, i) => i * 7)
    expect(() => murmurHash3x86_128(long)).not.toThrow()
    expect(murmurHash3x86_128(long)).toEqual(murmurHash3x86_128(long))
  })
})

describe('shard location', () => {
  const base = 'https://example.org/mesh'

  it('puts real hemibrain bodies in the shards the live bucket has them in', () => {
    // Both verified by reading the minishard index from the bucket and finding the key.
    expect(locate(base, 1158187240n, HEMIBRAIN_SHARDING)).toEqual({
      url: `${base}/151.shard`,
      shard: 0x151,
      minishard: 103,
    })
    expect(locate(base, 1001453586n, HEMIBRAIN_SHARDING)).toEqual({
      url: `${base}/1ab.shard`,
      shard: 0x1ab,
      minishard: 166,
    })
  })

  it('names shard files with ceil(shard_bits / 4) hex digits', () => {
    const wide = { ...HEMIBRAIN_SHARDING, shard_bits: 16 }
    expect(locate(base, 1158187240n, wide).url).toMatch(/\/[0-9a-f]{4}\.shard$/)
    const narrow = { ...HEMIBRAIN_SHARDING, shard_bits: 3 }
    expect(locate(base, 1158187240n, narrow).url).toMatch(/\/[0-9a-f]\.shard$/)
  })

  it('drops the low preshift bits, so neighbouring ids share a shard', () => {
    // That clustering is the whole point of preshift_bits — 6 bits means 64 consecutive ids
    // land together, which is what makes one Range request serve several neurons.
    const a = locate(base, 1158187240n, HEMIBRAIN_SHARDING)
    const b = locate(base, 1158187240n + 1n, HEMIBRAIN_SHARDING)
    expect(b.shard).toBe(a.shard)
    expect(b.minishard).toBe(a.minishard)
  })

  it('skips hashing entirely for an identity spec', () => {
    const identity: ShardingSpec = {
      '@type': 'neuroglancer_uint64_sharded_v1',
      hash: 'identity',
      preshift_bits: 0,
      minishard_bits: 4,
      shard_bits: 4,
    }
    // 0x123 -> minishard 0x3, shard 0x2.
    expect(locate(base, 0x123n, identity)).toMatchObject({ shard: 2, minishard: 3 })
  })
})

describe('multi-resolution manifest', () => {
  const manifest = parseMultiResManifest(manifestBytes(), manifestFixture.manifestOffset)

  it('reads the grid and the level pyramid', () => {
    expect(manifest.chunkShape).toEqual([1024, 1024, 1024])
    expect(manifest.gridOrigin).toEqual([0, 0, 0])
    expect(manifest.levels.map((l) => l.sizes.length)).toEqual([43, 16, 5, 3])
    expect(manifest.levels.map((l) => l.scale)).toEqual([1, 2, 4, 8])
  })

  it('shows the size range that makes level selection worth doing', () => {
    const bytes = manifest.levels.map((l) => l.totalBytes)
    expect(bytes[0]).toBeGreaterThan(2_000_000)
    expect(bytes[3]).toBeLessThan(12_000)
    expect(bytes[0]! / bytes[3]!).toBeGreaterThan(100)
  })

  it('reads fragment positions as three arrays, NOT interleaved triples', () => {
    /*
     * The bug this pins: positions are stored as every x, then every y, then every z. Read
     * as triples they are still valid coordinates, just wrong ones — and it is invisible at
     * the coarsest level, where hemibrain's `0,0,0,0,0,1,0,1,1` decodes identically either
     * way. At LOD 1 it scattered fragments across the whole volume and doubled the bounding
     * box.
     */
    const lod1 = manifest.levels[1]!
    expect([...lod1.positions.slice(0, 9)]).toEqual([0, 2, 4, 0, 3, 4, 0, 2, 5])
    // Interleaved would have read the first fragment as (0, 0, 0).
    expect([...lod1.positions.slice(0, 3)]).not.toEqual([0, 0, 0])

    // LOD 3 is the level that hides it — identical under both readings.
    expect([...manifest.levels[3]!.positions]).toEqual([0, 0, 0, 0, 0, 1, 0, 1, 1])
  })

  it('locates fragment data immediately before the manifest', () => {
    const total = manifest.levels.reduce((sum, l) => sum + l.totalBytes, 0)
    expect(manifest.dataStart).toBe(manifestFixture.manifestOffset - total)
  })

  it('accumulates fragment offsets across levels', () => {
    expect(fragmentOffset(manifest, 0, 0)).toBe(manifest.dataStart)
    expect(fragmentOffset(manifest, 0, 1)).toBe(
      manifest.dataStart + manifest.levels[0]!.sizes[0]!,
    )
    expect(fragmentOffset(manifest, 1, 0)).toBe(
      manifest.dataStart + manifest.levels[0]!.totalBytes,
    )
  })

  it('tolerates a zero-size fragment, which real data contains', () => {
    // hemibrain's LOD 2 has one.
    expect([...manifest.levels[2]!.sizes]).toContain(0)
  })
})

describe('fragment transform', () => {
  const manifest = parseMultiResManifest(manifestBytes(), manifestFixture.manifestOffset)

  it('reproduces the offsets observed against the live bucket', () => {
    // LOD 3 fragment 0 sits at grid (0,0,0); fragment 2 at (0,1,1).
    expect(fragmentTransform(HEMIBRAIN_INFO, manifest, 3, 0).offset.map(Math.round)).toEqual([
      64, 64, 64,
    ])
    expect(fragmentTransform(HEMIBRAIN_INFO, manifest, 3, 2).offset.map(Math.round)).toEqual([
      64, 131136, 131136,
    ])
  })

  it('includes vertexOffsets — dropping them shifts geometry by tens of nanometres', () => {
    // The 64 above *is* the vertex offset: grid (0,0,0) contributes nothing, and gridOrigin
    // is zero, so a transform that ignored it would return 0.
    const zeroGrid = fragmentTransform(HEMIBRAIN_INFO, manifest, 3, 0).offset
    expect(zeroGrid[0]).not.toBe(0)
  })

  it('scales quantised vertices across exactly one chunk', () => {
    const { scale } = fragmentTransform(HEMIBRAIN_INFO, manifest, 3, 0)
    const maxQuant = 2 ** HEMIBRAIN_INFO.vertex_quantization_bits - 1
    // chunk 1024 * lod scale 8 * transform 16 nm, spread over the quantisation range.
    expect(scale[0] * maxQuant).toBeCloseTo(1024 * 8 * 16, 3)
  })
})

describe('chooseLod', () => {
  const level = (bytes: number) => ({
    lod: 0,
    scale: 1,
    positions: new Uint32Array(),
    sizes: new Uint32Array(),
    totalBytes: bytes,
  })
  const pyramid = (bytes: number[]) => ({
    chunkShape: [1, 1, 1] as [number, number, number],
    gridOrigin: [0, 0, 0] as [number, number, number],
    vertexOffsets: [],
    levels: bytes.map((b, i) => ({ ...level(b), lod: i })),
    dataStart: 0,
  })

  it('takes the finest level that fits the budget', () => {
    // hemibrain's real pyramid, in bytes. Budgets are in triangles, converted at the
    // measured ~1.7 bytes per triangle — so 50k triangles is an ~85 kB allowance, which
    // clears LOD 2 (48 kB) but not LOD 1 (280 kB).
    const m = [pyramid([2_000_000, 280_000, 48_000, 11_000])]
    expect(chooseLod(m, 20_000)).toBe(3)
    expect(chooseLod(m, 50_000)).toBe(2)
    expect(chooseLod(m, 200_000)).toBe(1)
    expect(chooseLod(m, 1_500_000)).toBe(0)
  })

  it('sums across every neuron, so forty of them go coarser than one', () => {
    const one = [pyramid([2_000_000, 280_000, 48_000, 11_000])]
    const forty = Array.from({ length: 40 }, () =>
      pyramid([2_000_000, 280_000, 48_000, 11_000]),
    )
    expect(chooseLod(one, 1_500_000)).toBe(0)
    expect(chooseLod(forty, 1_500_000)).toBeGreaterThan(0)
  })

  it('falls back to the coarsest level rather than refusing when nothing fits', () => {
    expect(chooseLod([pyramid([2_000_000, 280_000])], 1)).toBe(1)
  })
})

describe('legacy fragments', () => {
  /** `uint32` vertex count, xyz float32 triples, then uint32 triangle indices. */
  function build(vertices: number[][], triangles: number[][]): ArrayBuffer {
    const buffer = new ArrayBuffer(4 + vertices.length * 12 + triangles.length * 12)
    const view = new DataView(buffer)
    view.setUint32(0, vertices.length, true)
    vertices.forEach((v, i) =>
      v.forEach((c, axis) => view.setFloat32(4 + i * 12 + axis * 4, c, true)),
    )
    const base = 4 + vertices.length * 12
    triangles.forEach((t, i) =>
      t.forEach((idx, k) => view.setUint32(base + i * 12 + k * 4, idx, true)),
    )
    return buffer
  }

  it('reads vertices and triangles', () => {
    const mesh = parseLegacyFragment(
      build(
        [
          [1, 2, 3],
          [4, 5, 6],
          [7, 8, 9],
        ],
        [[0, 1, 2]],
      ),
    )
    expect([...mesh.positions]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect([...mesh.indices]).toEqual([0, 1, 2])
  })

  it('reads a fragment whose byte offset is not 4-byte aligned', () => {
    // A Range response can land on any alignment, and a typed-array *view* at offset 4 of a
    // misaligned buffer throws — hence the copy in the parser.
    const source = build([[1, 2, 3]], [])
    const padded = new Uint8Array(source.byteLength + 1)
    padded.set(new Uint8Array(source), 1)
    const shifted = padded.buffer.slice(1)
    expect(() => parseLegacyFragment(shifted)).not.toThrow()
  })

  it('refuses a truncated fragment instead of returning half a neuron', () => {
    expect(() => parseLegacyFragment(new ArrayBuffer(2))).toThrow(/too short/)
    const claims = new ArrayBuffer(4 + 12)
    new DataView(claims).setUint32(0, 100, true)
    expect(() => parseLegacyFragment(claims)).toThrow(/claims 100 vertices/)
  })

  it('refuses trailing bytes that are not whole triangles', () => {
    const buffer = new ArrayBuffer(4 + 12 + 8)
    new DataView(buffer).setUint32(0, 1, true)
    expect(() => parseLegacyFragment(buffer)).toThrow(/not a whole number of triangles/)
  })

  it('rebases indices when joining fragments', () => {
    const joined = concatMeshes([
      { positions: new Float32Array([0, 0, 0]), indices: new Uint32Array([0]) },
      { positions: new Float32Array([1, 1, 1]), indices: new Uint32Array([0]) },
    ])
    // The second fragment's vertex 0 is vertex 1 of the joined mesh.
    expect([...joined.indices]).toEqual([0, 1])
    expect([...joined.positions]).toEqual([0, 0, 0, 1, 1, 1])
  })
})

describe('transport', () => {
  const original = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = original
    resetTransport()
  })

  /** A 200 carrying `bytes` bytes — `fetchBytes` reads `arrayBuffer`, never `json`. */
  const ok = (bytes: number) =>
    ({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(bytes)) }) as Response

  /**
   * Stub `fetch` so every URL matching `refuses` fails the way a browser reports a CORS refusal
   * — an opaque `TypeError`, indistinguishable from the network being down — and everything else
   * gets `answer`. Returns the URLs seen, live and in order, which is what the route assertions
   * are actually about.
   *
   * Local rather than in `test/precomputedStubs.ts`: its `serveBytes` is a URL-to-bytes map that
   * 404s everything else, and "refuse this prefix, answer the rest" is a different shape that
   * only this describe wants. Second consumer lifts it.
   */
  function stubFetch(refuses: RegExp, answer: Response): string[] {
    const seen: string[] = []
    globalThis.fetch = ((url: string) => {
      seen.push(url)
      if (refuses.test(url)) return Promise.reject(new TypeError('Failed to fetch'))
      return Promise.resolve(answer)
    }) as typeof fetch
    return seen
  }

  /** `transportModes()` read back from a stubbed `localStorage` holding `stored`. */
  function modesFromStorage(stored: Record<string, string>): Record<string, string> {
    // The node test env has no `window` at all, and the module guards every storage access — so
    // a stub is what makes the persisted half reachable here.
    const store = new Map([[MODE_KEY, JSON.stringify(stored)]])
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
      },
    })
    try {
      return transportModes()
    } finally {
      vi.unstubAllGlobals()
    }
  }

  /** Where `transport.ts` persists its route memory. */
  const MODE_KEY = 'coda.precomputed.transport'

  /** The one bucket with no CORS policy — the reason the JSON API route exists. */
  const MALE_CNS = /^https:\/\/storage\.googleapis\.com\/flyem-male-cns\//

  it('maps a Google Storage URL onto the same-origin proxy prefix', () => {
    expect(proxied('https://storage.googleapis.com/bucket/a/b/info')).toBe(
      '/gcs/bucket/a/b/info',
    )
    expect(proxied('https://example.org/x')).toBeUndefined()
  })

  it('restates a Google Storage URL through the JSON API, encoding the key whole', () => {
    // The key is one path segment on the JSON API, so every slash in it is `%2F`. Getting this
    // wrong asks for an object in a bucket named `storage` and 404s, which reads as a missing
    // mesh rather than as a malformed URL.
    expect(gcsJsonApiUrl('https://storage.googleapis.com/bucket/a/b/info')).toBe(
      'https://storage.googleapis.com/storage/v1/b/bucket/o/a%2Fb%2Finfo?alt=media',
    )
  })

  it('refuses to restate what the JSON API cannot represent', () => {
    // Not Google's.
    expect(gcsJsonApiUrl('https://example.org/bucket/info')).toBeUndefined()
    expect(gcsJsonApiUrl('https://b.s3.amazonaws.com/info')).toBeUndefined()
    // Already a JSON API URL — rewriting twice would ask for an object literally called
    // `storage/v1/b/…`, which is the confidently-wrong-URL failure this whole module avoids.
    expect(
      gcsJsonApiUrl('https://storage.googleapis.com/storage/v1/b/bucket/o/info?alt=media'),
    ).toBeUndefined()
    // The rewrite owns `?alt=media`; merging somebody else's parameters could collide with the
    // API's own, so such a URL keeps the proxy as its only fallback.
    expect(
      gcsJsonApiUrl('https://storage.googleapis.com/bucket/info?generation=1'),
    ).toBeUndefined()
    // A bucket with no key is a listing, not an object.
    expect(gcsJsonApiUrl('https://storage.googleapis.com/bucket')).toBeUndefined()
  })

  it('reads a refusing GCS bucket through the JSON API, without the proxy', async () => {
    /*
     * The measured reason this route exists. `flyem-male-cns` has no CORS policy for anybody —
     * re-probed from six origins including `neuroglancer-demo.appspot.com` — but Google serves
     * the same object under `/storage/v1/b/…?alt=media`, which answers
     * `Access-Control-Allow-Origin` whatever the bucket says. That is exactly how neuroglancer
     * reads it. It matters because `/gcs` is a dev-server path: on a static deploy it is 404
     * HTML, so before this the bucket was unreadable in production.
     */
    const seen = stubFetch(MALE_CNS, ok(16))

    const result = await fetchBytes(
      'https://storage.googleapis.com/flyem-male-cns/v1.0/segmentation/info',
    )
    expect(result.byteLength).toBe(16)
    // The proxy is never reached.
    expect(seen).toEqual([
      'https://storage.googleapis.com/flyem-male-cns/v1.0/segmentation/info',
      'https://storage.googleapis.com/storage/v1/b/flyem-male-cns/o/v1.0%2Fsegmentation%2Finfo?alt=media',
    ])
    expect(transportModes()['storage.googleapis.com/flyem-male-cns']).toBe('gcs-api')
  })

  it('goes straight to the JSON API once that is what answered', async () => {
    const seen = stubFetch(MALE_CNS, ok(4))

    await fetchBytes('https://storage.googleapis.com/flyem-male-cns/a')
    seen.length = 0
    await fetchBytes('https://storage.googleapis.com/flyem-male-cns/b')
    expect(seen).toEqual([
      'https://storage.googleapis.com/storage/v1/b/flyem-male-cns/o/b?alt=media',
    ])
  })

  it('keeps a 404 from the JSON API meaning the object is absent', async () => {
    /*
     * `skeletons.ts` and `readRawInfo` both read `status === 404` as "there is none of this
     * here". A bucket that refuses CORS must not turn that into a different verdict from a
     * CORS-open one — a neuron with no skeleton would become an error instead of a `undefined`.
     */
    stubFetch(MALE_CNS, { ok: false, status: 404 } as Response)

    const error = await fetchBytes(
      'https://storage.googleapis.com/flyem-male-cns/missing',
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PrecomputedFetchError)
    expect((error as PrecomputedFetchError).status).toBe(404)
  })

  it('drops a persisted mode this build does not recognise', () => {
    // A route name from some other build would pin a bucket to something this one cannot take,
    // and the bucket would never re-probe. Same reasoning as the host-keyed entries below.
    expect(modesFromStorage({ 'a.example': 'quic-relay', 'b.example': 'gcs-api' })).toEqual({
      'b.example': 'gcs-api',
    })
  })

  it('falls back to the proxy when every cross-origin route refuses', async () => {
    // A CORS refusal reaches JS as an opaque TypeError, indistinguishable from the network
    // being down — trying is the only way to find out. The proxy is the *third* route: this
    // stub refuses every `https://` URL, so the JSON API is refused along with the direct read.
    const seen = stubFetch(/^https:/, ok(8))

    const result = await fetchBytes('https://storage.googleapis.com/private/info')
    expect(result.byteLength).toBe(8)
    expect(seen).toEqual([
      'https://storage.googleapis.com/private/info',
      'https://storage.googleapis.com/storage/v1/b/private/o/info?alt=media',
      '/gcs/private/info',
    ])
  })

  it('remembers that a host needs the proxy and stops retrying direct', async () => {
    const seen = stubFetch(/^https:/, ok(4))

    await fetchBytes('https://storage.googleapis.com/private/one')
    await fetchBytes('https://storage.googleapis.com/private/two')
    // Four requests, not six: the first read probes all three routes, the second goes straight
    // to the one that answered.
    expect(seen).toHaveLength(4)
    expect(seen[3]).toBe('/gcs/private/two')
  })

  it('keeps the vite.config.ts hint on the failure that needs it', async () => {
    /*
     * The hint rides on the `proxy` entry in `ROUTES` rather than in the message, because it was
     * nearly lost when that message was generalised from "the proxy" to N routes — and it names
     * the likeliest local failure of this whole path. `neuprint/client.ts` carries the same
     * sentence for the same reason.
     */
    // Every route refuses, including the proxy — which is what a static deploy does to `/gcs`.
    stubFetch(/./, ok(4))
    const error = await fetchBytes('https://storage.googleapis.com/private/info').catch(
      (e: unknown) => e,
    )
    const message = (error as Error).message
    expect(message).toContain('pnpm dev')
    // Both routes named, in the order they were tried.
    expect(message).toContain('/storage/v1/b/private/o/info?alt=media')
    expect(message).toContain('/gcs/private/info')
  })

  it('does not let one refusing bucket route another bucket on the same host', async () => {
    /*
     * The measured incident. Every FlyEM bucket is on `storage.googleapis.com`, but CORS is a
     * property of the *bucket*: male-CNS refuses, hemibrain does not. Keyed by host, one
     * male-CNS mesh recorded `storage.googleapis.com → proxy` and persisted it, so from then on
     * every hemibrain read in that browser profile went through the proxy — in later sessions
     * too, for somebody who never opened male-CNS again. On a 300-body fetch that is 3.1 s
     * against 30.5 s, with nothing on screen to attribute it to.
     */
    // Only male-CNS refuses.
    const seen = stubFetch(/^https:\/\/.*flyem-male-cns/, ok(4))

    await fetchBytes('https://storage.googleapis.com/flyem-male-cns/mesh/a')
    expect(transportModes()['storage.googleapis.com/flyem-male-cns']).toBe('proxy')

    seen.length = 0
    await fetchBytes(
      'https://storage.googleapis.com/neuroglancer-janelia-flyem-hemibrain/mesh/b',
    )
    // Direct, first try — not `/gcs/...`.
    expect(seen).toEqual([
      'https://storage.googleapis.com/neuroglancer-janelia-flyem-hemibrain/mesh/b',
    ])
    expect(
      transportModes()['storage.googleapis.com/neuroglancer-janelia-flyem-hemibrain'],
    ).toBe('direct')
  })

  it('drops a mode written by the host-keyed version rather than honouring it', () => {
    // Otherwise every profile that read male-CNS once stays poisoned across the upgrade, which
    // is the whole failure it is being upgraded out of. A bare host key cannot be migrated: it
    // stood for whichever bucket happened to be read first.
    expect(
      modesFromStorage({ 'storage.googleapis.com': 'proxy', 'other.example': 'direct' }),
    ).toEqual({ 'other.example': 'direct' })
  })

  it('does not retry a 404 through the proxy', async () => {
    // The request plainly arrived; a missing object is missing by either route, and retrying
    // would double every lookup for a body that simply has no mesh.
    const seen: string[] = []
    globalThis.fetch = ((url: string) => {
      seen.push(url)
      return Promise.resolve({ ok: false, status: 404 } as Response)
    }) as typeof fetch

    await expect(fetchBytes('https://storage.googleapis.com/bucket/missing')).rejects.toThrow(
      PrecomputedFetchError,
    )
    expect(seen).toHaveLength(1)
  })

  it('sends a byte range when asked for one', async () => {
    let headers: HeadersInit | undefined
    globalThis.fetch = ((_url: string, init: RequestInit) => {
      headers = init.headers
      return Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(2)),
      } as Response)
    }) as typeof fetch
    await fetchBytes('https://storage.googleapis.com/b/o', { range: [10, 19] })
    expect((headers as Record<string, string>)['Range']).toBe('bytes=10-19')
  })
})

describe('mesh fetch progress', () => {
  /** The fraction `meshProgress` reports for one call, so the split can be read directly. */
  function at(done: number, total: number, phase: 'manifests' | 'fragments'): number {
    let fraction = -1
    meshProgress((f) => (fraction = f))(done, total, phase)
    return fraction
  }

  it('gives manifests the first fifth and fragments the rest', () => {
    // A manifest is a few hundred bytes; the fragments behind it are megabytes. An even split
    // would race to 50% in the first second and then look hung.
    expect(at(0, 8, 'manifests')).toBeCloseTo(0.05, 5)
    expect(at(8, 8, 'manifests')).toBeCloseTo(0.2, 5)
    expect(at(0, 8, 'fragments')).toBeCloseTo(0.2, 5)
    expect(at(8, 8, 'fragments')).toBeCloseTo(1, 5)
  })

  it('never decreases, including across the phase boundary', () => {
    // An indicator that runs backwards is worse than none — and it did, until the skeleton
    // path stopped using a dispatch-order ordinal as a completion count.
    const sequence = [
      ...Array.from({ length: 9 }, (_, i) => at(i, 8, 'manifests')),
      ...Array.from({ length: 9 }, (_, i) => at(i, 8, 'fragments')),
    ]
    for (let i = 1; i < sequence.length; i++) {
      expect(sequence[i]!).toBeGreaterThanOrEqual(sequence[i - 1]!)
    }
  })

  it('stays in range for a degenerate total', () => {
    expect(at(0, 0, 'manifests')).toBeCloseTo(0.2, 5)
    expect(at(5, 2, 'fragments')).toBeCloseTo(1, 5)
  })

  it('captions the phase, so the two bars are told apart on the card', () => {
    // The note travelled beside the fraction as a copied template literal before this was one
    // function; a source that got one and not the other is what the pairing prevents.
    const notes: Array<string | undefined> = []
    const report = meshProgress((_f, note) => notes.push(note))
    report(3, 8, 'manifests')
    report(3, 8, 'fragments')
    expect(notes).toEqual(['3/8 manifests', '3/8 meshes'])
  })
})

// ---------------------------------------------------------------------------
// The Draco decoder. This is the piece most worth covering and the hardest to reach: the
// production path fetches the wasm by URL, which Node's fetch will not do for a file. So the
// test serves the binary through a stubbed fetch, which exercises the real
// `createDecoderModule({ wasmBinary })` integration and the real decode loop — only the URL
// resolution is substituted.
// ---------------------------------------------------------------------------

describe('draco decoding', () => {
  let restore: RestoreFetch = () => {}
  afterEach(() => restore())

  async function serveWasmFromDisk() {
    restore = await serveDracoWasmFromDisk()
  }

  it('decodes a real neuroglancer fragment and places it in nanometres', async () => {
    await serveWasmFromDisk()
    const { decodeDracoFragment } = await import('./draco')
    const raw = Buffer.from(fragmentFixture.base64, 'base64')
    const bytes = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)

    const mesh = await decodeDracoFragment(
      bytes,
      fragmentFixture.scale as [number, number, number],
      fragmentFixture.offset as [number, number, number],
    )

    // Counts observed by decoding this exact fragment against the live bucket.
    expect(mesh.positions.length / 3).toBe(fragmentFixture.expect.points)
    expect(mesh.indices.length / 3).toBe(fragmentFixture.expect.faces)

    // Every index has to address a real vertex, or three.js renders nothing and says nothing.
    for (const index of mesh.indices) {
      expect(index).toBeLessThan(mesh.positions.length / 3)
    }

    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < mesh.positions.length; i += 3) {
      for (let c = 0; c < 3; c++) {
        const v = mesh.positions[i + c]!
        if (v < min[c]!) min[c] = v
        if (v > max[c]!) max[c] = v
      }
    }
    // The bounding box this fragment occupies in the hemibrain volume, in nm.
    for (let c = 0; c < 3; c++) {
      expect(min[c]).toBeCloseTo(fragmentFixture.expect.bbox.min[c]!, 0)
      expect(max[c]).toBeCloseTo(fragmentFixture.expect.bbox.max[c]!, 0)
    }
  }, 60_000)

  it('rejects bytes that are not a Draco mesh instead of returning empty geometry', async () => {
    await serveWasmFromDisk()
    const { decodeDracoFragment } = await import('./draco')
    await expect(
      decodeDracoFragment(
        new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer,
        [1, 1, 1],
        [0, 0, 0],
      ),
    ).rejects.toThrow()
  }, 60_000)
})
