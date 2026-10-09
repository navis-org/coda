/**
 * One neuron's arbour as a rooted tree with distances on it — what the Neuron Dendrogram draws and
 * what its distal summary reads.
 *
 * Headless and pure, `topologyOps.ts`' arrangement, and for its reason: jsdom performs no layout,
 * so anything left in the card is checked by nothing. The layouts are in `arborLayout.ts`;
 * everything they and the summary *measure* is here.
 *
 * ## The tree is re-rooted here, not trusted as delivered
 *
 * A skeleton's `parents` encode a direction somebody else chose: neuPrint roots wherever the
 * skeletonisation started, CATMAID wherever the tracer did. "Distal to this branch point" only
 * means something relative to a root the reader picked, so `buildArbor` reads `parents` as an
 * undirected tree and walks it again from the chosen node. Nodes the walk does not reach — another
 * fragment of a forest nobody healed — are counted, never silently attached.
 *
 * ## Two distances, one shape
 *
 * Every distance here is a per-node "from the root" array, and a point *along* an edge is the
 * linear interpolation between its two ends. That is exact for both metrics: geodesic length is
 * linear along a straight edge by definition, and electrotonic length is too because each edge
 * carries one λ (from the mean of its end radii). So every consumer — the layouts, the summary,
 * the axis — is written once over "a distance array" and never knows which metric it was handed.
 *
 * **Subtree membership is an interval test.** A pre-order walk gives each node `tin`, and a
 * subtree is the contiguous run `[tin[v], tout[v])` of it. That turns "is this synapse distal to
 * that branch point" into two comparisons, which is what lets a click on a 50,000-synapse arbour
 * answer within the frame.
 */

import { quantileSorted } from '../../core/stats'
import type { TableSchema } from '../../core/types'
import { column, tableSchema } from '../../core/types'
import type { GeometryUnits, PointsValue, SkeletonGeometry } from '../../core/values'
import { SWC_SOMA, makeTable } from '../../core/values'
import type { SynapseSite } from './topologyOps'
import { assignSynapses } from './topologyOps'
import { selectPoints } from './iterables'
import { NM_PER_UM, geometryUnitsProblem } from '../../data/units'

/** A neuron re-rooted at one node, with the arrays every walk over it needs. */
export interface Arbor {
  readonly root: number
  /** Parent per node in the re-rooted tree; `-1` at the root and at every unreached node. */
  readonly parent: Int32Array
  /** Reached nodes in pre-order, root first. Its length is how many were reached. */
  readonly order: Int32Array
  /** Pre-order position per node; `-1` where unreached. */
  readonly tin: Int32Array
  /** One past the last pre-order position in each node's subtree; `-1` where unreached. */
  readonly tout: Int32Array
  /** Children per node in the re-rooted tree, as CSR: `childList[childStart[v] .. childStart[v+1])`. */
  readonly childStart: Int32Array
  readonly childList: Int32Array
  /** Length of the edge from each node to its parent, in the skeleton's units. `0` at the root. */
  readonly edgeLength: Float64Array
  /** Geodesic distance from the root, in the skeleton's units. `NaN` where unreached. */
  readonly geodesic: Float64Array
  /**
   * Whether the edge from each node to its parent is a healed bridge rather than traced cable.
   * Absent when the skeleton was never healed.
   */
  readonly bridge?: Uint8Array
  /** Nodes the walk from `root` did not reach — other fragments of an unhealed forest. */
  readonly unreached: number
}

/** Which node a dendrogram is rooted at. A number is a node the reader picked. */
export type RootChoice = 'source' | 'soma' | number

/** The card's `Root` and `rootNode` params as a choice — one reading for the card and Run. */
export function rootChoiceOf(root: string, rootNode: number): RootChoice {
  return root === 'picked' ? rootNode : root === 'source' ? 'source' : 'soma'
}

/** The node a root choice resolved to, and whether the choice itself could be honoured. */
export interface ResolvedRoot {
  readonly node: number
  /**
   * The choice could not be honoured and the delivered root stands in: no soma is labelled, or a
   * picked node no longer exists. Said so the card can say it — a card set to "soma" that quietly
   * draws from wherever the skeletonisation started is the common case, most sources labelling
   * no soma.
   */
  readonly fellBack: boolean
}

/**
 * The node a root choice resolves to.
 *
 * `'source'` is the delivered root, and for a forest the root of the **largest** fragment, since
 * a dendrogram drawn from a twenty-node scrap is not the neuron. `'soma'` is the soma-labelled node
 * with the largest radius — the centre of a soma that several nodes outline — and falls back to the
 * delivered root where the source labels no soma, which most do not. A picked node out of range
 * falls back the same way rather than throwing: it is a stored param, and the skeleton it named
 * can be replaced underneath it by a re-fetch.
 */
