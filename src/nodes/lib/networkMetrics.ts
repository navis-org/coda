/**
 * The graph statistics behind `net.metrics`, in the two halves invariant 3 requires.
 *
 *   metricNodeSchema(nodes)   — the node table with the metric columns folded in
 *   nodeStatsSchema()         — the standalone per-node table's columns, a constant
 *   networkSummarySchema()    — the graph-level row's columns, a constant
 *   networkMetrics(network)   — the values for all three, from one pass over the topology
 *
 * Headless, like the rest of `src/nodes/lib`. Everything here is O(V + E) except the triangle
 * count, which is the one thing on this node that can get away from you and the one thing that
 * warns — see `triangleWork` below.
 *
 * ## Three decisions the obvious version gets wrong
 *
 * **The summary is one wide row, not a metric-per-row list.** A long table reads better in the
 * card and is worse everywhere else: the useful thing to do with this port is run it inside a
 * `For Each` over five datasets and `Collect` the results, and wide gives five rows whose
 * columns line up — a bar chart of density across connectomes is then a column picker. Long
 * would need a Pivot first, and the pivot's columns are named by its data, which is the one
 * shape `inferOutputs` cannot derive. Both schemas are constants for the same reason
 * `describeSchema` is: a picker downstream fills the moment the wire is drawn.
 *
 * **The metric columns are written *over* whatever the node table already had.** `net.build`
 * emits `degreeIn`, `degreeOut`, `weightIn` and `weightOut` itself, and `filterNetwork`
 * recomputes them, so a network arriving here usually has four of these names already. Adding
 * `degreeIn_1` beside `degreeIn` would give a column picker two answers to one question, and
 * the second would be the stale one — a network narrowed by `mapperNetwork` or `pathsToNetwork`
 * carries roll-ups those two never recompute (see `networkOps`' own note on this). Overwriting
 * is the same rule `recomputeRollups` already follows, applied to a longer list.
 *
 * **Self-loops count towards degree and towards nothing else.** A neuron synapsing onto itself
 * is a real link and `recomputeRollups` counts it in both `degreeIn` and `degreeOut`, so this
 * does too. But it is not a neighbour of itself: it cannot close a triangle, it cannot join two
 * components, and counting it in density would let a graph exceed 1. So every structural
 * measure below runs on the undirected simple projection — pairs, no self-loops — and the
 * summary reports `selfLoops` separately rather than hiding the discrepancy.
 */

import type { TableSchema } from '../../core/types'
import { column, isNumericDType, tableSchema } from '../../core/types'
import type { ColumnData, NetworkValue, TableValue } from '../../core/values'
import { getColumn, makeTable } from '../../core/values'
/*
 * The median comes from the module that owns Coda's quantile, for `describeOps`' reason: "which
 * of the nine quantile definitions" is exactly the thing two copies come to disagree about, and
 * a Distribution node and a Network Metrics node quoting different medians of the same column is
 * a bug nobody would think to look for. `boxStats` is headless and this direction is established.
 */
import { quantileSorted } from '../../ui/viewers/boxStats'
import { componentsOfNeighbours, foldNodeColumns, withNodeColumns } from './networkOps'

/**
 * Where the triangle count stops being free, in units of the work it is about to do.
 *
 * Not a node count and not a link count, because neither predicts this: the forward-ordered
 * neighbour intersection costs `Σ over undirected pairs (u,v) of d(v)`, which a graph with one
 * 5,000-partner hub blows past at a few thousand links while a 200,000-link lattice never
 * reaches. That sum is computable in O(E) *before* the nested loop runs, so the guard measures
 * the actual work rather than guessing from a proxy — see `triangleWork`.
 *
 * 50 million: a full pass over a `dataCache`-sized table is around the point where a `cheap`
 * node stops feeling instant, and this node is `cheap`. It warns and goes ahead, because a
 * clustering coefficient is not a question with no useful answer — see docs/limits.md.
 */
export const TRIANGLE_WORK_WARN = 50_000_000

