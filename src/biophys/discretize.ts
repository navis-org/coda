/**
 * A cable tree cut into compartments, the way NEURON cuts one.
 *
 * Knows nothing about neurons, sources or nanometres: the node layer re-roots a skeleton, picks the
 * piece holding the soma, fills radii and converts to micrometres before anything here sees it.
 *
 * ## The structure is NEURON's, deliberately
 *
 * A **section** is the path between two landmarks — the root, a branch point or a leaf — which is
 * also what navis builds its sections from. Each section has `nseg` compartments centred at
 * `(i + ½)/nseg` of its length, plus a **zero-area node at its distal end** that its child sections
 * attach to; the root gets one more. That is NEURON's own node layout, copied rather than
 * approximated so a comparison against NEURON measures the integrator and not two different
 * discretisations. A zero-area node holds no capacitance and no membrane: its equation is just
 * Kirchhoff's law, which the tree solve handles like any other row.
 *
 * ## Area and axial resistance are integrated, not averaged
 *
 * Every skeleton edge is a cone piece between two radii. A compartment's membrane area is the
 * lateral area of the pieces it covers, and the resistance between two neighbouring nodes is
 * `Ra·Δs / (π r₁ r₂)` summed over the pieces between them, with the radius interpolated linearly at
 * every cut — NEURON's treatment of `pt3d` points. A mean-diameter cylinder gets the input
 * resistance wrong wherever the radius tapers.
 *
 * ## Units
 *
 * Positions and radii in µm. Output areas in µm², axial conductances in µS.
 */

import { lowerBound } from '../core/stats'

/** A rooted tree of points with radii, in micrometres. */
export interface CableTree {
  /** xyz interleaved, µm. */
  readonly positions: ArrayLike<number>
  /** µm, every one greater than zero. */
  readonly radii: ArrayLike<number>
  /** Parent per node; exactly one `-1`, the root. Any order. */
  readonly parent: Int32Array
  /**
   * A region label per node, an integer 0–255 (SWC codes, or whatever table the caller keeps);
   * absent means every compartment is region 0.
   */
  readonly labels?: ArrayLike<number>
  /**
   * Per node, the radius the edge into it **begins** at. A node with one **begins a section**
   * there — its parent becomes a landmark even with a single child — because a section start is
   * where NEURON lets a radius jump: one node carries only one radius, and without this a thin
   * fibre leaving a soma would start as a cone from the soma's radius down. Absent, NaN or not
   * positive: no jump, the parent's radius.
   */
  readonly startRadius?: ArrayLike<number>
}

/**
 * How many compartments a section gets.
 *
 * `dLambda` is NEURON's `fixnseg.hoc` exactly — including its `+ 0.9` rounding, which can leave a
 * compartment slightly longer than `dLambda·λ` — so a count can be compared with a NEURON or Jaxley
 * model built by the same rule. `maxLength` is ours: `ceil(L / length)` rounded up to odd, which
 * never leaves a compartment longer than `length` (navis's `1 + 2·int(L / 2·res)` can).
 */
export type SegmentRule =
  | { readonly kind: 'dLambda'; readonly dLambda: number; readonly frequency: number }
  | { readonly kind: 'maxLength'; readonly length: number }

export interface DiscretizeOptions {
  readonly rule: SegmentRule
  /** Axial resistivity, Ω·cm. */
  readonly ra: number
  /** Specific capacitance, µF/cm² — the d_lambda rule's length constant depends on it. */
  readonly cm: number
}

/** One section: its skeleton nodes from the proximal landmark to the distal one. */
export interface Section {
  /** Skeleton nodes in order; `nodes[0]` is the proximal landmark, owned by the parent section. */
  readonly nodes: Int32Array
  readonly nseg: number
  /** Compartment of the section's first segment centre; the rest follow, then its end node. */
  readonly first: number
  /** The section whose end it hangs from; `-1` for a section hung from the root. */
  readonly parentSection: number
  /**
   * Each node's fraction of the way along — NEURON's `x` — with the last node exactly 1. One
   * computation for `nodeCompartment` and anything that places points in NEURON: an `x` of
   * 0.9999… from a second arc sum maps to the last segment centre rather than the end node.
   */
  readonly x: Float64Array
}

export interface CompartmentTree {
  readonly count: number
  /** Parent compartment; `-1` at index 0, the root. Always less than the child's index. */
  readonly parent: Int32Array
  /** Membrane area, µm². Zero at the junction nodes. */
  readonly area: Float64Array
  /** Axial conductance to the parent, µS. Zero at the root. */
  readonly gAxial: Float64Array
  /** Where each compartment sits, µm, xyz interleaved. */
  readonly position: Float64Array
  readonly region: Uint8Array
  /** Per skeleton node, the compartment holding it — NEURON's `sec(x)` rule. */
  readonly nodeCompartment: Int32Array
  /**
   * Per skeleton node, the section holding the edge into it and the node's index there; `-1` and
   * `0` at the root. What `compartmentAt` and a NEURON export locate a point by.
   */
  readonly nodeSection: Int32Array
  readonly nodeIndex: Int32Array
  readonly sections: readonly Section[]
}

