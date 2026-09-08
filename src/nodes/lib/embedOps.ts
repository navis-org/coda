/**
 * Shaping a node's inputs into the one thing UMAP consumes.
 *
 * **Every route converges on a k-NN graph**, which is the finding this module is arranged
 * around. A score matrix, a table of feature vectors and a table of nearest neighbours are
 * three ways of writing one down, and UMAP reads nothing else — so there are three adapters
 * here and one algorithm behind them, rather than three code paths that each have to be right
 * about `minDist`.
 *
 * The three are not equivalent in cost, and the guide says so rather than implying otherwise:
 *
 * - **Matrix** is `n²` already paid by whatever produced it — NBLAST, `core.similarity`, a
 *   Pivot — and reading `k` per row off it is cheap.
 * - **Features** builds that matrix here, through `similarityOps`. It folds the Similarity
 *   Matrix card in; it does **not** avoid the quadratic. Densifying the vectors and letting
 *   umap-js find its own neighbours would, and is not an option: umap-js takes `number[][]`,
 *   and `Partner Vectors` keyed by partner id is a hundred thousand features wide, so the dense
 *   form is refused by the crash floor long before the boxing is the problem.
 * - **Neighbours** is the one that escapes it. `NBLAST k-NN` scores `n × nCandidates` pairs
 *   rather than `n²`, and its output is already a k-NN graph in long form.
 *
 * The value half and the schema half sit together per invariant 3 — `embedSchema` and
 * `embedTable` — and the schema is a **constant**, which is the whole reason the annotation
 * join writes a column called `annotation` rather than one named after whatever was picked.
 */

import type { Warner } from '../../core/limits'
import { warnOverThreshold } from '../../core/limits'
import type { TableSchema } from '../../core/types'
import { column, tableSchema } from '../../core/types'
import type { CellValue, MatrixValue, TableValue } from '../../core/values'
import { getColumn, makeTable } from '../../core/values'
import type { KnnGraph } from '../../umap/run'
import type { LinkageTransform } from '../../pyodide/linkage'
import { checkSquarePopulation } from './linkageOps'
import { labelOf } from './tableOps'

// ---------------------------------------------------------------------------
// The output
// ---------------------------------------------------------------------------

/** What each row is. `cluster.cut`'s name for the same thing, so the two tables join. */
export const EMBED_LABEL_COLUMN = 'label'

/** The two coordinates, named the way scanpy and Seurat name them. */
export const EMBED_X_COLUMN = 'umap1'
export const EMBED_Y_COLUMN = 'umap2'

/**
 * What the Annotations port writes.
 *
 * A **constant**, and that is invariant 3 rather than a naming preference: a column named after
 * whichever `Label by` was picked would make this the one node whose output schema depends on a
 * param's *value*, so `inferOutputs` and `evaluate` would be two derivations of one thing and
 * every downstream picker would empty whenever the pickers moved.
 *
 * Which also settles what it is *not* called. `type` would be a lie the moment somebody labels
 * by hemilineage, and overwriting `label` would cost the join that makes this node worth
 * wiring — `Cut Tree` emits `label` too, so `Embedding ⋈ Cut Tree` on it is the
 * coloured-by-cluster scatter with an ordinary Join and no configuration.
 */
export const EMBED_ANNOTATION_COLUMN = 'annotation'

/**
 * The columns an embedding comes out as.
 *
 * `annotation` is present whether or not the port is wired, for `partnerVectorSchema`'s reason:
 * a schema that changes shape with an optional port empties every downstream picker on a graph
 * reopened without it.
 */
export function embedSchema(): TableSchema {
  return tableSchema(
    column(EMBED_LABEL_COLUMN, 'str'),
    column(EMBED_X_COLUMN, 'f64'),
    column(EMBED_Y_COLUMN, 'f64'),
    column(EMBED_ANNOTATION_COLUMN, 'str'),
  )
}