// ---------------------------------------------------------------------------
// The topology, indexed once
// ---------------------------------------------------------------------------

/**
 * A network's topology as row indices, with the two kinds of unusable link counted.
 *
 * Every metric below reads this rather than the tables, so "which links exist" is decided once.
 * Both exclusions are ordinary rather than exceptional — a filtered network routinely has links
 * naming nodes it no longer holds, which is why `networkOps` skips them too rather than raising.
 */
export interface NetworkIndex {
  /** Node ids in row order. A duplicate id keeps its first row, as `connectedComponents` does. */
  ids: string[]
  /** Link ends as node rows. Self-loops are kept here; each metric decides what to do with one. */
  source: Int32Array
  target: Int32Array
  weight: Float64Array
  directed: boolean
  /** Links whose two ends are the same node. Counted in degree, excluded from everything else. */
  selfLoops: number
  /** Links naming a node the node table does not have. Dropped before anything reads them. */
  dangling: number
}

/** Weight read defensively — `networkOps`' rule, because a network need not come from `net.build`. */
function weightsOf(edges: TableValue): Float64Array {
  const has = edges.schema.columns.some((c) => c.name === 'weight')
  const data = has ? getColumn(edges, 'weight') : []
  const out = new Float64Array(edges.length)
  for (let i = 0; i < edges.length; i++) {
    const value = Number(data[i] ?? 1)
    out[i] = Number.isFinite(value) ? value : 1
  }
  return out
}

export function indexNetwork(network: NetworkValue): NetworkIndex {
  const hasId = network.nodes.schema.columns.some((c) => c.name === 'id')
  if (!hasId) {
    throw new Error(
      'Network node table has no "id" column. Every network carries one; this value was ' +
        'built by something that did not.',
    )
  }
  const ids = getColumn(network.nodes, 'id').map((cell) => String(cell ?? ''))
  const rowOf = new Map<string, number>()
  ids.forEach((id, row) => {
    if (!rowOf.has(id)) rowOf.set(id, row)
  })

  const hasEnds =
    network.edges.schema.columns.some((c) => c.name === 'source') &&
    network.edges.schema.columns.some((c) => c.name === 'target')
  const sources = hasEnds ? getColumn(network.edges, 'source') : []
  const targets = hasEnds ? getColumn(network.edges, 'target') : []
  const weight = weightsOf(network.edges)

  const source = new Int32Array(network.edges.length)
  const target = new Int32Array(network.edges.length)
  const keptWeight = new Float64Array(network.edges.length)
  let kept = 0
  let selfLoops = 0
  let dangling = 0
  for (let i = 0; i < network.edges.length; i++) {
    const from = rowOf.get(String(sources[i] ?? ''))
    const to = rowOf.get(String(targets[i] ?? ''))
    if (from === undefined || to === undefined) {
      dangling++
      continue
    }
    if (from === to) selfLoops++
    source[kept] = from
    target[kept] = to
    keptWeight[kept] = weight[i] ?? 1
    kept++
  }

  return {
    ids,
    source: source.subarray(0, kept),
    target: target.subarray(0, kept),
    weight: keptWeight.subarray(0, kept),
    directed: network.directed,
    selfLoops,
    dangling,
  }
}

// ---------------------------------------------------------------------------
// The undirected simple projection
// ---------------------------------------------------------------------------

/**
 * Neighbours in CSR form, over unique unordered pairs with self-loops removed.
 *
 * Clustering, k-core, transitivity and assortativity are all defined over an undirected simple
 * graph, and a connectome is neither: it is directed and it routinely holds both `(a, b)` and
 * `(b, a)`, which as neighbour lists would make `a` its own neighbour twice and inflate every
 * one of them. Projecting once, here, is what keeps the four from each inventing their own
 * answer to that.
 *
 * CSR rather than `Set[]`: a 100k-node connectome is 100k small Sets, which is most of a second
 * in allocation alone, and the triangle count wants neighbours *sorted* anyway.
 */
