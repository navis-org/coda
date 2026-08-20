/**
 * Table/matrix operations shared by the table nodes.
 *
 * Every operation comes in two halves that live side by side on purpose:
 *
 *   fooSchema(...)  — schema in, schema out. Runs at edit time, no data.
 *   fooTable(...)   — values in, values out. Runs at execution time.
 *
 * They must agree: if `groupBySchema` says the output has `sum_weight` as f64 and
 * `groupByTable` emits `total`, column pickers downstream break in ways that only show
 * up after a run. Keeping the pair adjacent makes drift obvious in review, and
 * `tableOps.test.ts` asserts the agreement for each op.
 */

import type { ColumnSchema, DType, TableSchema } from '../../core/types'
import { column, findColumn, isNumericDType, pickColumns, tableSchema } from '../../core/types'
import type { CellValue, ColumnData, MatrixValue, TableValue } from '../../core/values'
import { getColumn, makeMatrix, makeTable, selectRows } from '../../core/values'

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

export type FilterOp =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'ge'
  | 'lt'
  | 'le'
  | 'contains'
  | 'notContains'
  | 'matches'
  | 'startsWith'
  | 'endsWith'
  | 'isEmpty'
  | 'notEmpty'
  | 'isTrue'
  | 'isFalse'

const NUMERIC_OPS: Array<{ value: FilterOp; label: string }> = [
  { value: 'eq', label: '=' },
  { value: 'ne', label: '≠' },
  { value: 'gt', label: '>' },
  { value: 'ge', label: '≥' },
  { value: 'lt', label: '<' },
  { value: 'le', label: '≤' },
]

const STRING_OPS: Array<{ value: FilterOp; label: string }> = [
  { value: 'eq', label: 'is' },
  { value: 'ne', label: 'is not' },
  { value: 'contains', label: 'contains' },
  { value: 'notContains', label: 'does not contain' },
  { value: 'matches', label: 'matches regex' },
  { value: 'startsWith', label: 'starts with' },
  { value: 'endsWith', label: 'ends with' },
  { value: 'isEmpty', label: 'is empty' },
  { value: 'notEmpty', label: 'is not empty' },
]

const BOOL_OPS: Array<{ value: FilterOp; label: string }> = [
  { value: 'isTrue', label: 'is true' },
  { value: 'isFalse', label: 'is false' },
]

/** Ops that make sense for a column's dtype — drives the operator dropdown. */
export function opsForDType(
  dtype: DType | undefined,
): Array<{ value: FilterOp; label: string }> {
  if (!dtype) return STRING_OPS
  if (isNumericDType(dtype)) return NUMERIC_OPS
  if (dtype === 'bool') return BOOL_OPS
  return STRING_OPS
}

/** Ops that ignore the comparison value, so the UI can hide the value field. */
export function opNeedsValue(op: FilterOp): boolean {
  return !['isEmpty', 'notEmpty', 'isTrue', 'isFalse'].includes(op)
}

/** Filtering never changes the schema. */
export function filterSchema(schema: TableSchema | undefined): TableSchema | undefined {
  return schema
}

/**
 * Keep the rows matching one condition.
 *
 * Note that this does **not** agree with the Table viewer's header filters, which borrow
 * Explore's grammar instead: text compares here are case-*sensitive*, and `Number(null)` is 0
 * so a null matches `== 0`. Neither is wrong on its own and the divergence is recorded in
 * `tableFilter.ts`; the point is that a graph can hold both an inch apart.
 */
export function filterTable(
  table: TableValue,
  columnName: string,
  op: FilterOp,
  rawValue: string,
): TableValue {
  const col = findColumn(table.schema, columnName)
  if (!col) throw new Error(`Filter column "${columnName}" not found`)
  const data = getColumn(table, columnName)
  const predicate = makePredicate(col.dtype, op, rawValue)

  const keep: number[] = []
  for (let i = 0; i < table.length; i++) {
    if (predicate(data[i] ?? null)) keep.push(i)
  }
  return selectRows(table, keep)
}

function makePredicate(
  dtype: DType,
  op: FilterOp,
  rawValue: string,
): (cell: CellValue) => boolean {
  if (op === 'isTrue') return (c) => c === true || c === 1
  if (op === 'isFalse') return (c) => c === false || c === 0
  if (op === 'isEmpty') return (c) => c === null || c === ''
  if (op === 'notEmpty') return (c) => c !== null && c !== ''

  if (isNumericDType(dtype)) {
    const target = Number(rawValue)
    if (!Number.isFinite(target)) {
      throw new Error(`"${rawValue}" is not a number`)
    }
    switch (op) {
      case 'eq':
        return (c) => Number(c) === target
      case 'ne':
        return (c) => Number(c) !== target
      case 'gt':
        return (c) => c !== null && Number(c) > target
      case 'ge':
        return (c) => c !== null && Number(c) >= target
      case 'lt':
        return (c) => c !== null && Number(c) < target
      case 'le':
        return (c) => c !== null && Number(c) <= target
      default:
        throw new Error(`Operator "${op}" does not apply to numeric columns`)
    }
  }

  const needle = rawValue
  switch (op) {
    case 'eq':
      return (c) => String(c ?? '') === needle
    case 'ne':
      return (c) => String(c ?? '') !== needle
    case 'contains':
      return (c) => String(c ?? '').includes(needle)
    case 'notContains':
      return (c) => !String(c ?? '').includes(needle)
    case 'startsWith':
      return (c) => String(c ?? '').startsWith(needle)
    case 'endsWith':
      return (c) => String(c ?? '').endsWith(needle)
    case 'matches': {
      let re: RegExp
      try {
        re = new RegExp(needle)
      } catch (err) {
        throw new Error(`Invalid regex /${needle}/: ${(err as Error).message}`)
      }
      return (c) => re.test(String(c ?? ''))
    }
    default:
      throw new Error(`Operator "${op}" does not apply to text columns`)
  }
}