export function resolveRoot(skeleton: SkeletonGeometry, choice: RootChoice): ResolvedRoot {
  const n = skeleton.parents.length
  if (n === 0) return { node: -1, fellBack: false }
  if (typeof choice === 'number' && Number.isInteger(choice) && choice >= 0 && choice < n) {
    return { node: choice, fellBack: false }
  }
  if (choice === 'soma' && skeleton.compartments) {
    let best = -1
    for (let i = 0; i < n; i++) {
      if (skeleton.compartments[i] !== SWC_SOMA) continue
      if (best < 0 || skeleton.radii[i]! > skeleton.radii[best]!) best = i
    }
    if (best >= 0) return { node: best, fellBack: false }
  }
  return { node: largestFragmentRoot(skeleton.parents), fellBack: choice !== 'source' }
}

/**
 * The delivered tree's children, as CSR over the parent pointers.
 *
 * Not `skeletonTree`, whose `number[]` per node took 28–39 ms on a synthetic 340,000-node tree —
 * the size of FlyWire's largest skeletons — against 2–8 ms for this, measured in Node. Both read an
 * out-of-range parent as a root.
 */
function deliveredChildren(parents: Int32Array): Csr {
  const n = parents.length
  let edges = 0
  for (let i = 0; i < n; i++) if (parents[i]! >= 0 && parents[i]! < n) edges++
  const owners = new Int32Array(edges)
  const values = new Int32Array(edges)
  for (let i = 0, k = 0; i < n; i++) {
    const p = parents[i]!
    if (p < 0 || p >= n) continue
    owners[k] = p
    values[k++] = i
  }
  return csr(n, owners, values)
}

/**
 * Every root of a delivered skeleton — one per fragment. An out-of-range parent is a root, the rule
 * `skeletonTree` follows.
 */
export function skeletonRoots(parents: Int32Array): number[] {
  const n = parents.length
  const roots: number[] = []
  for (let i = 0; i < n; i++) if (parents[i]! < 0 || parents[i]! >= n) roots.push(i)
  return roots
}

/** The root of the fragment holding the most nodes. */
function largestFragmentRoot(parents: Int32Array): number {
  const roots = skeletonRoots(parents)
  // A healed or ordinary neuron has one root, and then there is nothing to measure.
  if (roots.length === 1) return roots[0]!
  const { start, list } = deliveredChildren(parents)
  let best = -1
  let bestSize = -1
  const stack: number[] = []
  for (const root of roots) {
    let size = 0
    stack.push(root)
    while (stack.length > 0) {
      const v = stack.pop()!
      size++
      for (let k = start[v]!; k < start[v + 1]!; k++) stack.push(list[k]!)
    }
    if (size > bestSize) {
      bestSize = size
      best = root
    }
  }
  return best
}

/**
 * Which edges a heal added, as a flag on each edge's child in the *healed* numbering.
 *
 * Healing keeps node indices (`skeletons.py` returns parents in the numbering it was given) but may
 * re-root a fragment to join it, which reverses the traced edges between its old root and the join.
 * So an edge is traced if the original held it in **either** direction, and only an edge in
 * neither is a bridge.
 */
export function healedBridges(original: Int32Array, healed: Int32Array): Uint8Array {
  const out = new Uint8Array(healed.length)
  for (let i = 0; i < healed.length; i++) {
    const p = healed[i]!
    if (p < 0) continue
    if (original[i] === p || original[p] === i) continue
    out[i] = 1
  }
  return out
}

/** A list per index, as compressed rows: index `i`'s entries are `list[start[i] .. start[i + 1])`. */
export interface Csr {
  readonly start: Int32Array
  readonly list: Int32Array
}

/** Group `values` by `owners` as CSR, keeping their order within each owner. */
function csr(n: number, owners: Int32Array, values: Int32Array): Csr {
  const start = new Int32Array(n + 1)
  for (let k = 0; k < owners.length; k++) start[owners[k]! + 1]!++
  for (let i = 0; i < n; i++) start[i + 1]! += start[i]!
  const cursor = start.slice(0, n)
  const list = new Int32Array(owners.length)
  for (let k = 0; k < owners.length; k++) list[cursor[owners[k]!]!++] = values[k]!
  return { start, list }
}

/**
 * Re-root a skeleton at `root` and measure it.
 *
 * `bridges` is `healedBridges`' answer for this skeleton, carried onto the re-rooted edges: an
 * edge keeps its identity when its direction flips, so a bridge is found on whichever end it was
 * recorded against.
 */