export interface Projection {
  /** `offset[u] … offset[u + 1]` indexes `neighbour` for node `u`. Sorted ascending within a node. */
  offset: Int32Array
  neighbour: Int32Array
  /**
   * The *directed* unique non-self pairs seen on the way, as `a * n + b`.
   *
   * Density and reciprocity need this and nothing else does, and it rides along here rather than
   * in a pass of its own because that pass was a second walk over every link building a second
   * million-entry `Set` — the same links, the same self-loop skip, the same key arithmetic. On a
   * network of that size the two sets were ~200 MB live at once, on a `cheap` node.
   */
  ordered: Set<number>
}

export function projectUndirected(index: NetworkIndex): Projection {
  const n = index.ids.length
  const degree = new Int32Array(n)

  /*
   * Pair keys as `u * n + v`, u < v.
   *
   * A number rather than a string: at 100k nodes the key reaches 1e10, well inside float64's
   * exact-integer range and nowhere near a string's cost. `u < v` is what makes `(a, b)` and
   * `(b, a)` the same key, which is the entire point of the projection.
   */
  const seen = new Set<number>()
  const ordered = new Set<number>()
  const pairsA: number[] = []
  const pairsB: number[] = []
  for (let i = 0; i < index.source.length; i++) {
    const a = index.source[i]!
    const b = index.target[i]!
    if (a === b) continue
    ordered.add(a * n + b)
    const lo = a < b ? a : b
    const hi = a < b ? b : a
    const key = lo * n + hi
    if (seen.has(key)) continue
    seen.add(key)
    pairsA.push(lo)
    pairsB.push(hi)
    degree[lo]!++
    degree[hi]!++
  }

  const offset = new Int32Array(n + 1)
  for (let u = 0; u < n; u++) offset[u + 1] = offset[u]! + degree[u]!
  const neighbour = new Int32Array(offset[n]!)
  const cursor = Int32Array.from(offset.subarray(0, n))
  for (let i = 0; i < pairsA.length; i++) {
    const a = pairsA[i]!
    const b = pairsB[i]!
    neighbour[cursor[a]!++] = b
    neighbour[cursor[b]!++] = a
  }
  // Sorted within each node: the triangle count walks `> v` prefixes and the intersection is
  // cheaper on ordered runs. `subarray().sort()` sorts in place, in the shared buffer.
  for (let u = 0; u < n; u++) neighbour.subarray(offset[u]!, offset[u + 1]!).sort()

  return { offset, neighbour, ordered }
}

/**
 * What the triangle count is about to cost, exactly, before it costs it.
 *
 * `Σ over pairs (u, v), u < v, of d(v)` — the inner walk the intersection does per pair. Cheap
 * to compute (one pass over the projection) and the honest number to warn on, because the two
 * obvious proxies both mislead: node count says nothing at all, and link count says a
 * hub-and-spoke graph and a lattice with the same number of links cost the same, which is off
 * by three orders of magnitude in a connectome's favour — the wrong way.
 */
export function triangleWork(p: Projection): number {
  let work = 0
  for (let u = 0; u < p.offset.length - 1; u++) {
    for (let i = p.offset[u]!; i < p.offset[u + 1]!; i++) {
      const v = p.neighbour[i]!
      if (v > u) work += p.offset[v + 1]! - p.offset[v]!
    }
  }
  return work
}

/** Triangles through each node, and the graph's total. Forward-ordered, so each is found once. */
export function countTriangles(p: Projection): { perNode: Float64Array; total: number } {
  const n = p.offset.length - 1
  const perNode = new Float64Array(n)
  const mark = new Int32Array(n).fill(-1)
  let total = 0

  for (let u = 0; u < n; u++) {
    for (let i = p.offset[u]!; i < p.offset[u + 1]!; i++) mark[p.neighbour[i]!] = u
    for (let i = p.offset[u]!; i < p.offset[u + 1]!; i++) {
      const v = p.neighbour[i]!
      if (v <= u) continue
      for (let j = p.offset[v]!; j < p.offset[v + 1]!; j++) {
        const w = p.neighbour[j]!
        if (w <= v) continue
        if (mark[w] !== u) continue
        perNode[u]!++
        perNode[v]!++
        perNode[w]!++
        total++
      }
    }
  }
  return { perNode, total }
}

