/**
 * One spatial index per neuron, whichever kind of geometry it is.
 *
 * The seam `geometryDistance.ts` is written against, and it is thin on purpose: everything about
 * *what* a distance means is in that file, where a test can drive it with a stub, and everything
 * that needs a library is here. `meshInside.ts` and `pointsInMeshes.ts` are the same pair split
 * the same way and for the same reason.
 *
 * **The two kinds are indexed differently, and it is not an implementation detail.** A skeleton
 * is a set of points and a distance to it is a distance to the nearest of them — there is nothing
 * between two nodes, so there is nothing else it could be. A mesh is a *surface*, and the nearest
 * point on it is almost never a vertex: `three-mesh-bvh`'s `closestPointToPoint` walks the
 * triangle tree and lands anywhere on a face. Taking the nearest vertex instead would make every
 * answer depend on how finely the neuron happened to be tessellated, and `Downsample` on the
 * `Meshes` node moves that by two orders of magnitude.
 */

import type { Slicer } from '../../core/slice'
import { sliced } from '../../core/slice'
import type { MeshesValue, SkeletonsValue } from '../../core/values'
import type { DistanceCollection, TargetIndex } from './geometryDistance'
import { buildKdTree } from './kdTree'
import { buildMeshTrees } from './meshTrees'

/**
 * An index per item, in item order.
 *
 * Async because the mesh arm reaches for `three` and `three-mesh-bvh`, and **sliced** because
 * building either structure over a wire of full-resolution neurons is seconds of arithmetic with
 * no way to cancel it. The skeleton arm could be synchronous and deliberately is not: two code
 * paths where one yields and the other does not is how a node comes to freeze on one kind of
 * input only.
 */
export async function buildTargetIndexes(
  value: DistanceCollection,
  hooks: Slicer = {},
): Promise<TargetIndex[]> {
  return value.kind === 'meshes' ? meshIndexes(value, hooks) : skeletonIndexes(value, hooks)
}

async function skeletonIndexes(value: SkeletonsValue, hooks: Slicer): Promise<TargetIndex[]> {
  const built: TargetIndex[] = []
  await sliced(value.items.length, hooks, (i) => {
    built.push(treeFor(value.items[i]!))
  })
  return built
}

/**
 * Held weakly against the skeleton, for `meshTrees.ts`' reason and with the same licence: a
 * decoded skeleton is immutable by convention, so an item that is the same object is the same
 * arbour. What it buys is the second direction — an all-by-all with `Symmetry: mean` asks every
 * neuron both as a query and as a target — and the second Run.
 */
const trees = new WeakMap<object, TargetIndex>()

/**
 * One skeleton's index, memoised on the geometry.
 *
 * Exported for `geometryDistance.test.ts`, which had grown its own copy of these three lines and
 * so tested a `TargetIndex` the node never builds.
 */
export function treeFor(item: { positions: Float32Array; parents: Int32Array }): TargetIndex {
  const held = trees.get(item)
  if (held) return held
  // `parents.length` rather than `positions.length / 3`: the two agree on every skeleton a source
  // produces, and where they do not the tree is the one that must not read past the tree.
  const tree = buildKdTree(item.positions, item.parents.length)
  // The tree *is* the index's two methods, and `points` is what tells a caller two indexes can
  // descend together — see `TargetIndex.points`.
  const built: TargetIndex = { ...tree, points: tree }
  trees.set(item, built)
  return built
}

/**
 * A hair of slack on the pruning bound, because both of `closestPointToPoint`'s comparisons are
 * strict.
 *
 * A subtree is descended only while its box is **strictly** nearer than `maxThreshold`, so a
 * triangle exactly `dist` away sits behind a box that is skipped. On real coordinates that is a
 * measure-zero event; on the axis-aligned synthetic surfaces every test here is built from it is
 * the ordinary case, and the symptom is a `within` that misses the thing it was aimed at. The
 * absolute term is for `Within: 0`, where a relative one is zero and prunes the whole tree.
 */
const BOUND_SLACK = (dist: number): number => dist * (1 + 1e-9) + 1e-6

async function meshIndexes(value: MeshesValue, hooks: Slicer): Promise<TargetIndex[]> {
  const { three, trees: bvhs } = await buildMeshTrees(value.items, hooks)
  const { Vector3 } = three
  /*
   * One point and one hit record for the whole run, reused by every query. `closestPointToPoint`
   * writes into the target it is handed and returns it, so the allocation is per *call* unless
   * one is supplied — and a matrix is tens of millions of calls.
   */
  const probe = new Vector3()
  const hit = { point: new Vector3(), distance: 0, faceIndex: 0 }

  /*
   * **A mesh index answers no `closestTo`, and that is a measurement rather than an omission.**
   * `three-mesh-bvh` has `closestPointToGeometry`, which is the surface-to-surface counterpart of
   * `closestPair` and would be both faster and *better* — neither side sampled. It was written,
   * and it is **163 ms a pair** where the ordinary per-point walk is 0.2 ms, with or without a
   * `boundsTree` on the geometry it is handed. Three orders of magnitude the wrong way, so the
   * walk stands and a mesh pair falls back to it.
   */
  /*
   * **These wrappers are deliberately not memoised, where the skeleton arm's are**, and it costs
   * nothing: the expensive half is the `MeshBVH`, which `meshTrees.ts` caches against the mesh,
   * so a second Run rebuilds two closures and re-uses every tree.
   *
   * It is *not* to avoid a leak, which is what this comment claimed for a round. V8
   * context-allocates only what an inner function reads, and these two read `probe`, `hit` and
   * their own `bvh` — `value` and `bvhs` are touched in the outer body alone, so nothing holds
   * the `MeshesValue`. Worth saying because the reverse mistake is the expensive one: a closure
   * that *did* read the enclosing array would pin every other mesh's tree, which is the failure
   * `kdTree.ts`' `Build` record records.
   */
  return bvhs.map((bvh): TargetIndex => ({
    /*
     * **`maxThreshold` prunes but does not bound.** It skips subtrees whose *box* is past the
     * threshold, so anything it returns from a box that was near enough may still be further
     * than the threshold — a hit is not the same as a hit within `maxDist`. Everything in a
     * skipped subtree is past the threshold too, so a returned distance under it is the true
     * nearest and a returned distance over it is an upper bound on nothing useful. Hence the
     * comparison rather than a null check, which is the shape this was written as first.
     */
    nearest(x, y, z, maxDist = Infinity) {
      probe.set(x, y, z)
      const bound = maxDist === Infinity ? Infinity : BOUND_SLACK(maxDist)
      const found = bvh.closestPointToPoint(probe, hit, 0, bound)
      return found && found.distance <= maxDist ? found.distance : Infinity
    },
    /*
     * `minThreshold` equal to `maxThreshold` is the library's own documented way of asking this:
     * the walk returns the moment it meets a triangle inside the threshold rather than going on
     * to find the nearest one. On a pair that genuinely overlaps, that early exit is most of what
     * makes `Cable within a distance` affordable.
     */
    hasWithin(x, y, z, dist) {
      probe.set(x, y, z)
      const bound = BOUND_SLACK(dist)
      const found = bvh.closestPointToPoint(probe, hit, bound, bound)
      return !!found && found.distance <= dist
    },
  }))
}
