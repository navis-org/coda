/**
 * Where to cut a neuron so that two points end up in different objects — read off the
 * segmentation's own affinities rather than a min-cut.
 *
 * **Why not CAVE's min-cut.** A split (`pychunkedgraph/graph/cutting.py`) finds the edges of least
 * *total* affinity separating the points. Two things follow, both seen live (2026-11-22):
 *
 * - The stored affinity is a sum over the contact face, so total affinity is mostly contact
 *   *size*: the cheapest cut is the thinnest neck near either point, however strong its contact.
 *   On FANC the preview cut 19 supervoxels off from 8,029.
 * - A proofreader's merge is stored with affinity ~0 and area 0, so it is cut before any real
 *   contact. On the FANC preview both cut edges were proofreader merges.
 *
 * **The agglomeration again.** The segmentation was built by merging supervoxels in order of
 * *mean* affinity across their shared boundary (sum of affinity ÷ sum of area, re-summed as
 * regions grow) — waterz's mean-affinity agglomeration. This replays it on the neuron's own
 * supervoxels, twice:
 *
 * - **Constrained** (`cut`): a region holding a source may never merge with one holding a sink, so
 *   every supervoxel grows onto one side or the other and the edges left between them separate
 *   the points. It inherits min-cut's weakness in another form: where a point sits on a small
 *   piece weakly attached to its own neuron, the two neurons' bulk merges first (neither holds a
 *   point) and the cut falls around the small piece. Five of nine FANC splits tested 15 µm out
 *   went that way.
 * - **Unconstrained** (`candidates`): the plain agglomeration, recording each step on the way up
 *   from either point to where the two first share a region. A false merge is such a step where
 *   two *large* regions joined at a low mean affinity; a step where a point's region took in a
 *   small piece is not one (`minPiece`). Candidates are those steps, weakest first, each with the
 *   boundary between its two regions at that moment as its cut.
 *
 * Pure: the graph in, cuts out. Fetching is `splitSitesRun.ts`; positions come from outside
 * (`groupSites`), since the graph carries none.
 */

import { groupBy } from '../../core/collections'
import type { SupervoxelGraph } from '../../data/cave/subgraph'
import { edgeKind } from '../../data/cave/subgraph'

/**
 * What a proofreader's merge counts for.
 *
 * `trust` merges across it before any contact is weighed — a human said these belong together —
 * so the cut goes elsewhere unless a merge directly joins a source region to a sink region.
 * `distrust` weighs it as a contact with nothing measured, the last thing merged — CAVE's own
 * reading, so the cut takes it first.
 */
export type UserMergePolicy = 'trust' | 'distrust'

export interface SplitSitesInput {
  readonly graph: SupervoxelGraph
  /** Supervoxels that must end up on the source side. */
  readonly sources: readonly string[]
  /** Supervoxels that must end up on the sink side. */
  readonly sinks: readonly string[]
  readonly userMerges?: UserMergePolicy
  /** Smallest region, in supervoxels, a candidate step may join on either side. */
  readonly minPiece?: number
  /** How many candidates to return. */
  readonly maxCandidates?: number
  /**
   * The supervoxels the points were actually on, where `sources`/`sinks` are wider seeds (a
   * point's level-2 piece). A seed sharing an atom with the other side's seeds — a supervoxel cut
   * by the chunk border between two neighbouring pieces — is dropped, unless it is an anchor; only
   * anchors on one atom are refused as one supervoxel.
   */
  readonly anchors?: { readonly sources: readonly string[]; readonly sinks: readonly string[] }
}

/** Default `minPiece`: a step taking in fewer supervoxels is a fragment, not an object. */
export const MIN_PIECE = 20

/** Default `maxCandidates`. */
export const MAX_CANDIDATES = 10

/** One edge of a cut, source side first. */
export interface CutEdge {
  readonly source: string
  readonly sink: string
  /** Summed affinity over the contact; ~0 on a proofreader's merge. */
  readonly affinity: number
  /** Contact area in voxel faces; 0 on a proofreader's merge. */
  readonly area: number
  /** A proofreader's merge rather than a measured contact. */
  readonly userMerge: boolean
}

/** A refused merge: the boundary between a source region and a sink region when it came up. */
export interface Refusal {
  /** Its mean affinity then; `Infinity` for a trusted proofreader's merge. */
  readonly score: number
  readonly area: number
  readonly userMerges: number
}

/**
 * A step of the plain agglomeration on the way from a point to where both points share a region:
 * the region holding the point took in another, or (`point: 'both'`) the two points' regions met.
 */
