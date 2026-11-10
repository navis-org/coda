/**
 * A neuron's open ends, as SEAM's pipeline defines them (stage 2).
 *
 * Model E scores points on a surface; what the pipeline asks it about are **tips**, and a tip is
 * not "a leaf of whatever skeleton you have". `scripts/pilots/calib_tips.py`'s `tips_on` is four
 * decisions, and `p_tip`, the cutoff and `r` were all fitted with them in place, so a tip defined
 * any other way needs SEAM to refit all three:
 *
 * 1. **Twigs under `SEAM_TIP_RULE.pruneUm` go first**, non-recursively, on a skeleton whose
 *    fragments have been joined end to end first (`tipSkeleton.ts` runs both). A wavefront skeleton of a segmentation
 *    sprouts single-node spurs off the backbone, and every one of them is a false open end.
 * 2. **A tip is a node of degree one** — counting the edge to its parent *and* the edges to its
 *    children. That is not Coda's `NODE_LEAF`, which asks only about children: a root with one
 *    child has degree one and **is** a tip here, while an isolated node has degree zero and is
 *    not one, which is the case the comment in `tips_of` calls out.
 * 3. **Every tip is snapped to the nearest mesh vertex.** The skeleton runs down the middle of
 *    the neurite and Model E scores the *surface*, so an unsnapped tip asks about a point that is
 *    half a neurite's radius from anything the model has an opinion about. This is also why it is
 *    the mesh's own vertex rather than the nearest surface point: it is what SEAM does.
 * 4. **Tips within `SEAM_TIP_RULE.somaUm` of the soma are dropped.** A cell body is a hairball of ends, none of
 *    which is a missing neurite.
 *
 * **Kinks are the fifth decision, and they are opt-in** (`TipOptions.kinks`). A kink is a sharp
 * turn inside an unbranched run — where a side branch swallowed the real end, so the skeleton
 * carried on past the place the neuron stopped. They are extra candidates beside the tips, not a
 * different reading of them, and every one is published with `kind: 'kink'` so that a reader can
 * tell the two apart. `tip_candidates.py`'s order is the one followed here: thin the kinks against
 * the **unsnapped** tips, then snap and soma-mask tips and kinks together.
 *
 * Headless and pure, `nblastOps.ts`' arrangement: the pruning is a Pyodide call the caller makes,
 * so what is left here is the part a test can see.
 */

import { NM_PER_UM } from '../../data/units'
import { buildKdTree } from '../../nodes/lib/kdTree'
import { parentDistances } from '../../nodes/lib/topologyOps'
import type { MeshGeometry, SkeletonGeometry } from '../../core/values'

/**
 * What a tip is, as SEAM calibrated it — the numbers the four decisions above are made with.
 *
 * One object rather than loose constants because they are **one rule**: `p_tip`, the cutoff and
 * `r` were fitted with all of them in place, so moving any one of them gives a different set of
 * ends scored against thresholds that no longer apply to it. Naming them together is also what
 * makes kinks, when they land, a field here rather than a fifth number somewhere else.
 *
 * `pruneUm` is `tip_candidates.PRUNE_UM`, `somaUm` is `tip_diagnostic.SOMA_UM`, and `healUm` is
 * `tip_skeletons.HEAL_MAX_NM` — the longest bridge the heal may build. There is deliberately no
 * "no limit" healing: an unbounded heal is exactly what SEAM's note about inventing topology is
 * about.
 *
 * **Three of these reach the card and three do not**, and the line is worth stating because the
 * next request will be for a fourth control. `pruneUm`, `healUm` and `somaUm` are about the
 * *input*: which skeleton you wired, how broken it is, whether a soma is known at all — a reader
 * answers those, and `Find Open Ends` offers all three. The kink three are the *definition of a
 * kink*, which a reader either takes from SEAM or does not use; they reach the card as the one
 * switch that turns kinks on. `SNAP_WITHIN_NM` sits on the same side of that line, which is why
 * it is not a control either.
 */
export interface TipRule {
  /** Twigs shorter than this go before the leaves are taken. */
  readonly pruneUm: number
  /** The longest bridge the heal may build between two fragments. */
  readonly healUm: number
  /** No tip within this of the soma. */
  readonly somaUm: number
  /** How far along the path a kink's turn is measured, each way (`tip_candidates.KINK_L_UM`). */
  readonly kinkLengthUm: number
  /** A turn sharper than this is a kink (`tip_candidates.KINK_DEG`). */
  readonly kinkTurnDeg: number
  /** No kink within this of a tip or of a sharper kink (`tip_kinks.NMS_UM`). */
  readonly kinkNmsUm: number
}