export function buildArbor(
  skeleton: SkeletonGeometry,
  root: number,
  bridges?: Uint8Array,
): Arbor {
  const { parents, positions } = skeleton
  const n = parents.length

  // A node's neighbours are its delivered parent and its delivered children: the undirected tree
  // the re-rooted walk runs over.
  const { start, list: delivered } = deliveredChildren(parents)

  const parent = new Int32Array(n).fill(-1)
  const tin = new Int32Array(n).fill(-1)
  const tout = new Int32Array(n).fill(-1)
  const edgeLength = new Float64Array(n)
  const geodesic = new Float64Array(n).fill(NaN)
  const order = new Int32Array(n)
  let reached = 0

  if (root >= 0 && root < n) {
    // Iterative pre-order: a primary neurite is thousands of nodes deep, and recursion on it is a
    // stack overflow (`postOrder`'s note in topologyOps).
    const stack = [root]
    geodesic[root] = 0
    while (stack.length > 0) {
      const v = stack.pop()!
      tin[v] = reached
      order[reached++] = v
      // Pushed in reverse so they come off the stack in order: the delivered parent (`k` one
      // before the children's run), then the delivered children.
      for (let k = start[v + 1]! - 1; k >= start[v]! - 1; k--) {
        const u = k < start[v]! ? parents[v]! : delivered[k]!
        // `-2` marks a node queued but not yet visited, so nothing is pushed twice.
        if (u < 0 || u >= n || tin[u] !== -1) continue
        parent[u] = v
        tin[u] = -2
        const dx = positions[u * 3]! - positions[v * 3]!
        const dy = positions[u * 3 + 1]! - positions[v * 3 + 1]!
        const dz = positions[u * 3 + 2]! - positions[v * 3 + 2]!
        // Not `Math.hypot`, whose overflow guard costs several times this on every edge of a
        // 300,000-node skeleton — and coordinates in nanometres are nowhere near overflowing.
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
        edgeLength[u] = len
        geodesic[u] = geodesic[v]! + len
        stack.push(u)
      }
    }
  }

  // Subtree sizes by a reverse pre-order pass: every descendant of `v` comes after it in
  // pre-order, so by the time `v` is reached its size is complete.
  const size = new Int32Array(n)
  for (let k = reached - 1; k >= 0; k--) {
    const v = order[k]!
    size[v]!++
    tout[v] = tin[v]! + size[v]!
    const p = parent[v]!
    if (p >= 0) size[p]! += size[v]!
  }

  // Children in the re-rooted tree, in pre-order so a layout walks them deterministically. Every
  // reached node but the root has a parent, and the root is first.
  const below = order.subarray(1, reached)
  const { start: childStart, list: childList } = csr(
    n,
    below.map((v) => parent[v]!),
    below,
  )

  let bridge: Uint8Array | undefined
  if (bridges) {
    bridge = new Uint8Array(n)
    // From 1: the root, first in pre-order, has no edge above it.
    for (let k = 1; k < reached; k++) {
      const v = order[k]!
      const p = parent[v]!
      if ((parents[v] === p && bridges[v]) || (parents[p] === v && bridges[p])) bridge[v] = 1
    }
  }

  return {
    root: reached > 0 ? root : -1,
    parent,
    order: order.slice(0, reached),
    tin,
    tout,
    childStart,
    childList,
    edgeLength,
    geodesic,
    ...(bridge ? { bridge } : {}),
    unreached: n - reached,
  }
}

/** Whether `u` is `v` or lies below it. */
export function inSubtree(arbor: Arbor, v: number, u: number): boolean {
  const t = arbor.tin[u]!
  return t >= 0 && t >= arbor.tin[v]! && t < arbor.tout[v]!
}

/* ------------------------------------------------------------------------------------------
 * Electrotonic distance.
 * ---------------------------------------------------------------------------------------- */

/**
 * Passive membrane constants. Specific membrane resistance `rm` in Ω·cm², axial resistivity `ri` in
 * Ω·cm — the units every cable-theory paper quotes them in.
 */
export interface CableConstants {
  readonly rm: number
  readonly ri: number
}

/**
 * Gouwens & Wilson (2009), fitted to Drosophila antennal-lobe projection neurons: 20.8 kΩ·cm²
 * and 266 Ω·cm. A fly default because the connectomes here are mostly flies; a reader on a
 * mammalian cell changes two numbers, and the help says which.
 */
export const DEFAULT_CABLE: CableConstants = { rm: 20_800, ri: 266 }

const CM_PER_NM = 1e-7

/** The length constant of a cylinder of radius `radiusNm`, in nanometres. */
export function lengthConstantNm(radiusNm: number, cable: CableConstants): number {
  const r = radiusNm * CM_PER_NM
  return Math.sqrt((cable.rm * r) / (2 * cable.ri)) / CM_PER_NM
}

export type ElectrotonicResult =
  | { readonly ok: true; readonly distance: Float64Array }
  | { readonly ok: false; readonly reason: string }

/**
 * Electrotonic distance from the root, in units of λ: each edge contributes `Δx / λ(r̄)`, with r̄
 * the mean of its two end radii.
 *
 * **Refused, never patched**, in two cases. Coordinates that say they are not nanometres have no
 * radius in a physical unit to put into λ (`geometryUnitsProblem`). And a reached node with no
 * radius (`r ≤ 0`) makes λ zero and the distance infinite — CATMAID leaves 80% of its nodes so, measured over twenty FAFB neurons
 * (`pnpm probe:radii`), and an interpolated radius would be a measurement nobody took. The refusal
 * says how many nodes, so a reader can tell one bad node from a source that publishes none.
 */