export interface Candidate {
  /** Mean affinity of the boundary when the step was taken; `Infinity` for a trusted merge. */
  readonly score: number
  /** Whose region took the step. */
  readonly point: 'source' | 'sink' | 'both'
  /** Supervoxels in the point's region, and in the region it took in. */
  readonly sizes: readonly [number, number]
  /**
   * The boundary between the two regions, oriented source side first: for a step on the sink's
   * side, the region taken in is the `source` end.
   */
  readonly cut: readonly CutEdge[]
}

export type SplitSitesResult =
  | {
      readonly ok: true
      /** Supervoxels on each side of the constrained cut, and on neither. */
      readonly counts: {
        readonly source: number
        readonly sink: number
        readonly neither: number
      }
      /** The supervoxels on the source side and on the sink side. */
      readonly sides: readonly [readonly string[], readonly string[]]
      /** The constrained cut: the edges left between the two sides. */
      readonly cut: readonly CutEdge[]
      /**
       * Refused merges, in the order they came up — one entry per time a boundary between the
       * sides was popped, so one boundary that grew recurs, re-scored. Diagnostic: the first is
       * the strongest boundary between the two sides, where the agglomerator would have joined
       * them first.
       */
      readonly refusals: readonly Refusal[]
      /** Steps of the plain agglomeration joining two large regions, weakest first. */
      readonly candidates: readonly Candidate[]
      /**
       * Whether affinity is contact area under another name (≥ 90% of edges within 1% of a mean
       * affinity of 1, as MICrONS stores it). Then a "mean affinity" is 1 everywhere and the
       * order means little — said, not hidden.
       */
      readonly affinityIsArea: boolean
    }
  | {
      readonly ok: false
      readonly reason: 'no-points' | 'point-not-in-graph' | 'same-supervoxel' | 'not-connected'
      readonly message: string
    }

/** Shared boundary between two live regions. One object per pair, moved as regions merge. */
interface Pair {
  r1: number
  r2: number
  affinity: number
  area: number
  userMerges: number
  version: number
  dead: boolean
}

interface Entry {
  readonly score: number
  readonly pair: Pair
  readonly version: number
}

/** The root of `i` in a union-find over `parent`, halving the path on the way. */
export function findRoot(parent: Int32Array, i: number): number {
  while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!
  return i
}

/** Join `x`'s set and `y`'s in a union-find over `parent`; `x`'s root stays the root. */
export function unite(parent: Int32Array, x: number, y: number): void {
  const rx = findRoot(parent, x)
  const ry = findRoot(parent, y)
  if (rx !== ry) parent[ry] = rx
}

/** Edge kinds in `Prepared.kind`. */
const MEASURED = 0
const USER_MERGE = 1
/** Infinite, a NaN affinity or area, or inside one atom: never a boundary. */
const SKIPPED = 2

/** The graph on dense indices, with chunk-border pieces of one supervoxel joined into atoms. */
interface Prepared {
  readonly graph: SupervoxelGraph
  readonly ids: readonly string[]
  readonly index: ReadonlyMap<string, number>
  readonly n: number
  readonly ea: Int32Array
  readonly eb: Int32Array
  /** Each supervoxel's atom (the representative index). */
  readonly atom: Int32Array
  /** Supervoxels per atom, at the atom's representative. */
  readonly atomSize: Int32Array
  /** Per edge: `MEASURED`, `USER_MERGE` or `SKIPPED`. */
  readonly kind: Uint8Array
  readonly affinityIsArea: boolean
}

/** Prepared once per graph: a caller cutting one graph many times (the split gallery) pays once. */
const PREPARED = new WeakMap<SupervoxelGraph, Prepared>()

function prepare(graph: SupervoxelGraph): Prepared {
  const held = PREPARED.get(graph)
  if (held) return held
  const prepared = prepareAnew(graph)
  PREPARED.set(graph, prepared)
  return prepared
}

