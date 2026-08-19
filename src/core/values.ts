/**
 * Runtime values that flow along edges.
 *
 * Tables are columnar: one plain JS array per column plus a row count. That keeps
 * group-by/filter loops monomorphic and makes the eventual swap to Apache Arrow a
 * matter of reimplementing the accessors in this file rather than rewriting nodes.
 * Nodes must treat columns as immutable — always build new arrays.
 */

import type { TableSchema } from './types'

export type CellValue = number | string | boolean | null
export type ColumnData = CellValue[]

export interface TableValue {
  readonly kind: 'table' | 'neurons'
  readonly schema: TableSchema
  /** Column name -> column array. Every array has exactly `length` entries. */
  readonly data: Readonly<Record<string, ColumnData>>
  readonly length: number
}

export interface MatrixValue {
  readonly kind: 'matrix'
  readonly rowLabels: string[]
  readonly colLabels: string[]
  /** Row-major, `rowLabels.length * colLabels.length` entries. */
  readonly values: Float64Array
  /** What the cells mean, for viewer axis/legend labels. */
  readonly valueLabel?: string
}

export interface DatasetValue {
  readonly kind: 'dataset'
  /** Id of the registered DataSource this dataset lives in. */
  readonly sourceId: string
  readonly datasetId: string
  readonly label: string
}

export interface ScalarValue {
  readonly kind: 'number' | 'string' | 'boolean'
  readonly value: number | string | boolean
}

/** Axis-aligned bounding box, used to frame a 3D scene without rescanning geometry. */
export interface Bounds3 {
  min: [number, number, number]
  max: [number, number, number]
}

/**
 * A node-link graph.
 *
 * Topology *and* attribute tables, deliberately. Visual encodings and graph metrics both
 * want to read "the value of column X for this node/edge", so keeping attributes as
 * ordinary Coda tables means the same column-picker machinery works here, and a future
 * Centrality node can simply append a column.
 */
export interface NetworkValue {
  readonly kind: 'network'
  readonly directed: boolean
  /** One row per node. Must contain an `id` column; the rest are attributes. */
  readonly nodes: TableValue
  /** One row per edge. Must contain `source` and `target`; the rest are attributes. */
  readonly edges: TableValue
}

/** One neuron's branching morphology, SWC-style, in parallel typed arrays. */
export interface SkeletonGeometry {
  readonly bodyId: number
  /** Point coordinates, xyz interleaved: `positions[i * 3 + 0..2]`. */
  readonly positions: Float32Array
  readonly radii: Float32Array
  /** Parent index per point; -1 for a root. Defines the tree. */
  readonly parents: Int32Array
}

export interface SkeletonsValue {
  readonly kind: 'skeletons'
  readonly items: SkeletonGeometry[]
  /** One row per item, in the same order. Must contain `bodyId`. */
  readonly attributes: TableValue
  readonly bounds: Bounds3
}

export interface MeshGeometry {
  readonly bodyId: number
  /** xyz interleaved. */
  readonly positions: Float32Array
  /** Triangle indices into `positions`. */
  readonly indices: Uint32Array
}

/**
 * Which level of detail a mesh set was fetched at.
 *
 * Present only for multi-resolution sources. It exists because the spread is enormous — one
 * hemibrain neuron is 2.0 MB at the finest level and 10.8 kB at the coarsest — so a viewer
 * that showed the coarsest silently would look like a broken renderer rather than a
 * deliberate trade.
 */
export interface MeshDetail {
  /** 0 is finest. */
  lod: number
  /** How many levels the source offered. */
  levels: number
  triangles: number
}

export interface MeshesValue {
  readonly kind: 'meshes'
  readonly items: MeshGeometry[]
  readonly attributes: TableValue
  readonly bounds: Bounds3
  readonly detail?: MeshDetail
}

/**
 * A point cloud with one attribute row per point — synapses, soma positions. The 1:1
 * relationship between `positions` and `attributes` rows is what lets a colour encoding
 * address individual points by column.
 */
export interface PointsValue {
  readonly kind: 'points'
  /** xyz interleaved; `attributes.length * 3` entries. */
  readonly positions: Float32Array
  readonly attributes: TableValue
  readonly bounds: Bounds3
}

/**
 * Where a network's nodes sit, keyed by node id.
 *
 * A plain record rather than a Map because values cross the scheduler's cache and get compared
 * and logged; a record is inspectable and structurally cloneable with no ceremony. Ids not in
 * the network are ignored and network nodes not named here fall back to the viewer's own seed,
 * so a layout computed before an upstream filter ran still places everything it can.
 */
