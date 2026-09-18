/**
 * One triangle tree per mesh, built once and shared by everything that asks a spatial question
 * of a surface.
 *
 * Extracted from `meshInside.ts` when `Distance between` became the second caller, and the *cache* is
 * why it had to move rather than be copied. A `MeshesValue` wired to both `Points in Volumes`
 * and `Distance between` — asking which synapses are inside a neuron and how far another neuron runs
 * from it — is one set of surfaces, and two `WeakMap`s keyed on the same items would build every
 * tree twice, at the better part of a second for a dataset's primary set, with nothing on screen
 * to say the work had already been done once.
 *
 * Everything below is `meshInside.ts`' — the arguments are its and are kept here rather than
 * restated there.
 *
 * ## Why the library is dynamically imported
 *
 * `three` and `three-mesh-bvh` are in the tree *for the UI*. A static import from a node module
 * would put three in `nodes.html`'s bundle, which is a static page with no React and no renderer
 * in it. **The MCP bundle needs a second move**: `vite.mcp.config.ts` sets
 * `inlineDynamicImports: true`, so a dynamic import in the node pack is inlined into the one
 * file the MCP server downloads — measured at 2,482 kB → 4,345 kB before `three` was made
 * external there.
 *
 * ## `indirect: true`
 *
 * `MeshBVH` builds by **reordering the geometry's index array in place**, and the array handed
 * to it is `MeshGeometry.indices` — the `Uint32Array` that belongs to the value on the wire,
 * which the 3D viewer and the OBJ export hold too. A reordered index draws the identical
 * surface, which is exactly why it would go unnoticed.
 */

import type * as THREE from 'three'
import type { MeshBVH, MeshBVHOptions } from 'three-mesh-bvh'
import type { Slicer } from '../../core/slice'
import { sliced } from '../../core/slice'
import type { MeshGeometry } from '../../core/values'

/**
 * The trees, held weakly against the mesh items they describe.
 *
 * Keyed on `MeshGeometry` identity, which is sound for `groupIndexes`' reason in `iterables.ts`:
 * geometry buffers are immutable by convention — every node builds new arrays rather than
 * writing into one — so an item that is the same object is the same surface.
 *
 * `unknown` rather than `MeshBVH` because the type comes from a module this one only imports
 * dynamically; the cast is confined to `buildMeshTrees`.
 */
const trees = new WeakMap<MeshGeometry, unknown>()

/**
 * The build options, typed wider than the package declares them.
 *
 * `meshPicking.ts`' workaround at a third call site, and the same note: 0.8.3's `MeshBVHOptions`
 * omits `indirect` although its own runtime defaults carry it, so a bare literal fails the
 * excess-property check. Not a version bump — drei asks for `^0.8.3`, so 0.9 would put a second
 * copy of the package in the tree.
 */
const TREE_OPTIONS: MeshBVHOptions & { indirect: boolean } = { indirect: true }

export interface MeshTrees {
  /** The `three` module itself, so a caller needs no second dynamic import for `Vector3`. */
  three: typeof THREE
  /** One tree per item, in item order. */
  trees: MeshBVH[]
}

/**
 * The trees, built one at a time with a turn for the browser between them.
 *
 * **Sliced**, and this is the stretch that was left out of the first version of `meshInside.ts`.
 * At a measured 192 ms per million triangles a dataset's primary set is a fifth of a second of
 * frozen tab and a wire of full-resolution neuron surfaces is seconds of it, with no way to
 * cancel and nothing on the bar. `three-mesh-bvh` ships a worker builder that would move it off
 * thread entirely; that costs worker bundling in `vite.mcp.config.ts`' already careful
 * externalisation, so the yield is the trade taken here.
 */
export async function buildMeshTrees(
  items: readonly MeshGeometry[],
  hooks: Slicer = {},
): Promise<MeshTrees> {
  const [three, bvh] = await Promise.all([import('three'), import('three-mesh-bvh')])
  const { BufferAttribute, BufferGeometry } = three
  const { MeshBVH } = bvh

  const built: MeshBVH[] = []
  await sliced(items.length, hooks, (i) => {
    const item = items[i]!
    const held = trees.get(item)
    if (held) {
      built.push(held as MeshBVH)
      return
    }
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(item.positions, 3))
    geometry.setIndex(new BufferAttribute(item.indices, 1))
    const tree = new MeshBVH(geometry, TREE_OPTIONS)
    trees.set(item, tree)
    built.push(tree)
  })

  return { three, trees: built }
}
