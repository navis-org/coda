/**
 * Coda's socket type system.
 *
 * Two jobs:
 *  1. Reject wiring that cannot work (Table -> Skeleton) at edit time, not run time.
 *  2. Carry *column schemas* along edges so downstream nodes can offer real column
 *     pickers before anything has executed.
 *
 * Types are plain data (no classes) so they serialise into the graph file and can be
 * compared structurally. Nothing in this module touches the DOM or React.
 */

/** Column storage/semantic types. Deliberately close to Arrow so payloads can migrate. */
export type DType = 'i64' | 'f64' | 'str' | 'bool'

export interface ColumnSchema {
  name: string
  dtype: DType
  /** Optional free-text unit ("nm", "synapses") surfaced in table headers. */
  unit?: string
}

/**
 * An ordered set of columns. `undefined` schema on a table type means "unknown yet"
 * (e.g. the raw output of a Cypher node), which is assignable to any table input but
 * cannot populate a column picker.
 */
export interface TableSchema {
  columns: ColumnSchema[]
}

export type CodaType =
  /** Wildcard. Only used by reroute/debug nodes — real nodes should name a type. */
  | { kind: 'any' }
  | { kind: 'number' }
  | { kind: 'string' }
  | { kind: 'boolean' }
  /**
   * A dataset handle. `sourceId`/`datasetId` are *refinements* filled in by the Dataset
   * node at edit time — they let downstream nodes look up that source's column schemas
   * and dataset metadata (ROI lists, statuses) before anything executes. Absent means
   * "some dataset, not yet known".
   */
  | { kind: 'dataset'; sourceId?: string; datasetId?: string }
  /** Columnar table. */
  | { kind: 'table'; schema?: TableSchema }
  /** A table guaranteed to have a `bodyId` column. Subtype of `table`. */
  | { kind: 'neurons'; schema?: TableSchema }
  /** Labelled 2D numeric array — adjacency, correlation, pivot output. */
  | { kind: 'matrix' }
  /**
   * A node-link graph: node and edge attribute tables plus topology. Distinct from
   * `matrix` because it keeps per-node and per-edge attributes, which is what visual
   * encodings and graph metrics both read from.
   */
  | { kind: 'network'; nodeSchema?: TableSchema; edgeSchema?: TableSchema }
  /** Branching morphologies (SWC-like), one per neuron, with an attribute table. */
  | { kind: 'skeletons'; schema?: TableSchema }
  /** Triangle meshes, one per neuron or ROI, with an attribute table. */
  | { kind: 'meshes'; schema?: TableSchema }
  /** A 3D point cloud — synapses, soma positions — with one attribute row per point. */
  | { kind: 'points'; schema?: TableSchema }
  /**
   * Positions for a network's nodes, keyed by node id.
   *
   * Deliberately its own kind rather than a table of `id`/`x`/`y`. A layout is not data about
   * neurons — it is an arrangement computed *for* a particular node set, and typing it means a
   * viewer's Layout socket can only ever be handed one. A table would accept any two numeric
   * columns and fail at run time with a column picker to configure first.
   */
  | { kind: 'layout' }
  /**
   * A hierarchical clustering — the merge tree of a score matrix.
   *
   * Its own kind for the reason `layout` is: it is a tree computed *for* one particular set of
   * observations, not data about them, so typing it means a Dendrogram's socket can only ever
   * be handed one. As a table of `[a, b, height, size]` it would take any four numeric columns
   * and be quietly destroyed by an upstream Sort. See `LinkageValue`.
   */
  | { kind: 'linkage' }

export type TypeKind = CodaType['kind']

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export const T = {
  any: (): CodaType => ({ kind: 'any' }),
  number: (): CodaType => ({ kind: 'number' }),
  string: (): CodaType => ({ kind: 'string' }),
  boolean: (): CodaType => ({ kind: 'boolean' }),
  dataset: (sourceId?: string, datasetId?: string): CodaType => ({
    kind: 'dataset',
    ...(sourceId ? { sourceId } : {}),
    ...(datasetId ? { datasetId } : {}),
  }),
  table: (schema?: TableSchema): CodaType =>
    schema ? { kind: 'table', schema } : { kind: 'table' },
  neurons: (schema?: TableSchema): CodaType =>
    schema ? { kind: 'neurons', schema } : { kind: 'neurons' },
  matrix: (): CodaType => ({ kind: 'matrix' }),
  network: (nodeSchema?: TableSchema, edgeSchema?: TableSchema): CodaType => ({
    kind: 'network',
    ...(nodeSchema ? { nodeSchema } : {}),
    ...(edgeSchema ? { edgeSchema } : {}),
  }),
  skeletons: (schema?: TableSchema): CodaType =>
    schema ? { kind: 'skeletons', schema } : { kind: 'skeletons' },
  meshes: (schema?: TableSchema): CodaType =>
    schema ? { kind: 'meshes', schema } : { kind: 'meshes' },
  points: (schema?: TableSchema): CodaType =>
    schema ? { kind: 'points', schema } : { kind: 'points' },
  layout: (): CodaType => ({ kind: 'layout' }),
  linkage: (): CodaType => ({ kind: 'linkage' }),
} as const