function prepareAnew(graph: SupervoxelGraph): Prepared {
  const index = new Map<string, number>()
  const ids: string[] = []
  const indexOf = (id: string): number => {
    let at = index.get(id)
    if (at === undefined) {
      at = ids.length
      index.set(id, at)
      ids.push(id)
    }
    return at
  }
  const m = graph.a.length
  const ea = new Int32Array(m)
  const eb = new Int32Array(m)
  for (let i = 0; i < m; i++) {
    ea[i] = indexOf(graph.a[i]!)
    eb[i] = indexOf(graph.b[i]!)
  }
  const n = ids.length

  // Atoms: pieces of one supervoxel cut by chunk borders (infinite affinity) are one, never cut.
  const parent = Int32Array.from({ length: n }, (_, i) => i)
  const find = (i: number): number => findRoot(parent, i)
  for (let i = 0; i < m; i++) {
    if (edgeKind(graph.affinity[i]!, graph.area[i]!) === 'piece') unite(parent, ea[i]!, eb[i]!)
  }
  const atom = Int32Array.from({ length: n }, (_, i) => find(i))
  const atomSize = new Int32Array(n)
  for (let i = 0; i < n; i++) atomSize[atom[i]!]!++

  const kind = new Uint8Array(m)
  let measured = 0
  let areaLike = 0
  for (let i = 0; i < m; i++) {
    const affinity = graph.affinity[i]!
    const area = graph.area[i]!
    const edge = edgeKind(affinity, area)
    if (edge === 'piece' || edge === 'unread' || atom[ea[i]!] === atom[eb[i]!]) {
      kind[i] = SKIPPED
    } else if (edge === 'userMerge') {
      kind[i] = USER_MERGE
    } else {
      measured++
      if (Math.abs(affinity / area - 1) < 0.01) areaLike++
    }
  }
  return {
    graph,
    ids,
    index,
    n,
    ea,
    eb,
    atom,
    atomSize,
    kind,
    affinityIsArea: measured > 0 && areaLike / measured >= 0.9,
  }
}

/** All edges, or a subset of them by index — a window along the path (`pathCuts`). */
type EdgeSet = ArrayLike<number> | undefined

function forEachEdge(p: Prepared, edges: EdgeSet, visit: (i: number) => void): void {
  if (edges) for (let k = 0; k < edges.length; k++) visit(edges[k]!)
  else for (let i = 0; i < p.ea.length; i++) visit(i)
}

/**
 * Mean-affinity agglomeration over the atoms: pop the strongest boundary, ask `merge`, merge or
 * drop it, re-sum the boundaries the merge changed. `flags` (1 source, 2 sink) are per region
 * representative and grow as regions merge, so `merge` can read them live. `onMerge` hears each
 * merge before it happens, with the two regions' flags and sizes then. Answers the live region
 * each atom ended in.
 */
function agglomerate(
  p: Prepared,
  policy: UserMergePolicy,
  flags: Uint8Array,
  merge: (pair: Pair, score: number) => boolean,
  onMerge?: (keep: number, gone: number, score: number, size: Int32Array) => void,
  edges?: EdgeSet,
): (atom: number) => number {
  const { n, ea, eb, atom, kind, graph } = p
  const adjacency: Array<Map<number, Pair> | undefined> = new Array(n)
  const adj = (r: number): Map<number, Pair> => {
    let map = adjacency[r]
    if (!map) adjacency[r] = map = new Map()
    return map
  }
  forEachEdge(p, edges, (i) => {
    if (kind[i] === SKIPPED) return
    const x = atom[ea[i]!]!
    const y = atom[eb[i]!]!
    let pair = adj(x).get(y)
    if (!pair) {
      pair = { r1: x, r2: y, affinity: 0, area: 0, userMerges: 0, version: 0, dead: false }
      adj(x).set(y, pair)
      adj(y).set(x, pair)
    }
    if (kind[i] === USER_MERGE) pair.userMerges++
    else {
      pair.affinity += graph.affinity[i]!
      pair.area += graph.area[i]!
    }
  })

  const score = (pair: Pair): number => {
    if (pair.userMerges > 0 && policy === 'trust') return Infinity
    if (pair.area > 0) return pair.affinity / pair.area
    return -Infinity
  }
  const size = Int32Array.from(p.atomSize)
  const parent = Int32Array.from(atom)
  const regionOf = (i: number): number => findRoot(parent, i)

  const heap = new MaxHeap()
  for (let r = 0; r < n; r++) {
    for (const [other, pair] of adjacency[r] ?? []) {
      if (other > r) heap.push({ score: score(pair), pair, version: pair.version })
    }
  }

  for (let entry = heap.pop(); entry; entry = heap.pop()) {
    const { pair } = entry
    if (pair.dead || pair.version !== entry.version) continue
    if (!merge(pair, entry.score)) continue
    // Merge the region with fewer neighbours into the one with more, so each move is cheap.
    let keep = pair.r1
    let gone = pair.r2
    if (adj(keep).size < adj(gone).size) [keep, gone] = [gone, keep]
    onMerge?.(keep, gone, entry.score, size)
    flags[keep]! |= flags[gone]!
    size[keep]! += size[gone]!
    parent[gone] = keep
    pair.dead = true
    adj(keep).delete(gone)
    const moving = adj(gone)
    moving.delete(keep)
    for (const [other, moved] of moving) {
      const others = adj(other)
      others.delete(gone)
      const existing = adj(keep).get(other)
      if (existing) {
        existing.affinity += moved.affinity
        existing.area += moved.area
        existing.userMerges += moved.userMerges
        existing.version++
        moved.dead = true
        heap.push({ score: score(existing), pair: existing, version: existing.version })
      } else {
        moved.r1 = keep
        moved.r2 = other
        moved.version++
        adj(keep).set(other, moved)
        others.set(keep, moved)
        heap.push({ score: score(moved), pair: moved, version: moved.version })
      }
    }
    adjacency[gone] = undefined
  }
  return regionOf
}

