/**
 * Skeletons in, the shape NBLAST wants out.
 *
 * Headless and pure, which is the whole point: the Python side cannot be tested here (vitest
 * has no Pyodide) and the worker cannot either (jsdom has no `Worker`), so everything that can
 * be decided without them is decided here, where a test can see it. What is left on the other
 * side of the seam is one call.
 */

import type { Warner } from '../../core/limits'
import {
  describeDuration,
  formatBytes,
  refuseIfOverCrashFloor,
  warnOverThreshold,
} from '../../core/limits'
import type { DType, TableSchema } from '../../core/types'
import { column, findColumn, tableSchema } from '../../core/types'
import type { CellValue, MatrixValue, SkeletonsValue, TableValue } from '../../core/values'
import {
  getColumn,
  isSkeletonsValue,
  makeMatrix,
  skeletonPointCount,
  tableFromRows,
} from '../../core/values'
import type { Value } from '../../core/values'
import type { NblastKnnResult, NblastResult, PointSet } from '../../pyodide/nblast'

/**
 * Coda's skeletons are nanometres; NBLAST's scoring matrix is micrometres.
 *
 * This is the one number in the feature that produces a confident wrong answer rather than an
 * error. The FCWB matrix fastcore embeds runs out at a 40 um distance bin, and past it every
 * cell is about -10 — so a set of neurons handed over in nanometres scores as if no two of them
 * had ever been near each other, uniformly, with nothing anywhere to say why. See `nblast.py`.
 */
export const NM_PER_UM = 1000

/**
 * Pairs a second, measured on this wheel: single-threaded in wasm at a thousand points a
 * neuron, about 15,000.
 *
 * The one number the estimate below is built from, so a faster runtime moves the warning rather
 * than the other way round.
 */
const NBLAST_PAIRS_PER_SECOND = 15_000

/**
 * Where a comparison starts saying how long it will be: about seventeen seconds of scoring.
 *
 * This was `MAX_NBLAST_PAIRS`, and it refused. Two hundred and fifty thousand pairs is a 500 x
 * 500 all-by-all, which sounds generous until you notice that a cell type against its own
 * hemisphere is routinely twice that — so the guard rail was deciding which comparisons were
 * scientifically permissible on the basis of a seventeen-second measurement. It now says how
 * many minutes it will be, in front of a Cancel button, and scores.
 *
 * Checked against the two counts *before* anything is marshalled, so the sentence arrives
 * before the wait rather than after it.
 */
const NBLAST_PAIRS_WARN = 250_000

/**
 * How the two directions of a pair are combined, and what each is called on a card.
 *
 * Shared by both NBLAST nodes rather than re-typed: they take the same values through to the
 * same fastcore argument, and two lists that must agree are one list.
 */
export const SYMMETRY_OPTIONS = [
  { value: 'mean', label: 'mean of both directions' },
  { value: 'min', label: 'weaker direction' },
  { value: 'max', label: 'stronger direction' },
  { value: 'none', label: 'query against target only' },
]

/**
 * Lay a skeleton set out flat, in micrometres.
 *
 * Three buffers, every neuron after the last, because that is what crosses a `postMessage`
 * without being cloned point by point.
 *
 * **Nothing is dropped, however small.** A one-point skeleton is a degenerate dotprop, and the
 * temptation is to filter those out — but then the rows coming back no longer line up with the
 * neurons that went in, and every label after the dropped one is wrong. fastcore was checked
 * against exactly these cases rather than guessed at: it clamps `k` to the point count, takes a
 * single point, and resamples a multi-rooted fragment without complaint.
 */
