/**
 * A Custom Dataset's synapse table: a wired table or table file, answered one lookup at a time.
 *
 * An edge list is read whole because every hop asks about it; a synapse table is not, because a
 * whole one is the connectome's largest artefact — FlyWire's runs to a hundred and thirty million
 * rows — and every question about it names neurons. So a lookup reads only the rows whose `pre`
 * (or `post`) column holds one of the ids asked about:
 *
 *  - **a table file** through Read Rows' own lookup (`readTableFileRows`), in its worker, matched
 *    key-first so a block with no match never has its other columns read — and **indexed
 *    automatically**: the first lookup by a column records each block's range and every later one
 *    skips by it (`withBlockIndex`), whatever the Link Table's own `Index columns` says. That pays
 *    off on the column the file is clustered by: a file sorted by `pre` skips to its outputs, while
 *    every block of it spans nearly every `post` id, so an inputs lookup stays a scan of the key
 *    column — Parquet's statistics and a stored index alike have nothing to rule out;
 *  - **an in-memory table** by a `sliced` walk over its key column, holding only the columns a
 *    lookup reads.
 *
 * What a row is: one synaptic connection, the CAVE shape — a presynaptic site repeats once per
 * partner — so `synapseUnits` is `links` and nothing else. Positions are the table's own numbers
 * times the voxel size the node was given, so they come out in nanometres. There is no template
 * space and no confidence: a table cannot say which space it is in, and a score column's scale is
 * the table's own, so neither is claimed — `Min confidence` on a synapse node is ignored, aloud.
 */

import { hashValue } from '../../core/hash'
import { ID_COLUMN_NAME, idText, isNeuronId } from '../../core/ids'
import { PinnedLru } from '../../core/lruMap'
import type { ColumnSchema, TableSchema } from '../../core/types'
import { column, findColumn, tableSchema } from '../../core/types'
import type {
  CellValue,
  ColumnData,
  PointsValue,
  TableFileValue,
  TableValue,
} from '../../core/values'
import {
  EMPTY_BOUNDS,
  boundsOf,
  emptyTable,
  isTableFileValue,
  makeTable,
} from '../../core/values'
import { sliced } from '../../core/slice'
import { fileColumn } from '../files/columns'
import type { FileFacts } from '../files/fileReads'
import { readFileRows } from '../files/fileReads'
import type { OutputColumn } from '../files/read'
import { SYNAPSES_BETWEEN_SCHEMA } from '../source'
import type { VoxelScale } from '../units'

/** Which columns hold what, by name. */
export interface SynapseColumns {
  readonly pre: string
  readonly post: string
  readonly x: string
  readonly y: string
  readonly z: string
  /** Further columns carried onto every point, after the canonical ones. */
  readonly carry: readonly string[]
  /** Nanometres per unit of `x`, `y` and `z` — `IDENTITY_SCALE` where they are nanometres. */
  readonly voxel: VoxelScale
}

/** Which end of a synapse a lookup keys on — and the polarity of every row it returns. */
type SynapseSide = 'pre' | 'post'

/** The rows one lookup kept, column by column, ids as text. */
interface SynapseRows {
  readonly length: number
  readonly pre: ColumnData
  readonly post: ColumnData
  readonly x: ColumnData
  readonly y: ColumnData
  readonly z: ColumnData
  readonly carry: Readonly<Record<string, ColumnData>>
}

/**
 * A lookup: for each of `sides`, the rows whose column for that side holds one of `ids` — asked
 * together because a file answers both ends in one pass (`key.names`), where two lookups each
 * decoded the whole table: on a 192M-row synapse table that halved a Synapses question. `carry`
 * asks for the carried columns too — a Synapses cloud wears them, a synapses-between cloud has a
 * fixed schema and would only read them to throw them away.
 */
type Lookup = (
  sides: readonly SynapseSide[],
  ids: readonly string[],
  options: { carry: boolean; signal?: AbortSignal | undefined },
) => Promise<Partial<Record<SynapseSide, SynapseRows>>>

/** A registered table: how to look rows up, and what its points are in. */
export interface SynapseTable {
  readonly lookup: Lookup
  readonly voxel: VoxelScale
  /** The carried columns' schema, in the order they were chosen. */
  readonly carried: readonly ColumnSchema[]
}

/**
 * The canonical columns a Custom Dataset's synapse points carry — the three a synapse table can
 * fill, CAVE's narrowing (`cave/schema.ts`): no `type` or `partnerType`, which would arrive null
 * on every row, and no `weight`, which CAVE fills with a score and which here would be 1 on every
 * row.
 */
const BASE_COLUMNS: readonly ColumnSchema[] = [
  column(ID_COLUMN_NAME, 'str'),
  column('partnerId', 'str'),
  column('polarity', 'str'),
]

