/**
 * Draco decoding, lazily loaded.
 *
 * The decoder is ~300 kB of WebAssembly, so it must never sit in the main chunk — it is
 * dynamically imported the first time a multi-resolution mesh is actually read, and the
 * module instance is kept for the rest of the session because instantiating WASM is not
 * free.
 *
 * Neuroglancer's fragments decode with the stock decoder: they are ordinary triangular
 * meshes whose POSITION attribute is `DT_UINT32`, quantised into the fragment's chunk.
 * Confirmed against a real hemibrain fragment — 18 points, 8 faces, values inside
 * `0..65535` for 16-bit quantisation. There is no need for a patched build.
 */

export interface DecodedMesh {
  /** Physical coordinates, xyz interleaved. */
  positions: Float32Array
  indices: Uint32Array
}

/* eslint-disable @typescript-eslint/no-explicit-any -- draco3d ships no type declarations. */
type DracoModule = any

/*
 * `draco_decoder_nodejs.js` is misleadingly named: it is a *universal* Emscripten build that
 * branches on `typeof window`, and its `require("fs")` sits inside a Node-only guard that
 * never runs in a browser. What it would otherwise do in a browser is guess where its `.wasm`
 * lives relative to the script — which is wrong once the bundler has hashed and moved
 * everything. Importing the binary with `?url` and handing it over as `wasmBinary` removes
 * that guess entirely, and makes vite emit the wasm as a tracked asset.
 */
import wasmUrl from 'draco3d/draco_decoder.wasm?url'

let modulePromise: Promise<DracoModule> | undefined

async function decoderModule(): Promise<DracoModule> {
  modulePromise ??= (async () => {
    // Dynamic, so the ~58 kB of Emscripten glue stays out of the main chunk: most graphs
    // never touch a mesh. The `?url` import above is only a string, so it costs nothing.
    const [{ default: createDecoderModule }, wasmBinary] = await Promise.all([
      import('draco3d/draco_decoder_nodejs.js'),
      fetch(wasmUrl).then((response) => response.arrayBuffer()),
    ])
    return createDecoderModule({ wasmBinary })
  })()
  return modulePromise
}

/**
 * Decode one fragment, applying the per-axis scale and offset that map its quantised
 * integer vertices into physical space.
 *
 * The transform is folded in here rather than in a second pass so the integer coordinates
 * are touched exactly once — a full-resolution neuron is on the order of a million vertices.
 */
export async function decodeDracoFragment(
  bytes: ArrayBuffer,
  scale: readonly [number, number, number],
  offset: readonly [number, number, number],
): Promise<DecodedMesh> {
  const draco = await decoderModule()
  const decoder = new draco.Decoder()
  const buffer = new draco.DecoderBuffer()
  try {
    buffer.Init(new Int8Array(bytes), bytes.byteLength)
    if (decoder.GetEncodedGeometryType(buffer) !== draco.TRIANGULAR_MESH) {
      throw new Error('Draco fragment is not a triangular mesh')
    }
    const mesh = new draco.Mesh()
    try {
      const status = decoder.DecodeBufferToMesh(buffer, mesh)
      if (!status.ok()) throw new Error(`Draco decode failed: ${status.error_msg()}`)

      const pointCount = mesh.num_points()
      const faceCount = mesh.num_faces()
      const attribute = decoder.GetAttribute(mesh, decoder.GetAttributeId(mesh, draco.POSITION))

      const quantised = new draco.DracoInt32Array()
      const positions = new Float32Array(pointCount * 3)
      try {
        decoder.GetAttributeInt32ForAllPoints(mesh, attribute, quantised)
        for (let i = 0; i < pointCount; i++) {
          positions[i * 3] = quantised.GetValue(i * 3) * scale[0] + offset[0]
          positions[i * 3 + 1] = quantised.GetValue(i * 3 + 1) * scale[1] + offset[1]
          positions[i * 3 + 2] = quantised.GetValue(i * 3 + 2) * scale[2] + offset[2]
        }
      } finally {
        draco.destroy(quantised)
      }

      const faces = new draco.DracoInt32Array()
      const indices = new Uint32Array(faceCount * 3)
      try {
        for (let f = 0; f < faceCount; f++) {
          decoder.GetFaceFromMesh(mesh, f, faces)
          indices[f * 3] = faces.GetValue(0)
          indices[f * 3 + 1] = faces.GetValue(1)
          indices[f * 3 + 2] = faces.GetValue(2)
        }
      } finally {
        draco.destroy(faces)
      }

      return { positions, indices }
    } finally {
      draco.destroy(mesh)
    }
  } finally {
    draco.destroy(buffer)
    draco.destroy(decoder)
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