/** Side flags per atom: 1 for an atom holding a source, 2 for one holding a sink. */
function pointFlags(
  p: Prepared,
  sources: readonly string[],
  sinks: readonly string[],
): Uint8Array {
  const flags = new Uint8Array(p.n)
  for (const id of sources) flags[p.atom[p.index.get(id)!]!]! |= 1
  for (const id of sinks) flags[p.atom[p.index.get(id)!]!]! |= 2
  return flags
}

/** Indices of the edges between two marked sets of supervoxels (`mark` 1 and 2). */
function cutIndices(p: Prepared, mark: Uint8Array, edges?: EdgeSet): number[] {
  const cut: number[] = []
  forEachEdge(p, edges, (i) => {
    if (p.kind[i] === SKIPPED) return
    if ((mark[p.ea[i]!]! | mark[p.eb[i]!]!) === 3) cut.push(i)
  })
  return cut
}

/**
 * The cut between two given sets of supervoxels — another tool's split, say CAVE's preview —
 * over this graph, classified as every cut here is: source set first, pieces of one supervoxel
 * and unreadable edges left out. An edge with an end in neither set is not in it.
 */
export function cutAcross(
  graph: SupervoxelGraph,
  sources: ReadonlySet<string>,
  sinks: ReadonlySet<string>,
): CutEdge[] {
  const p = prepare(graph)
  const mark = Uint8Array.from(p.ids, (id) => (sources.has(id) ? 1 : sinks.has(id) ? 2 : 0))
  return cutEdges(p, mark, cutIndices(p, mark))
}

/** Edges by index as `CutEdge`s, the mark-1 end first. */
function cutEdges(p: Prepared, mark: Uint8Array, indices: readonly number[]): CutEdge[] {
  const { graph } = p
  return indices.map((i) => {
    const forward = mark[p.ea[i]!] === 1
    return {
      source: forward ? graph.a[i]! : graph.b[i]!,
      sink: forward ? graph.b[i]! : graph.a[i]!,
      affinity: graph.affinity[i]!,
      area: graph.area[i]!,
      userMerge: p.kind[i] === USER_MERGE,
    }
  })
}

export function splitSites(given: SplitSitesInput): SplitSitesResult {
  const { graph } = given
  const policy = given.userMerges ?? 'trust'
  if (given.sources.length === 0 || given.sinks.length === 0) {
    return { ok: false, reason: 'no-points', message: 'A split needs a point on each side.' }
  }
  const p = prepare(graph)
  const anchors = [...(given.anchors?.sources ?? []), ...(given.anchors?.sinks ?? [])]
  for (const id of [...given.sources, ...given.sinks, ...anchors]) {
    if (!p.index.has(id)) {
      return {
        ok: false,
        reason: 'point-not-in-graph',
        message: `Supervoxel ${id} is not in the neuron's graph inside the box.`,
      }
    }
  }
  const input = withoutClashingSeeds(p, given)
  const { sources, sinks } = input
  // `agglomerate` grows the flags it is handed as regions merge, so `merge` reads them live.
  const flags = pointFlags(p, sources, sinks)
  if (flags.some((f) => f === 3)) {
    return {
      ok: false,
      reason: 'same-supervoxel',
      message:
        'A source and a sink are on one supervoxel, which no cut between supervoxels can ' +
        'separate. Move a point, or split the supervoxel itself.',
    }
  }

  // Constrained: a source region never merges with a sink region.
  const refusals: Refusal[] = []
  const regionOf = agglomerate(p, policy, flags, (pair, score) => {
    if ((flags[pair.r1]! | flags[pair.r2]!) !== 3) return true
    refusals.push({ score, area: pair.area, userMerges: pair.userMerges })
    return false
  })
  const mark = new Uint8Array(p.n)
  const sides: [string[], string[]] = [[], []]
  let neither = 0
  for (let i = 0; i < p.n; i++) {
    const s = flags[regionOf(p.atom[i]!)]!
    mark[i] = s
    if (s === 1 || s === 2) sides[s - 1]!.push(p.ids[i]!)
    else neither++
  }
  const counts = { source: sides[0].length, sink: sides[1].length, neither }
  const cut = cutEdges(p, mark, cutIndices(p, mark))
  if (cut.length === 0) {
    return {
      ok: false,
      reason: 'not-connected',
      message:
        'Inside the box the two points are not joined, so there is nothing here to cut. They may ' +
        'join outside it: widen the box.',
    }
  }

  return {
    ok: true,
    counts,
    sides,
    cut,
    refusals,
    candidates: input.maxCandidates === 0 ? [] : candidatesOf(p, input),
    affinityIsArea: p.affinityIsArea,
  }
}