// ---------------------------------------------------------------------------
// Sort / limit
// ---------------------------------------------------------------------------

export function sortSchema(schema: TableSchema | undefined): TableSchema | undefined {
  return schema
}

/**
 * Row order after sorting, without materialising a new table.
 *
 * Split out from `sortTable` so the table *viewer* can sort a view cheaply (it only needs
 * an index order) while sharing this comparator — null placement and numeric-vs-locale
 * collation must not differ between what the Sort node does and what a column-header click
 * does, or the same data would order two different ways in one session.
 */
export function sortedRowIndices(
  table: TableValue,
  columnName: string,
  descending: boolean,
): number[] {
  const col = findColumn(table.schema, columnName)
  if (!col) throw new Error(`Sort column "${columnName}" not found`)
  const data = getColumn(table, columnName)
  const numeric = isNumericDType(col.dtype)

  const indices = Array.from({ length: table.length }, (_, i) => i)
  indices.sort((a, b) => {
    const av = data[a] ?? null
    const bv = data[b] ?? null
    // Nulls always sort last, regardless of direction — they're absence, not extremes.
    if (av === null && bv === null) return a - b
    if (av === null) return 1
    if (bv === null) return -1
    const cmp = numeric
      ? Number(av) - Number(bv)
      : String(av).localeCompare(String(bv), undefined, { numeric: true })
    if (cmp !== 0) return descending ? -cmp : cmp
    return a - b // stable
  })
  return indices
}

export function sortTable(
  table: TableValue,
  columnName: string,
  descending: boolean,
  limit = 0,
): TableValue {
  const indices = sortedRowIndices(table, columnName, descending)
  return selectRows(table, limit > 0 ? indices.slice(0, limit) : indices)
}

// ---------------------------------------------------------------------------
// Sample
// ---------------------------------------------------------------------------

export type SampleMode = 'head' | 'tail' | 'stride' | 'random'

export const SAMPLE_OPTIONS: Array<{ value: SampleMode; label: string }> = [
  { value: 'head', label: 'Top N' },
  { value: 'tail', label: 'Bottom N' },
  { value: 'stride', label: 'Every Nth' },
  { value: 'random', label: 'Random' },
]

export interface SampleSpec {
  mode: SampleMode
  /** Rows to keep. Read by every mode but `stride`. */
  count: number
  /** Keep one row in `step`, starting with the first. `stride` only. */
  step: number
  /** Seeds the draw. `random` only. */
  seed: number
}

/** Sampling takes rows away and never touches the columns. */
export function sampleSchema(schema: TableSchema | undefined): TableSchema | undefined {
  return schema
}

/**
 * Seeded PRNG for the random draw.
 *
 * Deliberately a second copy of `mulberry32` rather than an import from `data/mock/generate`,
 * which is the one other place this algorithm appears. The two are not the same concern: the
 * mock's stream exists to give a synthetic connectome recognisable structure and may be
 * retuned the day that structure needs to change, whereas this one is **provenance** — it is
 * pinned by a seed the user chose, saved in their graph, and a change to it would silently
 * resample every workflow that ever used this node. Nothing needs the two streams to agree,
 * and sharing one function is what would let the mock's concerns reach this one.
 */
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

/** A param arriving as NaN — an emptied number field — must not become NaN rows. */
function wholeNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.floor(value) : fallback
}

/**
 * `count` rows drawn without replacement, **in the input's own order**.
 *
 * Partial Fisher-Yates: `count` swaps rather than a full shuffle, unbiased at every draw, and
 * the cost is in the size of the sample rather than the size of the table. The result is then
 * sorted, because this node samples and does not shuffle — a random *subset* of a sorted table
 * is still sorted, which is what makes it comparable to the three deterministic modes beside
 * it and readable next to the table it came from. Shuffling is a different question and would
 * be a different node.
 */
function randomRowIndices(length: number, count: number, seed: number): number[] {
  const indices = Array.from({ length }, (_, i) => i)
  const rand = seededRandom(seed)
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(rand() * (length - i))
    const held = indices[i]!
    indices[i] = indices[j]!
    indices[j] = held
  }
  return indices.slice(0, count).sort((a, b) => a - b)
}

/**
 * Which rows a sample keeps, as ascending indices.
 *
 * Split out from `sampleTable` for the same reason `sortedRowIndices` is: the interesting
 * behaviour — the stride, the draw, and its determinism under a seed — is about row positions
 * and is sharpest to test without a table wrapped round it.
 */
export function sampleRowIndices(length: number, spec: SampleSpec): number[] {
  const rows = Math.max(0, wholeNumber(length, 0))

  if (spec.mode === 'stride') {
    const step = Math.max(1, wholeNumber(spec.step, 1))
    const out: number[] = []
    for (let i = 0; i < rows; i += step) out.push(i)
    return out
  }

  // A sample larger than the table is every row, not an error: the count is a ceiling.
  const count = Math.min(rows, Math.max(0, wholeNumber(spec.count, 0)))
  if (spec.mode === 'tail') return Array.from({ length: count }, (_, i) => rows - count + i)
  if (spec.mode === 'random') return randomRowIndices(rows, count, spec.seed)
  return Array.from({ length: count }, (_, i) => i)
}