/**
 * k-core number per node: the largest k for which the node survives peeling every vertex of
 * degree below k. Batagelj–Zaversnik bucket peeling, O(V + E).
 *
 * On a connectome this is the metric that says "core circuit" without a threshold anybody had
 * to choose, which is why it is here rather than in the expensive node: it costs a linear pass.
 */
export function coreness(p: Projection): Int32Array {
  const n = p.offset.length - 1
  const degree = new Int32Array(n)
  let maxDegree = 0
  for (let u = 0; u < n; u++) {
    degree[u] = p.offset[u + 1]! - p.offset[u]!
    if (degree[u]! > maxDegree) maxDegree = degree[u]!
  }

  // Bucket sort by degree, then peel in increasing order, moving each survivor one bucket down.
  const binStart = new Int32Array(maxDegree + 2)
  for (let u = 0; u < n; u++) binStart[degree[u]!]!++
  let running = 0
  for (let d = 0; d <= maxDegree; d++) {
    const count = binStart[d]!
    binStart[d] = running
    running += count
  }
  const order = new Int32Array(n)
  const position = new Int32Array(n)
  const cursor = Int32Array.from(binStart)
  for (let u = 0; u < n; u++) {
    position[u] = cursor[degree[u]!]!
    order[position[u]!] = u
    cursor[degree[u]!]!++
  }

  const core = Int32Array.from(degree)
  for (let i = 0; i < n; i++) {
    const u = order[i]!
    for (let e = p.offset[u]!; e < p.offset[u + 1]!; e++) {
      const v = p.neighbour[e]!
      if (core[v]! <= core[u]!) continue
      // Swap v to the front of its degree bucket, then shrink the bucket by one.
      const dv = core[v]!
      const pv = position[v]!
      const pw = binStart[dv]!
      const w = order[pw]!
      if (v !== w) {
        order[pv] = w
        order[pw] = v
        position[v] = pw
        position[w] = pv
      }
      binStart[dv]!++
      core[v]!--
    }
  }
  return core
}

/**
 * Degree assortativity: the Pearson correlation of the degrees at the two ends of a link.
 *
 * Over the undirected projection with total degree, and over both orientations of each pair —
 * networkx's `degree_assortativity_coefficient` on an undirected graph, so a number quoted from
 * here can be compared with one quoted from there. Null on a graph with no links and on a
 * regular one, where the correlation is 0/0 rather than 0: every link has identical ends, so
 * there is no variation to correlate and "0" would read as "no preference" when the truth is
 * that the question does not apply.
 */
export function degreeAssortativity(p: Projection): number | null {
  const n = p.offset.length - 1
  const degree = new Int32Array(n)
  for (let u = 0; u < n; u++) degree[u] = p.offset[u + 1]! - p.offset[u]!

  let sumX = 0
  let sumXY = 0
  let sumXX = 0
  let samples = 0
  for (let u = 0; u < n; u++) {
    for (let i = p.offset[u]!; i < p.offset[u + 1]!; i++) {
      const v = p.neighbour[i]!
      const x = degree[u]!
      const y = degree[v]!
      sumX += x
      sumXY += x * y
      sumXX += x * x
      samples++
    }
  }
  if (samples === 0) return null
  const meanX = sumX / samples
  const variance = sumXX / samples - meanX * meanX
  if (variance <= 0) return null
  return (sumXY / samples - meanX * meanX) / variance
}

// ---------------------------------------------------------------------------
// Schemas — the half that runs at edit time
// ---------------------------------------------------------------------------