/** Types whose values are tabular, i.e. carry a `TableSchema`. */
export type TabularType = Extract<CodaType, { kind: 'table' | 'neurons' }>

export function isTabular(t: CodaType | undefined): t is TabularType {
  return !!t && (t.kind === 'table' || t.kind === 'neurons')
}

/** Schema of a type, or undefined when the type is not tabular / not yet known. */
export function schemaOf(t: CodaType | undefined): TableSchema | undefined {
  return isTabular(t) ? t.schema : undefined
}

// ---------------------------------------------------------------------------
// Assignability
// ---------------------------------------------------------------------------

/**
 * Subtype relation on kinds only (`neurons` is a `table`).
 * Column schemas are intentionally *not* part of assignability: a node that needs a
 * particular column reports a validation error with a helpful message instead of
 * silently refusing the link, which is far easier to debug while wiring.
 */
export function isAssignable(from: CodaType, to: CodaType): boolean {
  if (from.kind === 'any' || to.kind === 'any') return true
  if (from.kind === to.kind) return true
  if (from.kind === 'neurons' && to.kind === 'table') return true
  // Numbers widen into strings for label/format inputs; nothing else coerces.
  if (from.kind === 'number' && to.kind === 'string') return true
  return false
}

/** Human-readable type name for tooltips and error messages. */
export function typeLabel(t: CodaType | undefined): string {
  if (!t) return 'unknown'
  switch (t.kind) {
    case 'table':
    case 'neurons': {
      const cols = t.schema?.columns
      const head = t.kind === 'neurons' ? 'Neurons' : 'Table'
      if (!cols) return `${head}{?}`
      if (cols.length <= 4) return `${head}{${cols.map((c) => c.name).join(', ')}}`
      return `${head}{${cols
        .slice(0, 3)
        .map((c) => c.name)
        .join(', ')}, +${cols.length - 3}}`
    }
    case 'any':
      return 'Any'
    case 'layout':
      return 'Layout'
    case 'linkage':
      return 'Linkage'
    case 'dataset':
      return t.datasetId ? `Dataset(${t.datasetId})` : 'Dataset'
    default:
      return t.kind.charAt(0).toUpperCase() + t.kind.slice(1)
  }
}

/**
 * Which attribute table a column param should read from.
 *
 * Network values carry two attribute tables, so a colour-by-node-type param and a
 * width-by-edge-weight param on the same node need to name different ones.
 */
export type AttributePart = 'nodes' | 'edges'

/**
 * Schema of the attribute table a column picker should offer, for any type that carries
 * one. This is what lets `colour by [type]` populate on a Network or Skeletons socket
 * exactly as it does on a Table.
 */
export function attributeSchema(
  t: CodaType | undefined,
  part: AttributePart = 'nodes',
): TableSchema | undefined {
  if (!t) return undefined
  switch (t.kind) {
    case 'table':
    case 'neurons':
      return t.schema
    case 'network':
      return part === 'edges' ? t.edgeSchema : t.nodeSchema
    case 'skeletons':
    case 'meshes':
    case 'points':
      return t.schema
    default:
      return undefined
  }
}

/** Narrow a type to a dataset refinement, for nodes that need source metadata. */
export function datasetRef(
  t: CodaType | undefined,
): { sourceId?: string; datasetId?: string } | undefined {
  return t?.kind === 'dataset'
    ? {
        ...(t.sourceId ? { sourceId: t.sourceId } : {}),
        ...(t.datasetId ? { datasetId: t.datasetId } : {}),
      }
    : undefined
}

// ---------------------------------------------------------------------------
// Schema helpers used by node `inferOutputs` implementations
// ---------------------------------------------------------------------------

export function column(name: string, dtype: DType, unit?: string): ColumnSchema {
  return unit ? { name, dtype, unit } : { name, dtype }
}

export function tableSchema(...columns: ColumnSchema[]): TableSchema {
  return { columns }
}

export function findColumn(
  schema: TableSchema | undefined,
  name: string,
): ColumnSchema | undefined {
  return schema?.columns.find((c) => c.name === name)
}

export function columnNames(schema: TableSchema | undefined): string[] {
  return schema?.columns.map((c) => c.name) ?? []
}

/** Columns restricted to a set of dtypes — powers dtype-aware column pickers. */
export function columnsOfType(
  schema: TableSchema | undefined,
  dtypes: DType[],
): ColumnSchema[] {
  return (schema?.columns ?? []).filter((c) => dtypes.includes(c.dtype))
}

export const NUMERIC_DTYPES: DType[] = ['i64', 'f64']

export function isNumericDType(d: DType): boolean {
  return d === 'i64' || d === 'f64'
}

/** Keep only the named columns, in the order given. Unknown names are dropped. */
export function pickColumns(
  schema: TableSchema | undefined,
  names: string[],
): TableSchema | undefined {
  if (!schema) return undefined
  const columns = names
    .map((n) => schema.columns.find((c) => c.name === n))
    .filter((c): c is ColumnSchema => !!c)
  return { columns }
}