export function sampleTable(table: TableValue, spec: SampleSpec): TableValue {
  const indices = sampleRowIndices(table.length, spec)
  // Every index list here is strictly ascending, so a full-length one is the identity.
  if (indices.length === table.length) return table
  return selectRows(table, indices)
}

// ---------------------------------------------------------------------------
// Uploaded table shaping
// ---------------------------------------------------------------------------

/**
 * The name a neuron table has to use.
 *
 * Nodes address columns by name — `out.profile` validates on it, `idColumn()` above defaults
 * to it, Connectivity and Skeletons read it — so an uploaded file whose author called the
 * column `root_id` cannot meet neuron data until it is renamed. That rename is the whole
 * reason the upload node's ID column picker exists rather than merely tagging the type.
 */
const ID_COLUMN_NAME = 'bodyId'

/**
 * Whether a shaped upload carries a body id, and may therefore call itself Neurons.
 *
 * One predicate rather than the same condition written twice, because the schema half and the
 * value half must agree about the *kind* as strictly as they agree about the columns: a table
 * typed `neurons` whose values arrive as a plain table breaks every downstream node's bodyId
 * guarantee only after a run.
 */
export function uploadIsNeurons(schema: TableSchema | undefined, idColumn: string): boolean {
  return Boolean(idColumn) && Boolean(findColumn(schema, idColumn))
}

/** Rename the chosen id column, evicting a different column already holding the name. */
function renamedColumns(names: readonly string[], idColumn: string): string[] {
  if (!idColumn || !names.includes(idColumn)) return [...names]
  const taken = new Set(names.filter((n) => n !== idColumn))
  return names.map((name) => {
    if (name === idColumn) return ID_COLUMN_NAME
    // The chosen column wins the name; a column that merely already had it is suffixed, the
    // same call `joinedColumns` and the wide pivot make about a collision.
    if (name !== ID_COLUMN_NAME) return name
    let n = 2
    while (taken.has(`${ID_COLUMN_NAME}_${n}`)) n++
    return `${ID_COLUMN_NAME}_${n}`
  })
}

/**
 * What an upload's stored table looks like once the node's two controls are applied.
 *
 * Both are lossless by construction, which is what lets them be applied *after* parsing rather
 * than during it — so changing either costs no re-parse and cannot disagree with the rows the
 * uploads store already holds.
 *
 *  - `textColumns` widens a column to `str`. Widening only, and never the reverse: reading
 *    text as a number is where data is lost, and the parser's round-trip rule has already kept
 *    anything ambiguous as text. This is for a column that is genuinely numeric and genuinely
 *    not a *quantity* — a cluster label, a layer index — which has no business offering itself
 *    to a size encoding or being averaged.
 *  - `idColumn` renames one column to `bodyId`. See `ID_COLUMN_NAME`.
 */
export function uploadShapeSchema(
  schema: TableSchema | undefined,
  idColumn: string,
  textColumns: readonly string[],
): TableSchema | undefined {
  if (!schema) return undefined
  const text = new Set(textColumns)
  const names = renamedColumns(
    schema.columns.map((c) => c.name),
    idColumn,
  )
  return {
    columns: schema.columns.map((c, i) =>
      // The unit goes with the dtype: a count of synapses read as text is no longer a count.
      text.has(c.name) ? column(names[i]!, 'str') : { ...c, name: names[i]! },
    ),
  }
}

export function uploadShapeTable(
  table: TableValue,
  idColumn: string,
  textColumns: readonly string[],
): TableValue {
  const schema = uploadShapeSchema(table.schema, idColumn, textColumns)!
  const text = new Set(textColumns)
  const data: Record<string, ColumnData> = {}
  for (let i = 0; i < table.schema.columns.length; i++) {
    const from = table.schema.columns[i]!.name
    const to = schema.columns[i]!.name
    const source = getColumn(table, from)
    // Null is absence and stays absence: `String(null)` is the four-letter word "null", which
    // would read as a value everywhere downstream.
    data[to] = text.has(from)
      ? source.map((cell) => (cell === null ? null : String(cell)))
      : source
  }
  return makeTable(schema, data, uploadIsNeurons(table.schema, idColumn) ? 'neurons' : 'table')
}

// ---------------------------------------------------------------------------
// Select columns
// ---------------------------------------------------------------------------

/** Nothing chosen means everything — the Select node's own rule, not `pickColumns`'. */
export function selectSchema(
  schema: TableSchema | undefined,
  names: string[],
): TableSchema | undefined {
  const picked = pickColumns(schema, names)
  return picked?.columns.length ? picked : schema
}

export function selectTable(table: TableValue, names: string[]): TableValue {
  const wanted = names.filter((n) => findColumn(table.schema, n))
  if (wanted.length === 0) return table
  const schema = { columns: wanted.map((n) => findColumn(table.schema, n)!) }
  const data: Record<string, ColumnData> = {}
  for (const n of wanted) data[n] = getColumn(table, n)
  return makeTable(
    schema,
    data,
    table.kind === 'neurons' && wanted.includes('bodyId') ? 'neurons' : 'table',
  )
}

// ---------------------------------------------------------------------------
// Stack (vertical concatenation)
// ---------------------------------------------------------------------------

export interface StackOptions {
  /** Column naming which input each row came from. Empty adds none. */
  sourceColumn?: string
  topLabel?: string
  bottomLabel?: string
}

