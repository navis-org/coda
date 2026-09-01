/**
 * The centrality half of the metrics pair: everything that is not O(V + E), behind `net.centrality`.
 *
 *   centralityNodeColumns(o)     — which columns the options ask for
 *   centralityNodeSchema(o)      — id + those, the standalone table
 *   centralityNetworkSchema(s,o) — a node table with them folded in
 *   centralitySummarySchema()    — the graph-level row, a constant
 *   networkCentrality(net, o, h) — the values
 *
 * Split from `networkMetrics.ts` rather than switched on inside it, and that split is the
 * design rather than a tidy-up. `cost` is a property of a node **type**, not of a run
 * (invariant 6), so a single node holding both would have to be `expensive` — and then reading
 * a graph's node count, link count and density would need a Run, which is the one thing about
 * this pair that has to be instant. Two nodes, each honest about what it costs. They compose:
 * `net.centrality` writes its columns onto the network, so a `net.metrics` card downstream
 * plots them alongside degree.
 *
 * ## What is measured here, and against what
 *
 * **Betweenness is Brandes**, unweighted BFS or Dijkstra on `1 / weight`, normalised exactly as
 * networkx's `betweenness_centrality(normalized=True)` does — including the detail that the
 * undirected sum is *not* halved before scaling, because `(n-1)(n-2)` counts ordered pairs and
 * the double count is what makes that the right denominator. A number quoted from this node is
 * meant to be comparable with one quoted from networkx; getting the scale subtly wrong is the
 * kind of thing nobody notices until two papers disagree.
 *
 * **Closeness is harmonic and incoming.** `Σ 1/d(u, v)` over all `u` that reach `v`, divided by
 * `n - 1`. Harmonic rather than the classical `(n-1)/Σd` because a connectome is never one
 * strongly connected component: classical closeness is `1/∞` — undefined — for any node that
 * cannot reach everything, which on a real graph is most of them, and the usual workaround
 * (restrict to the reachable set) makes a node in a two-node island score higher than a hub.
 * Incoming because that is how harmonic centrality is defined (networkx's
 * `harmonic_centrality`), and because it is the direction the sampled sweep can actually
 * estimate: a BFS from a pivot yields `d(pivot, ·)` for everything, which accumulates into the
 * *target's* score. Getting that backwards would make the exact and sampled columns two
 * different measures wearing one name.
 *
 * **Sampling is pivots, not links.** `samples > 0` runs the sweep from `k` seeded-random source
 * nodes and scales by `n / k`, which is the standard estimator and is unbiased for betweenness
 * and for harmonic closeness alike. What it cannot estimate is the diameter — a maximum is not
 * a mean, and the sampled maximum is a lower bound with no error bar — so `diameter` is null
 * whenever the sweep was sampled rather than a number that looks like an answer.
 *
 * **Every random draw is seeded.** Invariant 4: the cache key is provenance, so `evaluate` must
 * be deterministic. That covers the pivot draw and Louvain's random walk, which is why the
 * `rng` option is passed rather than left at the library's `Math.random`.
 */

import type { ColumnSchema, TableSchema } from '../../core/types'
import { column, tableSchema } from '../../core/types'
import type { ColumnData, NetworkValue, TableValue } from '../../core/values'
import { makeTable } from '../../core/values'
import type { NetworkIndex } from './networkMetrics'
import { indexNetwork } from './networkMetrics'
import { foldNodeColumns, withNodeColumns } from './networkOps'

export interface CentralityOptions {
  betweenness: boolean
  closeness: boolean
  pagerank: boolean
  eigenvector: boolean
  communities: boolean
  /** Path metrics treat a link's length as `1 / weight` rather than as one hop. */
  weighted: boolean
  /** Source nodes for the path sweep. 0 is every node — exact. */
  samples: number
  /** Pins the pivot draw and Louvain's walk. */
  seed: number
  /** Louvain's resolution: higher finds more, smaller communities. */
  resolution: number
  /** PageRank's damping factor. */
  damping: number
}

