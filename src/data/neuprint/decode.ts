/**
 * Turning neuPrint responses into Coda values.
 *
 * Kept pure and separate from the HTTP layer so every mapping here is testable against
 * recorded fixtures — which matters more than usual, because the alternative is testing
 * against a shared production server.
 *
 * neuPrint answers Cypher with `{columns, data}`: column *expressions* ("n.bodyId") and
 * rows as positional arrays. That is already Coda's table shape, so decoding is mostly
 * coercion — with one exception, `roiInfo`, which arrives as a JSON blob per neuron and has
 * to be unpacked into rows.
 */

import type { ColumnSchema, DType, TableSchema } from '../../core/types'
import { column, tableSchema } from '../../core/types'
import type { CellValue, ColumnData, SkeletonGeometry, TableValue } from '../../core/values'
import { makeTable } from '../../core/values'

export interface CypherResponse {
  columns: string[]
  data: unknown[][]
}

/** Coerce one JSON cell to the dtype its column declares. */
export function coerce(value: unknown, dtype: DType): CellValue {
  if (value === null || value === undefined) return null
  switch (dtype) {
    case 'i64':
    case 'f64': {
      const n = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(n) ? n : null
    }
    case 'bool':
      return typeof value === 'boolean' ? value : Boolean(value)
    default:
      return typeof value === 'string' ? value : String(value)
  }
}

/**
 * Build a table by taking response columns *positionally* against a schema.
 *
 * Positional rather than by name because neuPrint returns the expression text as the column
 * name ("n.bodyId", "s.location.x"), which is not what Coda calls the column. The builders
 * in `cypher.ts` are written to emit RETURN in schema order; a mismatched count means those
 * two drifted apart, and it is far better to say so than to shift every column by one.
 */
export function tableFromCypher(
  response: CypherResponse,
  schema: TableSchema,
  kind: 'table' | 'neurons' = 'table',
): TableValue {
  const columns = schema.columns
  if (response.columns.length !== columns.length) {
    throw new Error(
      `neuPrint returned ${response.columns.length} columns but the schema declares ${columns.length} ` +
        `(${response.columns.join(', ')})`,
    )
  }
  const data: Record<string, ColumnData> = {}
  columns.forEach((col, index) => {
    data[col.name] = response.data.map((row) => coerce(row[index], col.dtype))
  })
  return makeTable(schema, data, kind)
}

/**
 * Build a table when nothing declared the schema — the Raw Cypher node's case.
 *
 * Types are sniffed from the values actually returned rather than assumed, so a column of
 * body ids stays numeric and can drive a size encoding. A column that is entirely null has
 * no evidence either way and becomes a string, which is the type that renders anything.
 */
export function inferTableFromCypher(response: CypherResponse): TableValue {
  const names = dedupeNames(response.columns.map(cleanColumnName))
  const schema = tableSchema(
    ...names.map((name, index): ColumnSchema => column(name, sniffDType(response.data, index))),
  )
  const data: Record<string, ColumnData> = {}
  schema.columns.forEach((col, index) => {
    data[col.name] = response.data.map((row) => coerce(flatten(row[index]), col.dtype))
  })
  return makeTable(schema, data)
}

/** `n.bodyId` reads as `bodyId` in a column picker; `count(*)` has to stay as it is. */
function cleanColumnName(raw: string): string {
  const trimmed = raw.trim()
  const match = /^[A-Za-z_][A-Za-z0-9_]*\.(.+)$/.exec(trimmed)
  return (match?.[1] ?? trimmed) || 'column'
}

/** Two `RETURN n.type, p.type` columns would both become "type" and collide in the table. */
function dedupeNames(names: string[]): string[] {
  const seen = new Map<string, number>()
  return names.map((name) => {
    const count = seen.get(name) ?? 0
    seen.set(name, count + 1)
    return count === 0 ? name : `${name}_${count + 1}`
  })
}

function sniffDType(rows: unknown[][], index: number): DType {
  let sawNumber = false
  let sawBool = false
  for (const row of rows) {
    const cell = row[index]
    if (cell === null || cell === undefined) continue
    if (typeof cell === 'number') sawNumber = true
    else if (typeof cell === 'boolean') sawBool = true
    else return 'str'
  }
  if (sawNumber && !sawBool) return 'f64'
  if (sawBool && !sawNumber) return 'bool'
  return 'str'
}

/** Cypher can return maps and lists; a table cell cannot hold one, so show its JSON. */
function flatten(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return JSON.stringify(value)
  return value
}

// ---------------------------------------------------------------------------
// roiInfo
// ---------------------------------------------------------------------------

export const ROI_COUNTS_SCHEMA = tableSchema(
  column('bodyId', 'i64'),
  column('type', 'str'),
  column('roi', 'str'),
  column('pre', 'i64', 'synapses'),
  column('post', 'i64', 'synapses'),
)

