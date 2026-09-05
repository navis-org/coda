/**
 * Stubs and fixtures for the precomputed readers, shared rather than copied.
 *
 * Both of these were written out in three files before they lived here, which is the usual cost:
 * each copy encodes a detail about the code under test — that `fetchJson` goes through
 * `fetchBytes` and so needs `arrayBuffer` rather than `json`, that a multi-resolution `info`
 * without a sharding block describes something no fetch can read — and three copies means three
 * chances for one of them to stop being true without a test noticing.
 *
 * Here rather than in `src/test/setup.ts`, which is deliberately only for *resetting* module
 * state. These are opt-in helpers a test asks for.
 */

/** Restores whatever `globalThis.fetch` was before a stub replaced it. */
export type RestoreFetch = () => void

/**
 * Serve a fixed set of URLs as JSON; anything else 404s, as a real bucket would.
 *
 * `arrayBuffer` rather than `json`, because `fetchJson` is built on `fetchBytes` — a stub that
 * answered `json()` would pass against a mock and fail against the code.
 *
 * The returned `urls` is live: it accumulates every URL asked for, which is how a test asserts
 * that a memo saved a request rather than merely returned the right value.
 */
export function serveJson(docs: Readonly<Record<string, unknown>>): {
  urls: string[]
  restore: RestoreFetch
} {
  const previous = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = ((url: string) => {
    urls.push(String(url))
    const body = docs[String(url)]
    if (body === undefined) return Promise.resolve({ ok: false, status: 404 } as Response)
    /*
     * A number is a status rather than a document, and it exists because 404 stopped being the
     * only interesting failure: `openMeshDir` forgives exactly a missing `info` and nothing else,
     * so a test about a *transient* blip has to be able to serve one — served as an unregistered
     * URL it would be testing the forgiven case instead.
     */
    if (typeof body === 'number')
      return Promise.resolve({ ok: false, status: body } as Response)
    const bytes = new TextEncoder().encode(JSON.stringify(body))
    return Promise.resolve({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(bytes.buffer.slice(0) as ArrayBuffer),
    } as Response)
  }) as typeof fetch
  return { urls, restore: () => void (globalThis.fetch = previous) }
}

/**
 * A sharded multi-resolution mesh `info`, as every real one is.
 *
 * The sharding block is not decoration. Both layouts are read now — hemibrain's region shells are
 * unsharded — but they take different paths (`readManifest` branches on it), and sharded is the
 * one every *neuron* source in reach uses. A fixture without it silently exercises the other
 * branch.
 */
export const DRACO_INFO: Readonly<Record<string, unknown>> = {
  '@type': 'neuroglancer_multilod_draco',
  vertex_quantization_bits: 10,
  transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
  lod_scale_multiplier: 1,
  sharding: {
    '@type': 'neuroglancer_uint64_sharded_v1',
    preshift_bits: 9,
    hash: 'murmurhash3_x86_128',
    minishard_bits: 7,
    shard_bits: 9,
    minishard_index_encoding: 'gzip',
    data_encoding: 'gzip',
  },
}

/**
 * Serve the Draco decoder's wasm off disk, passing every other request through.
 *
 * `draco.ts` imports the binary with `?url`, which resolves to a path only a browser can fetch —
 * so under Node the mesh path dies before it decodes anything. Every test that decodes a real
 * fragment needs this, and the live suites need the passthrough as well, since the whole point
 * of those files is that the other requests are real.
 */
export async function serveDracoWasmFromDisk(): Promise<RestoreFetch> {
  const previous = globalThis.fetch
  const { readFile } = await import('node:fs/promises')
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('draco_decoder.wasm')) {
      const bytes = await readFile(require.resolve('draco3d/draco_decoder.wasm'))
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      } as Response
    }
    return previous(input, init)
  }) as typeof fetch
  return () => void (globalThis.fetch = previous)
}

/**
 * A `neuroglancer_multiscale_volume` `info`, with only the subdirectories a case cares about.
 *
 * Written out eighteen times across the two suites before it lived here, which is eighteen
 * chances for one of them to spell `segment_properties` the way the reader does not.
 */
export function volumeInfo(
  parts: {
    type?: 'segmentation' | 'image'
    mesh?: string
    skeletons?: string
    segmentProperties?: string
    /**
     * Publish it the way the older buckets do: `type` and `scales` and no `@type` at all.
     *
     * `gs://flywire_v141_m630` and `m783` are both this shape, and reading one as a legacy mesh
     * directory is what hid two multi-resolution mesh sets and a skeleton set. See
     * `isVolumeInfo`.
     */
    typeless?: boolean
  } = {},
): Readonly<Record<string, unknown>> {
  return {
    ...(parts.typeless
      ? { scales: [{ key: '16_16_40' }] }
      : { '@type': 'neuroglancer_multiscale_volume' }),
    type: parts.type ?? 'segmentation',
    ...(parts.mesh ? { mesh: parts.mesh } : {}),
    ...(parts.skeletons ? { skeletons: parts.skeletons } : {}),
    ...(parts.segmentProperties ? { segment_properties: parts.segmentProperties } : {}),
  }
}

/**
 * `serveJson`'s twin for readers that take raw bytes rather than JSON.
 *
 * Beside it rather than in the skeleton suite, because the two differ only in whether the body is
 * encoded — and a fixture that drifts from `fetchBytes`' expectations is a stub that passes
 * against nothing.
 */
export function serveBytes(objects: Readonly<Record<string, ArrayBuffer>>): {
  urls: string[]
  restore: RestoreFetch
} {
  const previous = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = ((url: string) => {
    urls.push(String(url))
    const body = objects[String(url)]
    if (!body) return Promise.resolve({ ok: false, status: 404 } as Response)
    return Promise.resolve({
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(body),
    } as Response)
  }) as typeof fetch
  return { urls, restore: () => void (globalThis.fetch = previous) }
}
