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

/**
 * One way of saying "a neuron somebody knows something about", and they are **OR-ed**.
 *
 * The counter-intuitive half, and the reason it is a list rather than three booleans on the
 * value: ticking a second one lets *more* rows through, not fewer. `traced` and `typed` together
 * mean proofread **or** named, which is the union somebody auditing a dataset for real neurons
 * is asking for — where ANDing them would answer "proofread and named", a set neither box says.
 * Every reader has to apply them the same way, so the list travels and each consumer joins it.
 *
 * Deliberately a vocabulary rather than column names. Which column answers `typed` is a fact
 * about the dataset in hand — hemibrain has `type`, male-CNS also has `flywireType` — so the
 * *intent* crosses the seam and each end resolves it against the schema it holds. Column names
 * on the value would mean the Explore card and the Cypher compiler could disagree about what a
 * type column is, which is a different set of neurons with nothing to say so. `typeColumns` and
 * `SUPERCLASS_COLUMN` in `data/neuronFilter.ts` are the one resolution.
 */
export type PopulationFilter = 'traced' | 'typed' | 'superclass'

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
  | {
      kind: 'dataset'
      sourceId?: string
      datasetId?: string
      /** Columns a wired annotation chain publishes, replacing the dataset's own labels. */
      annotations?: TableSchema
      /**
       * Whether a user-supplied edge set answers this dataset's connectivity.
       *
       * On the *type* and not only on the value because it is an edit-time fact: it decides
       * whether the Paths node is offered at all. CAVE has no server-side hop aggregation and
       * declares `paths: false`, but a local edge set can answer one — so an attached set
       * unlocks a node that otherwise refuses outright, and a refusal has to be right before
       * anything runs.
       */
      edges?: true
      /**
       * Which neurons this dataset means, when it means fewer than all of them. OR-ed.
       *
       * On the *type* as well as the value for `edges`' reason and one more. Three surfaces read
       * it before anything runs: the Explore card, which loads its index independently of any
       * Run; both export emitters, which have only the graph; and the dataset node's own
       * `validate`. Absent means every neuron the backend labels as one — for neuPrint that is
       * every `:Neuron`, which on hemibrain is 186,061 rather than the annotated subset.
       */
      population?: readonly PopulationFilter[]
    }
  /** Columnar table. */
  | { kind: 'table'; schema?: TableSchema }
  /** A table guaranteed to have a `neuronId` column. Subtype of `table`. */
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
  /**
   * A landmark-based spatial transform.
   *
   * Its own kind for `layout`'s and `linkage`'s reason: it is a mapping computed *for* one pair
   * of spaces rather than data about neurons. As a table of six columns it would take any six
   * numeric ones and be destroyed by an upstream Sort, which downstream is neurons in the wrong
   * place rather than an error. See `TransformValue`.
   */
  | { kind: 'transform' }
  /**
   * Neuroglancer layers, ready to be added to a scene.
   *
   * Its own kind for `layout`'s reason: it is not data about neurons, it is a *presentation* of
   * somebody else's data expressed in another tool's vocabulary. As a table it would take any
   * columns at all; as a Dataset it would be accepted by every query node in the app, none of
   * which could do anything with it.
   *
   * Carries no schema, because a layer is opaque JSON — see `LayersValue`.
   */
  | { kind: 'layers' }

export type TypeKind = CodaType['kind']

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export const T = {
  any: (): CodaType => ({ kind: 'any' }),
  number: (): CodaType => ({ kind: 'number' }),
  string: (): CodaType => ({ kind: 'string' }),
  boolean: (): CodaType => ({ kind: 'boolean' }),
  /**
   * A dataset handle.
   *
   * `annotations` is the schema a wired annotation chain publishes, and it is on the *type*
   * rather than only on the value because it decides what every column picker downstream
   * offers — which is an edit-time question. Absent means the dataset's own labels.
   */
  dataset: (
    sourceId?: string,
    datasetId?: string,
    annotations?: TableSchema,
    edges?: boolean,
    population?: readonly PopulationFilter[],
  ): CodaType => ({
    kind: 'dataset',
    ...(sourceId ? { sourceId } : {}),
    ...(datasetId ? { datasetId } : {}),
    ...(annotations ? { annotations } : {}),
    ...(edges ? { edges: true as const } : {}),
    // Empty is absent, not an empty list: a type is compared by identity in places, and "no
    // filters" and "a list of none" are the same dataset said two ways.
    ...(population?.length ? { population } : {}),
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
  transform: (): CodaType => ({ kind: 'transform' }),
  layers: (): CodaType => ({ kind: 'layers' }),
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
    case 'layers':
      return 'Layers'
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
):
  | { sourceId?: string; datasetId?: string; population?: readonly PopulationFilter[] }
  | undefined {
  return t?.kind === 'dataset'
    ? {
        ...(t.sourceId ? { sourceId: t.sourceId } : {}),
        ...(t.datasetId ? { datasetId: t.datasetId } : {}),
        // Unlike `annotations`, which needs a table somebody's Run paid for, this is decided
        // entirely by checkboxes — so a reader holding only the type knows it, and
        // `datasetIdentity` can hand a `reference` port the same answer an ordinary wire gets.
        ...(t.population?.length ? { population: t.population } : {}),
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

/**
 * `name`, or the first free `name_n`, marking it taken.
 *
 * The one statement of Coda's collision rule — the newcomer wins the name and the incumbent is
 * suffixed rather than overwritten — which `joinedColumns`, the wide pivot, `renamedColumns`,
 * `combineLayout`, the CSV header and both annotation providers all make.
 *
 * It sits in `src/core` for `ID_COLUMN_NAME`'s reason: this is the only layer every consumer
 * reaches. It had been written by hand in `nodes/lib/tableOps.ts` and again in `data/csv.ts`,
 * and `src/data` may not import `src/nodes` (invariant 1), so the annotation providers were
 * about to make it three. The two copies had already parted company on the case that matters:
 * counting occurrences, as the CSV one did, turns `a, a, a_2` into `a, a_2, a_2` — a collision
 * produced by the very function that exists to prevent one. Probing for the first *free* name
 * cannot do that.
 */
export function uniqueName(taken: Set<string>, name: string): string {
  let out = name
  for (let n = 2; taken.has(out); n++) out = `${name}_${n}`
  taken.add(out)
  return out
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