/** The per-node columns, in the order they are written. `id` first, as everywhere else. */
const NODE_COLUMNS = [
  column('degreeIn', 'i64'),
  column('degreeOut', 'i64'),
  column('degree', 'i64'),
  column('weightIn', 'f64'),
  column('weightOut', 'f64'),
  column('strength', 'f64'),
  column('clustering', 'f64'),
  column('coreness', 'i64'),
  column('component', 'i64'),
  column('componentSize', 'i64'),
]

/** Names this node writes onto a network's node table, for anything that needs to check. */
export const METRIC_COLUMNS: readonly string[] = NODE_COLUMNS.map((c) => c.name)

/** The standalone `Node stats` table: the id and the metrics, nothing carried along. */
export function nodeStatsSchema(): TableSchema {
  return tableSchema(column('id', 'str'), ...NODE_COLUMNS)
}

/**
 * The node table with the metric columns folded in — kept where they already are, appended
 * where they are new.
 *
 * Position matters more than it looks: a column that moves to the end on every run is a table
 * whose columns reorder when nothing about it changed, which is what a reader reads as the
 * data having changed.
 */
export function metricNodeSchema(nodes: TableSchema | undefined): TableSchema {
  return foldNodeColumns(nodes, NODE_COLUMNS)
}

/**
 * The graph-level row. A constant, and wide — see the header on why this is not one row per
 * metric.
 *
 * `directed` rides along as a column rather than being left to the reader because the moment
 * these rows are stacked across datasets it is the thing that decides whether `density` and
 * `reciprocity` next to each other mean anything.
 */
export function networkSummarySchema(): TableSchema {
  return tableSchema(
    column('nodes', 'i64'),
    column('links', 'i64'),
    column('directed', 'bool'),
    column('selfLoops', 'i64'),
    column('parallelLinks', 'i64'),
    column('isolated', 'i64'),
    column('density', 'f64'),
    column('meanDegree', 'f64'),
    column('medianDegree', 'f64'),
    column('maxDegree', 'i64'),
    column('reciprocity', 'f64'),
    column('components', 'i64'),
    column('largestComponent', 'i64'),
    column('meanClustering', 'f64'),
    column('transitivity', 'f64'),
    column('assortativity', 'f64'),
    column('totalWeight', 'f64'),
    column('meanWeight', 'f64'),
    column('medianWeight', 'f64'),
    column('maxWeight', 'f64'),
  )
}

// ---------------------------------------------------------------------------
// What the card's histogram can be pointed at
// ---------------------------------------------------------------------------

/**
 * The card holds three tables, and its one histogram has to be able to bin any of them.
 *
 * Node metrics, link weights and component sizes are not columns of one table and never can be
 * — they are counts of different things, one row per node, per link and per component. So the
 * picker's vocabulary is a `source:column` pair rather than a column name, and it lives here,
 * beside the schemas it is derived from, because two parties need exactly the same list: the
 * node, whose `histColumn` options are built from the input's *schema* before anything runs,
 * and the card, which builds them from the tables it is drawing. Written twice they would
 * differ the first time a column was added.
 *
 * Not a `column` param, for the reason above — `ctx.column()` resolves against one table, and
 * invariant 5's whole point is that there is one resolution. A pair that names its table is a
 * different question, kept deliberately distinct from the one a column picker asks.
 */
export type HistogramSource = 'nodes' | 'links' | 'components'

export interface HistogramChoice {
  source: HistogramSource
  column: string
}

/** The one-column table of component sizes the card derives. */
export const COMPONENT_SIZE_COLUMN = 'size'

/** `degree`, because it is the distribution somebody looks at first. */
export const DEFAULT_HISTOGRAM_CHOICE = 'nodes:degree'

const SOURCES: readonly HistogramSource[] = ['nodes', 'links', 'components']

/**
 * Every numeric column of the three tables, as picker options.
 *
 * Node columns keep their bare names — they are the common case and the metrics are what the
 * node is for. The other two are prefixed, because `weight` on a link and `weight` on a node
 * would otherwise be one word twice: a picker cannot say which table it means, and the two are
 * routinely both present.
 *
 * Called with schemas rather than tables so the node can offer the list before it runs. A
 * missing `edges` is a wire not yet drawn, and the list simply fills when it is.
 */