/**
 * One row per observation: what it is, where it landed, and what it is called.
 *
 * Built columnar rather than through `tableFromRows`, whose own doc says it is for small data:
 * an embedding of a whole dataset is the shape this node exists for, and the row-object form
 * allocates an object per neuron to then walk it again by string key.
 *
 * An unannotated row gets `null` rather than its own label back, which is the opposite of what
 * a Dendrogram leaf does with an unmatched name — and deliberately. There a blank leaf is worse
 * than the id it replaced, because the name *is* the drawing; here the label is still in its own
 * column, so filling `annotation` with a copy of it would put ids into a legend somebody is
 * colouring by cell type and give every unmatched neuron its own key.
 */
export function embedTable(
  labels: readonly string[],
  coords: Float64Array,
  annotations?: ReadonlyMap<string, string>,
): TableValue {
  const n = labels.length
  const label: CellValue[] = new Array(n)
  const x: CellValue[] = new Array(n)
  const y: CellValue[] = new Array(n)
  const annotation: CellValue[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const name = labels[i] ?? ''
    label[i] = name
    x[i] = coords[i * 2] ?? 0
    y[i] = coords[i * 2 + 1] ?? 0
    annotation[i] = annotations?.get(name) ?? null
  }
  return makeTable(embedSchema(), {
    [EMBED_LABEL_COLUMN]: label,
    [EMBED_X_COLUMN]: x,
    [EMBED_Y_COLUMN]: y,
    [EMBED_ANNOTATION_COLUMN]: annotation,
  })
}

// ---------------------------------------------------------------------------
// Which way in
// ---------------------------------------------------------------------------

/**
 * The three ways in, and the one statement of them.
 *
 * Read five times over — to declare the ports, to refuse an ambiguous wiring, to select the
 * route at run time, and once in each exporter — so a fourth route is one row here rather than
 * five edits, of which the two in the emitters are the ones nobody would notice missing.
 * `SOURCE_GROUP` is `PortDef.exclusiveGroup`'s value: what says these **compose with nothing**,
 * which every automatic wiring pass in the codebase otherwise assumes they do.
 */
export const SOURCE_GROUP = 'source'

export const EMBED_ROUTES = [
  { port: 'matrix', label: 'Matrix' },
  { port: 'features', label: 'Features' },
  { port: 'neighbours', label: 'Neighbours' },
] as const

export type EmbedRoute = (typeof EMBED_ROUTES)[number]['port']

/**
 * Which route a set of wires selects, or the sentence saying why none does.
 *
 * One function for `validate`, `evaluate` and both emitters, because the alternative is four
 * spellings of one refusal — and the two in the emitters would be the ones that quietly went on
 * naming three routes after a fourth arrived. `isWired` is the only thing that differs between
 * the callers: a type at edit time, a value at run time, a variable name in an exporter.
 */
export type EmbedRouteResult = { ok: true; route: EmbedRoute } | { ok: false; refusal: string }

export function embedRoute(isWired: (port: string) => boolean): EmbedRouteResult {
  const wired = EMBED_ROUTES.filter((route) => isWired(route.port))
  if (wired.length === 0) {
    return {
      ok: false,
      refusal: `Wire one of ${EMBED_ROUTES.map((r) => r.label).join(', ')} in — a score matrix, a table of feature vectors, or a table of nearest neighbours.`,
    }
  }
  if (wired.length > 1) {
    return {
      ok: false,
      refusal:
        `${wired.map((route) => route.label).join(' and ')} are wired at once, and they are ` +
        `alternatives — disconnect all but one. Which neighbours a point has would otherwise ` +
        `depend on a rule this node does not have.`,
    }
  }
  return { ok: true, route: wired[0]!.port }
}

/** The messages both halves of the Features and Neighbours routes report. See invariant 5. */
export const EMBED_ISSUES = {
  longColumns: 'Pick an Observations and a Features column',
  sameFeature:
    'Observations and Features point at the same column, so every point is identical',
  wideId: 'Pick the column naming each row',
  wideFeatures: 'Pick at least one feature column',
  neighbourColumns: 'Pick the two columns naming each neighbour pair',
  sameNeighbour:
    'From and To point at the same column, so every neuron is only its own neighbour',
} as const