const BASE_NAMES = new Set(BASE_COLUMNS.map((c) => c.name))

/**
 * The attribute schema of a synapse cloud with these carried columns — what inference publishes
 * and what `synapsePoints` fills, one function for both halves (invariant 3). A carried column
 * named like a canonical one is left out rather than overwriting it; `validate` says so.
 */
export function synapseSchema(carried: readonly ColumnSchema[]): TableSchema {
  return tableSchema(...BASE_COLUMNS, ...carried.filter((c) => !BASE_NAMES.has(c.name)))
}

/**
 * The carried columns' schemas, read off the input's schema — absent ones dropped, a clash with a
 * canonical name kept (`synapseSchema` is the one place that drops those; `validate` refuses them).
 */
export function carriedSchemas(
  schema: TableSchema | undefined,
  names: readonly string[],
): ColumnSchema[] {
  return names.flatMap((name) => {
    const found = schema && findColumn(schema, name)
    return found ? [found] : []
  })
}

/** Carried names that collide with a canonical column — for `validate` to name. */
export function shadowedColumns(names: readonly string[]): string[] {
  return names.filter((name) => BASE_NAMES.has(name))
}

/**
 * How many tables are remembered besides those a live dataset value pins (`pinSynapseTable`). A
 * table's lookup holds its columns, the edge tier's arrangement (`edges/store.ts`), so this bounds
 * what a session of edits keeps after the scheduler has let the values go.
 */
const MAX_TABLES = 16
const tables = new PinnedLru<SynapseTable>(MAX_TABLES)

/** Keep a synapse table for as long as `owner` — the dataset value naming it — lives. */
export function pinSynapseTable(owner: object, id: string): void {
  tables.pin(owner, id)
}

/**
 * Register a wired synapse table: its handle id — minted from the input's provenance key and the
 * columns and voxel size read from it, which together decide every answer it gives — and its
 * carried columns' schema, which the layout publishes.
 */
export function wiredSynapses(
  input: TableValue | TableFileValue,
  columns: SynapseColumns,
  inputKey: string,
): { id: string; carried: ColumnSchema[] } {
  const id = `syn-${hashValue([inputKey, columns])}`
  const carried = carriedSchemas(input.schema, columns.carry)
  const lookup = isTableFileValue(input)
    ? fileLookup(input, columns, carried)
    : tableLookup(input, columns, carried)
  tables.set(id, { lookup, voxel: columns.voxel, carried })
  return { id, carried }
}

export function synapseTableFor(id: string): SynapseTable | undefined {
  return tables.get(id)
}

/** Every column a lookup reads, by name, in one order — the file's and the table's alike. */
function namesRead(columns: SynapseColumns, carried: readonly ColumnSchema[]): string[] {
  return [
    columns.pre,
    columns.post,
    columns.x,
    columns.y,
    columns.z,
    ...carried.map((c) => c.name),
  ]
}

/*
 * Each lookup is built in a function of its own, for `edges/wired.ts`' reason: V8 gives every
 * closure made in one scope the same context, so a lookup made where the whole input is in scope
 * would keep the whole input alive for as long as the table is remembered.
 */

/**
 * The file facts a lookup keeps — a copy of those alone, so the loader's closure holds them and
 * never the value itself (the V8 rule above).
 */
function fileLookup(
  { ref, fingerprint, blocks, columns: fileColumns, schema, filters }: FileFacts,
  columns: SynapseColumns,
  carried: readonly ColumnSchema[],
): Lookup {
  const file: FileFacts = {
    ref,
    fingerprint,
    blocks,
    columns: fileColumns,
    schema,
    ...(filters ? { filters } : {}),
  }
  // Ids as text whatever the file's typing, so an eighteen-digit id arrives exact (invariant 8);
  // coordinates as numbers; a carried column as its own dtype. One entry per name: a
  // column picked twice (an axis doubling as another) is read once, the reader keying by name.
  const dtypeOf = (name: string): OutputColumn['dtype'] =>
    name === columns.pre || name === columns.post
      ? 'str'
      : (carried.find((c) => c.name === name)?.dtype ?? 'f64')
  const outputs = (names: readonly string[]) =>
    [...new Set(names)].map((name): OutputColumn => ({
      column: fileColumn(fileColumns, name, 'The Synapses file'),
      dtype: dtypeOf(name),
    }))
  const withCarry = outputs(namesRead(columns, carried))
  const without = outputs(namesRead(columns, []))
  const keyOf = (side: SynapseSide) => (side === 'pre' ? columns.pre : columns.post)
  return async (sides, ids, { carry, signal }) => {
    const read = await readFileRows(
      file,
      {
        columns: carry ? withCarry : without,
        key: { names: sides.map(keyOf), ids, indexed: true },
        limit: Infinity,
      },
      { signal },
    )
    const carriedNow = carry ? carried : []
    // One side: every row is its. Both: each side's rows picked out of the kept ones by that
    // side's own id column — read as text, so the one rule for an id's text (`keptWhere`).
    // As the reader matched them: an integer column numerically, so `0720…` found the cell
    // `720…`, and a text column by the text as written, so `0720` found `0720`. Both spellings.
    const wanted = sides.length > 1 ? new Set([...ids, ...ids.map(canonicalId)]) : undefined
    return Object.fromEntries(
      sides.map((side) => {
        const rows = wanted && keptWhere(read.data[keyOf(side)]!, wanted)
        return [side, rowsOf(read.rows, read.data, columns, carriedNow, rows)]
      }),
    )
  }
}