export const CENTRALITY_DEFAULTS: CentralityOptions = {
  betweenness: true,
  closeness: true,
  pagerank: true,
  eigenvector: false,
  communities: true,
  weighted: false,
  samples: 0,
  seed: 1,
  resolution: 1,
  damping: 0.85,
}

/**
 * Where the exact sweep stops being something to start without saying so.
 *
 * Brandes is `O(V·E)` — one BFS per source — so the honest unit is the product, and the product
 * is what the node warns on. 200 million: a few seconds of pure loop on a modern laptop, and
 * roughly where a graph of 20,000 nodes with 10 links each lands, which is an ordinary
 * cell-type network rather than an unreasonable one. Past it the message names `Sample` as the
 * control, because that is the thing that turns an hour into a minute. It warns and runs; time
 * is never a refusal (docs/limits.md).
 *
 * Compared in the node's `evaluate`, not here — `sweepSources(o, n) * links` needs nothing this
 * module has, and a guard rail belongs where `EvalContext.warn` is, before the await rather than
 * inside it. `networkMetrics` learned that the hard way; see its memo note.
 */
export const SWEEP_WORK_WARN = 200_000_000

/** Whether the options need the all-pairs sweep at all. */
export function needsSweep(o: CentralityOptions): boolean {
  return o.betweenness || o.closeness
}