export function electrotonicDistances(
  skeleton: SkeletonGeometry,
  arbor: Arbor,
  /** The value the skeleton came in — `SkeletonsValue.units` is a fact about the set. */
  value: { readonly units?: GeometryUnits },
  cable: CableConstants = DEFAULT_CABLE,
): ElectrotonicResult {
  // The shared nanometre guard, so this refuses in NBLAST's and Distance's words and on their
  // rule: absent units are unknown, not wrong, and pass.
  const units = geometryUnitsProblem(
    'This',
    value,
    'neuron’s coordinates',
    'Neuron Dendrogram',
    'electrotonic distance has no radius in a physical unit to compute a length constant from.',
  )
  if (units) return { ok: false, reason: units }
  if (!(cable.rm > 0) || !(cable.ri > 0)) {
    return {
      ok: false,
      reason: 'Membrane and axial resistance must both be greater than zero.',
    }
  }
  const { radii } = skeleton
  let missing = 0
  for (const v of arbor.order) {
    const r = radii[v]!
    if (!(Number.isFinite(r) && r > 0)) missing++
  }
  if (missing > 0) {
    return {
      ok: false,
      reason:
        missing === arbor.order.length
          ? 'Electrotonic distance needs radii, and this skeleton has none.'
          : `Electrotonic distance needs a radius on every node, and ${missing} of ` +
            `${arbor.order.length} nodes have none.`,
    }
  }

  const distance = new Float64Array(skeleton.parents.length).fill(NaN)
  for (const v of arbor.order) {
    const p = arbor.parent[v]!
    if (p < 0) {
      distance[v] = 0
      continue
    }
    const lambda = lengthConstantNm((radii[v]! + radii[p]!) / 2, cable)
    distance[v] = distance[p]! + arbor.edgeLength[v]! / lambda
  }
  return { ok: true, distance }
}

/** Above this share of nodes at one radius, the radii are read as stamped rather than measured. */
const STAMPED_RADIUS_SHARE = 0.5

/**
 * The radius most of an arbour shares, where most of it shares one.
 *
 * Not a refusal: the distances are computable and correct *for the radii given*. It is a note,
 * because `pnpm probe:radii` found MANC, male-CNS and optic-lobe skeletons with ~75% of every
 * neuron's nodes at exactly 256 nm — a skeletonisation floor, not a measurement — and over such an
 * arbour electrotonic distance is geodesic distance rescaled almost everywhere, while thin twigs are
 * given a radius they do not have. Derived from the neuron's own radii, so no dataset is named.
 */
export function stampedRadius(
  skeleton: SkeletonGeometry,
  arbor: Arbor,
): { readonly radius: number; readonly share: number } | undefined {
  /*
   * Boyer–Moore majority vote rather than a count per distinct radius. The threshold is above a
   * half, which is exactly what the vote finds, and a measured radius is a float that takes a
   * distinct value on nearly every node — a Map of them would hold one entry per node on a
   * 300,000-node skeleton to answer "no".
   */
  const { radii } = skeleton
  let candidate = NaN
  let lead = 0
  for (const v of arbor.order) {
    if (lead === 0) candidate = radii[v]!
    lead += radii[v] === candidate ? 1 : -1
  }
  let count = 0
  for (const v of arbor.order) if (radii[v] === candidate) count++
  const share = arbor.order.length > 0 ? count / arbor.order.length : 0
  // A radius every node shares at zero is not a stamped radius but a missing one — the refusal's
  // business (`electrotonicDistances`), not this note's.
  return share > STAMPED_RADIUS_SHARE && candidate > 0
    ? { radius: candidate, share }
    : undefined
}

/* ------------------------------------------------------------------------------------------
 * The reduced tree every layout draws.
 * ---------------------------------------------------------------------------------------- */

/**
 * The arbour as segments between topological landmarks — the root, every branch point and every
 * leaf. A layout draws one straight piece per segment, so a 100,000-node traced skeleton becomes a
 * few thousand pieces, and the nodes along a segment matter only through the distance they add.
 */
export interface KeyTree {
  /** Skeleton node per landmark, in pre-order; `nodes[0]` is the root. */
  readonly nodes: Int32Array
  /** Landmark index of each landmark's nearest landmark ancestor; `-1` for the root. */
  readonly parent: Int32Array
  /**
   * Per skeleton node, the landmark index of the segment it lies on — the segment's *distal* end.
   * The root and unreached nodes hold `-1`. A landmark lies on its own segment.
   */
  readonly segmentOf: Int32Array
}

/**
 * Whether a node is a landmark: the root, or anything that does not merely continue a segment —
 * a leaf (no children) or a branch point (two or more). One rule, read by `keyTree` and by
 * `pruneTwigs`, so a drawing with twigs hidden cannot disagree with the tree about what a segment
 * is.
 */
function isLandmark(isRoot: boolean, children: number): boolean {
  return isRoot || children !== 1
}

