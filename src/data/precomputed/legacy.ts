/**
 * `neuroglancer_legacy_mesh` — one flat mesh per segment, no levels of detail.
 *
 * The shape is a JSON manifest at `<id>:0` naming fragment files, and each fragment is
 * little-endian: a `uint32` vertex count, then that many xyz `float32` triples, then
 * `uint32` triangle indices to the end of the file. DVID's `segmentation_meshes` keyvalue
 * serves the same bytes without the manifest step, which is why the fragment parser is
 * exposed separately.
 *
 * There is no detail control here, and the meshes are big: one male-CNS neuron is 3.6 MB,
 * 107k vertices, 195k triangles. Callers have to cap the neuron count instead.
 */

import type { FetchOptions } from './transport'
import { fetchBytes, fetchJson } from './transport'

export interface LegacyManifest {
  fragments: string[]
}

export interface RawMesh {
  positions: Float32Array
  indices: Uint32Array
}

/**
 * Parse one fragment.
 *
 * The trailing index block is whatever is left after the vertices, so a truncated file shows
 * up as a non-multiple-of-three index count rather than as silently missing geometry.
 */
export function parseLegacyFragment(buffer: ArrayBuffer): RawMesh {
  if (buffer.byteLength < 4)
    throw new Error('Mesh fragment is too short to hold a vertex count')
  const view = new DataView(buffer)
  const vertexCount = view.getUint32(0, true)
  const vertexBytes = vertexCount * 12
  if (4 + vertexBytes > buffer.byteLength) {
    throw new Error(
      `Mesh fragment claims ${vertexCount} vertices but holds only ${buffer.byteLength - 4} bytes`,
    )
  }
  const indexBytes = buffer.byteLength - 4 - vertexBytes
  if (indexBytes % 12 !== 0) {
    throw new Error(
      `Mesh fragment has ${indexBytes} trailing bytes, not a whole number of triangles`,
    )
  }

  // Copy rather than view: the byte offset (4) is not 4-byte aligned for every buffer a
  // Range request may hand back, and a misaligned typed-array view throws.
  const positions = new Float32Array(vertexCount * 3)
  for (let i = 0; i < vertexCount * 3; i++) positions[i] = view.getFloat32(4 + i * 4, true)
  const indices = new Uint32Array(indexBytes / 4)
  for (let i = 0; i < indices.length; i++) {
    indices[i] = view.getUint32(4 + vertexBytes + i * 4, true)
  }
  return { positions, indices }
}

/** Read every fragment of a segment and concatenate them into one mesh. */
export async function readLegacyMesh(
  base: string,
  neuronId: bigint,
  options: FetchOptions = {},
): Promise<RawMesh | undefined> {
  let manifest: LegacyManifest
  try {
    manifest = await fetchJson<LegacyManifest>(`${base}/${neuronId}:0`, options)
  } catch {
    // A missing manifest means no mesh for this body, which is normal for fragments and
    // unproofread segments — not an error worth failing the whole request over.
    return undefined
  }
  const fragments = manifest.fragments ?? []
  if (fragments.length === 0) return undefined

  const parts: RawMesh[] = []
  for (const name of fragments) {
    const bytes = await fetchBytes(`${base}/${name}`, options)
    parts.push(parseLegacyFragment(bytes))
  }
  return concatMeshes(parts)
}

/** Join meshes into one, shifting each part's indices past the vertices already emitted. */
export function concatMeshes(parts: readonly RawMesh[]): RawMesh {
  if (parts.length === 1) return parts[0]!
  const vertexTotal = parts.reduce((sum, p) => sum + p.positions.length, 0)
  const indexTotal = parts.reduce((sum, p) => sum + p.indices.length, 0)
  const positions = new Float32Array(vertexTotal)
  const indices = new Uint32Array(indexTotal)

  let vertexAt = 0
  let indexAt = 0
  for (const part of parts) {
    positions.set(part.positions, vertexAt)
    const base = vertexAt / 3
    for (let i = 0; i < part.indices.length; i++) indices[indexAt + i] = part.indices[i]! + base
    vertexAt += part.positions.length
    indexAt += part.indices.length
  }
  return { positions, indices }
}