export const SEAM_TIP_RULE: TipRule = {
  pruneUm: 1.0,
  healUm: 1.0,
  somaUm: 10.0,
  kinkLengthUm: 1.0,
  kinkTurnDeg: 60,
  kinkNmsUm: 2.0,
}

/**
 * What a tip is, in the fixture's `kind` column.
 *
 * Published whether or not kinks were asked for, so a graph that turns them on later widens what
 * the column holds rather than minting a column that was not there before.
 */
export type TipKind = 'tip' | 'kink'

export interface Tips {
  /** `n × 3` nanometres: the **snapped** positions, which is what Model E is asked about. */
  readonly positions: Float32Array
  /** One per position: `tip` for a degree-one node, `kink` for a sharp turn inside a run. */
  readonly kinds: readonly TipKind[]
  /** Which skeleton node each came from, before snapping — for a reader asking "which end?". */
  readonly fromNode: Int32Array
  /** How many candidates were dropped for sitting on the soma. */
  readonly nearSoma: number
  /** How many of the kept candidates are kinks — what the opt-in actually bought. */
  readonly kinks: number
  /** How many had no mesh vertex within reach, so could not be snapped. */
  readonly unsnapped: number
}

/**
 * The degree-one nodes of a skeleton: **undirected** degree, parent edge included.
 *
 * Separate from `classifyNodes` rather than derived from it, and the difference is the whole
 * reason: that one answers "root, branch, slab or leaf" from the children alone, which is the
 * right question for a tree somebody is walking and the wrong one here. A root with a single
 * child is an end of the cable — SEAM counts it — and an isolated node is an end of nothing.
 */
export function degreeOneNodes(parents: Int32Array): Int32Array {
  const degree = new Int32Array(parents.length)
  for (let i = 0; i < parents.length; i++) {
    const parent = parents[i]!
    if (parent < 0 || parent >= parents.length) continue
    degree[i]! += 1
    degree[parent]! += 1
  }
  const out: number[] = []
  for (let i = 0; i < degree.length; i++) if (degree[i] === 1) out.push(i)
  return Int32Array.from(out)
}

export interface TipOptions {
  /** Where the soma is, in nanometres, or absent where the source does not say. */
  readonly somaNm?: readonly [number, number, number]
  /**
   * How far a tip may be from the mesh and still be snapped onto it, in nanometres.
   *
   * A bound rather than an unbounded search because an unbounded one always answers: a skeleton
   * node left behind by a mesh that has since been cut would snap to a vertex on the far side of
   * the brain, and Model E would be asked about a surface the tip has nothing to do with. The
   * default is generous — a neurite's radius is well under a micrometre and the worst honest case
   * is a node at the centre of a thick process.
   */
  readonly snapWithinNm?: number
  /**
   * Also look for **kinks**: SEAM's fifth decision, and off unless asked for.
   *
   * A kink is a sharp turn inside an unbranched run — the shape a side branch leaves when it
   * swallowed the real end, so the skeleton carries on past a place the neuron stopped. They
   * are extra candidates beside the tips rather than a different reading of them, which is why
   * this is a switch and not a mode.
   */
  readonly kinks?: boolean
  /**
   * The numbers the rule is made of — `SEAM_TIP_RULE` unless a card says otherwise.
   *
   * **The only carrier for any of them.** `somaUm` was briefly a loose option beside this as
   * well, which meant a `TipRule` had a field the one function taking it quietly ignored: a
   * caller passing a rule with `somaUm: 0` — "keep every tip" — got SEAM's 10 µm and no
   * complaint. `pruneUm` and `healUm` are still not read here, but they are not read by anybody
   * else either; they belong to the skeletonizing the caller did upstream (`tipSkeleton.ts`),
   * which is why they are in the rule rather than in two places.
   */
  readonly rule?: TipRule
}