/** A column both tables have, under two dtypes that cannot be reconciled. */
export interface DTypeConflict {
  name: string
  top: DType
  bottom: DType
}

/**
 * The dtype a column has after stacking, or undefined when the two cannot be reconciled.
 *
 * `i64` and `f64` widen to `f64` without comment: those are the same kind of thing, and a count
 * stacked onto a ratio is still a number. Everything else is a genuine disagreement about what
 * the column *is* — `bodyId` as a number in one table and text in the other is two different
 * columns wearing one name, and merging them either way would be a decision this node has no
 * grounds to make.
 */
function mergedDType(top: DType, bottom: DType): DType | undefined {
  if (top === bottom) return top
  if (isNumericDType(top) && isNumericDType(bottom)) return 'f64'
  return undefined
}

/**
 * The stacked column set: the top table's columns in order, then whatever the bottom adds.
 *
 * Conflicts are **returned rather than thrown**, because both halves need them and neither may
 * throw: `inferOutputs` must never throw (invariant 2) and `validate` reports strings. Only
 * `stackTables` refuses, and it refuses on exactly this list.
 */
export function stackColumns(
  top: TableSchema,
  bottom: TableSchema,
  options: StackOptions = {},
): { columns: ColumnSchema[]; conflicts: DTypeConflict[] } {
  const conflicts: DTypeConflict[] = []
  const columns: ColumnSchema[] = []

  for (const col of top.columns) {
    const other = findColumn(bottom, col.name)
    if (!other) {
      columns.push(col)
      continue
    }
    const dtype = mergedDType(col.dtype, other.dtype)
    if (!dtype) {
      conflicts.push({ name: col.name, top: col.dtype, bottom: other.dtype })
      // Keep the top's reading so the rest of the schema stays useful to look at. Nothing is
      // ever built from it — `stackTables` refuses on the same list.
      columns.push(col)
      continue
    }
    // The unit rides along only while both agree on it: nanometres stacked onto voxels is a
    // column with no single unit, and carrying one of them would label the other's rows wrongly.
    columns.push(
      col.unit && col.unit === other.unit
        ? column(col.name, dtype, col.unit)
        : column(col.name, dtype),
    )
  }

  for (const col of bottom.columns) {
    if (!findColumn(top, col.name)) columns.push(col)
  }

  const source = options.sourceColumn?.trim()
  // Appended last rather than first: it is this node's annotation, not part of either table, and
  // pushing every real column one place right on every stack reads as the data having moved.
  if (source) columns.push(column(source, 'str'))

  return { columns, conflicts }
}

/**
 * Schema in, schema out. Undefined when either side is unknown.
 *
 * Not "the half that is known": the result's column *set* depends on both, so publishing the
 * top's schema alone would advertise a table missing every column the bottom contributes, and a
 * picker downstream would be configured against a shape that never arrives.
 */
export function stackSchema(
  top: TableSchema | undefined,
  bottom: TableSchema | undefined,
  options: StackOptions = {},
): TableSchema | undefined {
  if (!top || !bottom) return undefined
  return { columns: stackColumns(top, bottom, options).columns }
}

/**
 * Two tables end to end, keeping every column either of them has.
 *
 * A column only one side carries is filled with **null** for the other's rows, which is what
 * null already means everywhere here: not recorded. That is the same call `Join` makes when it
 * suffixes a colliding name rather than dropping it — quietly losing a column in a scientific
 * pipeline is worse than an untidy result.
 *
 * Rows keep input order and duplicates are kept: this is `UNION ALL`, not `UNION`. Removing
 * repeats is a separate question with its own answer (which row wins?) and belongs in a node
 * that asks it.
 */
export function stackTables(
  top: TableValue,
  bottom: TableValue,
  options: StackOptions = {},
): TableValue {
  const source = options.sourceColumn?.trim()
  if (source && (findColumn(top.schema, source) || findColumn(bottom.schema, source))) {
    throw new Error(
      `Source column "${source}" already exists in one of the inputs. Pick a name neither ` +
        `table uses, or clear the field.`,
    )
  }

  const { columns, conflicts } = stackColumns(top.schema, bottom.schema, options)
  if (conflicts.length > 0) {
    const named = conflicts
      .map((c) => `"${c.name}" is ${c.top} above and ${c.bottom} below`)
      .join('; ')
    throw new Error(
      `Cannot stack: ${named}. One column cannot hold both — convert it upstream, or drop it ` +
        `with a Select.`,
    )
  }

  const total = top.length + bottom.length
  const data: Record<string, ColumnData> = {}
  for (const col of columns) {
    if (col.name === source) continue
    // Allocated once at full length rather than concatenated: two 165k-row neuron tables is
    // 330k cells per column, and `[...a, ...b]` builds both spreads before joining them.
    const out: ColumnData = new Array(total).fill(null)
    const fromTop = top.data[col.name]
    if (fromTop) for (let i = 0; i < top.length; i++) out[i] = fromTop[i] ?? null
    const fromBottom = bottom.data[col.name]
    if (fromBottom)
      for (let i = 0; i < bottom.length; i++) out[top.length + i] = fromBottom[i] ?? null
    data[col.name] = out
  }

  if (source) {
    const labels: ColumnData = new Array(total)
    labels.fill(options.topLabel ?? 'Top', 0, top.length)
    labels.fill(options.bottomLabel ?? 'Bottom', top.length, total)
    data[source] = labels
  }

  /*
   * Neurons only when *both* inputs are. A neuron table stacked onto a plain one that happens to
   * carry a `bodyId` is not a neuron table: the plain one never claimed its ids were neurons of
   * this dataset, and a `neurons` kind is exactly that claim.
   */
  const kind = top.kind === 'neurons' && bottom.kind === 'neurons' ? 'neurons' : 'table'
  return makeTable({ columns }, data, kind)
}