/** How many sources the sweep will run from, given the graph size. Read by the node's warn. */
export function sweepSources(o: CentralityOptions, nodes: number): number {
  if (!needsSweep(o)) return 0
  return o.samples > 0 ? Math.min(o.samples, nodes) : nodes
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

function centralityNodeColumns(o: CentralityOptions): ColumnSchema[] {
  const columns: ColumnSchema[] = []
  if (o.betweenness) columns.push(column('betweenness', 'f64'))
  if (o.closeness) columns.push(column('closeness', 'f64'))
  if (o.pagerank) columns.push(column('pagerank', 'f64'))
  if (o.eigenvector) columns.push(column('eigenvector', 'f64'))
  if (o.communities) columns.push(column('community', 'i64'))
  return columns
}

export function centralityNodeSchema(o: CentralityOptions): TableSchema {
  return tableSchema(column('id', 'str'), ...centralityNodeColumns(o))
}

/**
 * A node table with the chosen columns folded in. `networkOps.foldNodeColumns` has the rules —
 * shared with `net.metrics`, because "write over, never beside" is one decision and not two.
 */
export function centralityNetworkSchema(
  nodes: TableSchema | undefined,
  o: CentralityOptions,
): TableSchema {
  return foldNodeColumns(nodes, centralityNodeColumns(o))
}

/**
 * The graph-level row: constant width, nulls for what was not asked for.
 *
 * Constant rather than conditional like the node half, and the asymmetry is deliberate. The
 * node columns are the cost — not computing eigenvector centrality is why you turned it off,
 * and a column of nulls would be a picker offering a column that is never filled. The summary
 * costs nothing either way, and its whole use is being stacked across runs: a `Collect` of five
 * summaries whose columns depend on each run's settings is five different tables.
 */
export function centralitySummarySchema(): TableSchema {
  return tableSchema(
    column('sources', 'i64'),
    column('meanPathLength', 'f64'),
    column('diameter', 'f64'),
    column('reachable', 'f64'),
    column('communities', 'i64'),
    column('modularity', 'f64'),
  )
}

// ---------------------------------------------------------------------------
// Adjacency, as CSR
// ---------------------------------------------------------------------------

/**
 * Out-neighbours with lengths, in CSR form.
 *
 * On an undirected network every link is entered both ways, so "follow the arrows" and "walk
 * either way" are one code path with a different index rather than two implementations of
 * Brandes.
 *
 * **Parallel links are merged here, and that is a correctness fix rather than a saving.**
 * `net.build`'s "Merge parallel links" can be turned off, and a connectivity table then arrives
 * with one row per synapse group — so a pair can appear four times. Brandes counts *shortest
 * paths*, and a duplicated neighbour adds `sigma[u]` to `sigma[v]` once per copy: the same
 * single path counted four times, which inflates every betweenness downstream of it. Nothing
 * about the result looks unusual.
 *
 * The merge **sums the weights and then inverts**, rather than taking the shortest of the
 * copies. Both are defensible in isolation; only one makes the node's answer independent of a
 * checkbox on a different node. Four 30-synapse links between a pair are one 120-synapse
 * connection — that is what "Merge parallel links" produces upstream — so summing is what makes
 * a weighted path the same length whether or not somebody left that box ticked. Taking the
 * minimum would make the same graph two different distances apart depending on how it was
 * built.
 */
interface Adjacency {
  offset: Int32Array
  neighbour: Int32Array
  /** `1 / weight` when weighted, else 1. Never zero, never negative — see `linkLength`. */
  length: Float64Array
}

/**
 * A link's length from its weight.
 *
 * `1 / weight`, because a heavier connection is a *shorter* path — the reading that makes a
 * weighted betweenness mean what people expect it to. A non-positive or non-finite weight
 * cannot become a length at all (a zero-length link makes every path through it free, and a
 * negative one makes Dijkstra wrong rather than slow), so it falls back to one hop. Weights
 * arriving here are synapse counts, so that case is a filtered-to-nothing link rather than a
 * real zero-strength connection.
 */
function linkLength(weight: number, weighted: boolean): number {
  if (!weighted) return 1
  return weight > 0 && Number.isFinite(weight) ? 1 / weight : 1
}

function buildAdjacency(index: NetworkIndex, weighted: boolean): Adjacency {
  const n = index.ids.length
  const both = !index.directed
  // Total weight per ordered pair, keyed as `a * n + b` — `projectUndirected`'s key, for the
  // same reason: at 100k nodes it reaches 1e10, exact in a float64 and free next to a string.
  const merged = new Map<number, number>()
  const add = (a: number, b: number, w: number) => {
    const key = a * n + b
    merged.set(key, (merged.get(key) ?? 0) + w)
  }
  for (let i = 0; i < index.source.length; i++) {
    const a = index.source[i]!
    const b = index.target[i]!
    if (a === b) continue
    const w = index.weight[i]!
    add(a, b, w)
    if (both) add(b, a, w)
  }

  const degree = new Int32Array(n)
  for (const key of merged.keys()) degree[Math.floor(key / n)]!++
  const offset = new Int32Array(n + 1)
  for (let u = 0; u < n; u++) offset[u + 1] = offset[u]! + degree[u]!
  const neighbour = new Int32Array(offset[n]!)
  const length = new Float64Array(offset[n]!)
  const cursor = Int32Array.from(offset.subarray(0, n))
  for (const [key, w] of merged) {
    const a = Math.floor(key / n)
    const b = key - a * n
    neighbour[cursor[a]!] = b
    length[cursor[a]!] = linkLength(w, weighted)
    cursor[a]!++
  }
  return { offset, neighbour, length }
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/** mulberry32, seeded — the same generator the Sample node uses, for the same reason. */
function seededRandom(seed: number): () => number {
  let a = (Number.isFinite(seed) ? Math.floor(seed) : 0) >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** `k` distinct node rows, drawn without replacement from a seeded shuffle. */
function pivots(n: number, k: number, seed: number): Int32Array {
  const all = new Int32Array(n)
  for (let i = 0; i < n; i++) all[i] = i
  if (k >= n) return all
  const rand = seededRandom(seed)
  // Partial Fisher–Yates: only the first k positions have to be settled.
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rand() * (n - i))
    const tmp = all[i]!
    all[i] = all[j]!
    all[j] = tmp
  }
  return all.subarray(0, k)
}

/** A binary min-heap over (node, distance). Only used on the weighted path. */
class Heap {
  private nodes: number[] = []
  private keys: number[] = []

  get size(): number {
    return this.nodes.length
  }

  push(node: number, key: number): void {
    this.nodes.push(node)
    this.keys.push(key)
    let i = this.nodes.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.keys[parent]! <= this.keys[i]!) break
      this.swap(i, parent)
      i = parent
    }
  }

  pop(): { node: number; key: number } {
    const node = this.nodes[0]!
    const key = this.keys[0]!
    const lastNode = this.nodes.pop()!
    const lastKey = this.keys.pop()!
    if (this.nodes.length > 0) {
      this.nodes[0] = lastNode
      this.keys[0] = lastKey
      let i = 0
      for (;;) {
        const left = 2 * i + 1
        const right = left + 1
        let best = i
        if (left < this.keys.length && this.keys[left]! < this.keys[best]!) best = left
        if (right < this.keys.length && this.keys[right]! < this.keys[best]!) best = right
        if (best === i) break
        this.swap(i, best)
        i = best
      }
    }
    return { node, key }
  }

  private swap(a: number, b: number): void {
    const n = this.nodes[a]!
    this.nodes[a] = this.nodes[b]!
    this.nodes[b] = n
    const k = this.keys[a]!
    this.keys[a] = this.keys[b]!
    this.keys[b] = k
  }
}

