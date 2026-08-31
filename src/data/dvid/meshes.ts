/**
 * DVID meshes: one `.ngmesh` per body, in a keyvalue instance.
 *
 * ## The format is one Coda already reads
 *
 * `.ngmesh` **is** `neuroglancer_legacy_mesh`'s fragment — little-endian `uint32` vertex count,
 * that many xyz `float32` triples, then `uint32` indices to the end — which is why
 * `parseLegacyFragment` is exported separately from `legacy.ts` and why nothing new decodes
 * anything here. Verified against `flyem.dvid.io`: mushroombody body 100003022 is 106,360 bytes,
 * 2,966 vertices, 5,897 triangles, index block a whole number of triangles.
 *
 * What DVID drops is the manifest. A precomputed legacy body is a JSON `<id>:0` naming fragment
 * files; a DVID body is one key, `<id>.ngmesh`, and no assembly. So the read is a single request
 * where the precomputed one is two or more.
 *
 * ## Vertices are in nanometres — unlike the skeletons
 *
 * So this file scales nothing and `skeletons.ts` scales everything, and neither is free to assume
 * the other's rule. Measured on the same body in the same repo; `docs/backends.md` has the
 * numbers.
 *
 * ## These meshes are enormous, and there is no coarser one
 *
 * `AL-VA1v` body 1010 is **107 MB and 2,997,171 vertices** — thirty times the 3.6 MB `legacy.ts`
 * records for a male-CNS neuron, and DVID publishes no levels of detail, so there is nothing to
 * ask for instead. Two consequences, both load-bearing:
 *
 *  - **Thumbnails only because the download can be bounded.** `fetchCoarseMesh` takes this
 *    format under `THUMBNAIL_MAX_BYTES`, which on every other source is a manifest lookup and
 *    here is a streaming cut-off. Measured on mushroombody, 40 random bodies: median 16 kB, p90
 *    92 kB, max 487 kB — a page of 25 costs about 0.4 MB, cheaper than hemibrain's coarsest
 *    precomputed level. A repo whose bodies are the 107 MB kind draws placeholders instead, at
 *    2 MB apiece rather than 107.
 *  - **A scene needs a ceiling, and it has to be a streaming one.** `fetchMeshes`'
 *    `maxBytesPerBody` refuses from a manifest for free elsewhere; here there is no manifest and
 *    no other way to ask, so the transfer is abandoned mid-flight. See `readNgMesh`.
 */

import { parseLegacyFragment } from '../precomputed/legacy'
import type { MeshBodyReader, MeshSource } from '../precomputed/index'
import type { DvidOptions } from './client'
import { readKey, requireInstance } from './client'
import type { DvidRef } from './refs'
import { meshInstance } from './refs'

/**
 * Open a DVID segmentation's mesh store, or refuse saying which half is missing.
 *
 * The probe is one narrow `info` on the mesh instance rather than a repo listing — see
 * `refs.ts`. `base` is that instance's URL, which is all `readNgMesh` needs, so a `MeshSource`
 * travelling through the precomputed machinery carries no DVID type with it.
 */
export async function openDvidMeshSource(
  ref: DvidRef,
  options: DvidOptions = {},
): Promise<MeshSource> {
  const base = await requireInstance(ref, meshInstance(ref), 'meshes', options)
  return { base, format: 'dvid-ngmesh', levels: 1, readBody: readNgMesh }
}

/**
 * One body's mesh, or undefined when it has none or is over `maxBytes`.
 *
 * Both absences are ordinary and neither fails a scene: a body may be a fragment nobody meshed,
 * and a body may be the 107 MB one. They are reported the same way — as `missing` — because from
 * the caller's side they are the same fact, that this neuron is not in the result.
 *
 * **The ceiling bounds the download, not the decode**, and it has to. DVID publishes no manifest,
 * answers `HEAD` with no `Content-Length` and ignores `Range` — all measured — so a body's size
 * is unknowable until the bytes arrive, and a check after `arrayBuffer()` would have spent them
 * already. `FetchOptions.maxBytes` stops reading instead and reports 413, which `readKey` folds
 * into the same "not available" as a 404. Without that, one 107 MB body would be downloaded in
 * full only to be discarded.
 */
export const readNgMesh: MeshBodyReader = async (source, neuronId, options = {}) => {
  // `.ngmesh` is neuroglancer's own spelling for this key.
  const bytes = await readKey(source.base, `${neuronId}.ngmesh`, options)
  return bytes ? parseLegacyFragment(bytes) : undefined
}