// ---------------------------------------------------------------------------
// Group by + aggregate
// ---------------------------------------------------------------------------

export type AggFn = 'sum' | 'mean' | 'min' | 'max' | 'count' | 'countDistinct'

export const AGG_OPTIONS: Array<{ value: AggFn; label: string }> = [
  { value: 'sum', label: 'sum' },
  { value: 'mean', label: 'mean' },
  { value: 'min', label: 'min' },
  { value: 'max', label: 'max' },
  { value: 'count', label: 'count rows' },
  { value: 'countDistinct', label: 'count distinct' },
]

/** Name of the column an aggregation produces. Kept in one place so both halves agree. */
export function aggColumnName(agg: AggFn, valueColumn: string | undefined): string {
  if (agg === 'count') return 'n'
  if (!valueColumn) return agg
  return `${agg}_${valueColumn}`
}

function aggDType(agg: AggFn, source: DType | undefined): DType {
  if (agg === 'count' || agg === 'countDistinct') return 'i64'
  if (agg === 'mean') return 'f64'
  return source && isNumericDType(source) ? source : 'f64'
}

export function groupBySchema(
  schema: TableSchema | undefined,
  by: string[],
  valueColumn: string | undefined,
  agg: AggFn,
): TableSchema | undefined {
  if (!schema) return undefined
  const keyColumns = by
    .map((n) => schema.columns.find((c) => c.name === n))
    .filter((c): c is ColumnSchema => !!c)
  const out: ColumnSchema[] = [...keyColumns, column('n', 'i64')]
  if (agg !== 'count') {
    const src = valueColumn ? findColumn(schema, valueColumn) : undefined
    const unit = src?.unit
    out.push(
      unit
        ? column(aggColumnName(agg, valueColumn), aggDType(agg, src?.dtype), unit)
        : column(aggColumnName(agg, valueColumn), aggDType(agg, src?.dtype)),
    )
  }
  return { columns: out }
}

export function groupByTable(
  table: TableValue,
  by: string[],
  valueColumn: string | undefined,
  agg: AggFn,
): TableValue {
  const keyColumns = by.filter((n) => findColumn(table.schema, n))
  if (keyColumns.length === 0) {
    throw new Error('Group by needs at least one existing key column')
  }
  if (agg !== 'count' && !valueColumn) {
    throw new Error(`Aggregation "${agg}" needs a value column`)
  }

  const keyData = keyColumns.map((n) => getColumn(table, n))
  const valueData = agg === 'count' || !valueColumn ? undefined : getColumn(table, valueColumn)

  interface Bucket {
    keys: CellValue[]
    n: number
    sum: number
    min: number
    max: number
    distinct?: Set<string>
  }
  const buckets = new Map<string, Bucket>()

  for (let i = 0; i < table.length; i++) {
    /*
     * Concatenated in place rather than through two `map`s and a `join`. This is the one loop
     * here that runs over a whole neuron index — 165k rows on male-CNS — where the old form
     * allocated two arrays and a string per row; and `keys` was only ever read when a *new*
     * bucket appeared, so it is materialised in that branch instead of for every row.
     */
    let hash = ''
    for (let k = 0; k < keyData.length; k++) {
      const cell = keyData[k]![i]
      if (k > 0) hash += '\u0001'
      hash += cell === null || cell === undefined ? '\u0000' : String(cell)
    }
    let bucket = buckets.get(hash)
    if (!bucket) {
      bucket = {
        keys: keyData.map((col) => col[i] ?? null),
        n: 0,
        sum: 0,
        min: Number.POSITIVE_INFINITY,
        max: Number.NEGATIVE_INFINITY,
        ...(agg === 'countDistinct' ? { distinct: new Set<string>() } : {}),
      }
      buckets.set(hash, bucket)
    }
    bucket.n += 1
    if (valueData) {
      const raw = valueData[i]
      if (agg === 'countDistinct') {
        bucket.distinct!.add(raw === null || raw === undefined ? '\u0000' : String(raw))
      } else if (raw !== null && raw !== undefined) {
        const v = Number(raw)
        if (Number.isFinite(v)) {
          bucket.sum += v
          if (v < bucket.min) bucket.min = v
          if (v > bucket.max) bucket.max = v
        }
      }
    }
  }

  const schema = groupBySchema(table.schema, keyColumns, valueColumn, agg)!
  const data: Record<string, ColumnData> = {}
  for (const col of schema.columns) data[col.name] = []

  const outName = aggColumnName(agg, valueColumn)
  /** Loop-invariant: one lookup, not one per output row. */
  const outDtype = schema.columns.find((c) => c.name === outName)?.dtype
  for (const bucket of buckets.values()) {
    keyColumns.forEach((name, idx) => {
      data[name]!.push(bucket.keys[idx] ?? null)
    })
    data['n']!.push(bucket.n)
    if (agg !== 'count') {
      let value: number
      switch (agg) {
        case 'sum':
          value = bucket.sum
          break
        case 'mean':
          value = bucket.n > 0 ? bucket.sum / bucket.n : 0
          break
        case 'min':
          value = Number.isFinite(bucket.min) ? bucket.min : 0
          break
        case 'max':
          value = Number.isFinite(bucket.max) ? bucket.max : 0
          break
        case 'countDistinct':
          value = bucket.distinct?.size ?? 0
          break
        default:
          value = 0
      }
      data[outName]!.push(outDtype === 'i64' ? Math.round(value) : value)
    }
  }

  return makeTable(schema, data)
}