// ---------------------------------------------------------------------------
// Guard rails
// ---------------------------------------------------------------------------

/**
 * Below this there is no neighbourhood structure to preserve, so there is no embedding.
 *
 * umap-js throws on `n <= nNeighbors` with a message about adjusting the configuration, which
 * is true and unhelpful — the answer is nearly always that the wrong port is wired or a filter
 * upstream emptied the set. Four is the floor at which the smallest useful `nNeighbors` (2,
 * i.e. self plus one) leaves anything for the repulsion to act on.
 */
export const MIN_EMBED_OBSERVATIONS = 4

/**
 * Where this starts saying how long it will be.
 *
 * A warning and not a refusal (`docs/limits.md`): the answer on the other side is a real one and
 * the wait is the user's to spend. The number is the point at which umap-js's fuzzy-set
 * construction — a `Map` keyed by a string per entry — stops being the small half of the run.
 */
export const EMBED_OBSERVATIONS_WARN = 20_000

/**
 * Rows and columns must be the same population, and there must be enough of them.
 *
 * The population half is `linkageOps`' — the same two questions of the same matrices, which
 * this file had restated in its own words. Only the *size* rule is genuinely different: a tree
 * needs two observations and a neighbourhood needs four.
 */
export function checkEmbedMatrix(ctx: Warner, matrix: MatrixValue): void {
  checkSquarePopulation(matrix, 'An embedding', 'single neighbourhood to lay out')
  checkEmbedCount(ctx, matrix.rowLabels.length)
}

/** The size rules, shared by all three routes because none of them changes what `n` means. */
export function checkEmbedCount(ctx: Warner, n: number): void {
  if (n < MIN_EMBED_OBSERVATIONS) {
    throw new Error(
      `An embedding needs at least ${MIN_EMBED_OBSERVATIONS} observations, got ${n}. ` +
        `Fewer than that have no neighbourhood structure to preserve.`,
    )
  }
  if (n > EMBED_OBSERVATIONS_WARN) {
    warnOverThreshold(ctx, {
      count: n,
      threshold: EMBED_OBSERVATIONS_WARN,
      unit: 'observations',
      control: 'the size this stays interactive at',
      cost:
        'UMAP runs on the main thread in slices, so the tab keeps painting — but the run is ' +
        'single-threaded and the fuzzy-set construction allocates per neighbour pair.',
    })
  }
}

/**
 * `nNeighbors`, brought inside what the data can answer.
 *
 * umap-js **throws** on `X.length <= nNeighbors` rather than clamping, so a set of 30 neurons
 * under the default 15 is fine and a set of 12 is a stack trace. Clamped and said out loud
 * instead: the number is a description of the neighbourhood scale somebody wanted, and on a
 * small set the largest honest answer is every other point.
 */
export function clampNeighbours(ctx: Warner, requested: number, n: number): number {
  const capped = Math.max(2, Math.min(requested, n - 1))
  if (capped !== requested) {
    ctx.warn(
      `Neighbours was ${requested}, which is more than ${n} observations can offer; used ` +
        `${capped}. UMAP reads that number as how local the structure is, so on a set this ` +
        `small it is describing nearly the whole of it.`,
    )
  }
  return capped
}

// ---------------------------------------------------------------------------
// Route 1: a score matrix
// ---------------------------------------------------------------------------

