/**
 * The two tables Find Merges publishes, each as the schema/value pair invariant 3 asks for.
 *
 * `affinityTables.ts`' argument, for the other task — and the agreement matters for the same
 * reason: both schemas fold over an upstream one, so a column written under a name the schema
 * half spelled differently does not throw, it simply never reaches a picker.
 *
 * **One summary, published twice.** The per-neuron numbers are folded into the `Meshes` output's
 * attributes *as well as* being rows of the window table's parent, because `Split Neurons` and
 * `Filter Table` read an attribute table: "keep the neurons with a window above 0.9" works with
 * nothing new only if the finding is a column there.
 *
 * **A score is a probability, and the logit comes with it.** A reader cuts on a probability —
 * it is the number a calibration curve will eventually be drawn in — but the logit is what the
 * model emitted and what a future calibration is fitted to, so dropping it would mean
 * re-deriving it through a sigmoid nobody can invert exactly at the tails.
 */

import { ID_COLUMN_NAME } from '../../core/ids'
import type { TableSchema } from '../../core/types'
import { column, tableSchema } from '../../core/types'
import type { CellValue, ColumnData, TableValue } from '../../core/values'
import { makeTable } from '../../core/values'
import { foldColumns } from '../../nodes/lib/tableOps'

/** The window table's columns. */
const SCORE_COLUMN = 'score'
const LOGIT_COLUMN = 'logit'
const CELL_COLUMN = 'cell'
const POINTS_COLUMN = 'points'
const BALANCE_COLUMN = 'balance'
const X_COLUMN = 'x'
const Y_COLUMN = 'y'
const Z_COLUMN = 'z'

/** The per-neuron columns folded onto the meshes. */
const CELLS_COLUMN = 'cells'
const MAX_SCORE_COLUMN = 'maxScore'
const MEAN_SCORE_COLUMN = 'meanScore'

/** The drawn cloud's own column; it shares `cell` and `score` with the window table. */
const FRAGMENT_COLUMN = 'fragment'

const SUMMARY_COLUMNS = [
  column(CELLS_COLUMN, 'i64'),
  column(MAX_SCORE_COLUMN, 'f64'),
  column(MEAN_SCORE_COLUMN, 'f64'),
]

/** One scored window, as the node assembles it. */
export interface ScoredWindow {
  readonly neuronId: string
  /** Which grid cell — its index within that neuron's tiling, so a row traces back. */
  readonly cell: number
  readonly centreNm: readonly [number, number, number]
  readonly score: number
  readonly logit: number
  /** How many of this cell's own points were drawn — the denominator `balance` is a share of. */
  readonly points: number
  /**
   * The share of those points on the *smaller* side of the per-point bipartition, so 0 means the
   * head put everything on one side and 0.5 means it cut the cell in half.
   *
   * Reported as the minority share rather than as "the share labelled b" because the two labels
   * are not distinguishable: `piece_loss` is `torch.minimum(l0, l1)`, so which side the model
   * calls 0 is arbitrary per window and a column of "share of b" would be half noise by
   * construction. The minority share is the part of that answer that survives the symmetry.
   */
  readonly balance: number
}

/** What one neuron's windows came to. */
export interface NeuronWindows {
  readonly cells: number
  readonly maxScore: number | null
  readonly meanScore: number | null
}

/** Fold one neuron's scored windows into a row's worth of numbers. */
export function summariseWindows(scores: readonly number[]): NeuronWindows {
  if (scores.length === 0) return { cells: 0, maxScore: null, meanScore: null }
  let max = -Infinity
  let total = 0
  for (const score of scores) {
    if (score > max) max = score
    total += score
  }
  return { cells: scores.length, maxScore: max, meanScore: total / scores.length }
}

/** The window table's schema half. One row per window, never folded over anything. */
export function windowTableSchema(): TableSchema {
  return tableSchema(
    column(ID_COLUMN_NAME, 'str'),
    column(CELL_COLUMN, 'i64'),
    column(SCORE_COLUMN, 'f64'),
    column(LOGIT_COLUMN, 'f64'),
    column(POINTS_COLUMN, 'i64'),
    column(BALANCE_COLUMN, 'f64'),
    column(X_COLUMN, 'f64', 'nm'),
    column(Y_COLUMN, 'f64', 'nm'),
    column(Z_COLUMN, 'f64', 'nm'),
  )
}

/** The window table's value half. */
export function windowTable(rows: readonly ScoredWindow[]): TableValue {
  const schema = windowTableSchema()
  const data: Record<string, CellValue[]> = {
    [ID_COLUMN_NAME]: [],
    [CELL_COLUMN]: [],
    [SCORE_COLUMN]: [],
    [LOGIT_COLUMN]: [],
    [POINTS_COLUMN]: [],
    [BALANCE_COLUMN]: [],
    [X_COLUMN]: [],
    [Y_COLUMN]: [],
    [Z_COLUMN]: [],
  }
  for (const row of rows) {
    data[ID_COLUMN_NAME]!.push(row.neuronId)
    data[CELL_COLUMN]!.push(row.cell)
    data[SCORE_COLUMN]!.push(row.score)
    data[LOGIT_COLUMN]!.push(row.logit)
    data[POINTS_COLUMN]!.push(row.points)
    data[BALANCE_COLUMN]!.push(row.balance)
    data[X_COLUMN]!.push(row.centreNm[0])
    data[Y_COLUMN]!.push(row.centreNm[1])
    data[Z_COLUMN]!.push(row.centreNm[2])
  }
  return makeTable(schema, data)
}