// ---------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------

export type JoinHow = 'inner' | 'left'

/** Right-side columns get a suffix when they collide with a left-side name. */
function joinedColumns(
  left: TableSchema,
  right: TableSchema,
  rightKey: string,
  suffix: string,
): { columns: ColumnSchema[]; rightNames: Array<{ source: string; out: string }> } {
  const columns: ColumnSchema[] = [...left.columns]
  const taken = new Set(left.columns.map((c) => c.name))
  const rightNames: Array<{ source: string; out: string }> = []
  for (const col of right.columns) {
    if (col.name === rightKey) continue // key is redundant with the left key
    const out = taken.has(col.name) ? `${col.name}${suffix}` : col.name
    taken.add(out)
    columns.push({ ...col, name: out })
    rightNames.push({ source: col.name, out })
  }
  return { columns, rightNames }
}

export function joinSchema(
  left: TableSchema | undefined,
  right: TableSchema | undefined,
  rightKey: string | undefined,
  suffix: string,
): TableSchema | undefined {
  if (!left || !right) return undefined
  return { columns: joinedColumns(left, right, rightKey ?? '', suffix).columns }
}

export function joinTables(
  left: TableValue,
  right: TableValue,
  leftKey: string,
  rightKey: string,
  how: JoinHow,
  suffix = '_r',
): TableValue {
  if (!findColumn(left.schema, leftKey)) throw new Error(`Left key "${leftKey}" not found`)
  if (!findColumn(right.schema, rightKey)) throw new Error(`Right key "${rightKey}" not found`)

  const { columns, rightNames } = joinedColumns(left.schema, right.schema, rightKey, suffix)
  const schema: TableSchema = { columns }

  // Index the right side by key. First match wins for duplicate keys — a many-to-many
  // join would silently multiply rows, which is rarely what you want when you're
  // annotating a table.
  const rightKeyData = getColumn(right, rightKey)
  const index = new Map<string, number>()
  for (let i = 0; i < right.length; i++) {
    const k = String(rightKeyData[i] ?? '\u0000')
    if (!index.has(k)) index.set(k, i)
  }

  const leftKeyData = getColumn(left, leftKey)
  const leftRows: number[] = []
  const rightRows: Array<number | null> = []
  for (let i = 0; i < left.length; i++) {
    const match = index.get(String(leftKeyData[i] ?? '\u0000'))
    if (match === undefined) {
      if (how === 'left') {
        leftRows.push(i)
        rightRows.push(null)
      }
      continue
    }
    leftRows.push(i)
    rightRows.push(match)
  }

  const data: Record<string, ColumnData> = {}
  for (const col of left.schema.columns) {
    const src = getColumn(left, col.name)
    data[col.name] = leftRows.map((i) => src[i] ?? null)
  }
  for (const { source, out } of rightNames) {
    const src = getColumn(right, source)
    data[out] = rightRows.map((i) => (i === null ? null : (src[i] ?? null)))
  }

  return makeTable(schema, data, left.kind)
}

// ---------------------------------------------------------------------------
// Pivot (table -> matrix, and the same pivot as a wide table)
// ---------------------------------------------------------------------------

/**
 * How many distinct values the Columns field may have, and how many cells the result may be.
 *
 * A pivot's Columns field is by construction the *small* axis — every distinct value becomes a
 * column of the wide table and a column of the heatmap — so a high-cardinality field there is
 * always a mistake rather than an ambitious query, and it is a mistake that costs quadratic
 * memory before anything is drawn.
 *
 * Two ceilings because they catch different mistakes. A 2 × 1,000,000 pivot is only two
 * million cells and still produces a million-column table that `matrixToTable` would build as
 * a million JS arrays.
 *
 * The numbers are what a browser can hold, not a preference, which is why they are constants
 * rather than params — the same standing as `MAX_NEURONS` and the network viewer's node cap.
 * At the cell ceiling the result is 16 MB of Float64, plus the wide table beside it.
 */
export const MAX_PIVOT_COLUMNS = 2_000
export const MAX_PIVOT_CELLS = 2_000_000

/**
 * Long table -> labelled matrix.
 *
 * **It refuses before it allocates, and that is a backstop rather than the fix.** What
 * actually built a 15,000-square matrix on male-CNS — 225 million cells, ~9 GB, inside one
 * `evaluate` and then cached — was `resolveColumn` substituting the first column for a
 * `somaSide` that discovery had not published yet, landing on the column Rows had already
 * taken. That is fixed at the source: a chosen column is now kept, so the two fields cannot
 * collide by accident. This ceiling stays because the *shape* is what costs the memory, and
 * a node whose output size is the product of two independently-resolved columns should not
 * depend on both resolutions being sensible to stay inside a browser.
 *
 * The accumulators are also allocated per aggregation rather than all at once. `sum` needs one
 * array, not five: `min`/`max`/`countDistinct` each cost the whole matrix again, and were being
 * paid for by every pivot that never mentioned them.
 */
