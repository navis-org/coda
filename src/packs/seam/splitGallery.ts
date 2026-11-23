/**
 * The split gallery's candidates: the splits near one point of a neuron, nearest first along the
 * neuron, each checked to separate the whole neuron. Pure — the reads are handed in
 * (`splitGalleryRun.ts`). Plan and measurements: `docs/split-gallery-plan.md`.
 *
 * From one box read around the point (the click's box one chunk wider, `wide`):
 *
 * 1. **Joins**: the plain agglomeration's steps inside the click's own box (`weakJoins`), each a
 *    place where two pieces of the box meet.
 * 2. **Distance along the neuron** from the point to each join: shortest paths over the box's
 *    supervoxel graph, a step between two chunks costing the distance between their level-2
 *    points. No segmentation read; measured to pick as well as supervoxel centres did.
 * 3. **For each join, nearest first**: the constrained cut between its two sides in the click's
 *    box (`splitSites`), then again in the wide box, seeded with the two sides the first cut
 *    made — the contact often runs past the click's box, and the wide box holds the rest of it.
 * 4. **The check** (`partition`): the wide box's supervoxel graph without the cut, joined to the
 *    rest of the neuron by its level-2 graph. A chunk of the wide box with a link outside it has
 *    *all* its supervoxels joined to that link — more joining than there is, never less — so a
 *    cut this calls separating does separate the neuron. That is the property a write needs: the
 *    server removes whatever edges it is sent and does not check (`split-gallery-plan.md`).
 * 5. **Kept** if it separates and is not a split already kept (`SAME_SPLIT` of the neuron's
 *    chunks on the same sides). A split taking off fewer than `trimChunks` chunks goes last.
 *
 * Ids are text throughout (invariant 8): supervoxels and level-2 chunks alike.
 */

import type { SupervoxelGraph } from '../../data/cave/subgraph'
import { subgraphWhere } from '../../data/cave/subgraph'
import type { Triple } from '../../data/precomputed/volume'
import type { CutEdge, UserMergePolicy } from './splitSites'
import { findRoot, MaxHeap, splitSites, unite, weakJoins } from './splitSites'

/** Which side of a split: `a` holds the cut's first source end. */
export type SplitSide = 'a' | 'b'

/** What the candidates are computed from. */
export interface SplitGalleryInput {
  /** The supervoxel graph of the click's box one chunk wider on every side. */
  readonly wide: SupervoxelGraph
  /** Every level-2 chunk of the neuron inside the wide box, with its supervoxels. */
  readonly members: ReadonlyMap<string, readonly string[]>
  /** The level-2 chunks inside the click's own box (a subset of `members`' keys). */
  readonly inner: ReadonlySet<string>
  /** The neuron's level-2 graph: every chunk, and the links between them. */
  readonly chunks: readonly string[]
  readonly links: ReadonlyArray<readonly [string, string]>
  /** Each level-2 chunk's point, nm. A chunk without one costs a step of `STEP_NM`. */
  readonly positions: ReadonlyMap<string, Triple>
  /** The point the reader asked about, nm. */
  readonly click: Triple
}

export interface SplitGalleryOptions {
  /** How many splits to offer. */
  readonly max?: number
  /** A split taking off fewer level-2 chunks than this is a trim, offered after the rest. */
  readonly trimChunks?: number
  /** Smallest region, in supervoxels, a join may join on either side. */
  readonly minPiece?: number
  /** Joins considered, weakest first, before distance orders them. */
  readonly maxJoins?: number
  readonly userMerges?: UserMergePolicy
  /**
   * Splits already offered (an earlier set's): treated as seen, so none of them — nor any split
   * the same as one of them (`sameSplit`) — is offered again. The gallery's Regenerate.
   */
  readonly exclude?: readonly Split[]
}

