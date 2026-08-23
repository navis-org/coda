/**
 * Runtime values that flow along edges.
 *
 * Tables are columnar: one plain JS array per column plus a row count. That keeps
 * group-by/filter loops monomorphic and makes the eventual swap to Apache Arrow a
 * matter of reimplementing the accessors in this file rather than rewriting nodes.
 * Nodes must treat columns as immutable — always build new arrays.
 */

import type { CodaType, TableSchema } from './types'
import { datasetRef } from './types'

export type CellValue = number | string | boolean | null
export type ColumnData = CellValue[]

export interface TableValue {
  readonly kind: 'table' | 'neurons'
  readonly schema: TableSchema
  /** Column name -> column array. Every array has exactly `length` entries. */
  readonly data: Readonly<Record<string, ColumnData>>
  readonly length: number
}

/**
 * What a matrix's numbers *are*, where that changes what may be done with them.
 *
 * Distinct from `valueLabel`, which is prose for an axis. This is the machine-readable half,
 * and it exists because clustering needs **distances** where NBLAST produces similarities — so
 * somebody has to know to invert, and putting that knowledge in the consumer makes it a
 * special case per producer.
 *
 * **Optional, and absent means unknown.** A consumer asks and carries on when nobody said:
 * Pivot genuinely cannot answer, since its cells are whatever aggregation was picked. Refusing
 * on an absent one would refuse on a fact nobody stated — the distinction `columnSchemaFor`
 * draws between a schema that is missing and one that is empty.
 */
export type MatrixMeasure = 'similarity' | 'distance' | 'count'

export interface MatrixValue {
  readonly kind: 'matrix'
  readonly rowLabels: string[]
  readonly colLabels: string[]
  /** Row-major, `rowLabels.length * colLabels.length` entries. */
  readonly values: Float64Array
  /** What the cells mean, for viewer axis/legend labels. */
  readonly valueLabel?: string
  readonly measure?: MatrixMeasure
}

export interface DatasetValue {
  readonly kind: 'dataset'
  /** Id of the registered DataSource this dataset lives in. */
  readonly sourceId: string
  readonly datasetId: string
  readonly label: string
  /**
   * Annotations *replacing* the dataset's own, when a source is wired to it.
   *
   * Absent means the dataset uses whatever labels its backend publishes — which for neuPrint is
   * properties on the neuron and for CAVE is the table its spec names. Present, this is the
   * neuron table's label half instead, and the backend contributes only identity.
   *
   * Carried on the value rather than resolved from the graph because a source has no view of the
   * graph: `findNeurons` is handed a dataset and has to know, and the alternative is every query
   * node threading an extra argument through the seam.
   */
  readonly annotations?: DatasetAnnotations
  /**
   * A user-supplied edge set answering every connectivity question for this dataset.
   *
   * Present, it is **authoritative**: `fetchConnectivity`, `fetchAdjacency` and `fetchPathStep`
   * are all answered from it, so Connectivity, Adjacency, Paths and Profile change together.
   * That is deliberate rather than a simplification — connectivity answered from two places at
   * once, with nothing on the card saying which node used which, is a graph nobody can read.
   *
   * Only the identity travels: the edges themselves are in `data/edges/store.ts` and never in
   * the `.coda.json`, the same trade `core.uploadTable` makes. What differs is what a missing
   * one means. An upload that is not here blocks the node that names it; this one is a claim
   * about the *whole dataset*, so a run refuses rather than quietly asking the backend — which
   * would answer a different question under a green node.
   */
  readonly edges?: DatasetEdges
}

/**
 * An attached edge set, by identity.
 *
 * `id` is a hash of the encoded content, so a colleague who imports the same file gets the same
 * id and a shared graph resolves. `name` rides along only so a refusal can name the thing the
 * reader is looking for rather than a hash.
 */
export interface DatasetEdges {
  readonly id: string
  readonly name: string
}

/**
 * A neuron annotation table, and one string identifying it.
 *
 * **Not a `Value`**, deliberately: annotations travel between nodes as an ordinary neuron table,
 * so a Filter or a Sort can sit in the chain. What a wire cannot carry is *which* table this is,
 * and something has to — the neuron index built from it, the Explore widget's shared entry and
 * the profile cache are all keyed by it, and two datasets differing only in their annotations
 * sharing one cached table means the first one fetched wins for the session.
 *
 * So the dataset node pairs the table with `ctx.inputKey('annotations')`, which is the
 * scheduler's own provenance for whatever arrived on that port — `hash(type, params, upstream)`,
 * so it changes exactly when the table would and is a fact about the *pipeline* rather than
 * about the rows. It used to be the annotation refs, which could only describe a chain nothing
 * was allowed to edit.
 */