export function keyTree(arbor: Arbor): KeyTree {
  const n = arbor.parent.length
  const keyIndex = new Int32Array(n).fill(-1)
  const nodes: number[] = []
  for (const v of arbor.order) {
    const children = arbor.childStart[v + 1]! - arbor.childStart[v]!
    if (isLandmark(v === arbor.root, children)) {
      keyIndex[v] = nodes.length
      nodes.push(v)
    }
  }

  // A node's segment is named by the landmark at its distal end, which a pre-order walk has not
  // reached yet — so assign bottom-up, in reverse pre-order, carrying each landmark upwards until
  // the next one.
  const segmentOf = new Int32Array(n).fill(-1)
  // Down to 1: `order[0]` is the root, which lies on no segment.
  for (let k = arbor.order.length - 1; k >= 1; k--) {
    const v = arbor.order[k]!
    if (keyIndex[v]! >= 0) {
      segmentOf[v] = keyIndex[v]!
    } else {
      // A slab node has exactly one child, already assigned.
      segmentOf[v] = segmentOf[arbor.childList[arbor.childStart[v]!]!]!
    }
  }

  const parent = new Int32Array(nodes.length).fill(-1)
  for (let k = 1; k < nodes.length; k++) {
    parent[k] = keyIndexAbove(arbor, keyIndex, arbor.parent[nodes[k]!]!)
  }

  return { nodes: Int32Array.from(nodes), parent, segmentOf }
}

/**
 * The nearest landmark at or above `v`, a reached node. Always found, the root being a landmark;
 * and the walks total O(n), each covering one segment.
 */
function keyIndexAbove(arbor: Arbor, keyIndex: Int32Array, v: number): number {
  let u = v
  while (keyIndex[u]! < 0) u = arbor.parent[u]!
  return keyIndex[u]!
}

/** The distance from the root of each landmark, read off a per-node distance array. */
export function landmarkDistances(tree: KeyTree, distance: Float64Array): Float64Array {
  return Float64Array.from(tree.nodes, (v) => distance[v]!)
}

/** Each landmark's children in the reduced tree, in pre-order. */
export function keyChildren(tree: KeyTree): Csr {
  const n = tree.nodes.length
  return csr(
    n,
    tree.parent.subarray(1),
    Int32Array.from({ length: Math.max(0, n - 1) }, (_, i) => i + 1),
  )
}

/* ------------------------------------------------------------------------------------------
 * Hiding short twigs: a drawing decision, never a measurement.
 * ---------------------------------------------------------------------------------------- */

/** A reduced tree with the short twigs left out, and where each original segment went. */
export interface PrunedTree {
  readonly tree: KeyTree
  /**
   * Per landmark of the *original* tree, the landmark of the pruned tree whose segment now holds
   * it, or `-1` where it was hidden. A branch point left with one child is no longer a landmark,
   * so its segment merges into the one below and maps there.
   */
  readonly drawnAs: Int32Array
  /** How many twigs were hidden. */
  readonly hidden: number
}

/**
 * Hide leaf segments shorter than `minTwig`, once — not repeatedly, which would erode a whole
 * arbour from its tips inwards.
 *
 * Only the drawing reads the result. The distal summary and every distance keep reading the full
 * tree, so hiding twigs changes what is drawn and never what is counted; the card says how many
 * synapses sit on hidden twigs rather than moving them somewhere they are not.
 */
export function pruneTwigs(tree: KeyTree, d: Float64Array, minTwig: number): PrunedTree {
  const n = tree.nodes.length
  const childCount = new Int32Array(n)
  for (let k = 1; k < n; k++) childCount[tree.parent[k]!]!++
  const kept = new Uint8Array(n).fill(1)
  let hidden = 0
  if (minTwig > 0) {
    for (let k = 1; k < n; k++) {
      if (childCount[k] === 0 && d[k]! - d[tree.parent[k]!]! < minTwig) {
        kept[k] = 0
        hidden++
      }
    }
  }
  if (hidden === 0) {
    return { tree, drawnAs: Int32Array.from({ length: n }, (_, k) => k), hidden: 0 }
  }

  // Kept children per landmark, then which landmarks survive as landmarks.
  const keptChildren = new Int32Array(n)
  for (let k = 1; k < n; k++) if (kept[k]) keptChildren[tree.parent[k]!]!++
  const stays = (k: number): boolean => kept[k] === 1 && isLandmark(k === 0, keptChildren[k]!)

  // `drawnAs` bottom-up: a landmark that stays is itself; one left with a single kept child takes
  // that child's answer, its segment having merged into the one below.
  const index = new Int32Array(n).fill(-1)
  const nodes: number[] = []
  for (let k = 0; k < n; k++) {
    if (stays(k)) {
      index[k] = nodes.length
      nodes.push(tree.nodes[k]!)
    }
  }
  const drawnAs = new Int32Array(n).fill(-1)
  const onlyChild = new Int32Array(n).fill(-1)
  for (let k = 1; k < n; k++) if (kept[k]) onlyChild[tree.parent[k]!] = k
  for (let k = n - 1; k >= 0; k--) {
    if (!kept[k]) continue
    drawnAs[k] = stays(k) ? index[k]! : drawnAs[onlyChild[k]!]!
  }

  const parent = new Int32Array(nodes.length).fill(-1)
  for (let k = 1; k < n; k++) {
    if (!stays(k)) continue
    let p = tree.parent[k]!
    while (!stays(p)) p = tree.parent[p]!
    parent[index[k]!] = index[p]!
  }
  const segmentOf = new Int32Array(tree.segmentOf.length).fill(-1)
  for (let v = 0; v < segmentOf.length; v++) {
    const k = tree.segmentOf[v]!
    if (k >= 0) segmentOf[v] = drawnAs[k]!
  }
  return { tree: { nodes: Int32Array.from(nodes), parent, segmentOf }, drawnAs, hidden }
}