export const GALLERY_SIZE = 6
/** Measured on 156 simulated clicks: trims under 3 chunks last put the right split 4th or better 97 % of the time. */
export const TRIM_CHUNKS = 3
const MAX_JOINS = 120
/**
 * Smallest region, in supervoxels, a join may join on either side — half `splitSites`' `MIN_PIECE`.
 * That 20 was set on FANC; Aedes supervoxels are larger, and a false-merged piece there was 17
 * (648518347570445672, 2026-11-23): at 20 its join was never a candidate, at 10 it came first.
 */
export const GALLERY_MIN_PIECE = 10
/** Two splits putting this share of the neuron's chunks on the same sides are one split. */
const SAME_SPLIT = 0.98
/** What a step between two supervoxels of one chunk costs, nm: small, so a chunk is near itself. */
const STEP_NM = 50

/** One split on offer. */
export interface SplitCandidate {
  /** The edges to remove, `a` side first. Never empty. */
  readonly cut: readonly CutEdge[]
  /**
   * Each of the neuron's level-2 chunks' side; a chunk the cut runs through, the side most of its
   * supervoxels are on (`divided` says which are where).
   */
  readonly chunkSides: ReadonlyMap<string, SplitSide>
  /**
   * The chunks the cut runs through — supervoxels on both sides — and each of their supervoxels'
   * side: what a drawing needs to colour such a chunk exactly (`splitColours.ts`).
   */
  readonly divided: ReadonlyMap<string, ReadonlyMap<string, SplitSide>>
  /** Level-2 chunks on each side. */
  readonly sizes: { readonly a: number; readonly b: number }
  /** Mean affinity of the join it was found from. */
  readonly score: number
  /** Distance along the neuron from the click to the join, nm. */
  readonly alongNm: number
}

/** What a cut does to the whole neuron (`splitOf`). */
type Split = Pick<SplitCandidate, 'chunkSides' | 'divided' | 'sizes'>

/**
 * The candidates, best first, one at a time — so a caller can show each as it comes. Between
 * them it yields `undefined` after every join it checked and did not offer, so a caller on the
 * main thread can give the browser a turn there too. Ends after `max`, or when the joins run out.
 */
export function* splitCandidates(
  input: SplitGalleryInput,
  options: SplitGalleryOptions = {},
): Generator<SplitCandidate | undefined, void, undefined> {
  const max = options.max ?? GALLERY_SIZE
  const trimChunks = options.trimChunks ?? TRIM_CHUNKS
  const work = boxWork(input, {
    minPiece: options.minPiece ?? GALLERY_MIN_PIECE,
    maxJoins: options.maxJoins ?? MAX_JOINS,
    userMerges: options.userMerges ?? 'trust',
  })
  // A turn for the browser after the box's own work, the heaviest step on a box not seen before.
  yield undefined
  // Only this depends on the click: how far along the neuron each join is.
  const along = distancesAlong(work.innerGraph, work.chunkOf, input.positions, input.click)
  const order = work.joins
    .map((join, index) => ({
      join,
      index,
      alongNm: Math.min(
        ...join.cut.flatMap((e) => [
          along.get(e.source) ?? Infinity,
          along.get(e.sink) ?? Infinity,
        ]),
      ),
    }))
    .filter(({ alongNm }) => Number.isFinite(alongNm))
    .sort((x, y) => x.alongNm - y.alongNm)

  const seen: Split[] = [...(options.exclude ?? [])]
  const trims: SplitCandidate[] = []
  let offered = 0
  for (const { join, index, alongNm } of order) {
    if (offered >= max) return
    const found = work.splitAt(index)
    if (!found || seen.some((k) => sameSplit(k, found.split))) {
      yield undefined
      continue
    }
    const candidate: SplitCandidate = {
      cut: found.cut,
      ...found.split,
      score: join.score,
      alongNm,
    }
    seen.push(candidate)
    if (Math.min(candidate.sizes.a, candidate.sizes.b) < trimChunks) {
      trims.push(candidate)
      yield undefined
      continue
    }
    offered++
    yield candidate
  }
  for (const trim of trims) {
    if (offered >= max) return
    offered++
    yield trim
  }
}

interface WorkOptions {
  readonly minPiece: number
  readonly maxJoins: number
  readonly userMerges: UserMergePolicy
}

