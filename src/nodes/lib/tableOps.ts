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

import type { Warner } from '../../core/limits'
import { formatBytes, refuseIfOverCrashFloor, warnOverThreshold } from '../../core/limits'
import type { ColumnSchema, DType, TableSchema } from '../../core/types'
import {
  column,
  columnNames,
  findColumn,
  isNumericDType,
  pickColumns,
  tableSchema,
  uniqueName,
} from '../../core/types'
import type { CellValue, ColumnData, MatrixValue, TableValue } from '../../core/values'
import { JOIN_SEPARATOR, getColumn, makeMatrix, makeTable, selectRows } from '../../core/values'
import { ID_COLUMN_NAME, idText } from '../../core/ids'
import { TYPE_COLUMN_NAME } from '../../data/annotations/types'
import type { Rename } from './renames'

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
// Row identity, shared
// ---------------------------------------------------------------------------

/**
 * A string identifying one row by the given columns, for grouping or matching.
 *
 * Built in place rather than through a `map` and a `join`: this runs over whole neuron indexes —
 * 165k rows on male-CNS — where that form allocates an array and a string per row.
 *
 * Two characters carry the rules and both matter. `\u0001` separates the columns, so `["ab","c"]`
 * and `["a","bc"]` are different rows — the collision `uploads.ts` records for its own content
 * address. `\u0000` stands for a *missing* value, so a null is not the four-letter string "null",
 * which a `str` column of somebody's annotation base very plausibly contains. Written as escapes
 * rather than as literal control characters, for `uploads.ts`' reason: a raw one is invisible to
 * every reader and to `grep`.
 *
 * Compared as text, the `joinTables` rule — within one table a column has one dtype, so the only
 * case that could bite is the null one above.
 */
export function rowKey(columns: ReadonlyArray<ColumnData>, row: number): string {
  let key = ''
  for (let k = 0; k < columns.length; k++) {
    const cell = columns[k]![row]
    if (k > 0) key += '\u0001'
    key += cell === null || cell === undefined ? '\u0000' : String(cell)
  }
  return key
}

// ---------------------------------------------------------------------------
// Deduplicate
// ---------------------------------------------------------------------------

/** Which row of a duplicate set survives. `pandas.drop_duplicates`' `keep`. */
export type KeepMode = 'first' | 'last' | 'none'

export const KEEP_OPTIONS: Array<{ value: KeepMode; label: string }> = [
  { value: 'first', label: 'first' },
  { value: 'last', label: 'last' },
  { value: 'none', label: 'none (drop them all)' },
]

/** Deduplicating never changes the schema. */
export function dedupeSchema(schema: TableSchema | undefined): TableSchema | undefined {
  return schema
}

/**
 * Drop rows that repeat, comparing on the named columns.
 *
 * **Empty means every column**, which is `pandas.drop_duplicates()`'s own default and `Select`'s
 * reading of an empty picker: an unconfigured node compares whole rows, which is the answer to
 * "this table has exact duplicates in it" and needs nothing set.
 *
 * **`none` drops every row of a repeated set, not one of them.** That is `keep=False`, and it
 * answers a different question from the other two: `first`/`last` are "one row per neuron", where
 * `none` is "only the neurons nobody disagrees about" — which on an annotation base is the
 * conservative read, since a root id carrying two different `side` values is a conflict rather
 * than a copy.
 *
 * **Row order is the input's**, whichever mode. A row kept because it was *last* stays where it
 * was rather than moving to the end; pandas does the same, and a dedupe that also reordered would
 * be two operations wearing one name.
 */
export function dedupeTable(
  table: TableValue,
  columns: readonly string[],
  keep: KeepMode,
): TableValue {
  /*
   * A named-but-absent column is refused rather than ignored, `groupByTable`'s rule: comparing on
   * fewer columns than were asked for silently keeps *more* rows, and on a table whose upstream
   * schema moved that reads as a dedupe that did not work.
   */
  const named = columns.filter((n) => findColumn(table.schema, n))
  if (columns.length > 0 && named.length === 0) {
    throw new Error(
      `Deduplicate: none of the chosen columns are in this table (${columns.join(', ')})`,
    )
  }
  const names = named.length > 0 ? named : table.schema.columns.map((c) => c.name)
  const keyData = names.map((n) => getColumn(table, n))

  // Built once. All three modes need every row's key, and two of them need a second pass over
  // it, so recomputing would double the only expensive part of this.
  const keys: string[] = new Array(table.length)
  for (let i = 0; i < table.length; i++) keys[i] = rowKey(keyData, i)

  const kept: number[] = []
  if (keep === 'first') {
    const seen = new Set<string>()
    for (let i = 0; i < keys.length; i++) {
      if (seen.has(keys[i]!)) continue
      seen.add(keys[i]!)
      kept.push(i)
    }
  } else if (keep === 'last') {
    const lastAt = new Map<string, number>()
    for (let i = 0; i < keys.length; i++) lastAt.set(keys[i]!, i)
    // Walked forward again rather than reading the Map's values, whose order is
    // *first*-occurrence — which would emit the kept rows in the wrong places.
    for (let i = 0; i < keys.length; i++) if (lastAt.get(keys[i]!) === i) kept.push(i)
  } else {
    const counts = new Map<string, number>()
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1)
    for (let i = 0; i < keys.length; i++) if (counts.get(keys[i]!) === 1) kept.push(i)
  }
  return selectRows(table, kept)
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
 * Whether a shaped upload carries a neuron id, and may therefore call itself Neurons.
 *
 * One predicate rather than the same condition written twice, because the schema half and the
 * value half must agree about the *kind* as strictly as they agree about the columns: a table
 * typed `neurons` whose values arrive as a plain table breaks every downstream node's neuronId
 * guarantee only after a run.
 */
export function uploadIsNeurons(schema: TableSchema | undefined, idColumn: string): boolean {
  return Boolean(idColumn) && Boolean(findColumn(schema, idColumn))
}

/**
 * Which of a set of renames actually applies, keyed by the column it renames.
 *
 * Pairs rather than one id column, because there are names Coda addresses a table by —
 * `neuronId` and `type` — and they are applied in one pass so a column cannot be both the
 * source of one rename and the collision victim of the other. The first pair naming a source
 * wins, so the same column picked twice is the id rather than half of each.
 *
 * A pair whose source is not in the table, or which names nothing to rename *to*, is **dropped
 * here** — which is what makes the map the honest answer to "what will this do". Both the kind
 * rule and the node's warnings read it, and a stale pair naming a column an upstream edit
 * removed must not count as an applied rename in either.
 */
export function resolveRenames(
  names: readonly string[],
  renames: readonly Rename[],
): Map<string, string> {
  const from = new Map<string, string>()
  for (const { from: source, to } of renames) {
    if (source && to && names.includes(source) && !from.has(source)) from.set(source, to)
  }
  return from
}

/**
 * Apply a set of renames, suffixing any column that merely already held a target name.
 *
 * Two passes, and the order is the whole of it: every renamed column claims its name first, so
 * a column that only *happens* to hold that name is the one that gets suffixed rather than the
 * one somebody chose. That is `joinedColumns`' call about a collision and the wide pivot's.
 *
 * Allocating through a single `uniqueName` set is what makes it safe for a rename set somebody
 * is typing, where the import nodes' two-rename case could not reach it: **the mapping is not
 * injective**, so `a → x` beside `b → x` is a real state, and taking each target literally
 * would emit two columns called `x` — a table whose `data` has one array where its schema
 * claims two, which is `makeTable`'s "ragged columns" throw at best and a silently overwritten
 * column at worst. It is the same non-injectivity the annotation providers were caught by, and
 * `annotationColumns` is that fix one layer down.
 */