interface SweepResult {
  /** Raw Brandes accumulation, before scaling. */
  betweenness: Float64Array
  /** Raw `Σ 1/d` into each target, before scaling. */
  harmonic: Float64Array
  /** Sum of finite distances over the pairs the sweep visited, and how many there were. */
  distanceSum: number
  pairs: number
  /** Largest finite distance seen. Only an answer when every source was swept. */
  longest: number
  sources: number
}

export interface SweepHooks {
  signal?: AbortSignal
  progress?: (fraction: number) => void
}

/**
 * One Brandes sweep, producing betweenness and harmonic closeness together.
 *
 * Together because they come off the same shortest-path tree, and running two sweeps to get
 * them separately would double the only genuinely expensive thing in this file. The unweighted
 * branch is a BFS with an explicit queue; the weighted one is Dijkstra with a lazy heap
 * (stale entries are skipped on pop rather than decreased in place, which is the standard
 * trade — a few more pushes against an indexed heap's bookkeeping).
 */
function brandesSweep(
  adjacency: Adjacency,
  n: number,
  o: CentralityOptions,
  hooks: SweepHooks = {},
): SweepResult {
  const sources = pivots(n, o.samples > 0 ? o.samples : n, o.seed)
  const betweenness = new Float64Array(n)
  const harmonic = new Float64Array(n)

  const dist = new Float64Array(n)
  const sigma = new Float64Array(n)
  const delta = new Float64Array(n)
  const preds: number[][] = Array.from({ length: n }, () => [])
  const order = new Int32Array(n)
  /*
   * Which sweep last touched a node, rather than a flag cleared between sweeps.
   *
   * A stamp compared against `s` is what lets the reset below be proportional to what the walk
   * *reached* instead of to the whole graph, and the two go together: with a `Uint8Array` flag
   * there is no way to tell "unvisited this sweep" from "unvisited ever" without clearing it.
   * `-1` because source 0 is a real sweep.
   */
  const stamp = new Int32Array(n).fill(-1)
  /** Popped-and-final, on the weighted branch only. A stamp for `stamp`'s reason. */
  const settled = new Int32Array(n).fill(-1)

  let distanceSum = 0
  let pairs = 0
  let longest = 0
  let counted = 0

  for (let s = 0; s < sources.length; s++) {
    if (hooks.signal?.aborted) throw new Error('Cancelled')
    if (hooks.progress && s % 64 === 0) hooks.progress(s / sources.length)

    /*
     * Reset only what the previous sweep touched, which `order` is already a list of.
     *
     * Four `fill`s and an n-long loop per source is Θ(V) whatever the walk reached, so the sweep
     * was Θ(V²) on the resets alone — invisible on a connected graph and the entire runtime on a
     * fragmented one. The correspondence graph in CLAUDE.md is the case that matters: 36k nodes
     * in 11,936 components, largest 39, so almost every source walks a handful of nodes and then
     * cleared 36,000. Bounded by the walk instead, that is ~70× less work for the same answer.
     */
    for (let i = 0; i < counted; i++) {
      const u = order[i]!
      sigma[u] = 0
      delta[u] = 0
      preds[u]!.length = 0
    }

    const root = sources[s]!
    dist[root] = 0
    sigma[root] = 1
    stamp[root] = s
    counted = 0

    if (o.weighted) {
      /*
       * `settled` is a second stamp rather than a flag, for the reset's sake — and `dist` is
       * only believed where `stamp[v] === s`, which is what lets it go unfilled between sweeps.
       */
      const heap = new Heap()
      heap.push(root, 0)
      while (heap.size > 0) {
        const { node: u, key } = heap.pop()
        if (settled[u] === s) continue
        if (key > dist[u]!) continue
        settled[u] = s
        order[counted++] = u
        for (let e = adjacency.offset[u]!; e < adjacency.offset[u + 1]!; e++) {
          const v = adjacency.neighbour[e]!
          const alt = dist[u]! + adjacency.length[e]!
          const known = stamp[v] === s ? dist[v]! : Number.POSITIVE_INFINITY
          if (alt < known) {
            stamp[v] = s
            dist[v] = alt
            sigma[v] = sigma[u]!
            preds[v]!.length = 0
            preds[v]!.push(u)
            heap.push(v, alt)
          } else if (alt === known) {
            sigma[v]! += sigma[u]!
            preds[v]!.push(u)
          }
        }
      }
    } else {
      let head = 0
      order[counted++] = root
      while (head < counted) {
        const u = order[head++]!
        for (let e = adjacency.offset[u]!; e < adjacency.offset[u + 1]!; e++) {
          const v = adjacency.neighbour[e]!
          if (stamp[v] !== s) {
            stamp[v] = s
            dist[v] = dist[u]! + 1
            order[counted++] = v
          }
          if (dist[v] === dist[u]! + 1) {
            sigma[v]! += sigma[u]!
            preds[v]!.push(u)
          }
        }
      }
    }

    for (let i = 0; i < counted; i++) {
      const v = order[i]!
      if (v === root) continue
      const d = dist[v]!
      harmonic[v]! += 1 / d
      distanceSum += d
      pairs++
      if (d > longest) longest = d
    }

    // Dependency accumulation, in reverse discovery order — the whole reason Brandes is
    // O(V·E) rather than O(V³).
    for (let i = counted - 1; i > 0; i--) {
      const w = order[i]!
      const coefficient = (1 + delta[w]!) / sigma[w]!
      for (const v of preds[w]!) delta[v]! += sigma[v]! * coefficient
      betweenness[w]! += delta[w]!
    }
  }

  hooks.progress?.(1)
  return {
    betweenness,
    harmonic,
    distanceSum,
    pairs,
    longest,
    sources: sources.length,
  }
}