/**
 * The input with every seed dropped whose atom also holds a seed of the other side, anchors
 * excepted (`SplitSitesInput.anchors`). Without anchors, the input as given.
 */
function withoutClashingSeeds(p: Prepared, input: SplitSitesInput): SplitSitesInput {
  if (!input.anchors) return input
  const flags = pointFlags(p, input.sources, input.sinks)
  if (!flags.some((f) => f === 3)) return input
  const anchored = new Set([...input.anchors.sources, ...input.anchors.sinks])
  const keep = (id: string) => anchored.has(id) || flags[p.atom[p.index.get(id)!]!] !== 3
  return {
    ...input,
    sources: [...new Set([...input.sources.filter(keep), ...input.anchors.sources])],
    sinks: [...new Set([...input.sinks.filter(keep), ...input.anchors.sinks])],
  }
}

/**
 * The plain agglomeration with its merge tree recorded: leaves are atoms, each merge a node over
 * the two regions' nodes. `onStep` hears each merge before it happens — the two regions'
 * representatives, their current tree nodes and sizes, and the flags as they were. Answers the
 * boundary between the leaves of any two nodes, the first node's end first.
 */
function mergeTree(
  p: Prepared,
  policy: UserMergePolicy,
  flags: Uint8Array,
  onStep: (step: {
    score: number
    keep: number
    gone: number
    node: Int32Array
    size: Int32Array
  }) => void,
): (first: number, second: number) => CutEdge[] {
  const node = Int32Array.from({ length: p.n }, (_, i) => i)
  const left: number[] = []
  const right: number[] = []
  agglomerate(
    p,
    policy,
    flags,
    () => true,
    (keep, gone, score, size) => {
      onStep({ score, keep, gone, node, size })
      left.push(node[keep]!)
      right.push(node[gone]!)
      node[keep] = p.n + left.length - 1
    },
  )
  return (first, second) => {
    const atomMark = new Uint8Array(p.n)
    for (const [start, value] of [
      [first, 1],
      [second, 2],
    ] as const) {
      const stack = [start]
      while (stack.length) {
        const at = stack.pop()!
        if (at < p.n) atomMark[at] = value
        else stack.push(left[at - p.n]!, right[at - p.n]!)
      }
    }
    const mark = new Uint8Array(p.n)
    for (let i = 0; i < p.n; i++) mark[i] = atomMark[p.atom[i]!]!
    return cutEdges(p, mark, cutIndices(p, mark))
  }
}

/**
 * The plain agglomeration's steps on the way up from either point. A step is kept as a candidate
 * where both regions hold at least `minPiece` supervoxels; its cut is the boundary between them.
 */
function candidatesOf(p: Prepared, input: SplitSitesInput): Candidate[] {
  const minPiece = input.minPiece ?? MIN_PIECE
  const steps: Array<{
    score: number
    point: Candidate['point']
    /** The two regions' tree nodes, source side first. */
    nodes: [number, number]
    sizes: [number, number]
  }> = []
  const flags = pointFlags(p, input.sources, input.sinks)
  const cutBetween = mergeTree(p, input.userMerges ?? 'trust', flags, (step) => {
    const { keep, gone, node, size } = step
    const fk = flags[keep]!
    const fg = flags[gone]!
    // A step on a point's way up: exactly one side holds that point, and the two have not met.
    if ((fk | fg) === 0 || fk === 3 || fg === 3 || (fk === fg && fk !== 0)) return
    const point = (fk | fg) === 3 ? 'both' : (fk | fg) === 1 ? 'source' : 'sink'
    // The region holding the point (on a meeting, the source's), and the one it takes in.
    const own = point === 'sink' ? (fk ? keep : gone) : fk & 1 ? keep : gone
    const other = own === keep ? gone : keep
    // Source side first: on the sink's way up, the region taken in is the source end.
    const [first, second] = point === 'sink' ? [other, own] : [own, other]
    steps.push({
      score: step.score,
      point,
      nodes: [node[first]!, node[second]!],
      sizes: [size[own]!, size[other]!],
    })
  })
  return steps
    .filter((s) => Math.min(...s.sizes) >= minPiece)
    .sort((x, y) => x.score - y.score)
    .slice(0, input.maxCandidates ?? MAX_CANDIDATES)
    .map((step) => ({
      score: step.score,
      point: step.point,
      sizes: step.sizes,
      cut: cutBetween(...step.nodes),
    }))
}