export function histogramChoices(
  nodes: TableSchema | undefined,
  edges: TableSchema | undefined,
): Array<{ value: string; label: string }> {
  const options: Array<{ value: string; label: string }> = []
  for (const col of metricNodeSchema(nodes).columns) {
    if (isNumericDType(col.dtype)) options.push({ value: `nodes:${col.name}`, label: col.name })
  }
  for (const col of edges?.columns ?? []) {
    if (isNumericDType(col.dtype)) {
      options.push({ value: `links:${col.name}`, label: `link ${col.name}` })
    }
  }
  // Always last and always there: the sizes are derived by the metrics themselves, so unlike
  // the other two this entry does not depend on what the network happens to carry.
  options.push({ value: `components:${COMPONENT_SIZE_COLUMN}`, label: 'component size' })
  return options
}

/**
 * A stored choice as the pair it names.
 *
 * Falls back only on a string that is not a pair at all — a value from a build that stored
 * something else, or a hand-edited file. A pair naming a column the network does not have is
 * returned **as written**, because a schema without a column is very often a schema that has
 * not arrived, and substituting is how a picker quietly starts answering a different question
 * (the standing rule for column params, which this is a cousin of). The card draws an empty
 * state for it instead, which says so.
 */
export function parseHistogramChoice(value: unknown): HistogramChoice {
  const text = typeof value === 'string' ? value : ''
  const cut = text.indexOf(':')
  const source = text.slice(0, cut) as HistogramSource
  const column = text.slice(cut + 1)
  if (cut > 0 && column.length > 0 && SOURCES.includes(source)) return { source, column }
  return parseHistogramChoice(DEFAULT_HISTOGRAM_CHOICE)
}

// ---------------------------------------------------------------------------
// Values — the half that runs on data
// ---------------------------------------------------------------------------

export interface NetworkMetrics {
  /** The input network, with the metric columns written onto its node table. */
  network: NetworkValue
  /** id + metrics, one row per node. */
  nodeStats: TableValue
  /** One row, the graph-level numbers. */
  summary: TableValue
  /** What the triangle count was about to cost, for the caller's warn. */
  triangleWork: number
  /**
   * One entry per component, largest first — the sizes, not the per-node column.
   *
   * On the result because it is a fact about the *graph* and the walk that produced it already
   * had it. The card bins these into its Component size distribution, and re-grouping the
   * per-node `component` column to get them back is a pass over every node to rebuild a map
   * this function built and threw away.
   */
  componentSizes: number[]
  /** Links naming a node the network does not hold. Dropped, and worth saying so. */
  dangling: number
}

/** The median of an already-sorted run, or null where there is nothing to take one of. */
function median(sorted: ArrayLike<number>): number | null {
  return sorted.length === 0 ? null : quantileSorted(sorted, 0.5)
}

/**
 * Every metric, from one index and one projection.
 *
 * One function rather than ten exported ones because the caller needs all of them and they
 * share the two expensive constructions. The pieces above stay exported anyway — each is
 * separately testable, and `networkMetrics.test.ts` pins them against hand-worked graphs where
 * the composite answer would only say that *something* is wrong.
 */
/**
 * Memoised on the network object, on `describeTable`'s terms and for its reason.
 *
 * This is called twice for the same network on every run — once by `evaluate` and once by the
 * card, which reads the node's *input* rather than its output precisely so that the two calls
 * are handed the same object. Without the memo, every edit on a `cheap` node counts every
 * triangle twice.
 *
 * A cache over a pure function of an immutable input, so invariant 4 is untouched.
 *
 * **Which is why nothing here warns.** The guard rails belong in the node's `evaluate`, on
 * `out.describe`'s model — `triangleWork` and `dangling` come back on the result for it to warn
 * *from*. Raising them in here looked equivalent and was not: the card calls this too, and it
 * draws from the node's input, so on the ordinary chain the card primes the memo first and
 * `evaluate` then gets a hit and warns about nothing. A guard rail whose firing depends on which
 * caller arrived first is not a guard rail.
 */