export function dotpropSetFrom(skeletons: SkeletonsValue): PointSet {
  const total = skeletonPointCount(skeletons)

  const points = new Float32Array(total * 3)
  const parents = new Int32Array(total)
  const offsets = new Int32Array(skeletons.items.length + 1)

  let at = 0
  for (let n = 0; n < skeletons.items.length; n++) {
    const item = skeletons.items[n]!
    const count = item.parents.length
    for (let i = 0; i < count; i++) {
      points[(at + i) * 3] = item.positions[i * 3]! / NM_PER_UM
      points[(at + i) * 3 + 1] = item.positions[i * 3 + 1]! / NM_PER_UM
      points[(at + i) * 3 + 2] = item.positions[i * 3 + 2]! / NM_PER_UM
      // Parent indices stay neuron-local: `nblast.py` slices each neuron out and hands
      // fastcore row numbers as node ids, so a global offset here would be a forest of
      // dangling references rather than a tree.
      parents[at + i] = item.parents[i]!
    }
    at += count
    offsets[n + 1] = at
  }
  return { points, parents, offsets }
}

/**
 * What to call each row.
 *
 * Neuron ids unless a column was picked, and neuron ids again wherever that column is empty — a
 * neuron with no type is still a neuron, and a blank row label in a heatmap is a row nobody
 * can identify rather than a row with nothing to say.
 */
export function nblastLabels(skeletons: SkeletonsValue, column: string | undefined): string[] {
  const values = column ? getColumn(skeletons.attributes, column) : undefined
  return skeletons.items.map((item, i) => {
    const cell = values?.[i]
    return cell === null || cell === undefined || cell === '' ? item.id : String(cell)
  })
}

/**
 * Refuse coordinates that are not nanometres, naming the side.
 *
 * A refusal rather than a warning, and that is forced rather than chosen: there is no run-time
 * warning channel here that survives a result being restored from cache instead of recomputed
 * (see `unmatchedLabels` for the same gap worked around a different way). Given the choice
 * between silence and a stop, a comparison whose every number would be wrong should stop.
 *
 * **Absent units are allowed through.** Absent means unknown, and no source produces it today —
 * every geometry value from either source says `nm` or `voxels`. Refusing on it would refuse on
 * a fact nobody stated, which is the same distinction `columnSchemaFor` draws between a schema
 * that is missing and one that is empty.
 */
export function checkNblastUnits(side: string, skeletons: SkeletonsValue): void {
  if (skeletons.units === undefined || skeletons.units === 'nm') return
  throw new Error(
    `${side} skeletons are in ${skeletons.units}, not nanometres, so NBLAST would compare them ` +
      `at the wrong scale and say nothing about it. This happens when the dataset's Meta ` +
      `publishes no voxelSize or no unit this build recognises, so the fetch had nothing to ` +
      `convert with — the Skeletons node's footer says which units it got.`,
  )
}

/**
 * Refuse a comparison between two template spaces, which is a comparison of nothing.
 *
 * NBLAST asks how well one neuron's arbor lies *along* another's, so it is entirely a question
 * about where the two sit. Two reconstructions in unrelated coordinate systems are hundreds of
 * micrometres apart and differently scaled: every pair scores like two neurons that have never
 * met — uniformly, confidently, and with nothing anywhere to say why. Exactly the shape of the
 * nanometres-versus-micrometres trap `checkNblastUnits` exists for, one level up.
 *
 * `docs/python-pyodide.md` recorded this as out of reach — *"NBLAST across datasets means
 * nothing without a template-space registration, which Coda has no route to yet"*. There is a
 * route now, so this stops being a caveat in a document and becomes a refusal that names it.
 *
 * **Absent means unknown on either side and lets the comparison through**, which is
 * `checkNblastUnits`' rule and matters more here: a synthetic connectome and an unregistered
 * Custom dataset both produce spaceless geometry, and refusing on a fact nobody stated would
 * break the mock chains every example runs on. What is refused is two sides that *both* say,
 * and disagree.
 */
export function checkNblastSpaces(query: SkeletonsValue, target: SkeletonsValue): void {
  if (!query.space || !target.space || query.space === target.space) return
  throw new Error(
    `Query skeletons are in ${query.space} and Target skeletons are in ${target.space}. NBLAST ` +
      'scores how well two arbors lie along each other, so across two coordinate systems it ' +
      'would score every pair as a stranger and say nothing about it. Put both sides through ' +
      'Transform Neurons first.',
  )
}