function tableLookup(
  table: TableValue,
  columns: SynapseColumns,
  carried: readonly ColumnSchema[],
): Lookup {
  const data: Record<string, ColumnData> = {}
  for (const name of namesRead(columns, carried)) {
    const values = table.data[name]
    if (!values) throw new Error(`The Synapses table has no column "${name}".`)
    data[name] = values
  }
  return inMemoryLookup(table.length, data, columns, carried)
}

function inMemoryLookup(
  length: number,
  data: Readonly<Record<string, ColumnData>>,
  columns: SynapseColumns,
  carried: readonly ColumnSchema[],
): Lookup {
  const idColumns = new Set([columns.pre, columns.post])
  const one = async (
    side: SynapseSide,
    ids: readonly string[],
    carry: boolean,
    signal: AbortSignal | undefined,
  ): Promise<SynapseRows> => {
    const wanted = new Set(ids)
    const key = data[side === 'pre' ? columns.pre : columns.post]!
    // A walk of the whole key column, so `sliced`: yielding, and seeing a Cancel.
    const matched: number[] = []
    await sliced(length, { signal }, (row) => {
      const id = idText(key[row])
      if (id !== null && wanted.has(id)) matched.push(row)
    })
    // Copied for the matches only — the columns `namesRead` lists, the file route's own list — and
    // the two id columns as text, the file's reader asking for them that way, so both lookups hand
    // `synapsePoints` the same thing (invariant 8).
    const kept: Record<string, ColumnData> = {}
    for (const name of new Set(namesRead(columns, carry ? carried : []))) {
      const values = data[name]!
      kept[name] = idColumns.has(name)
        ? matched.map((row) => idText(values[row]))
        : matched.map((row) => values[row] ?? null)
    }
    return rowsOf(matched.length, kept, columns, carry ? carried : [])
  }
  return async (sides, ids, { carry, signal }) =>
    Object.fromEntries(
      await Promise.all(sides.map(async (side) => [side, await one(side, ids, carry, signal)])),
    )
}

/** The rows as a lookup hands them over — all of them, or only `rows` where a read kept more. */
function rowsOf(
  length: number,
  data: Readonly<Record<string, ColumnData>>,
  columns: SynapseColumns,
  carried: readonly ColumnSchema[],
  rows?: readonly number[],
): SynapseRows {
  const column = (name: string): ColumnData => {
    const values = data[name]!
    return rows ? rows.map((row) => values[row] ?? null) : values
  }
  return {
    length: rows ? rows.length : length,
    pre: column(columns.pre),
    post: column(columns.post),
    x: column(columns.x),
    y: column(columns.y),
    z: column(columns.z),
    carry: Object.fromEntries(carried.map((c) => [c.name, column(c.name)])),
  }
}

// ---------------------------------------------------------------------------
// Rows to points — one set of rules for both clouds
// ---------------------------------------------------------------------------

/**
 * The rows' positions, in nanometres: the table's numbers times the voxel size — every row, or
 * only the `kept` ones where a filter dropped some.
 */
function writePositions(
  into: Float32Array,
  at: number,
  rows: SynapseRows,
  voxel: VoxelScale,
  kept?: readonly number[],
): void {
  const [vx, vy, vz] = voxel
  const count = kept ? kept.length : rows.length
  for (let i = 0; i < count; i++) {
    const row = kept ? kept[i]! : i
    into[at++] = Number(rows.x[row] ?? NaN) * vx
    into[at++] = Number(rows.y[row] ?? NaN) * vy
    into[at++] = Number(rows.z[row] ?? NaN) * vz
  }
}

/** A cloud in nanometres, in no claimed space. */
function cloud(positions: Float32Array, attributes: TableValue): PointsValue {
  return {
    kind: 'points',
    positions,
    attributes,
    bounds: positions.length ? boundsOf([positions]) : EMPTY_BOUNDS,
    units: 'nm',
  }
}