function renamedColumns(names: readonly string[], from: ReadonlyMap<string, string>): string[] {
  if (from.size === 0) return [...names]

  const out = new Array<string>(names.length)
  const taken = new Set<string>()
  names.forEach((name, i) => {
    const target = from.get(name)
    if (target !== undefined) out[i] = uniqueName(taken, target)
  })
  names.forEach((name, i) => {
    if (out[i] === undefined) out[i] = uniqueName(taken, name)
  })
  return out
}

/** The renamed schema, keeping each column's dtype and unit — only the name changes. */
function renameColumns(
  schema: TableSchema,
  names: readonly string[],
  from: ReadonlyMap<string, string>,
): TableSchema {
  const renamed = renamedColumns(names, from)
  return { columns: schema.columns.map((c, i) => ({ ...c, name: renamed[i]! })) }
}

/**
 * The two import nodes' controls, as one argument.
 *
 * An object rather than three positional arguments, because two of them are column names and
 * a caller that swapped them would type-check, run, and rename the wrong column.
 */
export interface UploadShape {
  /** Renamed to `neuronId`. Empty renames nothing. */
  idColumn?: string
  /** Renamed to `type`. Empty renames nothing. */
  typeColumn?: string
  /** Widened to `str`. */
  textColumns?: readonly string[]
}

function renamesOf(shape: UploadShape): Rename[] {
  return [
    { from: shape.idColumn ?? '', to: ID_COLUMN_NAME },
    { from: shape.typeColumn ?? '', to: TYPE_COLUMN_NAME },
  ]
}

/**
 * What an import's table looks like once the node's controls are applied.
 *
 * All three are lossless by construction, which is what lets them be applied *after* parsing
 * rather than during it — so changing any of them costs no re-parse and cannot disagree with
 * the rows the uploads store already holds.
 *
 *  - `textColumns` widens a column to `str`. Widening only, and never the reverse: reading
 *    text as a number is where data is lost, and the parser's round-trip rule has already kept
 *    anything ambiguous as text. This is for a column that is genuinely numeric and genuinely
 *    not a *quantity* — a cluster label, a layer index — which has no business offering itself
 *    to a size encoding or being averaged.
 *  - `idColumn` renames one column to `neuronId`. See `ID_COLUMN_NAME`.
 *  - `typeColumn` renames one column to `type`. See `TYPE_COLUMN_NAME`, and note that the two
 *    are a pair rather than a symmetry: an id makes the table *Neurons*, where a type makes it
 *    legible — `typesOf` reads `type` by literal name, so a chain publishing `cell_type` leaves
 *    every connectivity row's type null with the schema still declaring it.
 */
export function uploadShapeSchema(
  schema: TableSchema | undefined,
  shape: UploadShape,
): TableSchema | undefined {
  if (!schema) return undefined
  const text = new Set(shape.textColumns ?? [])
  const names = schema.columns.map((c) => c.name)
  const renamed = renamedColumns(names, resolveRenames(names, renamesOf(shape)))
  return {
    columns: schema.columns.map((c, i) =>
      // The unit goes with the dtype: a count of synapses read as text is no longer a count.
      text.has(c.name) ? column(renamed[i]!, 'str') : { ...c, name: renamed[i]! },
    ),
  }
}

export function uploadShapeTable(table: TableValue, shape: UploadShape): TableValue {
  const schema = uploadShapeSchema(table.schema, shape)!
  const text = new Set(shape.textColumns ?? [])
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
  return makeTable(
    schema,
    data,
    uploadIsNeurons(table.schema, shape.idColumn ?? '') ? 'neurons' : 'table',
  )
}

// ---------------------------------------------------------------------------
// Rename columns
// ---------------------------------------------------------------------------

/**
 * Everything a set of renames does to a table, worked out once.
 *
 * Four things read this — the schema half, the value half, the node's `validate` and its card —
 * and each of them wants a different pair of the fields. Computed separately they were the same
 * walk two and three times over per keystroke, and worse, the card and the badge answered
 * "which columns are missing" from two expressions that could drift apart. `resolveFilters`
 * one node over has the same shape and the same reason.
 */
export interface RenamePlan {
  /** The finished columns. Undefined only when the input schema is. */
  schema: TableSchema | undefined
  /** The renames that actually apply, source → target, in the order they were declared. */
  applied: ReadonlyMap<string, string>
  /** Sources this table does not carry. Empty while the schema is unknown — see below. */
  missing: string[]
  /** Whether the result claims to be Neurons. */
  neurons: boolean
}

/** Whether any applied rename targets this name. */
function renamesOnto(applied: ReadonlyMap<string, string>, name: string): boolean {
  for (const to of applied.values()) if (to === name) return true
  return false
}

export function renamePlan(
  schema: TableSchema | undefined,
  renames: readonly Rename[],
  wasNeurons = false,
): RenamePlan {
  const names = schema?.columns.map((c) => c.name) ?? []
  const applied = resolveRenames(names, renames)
  const renamed = schema ? renameColumns(schema, names, applied) : undefined
  /*
   * Nothing is missing while the schema is unknown, rather than everything: a port publishing
   * no schema is not a port whose table lacks these columns — a Pivot publishes none until it
   * has run. `columnSchemaFor`'s rule, and reporting it here is what lets both readers state it
   * without each remembering to guard.
   */
  const missing = schema
    ? renames.filter((r) => r.from && !names.includes(r.from)).map((r) => r.from)
    : []
  return {
    schema: renamed,
    applied,
    missing,
    /*
     * Both directions, and each is a different statement. Renaming `neuronId` **away** has to
     * demote: the column is gone, so `idColumn()` throws on every node downstream that believed
     * the kind. Renaming a column **onto** `neuronId` promotes, which is what makes this the
     * general form of Upload Table's `ID column` — the fix for somebody else's table, usable
     * mid-chain on one that was fetched or joined rather than only at the point of import.
     *
     * What it will not do is promote a table it did not touch. `core.stack` states the rule
     * this respects: a `neurons` kind is a *claim* that the ids are neurons of a dataset, and a
     * plain table that happens to carry a `neuronId` never made it. So the promotion reads
     * `applied`, a pair whose source is not in the table having renamed nothing at all.
     */
    neurons:
      Boolean(findColumn(renamed, ID_COLUMN_NAME)) &&
      (wasNeurons || renamesOnto(applied, ID_COLUMN_NAME)),
  }
}

/** Schema in, schema out — the half `inferOutputs` needs. */
export function renameSchema(
  schema: TableSchema | undefined,
  renames: readonly Rename[],
): TableSchema | undefined {
  return renamePlan(schema, renames).schema
}

/**
 * Every column whose name actually changes, as `[from, to]` — what an emitter writes out.
 *
 * Derived from the finished schema rather than from the pairs, and that is what makes a
 * generated `rename` exact rather than approximate. `renamedColumns` does two things the pairs
 * alone do not say: it suffixes a *second* rename onto one target, and it suffixes a column
 * that merely already **held** a target name — so `root_id → neuronId` on a table that has a
 * `neuronId` already is two renames, one of which nobody typed. Emitting the pairs would put
 * two columns of one name in somebody's DataFrame, which pandas permits and every later
 * `df[col]` then answers with a frame instead of a series.
 *
 * With no schema — a Pivot upstream, or a first run — it falls back to the pairs as typed,
 * which is the same answer whenever nothing collides, and is the honest limit of what can be
 * known at export time.
 */
export function renameMapping(
  schema: TableSchema | undefined,
  renames: readonly Rename[],
): Array<[string, string]> {
  const renamed = renameSchema(schema, renames)
  if (!schema || !renamed) {
    return renames.filter((r) => r.from && r.to).map((r) => [r.from, r.to])
  }
  const out: Array<[string, string]> = []
  schema.columns.forEach((c, i) => {
    const to = renamed.columns[i]!.name
    if (to !== c.name) out.push([c.name, to])
  })
  return out
}

