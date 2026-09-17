/**
 * A mesh as two typed arrays, and joining several of them into one.
 *
 * A leaf, for the reason `parsedMesh.ts` gives for being one: it is what `precomputed/legacy.ts`,
 * `precomputed/draco.ts` and `meshDecimate.ts` all need, and declaring it in any of them makes the
 * other two import a module they have no other business with.
 *
 * `concatMeshes` used to live in `precomputed/legacy.ts`, which is a
 * `neuroglancer_legacy_mesh` *parser* that fetches over the network. Four of its five importers
 * were not that format — graphene's Draco fragments, multi-resolution Draco, the decimator's
 * tests and its probe — and the misplacement had started to cost something real: `decimateParts`
 * could not join its own fallback without pulling a network module into a pure-arithmetic one, so
 * it returned `undefined` and made every caller write the join out instead. Twenty lines of
 * typed-array arithmetic knows nothing about either format.
 */

/**
 * The shape every mesh reader in `src/data` hands back.
 *
 * One name, because there were four — `RawMesh` for the legacy parser, `DecodedMesh` for Draco,
 * `X3dMesh` for CATMAID's, `DecimatedMesh` for the clustering — structurally identical, plus two
 * anonymous spellings in `precomputed/index.ts`. The cost of the missing shared name was visible
 * in the signature that prompted this: `decimateParts` took `readonly DecimatedMesh[]` as its
 * *input*, which reads backwards, the parts being the least decimated thing in the system.
 *
 * `ParsedMesh` **extends** it rather than restating it, being this plus two counters; the stop is
 * at the `src/data` edge. `core/values.ts`' `MeshGeometry` is this plus an `id` and deliberately
 * does not extend — its fields are `readonly`, so inheriting would silently widen them, and a
 * domain value inheriting from a plumbing type is a dependency the wrong way round. Same for
 * `MeshResult`, `StoredMesh` and `CoarseGeometry`'s mesh arm, each of which adds an identity or a
 * provenance and so means something other than "two arrays somebody is still assembling".
 *
 * Deliberately **not** `core/values.ts`' `MeshGeometry`, which carries an `id`: that is a mesh
 * somebody can name, where this is a mesh somebody is still assembling.
 */
export interface MeshArrays {
  /** xyz interleaved. */
  positions: Float32Array
  /** Triangle indices into `positions`. */
  indices: Uint32Array
}

/**
 * Join meshes into one, shifting each part's indices past the vertices already emitted.
 *
 * Returns a single part **by identity**, which several callers rely on to avoid a copy.
 */
export function concatMeshes(parts: readonly MeshArrays[]): MeshArrays {
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