/** A join's split of the neuron, and the edges it removes; null where it is no split. */
type Found = { readonly cut: readonly CutEdge[]; readonly split: Split } | null

/**
 * What a box's candidates cost that no click changes: the click's box, its joins, the neuron
 * numbered for the check, and each join's split once worked out. A second press in a box already
 * read pays only the distances (`distancesAlong`). Kept with the box's graph — the session keeps
 * the box (`splitSession.ts`), so this goes when the box does.
 */
const WORK = new WeakMap<SupervoxelGraph, Map<string, ReturnType<typeof boxWorkAnew>>>()

function boxWork(input: SplitGalleryInput, options: WorkOptions) {
  const key = `${options.minPiece}|${options.maxJoins}|${options.userMerges}`
  let held = WORK.get(input.wide)
  if (!held) WORK.set(input.wide, (held = new Map()))
  let work = held.get(key)
  if (!work) held.set(key, (work = boxWorkAnew(input, options)))
  return work
}

function boxWorkAnew(
  input: SplitGalleryInput,
  { minPiece, maxJoins, userMerges }: WorkOptions,
) {
  const chunkOf = chunkOfMembers(input.members)
  const innerGraph = subgraphWhere(input.wide, (sv) => input.inner.has(chunkOf.get(sv) ?? ''))
  const joins = weakJoins(innerGraph, { minPiece, max: maxJoins, userMerges })
  // The constrained cut, its candidate list unasked for (a second agglomeration nobody reads).
  const cutOf = (
    graph: SupervoxelGraph,
    sources: readonly string[],
    sinks: readonly string[],
  ) => {
    const split = splitSites({ graph, sources, sinks, minPiece, userMerges, maxCandidates: 0 })
    return split.ok && split.cut.length > 0 ? split : undefined
  }
  const neuron = numbered(input)
  const splits = new Map<number, Found>()
  return {
    chunkOf,
    innerGraph,
    joins,
    /** Join `index`'s split: its two sides in the click's box, then the cut between them in the wide box. */
    splitAt(index: number): Found {
      const held = splits.get(index)
      if (held !== undefined) return held
      const join = joins[index]!
      const local = cutOf(
        innerGraph,
        [...new Set(join.cut.map((e) => e.source))],
        [...new Set(join.cut.map((e) => e.sink))],
      )
      const wide = local && cutOf(input.wide, local.sides[0], local.sides[1])
      const split = wide && neuron.split(wide.cut)
      const found = wide && split ? { cut: wide.cut, split } : null
      splits.set(index, found)
      return found
    },
  }
}

const CHUNK_OF = new WeakMap<ReadonlyMap<string, readonly string[]>, Map<string, string>>()

/** Each wide-box supervoxel's level-2 chunk, worked out once per box (kept with its `members`). */
export function chunkOfMembers(
  members: ReadonlyMap<string, readonly string[]>,
): ReadonlyMap<string, string> {
  let chunkOf = CHUNK_OF.get(members)
  if (!chunkOf) {
    chunkOf = new Map()
    for (const [chunk, svs] of members) for (const sv of svs) chunkOf.set(sv, chunk)
    CHUNK_OF.set(members, chunkOf)
  }
  return chunkOf
}

const NUMBERED = new WeakMap<SplitGalleryInput, ReturnType<typeof numberNeuron>>()

/**
 * The box's neuron numbered for the check, once per input object — the one the candidates were
 * found in, which the session hands Accept (`splitOf`), so the check again rebuilds nothing.
 * Keyed by the whole input, not its graph: the numbering reads its links and members too.
 */
function numbered(input: SplitGalleryInput) {
  let neuron = NUMBERED.get(input)
  if (!neuron) NUMBERED.set(input, (neuron = numberNeuron(input)))
  return neuron
}

/**
 * What removing `cut` does to the neuron: its two sides, or undefined where it stays one piece.
 * For a check on its own — before a write, against a fresh read (phase 4 of the plan).
 */