/**
 * How small a cut is next to what its supervoxels touch on their own side.
 *
 * For each side, the cut's area over the summed area the cut's atoms on that side share with the
 * rest of their own side (measured contacts only; pieces of one supervoxel count as one). Through
 * a real thin neck the atoms at the cut touch their own side about as much as they touch across,
 * so both ratios are near 1. Where one neurite runs past the other, the atoms on that side are
 * mostly in contact with their own neurite and the ratio there is small. `Infinity` on a side
 * whose cut atoms touch nothing else on their side (a tip).
 *
 * Tried as a false-merge signal on Aedes (2026-11-22) and did not generalise
 * (`docs/split-sites-plan.md`); kept for the next ranking.
 */
export interface ContactRatio {
  readonly source: number
  readonly sink: number
  /** The smaller of the two: low where at least one neurite runs past the contact. */
  readonly least: number
}

function contactRatio(
  p: Prepared,
  mark: Uint8Array,
  cut: readonly number[],
  edges: EdgeSet,
): ContactRatio {
  let cutArea = 0
  const ends = [new Set<number>(), new Set<number>()]
  for (const i of cut) {
    if (p.kind[i] !== MEASURED) continue
    cutArea += p.graph.area[i]!
    for (const v of [p.ea[i]!, p.eb[i]!]) ends[mark[v]! - 1]!.add(p.atom[v]!)
  }
  const own = [0, 0]
  forEachEdge(p, edges, (i) => {
    if (p.kind[i] !== MEASURED) return
    const side = mark[p.ea[i]!]!
    if (side === 0 || side !== mark[p.eb[i]!]) return
    const k = side - 1
    // An edge between two of the cut's own atoms counts once.
    if (ends[k]!.has(p.atom[p.ea[i]!]!) || ends[k]!.has(p.atom[p.eb[i]!]!)) {
      own[k]! += p.graph.area[i]!
    }
  })
  const ratio = (k: number) => (own[k]! > 0 ? cutArea / own[k]! : Infinity)
  const source = ratio(0)
  const sink = ratio(1)
  return { source, sink, least: Math.min(source, sink) }
}

/** A cut found by sliding a window along the path (`pathCuts`). */
export interface PathCut {
  /** Path positions of the window's two ends; the cut lies between them. */
  readonly window: readonly [number, number]
  readonly cut: readonly CutEdge[]
  /** Summed affinity ÷ summed area over its measured contacts; undefined where it has none. */
  readonly meanAffinity: number | undefined
  readonly area: number
  readonly contact: ContactRatio
}

/**
 * **Experimental: every bottleneck along the path.** For each window of `2·half + 1` path
 * positions, the constrained cut between the supervoxels just before it and just after it, on the
 * graph restricted to the window. Distinct cuts only, each with its mean affinity and contact
 * ratio.
 *
 * Why: a false merge the agglomeration took confidently is joined early, between two pieces that
 * hold neither point, so it is never a step on a point's way up (`candidates`). On Aedes root
 * 648518347672268769 no candidate came within 6 µm of the true site; a window around it cut there.
 *
 * `order` gives a supervoxel's position along the path (its chunk's), or undefined off it. The
 * graph is prepared once; each window agglomerates the edges whose two ends lie inside it.
 */
