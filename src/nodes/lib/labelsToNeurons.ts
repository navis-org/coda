/**
 * A table of labels in, the neurons those labels name out.
 *
 * **One operation behind two nodes.** `Selected to Neurons` and `Clusters to Neurons` differ in
 * what they are called, what their input socket says, and what their guide points at — not in
 * what they do. Both take a table whose rows are named by a label column, find the neurons
 * those labels name, and carry every other column of the labels table along. Written once here
 * so the two cannot come to disagree about matching, about which columns survive, or about what
 * happens when a label names nothing.
 *
 * The reason they exist at all is a type mismatch with a real cause behind it. A `LinkageValue`
 * knows its leaves only by *label*, because that is all a `MatrixValue` axis carries — so a
 * Dendrogram's `Selected` and a Cut Tree's `Clusters` are plain tables of names, and a
 * Neuroglancer or a 3D view wants `T.neurons()`, a table with a `neuronId`. Something has to
 * cross that gap, and it needs the neuron table to do it whenever the labels are not ids.
 */

import type { TableSchema } from '../../core/types'
import type { CellValue, ColumnData, TableValue } from '../../core/values'
import { getColumn, makeTable, selectRows } from '../../core/values'
import { ID_ONLY_SCHEMA, joinTables, joinedColumns } from './tableOps'

/** Appended to a label column whose name the neuron table already uses. */
export const DEFAULT_LABEL_SUFFIX = '_c'

export interface LabelMatchRequest {
  labels: TableValue
  /** Which column of `labels` holds the name. */
  labelColumn: string
  /** The neurons to match against. Absent means the labels are neuron ids themselves. */
  neurons?: TableValue | undefined
  /** Which column of `neurons` a label is compared with. */
  matchColumn?: string | undefined
  suffix?: string
}

export interface LabelMatchResult {
  neurons: TableValue
  /** How many distinct labels were asked for. */
  asked: number
  /** How many of them named at least one neuron. */
  matched: number
  /**
   * Label rows dropped for not being usable neuron ids. Only ever non-zero on the unwired path,
   * where a label has to *be* an id — which is what a cell type is not.
   */
  dropped: number
}

/**
 * What the result looks like, without running it.
 *
 * Both halves of invariant 3: `inferOutputs` and `evaluate` build their columns from this same
 * function, so a picker downstream cannot be offered a column the run will not produce.
 *
 * The label column itself is **dropped**, exactly as `joinTables` drops its right key: it holds
 * the same value the match column already does, under a second name. On the unwired path it is
 * not so much dropped as *converted* — it becomes the `neuronId` the whole node exists to produce.
 */
export function labelsToNeuronsSchema(
  labels: TableSchema | undefined,
  labelColumn: string | undefined,
  neurons: TableSchema | undefined,
  suffix: string = DEFAULT_LABEL_SUFFIX,
): TableSchema | undefined {
  if (!labels) return undefined
  const key = labelColumn ?? ''
  // Unwired: the labels are ids, so the node builds the one column a neuron table must have
  // and carries the rest. Anything else the dataset knows is not available without a query,
  // which this node deliberately does not make.
  const left = neurons ?? ID_ONLY_SCHEMA
  return { columns: joinedColumns(left, labels, key, suffix).columns }
}

/**
 * The neurons a set of labels names.
 *
 * **Matched by text, like every other key comparison here.** `joinTables` keys on
 * `String(cell)`, and it has to: a pivot's label column is `str` even when pivoted from an
 * `i64`, and an NBLAST labelled by neuron id produces the *string* "722817260" against an `i64`
 * column. Comparing by value would fail on exactly the default case.
 *
 * **The neuron table drives the row order and the row count.** One label naming six neurons
 * gives six rows — which is the point when the labels are cell types — and a label naming none
 * gives none. That is an inner join with the neurons on the left, and it is what makes "show me
 * this cluster" return the neurons that were clustered rather than a list of names.
 */
/**
 * How much of a label set found anything, without building the answer.
 *
 * The card under both nodes needs three integers and nothing else, and running the whole
 * operation for them means a full inner join — every column of a neuron table that can be
 * 165,000 rows — materialised on a render path and thrown away. This is the counting half on
 * its own: the same map build, then one scan of the match column.
 *
 * Split out rather than reimplemented, so the number under the card and the rows leaving the
 * port cannot disagree about what "matched" means.
 */
export function labelCoverage(request: LabelMatchRequest): Omit<LabelMatchResult, 'neurons'> {
  const { labels, labelColumn, neurons, matchColumn } = request
  const rowForLabel = labelIndex(labels, labelColumn)

  if (!neurons || !matchColumn) {
    // No neuron table: a label counts when it is a usable id, which is the same test `fromIds`
    // applies before it keeps a row.
    const labelData = getColumn(labels, labelColumn)
    let matched = 0
    for (const row of rowForLabel.values()) {
      if (usableId(labelData[row]) === undefined) continue
      matched++
    }
    return { asked: rowForLabel.size, matched, dropped: rowForLabel.size - matched }
  }

  const hit = new Set<string>()
  for (const cell of getColumn(neurons, matchColumn)) {
    const key = labelText(cell)
    if (key !== undefined && rowForLabel.has(key)) hit.add(key)
  }
  return { asked: rowForLabel.size, matched: hit.size, dropped: 0 }
}