/* ------------------------------------------------------------------------------------------
 * Synapses on the tree.
 * ---------------------------------------------------------------------------------------- */

/**
 * Where each synapse sits on the skeleton as delivered, before any root is chosen: on the edge
 * from `child` to `parent` (the delivered parent pointer), a fraction `t` of the way from `parent`
 * to `child`. `parent` is `-1` for a synapse whose nearest node has no edge at all; `child` is
 * `-1` only for an empty skeleton.
 *
 * Split from `orientPlacement` because this is the expensive half — the nearest-node search, 146 ms
 * for 31,439 synapses on male-CNS 10003 — and none of it depends on the root. An edge is the same
 * edge whichever way the tree is walked, so picking a new root is a flip per synapse, not a search.
 */
export interface SynapseProjection {
  readonly child: Int32Array
  readonly parent: Int32Array
  readonly t: Float32Array
}

/**
 * Project synapses onto the skeleton's edges.
 *
 * `assignSynapses` finds the nearest node — the same pass Neuron Topology counts with — and this
 * refines it to the nearest point on any edge touching that node. Snapping to the node alone is a
 * distance error up to half an edge, which on a level-2 skeleton (a node every few micrometres) is
 * larger than the question "how far from this branch point" can tolerate.
 */
export function projectSynapses(
  skeleton: SkeletonGeometry,
  sites: readonly SynapseSite[],
): SynapseProjection {
  const child = new Int32Array(sites.length).fill(-1)
  const parent = new Int32Array(sites.length).fill(-1)
  const t = new Float32Array(sites.length).fill(1)
  const { nodeOf } = assignSynapses(skeleton, sites)
  const children = deliveredChildren(skeleton.parents)
  const { parents, positions: pos } = skeleton
  const n = parents.length

  for (let s = 0; s < sites.length; s++) {
    const v = nodeOf[s]!
    if (v < 0) continue
    const site = sites[s]!
    // Starting values are the answer for a node with no edges: the node itself, at full length.
    child[s] = v
    let bestDist = Infinity
    /** The edge from `a` down to `c`: keep it if the site is closer to it than to any so far. */
    const consider = (c: number, a: number): void => {
      const ax = pos[a * 3]!
      const ay = pos[a * 3 + 1]!
      const az = pos[a * 3 + 2]!
      const dx = pos[c * 3]! - ax
      const dy = pos[c * 3 + 1]! - ay
      const dz = pos[c * 3 + 2]! - az
      const len2 = dx * dx + dy * dy + dz * dz
      const along =
        len2 > 0
          ? Math.min(
              1,
              Math.max(
                0,
                ((site.x - ax) * dx + (site.y - ay) * dy + (site.z - az) * dz) / len2,
              ),
            )
          : 1
      const d =
        (site.x - (ax + along * dx)) ** 2 +
        (site.y - (ay + along * dy)) ** 2 +
        (site.z - (az + along * dz)) ** 2
      if (d < bestDist) {
        bestDist = d
        child[s] = c
        parent[s] = a
        t[s] = along
      }
    }
    // The edge to the parent, then every edge to a child.
    const p = parents[v]!
    if (p >= 0 && p < n) consider(v, p)
    for (let k = children.start[v]!; k < children.start[v + 1]!; k++)
      consider(children.list[k]!, v)
  }
  return { child, parent, t }
}

/**
 * Where each synapse sits on the re-rooted tree: on the edge from `node` up to its parent, a
 * fraction `t` of the way from the parent (0) to `node` (1). `node` is `-1` for a synapse that
 * could not be placed — on an unreached fragment, or on an empty skeleton.
 */
export interface Placement {
  readonly node: Int32Array
  readonly t: Float32Array
  /** How many synapses could not be placed. */
  readonly unplaced: number
}

/** A projection read in a re-rooted tree's directions: an edge it reversed flips `t`. */
export function orientPlacement(arbor: Arbor, projection: SynapseProjection): Placement {
  const count = projection.child.length
  const node = new Int32Array(count).fill(-1)
  const t = new Float32Array(count)
  let unplaced = 0
  for (let s = 0; s < count; s++) {
    const c = projection.child[s]!
    const p = projection.parent[s]!
    if (c >= 0 && arbor.tin[c]! >= 0) {
      // A node with no edges (`p` is -1) can be reached only as the root, whose parent is -1 too.
      if (arbor.parent[c] === p) {
        node[s] = c
        t[s] = projection.t[s]!
        continue
      }
      if (arbor.parent[p] === c) {
        node[s] = p
        t[s] = 1 - projection.t[s]!
        continue
      }
    }
    unplaced++
  }
  return { node, t, unplaced }
}

/** A point on the tree: on the edge above `node`, a fraction `t` of the way down it. */
export interface ArborPoint {
  readonly node: number
  readonly t: number
}

/**
 * The node a "Make root" on a clicked point means: whichever end of its edge it is nearer. One
 * rule for every surface that re-roots from a click — the Neuron Dendrogram and the split editor.
 */