// ---------------------------------------------------------------------------
// The iterative pair
// ---------------------------------------------------------------------------

const POWER_ITERATIONS = 200
const POWER_TOLERANCE = 1e-10

/**
 * PageRank over the out-adjacency, weighted by link weight where the network has one.
 *
 * Dangling mass — a neuron with no outputs in this graph, which after a filter is common —
 * is redistributed uniformly rather than dropped. Dropping it makes the vector stop summing to
 * one, and then every score is quietly scaled by however much of the graph happened to be a
 * sink.
 */
export function pagerank(index: NetworkIndex, damping: number): Float64Array {
  const n = index.ids.length
  const rank = new Float64Array(n)
  if (n === 0) return rank
  rank.fill(1 / n)

  const both = !index.directed
  const outWeight = new Float64Array(n)
  for (let i = 0; i < index.source.length; i++) {
    const a = index.source[i]!
    const b = index.target[i]!
    if (a === b) continue
    const w = index.weight[i]! > 0 ? index.weight[i]! : 1
    outWeight[a]! += w
    if (both) outWeight[b]! += w
  }

  const next = new Float64Array(n)
  for (let iteration = 0; iteration < POWER_ITERATIONS; iteration++) {
    next.fill(0)
    let dangling = 0
    for (let u = 0; u < n; u++) if (outWeight[u]! === 0) dangling += rank[u]!
    for (let i = 0; i < index.source.length; i++) {
      const a = index.source[i]!
      const b = index.target[i]!
      if (a === b) continue
      const w = index.weight[i]! > 0 ? index.weight[i]! : 1
      next[b]! += (rank[a]! * w) / outWeight[a]!
      if (both) next[a]! += (rank[b]! * w) / outWeight[b]!
    }
    let change = 0
    const base = (1 - damping) / n + (damping * dangling) / n
    for (let u = 0; u < n; u++) {
      const value = base + damping * next[u]!
      change += Math.abs(value - rank[u]!)
      next[u] = value
    }
    rank.set(next)
    if (change < POWER_TOLERANCE * n) break
  }
  return rank
}