export function pathCuts(
  graph: SupervoxelGraph,
  order: (supervoxel: string) => number | undefined,
  half: number,
  userMerges: UserMergePolicy = 'trust',
): PathCut[] {
  const p = prepare(graph)
  const position = Int32Array.from(p.ids, (id) => order(id) ?? -1)
  // Edges bucketed by their lower end's position; an edge with an end off the path is never read.
  const byLow: number[][] = []
  for (let i = 0; i < p.ea.length; i++) {
    const u = position[p.ea[i]!]!
    const v = position[p.eb[i]!]!
    if (u < 0 || v < 0) continue
    ;(byLow[Math.min(u, v)] ??= []).push(i)
  }
  // A loop, not `Math.max(...position)`: one entry per supervoxel overflows an argument list.
  let last = -1
  for (const at of position) if (at > last) last = at

  const seen = new Set<string>()
  const cuts: PathCut[] = []
  for (let centre = half + 1; centre + half + 1 <= last; centre++) {
    const lo = centre - half - 1
    const hi = centre + half + 1
    const edges: number[] = []
    for (let at = lo; at <= hi; at++) {
      for (const i of byLow[at] ?? []) {
        if (Math.max(position[p.ea[i]!]!, position[p.eb[i]!]!) <= hi) edges.push(i)
      }
    }
    const flags = new Uint8Array(p.n)
    // Which sides the window has, gathered while marking: both, and no atom on both.
    let sides = 0
    let clash = false
    for (const i of edges) {
      for (const v of [p.ea[i]!, p.eb[i]!]) {
        const side = position[v] === lo ? 1 : position[v] === hi ? 2 : 0
        if (side === 0) continue
        const a = p.atom[v]!
        flags[a]! |= side
        sides |= side
        if (flags[a] === 3) clash = true
      }
    }
    if (clash || sides !== 3) continue
    const regionOf = agglomerate(
      p,
      userMerges,
      flags,
      (pair) => (flags[pair.r1]! | flags[pair.r2]!) !== 3,
      undefined,
      edges,
    )
    const mark = new Uint8Array(p.n)
    for (const i of edges) {
      for (const v of [p.ea[i]!, p.eb[i]!]) mark[v] = flags[regionOf(p.atom[v]!)]!
    }
    const indices = cutIndices(p, mark, edges)
    if (indices.length === 0) continue
    const key = [...indices].sort((x, y) => x - y).join(',')
    if (seen.has(key)) continue
    seen.add(key)
    const cut = cutEdges(p, mark, indices)
    const { meanAffinity, area } = cutScore(cut)
    cuts.push({
      window: [lo, hi],
      cut,
      meanAffinity,
      area,
      contact: contactRatio(p, mark, indices, edges),
    })
  }
  return cuts
}

/** A join between two large regions found by `weakJoins`: where the neuron may be two objects. */
export interface WeakJoin {
  /** Mean affinity of the boundary when the two regions joined; `Infinity` for a trusted merge. */
  readonly score: number
  /** Supervoxels on each side, the larger first. */
  readonly sizes: readonly [number, number]
  /** The boundary between the two regions, larger side's end first. */
  readonly cut: readonly CutEdge[]
}

/**
 * **Experimental: a whole neuron, no points.** The plain agglomeration over the graph; every
 * step joining two regions of at least `minPiece` supervoxels each is a join, and the weakest
 * `max` are returned with their boundaries. The same signal `splitSites`' candidates read, without
 * the points to say which steps lie between two objects.
 */
export function weakJoins(
  graph: SupervoxelGraph,
  options: { minPiece?: number; max?: number; userMerges?: UserMergePolicy } = {},
): WeakJoin[] {
  const minPiece = options.minPiece ?? MIN_PIECE
  const p = prepare(graph)
  const steps: Array<{ score: number; big: number; small: number; sizes: [number, number] }> =
    []
  const cutBetween = mergeTree(
    p,
    options.userMerges ?? 'trust',
    new Uint8Array(p.n),
    ({ score, keep, gone, node, size }) => {
      const a = size[keep]!
      const b = size[gone]!
      if (Math.min(a, b) < minPiece) return
      const [big, small] = a >= b ? [keep, gone] : [gone, keep]
      steps.push({
        score,
        big: node[big]!,
        small: node[small]!,
        sizes: [size[big]!, size[small]!],
      })
    },
  )
  return steps
    .sort((x, y) => x.score - y.score)
    .slice(0, options.max ?? MAX_CANDIDATES)
    .map((step) => ({
      score: step.score,
      sizes: step.sizes,
      cut: cutBetween(step.big, step.small),
    }))
}

/** A place where the cut runs: cut edges within `radiusNm` of each other, chained. */
export interface SplitSite {
  /** The mean of its edges' midpoints, nm. */
  readonly at: readonly [number, number, number]
  readonly edges: readonly CutEdge[]
  /** Summed affinity ÷ summed area over its measured contacts; undefined where it has none. */
  readonly meanAffinity: number | undefined
  /** Summed contact area, voxel faces. */
  readonly area: number
  readonly userMerges: number
  /** Edges with no position — their supervoxels' chunks are not in the L2 cache. */
  readonly unplaced: number
}