/**
 * The compartment at fraction `x` along a section — NEURON's `sec(x)`: the end node at 1, the
 * compartment it hangs from (`attach`) at 0, and otherwise the segment `floor(x·nseg)`.
 */
function compartmentAtX(first: number, nseg: number, attach: number, x: number): number {
  if (x >= 1) return first + nseg
  if (x <= 0) return attach
  return first + Math.min(Math.floor(x * nseg), nseg - 1)
}

/** What `compartmentAt` reads of a tree — enough to keep for placing points later. */
export type PlacingTree = Pick<
  CompartmentTree,
  'parent' | 'sections' | 'nodeSection' | 'nodeIndex'
>

/**
 * The compartment holding a point on the edge from `node`'s parent to `node`, a fraction `t` of the
 * way down it (0 at the parent, 1 at `node`) — the placement `projectSynapses` and
 * `orientPlacement` produce, so a synapse lands where it was projected rather than snapped to a
 * node. At `t = 1` it is `nodeCompartment[node]`, by the same rule.
 */
export function compartmentAt(tree: PlacingTree, node: number, t: number): number {
  const s = tree.nodeSection[node]!
  if (s < 0) return 0
  const section = tree.sections[s]!
  const j = tree.nodeIndex[node]!
  const x = t >= 1 ? section.x[j]! : section.x[j - 1]! + t * (section.x[j]! - section.x[j - 1]!)
  return compartmentAtX(section.first, section.nseg, tree.parent[section.first]!, x)
}

/** `Ra·Δs/(π r₁ r₂)` in Ω·cm·µm/µm² is this many MΩ. */
const MOHM_PER_RA_UM = 1e-2

/**
 * The smallest axial resistance, MΩ. Only a section of zero length reaches it — two coincident
 * landmarks — since a half segment integrates over everything it covers; its resistance would be
 * zero and its conductance infinite. The floor keeps the solve finite while still joining the two
 * ends far more tightly than any real cable would. Merging coincident nodes is the caller's job.
 */
const MIN_AXIAL_MOHM = 1e-6