export interface DatasetAnnotations {
  /** Provenance of whatever produced the table. Empty is a distinct key from any pipeline's. */
  readonly key: string
  /** `neuronId` plus the chain's columns, one row per neuron. */
  readonly table: TableValue
}

/**
 * The identity half of a dataset, as a value — what a `reference` port is handed.
 *
 * Here rather than in the scheduler, which is where it started: this is the projection from a
 * dataset *type* to a dataset *value*, and both halves of that pairing live in this file and
 * `types.ts`. Two layers away it was a `DatasetValue` nobody reading `DatasetValue` would find,
 * and the day this interface gains a field the person adding it looks here.
 *
 * **Deliberately partial, in two ways worth knowing.** There are no `annotations` — a reference
 * reader is usually the node about to supply them. And `label` is the dataset id rather than the
 * human name a run would carry (`"MaleCNS v0.9"`), because a type does not know it; a node fed by
 * a reference therefore sees a plainer label than the same node fed by an ordinary wire.
 *
 * `undefined` when the type is not a dataset or has not resolved an id yet, which is the ordinary
 * state on a fresh session and not an error.
 */
export function datasetIdentity(type: CodaType | undefined): DatasetValue | undefined {
  const ref = datasetRef(type)
  if (!ref?.sourceId || !ref.datasetId) return undefined
  return {
    kind: 'dataset',
    sourceId: ref.sourceId,
    datasetId: ref.datasetId,
    label: ref.datasetId,
  }
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

/**
 * What a geometry value's coordinates are in.
 *
 * Everything drawn in one scene is nanometres, converted at the source seam — see
 * `data/neuprint/units.ts` for why that is the common space rather than voxels. This field is
 * that invariant made checkable: it travels with the value, so a consumer whose answer depends
 * on physical scale can ask instead of assuming.
 *
 * **`voxels` is a real answer, not a failure.** neuPrint returns skeleton and synapse
 * coordinates in dataset voxels, and the conversion needs `Meta.voxelSize` plus a unit string
 * the table recognises. Where either is missing the numbers are still voxels — we simply do
 * not know how big one is — and saying so is the difference between a comparison that refuses
 * and one that quietly scores a brain eight times too small.
 *
 * **Absent means unknown**, which no source produces today. It is what a value built before
 * this field existed says, and what a future source that cannot tell should say.
 */
export type GeometryUnits = 'nm' | 'voxels'

/** One neuron's branching morphology, SWC-style, in parallel typed arrays. */
export interface SkeletonGeometry {
  /**
   * What this item is keyed by and called — a `NeuronId` for a neuron, text either way.
   *
   * Text because that is what invariant 8 requires of anything an id is *compared* by, and
   * several consumers do compare these: `viewer3d`'s selection through `rowsWithIds`, the SWC
   * and OBJ filenames in `exportValue.ts`, and NBLAST's match table. Held as a number this was
   * a rounded copy of the attribute table's exact id on any source whose ids do not fit in a
   * double — benign on neuPrint and the mock, and a silently empty selection on CAVE.
   *
   * Note it is still a *draw and export key*, not the identity: identity lives in the attribute
   * table's row, which is the one that can carry a type, a status and everything else. The two
   * are index-aligned, so a consumer that wants the exact published value should read the
   * column rather than re-deriving it from here.
   */
  readonly id: string
  /** Point coordinates, xyz interleaved: `positions[i * 3 + 0..2]`. */
  readonly positions: Float32Array
  readonly radii: Float32Array
  /** Parent index per point; -1 for a root. Defines the tree. */
  readonly parents: Int32Array
}

export interface SkeletonsValue {
  readonly kind: 'skeletons'
  readonly items: SkeletonGeometry[]
  /** One row per item, in the same order. Must contain `neuronId`. */
  readonly attributes: TableValue
  readonly bounds: Bounds3
  readonly units?: GeometryUnits
}

export interface MeshGeometry {
  /**
   * What this item is keyed by and called: a `NeuronId` for a neuron, `ME(R)` for a region.
   *
   * One field rather than the `neuronId: number` plus optional `label: string` this used to be,
   * and the merge is what widening to text bought. Every mesh here was a neuron until region
   * meshes arrived, and a region has no neuron id — so `neuronId` was set to `0` for all of them
   * while `label` carried the real one, and every consumer without exception wrote
   * `label ?? String(neuronId)`. A distinction erased at every use site is not one.
   *
   * See `SkeletonGeometry.id` for why it is text, and for the identity-versus-key line.
   */
  readonly id: string
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
  /**
   * Simplified on arrival rather than fetched at a published level.
   *
   * A source with no levels of detail can still hit a triangle budget, by decimating what it
   * was given — which is what CAVE does, because a graphene manifest lists supervoxel fragments
   * at full resolution and there is nothing coarser to ask for. `lod`/`levels` describe nothing
   * in that case, so the caption needs this to say what actually happened: the alternative is a
   * viewer reporting "level 0 of 0" while 98% of the triangles have been merged away, which is
   * the silent-thinning failure `labels thinned` and `cells merged` both exist to prevent.
   */
  decimated?: boolean
}

export interface MeshesValue {
  readonly kind: 'meshes'
  readonly items: MeshGeometry[]
  readonly attributes: TableValue
  readonly bounds: Bounds3
  readonly detail?: MeshDetail
  readonly units?: GeometryUnits
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
  readonly units?: GeometryUnits
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

/**
 * A hierarchical clustering of the things some matrix was over.
 *
 * **Not a table of `[a, b, height, size]`**, and that is the same call `LayoutValue` makes: a
 * linkage is not data about neurons, it is a tree computed *for* one particular set of them.
 * As a table it would accept any four numeric columns, need four column pickers to configure,
 * and be silently destroyed by a Sort or a Filter upstream of whatever drew it — none of which
 * a reader would connect to the wrong picture they got.
 *
 * `merges` is SciPy's `Z` ravelled: one merge per four entries, `[a, b, height, size]`, where
 * `a` and `b` are observation indices below `labels.length` and cluster indices above it — the
 * cluster formed at step `i` is numbered `labels.length + i`. That layout is not ours to
 * invent; it is what `scipy.cluster.hierarchy`, R's `hclust` and navis-fastcore all speak, and
 * keeping it means the notebook export is a translation rather than a reimplementation.
 *
 * **Merges are in ascending height order**, which the five methods Coda offers all guarantee.
 * That is not true of hierarchical clustering in general — see `LINKAGE_METHODS` for the two
 * methods left out and the measurement behind it.
 */
export interface LinkageValue {
  readonly kind: 'linkage'
  /** Row-major `(labels.length - 1) x 4`: `[a, b, height, size]` per merge. */
  readonly merges: Float64Array
  /** One per observation, in observation order. Index `i` names observation `i`. */
  readonly labels: string[]
  /**
   * The observations left to right, so a dendrogram draws without crossing itself. A
   * permutation of `0..n-1`, so `order.map(i => labels[i])` is the drawing order.
   */
  readonly order: Int32Array
  /**
   * A cluster number per observation, 1-based, or absent where nothing has cut the tree.
   *
   * Optional, and absent means *not cut* rather than *one cluster* — the same distinction
   * `MatrixValue.measure` draws. `cluster.cut` is what sets it, which is what lets a
   * Dendrogram downstream of a Cut colour its branches with no second input and no picker.
   */
  readonly clusters?: Int32Array
  /** Which linkage method built it, for a caption. */
  readonly method?: string
  /** What a height means, e.g. `1 - NBLAST score`. For the axis, and for honesty. */
  readonly distanceLabel?: string
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
  | LinkageValue

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
  measure?: MatrixMeasure,
): MatrixValue {
  const expected = rowLabels.length * colLabels.length
  if (values.length !== expected) {
    throw new Error(`makeMatrix: expected ${expected} values, got ${values.length}`)
  }
  return {
    kind: 'matrix',
    rowLabels,
    colLabels,
    values,
    ...(valueLabel ? { valueLabel } : {}),
    ...(measure ? { measure } : {}),
  }
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

export function isLinkageValue(v: Value | undefined): v is LinkageValue {
  return !!v && v.kind === 'linkage'
}

/** How many merges. `merges` is four numbers each, so this is not its length. */
export function linkageMergeCount(v: LinkageValue): number {
  return v.merges.length / 4
}

/**
 * A tree, checked against itself.
 *
 * The one place the three arrays are compared, for the reason `makeMatrix` exists: `merges`,
 * `labels` and `order` are built by three different pieces of code — Python, the node, and
 * fastcore — and a drift between them reaches the viewer as a tree drawn over the wrong names
 * rather than as an error.
 */
export function makeLinkage(
  merges: Float64Array,
  labels: string[],
  order: Int32Array,
  extra: { clusters?: Int32Array; method?: string; distanceLabel?: string } = {},
): LinkageValue {
  const expected = Math.max(0, labels.length - 1) * 4
  if (merges.length !== expected) {
    throw new Error(
      `makeLinkage: ${labels.length} labels needs ${expected / 4} merges, got ${merges.length / 4}`,
    )
  }
  if (order.length !== labels.length) {
    throw new Error(
      `makeLinkage: ${labels.length} labels but ${order.length} in the leaf order`,
    )
  }
  if (extra.clusters && extra.clusters.length !== labels.length) {
    throw new Error(
      `makeLinkage: ${labels.length} labels but ${extra.clusters.length} cluster assignments`,
    )
  }
  return {
    kind: 'linkage',
    merges,
    labels,
    order,
    ...(extra.clusters ? { clusters: extra.clusters } : {}),
    ...(extra.method ? { method: extra.method } : {}),
    ...(extra.distanceLabel ? { distanceLabel: extra.distanceLabel } : {}),
  }
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

/**
 * How a geometry value's units read in a footer.
 *
 * Printed even when they are the expected nanometres, deliberately. A line that appears only
 * when something is wrong is a line nobody learns to look at — the same reasoning that keeps
 * the matched half of `unmatchedLabels` on screen — and here the whole point is that the
 * reader can tell `nm` from `voxels` at a glance on the node that fetched them.
 */
export function unitsLabel(units: GeometryUnits | undefined): string {
  return units ?? 'units unknown'
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
      return (
        `${v.items.length} skeleton${v.items.length === 1 ? '' : 's'} · ` +
        `${skeletonPointCount(v).toLocaleString()} pts · ${unitsLabel(v.units)}`
      )
    case 'meshes':
      return (
        `${v.items.length} mesh${v.items.length === 1 ? '' : 'es'} · ` +
        `${meshTriangleCount(v).toLocaleString()} tris · ${unitsLabel(v.units)}`
      )
    case 'points':
      return `${v.attributes.length.toLocaleString()} points · ${unitsLabel(v.units)}`
    case 'layout': {
      const count = Object.keys(v.positions).length
      return `${count.toLocaleString()} placed${v.algorithm ? ` · ${v.algorithm}` : ''}`
    }
    case 'linkage': {
      const cut = v.clusters ? ` · ${new Set(v.clusters).size} clusters` : ''
      return `${v.labels.length} leaves${v.method ? ` · ${v.method}` : ''}${cut}`
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

/**
 * What `join` puts between values, and what anything reading the result splits on.
 *
 * One constant because it is a *contract* rather than a formatting choice: a community-tag table
 * folded into one cell here is split back into chips by the Explore widget, and two spellings of
 * the separator would be a row of tags nobody could read.
 *
 * `'; '` rather than a control character, because the cell is read by people too — it lands in a
 * Table node, in a CSV and in a notebook. The cost is stated rather than engineered away: a value
 * that itself contains `'; '` splits into two on the way back out. That is cosmetic, the whole
 * cell is one hover away, and the alternative is a column of invisible bytes.
 *
 * **It lives in `src/core` because a *source* now produces one.** It began in `tableOps.ts`
 * beside the Group By aggregation that writes it, which was right while a node was the only
 * thing that could — and `CatmaidSource` folds a neuron's remaining annotations into one cell
 * exactly as that aggregation folds community tags, so it needs the separator the Explore widget
 * will split on. `src/data` may not import `src/nodes` (invariant 1), so the agreement had to
 * move to the layer every consumer reaches. Same reasoning and same destination as
 * `ID_COLUMN_NAME`, and deliberately no re-export from where it was: a shim is how a symbol
 * acquires a second spelling and then a third.
 */
export const JOIN_SEPARATOR = '; '