/**
 * Eigenvector centrality by power iteration over *incoming* links, normalised to unit L2.
 *
 * Incoming, and L2, because both are networkx's `eigenvector_centrality` — this is a number
 * people cross-check. On a directed graph it is the measure with the well-known failure mode
 * (anything upstream of no cycle tends to zero), which is why it is the one member of this set
 * that defaults to off rather than on.
 */
export function eigenvector(index: NetworkIndex): Float64Array {
  const n = index.ids.length
  const x = new Float64Array(n)
  if (n === 0) return x
  x.fill(1 / Math.sqrt(n))

  const both = !index.directed
  const next = new Float64Array(n)
  for (let iteration = 0; iteration < POWER_ITERATIONS; iteration++) {
    next.fill(0)
    for (let i = 0; i < index.source.length; i++) {
      const a = index.source[i]!
      const b = index.target[i]!
      if (a === b) continue
      const w = index.weight[i]! > 0 ? index.weight[i]! : 1
      next[b]! += x[a]! * w
      if (both) next[a]! += x[b]! * w
    }
    let norm = 0
    for (let u = 0; u < n; u++) norm += next[u]! * next[u]!
    norm = Math.sqrt(norm)
    // A graph with no links at all, or one whose vector collapsed: leave the last non-zero
    // iterate rather than dividing by zero and returning NaN in a column of scores.
    if (norm === 0) return x
    let change = 0
    for (let u = 0; u < n; u++) {
      const value = next[u]! / norm
      change += Math.abs(value - x[u]!)
      x[u] = value
    }
    if (change < POWER_TOLERANCE * n) break
  }
  return x
}

// ---------------------------------------------------------------------------
// Communities
// ---------------------------------------------------------------------------

interface Communities {
  /** Community per node row, numbered largest-first. */
  membership: Int32Array
  count: number
  modularity: number
}

/**
 * Louvain, from `graphology-communities-louvain`, with our seed and largest-first numbering.
 *
 * Two things are ours rather than the library's. The **rng** is seeded, because invariant 4
 * needs `evaluate` deterministic and the default random walk is `Math.random`. And the
 * community ids are **renumbered largest-first**, exactly as `componentsOfEdges` numbers
 * components — the library's ids are arbitrary, and `resolveColor` ranks categories by
 * frequency, so unranked ids would give the biggest community whichever colour happened to
 * fall out of the merge order. Two graphs of the same data would then be two different
 * pictures. Ties break on the earliest node, which makes the numbering total.
 *
 * Dynamically imported: this is the only thing in `src/nodes/lib` that needs it, and a static
 * import would put graphology in the main chunk for every graph that never builds a network.
 */