/**
 * Each label to the first row that carries it.
 *
 * First occurrence wins, as `joinTables` does for a duplicate key: two identical labels are one
 * label, and a many-to-many match would multiply rows silently.
 */
function labelIndex(labels: TableValue, labelColumn: string): Map<string, number> {
  const data = getColumn(labels, labelColumn)
  const rowForLabel = new Map<string, number>()
  for (let i = 0; i < labels.length; i++) {
    const key = labelText(data[i])
    if (key !== undefined && !rowForLabel.has(key)) rowForLabel.set(key, i)
  }
  return rowForLabel
}

/**
 * A cell as a neuron id, or undefined where it cannot be one.
 *
 * The rule `idsFromColumn` applies: an id past the safe range is stored as a *different*
 * integer and would identify a different neuron, so it is not usable rather than merely large.
 */
function usableId(cell: CellValue | undefined): number | undefined {
  const value = Number(cell)
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function labelsToNeurons(request: LabelMatchRequest): LabelMatchResult {
  const { labels, labelColumn, neurons, matchColumn } = request
  const suffix = request.suffix ?? DEFAULT_LABEL_SUFFIX
  const rowForLabel = labelIndex(labels, labelColumn)

  return neurons && matchColumn
    ? matchAgainst(neurons, matchColumn, labels, labelColumn, rowForLabel, suffix)
    : fromIds(labels, labelColumn, rowForLabel, suffix)
}

/** A label as it is compared. Null and empty are not labels — they name nothing. */
function labelText(cell: CellValue | undefined): string | undefined {
  if (cell === null || cell === undefined || cell === '') return undefined
  return String(cell)
}

/**
 * Neuron rows whose match column names a label, each carrying that label's other columns.
 *
 * **This is `joinTables` with the neurons on the left**, and it says so by calling it rather
 * than by resembling it: the key index, first-match-wins, the row scan and the column assembly
 * are all that function's, so the suffix rule here cannot drift from the Join node's.
 *
 * The one thing done first is dropping blank labels. `joinTables` keys a null through a
 * sentinel so a null matches a null, which is right when joining two tables and wrong here —
 * a neuron with no `type` is not a member of a cluster nobody named. Filtering the labels is
 * enough to prevent it, since the join indexes that side.
 */
function matchAgainst(
  neurons: TableValue,
  matchColumn: string,
  labels: TableValue,
  labelColumn: string,
  rowForLabel: Map<string, number>,
  suffix: string,
): LabelMatchResult {
  const named = selectRows(labels, [...rowForLabel.values()])
  const joined = joinTables(neurons, named, {
    leftKey: matchColumn,
    rightKey: labelColumn,
    how: 'inner',
    suffix,
  })

  // Which labels found anything, counted off the result rather than during the join — the
  // same "derive it from what came back" rule `unmatchedLabels` follows.
  const hit = new Set<string>()
  for (const cell of getColumn(joined, matchColumn)) {
    const key = labelText(cell)
    if (key !== undefined) hit.add(key)
  }

  return {
    // `joinTables` carries the left's kind through, and the left is the neuron table — but the
    // port declares `T.neurons()`, and a value whose kind disagrees with its port is a
    // disagreement nothing type-checks. Stated rather than inherited.
    neurons:
      joined.kind === 'neurons' ? joined : makeTable(joined.schema, joined.data, 'neurons'),
    asked: rowForLabel.size,
    matched: hit.size,
    dropped: 0,
  }
}

/**
 * Labels read as neuron ids, for the case where that is what they are.
 *
 * The default NBLAST labels a matrix with neuron ids, so a Dendrogram hanging off one needs no
 * neuron table at all — which is worth the branch, because it is the arrangement somebody has
 * before they have thought about any of this.
 *
 * **A row that is not a usable id is dropped and counted, never refused.** This is data arriving
 * from a viewer rather than text somebody typed, so the asymmetry `idsFromColumn` records
 * applies: refusing to run because one label is a cell type would make the node unusable in
 * exactly the case the count is there to explain.
 */
function fromIds(
  labels: TableValue,
  labelColumn: string,
  rowForLabel: Map<string, number>,
  suffix: string,
): LabelMatchResult {
  const labelData = getColumn(labels, labelColumn)
  const { columns, rightNames } = joinedColumns(
    ID_ONLY_SCHEMA,
    labels.schema,
    labelColumn,
    suffix,
  )

  const ids: CellValue[] = []
  const rows: number[] = []
  let dropped = 0
  for (const row of rowForLabel.values()) {
    const value = usableId(labelData[row])
    if (value === undefined) {
      dropped++
      continue
    }
    ids.push(value)
    rows.push(row)
  }

  const data: Record<string, ColumnData> = { neuronId: ids }
  for (const { source, out } of rightNames) {
    const src = getColumn(labels, source)
    data[out] = rows.map((i) => src[i] ?? null)
  }

  return {
    neurons: makeTable({ columns }, data, 'neurons'),
    asked: rowForLabel.size,
    matched: ids.length,
    dropped,
  }
}