/**
 * The rows `sides` looked up, as one point cloud: each lookup's rows oriented to its own side —
 * `neuronId` the end looked up, `partnerId` the other, `polarity` that side.
 */
export async function synapsePoints(
  table: SynapseTable,
  sides: readonly SynapseSide[],
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<PointsValue> {
  const bySide = await table.lookup(sides, ids, { carry: true, signal })
  const found = sides.map((side) => ({ side, rows: bySide[side]! }))
  const total = found.reduce((n, part) => n + part.rows.length, 0)
  const positions = new Float32Array(total * 3)
  const columns: Record<string, CellValue[]> = {
    [ID_COLUMN_NAME]: [],
    partnerId: [],
    polarity: [],
    ...Object.fromEntries(table.carried.map((c) => [c.name, []])),
  }
  let at = 0
  for (const { side, rows } of found) {
    writePositions(positions, at * 3, rows, table.voxel)
    at += rows.length
    const own = side === 'pre' ? rows.pre : rows.post
    const other = side === 'pre' ? rows.post : rows.pre
    for (let row = 0; row < rows.length; row++) {
      columns[ID_COLUMN_NAME]!.push(own[row] ?? null)
      columns.partnerId!.push(other[row] ?? null)
      columns.polarity!.push(side)
    }
    // A loop rather than `push(...column)`: spread passes every row as an argument, and a
    // connected neuron's rows run past what a call's stack will take.
    for (const c of table.carried) {
      const from = rows.carry[c.name]!
      const into = columns[c.name]!
      for (let row = 0; row < rows.length; row++) into.push(from[row] ?? null)
    }
  }
  return cloud(positions, makeTable(synapseSchema(table.carried), columns))
}

/** A synapses-between cloud with nothing in it, for a question bound to nobody — no lookup made. */
export function emptySynapsesBetween(): PointsValue {
  return cloud(new Float32Array(0), emptyTable(SYNAPSES_BETWEEN_SCHEMA))
}

/**
 * The synapses from `sourceIds` onto `targetIds` — one lookup, on whichever end is bound (the
 * sources where both are), filtered on the other: `fetchSynapsesBetween`'s contract, oriented, so
 * `neuronId` is always the presynaptic end.
 *
 * `polarity` is **left empty**, and that is the honest answer rather than a gap: on this cloud it
 * names the end each point is drawn at, and a table has one position per synapse with nothing to
 * say which end that is. Writing the `location` asked for would be a column claiming a move that
 * never happened; the caller says so through `onWarn`. `confidence` is empty for the same reason
 * the synapse schema has no score. Types come from the neuron table, null where it has none.
 */
export async function synapsesBetween(
  table: SynapseTable,
  req: {
    sourceIds?: readonly string[]
    targetIds?: readonly string[]
    signal?: AbortSignal
  },
  types: ReadonlyMap<string, string>,
): Promise<PointsValue> {
  const side: SynapseSide = req.sourceIds ? 'pre' : 'post'
  const rows = (
    await table.lookup([side], (req.sourceIds ?? req.targetIds)!, {
      carry: false,
      signal: req.signal,
    })
  )[side]!
  // Only with both ends bound is there a filter; with one, every row looked up is an answer, and
  // the lookup's own columns go through as they are.
  const partners = req.sourceIds && req.targetIds ? new Set(req.targetIds) : undefined
  const kept = partners && keptWhere(rows.post, partners)
  const length = kept ? kept.length : rows.length
  const positions = new Float32Array(length * 3)
  writePositions(positions, 0, rows, table.voxel, kept)
  const pre = kept ? kept.map((row) => rows.pre[row] ?? null) : rows.pre
  const post = kept ? kept.map((row) => rows.post[row] ?? null) : rows.post
  const typeOf = (id: CellValue) => (typeof id === 'string' ? (types.get(id) ?? null) : null)
  const empty = () => new Array<CellValue>(length).fill(null)
  return cloud(
    positions,
    makeTable(SYNAPSES_BETWEEN_SCHEMA, {
      [ID_COLUMN_NAME]: pre,
      type: pre.map(typeOf),
      partnerId: post,
      partnerType: post.map(typeOf),
      polarity: empty(),
      confidence: empty(),
    }),
  )
}

/** An id as the reader compares it: a number's decimal digits, anything else as written. */
function canonicalId(id: string): string {
  return isNeuronId(id) ? BigInt(id).toString() : id
}

/** The rows whose `column` holds one of `ids`. */
function keptWhere(column: ColumnData, ids: ReadonlySet<string>): number[] {
  const kept: number[] = []
  for (let row = 0; row < column.length; row++) {
    const id = idText(column[row])
    if (id !== null && ids.has(id)) kept.push(row)
  }
  return kept
}