type Position = readonly [number, number, number]

/**
 * The cut, gathered into sites.
 *
 * `positionOf` places a supervoxel (in practice its level-2 chunk's representative point, which can
 * be a few micrometres from the contact itself). An edge is at the midpoint of its two ends; edges
 * whose midpoints chain within `radiusNm` are one site. Edges with no position at all are one
 * site of their own, last.
 *
 * Sorted by mean affinity, highest first — where the agglomerator would have joined the two
 * objects first. Every site has to be cut for the points to separate; the order says which looks
 * most like the merge, not which is optional.
 */
export function groupSites(
  cut: readonly CutEdge[],
  positionOf: (supervoxel: string) => Position | undefined,
  radiusNm: number,
): SplitSite[] {
  const placed: Array<{ edge: CutEdge; at: Position }> = []
  const unplaced: CutEdge[] = []
  for (const edge of cut) {
    const p = positionOf(edge.source)
    const q = positionOf(edge.sink)
    if (p && q) {
      placed.push({ edge, at: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2] })
    } else if (p || q) placed.push({ edge, at: (p ?? q)! })
    else unplaced.push(edge)
  }

  // Single linkage over a grid of `radiusNm` cells: only neighbouring cells can be within reach.
  const parent = Int32Array.from({ length: placed.length }, (_, i) => i)
  const find = (i: number): number => findRoot(parent, i)
  const cell = (at: Position): number[] => at.map((v) => Math.floor(v / radiusNm))
  const grid = groupBy(placed.keys(), (i) => cell(placed[i]!.at).join(','))
  const r2 = radiusNm * radiusNm
  placed.forEach(({ at }, i) => {
    const [cx, cy, cz] = cell(at) as [number, number, number]
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          for (const j of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
            if (j <= i) continue
            const b = placed[j]!.at
            const d = (at[0] - b[0]) ** 2 + (at[1] - b[1]) ** 2 + (at[2] - b[2]) ** 2
            if (d <= r2) unite(parent, i, j)
          }
        }
  })

  const groups = groupBy(placed.keys(), find)

  const sites: SplitSite[] = [...groups.values()].map((members) => {
    const at: [number, number, number] = [0, 0, 0]
    for (const i of members)
      for (let k = 0; k < 3; k++) at[k]! += placed[i]!.at[k]! / members.length
    return summarise(
      members.map((i) => placed[i]!.edge),
      at,
      0,
    )
  })
  sites.sort((x, y) => (y.meanAffinity ?? -1) - (x.meanAffinity ?? -1))
  if (unplaced.length > 0) {
    sites.push(summarise(unplaced, [Number.NaN, Number.NaN, Number.NaN], unplaced.length))
  }
  return sites
}

function summarise(edges: readonly CutEdge[], at: Position, unplaced: number): SplitSite {
  return { at, edges, ...cutScore(edges), unplaced }
}

/** A cut's mean affinity (over measured contacts), summed area and proofreader merges. */
function cutScore(edges: readonly CutEdge[]): {
  meanAffinity: number | undefined
  area: number
  userMerges: number
} {
  let affinity = 0
  let area = 0
  let userMerges = 0
  for (const edge of edges) {
    if (edge.userMerge) userMerges++
    else {
      affinity += edge.affinity
      area += edge.area
    }
  }
  return { meanAffinity: area > 0 ? affinity / area : undefined, area, userMerges }
}

/** A binary max-heap on `score`. */
export class MaxHeap<T extends { readonly score: number } = Entry> {
  private readonly items: T[] = []

  push(entry: T): void {
    const items = this.items
    items.push(entry)
    let i = items.length - 1
    while (i > 0) {
      const up = (i - 1) >> 1
      if (items[up]!.score >= entry.score) break
      items[i] = items[up]!
      i = up
    }
    items[i] = entry
  }

  pop(): T | undefined {
    const items = this.items
    const top = items[0]
    const last = items.pop()
    if (!top || !last || items.length === 0) return top
    let i = 0
    const n = items.length
    for (;;) {
      const l = 2 * i + 1
      if (l >= n) break
      const r = l + 1
      const child = r < n && items[r]!.score > items[l]!.score ? r : l
      if (items[child]!.score <= last.score) break
      items[i] = items[child]!
      i = child
    }
    items[i] = last
    return top
  }
}