export function rootNodeFor(point: ArborPoint, parent: Int32Array): number {
  const p = parent[point.node]!
  return point.t >= 0.5 || p < 0 ? point.node : p
}

/** The distance of a tree point from the root, under a per-node distance array. */
export function distanceAt(arbor: Arbor, distance: Float64Array, at: ArborPoint): number {
  const p = arbor.parent[at.node]!
  const here = distance[at.node]!
  if (p < 0) return here
  const above = distance[p]!
  return above + at.t * (here - above)
}

/**
 * Every placed synapse distal to `at`, with its distance from `at`.
 *
 * Distal means below `at` in the re-rooted tree, which is a subtree test on the placement's node —
 * plus the one case the test cannot see: a synapse on the *same* edge, which is distal only if it
 * sits further down it. Its distance from `at` is then the difference of the two root distances,
 * because the path from the root to anything distal passes through `at`.
 */
export function distalSynapses(
  arbor: Arbor,
  placement: Placement,
  distance: Float64Array,
  at: ArborPoint,
): { readonly indices: Int32Array; readonly distances: Float64Array } {
  const origin = distanceAt(arbor, distance, at)
  const indices: number[] = []
  const distances: number[] = []
  for (let s = 0; s < placement.node.length; s++) {
    const u = placement.node[s]!
    if (u < 0 || !inSubtree(arbor, at.node, u)) continue
    if (u === at.node && placement.t[s]! < at.t) continue
    indices.push(s)
    distances.push(distanceAt(arbor, distance, { node: u, t: placement.t[s]! }) - origin)
  }
  return { indices: Int32Array.from(indices), distances: Float64Array.from(distances) }
}

/* ------------------------------------------------------------------------------------------
 * The clicked point, as the Neuron Dendrogram stores it, and what lies beyond it.
 * ---------------------------------------------------------------------------------------- */

/** A clicked point and the neuron it was clicked on. */
export interface Focus {
  readonly neuronId: string
  readonly point: ArborPoint
}

/**
 * The `focus` param's text: `neuronId:node:t`.
 *
 * The neuron is part of it because the node's Points output is built from it at Run, and paging
 * the card is a display change that must not move what the port carries — so the port reads the
 * neuron off the point, never off the page.
 */
export function writeFocus(focus: Focus | undefined): string {
  return focus ? `${focus.neuronId}:${focus.point.node}:${focus.point.t.toFixed(4)}` : ''
}

/** The param's text back, or undefined for an empty or malformed one. Not checked against a tree. */
export function parseFocus(text: string): Focus | undefined {
  const match = /^([^:]+):(\d+):([\d.]+)$/.exec(text)
  if (!match) return undefined
  const t = Number(match[3])
  if (!(t >= 0 && t <= 1)) return undefined
  return { neuronId: match[1]!, point: { node: Number(match[2]), t } }
}

/**
 * The point, if it still exists in this tree. A stored index outlives the skeleton it named —
 * another route, a re-fetch — so an out-of-range one reads as no point.
 */
export function pointOnArbor(arbor: Arbor, point: ArborPoint): ArborPoint | undefined {
  return point.node < arbor.tin.length && arbor.tin[point.node]! >= 0 ? point : undefined
}

/** The param's point, if it was clicked on this neuron and still exists in this tree. */
export function focusOn(
  text: string,
  neuronId: string | null,
  arbor: Arbor,
): ArborPoint | undefined {
  const focus = parseFocus(text)
  return focus && focus.neuronId === neuronId ? pointOnArbor(arbor, focus.point) : undefined
}

/** The two columns the distal points add to the synapse rows, in micrometres. */
const DISTAL_COLUMNS: ReadonlySet<string> = new Set(['distanceFromPoint', 'distanceFromRoot'])

/** The schema half: the synapse rows' own columns, then the two distances. */
export function distalPointsSchema(synapses: TableSchema): TableSchema {
  return tableSchema(
    ...synapses.columns.filter((c) => !DISTAL_COLUMNS.has(c.name)),
    column('distanceFromPoint', 'f64', 'µm'),
    column('distanceFromRoot', 'f64', 'µm'),
  )
}

/**
 * The value half: the synapses `distalSynapses` found, as a point cloud with their geodesic
 * distance from the clicked point and from the root added. Geodesic only — electrotonic distance
 * is a reading the card offers, and its constants are presentational there.
 */
export function distalPoints(
  cloud: PointsValue,
  arbor: Arbor,
  placement: Placement,
  distal: { readonly indices: Int32Array; readonly distances: Float64Array },
): PointsValue {
  const keep = new Uint8Array(cloud.attributes.length)
  for (const s of distal.indices) keep[s] = 1
  const picked = selectPoints(cloud, (i) => keep[i] === 1)
  const own = picked.attributes
  // `distalSynapses` walks the synapses in order, so its indices are ascending and line up with
  // the rows `selectPoints` kept.
  return {
    ...picked,
    attributes: makeTable(distalPointsSchema(own.schema), {
      ...own.data,
      distanceFromPoint: Array.from(distal.distances, (d) => d / NM_PER_UM),
      distanceFromRoot: Array.from(
        distal.indices,
        (s) =>
          distanceAt(arbor, arbor.geodesic, { node: placement.node[s]!, t: placement.t[s]! }) /
          NM_PER_UM,
      ),
    }),
  }
}