/**
 * Say what an oversized comparison will cost, naming both sides so it is clear which one to cut
 * — and refuse only the one that cannot produce a matrix at all.
 */
export function checkNblastSize(ctx: Warner, rows: number, cols: number): void {
  const pairs = rows * cols
  refuseIfOverCrashFloor(
    `A ${rows.toLocaleString()} x ${cols.toLocaleString()} score matrix`,
    pairs * 8,
  )
  if (pairs <= NBLAST_PAIRS_WARN) return
  warnOverThreshold(ctx, {
    count: pairs,
    threshold: NBLAST_PAIRS_WARN,
    unit: `pairs (${rows.toLocaleString()} x ${cols.toLocaleString()})`,
    control: 'what this node scores without comment',
    cost:
      `That is ${describeDuration(pairs / NBLAST_PAIRS_PER_SECOND)} of scoring — it runs ` +
      `single-threaded in the browser at roughly ${NBLAST_PAIRS_PER_SECOND.toLocaleString()} ` +
      `pairs a second — and the matrix comes to ${formatBytes(pairs * 8)}.`,
  })
}

/**
 * Read both sides of a comparison: refuse what must not reach the runtime, and say what the
 * rest will cost.
 *
 * Both NBLAST nodes ask the same four questions of their inputs — is this a skeleton set, is
 * it empty, is it a big one, is it in nanometres — and asked at each node they were the same
 * twenty lines twice, including the messages. The precedent is `neuronIdsFrom` in
 * `query/morphology.ts`, which folds the identical three concerns for the three fetch nodes.
 *
 * The four are not the same *kind* of question, and that is the distinction the guard rails
 * lost for a while. Wrong units produce a confident wrong matrix, so that one refuses and
 * always will. A large set produces a correct matrix slowly, so it warns — which is why the
 * count is checked here and the seventeen-second ceiling that used to sit beside it is gone.
 */
export function nblastSidesFrom(
  ctx: Warner,
  queryValue: Value | undefined,
  targetValue: Value | undefined,
  limit: number,
): { query: SkeletonsValue; target?: SkeletonsValue } {
  if (!isSkeletonsValue(queryValue)) throw new Error('Query input is not a set of skeletons')
  if (targetValue !== undefined && !isSkeletonsValue(targetValue)) {
    throw new Error('Target input is not a set of skeletons')
  }
  if (queryValue.items.length === 0) throw new Error('No skeletons on the Query input')

  const saySo = (side: string, count: number): void => {
    warnOverThreshold(ctx, {
      count,
      threshold: limit,
      unit: `neurons on ${side}`,
      control: "this node's Warn above",
      cost: 'Scoring is single-threaded in the browser and grows with the product of the two sides.',
    })
  }
  if (queryValue.items.length > limit) saySo('Query', queryValue.items.length)
  if (targetValue && targetValue.items.length > limit) saySo('Target', targetValue.items.length)

  checkNblastUnits('Query', queryValue)
  if (targetValue) {
    checkNblastUnits('Target', targetValue)
    // Only meaningful with two sides. An all-by-all is one set against itself, which is in one
    // space by construction however little it says about which.
    checkNblastSpaces(queryValue, targetValue)
  }

  return { query: queryValue, ...(targetValue ? { target: targetValue } : {}) }
}

/**
 * What both nodes warn about at edit time.
 *
 * One rule, because it is a fact about NBLAST rather than about either node.
 */
export function nblastIssues(resample: number): string[] {
  return resample === 0
    ? ['Resample is 0, so scores follow how finely each neuron was traced as much as its shape']
    : []
}