/**
 * The nodes where the skeleton turns sharply inside an unbranched run — `tip_kinks.kinks`.
 *
 * **Why these are candidates at all.** A tip is where the reconstruction stops. A kink is where
 * it carried *on* but should not have: a side branch swallowed the real end, so the traced path
 * turns a corner to follow the wrong neurite. The shape is the same question Model E is asked
 * about a tip — "does the surface here look like somewhere a neurite was cut off" — at a place no
 * leaf exists.
 *
 * A candidate node has a parent and **exactly one child**, so it is inside a run rather than at a
 * branch point or an end. The turn is measured between the direction from a point `lengthNm`
 * back along the path and the direction to a point `lengthNm` forward, and **a walk that runs
 * out of path before reaching that distance disqualifies the node** rather than measuring a
 * shorter one: a turn over 200 nm is noise, and comparing it with a turn over a micrometre would
 * rank the two against each other.
 *
 * Returns every node that turns far enough, with its angle, unthinned — `thinKinks` is the
 * second half.
 */
export function kinkNodes(
  skeleton: Pick<SkeletonGeometry, 'positions' | 'parents'>,
  lengthNm: number,
  turnDeg: number,
): { node: number; angle: number }[] {
  const { positions, parents } = skeleton
  const n = parents.length
  /*
   * Child counts and the last child seen, in one pass — deliberately not `skeletonTree`, which
   * answers the same question with an array per node. Measured on a 200,000-node skeleton, which
   * is an ordinary wavefront one: 13.5 ms against 0.5 ms, per neuron and on the main thread. The
   * out-of-range guard is `skeletonTree`'s and is there for `skeletonTree`'s reason.
   *
   * `lastChild` is only ever read where `children` says there is exactly one, so "the last" and
   * "the only" are the same node — which is why the walk below asks `children[…] === 1` rather
   * than trusting the index on its own.
   */
  const children = new Int32Array(n)
  const lastChild = new Int32Array(n).fill(-1)
  for (let i = 0; i < n; i++) {
    const parent = parents[i]!
    if (parent < 0 || parent >= n) continue
    children[parent]! += 1
    lastChild[parent] = i
  }
  // Precomputed rather than measured inside the walks: ancestors are shared between candidates,
  // so a step computed on demand is computed again for every candidate below it.
  const step = parentDistances(skeleton)

  const found: { node: number; angle: number }[] = []
  for (let i = 0; i < n; i++) {
    if (parents[i]! < 0 || children[i] !== 1) continue
    // Rootwards until far enough, or until there is no more path — in which case it is not asked.
    let up = i
    let walked = 0
    while (parents[up]! >= 0 && parents[up]! < n && walked < lengthNm) {
      walked += step[up]!
      up = parents[up]!
    }
    if (walked < lengthNm) continue
    // And leafwards, stopping at the first branch point or leaf, which is what ends a run.
    let down = i
    walked = 0
    while (children[down] === 1 && walked < lengthNm) {
      down = lastChild[down]!
      walked += step[down]!
    }
    if (walked < lengthNm) continue

    const ax = positions[i * 3]! - positions[up * 3]!
    const ay = positions[i * 3 + 1]! - positions[up * 3 + 1]!
    const az = positions[i * 3 + 2]! - positions[up * 3 + 2]!
    const bx = positions[down * 3]! - positions[i * 3]!
    const by = positions[down * 3 + 1]! - positions[i * 3 + 1]!
    const bz = positions[down * 3 + 2]! - positions[i * 3 + 2]!
    const dot = ax * bx + ay * by + az * bz
    // The `1e-9` is SEAM's, and it is what keeps a zero-length arm from dividing by zero — two
    // nodes at one position, which a resample can leave behind.
    const cos = dot / (Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz) + 1e-9)
    const angle = (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI
    if (angle > turnDeg) found.push({ node: i, angle })
  }
  return found
}

/**
 * Kinks kept greedily, sharpest first, none within `nmsNm` of a tip or of a kept kink.
 *
 * Without it a single bend contributes a kink at every node along it, and a cluster of twenty
 * candidates a micrometre apart is twenty windows scored to answer one question. The exclusion
 * against *tips* matters just as much: a kink beside a tip is the same place, and the tip is the
 * one the calibration was fitted on.
 *
 * Sharpest first because the order decides which of a cluster survives, and the sharpest turn is
 * the best guess at where the real end was.
 */
