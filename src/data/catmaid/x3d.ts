/**
 * The one wire format CATMAID answers that is not JSON: a volume's mesh, as X3D.
 *
 * ```
 * <IndexedTriangleSet index='0 1 2 …'><Coordinate point='538898.3 190870.0 45073.3 …'/></IndexedTriangleSet>
 * ```
 *
 * Parsed by hand rather than through `DOMParser`, for the reason `src/data` may not import
 * `src/ui`: this layer is meant to stay usable by a non-browser consumer, and a DOM is the
 * largest thing it could accidentally require. It is also faster — the whole document is two
 * whitespace-separated number lists, and walking them directly avoids building an element tree
 * to read two attributes off it.
 *
 * Coordinates are **project-space nanometres**, the same frame as skeletons. Nothing is scaled
 * here; see `POINTS_ARE_NM` in `api.ts` for the cross-check that established it.
 */

/** A parsed `IndexedTriangleSet`: xyz-interleaved positions and triangle indices. */
export interface X3dMesh {
  positions: Float32Array
  indices: Uint32Array
}

/**
 * Read the numbers out of one single-quoted attribute.
 *
 * Single quotes because that is what CATMAID emits; double quotes are accepted too so a
 * hand-written or re-serialised volume still parses. The attribute is found by name rather than
 * by position, since `index` and `point` sit on different elements.
 */
function attribute(source: string, name: string): string | undefined {
  const match = new RegExp(`${name}\\s*=\\s*(['"])([\\s\\S]*?)\\1`).exec(source)
  return match?.[2]
}

/**
 * Parse into a typed array of known length, refusing a ragged list rather than truncating.
 *
 * A count that is not a multiple of three means the document is not what it claims, and the
 * quiet failure — dropping the remainder — is a mesh with a missing corner that renders fine.
 */
function numbers(text: string): number[] {
  const out: number[] = []
  // A manual scan rather than `split(/\s+/).map(Number)`: a large neuropil carries ~7,200
  // coordinates and the split allocates a string per number before any of them are used.
  let index = 0
  const length = text.length
  while (index < length) {
    while (index < length && text.charCodeAt(index) <= 32) index += 1
    if (index >= length) break
    const start = index
    while (index < length && text.charCodeAt(index) > 32) index += 1
    const value = Number(text.slice(start, index))
    if (!Number.isFinite(value)) {
      throw new Error(`X3D mesh carries a non-numeric value "${text.slice(start, index)}"`)
    }
    out.push(value)
  }
  return out
}

export function parseX3dMesh(source: string): X3dMesh {
  const indexText = attribute(source, 'index')
  const pointText = attribute(source, 'point')
  if (indexText === undefined || pointText === undefined) {
    throw new Error(
      'CATMAID volume is not an IndexedTriangleSet — no index or point attribute found',
    )
  }

  const rawIndices = numbers(indexText)
  const rawPoints = numbers(pointText)
  if (rawPoints.length % 3 !== 0) {
    throw new Error(
      `X3D mesh has ${rawPoints.length} coordinates, which is not whole xyz triples`,
    )
  }
  if (rawIndices.length % 3 !== 0) {
    throw new Error(`X3D mesh has ${rawIndices.length} indices, which is not whole triangles`)
  }

  const vertexCount = rawPoints.length / 3
  const indices = new Uint32Array(rawIndices.length)
  for (let i = 0; i < rawIndices.length; i += 1) {
    const value = rawIndices[i] as number
    // An out-of-range index is how a mesh comes to render as one enormous spike through the
    // scene, so it is refused here rather than passed to a renderer that will not check.
    if (!Number.isInteger(value) || value < 0 || value >= vertexCount) {
      throw new Error(`X3D mesh index ${value} is outside its ${vertexCount} vertices`)
    }
    indices[i] = value
  }

  return { positions: Float32Array.from(rawPoints), indices }
}