/** The scores, as the value the Heatmap and Normalize already understand. */
export function nblastMatrix(
  result: NblastResult,
  rowLabels: string[],
  colLabels: string[],
): MatrixValue {
  // Through `makeMatrix` rather than a literal: it is the one place that checks the labels
  // against the values, and a label array that has drifted from the result would otherwise
  // reach the Heatmap silently. Similarity whether or not it was normalised — un-normalised
  // scores are unbounded but they still rise with likeness, and a clustering node has to know
  // to invert them.
  return makeMatrix(rowLabels, colLabels, result.scores, 'NBLAST score', 'similarity')
}

/**
 * The columns a k-NN result comes out as.
 *
 * **`queryId` / `targetId` rather than navis's `query` / `target`**, and that is not gratuitous
 * divergence: `isIdentifierColumn` reads a column name's *last word* to decide whether a number
 * is an identifier or a quantity, so a column called `query` would print body 527536 as
 * "527,536" — a string no query accepts and, under another locale, not even the same string.
 * The Python emitter renames navis's frame to these, or every downstream cell in the notebook
 * would be addressing columns that are not there.
 */
export function knnSchema(withLabels: boolean, idType: DType = 'i64'): TableSchema {
  return tableSchema(
    column('queryId', idType),
    column('targetId', idType),
    column('rank', 'i64'),
    column('score', 'f64'),
    ...(withLabels ? [column('queryLabel', 'str'), column('targetLabel', 'str')] : []),
  )
}

/**
 * What dtype an id column built from this set should be: whatever its own `neuronId` already is.
 *
 * The ids are copied out of the attribute table rather than re-derived from the geometry, so
 * mirroring the dtype is what keeps `queryId` joinable against the `neuronId` it came from and
 * comparable the same way. Deciding here instead would mean choosing between rounding a wide id
 * back into an `i64` and handing every neuPrint user a text column where a number was —
 * which changes what a bare `527536` means in a Table filter, and how the column sorts.
 *
 * `i64` for a set carrying no `neuronId` at all, which is what the node advertises unwired.
 */
export function idTypeOf(schema: TableSchema | undefined): DType {
  return findColumn(schema, 'neuronId')?.dtype ?? 'i64'
}

/**
 * One row per (neuron, neighbour), best first.
 *
 * **Padding is dropped.** fastcore fills a short row with `-1` / `-inf` to keep the two arrays
 * rectangular; carrying that into a table would put a neighbour called -1 with a score of
 * negative infinity in front of somebody. What is left is a table with fewer than `k` rows for
 * such a neuron, which is the honest artefact — there is no run-time channel to say more, and
 * a count returned to a caller that discards it is not one.
 *
 * `rank` is 1-based, so the best match reads as rank 1 rather than rank 0.
 */
export function knnTable(
  result: NblastKnnResult,
  query: SkeletonsValue,
  targets: SkeletonsValue,
  labels?: { query: string[]; target: string[] },
): TableValue {
  /*
   * The ids come out of each side's attribute table, index-aligned with its geometry, rather
   * than off `SkeletonGeometry.id`. Both name the same neuron; the column is the one the source
   * actually published, so a `queryId` lands in this table as the same *value and dtype* the
   * `neuronId` upstream had — which is what a join, a filter and a sort downstream all rely on.
   */
  const queryIds = getColumn(query.attributes, 'neuronId')
  const targetIds = getColumn(targets.attributes, 'neuronId')
  const rows: Record<string, CellValue>[] = []

  for (let r = 0; r < result.rows; r++) {
    for (let c = 0; c < result.k; c++) {
      const at = r * result.k + c
      const target = result.idx[at]!
      if (target < 0) continue
      rows.push({
        queryId: queryIds[r] ?? null,
        targetId: targetIds[target] ?? null,
        rank: c + 1,
        score: result.scores[at]!,
        ...(labels
          ? { queryLabel: labels.query[r] ?? null, targetLabel: labels.target[target] ?? null }
          : {}),
      })
    }
  }
  return tableFromRows(knnSchema(labels !== undefined, idTypeOf(query.attributes.schema)), rows)
}