export function thinKinks(
  skeleton: Pick<SkeletonGeometry, 'positions'>,
  found: readonly { node: number; angle: number }[],
  tips: Int32Array,
  nmsNm: number,
): number[] {
  const at = (node: number): [number, number, number] => [
    skeleton.positions[node * 3]!,
    skeleton.positions[node * 3 + 1]!,
    skeleton.positions[node * 3 + 2]!,
  ]
  const tipPoints = new Float32Array(tips.length * 3)
  for (let i = 0; i < tips.length; i++) tipPoints.set(at(tips[i]!), i * 3)
  const nearTip = tips.length > 0 ? buildKdTree(tipPoints) : undefined

  const kept: number[] = []
  for (const { node } of [...found].sort((a, b) => b.angle - a.angle)) {
    const [x, y, z] = at(node)
    if (nearTip?.hasWithin(x, y, z, nmsNm)) continue
    // Scanned rather than indexed, and read back off `kept` rather than held beside it: the kept
    // list is tens of entries (every pair is more than `nmsNm` apart by construction), and a
    // second array of positions is one more thing that can fall out of step with the first.
    if (
      kept.some((k) => {
        const [kx, ky, kz] = at(k)
        return Math.hypot(kx - x, ky - y, kz - z) <= nmsNm
      })
    ) {
      continue
    }
    kept.push(node)
  }
  return kept
}

/** `tips_on`'s default reach, in nanometres. Ten micrometres is far wider than any radius. */
export const SNAP_WITHIN_NM = 10 * NM_PER_UM

/**
 * The tips of one **already-pruned** skeleton, snapped onto its mesh.
 *
 * Pruned by the caller because that is a Pyodide call (`runSimplifySkeletons`, `prune` at
 * `PRUNE_UM`) and this file is headless. Passing an unpruned skeleton is not an error, it is a
 * different question — every single-node spur comes back as an open end.
 */
export function tipsOf(
  skeleton: Pick<SkeletonGeometry, 'positions' | 'parents'>,
  mesh: Pick<MeshGeometry, 'positions'> | undefined,
  options: TipOptions = {},
): Tips {
  const ends = degreeOneNodes(skeleton.parents)
  const rule = options.rule ?? SEAM_TIP_RULE
  const somaUm = rule.somaUm
  const soma = somaUm > 0 ? options.somaNm : undefined
  const somaSq = somaUm * NM_PER_UM * (somaUm * NM_PER_UM)
  const snapWithin = options.snapWithinNm ?? SNAP_WITHIN_NM
  // Built once for the whole neuron: a mesh is a million vertices and there are hundreds of tips.
  const surface = mesh && mesh.positions.length > 0 ? buildKdTree(mesh.positions) : undefined

  /*
   * Tips first and kinks after, which is `tip_candidates.py`'s order and not an arbitrary one:
   * the thinning excludes a kink that is near a tip, and it reads the tips at their **skeleton**
   * positions, before anything is snapped or soma-masked. Both lists then go through one loop, so
   * a kink is snapped and masked by exactly the rules a tip is.
   */
  const candidates: { node: number; kind: TipKind }[] = Array.from(ends, (node) => ({
    node,
    kind: 'tip' as TipKind,
  }))
  if (options.kinks) {
    const found = kinkNodes(skeleton, rule.kinkLengthUm * NM_PER_UM, rule.kinkTurnDeg)
    for (const node of thinKinks(skeleton, found, ends, rule.kinkNmsUm * NM_PER_UM)) {
      candidates.push({ node, kind: 'kink' })
    }
  }

  const positions: number[] = []
  const fromNode: number[] = []
  const kinds: TipKind[] = []
  let nearSoma = 0
  let unsnapped = 0
  for (const { node, kind } of candidates) {
    let x = skeleton.positions[node * 3]!
    let y = skeleton.positions[node * 3 + 1]!
    let z = skeleton.positions[node * 3 + 2]!
    if (surface) {
      const at = surface.nearestIndex(x, y, z, snapWithin)
      if (at < 0) {
        unsnapped += 1
        continue
      }
      x = mesh!.positions[at * 3]!
      y = mesh!.positions[at * 3 + 1]!
      z = mesh!.positions[at * 3 + 2]!
    }
    // After snapping, as SEAM measures it: the mask is about where the end *is*, and a tip inside
    // a cell body can sit a micrometre from its skeleton node.
    if (soma) {
      const dx = x - soma[0]
      const dy = y - soma[1]
      const dz = z - soma[2]
      if (dx * dx + dy * dy + dz * dz <= somaSq) {
        nearSoma += 1
        continue
      }
    }
    positions.push(x, y, z)
    fromNode.push(node)
    kinds.push(kind)
  }

  return {
    positions: Float32Array.from(positions),
    kinds,
    fromNode: Int32Array.from(fromNode),
    nearSoma,
    kinks: kinds.reduce((count, kind) => count + (kind === 'kink' ? 1 : 0), 0),
    unsnapped,
  }
}