export async function louvainCommunities(
  index: NetworkIndex,
  o: CentralityOptions,
): Promise<Communities> {
  const n = index.ids.length
  if (n === 0) return { membership: new Int32Array(0), count: 0, modularity: Number.NaN }

  const [{ default: Graph }, { default: louvain }] = await Promise.all([
    import('graphology'),
    import('graphology-communities-louvain'),
  ])

  const graph = new Graph({ type: index.directed ? 'directed' : 'undirected', multi: false })
  for (let u = 0; u < n; u++) graph.addNode(String(u))
  for (let i = 0; i < index.source.length; i++) {
    const a = String(index.source[i]!)
    const b = String(index.target[i]!)
    if (a === b) continue
    const w = index.weight[i]! > 0 ? index.weight[i]! : 1
    // Parallel links summed rather than last-wins: a `net.build` with merging turned off hands
    // this one row per synapse group, and taking the last one would weight the pair by whichever
    // group happened to be sorted last.
    if (graph.hasEdge(a, b)) {
      graph.setEdgeAttribute(a, b, 'weight', graph.getEdgeAttribute(a, b, 'weight') + w)
    } else {
      graph.addEdge(a, b, { weight: w })
    }
  }

  const detailed = louvain.detailed(graph, {
    resolution: o.resolution > 0 ? o.resolution : 1,
    rng: seededRandom(o.seed),
  })

  const raw = new Int32Array(n)
  for (let u = 0; u < n; u++) raw[u] = detailed.communities[String(u)] ?? -1

  const size = new Map<number, number>()
  const first = new Map<number, number>()
  for (let u = 0; u < n; u++) {
    const c = raw[u]!
    size.set(c, (size.get(c) ?? 0) + 1)
    if (!first.has(c)) first.set(c, u)
  }
  const ranked = [...size.keys()].sort(
    (a, b) => size.get(b)! - size.get(a)! || first.get(a)! - first.get(b)!,
  )
  const rank = new Map<number, number>()
  ranked.forEach((c, place) => rank.set(c, place + 1))

  const membership = new Int32Array(n)
  for (let u = 0; u < n; u++) membership[u] = rank.get(raw[u]!) ?? 0
  return { membership, count: ranked.length, modularity: detailed.modularity }
}

// ---------------------------------------------------------------------------
// The whole thing
// ---------------------------------------------------------------------------

export interface CentralityResult {
  network: NetworkValue
  nodeStats: TableValue
  summary: TableValue
}

export async function networkCentrality(
  network: NetworkValue,
  o: CentralityOptions,
  hooks: SweepHooks = {},
): Promise<CentralityResult> {
  const index = indexNetwork(network)
  const n = index.ids.length
  const values: Record<string, ColumnData> = { id: index.ids.slice() }

  let sweep: SweepResult | undefined
  if (needsSweep(o) && n > 0) {
    const adjacency = buildAdjacency(index, o.weighted)
    sweep = brandesSweep(adjacency, n, o, hooks)
  }

  if (o.betweenness) {
    const scaled = new Float64Array(n)
    if (sweep && n > 2) {
      // networkx's `_rescale(normalized=True)`: ordered pairs in the denominator for directed
      // and undirected alike, then the sampled sweep scaled back up by n / k.
      let scale = 1 / ((n - 1) * (n - 2))
      if (sweep.sources < n) scale *= n / sweep.sources
      for (let u = 0; u < n; u++) scaled[u] = sweep.betweenness[u]! * scale
    }
    values['betweenness'] = Array.from(scaled)
  }

  if (o.closeness) {
    const scaled = new Float64Array(n)
    if (sweep && n > 1) {
      let scale = 1 / (n - 1)
      if (sweep.sources < n) scale *= n / sweep.sources
      for (let u = 0; u < n; u++) scaled[u] = sweep.harmonic[u]! * scale
    }
    values['closeness'] = Array.from(scaled)
  }

  if (o.pagerank) values['pagerank'] = Array.from(pagerank(index, o.damping))
  if (o.eigenvector) values['eigenvector'] = Array.from(eigenvector(index))

  let communities: Communities | undefined
  if (o.communities) {
    communities = await louvainCommunities(index, o)
    values['community'] = Array.from(communities.membership)
  }

  const wanted = centralityNodeColumns(o)

  const summary = makeTable(centralitySummarySchema(), {
    sources: [sweep ? sweep.sources : null],
    meanPathLength: [sweep && sweep.pairs > 0 ? sweep.distanceSum / sweep.pairs : null],
    // A maximum is not a mean: a sampled sweep gives a lower bound on the diameter with no
    // error bar, so it says nothing rather than something that reads like an answer.
    diameter: [sweep && sweep.sources === n && sweep.pairs > 0 ? sweep.longest : null],
    reachable: [sweep && n > 1 ? sweep.pairs / (sweep.sources * (n - 1)) : null],
    communities: [communities ? communities.count : null],
    modularity: [
      communities && Number.isFinite(communities.modularity) ? communities.modularity : null,
    ],
  })

  return {
    network: {
      ...network,
      nodes: withNodeColumns(network.nodes, wanted, values),
    },
    nodeStats: makeTable(centralityNodeSchema(o), values),
    summary,
  }
}