/**
 * The `k` nearest observations per row of a square matrix.
 *
 * A **bounded max-heap** over two reused typed arrays rather than a sort per row: `n` sorts of
 * `n` elements is `n² log n` on a matrix that is already the biggest thing in memory, and the
 * heap's root is the current worst, so the common case is one compare that rejects.
 *
 * The heap is what the first version got wrong, and it was measured rather than argued.
 * Rescanning all `k − 1` slots for the new worst is fine on random data and bad on the data
 * this node actually gets — a similarity matrix ordered by cell type displaces the running
 * top-k over and over. At `Neighbours`' maximum of 200 the rescan cost **325 ms random and
 * 584 ms ordered** at n = 3000, against **195 and 124** here; at n = 5000 ordered it is 287 ms.
 * Below about k = 20 the two are a wash and the hoists above are what pays.
 *
 * **A cell that is not finite is not a distance and is skipped**, which is how a matrix with an
 * unrecorded pair behaves rather than how `NaN` sorts. Where that leaves a row short, the
 * padding rules in `KnnGraph` apply — and `rowMax` is then exactly the largest kept distance,
 * because a short row is one where every finite cell *was* kept. Tracking a per-cell maximum to
 * get the same number was `n²` compares for a value only a short row reads.
 */
export function knnFromMatrix(
  matrix: MatrixValue,
  transform: LinkageTransform,
  k: number,
): KnnGraph {
  const n = matrix.rowLabels.length
  const wanted = k - 1
  const indices: number[][] = new Array(n)
  const distances: number[][] = new Array(n)

  // Reused across rows: the heap's two halves, and the permutation that sorts it ascending.
  const heapIdx = new Int32Array(wanted)
  const heapDist = new Float64Array(wanted)
  const order = new Int32Array(wanted)

  // Hoisted out of the `n²` loop, where it was a string comparison per cell.
  const invert = transform === 'one_minus'
  const values = matrix.values

  for (let i = 0; i < n; i++) {
    let filled = 0
    const base = i * n
    for (let j = 0; j < n; j++) {
      if (j === i) continue
      const raw = values[base + j]!
      if (!Number.isFinite(raw)) continue
      const d = invert ? 1 - raw : raw
      if (filled < wanted) {
        heapIdx[filled] = j
        heapDist[filled] = d
        filled++
        // Heapified once, when the buffer first fills — Floyd's build, `O(k)` rather than the
        // `O(k log k)` of sifting each insert up on the way in.
        if (filled === wanted) {
          for (let s = (wanted >> 1) - 1; s >= 0; s--) siftDown(heapIdx, heapDist, wanted, s)
        }
        continue
      }
      // The root is the worst kept, so this is the single branch that rejects nearly every cell.
      if (d >= heapDist[0]!) continue
      heapIdx[0] = j
      heapDist[0] = d
      siftDown(heapIdx, heapDist, wanted, 0)
    }
    indices[i] = new Array<number>(k)
    distances[i] = new Array<number>(k)
    writeRow(
      indices[i]!,
      distances[i]!,
      i,
      heapIdx,
      heapDist,
      ascending(heapDist, order, filled),
    )
  }

  return { indices, distances, labels: matrix.rowLabels.slice() }
}

/** One step of a max-heap over two parallel arrays, keyed on `dist`. */
function siftDown(idx: Int32Array, dist: Float64Array, size: number, from: number): void {
  let root = from
  const rootIdx = idx[root]!
  const rootDist = dist[root]!
  for (;;) {
    let child = root * 2 + 1
    if (child >= size) break
    const right = child + 1
    if (right < size && dist[right]! > dist[child]!) child = right
    if (dist[child]! <= rootDist) break
    idx[root] = idx[child]!
    dist[root] = dist[child]!
    root = child
  }
  idx[root] = rootIdx
  dist[root] = rootDist
}

/**
 * The permutation putting the first `count` entries in ascending distance order.
 *
 * `smoothKNNDistance` reads `nonZeroDists[index - 1]` for rho, so a row has to be *sorted*
 * rather than merely correct as a set — and a heap is not. Sorted through a reused index array
 * so the two payload arrays stay put and nothing is allocated per row; `subarray` is a view,
 * not a copy.
 */
function ascending(dist: Float64Array, order: Int32Array, count: number): Int32Array {
  for (let s = 0; s < count; s++) order[s] = s
  const view = order.subarray(0, count)
  view.sort((a, b) => dist[a]! - dist[b]!)
  return view
}

// ---------------------------------------------------------------------------
// Route 2: a table of nearest neighbours
// ---------------------------------------------------------------------------