export interface LayoutValue {
  readonly kind: 'layout'
  readonly positions: Readonly<Record<string, { x: number; y: number }>>
  /** What produced it, for the viewer's caption. Free text, e.g. "ELK layered". */
  readonly algorithm?: string
}

export type Value =
  | TableValue
  | MatrixValue
  | DatasetValue
  | ScalarValue
  | NetworkValue
  | SkeletonsValue
  | MeshesValue
  | PointsValue
  | LayoutValue

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export function makeTable(
  schema: TableSchema,
  data: Record<string, ColumnData>,
  kind: 'table' | 'neurons' = 'table',
): TableValue {
  let length = 0
  for (const col of schema.columns) {
    const arr = data[col.name]
    if (!arr)
      throw new Error(`makeTable: column "${col.name}" declared in schema but not provided`)
    length = Math.max(length, arr.length)
  }
  for (const col of schema.columns) {
    const arr = data[col.name]!
    if (arr.length !== length) {
      throw new Error(
        `makeTable: ragged columns — "${col.name}" has ${arr.length} rows, expected ${length}`,
      )
    }
  }
  return { kind, schema, data, length }
}

/** Build a table from row objects. Convenient for small/mock data, not hot paths. */
export function tableFromRows(
  schema: TableSchema,
  rows: Array<Record<string, CellValue>>,
  kind: 'table' | 'neurons' = 'table',
): TableValue {
  const data: Record<string, ColumnData> = {}
  for (const col of schema.columns) data[col.name] = []
  for (const row of rows) {
    for (const col of schema.columns) {
      data[col.name]!.push(row[col.name] ?? null)
    }
  }
  return makeTable(schema, data, kind)
}

export function emptyTable(
  schema: TableSchema,
  kind: 'table' | 'neurons' = 'table',
): TableValue {
  const data: Record<string, ColumnData> = {}
  for (const col of schema.columns) data[col.name] = []
  return makeTable(schema, data, kind)
}

export function makeMatrix(
  rowLabels: string[],
  colLabels: string[],
  values: Float64Array,
  valueLabel?: string,
): MatrixValue {
  const expected = rowLabels.length * colLabels.length
  if (values.length !== expected) {
    throw new Error(`makeMatrix: expected ${expected} values, got ${values.length}`)
  }
  return valueLabel
    ? { kind: 'matrix', rowLabels, colLabels, values, valueLabel }
    : { kind: 'matrix', rowLabels, colLabels, values }
}

export function num(value: number): ScalarValue {
  return { kind: 'number', value }
}
export function str(value: string): ScalarValue {
  return { kind: 'string', value }
}
export function bool(value: boolean): ScalarValue {
  return { kind: 'boolean', value }
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

export function getColumn(table: TableValue, name: string): ColumnData {
  const col = table.data[name]
  if (!col) {
    throw new Error(
      `Column "${name}" not found. Available: ${table.schema.columns.map((c) => c.name).join(', ') || '(none)'}`,
    )
  }
  return col
}

export function getRow(table: TableValue, index: number): Record<string, CellValue> {
  const row: Record<string, CellValue> = {}
  for (const col of table.schema.columns) row[col.name] = table.data[col.name]![index] ?? null
  return row
}

/** Materialise selected row indices into a new table, preserving schema. */
export function selectRows(table: TableValue, indices: number[]): TableValue {
  const data: Record<string, ColumnData> = {}
  for (const col of table.schema.columns) {
    const src = table.data[col.name]!
    const dst: ColumnData = new Array(indices.length)
    for (let i = 0; i < indices.length; i++) dst[i] = src[indices[i]!] ?? null
    data[col.name] = dst
  }
  return makeTable(table.schema, data, table.kind)
}

// ---------------------------------------------------------------------------
// Type <-> value bridging
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 3D helpers
// ---------------------------------------------------------------------------

export const EMPTY_BOUNDS: Bounds3 = { min: [0, 0, 0], max: [0, 0, 0] }

/**
 * Bounds of a set of interleaved xyz buffers.
 *
 * Un-grown boxes collapse to the origin rather than carrying infinities out: a viewer that
 * frames on `Infinity` shows nothing and blames nothing.
 */
export function boundsOf(buffers: readonly Float32Array[]): Bounds3 {
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const positions of buffers) {
    for (let i = 0; i < positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        const v = positions[i + axis]!
        if (v < min[axis]!) min[axis] = v
        if (v > max[axis]!) max[axis] = v
      }
    }
  }
  if (!Number.isFinite(min[0])) return EMPTY_BOUNDS
  return { min, max }
}