/**
 * Unpack `roiInfo` into one row per (neuron, ROI).
 *
 * The blob is `{"LO(R)": {"pre": 63, "post": 1063, ...}}` as a JSON *string*. It nests
 * overlapping ROIs — a synapse in `LO(R)` is also counted in its parent `OL(R)` — so the
 * caller's `rois` filter is applied here rather than summed blindly downstream, where
 * double counting would look like real numbers.
 */
export function roiCountsFromCypher(response: CypherResponse, rois?: string[]): TableValue {
  const wanted = rois?.length ? new Set(rois) : undefined
  const bodyId: ColumnData = []
  const type: ColumnData = []
  const roi: ColumnData = []
  const pre: ColumnData = []
  const post: ColumnData = []

  for (const row of response.data) {
    const id = coerce(row[0], 'i64')
    const neuronType = coerce(row[1], 'str')
    const info = parseRoiInfo(row[2])
    for (const [name, counts] of Object.entries(info)) {
      if (wanted && !wanted.has(name)) continue
      bodyId.push(id)
      type.push(neuronType)
      roi.push(name)
      pre.push(coerce(counts.pre ?? 0, 'i64'))
      post.push(coerce(counts.post ?? 0, 'i64'))
    }
  }
  return makeTable(ROI_COUNTS_SCHEMA, { bodyId, type, roi, pre, post })
}

interface RoiCounts {
  pre?: number
  post?: number
}

/** Tolerant: a neuron with no `roiInfo`, or an unparseable one, contributes no rows. */
export function parseRoiInfo(raw: unknown): Record<string, RoiCounts> {
  if (!raw) return {}
  if (typeof raw === 'object') return raw as Record<string, RoiCounts>
  if (typeof raw !== 'string') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, RoiCounts>) : {}
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// Skeletons
// ---------------------------------------------------------------------------

export interface SwcResponse {
  columns: string[]
  data: unknown[][]
}

/**
 * SWC rows to a Coda skeleton.
 *
 * neuPrint returns `[rowId, x, y, z, radius, link]` in arbitrary order, with `link` naming a
 * *rowId*, not an index. Coda's `parents` are indices, and everything that walks a skeleton
 * (cable length, downstream morphometrics) is written expecting a parent to appear before
 * its child — so the points are re-emitted in traversal order from each root rather than
 * passed through in file order.
 *
 * Defensive about real files: a `link` pointing at a missing row becomes a root, and a
 * cycle terminates because a point is only ever visited once.
 */
export function skeletonFromSwc(bodyId: number, response: SwcResponse): SkeletonGeometry {
  const index = new Map<string, number>()
  response.columns.forEach((name, i) => index.set(name.toLowerCase(), i))
  const at = (row: unknown[], name: string, fallback: number) => {
    const i = index.get(name)
    const value = i === undefined ? undefined : row[i]
    const n = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(n) ? n : fallback
  }

  const rows = response.data
  const count = rows.length
  const rowIdToSlot = new Map<number, number>()
  rows.forEach((row, slot) => rowIdToSlot.set(at(row, 'rowid', slot + 1), slot))

  // Children per slot, so a traversal can go root -> leaf.
  const children: number[][] = Array.from({ length: count }, () => [])
  const roots: number[] = []
  rows.forEach((row, slot) => {
    const link = at(row, 'link', -1)
    const parent = rowIdToSlot.get(link)
    if (parent === undefined || parent === slot) roots.push(slot)
    else children[parent]!.push(slot)
  })

  const positions = new Float32Array(count * 3)
  const radii = new Float32Array(count)
  const parents = new Int32Array(count)

  let emitted = 0
  const slotToPoint = new Map<number, number>()
  const stack: Array<{ slot: number; parentPoint: number }> = roots.map((slot) => ({
    slot,
    parentPoint: -1,
  }))

  while (stack.length) {
    const { slot, parentPoint } = stack.pop()!
    if (slotToPoint.has(slot)) continue // a cycle, or a row linked twice
    const row = rows[slot]!
    const point = emitted++
    slotToPoint.set(slot, point)
    positions[point * 3] = at(row, 'x', 0)
    positions[point * 3 + 1] = at(row, 'y', 0)
    positions[point * 3 + 2] = at(row, 'z', 0)
    radii[point] = at(row, 'radius', 0)
    parents[point] = parentPoint
    for (const child of children[slot]!) stack.push({ slot: child, parentPoint: point })
  }

  // Anything left is in a cycle with no root. Emit it as its own tree rather than drop it —
  // silently losing half a neuron is worse than an arbitrary root.
  for (let slot = 0; slot < count; slot++) {
    if (slotToPoint.has(slot)) continue
    const row = rows[slot]!
    const point = emitted++
    slotToPoint.set(slot, point)
    positions[point * 3] = at(row, 'x', 0)
    positions[point * 3 + 1] = at(row, 'y', 0)
    positions[point * 3 + 2] = at(row, 'z', 0)
    radii[point] = at(row, 'radius', 0)
    parents[point] = -1
  }

  return {
    bodyId,
    positions: positions.subarray(0, emitted * 3),
    radii: radii.subarray(0, emitted),
    parents: parents.subarray(0, emitted),
  }
}