const MEMO = new WeakMap<NetworkValue, NetworkMetrics>()

export function networkMetrics(network: NetworkValue): NetworkMetrics {
  const hit = MEMO.get(network)
  if (hit) return hit
  const built = computeMetrics(network)
  MEMO.set(network, built)
  return built
}

function computeMetrics(network: NetworkValue): NetworkMetrics {
  const index = indexNetwork(network)
  const n = index.ids.length
  const projection = projectUndirected(index)
  // An O(E) pass, which is what lets the node state the cost of the triangle count before
  // paying it rather than after — see `TRIANGLE_WORK_WARN`.
  const work = triangleWork(projection)

  const degreeIn = new Float64Array(n)
  const degreeOut = new Float64Array(n)
  const weightIn = new Float64Array(n)
  const weightOut = new Float64Array(n)
  for (let i = 0; i < index.source.length; i++) {
    const from = index.source[i]!
    const to = index.target[i]!
    const w = index.weight[i]!
    degreeOut[from]!++
    weightOut[from]! += w
    degreeIn[to]!++
    weightIn[to]! += w
  }

  const { perNode: triangles, total: triangleCount } = countTriangles(projection)
  const cores = coreness(projection)
  /*
   * Over the projection, not over the `NetworkValue`.
   *
   * `connectedComponents` takes the value and rebuilds the id list, a second `Map` and one
   * two-element array per link to reach the adjacency this function is already holding — the
   * most expensive thing on the node, on a graph of any size. `componentsOfNeighbours` is the
   * same walk and the same largest-first contract, given the neighbours directly. The
   * projection is exactly the right graph: undirected, self-loops dropped, dangling links gone.
   */
  const component = componentsOfNeighbours(n, (u) =>
    projection.neighbour.subarray(projection.offset[u]!, projection.offset[u + 1]!),
  )

  const componentSize = new Int32Array(n)
  const sizeOf = new Map<number, number>()
  for (const c of component) sizeOf.set(c, (sizeOf.get(c) ?? 0) + 1)
  for (let u = 0; u < n; u++) componentSize[u] = sizeOf.get(component[u]!) ?? 0
  // Components are numbered largest-first, so ranking the keys sorts the sizes for free.
  const componentSizes = [...sizeOf.keys()].sort((a, b) => a - b).map((c) => sizeOf.get(c)!)

  const clustering = new Float64Array(n)
  let clusteringSum = 0
  let clusteringCount = 0
  let triples = 0
  for (let u = 0; u < n; u++) {
    const k = projection.offset[u + 1]! - projection.offset[u]!
    triples += (k * (k - 1)) / 2
    if (k < 2) {
      // Not zero-with-a-caveat: a node with one neighbour has no pair of them to be closed, so
      // its clustering is undefined. networkx reports 0 here; this reports null, because a
      // column of zeros for every leaf drags `meanClustering` towards the number of leaves
      // rather than towards anything about the graph. `meanClustering` averages what exists.
      clustering[u] = Number.NaN
      continue
    }
    const value = (2 * triangles[u]!) / (k * (k - 1))
    clustering[u] = value
    clusteringSum += value
    clusteringCount++
  }

  // Density and reciprocity over unique non-self pairs: a network whose parallel links were
  // never merged would otherwise report a density above 1, which is not a large number, it is
  // a wrong one. The set was built by `projectUndirected`, which walked these links already.
  const orderedPairs = projection.ordered
  let reciprocated = 0
  if (index.directed) {
    for (const key of orderedPairs) {
      const a = Math.floor(key / n)
      const b = key - a * n
      if (orderedPairs.has(b * n + a)) reciprocated++
    }
  }

  /*
   * One pass for the four things a degree column is asked for, and a typed sort for the fifth.
   *
   * `TypedArray#sort` is numeric by default and needs no comparator call per comparison; the
   * boxed `number[]` this used to build, copy and `reduce` was three more walks over every node
   * to reach numbers the loop below was already passing.
   */
  const total = new Float64Array(n)
  const strength = new Float64Array(n)
  let isolated = 0
  let maxDegree = 0
  let degreeSum = 0
  for (let u = 0; u < n; u++) {
    total[u] = degreeIn[u]! + degreeOut[u]!
    strength[u] = weightIn[u]! + weightOut[u]!
    degreeSum += total[u]!
    if (total[u]! === 0) isolated++
    if (total[u]! > maxDegree) maxDegree = total[u]!
  }
  const sortedDegrees = total.slice().sort()
  const meanDegree = n > 0 ? degreeSum / n : null

  const sortedWeights = index.weight.slice().sort()
  let totalWeight = 0
  for (let i = 0; i < index.weight.length; i++) totalWeight += index.weight[i]!

  const possible = index.directed ? n * (n - 1) : (n * (n - 1)) / 2
  const observed = index.directed ? orderedPairs.size : projection.neighbour.length / 2
  const density = possible > 0 ? observed / possible : null

  // `sizeOf` is already keyed by component id, so its size *is* the component count.
  const components = sizeOf.size
  let largestComponent = 0
  for (const size of sizeOf.values()) if (size > largestComponent) largestComponent = size

  const nodeValues: Record<string, ColumnData> = {
    id: index.ids.slice(),
    degreeIn: Array.from(degreeIn),
    degreeOut: Array.from(degreeOut),
    degree: Array.from(total),
    weightIn: Array.from(weightIn),
    weightOut: Array.from(weightOut),
    strength: Array.from(strength),
    clustering: Array.from(clustering, (v) => (Number.isNaN(v) ? null : v)),
    coreness: Array.from(cores),
    component: [...component],
    componentSize: Array.from(componentSize),
  }

  const summary = makeTable(networkSummarySchema(), {
    nodes: [n],
    links: [index.source.length],
    directed: [index.directed],
    selfLoops: [index.selfLoops],
    parallelLinks: [Math.max(0, index.source.length - index.selfLoops - orderedPairs.size)],
    isolated: [isolated],
    density: [density],
    meanDegree: [meanDegree],
    medianDegree: [median(sortedDegrees)],
    maxDegree: [maxDegree],
    // Undirected reciprocity is 1 by construction — every link is its own reverse — so
    // reporting it would be reporting the value of `directed`, in a column nobody would read
    // that way. Null says the question does not apply, which is what it does elsewhere here.
    reciprocity: [
      index.directed && orderedPairs.size > 0 ? reciprocated / orderedPairs.size : null,
    ],
    components: [components],
    largestComponent: [largestComponent],
    meanClustering: [clusteringCount > 0 ? clusteringSum / clusteringCount : null],
    transitivity: [triples > 0 ? (3 * triangleCount) / triples : null],
    assortativity: [degreeAssortativity(projection)],
    totalWeight: [totalWeight],
    meanWeight: [sortedWeights.length > 0 ? totalWeight / sortedWeights.length : null],
    medianWeight: [median(sortedWeights)],
    // Off the sorted array's end rather than `Math.max(...)`: spreading a million link weights
    // into an argument list is a stack overflow, and a network of that size is the ordinary case.
    maxWeight: [sortedWeights.length > 0 ? sortedWeights[sortedWeights.length - 1]! : null],
  })

  return {
    network: {
      ...network,
      nodes: withMetricColumns(network.nodes, nodeValues),
    },
    nodeStats: makeTable(nodeStatsSchema(), nodeValues),
    summary,
    triangleWork: work,
    componentSizes,
    dangling: index.dangling,
  }
}

/** The value half of `metricNodeSchema`. `networkOps.withNodeColumns` has the rules. */
export function withMetricColumns(
  nodes: TableValue,
  values: Record<string, ColumnData>,
): TableValue {
  return withNodeColumns(nodes, NODE_COLUMNS, values)
}