/** Which columns of a long neighbour table say what. */
export interface NeighbourColumns {
  query: string
  target: string
  /** Absent means every listed pair is equally close, which is a graph and not a ranking. */
  score?: string | undefined
  /** Whether a bigger number means *more alike* (NBLAST) or *further apart*. */
  scoreIs: 'similarity' | 'distance'
}

/** What a neighbour table could not be used for, so the node can say it out loud. */
export interface NeighbourLosses {
  /** Rows naming a target that is not itself a query, so has no row to be placed in. */
  unknownTargets: number
  /** Observations left with no neighbour at all. */
  isolated: number
}

/**
 * A long `(query, target, score)` table as a k-NN graph.
 *
 * **The rows are the queries**, in first-appearance order, and a target that is not itself a
 * query is dropped and counted. That is the honest reading rather than a refusal: with a Target
 * wired, `NBLAST k-NN` compares two populations and the graph is bipartite — an embedding of it
 * would place every query by neighbours that are not in the picture — but the same table also
 * arrives legitimately short after a Filter, where dropping a handful of references is nothing
 * to stop for. The count is what tells the two apart, so it is returned rather than swallowed.
 *
 * A repeated pair keeps its **smallest** distance, which is the same "first wins" rule
 * `labelsByNeuron` applies read through an ordering that exists here.
 */
export function knnFromNeighbours(
  table: TableValue,
  columns: NeighbourColumns,
  requested: number,
  ctx: Warner,
): { graph: KnnGraph; losses: NeighbourLosses } {
  const queries = getColumn(table, columns.query)
  const targets = getColumn(table, columns.target)
  const scores = columns.score ? getColumn(table, columns.score) : undefined

  const labels: string[] = []
  const rowOf = new Map<string, number>()
  for (let row = 0; row < table.length; row++) {
    const name = labelOf(queries[row])
    if (name === '') continue
    if (rowOf.has(name)) continue
    rowOf.set(name, labels.length)
    labels.push(name)
  }

  /*
   * How many points there are is not knowable until the query column has been walked, so the
   * clamp happens here rather than at the node the way the matrix route's does. Same rule,
   * one place: umap-js throws on `n <= nNeighbors` rather than clamping.
   */
  checkEmbedCount(ctx, labels.length)
  const k = clampNeighbours(ctx, requested, labels.length)

  const buckets: Array<Map<number, number>> = labels.map(() => new Map())
  let unknownTargets = 0
  for (let row = 0; row < table.length; row++) {
    const from = rowOf.get(labelOf(queries[row]))
    if (from === undefined) continue
    const toName = labelOf(targets[row])
    const to = rowOf.get(toName)
    if (to === undefined) {
      if (toName !== '') unknownTargets++
      continue
    }
    // Self-matches are added back by `writeRow` at position 0. `NBLAST k-NN` with a Target wired
    // returns one at 1.0 and spends a place on it, which here would be a duplicate rather than
    // a neighbour.
    if (to === from) continue
    const raw = scores ? Number(scores[row]) : 1
    if (!Number.isFinite(raw)) continue
    const distance = columns.scoreIs === 'similarity' ? 1 - raw : raw
    const bucket = buckets[from]!
    const seen = bucket.get(to)
    if (seen === undefined || distance < seen) bucket.set(to, distance)
  }

  const indices: number[][] = new Array(labels.length)
  const distances: number[][] = new Array(labels.length)
  // The same two payload arrays `writeRow` reads on the matrix route. A bucket is already the
  // size of one query's neighbour list, so sorting it whole is cheap; what `order` buys here is
  // one shape for both routes rather than a second padding convention.
  const foundIdx = new Int32Array(k)
  const foundDist = new Float64Array(k)
  const order = new Int32Array(k)
  let isolated = 0
  for (let i = 0; i < labels.length; i++) {
    const found = [...buckets[i]!.entries()].sort((a, b) => a[1] - b[1])
    const count = Math.min(found.length, k - 1)
    if (count === 0) isolated++
    for (let s = 0; s < count; s++) {
      foundIdx[s] = found[s]![0]
      foundDist[s] = found[s]![1]
      order[s] = s
    }
    indices[i] = new Array<number>(k)
    distances[i] = new Array<number>(k)
    writeRow(indices[i]!, distances[i]!, i, foundIdx, foundDist, order.subarray(0, count))
  }

  return { graph: { indices, distances, labels }, losses: { unknownTargets, isolated } }
}