export function splitOf(
  input: SplitGalleryInput,
  cut: readonly CutEdge[],
): (Split & SupervoxelSides) | undefined {
  // `withSides` set: the side lookup is there whenever a split is.
  return numbered(input).split(cut, true) as (Split & SupervoxelSides) | undefined
}

/**
 * Each wide-box supervoxel's own side after a cut — undefined for one on neither (a third piece
 * the cut also breaks off) or outside the box. Only `splitOf` answers it: it holds the cut's whole
 * union-find, which a candidate kept for drawing should not.
 */
interface SupervoxelSides {
  readonly sideOf: (supervoxel: string) => SplitSide | undefined
}

/**
 * The neuron for the separation check, numbered once per box: the wide box's supervoxels
 * `0..n-1`, then a node per level-2 chunk `n + k`. The part that is the same for every cut is
 * joined once into `base` — chunks outside the box through the level-2 graph, and **every**
 * supervoxel of a wide-box chunk that links outside joined to that link, wholesale (more joining
 * than there is, never less, so a cut this calls separating does separate the neuron: the
 * property a write needs, since the server checks nothing — `split-gallery-plan.md`). Each cut
 * then copies `base` and joins the box's edges it leaves.
 */
function numberNeuron(input: SplitGalleryInput) {
  const { wide, members, chunks } = input
  const index = new Map<string, number>()
  const indexOf = (sv: string) => {
    let at = index.get(sv)
    if (at === undefined) index.set(sv, (at = index.size))
    return at
  }
  const m = wide.a.length
  const ea = new Int32Array(m)
  const eb = new Int32Array(m)
  // Every row of a pair: a reply may list one edge twice (both directions), and a cut must remove both.
  const edgeAt = new Map<string, number[]>()
  for (let i = 0; i < m; i++) {
    ea[i] = indexOf(wide.a[i]!)
    eb[i] = indexOf(wide.b[i]!)
    const key = edgeKey(wide.a[i]!, wide.b[i]!)
    const rows = edgeAt.get(key)
    if (rows) rows.push(i)
    else edgeAt.set(key, [i])
  }
  for (const svs of members.values()) for (const sv of svs) indexOf(sv)
  const n = index.size
  const chunkAt = new Map(chunks.map((chunk, k) => [chunk, k]))

  const base = Int32Array.from({ length: n + chunks.length }, (_, i) => i)
  const nodeOf = (chunk: string) => n + chunkAt.get(chunk)!
  for (const [x, y] of input.links) {
    const inX = members.has(x)
    const inY = members.has(y)
    if (inX && inY) continue // inside the box, its supervoxel graph speaks
    if (!inX && !inY) unite(base, nodeOf(x), nodeOf(y))
    else {
      const [inside, outside] = inX ? [x, y] : [y, x]
      for (const sv of members.get(inside)!) unite(base, index.get(sv)!, nodeOf(outside))
    }
  }
  // Where a chunk outside the box is read from: its node (a box chunk, by its supervoxels).
  const chunkNode = Int32Array.from(chunks, nodeOf)

  return {
    split(
      cut: readonly CutEdge[],
      withSides = false,
    ): (Split & Partial<SupervoxelSides>) | undefined {
      const first = cut[0]
      if (!first) return undefined
      const removed = new Uint8Array(m)
      for (const e of cut) {
        for (const row of edgeAt.get(edgeKey(e.source, e.sink)) ?? []) removed[row] = 1
      }
      const parent = base.slice()
      for (let i = 0; i < m; i++) if (!removed[i]) unite(parent, ea[i]!, eb[i]!)
      const source = index.get(first.source)
      const sink = index.get(first.sink)
      if (source === undefined || sink === undefined) return undefined
      const ra = findRoot(parent, source)
      const rb = findRoot(parent, sink)
      if (ra === rb) return undefined
      const sideOf = (node: number): SplitSide | undefined => {
        const root = findRoot(parent, node)
        return root === ra ? 'a' : root === rb ? 'b' : undefined
      }
      const chunkSides = new Map<string, SplitSide>()
      const divided = new Map<string, Map<string, SplitSide>>()
      const sizes = { a: 0, b: 0 }
      chunks.forEach((chunk, k) => {
        const svs = members.get(chunk)
        let side = svs ? undefined : sideOf(chunkNode[k]!)
        if (svs) {
          // A box chunk: by its supervoxels, the side most are on — and every one's, where the
          // cut runs through it.
          const each = new Map<string, SplitSide>()
          let a = 0
          for (const sv of svs) {
            const s = sideOf(index.get(sv)!)
            if (!s) continue
            each.set(sv, s)
            if (s === 'a') a++
          }
          const b = each.size - a
          if (a > 0 && b > 0) divided.set(chunk, each)
          side = each.size === 0 ? undefined : a >= b ? 'a' : 'b'
        }
        if (!side) return
        chunkSides.set(chunk, side)
        sizes[side]++
      })
      if (!withSides) return { chunkSides, divided, sizes }
      return {
        chunkSides,
        divided,
        sizes,
        sideOf: (sv: string) => {
          const node = index.get(sv)
          return node === undefined ? undefined : sideOf(node)
        },
      }
    },
  }
}