/** The per-neuron summary's schema half: the neurons' own columns with the three folded in. */
export function neuronSummarySchema(schema: TableSchema | undefined): TableSchema {
  return foldColumns(schema ?? tableSchema(), SUMMARY_COLUMNS)
}

/**
 * The per-neuron summary's value half.
 *
 * `summaries` is index-aligned with the attribute rows, `undefined` where a neuron was skipped —
 * which reads as null in every column rather than as zero windows, because a mesh nobody asked
 * the model about has not been found to hold no merge.
 */
export function neuronSummaryTable(
  attributes: TableValue,
  summaries: readonly (NeuronWindows | undefined)[],
): TableValue {
  const schema = neuronSummarySchema(attributes.schema)
  const data: Record<string, ColumnData> = { ...attributes.data }
  // `Array.from`, never `summaries.map`: a caller that built its array with `new Array(n)` hands
  // us a sparse one and `map` preserves holes, so a skipped neuron's cells would read
  // `undefined` rather than the null promised above, at the right length and with nothing thrown.
  const cells = (read: (summary: NeuronWindows) => CellValue): ColumnData =>
    Array.from({ length: summaries.length }, (_, i) => {
      const summary = summaries[i]
      return summary ? read(summary) : null
    })
  data[CELLS_COLUMN] = cells((s) => s.cells)
  data[MAX_SCORE_COLUMN] = cells((s) => s.maxScore)
  data[MEAN_SCORE_COLUMN] = cells((s) => s.meanScore)
  return makeTable(schema, data, attributes.kind)
}

/**
 * The drawn cloud's schema half.
 *
 * **`fragment` is a label, not a measurement**, and it is deliberately `str`: the numbers behind
 * it are a cell index and a piece, and a reader doing arithmetic on them would be adding grid
 * coordinates together. It is also only comparable *within a cell* — see `fragmentName`.
 */
export function drawnPointsSchema(): TableSchema {
  return tableSchema(
    column(ID_COLUMN_NAME, 'str'),
    column(CELL_COLUMN, 'i64'),
    column(SCORE_COLUMN, 'f64'),
    column(FRAGMENT_COLUMN, 'str'),
  )
}

/**
 * What a fragment is called: its cell, and which piece of that cell.
 *
 * **Two fragments in different cells are not comparable, and this name says so by carrying the
 * cell.** The model's per-point head is trained with a permutation-invariant loss
 * (`torch.minimum(l0, l1)` in SEAM's `piece_loss`), so which piece it calls 0 and which 1 is
 * arbitrary *per window*: `3a` and `4a` have nothing to do with each other. Resolving that into
 * labels that mean something across a whole neuron is a separate problem and is not solved here.
 *
 * A cell whose points all landed on one side has one name in the output and no `b` — which is
 * the model saying it found nothing to cut there, in the same shape as every other answer.
 */
export function fragmentName(cell: number, piece: number): string {
  return `${cell}${piece === 0 ? 'a' : 'b'}`
}

/**
 * The share of a cell's points on the smaller side of its bipartition.
 *
 * 0 for a cell the head did not cut at all, and 0.5 for one it halved. Shared by the node and the
 * card so the number in the table and the number on the histogram cannot drift apart.
 */
export function minorityShare(positives: number, total: number): number {
  if (total <= 0) return 0
  const share = positives / total
  return Math.min(share, 1 - share)
}

/** One window's drawn points, ready to be concatenated. */
export interface DrawnWindow {
  readonly neuronId: string
  /** Which grid cell — the window's index in its neuron's tiling. */
  readonly cell: number
  readonly score: number
  /** One name per drawn point, from `fragmentName`. */
  readonly fragments: readonly string[]
}

/** The drawn cloud's value half. */
export function drawnPointsTable(windows: readonly DrawnWindow[]): TableValue {
  const schema = drawnPointsSchema()
  const ids: CellValue[] = []
  const cells: CellValue[] = []
  const score: CellValue[] = []
  const fragment: CellValue[] = []
  for (const window of windows) {
    for (const name of window.fragments) {
      ids.push(window.neuronId)
      cells.push(window.cell)
      score.push(window.score)
      fragment.push(name)
    }
  }
  return makeTable(schema, {
    [ID_COLUMN_NAME]: ids,
    [CELL_COLUMN]: cells,
    [SCORE_COLUMN]: score,
    [FRAGMENT_COLUMN]: fragment,
  })
}