/** One row of the distal summary: a partner (or partner type) on one side of the connection. */
export interface DistalRow {
  readonly label: string
  /** `'pre'` for this neuron's outputs, `'post'` for its inputs — `assignSynapses`' reading. */
  readonly polarity: 'pre' | 'post'
  readonly count: number
  readonly min: number
  readonly median: number
  readonly max: number
}

/**
 * The distal synapses rolled up by label and side, most synapses first.
 *
 * `label` is asked per synapse index so the caller decides the vocabulary — partner id, partner
 * type, or the card's lit-partner column — and this never learns which. Polarity follows
 * `assignSynapses`: anything not spelled `pre` is an input.
 */
export function summariseDistal(
  distal: { readonly indices: Int32Array; readonly distances: Float64Array },
  label: (synapse: number) => string,
  polarity: (synapse: number) => string,
): DistalRow[] {
  const groups = new Map<string, { label: string; polarity: 'pre' | 'post'; d: number[] }>()
  for (let k = 0; k < distal.indices.length; k++) {
    const s = distal.indices[k]!
    const side = polarity(s) === 'pre' ? 'pre' : 'post'
    const name = label(s)
    const key = `${side}\u0000${name}`
    let group = groups.get(key)
    if (!group) {
      group = { label: name, polarity: side, d: [] }
      groups.set(key, group)
    }
    group.d.push(distal.distances[k]!)
  }
  const rows: DistalRow[] = []
  for (const group of groups.values()) {
    const d = Float64Array.from(group.d).sort()
    rows.push({
      label: group.label,
      polarity: group.polarity,
      count: d.length,
      min: d[0]!,
      median: quantileSorted(d, 0.5),
      max: d[d.length - 1]!,
    })
  }
  // Numeric-aware, so a label that is an id orders as a number (`999` before `1000`) and one that
  // is a cell type alphabetically — the caller picks the vocabulary, so the order has to suit both.
  return rows.sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label, undefined, { numeric: true }),
  )
}

/* ------------------------------------------------------------------------------------------
 * Values per node, for colouring the branches.
 * ---------------------------------------------------------------------------------------- */

/** How synapse flow centrality counts paths. navis's three modes, its default `sum`. */
export type FlowMode = 'sum' | 'centrifugal' | 'centripetal'

/**
 * Synapse flow centrality per node of the re-rooted tree (Schneider-Mizell et al. 2016), as
 * `navis.synapse_flow_centrality` computes it: through each node's edge, the number of paths from
 * an input on one side to an output on the other. `centrifugal` counts proximal inputs to distal
 * outputs, `centripetal` distal inputs to proximal outputs, and `sum` both.
 *
 * Two departures, neither of them a choice made here. A synapse counts on the node at the child
 * end of the edge it was placed on, where navis counts it on its nearest node — `projectSynapses`
 * refines onto edges, and the edge is the honest answer. And navis's own correction is applied: a
 * branch point takes its largest child's flow, because at the branch into the cell body fibre the
 * flow goes across the point rather than through it (`mmetrics.py`).
 *
 * Depends on the root, so it is computed on the arbour as drawn rather than on the skeleton.
 */
export function synapseFlow(
  arbor: Arbor,
  placement: Placement,
  polarity: (synapse: number) => string,
  mode: FlowMode = 'sum',
): Float64Array {
  const n = arbor.parent.length
  // Inputs and outputs below each node, the node's own included: placed, then summed upwards.
  const pre = new Float64Array(n)
  const post = new Float64Array(n)
  for (let s = 0; s < placement.node.length; s++) {
    const u = placement.node[s]!
    if (u < 0) continue
    if (polarity(s) === 'pre') pre[u]!++
    else post[u]!++
  }
  for (let k = arbor.order.length - 1; k >= 1; k--) {
    const v = arbor.order[k]!
    const p = arbor.parent[v]!
    pre[p]! += pre[v]!
    post[p]! += post[v]!
  }
  const root = arbor.root
  const totalPre = root >= 0 ? pre[root]! : 0
  const totalPost = root >= 0 ? post[root]! : 0

  const flow = new Float64Array(n)
  for (const v of arbor.order) {
    const centrifugal = (totalPost - post[v]!) * pre[v]!
    const centripetal = post[v]! * (totalPre - pre[v]!)
    flow[v] =
      mode === 'centrifugal'
        ? centrifugal
        : mode === 'centripetal'
          ? centripetal
          : centrifugal + centripetal
  }
  // navis's branch-point correction: the largest child's flow, never less.
  for (const v of arbor.order) {
    const from = arbor.childStart[v]!
    const to = arbor.childStart[v + 1]!
    if (to - from < 2) continue
    let best = 0
    for (let c = from; c < to; c++) best = Math.max(best, flow[arbor.childList[c]!]!)
    flow[v] = best
  }
  return flow
}