export function renameTable(table: TableValue, renames: readonly Rename[]): TableValue {
  const plan = renamePlan(table.schema, renames, table.kind === 'neurons')
  const schema = plan.schema!
  const data: Record<string, ColumnData> = {}
  // The arrays are handed over by reference rather than copied. Columns are immutable by
  // contract (`core/values.ts`), and this op changes nothing but the key they sit under — so a
  // rename over a 165,000-row index costs one object rather than a second copy of the table.
  table.schema.columns.forEach((c, i) => {
    data[schema.columns[i]!.name] = getColumn(table, c.name)
  })
  return makeTable(schema, data, plan.neurons ? 'neurons' : 'table')
}

// ---------------------------------------------------------------------------
// Combine columns
// ---------------------------------------------------------------------------

export interface CombineSpec {
  /** The columns to draw from, in priority order. The first with a value wins. */
  columns: readonly string[]
  /** Name for the result. */
  into: string
  /** Column naming which input each value came from. Empty adds none. */
  sourceColumn?: string
}

/**
 * A cell that counts as absent.
 *
 * Null and the empty string are one absence, which is the call `datasetStats.ts` already makes
 * and for the same reason: a base publishes both for one thing depending on how it was edited,
 * so a coalesce stopping at the first `''` would answer "no type" for a neuron that has one two
 * columns over. Whitespace is deliberately *not* trimmed — `" "` is odd data rather than absent
 * data, and a trim rule invented here would drop it with nothing saying so.
 */
function absent(cell: CellValue): boolean {
  return cell === null || cell === ''
}

/**
 * The dtype a combined column takes: the shared one, or `str`.
 *
 * Widening rather than refusing, which is the opposite of `stackColumns` and the difference is
 * real. A stack meeting two dtypes under one name has found two different columns wearing it;
 * here the picker *is* somebody saying these columns hold one fact, so the honest merge keeps
 * every value — and `str` keeps all of them, the same trade `textColumns` makes. `i64` with
 * `f64` is the one pair that reconciles without leaving numbers behind.
 */
function combinedDType(schema: TableSchema | undefined, columns: readonly string[]): DType {
  const found = columns
    .map((n) => findColumn(schema, n)?.dtype)
    .filter((d): d is DType => d !== undefined)
  if (found.length === 0) return 'str'
  // `mergedDType` is the one statement of "can these two reconcile" — the same question
  // `stackColumns` asks. What differs is only what each caller does with a *no*: a stack has
  // found two different columns wearing one name and refuses, where this picker is somebody
  // saying these hold one fact, so it widens to the type that keeps every value.
  return found.reduce((a, b) => mergedDType(a, b) ?? 'str')
}

export interface CombineLayout {
  /** One output name per input column, in order. */
  renamed: string[]
  /** Whether the result takes an existing column's place rather than being appended. */
  replaced: boolean
  /** The source column's final name, once a collision has been settled. */
  sourceName?: string
}

/**
 * Where the result sits, and what happens to a column already holding its name.
 *
 * Two clauses. **A result named after one of the picked columns replaces it in place**, which
 * is the backfill case and the common one: `[cell_type, hemibrain_type] → cell_type` should
 * leave a table with exactly the columns it arrived with. Otherwise the result is appended
 * last, and any *other* column already holding the name is suffixed rather than overwritten —
 * `renamedColumns`' rule, and `joinedColumns`' before it.
 */
export function combineLayout(names: readonly string[], spec: CombineSpec): CombineLayout {
  const replaced = spec.columns.includes(spec.into)
  const taken = new Set(names)
  const renamed = replaced
    ? [...names]
    : names.map((name) => (name === spec.into ? uniqueName(taken, name) : name))
  taken.add(spec.into)

  // Appended last, and a collision suffixed, on `stackColumns`' reasoning: it is this node's
  // annotation about the table rather than part of it.
  const sourceName = spec.sourceColumn ? uniqueName(taken, spec.sourceColumn) : undefined
  return { renamed, replaced, sourceName }
}

/**
 * Everything both halves need, derived once.
 *
 * The schema half and the value half were each computing `combinedDType` and `combineLayout`
 * from the same inputs — two derivations of one answer that nothing checked against each other,
 * which is the drift invariant 3 exists to prevent, inside a single op. Undefined where there is
 * nothing to do, which is what makes both entry points a one-line guard.
 */
export interface CombinePlan extends CombineLayout {
  schema: TableSchema
  dtype: DType
}

export function combinePlan(
  schema: TableSchema | undefined,
  spec: CombineSpec,
): CombinePlan | undefined {
  if (!schema || !spec.into || spec.columns.length === 0) return undefined

  const dtype = combinedDType(schema, spec.columns)
  const layout = combineLayout(
    schema.columns.map((c) => c.name),
    spec,
  )
  const columns: ColumnSchema[] = schema.columns.map((c, i) =>
    // The unit does not survive: the values now come from several columns, and one of them
    // carrying nanometres says nothing about the result.
    layout.replaced && c.name === spec.into
      ? column(spec.into, dtype)
      : { ...c, name: layout.renamed[i]! },
  )
  if (!layout.replaced) columns.push(column(spec.into, dtype))
  if (layout.sourceName) columns.push(column(layout.sourceName, 'str'))
  return { ...layout, schema: { columns }, dtype }
}

export function combineSchema(
  schema: TableSchema | undefined,
  spec: CombineSpec,
): TableSchema | undefined {
  return combinePlan(schema, spec)?.schema ?? schema
}