/**
 * Summed straight-line distance between connected points, in the skeleton's own units.
 *
 * Shared so the mock and the real decoder cannot disagree: geometry is normalised to
 * nanometres (see `data/neuprint/units.ts`), and a traversal fix applied to one copy would
 * silently make the fixtures stop standing in for the thing they replace.
 */
export function cableLength(skeleton: SkeletonGeometry): number {
  let total = 0
  for (let i = 0; i < skeleton.parents.length; i++) {
    const parent = skeleton.parents[i]!
    if (parent < 0) continue
    total += Math.hypot(
      skeleton.positions[i * 3]! - skeleton.positions[parent * 3]!,
      skeleton.positions[i * 3 + 1]! - skeleton.positions[parent * 3 + 1]!,
      skeleton.positions[i * 3 + 2]! - skeleton.positions[parent * 3 + 2]!,
    )
  }
  return total
}

export function boundsCenter(b: Bounds3): [number, number, number] {
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2]
}

export function boundsSize(b: Bounds3): number {
  return Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) || 1
}

export function isNetworkValue(v: Value | undefined): v is NetworkValue {
  return !!v && v.kind === 'network'
}
export function isSkeletonsValue(v: Value | undefined): v is SkeletonsValue {
  return !!v && v.kind === 'skeletons'
}
export function isMeshesValue(v: Value | undefined): v is MeshesValue {
  return !!v && v.kind === 'meshes'
}
export function isPointsValue(v: Value | undefined): v is PointsValue {
  return !!v && v.kind === 'points'
}

/** Total point count across a skeleton collection, for summaries and guard rails. */
export function skeletonPointCount(v: SkeletonsValue): number {
  return v.items.reduce((sum, item) => sum + item.parents.length, 0)
}

export function meshTriangleCount(v: MeshesValue): number {
  return v.items.reduce((sum, item) => sum + item.indices.length / 3, 0)
}

export function isTableValue(v: Value | undefined): v is TableValue {
  return !!v && (v.kind === 'table' || v.kind === 'neurons')
}

export function isMatrixValue(v: Value | undefined): v is MatrixValue {
  return !!v && v.kind === 'matrix'
}

export function isDatasetValue(v: Value | undefined): v is DatasetValue {
  return !!v && v.kind === 'dataset'
}

export function isLayoutValue(v: Value | undefined): v is LayoutValue {
  return !!v && v.kind === 'layout'
}

export function makeLayout(
  positions: Record<string, { x: number; y: number }>,
  algorithm?: string,
): LayoutValue {
  return algorithm ? { kind: 'layout', positions, algorithm } : { kind: 'layout', positions }
}

export function asString(v: Value | undefined, fallback = ''): string {
  if (!v) return fallback
  if (v.kind === 'string') return v.value as string
  if (v.kind === 'number' || v.kind === 'boolean') return String(v.value)
  return fallback
}

/** Row count summary used in node footers: "1,234 rows". */
export function describeValue(v: Value | undefined): string {
  if (!v) return '—'
  switch (v.kind) {
    case 'table':
    case 'neurons':
      return `${v.length.toLocaleString()} ${v.length === 1 ? 'row' : 'rows'} × ${v.schema.columns.length} col`
    case 'matrix':
      return `${v.rowLabels.length} × ${v.colLabels.length} matrix`
    case 'dataset':
      return v.label
    case 'network':
      return `${v.nodes.length.toLocaleString()} nodes · ${v.edges.length.toLocaleString()} edges`
    case 'skeletons':
      return `${v.items.length} skeleton${v.items.length === 1 ? '' : 's'} · ${skeletonPointCount(v).toLocaleString()} pts`
    case 'meshes':
      return `${v.items.length} mesh${v.items.length === 1 ? '' : 'es'} · ${meshTriangleCount(v).toLocaleString()} tris`
    case 'points':
      return `${v.attributes.length.toLocaleString()} points`
    case 'layout': {
      const count = Object.keys(v.positions).length
      return `${count.toLocaleString()} placed${v.algorithm ? ` · ${v.algorithm}` : ''}`
    }
    case 'string': {
      // Elided, because this is a one-line footer and a string value can be enormous — the
      // Neuroglancer node emits a URL that carries a whole viewer state, 70 kB on male-CNS.
      const text = String(v.value)
      return text.length > 60 ? `${text.slice(0, 59)}…` : text
    }
    default:
      return String(v.value)
  }
}
