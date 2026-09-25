/**
 * An undirected point graph as the rooted tree `SkeletonGeometry` requires.
 *
 * Two backends need this and they arrive at it from opposite directions. CAVE builds a skeleton
 * from its level-2 chunk graph, whose edges are chunk-id pairs; a neuroglancer precomputed
 * skeleton file carries vertex-index pairs directly. What is the same — and what is worth having
 * once — is the walk, because `parents` is a far stricter thing than an edge list and every rule
 * below is a wrong picture if lost.
 *
 * It lived inside `cave/l2.ts` until the second caller appeared. The reason to move it rather
 * than copy it is the second rule: a cycle surviving into `parents` makes every consumer that
 * walks to a root loop forever, and that is not a bug anyone wants two chances at.
 *
 * Three rules, and the walk is the shortest thing that satisfies all three:
 *
 *  1. **A spanning forest, breadth-first.** Both inputs are undirected and both can hold cycles,
 *     where a skeleton is a tree.
 *  2. **Each component gets its own root**, so a neuron split by a proofreading edit — or a
 *     skeleton whose file holds two disconnected arbours — is two trees rather than one with a
 *     fabricated join through the middle of the brain.
 *  3. **Points come out in visit order, so a parent always precedes its child.** That is the
 *     contract `SkeletonGeometry.parents` states and that `neuprint/decode.ts` does real work to
 *     honour. Emitting in input order instead would satisfy the type and break every consumer
 *     written to walk the array once — the SWC writer included.
 */

/** One point of the graph, in whatever units the caller is working in. */
export interface TreePoint {
  /** xyz. Read by index, so a plain array or a tuple both do. */
  at: readonly number[]
  radius: number
}

export interface SkeletonTree {
  /** xyz interleaved, in visit order. */
  positions: Float32Array
  radii: Float32Array
  /** Parent index per point; -1 for a root. */
  parents: Int32Array
  /** Present when the caller's labels label anything, reordered with everything else. */
  compartments?: Uint8Array
}

/**
 * A stored compartment value as an SWC structure code; anything that is not one reads as 0,
 * unlabelled. The one rule for every reader, applied where the byte is written — a `Uint8Array`
 * would otherwise wrap an out-of-range value without a word.
 */
export function compartmentCode(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0
  const code = Math.round(value)
  return code >= 0 && code <= 255 ? code : 0
}

/**
 * The codes, or undefined where none labels anything: a source whose every code is 0 publishes
 * no labels, and an array of zeros would tell a viewer there is something to colour by.
 */
export function labelledOrNone(codes: Uint8Array): Uint8Array | undefined {
  return codes.some((code) => code > 0) ? codes : undefined
}

/**
 * Walk `points` through `edges` and emit the forest.
 *
 * `edges` are **indices into `points`**, already resolved: a caller whose edges name something
 * else (CAVE's chunk ids) maps them first, because dropping an edge that names a point it has no
 * coordinate for is that caller's decision to explain, not this one's. Out-of-range indices are
 * skipped rather than throwing — a file is somebody else's bytes, and one bad edge is not a
 * reason to lose an entire neuron.
 */
export function spanningForest(
  points: readonly TreePoint[],
  edges: Iterable<readonly [number, number]>,
  /** One compartment value per point, in `points` order, where the source publishes them. */
  labels?: ArrayLike<number>,
): SkeletonTree {
  const neighbours: number[][] = points.map(() => [])
  for (const [from, to] of edges) {
    if (from < 0 || to < 0 || from >= points.length || to >= points.length) continue
    if (from === to) continue
    neighbours[from]!.push(to)
    neighbours[to]!.push(from)
  }

  // Visit order, and the slot each point takes in the emitted arrays. BFS reaches a parent
  // before its children, so slots increase down every branch — rule 3.
  const visited: number[] = []
  const slot = new Int32Array(points.length).fill(-1)
  const parents = new Int32Array(points.length).fill(-1)
  for (let start = 0; start < points.length; start++) {
    if (slot[start] !== -1) continue
    slot[start] = visited.length
    visited.push(start)
    for (let head = visited.length - 1; head < visited.length; head++) {
      const node = visited[head]!
      for (const next of neighbours[node]!) {
        if (slot[next] !== -1) continue
        slot[next] = visited.length
        visited.push(next)
        parents[slot[next]!] = slot[node]!
      }
    }
  }

  const positions = new Float32Array(points.length * 3)
  const radii = new Float32Array(points.length)
  // Labels follow the points into visit order, or they would describe the wrong ones.
  const compartments = labels ? new Uint8Array(points.length) : undefined
  for (let i = 0; i < visited.length; i++) {
    const point = points[visited[i]!]!
    positions[i * 3] = point.at[0]!
    positions[i * 3 + 1] = point.at[1]!
    positions[i * 3 + 2] = point.at[2]!
    radii[i] = point.radius
    if (compartments) compartments[i] = compartmentCode(labels![visited[i]!])
  }
  const labelled = compartments && labelledOrNone(compartments)
  return { positions, radii, parents, ...(labelled ? { compartments: labelled } : {}) }
}