export function combineTable(table: TableValue, spec: CombineSpec): TableValue {
  const plan = combinePlan(table.schema, spec)
  if (!plan) return table

  /*
   * Only the columns the table actually has, and a missing one is skipped rather than refused:
   * this is a coalesce, so a name the schema lost is one fewer place to look rather than a
   * question that can no longer be answered. `groupByTable` refuses the same case because
   * grouping on fewer columns silently keeps *more* rows; here it keeps fewer values, which
   * the result column shows.
   */
  const sources = spec.columns
    .filter((n) => findColumn(table.schema, n))
    .map((n) => ({ name: n, data: getColumn(table, n) }))

  const values: CellValue[] = new Array(table.length).fill(null)
  // Only where one was asked for. Unset is the default, and this is a whole extra column's
  // worth of allocation and one store per row on tables that run to six figures.
  const from: CellValue[] | undefined = plan.sourceName
    ? new Array<CellValue>(table.length).fill(null)
    : undefined
  for (let row = 0; row < table.length; row++) {
    for (const source of sources) {
      const cell = source.data[row] ?? null
      if (absent(cell)) continue
      values[row] = plan.dtype === 'str' && typeof cell !== 'string' ? String(cell) : cell
      if (from) from[row] = source.name
      break
    }
  }

  const data: Record<string, ColumnData> = {}
  table.schema.columns.forEach((c, i) => {
    data[plan.renamed[i]!] = getColumn(table, c.name)
  })
  // After the pass above, so a replaced column takes the result rather than keeping its own.
  data[spec.into] = values
  if (plan.sourceName && from) data[plan.sourceName] = from

  return makeTable(plan.schema, data, table.kind)
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
    table.kind === 'neurons' && wanted.includes('neuronId') ? 'neurons' : 'table',
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
 * the column *is* — `neuronId` as a number in one table and text in the other is two different
 * columns wearing one name, and merging them either way would be a decision this node has no
 * grounds to make.
 */
export function mergedDType(top: DType, bottom: DType): DType | undefined {
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
   * carry a `neuronId` is not a neuron table: the plain one never claimed its ids were neurons of
   * this dataset, and a `neurons` kind is exactly that claim.
   */
  const kind = top.kind === 'neurons' && bottom.kind === 'neurons' ? 'neurons' : 'table'
  return makeTable({ columns }, data, kind)
}

// ---------------------------------------------------------------------------
// Group by + aggregate
// ---------------------------------------------------------------------------

export type AggFn = 'sum' | 'mean' | 'min' | 'max' | 'count' | 'countDistinct' | 'join'

export const AGG_OPTIONS: Array<{ value: AggFn; label: string }> = [
  { value: 'sum', label: 'sum' },
  { value: 'mean', label: 'mean' },
  { value: 'min', label: 'min' },
  { value: 'max', label: 'max' },
  { value: 'count', label: 'count rows' },
  { value: 'countDistinct', label: 'count distinct' },
  { value: 'join', label: 'join text' },
]

/**
 * The aggregations a **matrix** can hold, which is not all of them.
 *
 * A `MatrixValue` cell is a `Float64Array` slot, so `core.pivot` can only offer aggregations
 * whose result is a number. Derived from `aggDType` rather than listed, so a future text
 * aggregation is excluded by arriving rather than by somebody remembering this line — the
 * failure otherwise is a dropdown entry that produces a matrix of zeroes.
 */
export const NUMERIC_AGG_OPTIONS: Array<{ value: AggFn; label: string }> = AGG_OPTIONS.filter(
  (option) => isNumericDType(aggDType(option.value, undefined)),
)

/** Name of the column an aggregation produces. Kept in one place so both halves agree. */
export function aggColumnName(agg: AggFn, valueColumn: string | undefined): string {
  if (agg === 'count') return 'n'
  if (!valueColumn) return agg
  return `${agg}_${valueColumn}`
}

function aggDType(agg: AggFn, source: DType | undefined): DType {
  if (agg === 'count' || agg === 'countDistinct') return 'i64'
  if (agg === 'mean') return 'f64'
  // `join` is the one aggregation whose result is not a number, whatever it was given.
  if (agg === 'join') return 'str'
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
    // A unit belongs to a quantity: `join` produces text, so nanometres joined with semicolons
    // are no longer nanometres — the call `textColumns` makes one op over.
    const unit = agg === 'join' ? undefined : src?.unit
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
    texts?: Set<string>
  }
  const buckets = new Map<string, Bucket>()

  for (let i = 0; i < table.length; i++) {
    // `keys` is only ever read when a *new* bucket appears, so it is materialised in that
    // branch rather than for every row.
    const hash = rowKey(keyData, i)
    let bucket = buckets.get(hash)
    if (!bucket) {
      bucket = {
        keys: keyData.map((col) => col[i] ?? null),
        n: 0,
        sum: 0,
        min: Number.POSITIVE_INFINITY,
        max: Number.NEGATIVE_INFINITY,
        ...(agg === 'countDistinct' ? { distinct: new Set<string>() } : {}),
        ...(agg === 'join' ? { texts: new Set<string>() } : {}),
      }
      buckets.set(hash, bucket)
    }
    bucket.n += 1
    if (valueData) {
      const raw = valueData[i]
      if (agg === 'countDistinct') {
        bucket.distinct!.add(raw === null || raw === undefined ? '\u0000' : String(raw))
      } else if (agg === 'join') {
        /*
         * **Distinct**, in first-appearance order, absences skipped.
         *
         * A `Set` rather than an array, and that is the departure from `string_agg` /
         * `paste(collapse=)`. This cell exists to be *read* — it is what a community-annotation
         * table folds into, and two people adding the same tag is the ordinary case there — so a
         * repeat is noise in every use this has. Leaving it to a Deduplicate upstream was the
         * first call and the wrong one: it puts a node on the main path to remove something
         * nobody wanted. Exact string match, deliberately: `DA?` and `da?` are different text
         * somebody typed, and folding them would be an editorial decision this cannot make.
         *
         * JS `Set` iterates in insertion order, which is what keeps "first appearance" true.
         */
        if (raw !== null && raw !== undefined && raw !== '') bucket.texts!.add(String(raw))
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
    if (agg === 'join') {
      // Empty rather than an empty string: a neuron nobody tagged has no tags, which is an
      // absence, and `String(null)` is the four-letter word every picker downstream would read
      // as a value.
      data[outName]!.push(bucket.texts!.size ? [...bucket.texts!].join(JOIN_SEPARATOR) : null)
    } else if (agg !== 'count') {
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

export type JoinHow = 'inner' | 'left' | 'outer' | 'right'

export const JOIN_OPTIONS: Array<{ value: JoinHow; label: string }> = [
  { value: 'left', label: 'left (every left row)' },
  { value: 'inner', label: 'inner (matched only)' },
  { value: 'outer', label: 'outer (every row of both)' },
  { value: 'right', label: 'right (every right row)' },
]

/**
 * The two keys, the direction and the collision suffix, as one argument.
 *
 * An object rather than four positional arguments, on `UploadShape`'s reasoning: two of them
 * are column names, so a caller that swapped them would type-check, run, and join on the wrong
 * pair — against a real table, silently, since a key matching nothing yields an empty inner
 * join rather than an error.
 */
export interface JoinSpec {
  leftKey: string
  rightKey: string
  how: JoinHow
  /** Appended to a right-hand column name colliding with a left-hand one. */
  suffix?: string
}

/**
 * Whether this direction can emit a row that came from the right side alone.
 *
 * Exported because it decides three separate things in three layers — whether the key column
 * reconciles here, whether the node's badge mentions it, and whether the notebook cell writes a
 * fill. Written out at each of them, a fifth direction is three edits with nothing failing when
 * one is missed, and each failure is a *plausible* wrong answer rather than an error.
 */
export function keepsUnmatchedRight(how: JoinHow): boolean {
  return how === 'outer' || how === 'right'
}

/** First row per key. A later row whose key was already seen is never matched — see below. */
function firstByKey(key: ReadonlyArray<ColumnData>, length: number): Map<string, number> {
  const index = new Map<string, number>()
  for (let i = 0; i < length; i++) {
    const k = rowKey(key, i)
    if (!index.has(k)) index.set(k, i)
  }
  return index
}

/** Right-side columns get a suffix when they collide with a left-side name. */
export function joinedColumns(
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

/**
 * The dtype the surviving key column takes, or undefined where it keeps the left's.
 *
 * Only an `outer` or a `right` join can put a right-hand key value into the left-hand key
 * column, and only then do the two sides' dtypes have to reconcile. Matching is by text
 * already, so a `str` root id meeting an `i64` neuron id joins perfectly well — but writing
 * that string into a column *declared* `i64` breaks invariant 3, and every picker, sort and
 * formatter downstream believes the declaration.
 *
 * **`mergedDType` decides, not a bare `!==`**, because it is this file's one statement of "can
 * these two reconcile, and into what" — the same question `stackColumns` and `combineColumns`
 * ask. It reconciles `i64` with `f64`, so a count joined against a ratio stays a number here
 * exactly as it does there; a `!==` test would send that pair to text, take the column out of
 * every numeric picker and flip it to locale collation, with three ops in one file disagreeing
 * about one rule. Anything genuinely irreconcilable goes to `str`, which loses nothing —
 * coercing to the left's dtype would silently round a wide id (invariant 8).
 *
 * Exported so the node's badge can name the dtype rather than restating the condition.
 */
export function joinKeyDType(
  left: TableSchema | undefined,
  right: TableSchema | undefined,
  spec: JoinSpec,
): DType | undefined {
  if (!keepsUnmatchedRight(spec.how)) return undefined
  const l = findColumn(left, spec.leftKey)
  const r = findColumn(right, spec.rightKey)
  if (!l || !r || l.dtype === r.dtype) return undefined
  return mergedDType(l.dtype, r.dtype) ?? 'str'
}

/**
 * The columns a join publishes, and how to read the right side into them.
 *
 * One function behind both halves, so the widening rule is stated once: `joinSchema` returns
 * its columns and `joinTables` builds its data from the same call, which is invariant 3 by
 * construction rather than by two functions agreeing.
 */
function joinLayout(left: TableSchema, right: TableSchema, spec: JoinSpec) {
  const { columns, rightNames } = joinedColumns(left, right, spec.rightKey, spec.suffix ?? '_r')
  const keyDType = joinKeyDType(left, right, spec)
  return {
    columns: keyDType
      ? columns.map((c) => (c.name === spec.leftKey ? column(c.name, keyDType) : c))
      : columns,
    rightNames,
    keyDType,
  }
}

export function joinSchema(
  left: TableSchema | undefined,
  right: TableSchema | undefined,
  spec: JoinSpec,
): TableSchema | undefined {
  if (!left || !right) return undefined
  return { columns: joinLayout(left, right, spec).columns }
}

/**
 * Key join of two tables.
 *
 * ## Duplicate keys annotate; they never multiply
 *
 * The side being *matched into* is deduplicated by key — the right for `left`/`inner`/`outer`,
 * the left for `right` — first occurrence winning. A many-to-many join would silently multiply
 * rows, which is rarely what anyone wants when annotating a table, and a row count that grew by
 * a factor nobody asked for is hard to notice and harder to trace.
 *
 * The consequence for `outer` is worth stating, because the obvious reading is the other one: a
 * *second* right row carrying a key the left also carries is **not** an unmatched row. It was
 * dropped by the dedupe, and resurrecting it in the outer tail would reinstate exactly the
 * multiplication the rule prevents — drawn, worse, as a left-null row for a key that plainly
 * matched. So "unmatched" means *no left row carries this key*, never "this particular right
 * row was not the one picked".
 *
 * ## One key column, filled from whichever side had the row
 *
 * The right key is dropped as redundant with the left's, so a row that came from the right
 * alone would otherwise have no key at all — the single most useful column on it. It is filled
 * from the right instead, which is exactly what `dplyr::full_join(by = join_by(a == b))` does.
 * pandas keeps both key columns instead; the emitter reproduces this rather than inheriting
 * that, since an output schema that changed shape with the join direction would empty a
 * downstream picker every time somebody tried a different one.
 *
 * ## Row order
 *
 * `left`/`inner`/`outer` keep the left's order, with the outer tail — right-only rows — after
 * it in the right's. `right` keeps the right's order throughout, which is what makes it the
 * mirror of `left` rather than "a left join with the wires swapped": the columns stay in
 * left-then-right order, so nothing downstream has to be repointed to use it.
 */
export function joinTables(left: TableValue, right: TableValue, spec: JoinSpec): TableValue {
  const { leftKey, rightKey, how } = spec
  if (!findColumn(left.schema, leftKey)) throw new Error(`Left key "${leftKey}" not found`)
  if (!findColumn(right.schema, rightKey)) throw new Error(`Right key "${rightKey}" not found`)

  const { columns, rightNames, keyDType } = joinLayout(left.schema, right.schema, spec)

  /*
   * Keys are compared through `rowKey`, this file's cell rule, rather than a second spelling of
   * it — so a Join and a Deduplicate cannot come to disagree about whether two null-keyed rows
   * are the same row, which is a different row count and no error. The one-column arrays are
   * hoisted for the same reason `dedupeTable` and `groupByTable` hoist theirs: it is read once
   * per row.
   */
  const leftKeyCols = [getColumn(left, leftKey)]
  const rightKeyData = getColumn(right, rightKey)
  const rightKeyCols = [rightKeyData]

  /** Which left and right row each output row draws from. Null on the side it did not come from. */
  const leftRows: Array<number | null> = []
  const rightRows: Array<number | null> = []

  if (how === 'right') {
    const leftIndex = firstByKey(leftKeyCols, left.length)
    for (let i = 0; i < right.length; i++) {
      leftRows.push(leftIndex.get(rowKey(rightKeyCols, i)) ?? null)
      rightRows.push(i)
    }
  } else {
    const rightIndex = firstByKey(rightKeyCols, right.length)
    /*
     * Which right rows something matched, marked as we go. The alternative — a Set of every
     * left key, built in a second pass — answers the same question by re-reading every left
     * row and retaining a copy of each key as a string: 23 ms and ~13 MB at 165,000 rows,
     * against 0.5 ms and 165 KB for this.
     */
    const matched = how === 'outer' ? new Uint8Array(right.length) : undefined
    for (let i = 0; i < left.length; i++) {
      const match = rightIndex.get(rowKey(leftKeyCols, i))
      if (match === undefined) {
        if (how !== 'inner') {
          leftRows.push(i)
          rightRows.push(null)
        }
        continue
      }
      if (matched) matched[match] = 1
      leftRows.push(i)
      rightRows.push(match)
    }
    if (matched) {
      for (let i = 0; i < right.length; i++) {
        // Only the row the dedupe kept, and only where nothing on the left matched its key.
        if (matched[i] || rightIndex.get(rowKey(rightKeyCols, i)) !== i) continue
        leftRows.push(null)
        rightRows.push(i)
      }
    }
  }

  const data: Record<string, ColumnData> = {}
  for (const col of left.schema.columns) {
    const src = getColumn(left, col.name)
    data[col.name] = leftRows.map((i) => (i === null ? null : (src[i] ?? null)))
  }
  for (const { source, out } of rightNames) {
    const src = getColumn(right, source)
    data[out] = rightRows.map((i) => (i === null ? null : (src[i] ?? null)))
  }

  if (keepsUnmatchedRight(how)) {
    const key = data[leftKey]!
    for (let i = 0; i < key.length; i++) {
      if (leftRows[i] === null) key[i] = rightKeyData[rightRows[i]!] ?? null
      // Only text needs coercing: `i64` reconciled with `f64` is a number on both sides.
      if (keyDType === 'str' && key[i] !== null) key[i] = String(key[i])
    }
  }

  /*
   * The *left* table's kind, whichever direction this is, because the output's columns are the
   * left's followed by the right's annotations — so what a row is about has not changed. An
   * outer or right join can add rows the left never had, and a `neurons` claim about those is
   * exactly as good as the claim about the right table they came from, which either met a
   * Neurons socket or did not.
   */
  return makeTable({ columns }, data, left.kind)
}

// ---------------------------------------------------------------------------
// Relabel
// ---------------------------------------------------------------------------

/** What happens to a row whose value the mapping does not cover. */
export type UnmatchedMode = 'null' | 'keep' | 'drop'

export const UNMATCHED_OPTIONS: Array<{ value: UnmatchedMode; label: string }> = [
  { value: 'null', label: 'leave empty' },
  { value: 'keep', label: 'keep the original value' },
  { value: 'drop', label: 'drop the row' },
]

export interface RelabelSpec {
  /** The column of the table being rewritten. */
  column: string
  /** The mapping table's key column, matched against `column`. */
  keyColumn: string
  /** The mapping table's value column, the replacement. */
  valueColumn: string
  /** A new column to write into, or empty to rewrite `column` in place. */
  into?: string
  unmatched: UnmatchedMode
}

/**
 * The column the mapped values land in: `spec.column` rewritten in place, or the typed `into`
 * deduplicated against the table's own names.
 *
 * Exported for the exporters, `combineLayout`'s reason: pandas' `df[name] = ...` and R's
 * `df[[name]] <- ...` both *overwrite* a column of that name, where this node suffixes — so an
 * emitter reconstructing the rule would be a second copy of it, and the two would disagree
 * exactly where somebody typed a name the table already has.
 *
 * Two arguments rather than a `RelabelSpec`, which is `keepsUnmatchedRight(how)`'s shape one op
 * over and for its reason: an emitter has raw params, not a spec, so a spec-shaped parameter
 * makes both of them fabricate three fields this cannot read and cast the result past the
 * `UnmatchedMode` check — which is where a fourth mode would arrive unnoticed.
 */
export function relabelTarget(
  schema: TableSchema | undefined,
  column: string,
  into: string | undefined,
): string {
  const name = into?.trim() ?? ''
  // Typing the column's own name means in place, `combineTable`'s rule — "naming one of the
  // columns you picked backfills it" — rather than the `column_2` that suffixing would give
  // somebody who spelled out what the empty field already means.
  if (!name || name === column) return column
  // Any *other* existing name is suffixed rather than taking that column's place: overwriting a
  // column somebody did not name in this node is not a thing to do quietly.
  return uniqueName(new Set(columnNames(schema)), name)
}

interface RelabelLayout {
  columns: ColumnSchema[]
  /** The column the mapped values land in — `spec.column`, or the deduplicated `into`. */
  target: string
}

/**
 * The columns a relabel publishes, and where the new values go.
 *
 * One function behind both halves, `joinLayout`'s arrangement and for its reason: the dtype
 * rule below is stated once rather than agreed on twice (invariant 3).
 *
 * The dtype is the *mapping's* value column, not the original's — relabelling a `str` type
 * name through a map of cluster numbers gives a column of numbers, and saying otherwise
 * empties every numeric picker downstream. `keep` is the exception, because it puts original
 * values back into the same column: that pair is reconciled by `mergedDType`, the stack's
 * rule, falling back to text exactly as `joinKeyDType` does. The unit rides along only where
 * the column is made *entirely* of mapped values, since a half-mapped column measured in the
 * map's unit is a claim about rows that never went through it.
 */
function relabelLayout(
  schema: TableSchema,
  mapSchema: TableSchema,
  spec: RelabelSpec,
): RelabelLayout | undefined {
  const source = findColumn(schema, spec.column)
  const value = findColumn(mapSchema, spec.valueColumn)
  if (!source || !value) return undefined
  const keeps = spec.unmatched === 'keep'
  const dtype = keeps ? (mergedDType(source.dtype, value.dtype) ?? 'str') : value.dtype
  const unit = keeps ? undefined : value.unit
  const target = relabelTarget(schema, spec.column, spec.into)
  if (target === source.name) {
    return {
      columns: schema.columns.map((c) =>
        c.name === source.name ? column(c.name, dtype, unit) : c,
      ),
      target,
    }
  }
  return { columns: [...schema.columns, column(target, dtype, unit)], target }
}

/**
 * Relabelling publishes the input's columns with one rewritten, or one appended.
 *
 * Unresolved pickers pass the schema straight through rather than answering `undefined`: at
 * edit time an unset picker is overwhelmingly a schema that has not arrived yet, and blanking
 * the whole downstream column list on it is the failure `resolveColumn` exists to avoid.
 */
export function relabelSchema(
  schema: TableSchema | undefined,
  mapSchema: TableSchema | undefined,
  spec: RelabelSpec,
): TableSchema | undefined {
  if (!schema) return undefined
  if (!mapSchema) return schema
  const layout = relabelLayout(schema, mapSchema, spec)
  return layout ? { columns: layout.columns } : schema
}

/**
 * Rewrite one column through a two-column mapping table.
 *
 * ## Matching is textual, and that is where a wide id has already been lost
 *
 * Keys go through `rowKey`, this file's one cell rule, so a Relabel and a Join cannot come to
 * disagree about whether two nulls are the same key. The mapper's `Labels` output carries
 * `neuronId` as `str` — [invariant 8](invariants.md) — while an edge list fetched as `i64`
 * carries a *float64*, so an eighteen-digit CAVE root id has already become a different number
 * before it reaches this function. Nothing here can undo that, and the node's `validate` says
 * so rather than letting it read as a mapping with holes in it.
 *
 * ## Duplicate keys annotate; they never multiply
 *
 * First occurrence wins, `joinTables`' rule and for the same reason: a mapping table with a
 * repeated key is a mapping that disagrees with itself, and multiplying rows over it is never
 * what anybody meant by "relabel".
 *
 * ## `unmatched` is the whole design
 *
 * `null` is the default at the node, not `keep`. Keeping an unmapped value leaves raw type
 * names sitting in a column of shared labels, where they look exactly like matched ones — the
 * failure comparative connectomics exists to avoid. `keep` is right for a deliberately partial
 * mapping, and `drop` is cocoa's `ignore_unlabeled=True`.
 */
export function relabelTable(
  table: TableValue,
  map: TableValue,
  spec: RelabelSpec,
): TableValue {
  if (!findColumn(table.schema, spec.column)) {
    throw new Error(`Column "${spec.column}" not found`)
  }
  if (!findColumn(map.schema, spec.keyColumn)) {
    throw new Error(`Mapping key column "${spec.keyColumn}" not found`)
  }
  if (!findColumn(map.schema, spec.valueColumn)) {
    throw new Error(`Mapping value column "${spec.valueColumn}" not found`)
  }
  const layout = relabelLayout(table.schema, map.schema, spec)!

  // `firstByKey`, which is `joinTables`' index rather than a second statement of its rule: a
  // disagreement between the two would be a different row *content* with nothing to raise.
  const keyColumns = [getColumn(map, spec.keyColumn)]
  const lookup = firstByKey(keyColumns, map.length)
  const values = getColumn(map, spec.valueColumn)

  // The one-element wrappers are hoisted rather than written at the call: `rowKey` takes 1..n
  // columns here and in three other ops, so once it is polymorphic the literal is an allocation
  // per row — 165,000 of them on a whole-brain index.
  const sourceColumns = [getColumn(table, spec.column)]
  const source = sourceColumns[0]!
  const mapped: ColumnData = new Array(table.length)
  // Only `drop` ever reads this, so only `drop` pays for it.
  const kept: number[] | undefined = spec.unmatched === 'drop' ? [] : undefined
  for (let row = 0; row < table.length; row++) {
    // One hash of the key, not two: `firstByKey` stores a row index, and a row index is never
    // `undefined` where the key is present.
    const hit = lookup.get(rowKey(sourceColumns, row))
    if (hit !== undefined) mapped[row] = values[hit] ?? null
    else if (kept) continue
    else mapped[row] = spec.unmatched === 'keep' ? (source[row] ?? null) : null
    kept?.push(row)
  }

  // Untouched columns are handed over by reference — `renameTable`'s note: columns are immutable
  // by contract, and a relabel over a 165,000-row index has no business copying the fifteen
  // columns it did not touch. Where rows *were* dropped, `selectRows` is the gather every other
  // row-dropping op in this file ends in, so this one is not a fifth hand-written copy of it.
  const data: Record<string, ColumnData> = {}
  for (const col of layout.columns) {
    data[col.name] = col.name === layout.target ? mapped : table.data[col.name]!
  }
  const whole = makeTable({ columns: layout.columns }, data, table.kind)
  return kept && kept.length !== table.length ? selectRows(whole, kept) : whole
}

// ---------------------------------------------------------------------------
// Pivot (table -> matrix, and the same pivot as a wide table)
// ---------------------------------------------------------------------------

/**
 * Where a pivot starts saying what its shape costs, and where it stops being possible at all.
 *
 * A pivot's Columns field is by construction the *small* axis — every distinct value becomes a
 * column of the wide table and a column of the heatmap — so a high-cardinality field there is
 * usually a mistake rather than an ambitious query, and it is a mistake that costs quadratic
 * memory before anything is drawn. "Usually", though, is why these are two tiers now rather
 * than one: a 6,000-column connectivity matrix over a whole optic lobe is a real thing to want,
 * and the old constants refused it in the same breath as they caught a misconfigured picker.
 *
 * Two thresholds because they catch different mistakes. A 2 × 1,000,000 pivot is only two
 * million cells and still produces a million-column table that `matrixToTable` would build as
 * a million JS arrays.
 *
 * The floors are the exception this file's guard rails keep: the accumulators are single
 * allocations sized by the product of two independently-resolved column pickers, so past
 * `CRASH_FLOOR_CELLS` there is no result to warn about. That is the shape of the 9 GB incident
 * in `docs/gotchas.md` — and note that the *fix* for it was `resolveColumn` keeping a chosen
 * column, not this check.
 */
export const PIVOT_COLUMNS_WARN = 2_000
/**
 * Both directions answer to this one, rather than an `UNPIVOT_CELLS_WARN` beside it.
 * `unpivotTable` asks the same question from the other side — how big a reshape of this table
 * is one somebody meant — and a second constant holding the same number is how a threshold
 * comes to drift from itself, which is what invariant 8 records about a second spelling.
 */
export const PIVOT_CELLS_WARN = 2_000_000

/**
 * A separate floor from the cell one because a wide pivot is expensive in a way cells do not
 * capture: `matrixToTable` builds one JS array *per column*, each with its own header entry in
 * the schema, so 100,000 columns is 100,000 objects before a single value is written. At the
 * cell floor that shape is only 670 rows tall, which is not a table anybody asked for.
 */
export const MAX_PIVOT_COLUMNS = 100_000

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
  /** Where a shape worth a sentence goes. `SILENT` for a caller with nobody to tell. */
  ctx: Warner,
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
        `pivot would be that many columns wide. Past ` +
        `${MAX_PIVOT_COLUMNS.toLocaleString()} columns the wide table is that many separate ` +
        `arrays and there is no result on the other side of it. Columns should be the small ` +
        `field — a side, a status, an ROI. Group or filter first.`,
    )
  }
  refuseIfOverCrashFloor(
    `A ${rowLabels.length.toLocaleString()} x ${colLabels.length.toLocaleString()} pivot`,
    size * 8,
  )
  if (colLabels.length > PIVOT_COLUMNS_WARN) {
    warnOverThreshold(ctx, {
      count: colLabels.length,
      threshold: PIVOT_COLUMNS_WARN,
      unit: `distinct values in "${columnsColumn}"`,
      control: 'the width a pivot is usually meant to have',
      cost: 'Columns is the small axis by construction — a side, a status, an ROI — and every distinct value is a column of the wide table beside the matrix.',
    })
  }
  if (size > PIVOT_CELLS_WARN) {
    warnOverThreshold(ctx, {
      count: size,
      threshold: PIVOT_CELLS_WARN,
      unit: `cells (${rowLabels.length.toLocaleString()} x ${colLabels.length.toLocaleString()})`,
      control: 'the size a pivot is usually meant to have',
      cost: `That is ${formatBytes(size * 8)} of Float64, plus the wide table beside it.`,
    })
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
 * even when it was pivoted from `neuronId` — harmless downstream, since `joinTables` keys on
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

/**
 * A cell as an axis label, with one placeholder for the absent ones.
 *
 * Exported for `similarityOps.ts`, which labels the same two axes from the same columns: a
 * similarity matrix over `preId` and a Pivot over `preId` have to name their rows identically
 * or the two cannot be joined back together, and the em dash is the visible half of that — a
 * partner with no type is one bucket here and one bucket there.
 *
 * Worth knowing at the call site rather than only here: the placeholder **pools** every absent
 * value into a single label. That is the right answer for a pivot, where a column of untyped
 * partners is a column somebody can look at and filter out. It is the wrong answer for a
 * feature vector, where it makes two neurons alike for both touching unnamed things — which is
 * why `partnerVectors.ts` resolves absences itself, before it ever gets here.
 */
export function labelOf(cell: CellValue | undefined): string {
  return cell === null || cell === undefined ? '—' : String(cell)
}

/** The distinct labels of a column, in the order a pivot axis puts them. */
export function uniqueLabels(data: ColumnData): string[] {
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
// Unpivot (wide -> long)
// ---------------------------------------------------------------------------

export interface UnpivotSpec {
  /** The wide columns, folded away one output row each. Empty means there is nothing to do. */
  columns: readonly string[]
  /** Columns repeated on every row a fold produces. Empty means everything not folded. */
  keep: readonly string[]
  /** Name of the column holding *which* column a value came from. */
  nameInto: string
  /** Name of the column holding the value itself. */
  valueInto: string
  /** Skip a cell that is null or blank instead of emitting a row for it. */
  dropEmpty?: boolean
}

export interface UnpivotPlan {
  schema: TableSchema
  /** The folded columns the table actually has, in pick order. */
  melted: string[]
  /** The repeated columns, in the order they appear in the result. */
  kept: string[]
  /** Final name of the name column, once a collision has been settled. */
  nameName: string
  /** Final name of the value column, likewise. */
  valueName: string
  /** What the value column holds — the folded columns' shared dtype, or `str`. */
  dtype: DType
  /** Whether the id column survived the fold, which is what a `neurons` kind claims. */
  neurons: boolean
}

/**
 * Everything both halves need, derived once — `combinePlan`'s shape and its reason.
 *
 * Undefined where there is nothing to do, which makes both entry points a one-line guard and
 * makes an unconfigured node pass its input through rather than refuse.
 *
 * Three decisions live here, and each is the one a reasonable person would write differently:
 *
 * **The folded set is explicit and the kept set is derived**, which looks backwards next to
 * `pivot_longer(cols = …)` until you count what each costs when it is wrong. Folding is what
 * multiplies rows — the result is `rows x folded`, the "product of two independently-resolved
 * pickers" shape `pivotTable` records a 9 GB incident about — so it is the half that has to be
 * *said*, and an unset picker means nothing is folded rather than everything is. Keeping is
 * free and lossless, so "whatever is left" is both the safe reading and the one somebody means
 * by "the id columns".
 *
 * **The value column widens rather than refusing**, through the same `combinedDType` the
 * coalesce uses and for the same reason: a picker naming these columns *is* somebody saying
 * they hold one fact. `stackColumns` refuses the same clash because there nobody said it — two
 * tables met under one column name by accident. The unit rides along only while every folded
 * column agrees on it, which is `stackColumns`' rule: synapses folded together with a length in
 * nanometres has no single unit, and carrying one would label the other's rows wrongly.
 *
 * **The two new columns yield a colliding name**, where `combineLayout`'s result would take it
 * and suffix the incumbent. The difference is what the name is *about*: a coalesce result is
 * the column somebody asked for, where `name` and `value` are this node's default spelling of
 * its own output — the same standing as `stackColumns`' source column, which is also appended
 * last and also yields.
 */
export function unpivotPlan(
  schema: TableSchema | undefined,
  spec: UnpivotSpec,
): UnpivotPlan | undefined {
  if (!schema) return undefined
  const nameInto = spec.nameInto.trim()
  const valueInto = spec.valueInto.trim()
  if (!nameInto || !valueInto) return undefined

  // Deduplicated: a column folded twice would emit its cell twice per row, which is a row
  // multiplication nobody asked for rather than a picker meaning it.
  const melted = [...new Set(spec.columns)].filter((name) => findColumn(schema, name))
  if (melted.length === 0) return undefined

  const folded = new Set(melted)
  /*
   * A column named in both pickers is folded, not kept. Keeping it too would repeat it beside
   * the value it just became — legible only as an accident — and `unpivotIssues` says so on the
   * card rather than leaving the resolution silent.
   */
  const kept = (
    spec.keep.length > 0
      ? [...new Set(spec.keep)].filter((n) => !folded.has(n) && findColumn(schema, n))
      : schema.columns.map((c) => c.name).filter((n) => !folded.has(n))
  ).slice()

  const taken = new Set(kept)
  const nameName = uniqueName(taken, nameInto)
  const valueName = uniqueName(taken, valueInto)

  const dtype = combinedDType(schema, melted)
  const units = melted.map((n) => findColumn(schema, n)?.unit)
  const unit = units.every((u) => u !== undefined && u === units[0]) ? units[0] : undefined

  const columns: ColumnSchema[] = kept.map((n) => findColumn(schema, n)!)
  columns.push(column(nameName, 'str'), column(valueName, dtype, unit))
  return {
    schema: { columns },
    melted,
    kept,
    nameName,
    valueName,
    dtype,
    neurons: kept.includes(ID_COLUMN_NAME),
  }
}

export function unpivotSchema(
  schema: TableSchema | undefined,
  spec: UnpivotSpec,
): TableSchema | undefined {
  return unpivotPlan(schema, spec)?.schema ?? schema
}

/**
 * Wide -> long: one row per input row per folded column.
 *
 * The inverse of `pivotTable`'s wide half, and the one that turns a matrix-shaped table — a
 * published connectivity CSV, a wide pivot somebody was sent — back into the long form every
 * other node here takes. `Group By`, `Filter Table`, a Scatter's two channels and every chart
 * that colours by a category all want the value in *one* column with a label beside it.
 *
 * **Row-major**, so an input row's cells stay together: rows 1..k of the result are the first
 * input row's folded columns in pick order, then the second input row's, and so on. That is
 * `tidyr::pivot_longer`'s order rather than `pandas.melt`'s, which emits one folded column's
 * whole block before the next. Either is defensible and the difference is only visible in an
 * unsorted table — but a Table viewer beside this node is what somebody checks the reshape
 * with, and grouping by the row keeps the comparison against the input a single glance.
 *
 * A folded column the schema no longer has is skipped rather than refused, `combineTable`'s
 * rule: this is a fold over a set of columns, so a name that is gone is one fewer thing to fold
 * rather than a question that can no longer be answered.
 */
export function unpivotTable(
  table: TableValue,
  spec: UnpivotSpec,
  /** Where a shape worth a sentence goes. `SILENT` for a caller with nobody to tell. */
  ctx: Warner,
): TableValue {
  const plan = unpivotPlan(table.schema, spec)
  if (!plan) return table

  const width = plan.melted.length
  const sources = plan.melted.map((name) => getColumn(table, name))
  const dropEmpty = spec.dropEmpty ?? false

  /*
   * Counted before anything is allocated, so the floor below is checked against the rows that
   * will actually exist. With `dropEmpty` the count is a pass over cells the table already
   * holds — no allocation — and a wide table that is mostly holes is exactly the case where the
   * full product would refuse a result the user can have.
   */
  let outRows = table.length * width
  if (dropEmpty) {
    outRows = 0
    for (const source of sources) {
      for (let row = 0; row < table.length; row++) if (!absent(source[row] ?? null)) outRows++
    }
  }

  const cells = outRows * plan.schema.columns.length
  refuseIfOverCrashFloor(
    `Unfolding ${width.toLocaleString()} columns over ${table.length.toLocaleString()} rows`,
    cells * 8,
  )
  if (cells > PIVOT_CELLS_WARN) {
    warnOverThreshold(ctx, {
      count: cells,
      threshold: PIVOT_CELLS_WARN,
      unit: `cells (${outRows.toLocaleString()} rows x ${plan.schema.columns.length} columns)`,
      control: 'the size a reshape is usually meant to have',
      cost:
        `Unfolding ${width.toLocaleString()} columns repeats every kept column ` +
        `${width.toLocaleString()} times. Folding fewer columns, or filtering first, costs ` +
        `proportionally less.`,
    })
  }

  const keptIn = plan.kept.map((name) => getColumn(table, name))
  const keptOut = plan.kept.map(() => new Array<CellValue>(outRows).fill(null))
  const names: ColumnData = new Array<CellValue>(outRows).fill(null)
  const values: ColumnData = new Array<CellValue>(outRows).fill(null)

  let out = 0
  for (let row = 0; row < table.length; row++) {
    for (let j = 0; j < width; j++) {
      const cell = sources[j]![row] ?? null
      if (dropEmpty && absent(cell)) continue
      for (let k = 0; k < keptIn.length; k++) keptOut[k]![out] = keptIn[k]![row] ?? null
      names[out] = plan.melted[j]!
      // Null stays null: `String(null)` is the four-letter word "null", which reads as a value
      // everywhere downstream — `combineTable`'s trap, met here on the path it does not have,
      // since a fold emits a row for an absent cell where a coalesce skips past it.
      values[out] =
        plan.dtype === 'str' && cell !== null && typeof cell !== 'string' ? String(cell) : cell
      out++
    }
  }

  const data: Record<string, ColumnData> = {}
  plan.kept.forEach((name, k) => {
    data[name] = keptOut[k]!
  })
  data[plan.nameName] = names
  data[plan.valueName] = values

  /*
   * Neurons only while the id column is one of the kept ones — `selectTable`'s rule. The ids
   * now repeat, once per folded column, and that is still a table *of* neurons: a `neurons`
   * kind is a claim about what the ids are, not about how many times each appears. Fold the id
   * column itself and the claim is gone with it.
   */
  return makeTable(
    plan.schema,
    data,
    plan.neurons && table.kind === 'neurons' ? 'neurons' : 'table',
  )
}

/**
 * What is worth saying on the card, in one place because three surfaces ask.
 *
 * Warnings, never refusals: this node passes its input through when it is not configured, so a
 * half-set-up card has no business blocking everything downstream — invariant 5's corollary,
 * and the call `combine.ts` makes one node over.
 */
export function unpivotIssues(schema: TableSchema | undefined, spec: UnpivotSpec): string[] {
  const issues: string[] = []
  if (!spec.nameInto.trim() || !spec.valueInto.trim()) {
    issues.push('Both output columns need a name — the table passes through unchanged')
  }
  if (spec.columns.length === 0) {
    issues.push('No columns to fold — the table passes through unchanged')
    return issues
  }
  const plan = unpivotPlan(schema, spec)
  if (!plan) return issues

  const both = spec.keep.filter((n) => plan.melted.includes(n))
  if (both.length > 0) {
    issues.push(`${both.join(', ')} is both folded and kept — it will only appear as a value`)
  }
  if (plan.kept.length === 0) {
    issues.push('Nothing is kept, so the values cannot be traced back to their rows')
  }
  return issues
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

/**
 * Pull an id column out as exact decimal strings — the bridge into DataSource calls.
 *
 * The per-cell rule is `idText` in `core/ids.ts`; see there for why a wide id cannot be a
 * number. This adds only what is about the *column*: a cell that is not an id is skipped, as
 * a null always has been, rather than throwing. Skipping is the rule `idList.ts` records — a
 * wired column is *data*, and refusing to run because one upstream row carried a bad id would
 * be unusable. What a caller loses is counted by comparing the result's length against the
 * table's, which is what the Input IDs card does.
 */
export function idColumn(table: TableValue, columnName = ID_COLUMN_NAME): string[] {
  const data = getColumn(table, columnName)
  const out: string[] = []
  for (const cell of data) {
    const id = idText(cell)
    if (id !== null) out.push(id)
  }
  return out
}

/** Schema for a single-column table of ids, used by stub/passthrough paths. */
export const ID_ONLY_SCHEMA: TableSchema = tableSchema(column(ID_COLUMN_NAME, 'i64'))

/**
 * Rows whose id column appears in a selection.
 *
 * Compared as strings because an `ids` param is a string array — it has to be, since that is
 * what survives a round trip through the saved file — while `neuronId` is `i64`. That rule was
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
  columnName = ID_COLUMN_NAME,
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