export function discretize(tree: CableTree, options: DiscretizeOptions): CompartmentTree {
  const { positions, radii, parent: delivered, labels } = tree
  const n = delivered.length
  if (radii.length !== n || positions.length !== n * 3) {
    throw new Error('positions, radii and parent must describe the same nodes.')
  }

  let root = -1
  for (let i = 0; i < n; i++) {
    const p = delivered[i]!
    if (p === -1) {
      if (root >= 0) throw new Error('A cable tree must have exactly one root.')
      root = i
    } else if (p < 0 || p >= n) {
      throw new Error(`Node ${i} has a parent outside the tree.`)
    }
    if (!(radii[i]! > 0)) throw new Error(`Node ${i} has no radius.`)
    // A Uint8Array wraps silently: −1 would become region 255.
    if (labels && !(Number.isInteger(labels[i]) && labels[i]! >= 0 && labels[i]! <= 255)) {
      throw new Error(`Node ${i} has a label outside 0–255.`)
    }
  }
  if (tree.startRadius && tree.startRadius.length !== n) {
    throw new Error('startRadius must have one entry per node.')
  }
  if (root < 0) throw new Error('A cable tree must have exactly one root.')

  // Children as CSR.
  const childStart = new Int32Array(n + 1)
  for (let i = 0; i < n; i++) if (i !== root) childStart[delivered[i]! + 1]!++
  for (let i = 0; i < n; i++) childStart[i + 1]! += childStart[i]!
  const cursor = childStart.slice(0, n)
  const childList = new Int32Array(Math.max(0, n - 1))
  for (let i = 0; i < n; i++) if (i !== root) childList[cursor[delivered[i]!]!++] = i
  const childCount = (v: number) => childStart[v + 1]! - childStart[v]!
  /** The radius the edge into `v` starts at, where it has one of its own. */
  const ownStart = (v: number) => {
    const r = tree.startRadius?.[v]
    return r !== undefined && r > 0 ? r : undefined
  }
  // A single child starting at a radius of its own begins a section, so its parent ends one.
  const isLandmark = (v: number) =>
    v === root || childCount(v) !== 1 || ownStart(childList[childStart[v]!]!) !== undefined

  const label = (v: number) => (labels ? labels[v]! : 0)

  // Grow the compartment arrays as sections are cut; the final count is unknown up front.
  const parent: number[] = [-1]
  const area: number[] = [0]
  const gAxial: number[] = [0]
  const position: number[] = [
    positions[root * 3]!,
    positions[root * 3 + 1]!,
    positions[root * 3 + 2]!,
  ]
  const region: number[] = [label(root)]
  const nodeCompartment = new Int32Array(n).fill(-1)
  nodeCompartment[root] = 0
  const nodeSection = new Int32Array(n).fill(-1)
  const nodeIndex = new Int32Array(n)
  const sections: Section[] = []

  // Landmark → its junction compartment (the root's, or the end node of the section it ends), and
  // the section it ends (-1 for the root).
  const junction = new Int32Array(n).fill(-1)
  junction[root] = 0
  const ending = new Int32Array(n).fill(-1)

  let visited = 1
  const stack = [root]
  while (stack.length > 0) {
    const p = stack.pop()!
    for (let k = childStart[p]!; k < childStart[p + 1]!; k++) {
      // Walk down from `p` through slab nodes to the next landmark.
      const path = [p]
      let v = childList[k]!
      for (;;) {
        path.push(v)
        visited++
        if (isLandmark(v)) break
        v = childList[childStart[v]!]!
      }
      const section = cutSection(Int32Array.from(path), junction[p]!, ending[p]!)
      ending[v] = sections.length
      sections.push(section)
      junction[v] = section.first + section.nseg
      stack.push(v)
    }
  }
  if (visited !== n) throw new Error('A cable tree must be connected and acyclic.')

  /** Append one section's compartments and map its nodes onto them. */
  function cutSection(nodes: Int32Array, attach: number, parentSection: number): Section {
    const m = nodes.length
    const arc = new Float64Array(m)
    for (let j = 1; j < m; j++) {
      const a = nodes[j - 1]! * 3
      const b = nodes[j]! * 3
      const dx = positions[b]! - positions[a]!
      const dy = positions[b + 1]! - positions[a + 1]!
      const dz = positions[b + 2]! - positions[a + 2]!
      arc[j] = arc[j - 1]! + Math.sqrt(dx * dx + dy * dy + dz * dz)
    }
    const length = arc[m - 1]!
    // A section may begin at a radius of its own (`startRadius`); every other point is its node's.
    const start = ownStart(nodes[1]!) ?? radii[nodes[0]!]!
    const r = (j: number) => (j === 0 ? start : radii[nodes[j]!]!)

    const nseg = segmentCount(options, length, arc, r)

    /** Index of the piece (j−1, j) holding arc position `s`: the first j ≥ 1 with arc[j] ≥ s. */
    const pieceAt = (s: number) => Math.min(m - 1, Math.max(1, lowerBound(arc, s)))
    /** The piece holding `s` and how far along it `s` is, 0 to 1. */
    const locate = (s: number) => {
      const j = pieceAt(s)
      const span = arc[j]! - arc[j - 1]!
      return { j, t: span > 0 ? (s - arc[j - 1]!) / span : 1 }
    }
    const radiusAt = (s: number) => {
      const { j, t } = locate(s)
      return r(j - 1) + t * (r(j) - r(j - 1))
    }
    /**
     * Lateral area (µm²) and axial resistance (MΩ) of the cable between arc positions a < b.
     *
     * Two nodes at one point with different radii have no length and no resistance, but the
     * annulus between the two discs is membrane, as NEURON's pt3d counts it, and the taper after
     * it runs from the second node's radius. **An annulus belongs to the integration that ends at
     * its point** — NEURON's rule where a cut falls on one — and one at a section's very start to
     * its first: so wherever the pair sits, inside, at a cut, or at either end, it is counted once.
     */
    const integrate = (a: number, b: number) => {
      let lateral = 0
      let resistance = 0
      let j: number
      let r0: number
      if (a === 0) {
        j = 1
        r0 = r(0)
      } else {
        j = pieceAt(a)
        if (arc[j] === a) {
          // On a node: start past it and any node coincident with it, whose annuli were counted
          // by the integration that ended here.
          while (j + 1 < m && arc[j + 1] === a) j++
          r0 = r(j)
          j++
        } else {
          r0 = radiusAt(a)
        }
      }
      let s0 = a
      for (; j < m; j++) {
        const zero = arc[j] === arc[j - 1]
        // Past b — but a zero-length piece *at* b is still this integration's.
        if (arc[j - 1]! > b || (arc[j - 1]! >= b && !zero)) break
        if (zero) {
          lateral += Math.PI * Math.abs(r(j) ** 2 - r0 ** 2)
          r0 = r(j)
          continue
        }
        const s1 = Math.min(arc[j]!, b)
        if (s1 <= s0) continue
        const r1 = s1 === arc[j]! ? r(j) : radiusAt(s1)
        const ds = s1 - s0
        lateral += Math.PI * (r0 + r1) * Math.sqrt((r1 - r0) ** 2 + ds * ds)
        resistance += (MOHM_PER_RA_UM * options.ra * ds) / (Math.PI * r0 * r1)
        s0 = s1
        r0 = r1
      }
      return { lateral, resistance }
    }
    const pointAt = (s: number): [number, number, number] => {
      const { j, t } = locate(s)
      const a = nodes[j - 1]! * 3
      const b = nodes[j]! * 3
      return [
        positions[a]! + t * (positions[b]! - positions[a]!),
        positions[a + 1]! + t * (positions[b + 1]! - positions[a + 1]!),
        positions[a + 2]! + t * (positions[b + 2]! - positions[a + 2]!),
      ]
    }
    /**
     * The skeleton node nearest arc position `s`, a tie going to the lower node index. Nearest
     * rather than "the piece's distal end" because distal flips when the tree is re-rooted, and a
     * channel placed by region must not move half a compartment with the choice of root.
     */
    const nearestNode = (s: number) => {
      const j = pieceAt(s)
      const a = nodes[j - 1]!
      const b = nodes[j]!
      // A section's first node is the junction it hangs from, which is its parent section's (or
      // the root's own compartment): never this section's label. Taken by nearness, a long first
      // edge out of a labelled soma came out soma — soma-only channels and all — under Fixed length.
      if (j === 1) return b
      const toA = s - arc[j - 1]!
      const toB = arc[j]! - s
      return toA < toB ? a : toB < toA ? b : Math.min(a, b)
    }
    const g = (resistance: number) => 1 / Math.max(resistance, MIN_AXIAL_MOHM)

    const first = parent.length
    const step = length / nseg
    for (let i = 0; i < nseg; i++) {
      const centre = (i + 0.5) * step
      const from = i === 0 ? 0 : (i - 0.5) * step
      parent.push(i === 0 ? attach : first + i - 1)
      // The last segment ends at `length` exactly, not at nseg·step's rounding of it, so the end of
      // the cable — and an annulus there — is never a hair beyond the last integration.
      area.push(integrate(i * step, i === nseg - 1 ? length : (i + 1) * step).lateral)
      gAxial.push(g(integrate(from, centre).resistance))
      position.push(...pointAt(centre))
      region.push(label(nearestNode(centre)))
    }
    // The zero-area end node, half a compartment beyond the last centre.
    const end = first + nseg
    parent.push(end - 1)
    area.push(0)
    gAxial.push(g(integrate((nseg - 0.5) * step, length).resistance))
    const last = nodes[m - 1]!
    position.push(positions[last * 3]!, positions[last * 3 + 1]!, positions[last * 3 + 2]!)
    region.push(label(last))

    const x = Float64Array.from(arc, (s, j) => (j === m - 1 || !(length > 0) ? 1 : s / length))
    for (let j = 1; j < m; j++) {
      nodeCompartment[nodes[j]!] = compartmentAtX(first, nseg, attach, x[j]!)
      nodeSection[nodes[j]!] = sections.length
      nodeIndex[nodes[j]!] = j
    }

    return { nodes, nseg, first, parentSection, x }
  }

  return {
    count: parent.length,
    parent: Int32Array.from(parent),
    area: Float64Array.from(area),
    gAxial: Float64Array.from(gAxial),
    position: Float64Array.from(position),
    region: Uint8Array.from(region),
    nodeCompartment,
    nodeSection,
    nodeIndex,
    sections,
  }
}

/** The compartment count for one section, by the rule chosen. Always odd and at least one. */
function segmentCount(
  options: DiscretizeOptions,
  length: number,
  arc: Float64Array,
  r: (j: number) => number,
): number {
  const { rule } = options
  if (rule.kind === 'maxLength') {
    const nseg = Math.max(1, Math.ceil(length / rule.length))
    return nseg % 2 === 0 ? nseg + 1 : nseg
  }
  // fixnseg.hoc's lambda_f over 3d points: Σ Δx / √(d₁ + d₂), scaled. Diameters, so 2r.
  let lam = 0
  for (let j = 1; j < arc.length; j++) {
    lam += (arc[j]! - arc[j - 1]!) / Math.sqrt(2 * r(j - 1) + 2 * r(j))
  }
  lam *= Math.SQRT2 * 1e-5 * Math.sqrt(4 * Math.PI * rule.frequency * options.ra * options.cm)
  // L / (d_lambda · lambda_f) = lam / d_lambda, lambda_f being L / lam.
  return Math.floor((lam / rule.dLambda + 0.9) / 2) * 2 + 1
}