/**
 * Refuse neighbour scores that do not become distances.
 *
 * `checkLinkageDistances`' argument, one input shape over: a similarity above 1 inverts to a
 * negative distance, umap-js embeds it without complaint, and what comes back is a picture whose
 * wrongness is invisible. The two ways in want opposite fixes, so both are named.
 */
export function checkNeighbourDistances(rows: readonly number[][], scoreIs: string): void {
  let lowest = Number.POSITIVE_INFINITY
  for (const row of rows) {
    for (const d of row) if (d < lowest) lowest = d
  }
  if (!Number.isFinite(lowest) || lowest >= 0) return
  throw new Error(
    scoreIs === 'similarity'
      ? `Treating these scores as similarities gives distances as low as ${lowest.toFixed(3)}, ` +
          `and a distance cannot be negative. NBLAST scores above 1 mean Normalise is off at the ` +
          `NBLAST node; if the column already holds distances, say so with "Scores are".`
      : `These scores go as low as ${lowest.toFixed(3)}, and a distance cannot be negative. Set ` +
          `"Scores are" back to similarities if a bigger number means more alike.`,
  )
}

// ---------------------------------------------------------------------------
// The padding rules, in one function because they have to agree
// ---------------------------------------------------------------------------

/**
 * Write one row of both halves of a `KnnGraph`: self first, then the nearest found, then pad.
 *
 * **One function and not two**, which is what the pair it replaced said it needed and could not
 * enforce: two `new Array(k)`, two identical fill loops and two `row[0]` conventions that a
 * reader had to check against each other. Both call sites also held their neighbours as
 * `[index, distance]` pairs and split them with two `.map()`s purely to feed the two
 * signatures — four throwaway arrays per row on the `n²` path, plus `k` tuples.
 *
 * The two conventions, both of which fail silently and are checkable from nowhere inside
 * umap-js (see `KnnGraph`):
 *
 * - **`-1` fills a missing neighbour**, which the library skips outright.
 * - **A padded distance is `rowMax`, never infinity.** `computeMembershipStrengths` skips the
 *   `-1` index, so the padded *distance* reaches only `smoothKNNDistance` — where an infinity
 *   makes the row's mean infinite and `result[i]` with it, one short row quietly destroying its
 *   own neighbourhood. Repeating the furthest real neighbour says "nothing closer than this out
 *   here", which is what a short row means.
 */
function writeRow(
  indices: number[],
  distances: number[],
  self: number,
  foundIdx: Int32Array,
  foundDist: Float64Array,
  order: Int32Array,
): void {
  const k = indices.length
  indices[0] = self
  distances[0] = 0
  // Every finite cell was kept in a short row, so the largest kept distance *is* the row's
  // maximum — no per-cell tracking needed to find it.
  const rowMax = order.length > 0 ? foundDist[order[order.length - 1]!]! : 1
  for (let s = 1; s < k; s++) {
    const at = order[s - 1]
    if (at === undefined) {
      indices[s] = -1
      distances[s] = rowMax
      continue
    }
    indices[s] = foundIdx[at]!
    distances[s] = foundDist[at]!
  }
}

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

/**
 * How much of the embedding a wired Annotations table actually named.
 *
 * Reported rather than derived from the output, so the node can say `412 of 500 labelled` — an
 * unmatched row is a `null` in a column that also holds real blanks, and counting nulls
 * afterwards cannot tell those apart.
 */
export function countAnnotated(
  labels: readonly string[],
  annotations: ReadonlyMap<string, string>,
): number {
  let matched = 0
  for (const label of labels) if (annotations.has(label)) matched++
  return matched
}