export function pivotTable(
  table: TableValue,
  indexColumn: string,
  columnsColumn: string,
  valueColumn: string | undefined,
  agg: AggFn,
): MatrixValue {
  if (!findColumn(table.schema, indexColumn))
    throw new Error(`Row column "${indexColumn}" not found`)
  if (!findColumn(table.schema, columnsColumn)) {
    throw new Error(`Column column "${columnsColumn}" not found`)
  }
  if (agg !== 'count' && !valueColumn)
    throw new Error(`Aggregation "${agg}" needs a value column`)

  const rowData = getColumn(table, indexColumn)
  const colData = getColumn(table, columnsColumn)
  const valData = agg === 'count' || !valueColumn ? undefined : getColumn(table, valueColumn)

  const rowLabels = uniqueLabels(rowData)
  const colLabels = uniqueLabels(colData)
  const size = rowLabels.length * colLabels.length

  if (colLabels.length > MAX_PIVOT_COLUMNS) {
    throw new Error(
      `"${columnsColumn}" has ${colLabels.length.toLocaleString()} distinct values, so this ` +
        `pivot would be that many columns wide (limit ${MAX_PIVOT_COLUMNS.toLocaleString()}). ` +
        'Columns should be the small field — a side, a status, an ROI. Group or filter first.',
    )
  }
  if (size > MAX_PIVOT_CELLS) {
    throw new Error(
      `${rowLabels.length.toLocaleString()} rows × ${colLabels.length.toLocaleString()} ` +
        `columns is ${size.toLocaleString()} cells, over the ` +
        `${MAX_PIVOT_CELLS.toLocaleString()} a pivot will build. Narrow "${indexColumn}" or ` +
        `"${columnsColumn}" upstream.`,
    )
  }

  const rowIndex = new Map(rowLabels.map((l, i) => [l, i]))
  const colIndex = new Map(colLabels.map((l, i) => [l, i]))

  // One array per thing this aggregation actually accumulates into. `values` doubles as the
  // accumulator for everything except `mean`, which is the only aggregation needing two.
  const values = new Float64Array(size)
  if (agg === 'min') values.fill(Number.POSITIVE_INFINITY)
  if (agg === 'max') values.fill(Number.NEGATIVE_INFINITY)
  const counts = agg === 'mean' ? new Float64Array(size) : undefined
  const distinct =
    agg === 'countDistinct' ? new Array<Set<string> | undefined>(size) : undefined

  for (let i = 0; i < table.length; i++) {
    const r = rowIndex.get(labelOf(rowData[i]))
    const c = colIndex.get(labelOf(colData[i]))
    if (r === undefined || c === undefined) continue
    const at = r * colLabels.length + c

    if (agg === 'count') {
      values[at]! += 1
      continue
    }
    if (!valData) continue
    const raw = valData[i]
    if (distinct) {
      distinct[at] ??= new Set<string>()
      distinct[at]!.add(labelOf(raw))
      continue
    }
    if (raw === null || raw === undefined) continue
    const v = Number(raw)
    if (!Number.isFinite(v)) continue
    switch (agg) {
      case 'sum':
        values[at]! += v
        break
      case 'mean':
        values[at]! += v
        counts![at]! += 1
        break
      case 'min':
        if (v < values[at]!) values[at] = v
        break
      case 'max':
        if (v > values[at]!) values[at] = v
        break
    }
  }

  // An empty cell reads as 0 rather than as a sentinel, exactly as it did before: the pair
  // simply was not in the data, and `matrixToTable` agrees with this on the wide side.
  if (agg === 'mean') {
    for (let i = 0; i < size; i++) values[i] = counts![i]! > 0 ? values[i]! / counts![i]! : 0
  } else if (agg === 'min' || agg === 'max') {
    for (let i = 0; i < size; i++) if (!Number.isFinite(values[i]!)) values[i] = 0
  } else if (distinct) {
    for (let i = 0; i < size; i++) values[i] = distinct[i]?.size ?? 0
  }

  const unit = valueColumn ? findColumn(table.schema, valueColumn)?.unit : undefined
  return makeMatrix(rowLabels, colLabels, values, unit ?? aggColumnName(agg, valueColumn))
}

/**
 * A matrix as an ordinary wide table: the row labels in `labelColumn`, then one numeric
 * column per column label, in the matrix's own order.
 *
 * Reshaped from the *matrix* rather than pivoted a second time from the table, which is what
 * makes the two forms of one pivot unable to disagree — same aggregation, same labels, same
 * ordering, one pass over the data.
 *
 * Two things follow from a matrix axis being labels rather than data. `labelColumn` is `str`
 * even when it was pivoted from `bodyId` — harmless downstream, since `joinTables` keys on
 * `String(cell)` and so still joins it back against the numeric column it came from. And a
 * missing pair reads as 0 here exactly as it does in the matrix, rather than as null: the
 * absent cell is what `pivotTable` already decided, and disagreeing about it in the table half
 * is the drift this function exists to prevent.
 *
 * No unit is carried, deliberately. `MatrixValue.valueLabel` conflates a real unit
 * ("synapses") with a fallback aggregate name ("sum_weight"), and the two are not
 * distinguishable here — an honest blank beats "sum_weight" sitting in a unit slot.
 */