/** Whether two splits put `SAME_SPLIT` of the neuron's chunks on the same sides, either labelling. */
function sameSplit(p: Split, q: Split): boolean {
  let same = 0
  let swapped = 0
  let both = 0
  for (const [chunk, x] of p.chunkSides) {
    const y = q.chunkSides.get(chunk)
    if (!y) continue
    both++
    if (x === y) same++
    else swapped++
  }
  return both > 0 && Math.max(same, swapped) / both >= SAME_SPLIT
}

/**
 * Distance along the neuron from the click to every supervoxel of `graph`, nm: Dijkstra from the
 * supervoxels of the chunk whose point is nearest the click. A step within one chunk costs
 * `STEP_NM`; between two, the distance between their points.
 */
export function distancesAlong(
  graph: SupervoxelGraph,
  chunkOf: ReadonlyMap<string, string>,
  positions: ReadonlyMap<string, Triple>,
  click: Triple,
): Map<string, number> {
  const neighbours = new Map<string, string[]>()
  const link = (x: string, y: string) => {
    const list = neighbours.get(x)
    if (list) list.push(y)
    else neighbours.set(x, [y])
  }
  for (let i = 0; i < graph.a.length; i++) {
    link(graph.a[i]!, graph.b[i]!)
    link(graph.b[i]!, graph.a[i]!)
  }
  let start: string | undefined
  let gap = Infinity
  for (const sv of neighbours.keys()) {
    const chunk = chunkOf.get(sv)
    const at = chunk === undefined ? undefined : positions.get(chunk)
    if (at && distance(at, click) < gap) [start, gap] = [chunk, distance(at, click)]
  }
  const reached = new Map<string, number>()
  if (start === undefined) return reached
  // Nearest first: a max-heap on the negated distance.
  const heap = new MaxHeap<{ score: number; sv: string }>()
  for (const sv of neighbours.keys()) {
    if (chunkOf.get(sv) !== start) continue
    reached.set(sv, 0)
    heap.push({ score: -0, sv })
  }
  const done = new Set<string>()
  for (let next = heap.pop(); next; next = heap.pop()) {
    const d = -next.score
    const { sv } = next
    if (done.has(sv)) continue
    done.add(sv)
    const here = chunkOf.get(sv)
    const at = here === undefined ? undefined : positions.get(here)
    for (const other of neighbours.get(sv) ?? []) {
      const there = chunkOf.get(other)
      const to = there === undefined ? undefined : positions.get(there)
      const step = at && to && here !== there ? Math.max(STEP_NM, distance(at, to)) : STEP_NM
      if (d + step < (reached.get(other) ?? Infinity)) {
        reached.set(other, d + step)
        heap.push({ score: -(d + step), sv: other })
      }
    }
  }
  return reached
}

const distance = (p: Triple, q: Triple) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])

const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)