export function matrixToTable(matrix: MatrixValue, labelColumn: string): TableValue {
  const taken = new Set<string>([labelColumn])
  const columns: ColumnSchema[] = [column(labelColumn, 'str')]
  const data: Record<string, ColumnData> = { [labelColumn]: [...matrix.rowLabels] }

  const width = matrix.colLabels.length
  matrix.colLabels.forEach((label, c) => {
    const name = uniqueName(taken, label)
    // f64 is what the cells literally are: the values live in a Float64Array, counts
    // included. Nothing here has to re-derive `aggDType`.
    columns.push(column(name, 'f64'))
    const cells: ColumnData = new Array(matrix.rowLabels.length)
    for (let r = 0; r < cells.length; r++) cells[r] = matrix.values[r * width + c] ?? 0
    data[name] = cells
  })

  return makeTable({ columns }, data)
}

/** First free name, so a column label colliding with the row field keeps both columns. */
function uniqueName(taken: Set<string>, name: string): string {
  let out = name
  for (let n = 2; taken.has(out); n++) out = `${name}_${n}`
  taken.add(out)
  return out
}

function labelOf(cell: CellValue | undefined): string {
  return cell === null || cell === undefined ? '—' : String(cell)
}

function uniqueLabels(data: ColumnData): string[] {
  const seen = new Set<string>()
  const labels: string[] = []
  for (const cell of data) {
    const label = labelOf(cell)
    if (seen.has(label)) continue
    seen.add(label)
    labels.push(label)
  }
  return labels.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

// ---------------------------------------------------------------------------
// Matrix normalisation
// ---------------------------------------------------------------------------

export type NormalizeMode = 'none' | 'row' | 'column' | 'max' | 'log'

export const NORMALIZE_OPTIONS: Array<{ value: NormalizeMode; label: string }> = [
  { value: 'none', label: 'raw values' },
  { value: 'row', label: 'fraction of row total' },
  { value: 'column', label: 'fraction of column total' },
  { value: 'max', label: 'fraction of global max' },
  { value: 'log', label: 'log10(1 + x)' },
]

export function normalizeMatrix(matrix: MatrixValue, mode: NormalizeMode): MatrixValue {
  // Note what is deliberately not carried: `measure`. A fraction of a row is no longer the
  // quantity that went in — a normalised count is a proportion, not a count — so the honest
  // answer downstream is "nobody said" rather than the old claim restated about new numbers.
  if (mode === 'none') return matrix
  const rows = matrix.rowLabels.length
  const cols = matrix.colLabels.length
  const out = new Float64Array(matrix.values.length)

  if (mode === 'row') {
    for (let r = 0; r < rows; r++) {
      let total = 0
      for (let c = 0; c < cols; c++) total += matrix.values[r * cols + c] ?? 0
      for (let c = 0; c < cols; c++) {
        out[r * cols + c] = total > 0 ? (matrix.values[r * cols + c] ?? 0) / total : 0
      }
    }
    return makeMatrix(matrix.rowLabels, matrix.colLabels, out, 'fraction of row')
  }
  if (mode === 'column') {
    for (let c = 0; c < cols; c++) {
      let total = 0
      for (let r = 0; r < rows; r++) total += matrix.values[r * cols + c] ?? 0
      for (let r = 0; r < rows; r++) {
        out[r * cols + c] = total > 0 ? (matrix.values[r * cols + c] ?? 0) / total : 0
      }
    }
    return makeMatrix(matrix.rowLabels, matrix.colLabels, out, 'fraction of column')
  }
  if (mode === 'max') {
    let max = 0
    for (const v of matrix.values) if (v > max) max = v
    for (let i = 0; i < out.length; i++) out[i] = max > 0 ? (matrix.values[i] ?? 0) / max : 0
    return makeMatrix(matrix.rowLabels, matrix.colLabels, out, 'fraction of max')
  }
  for (let i = 0; i < out.length; i++) out[i] = Math.log10(1 + (matrix.values[i] ?? 0))
  return makeMatrix(matrix.rowLabels, matrix.colLabels, out, 'log10(1 + synapses)')
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Pull a numeric id column out as a plain array — the bridge into DataSource calls. */
export function idColumn(table: TableValue, columnName = 'bodyId'): number[] {
  const data = getColumn(table, columnName)
  const out: number[] = []
  for (const cell of data) {
    if (cell === null || cell === undefined) continue
    const n = Number(cell)
    if (Number.isFinite(n)) out.push(n)
  }
  return out
}

/** Schema for a single-column table of ids, used by stub/passthrough paths. */
export const ID_ONLY_SCHEMA: TableSchema = tableSchema(column('bodyId', 'i64'))

/**
 * Rows whose id column appears in a selection.
 *
 * Compared as strings because an `ids` param is a string array — it has to be, since that is
 * what survives a round trip through the saved file — while `bodyId` is `i64`. That rule was
 * written out three times, in Explore, Profile and the 3D viewer, each with its own copy of
 * the column-by-column materialisation `selectRows` already does.
 *
 * `kind` is taken rather than assumed: two of the three callers force `'neurons'` because
 * that is what their port advertises, and `selectRows` alone would preserve the input's.
 */
export function rowsWithIds(
  table: TableValue,
  selection: unknown,
  kind: TableValue['kind'] = 'neurons',
  columnName = 'bodyId',
): TableValue {
  const wanted = new Set((Array.isArray(selection) ? selection : []).map(String))
  const rows: number[] = []
  if (wanted.size > 0) {
    const ids = table.data[columnName] ?? []
    for (let row = 0; row < table.length; row++) {
      const id = ids[row]
      if (id !== null && id !== undefined && wanted.has(String(id))) rows.push(row)
    }
  }
  const picked = selectRows(table, rows)
  return picked.kind === kind ? picked : makeTable(picked.schema, picked.data, kind)
}
