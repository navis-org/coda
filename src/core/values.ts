/**
 * Runtime values that flow along edges.
 *
 * Tables are columnar: one plain JS array per column plus a row count. That keeps
 * group-by/filter loops monomorphic and makes the eventual swap to Apache Arrow a
 * matter of reimplementing the accessors in this file rather than rewriting nodes.
 * Nodes must treat columns as immutable — always build new arrays.
 */

import type { CodaType, PopulationFilter, TableSchema } from './types'
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
  /**
   * Which neurons this dataset means, when it means fewer than all of them.
   *
   * Carried on the value for `annotations`' reason: a source is handed a dataset and has to
   * know, and the alternative is every query node threading an extra argument through the seam.
   * What it is *not* is a filter every consumer applies. `neuronSetRequest` is the one
   * projection that passes it on, and it reaches exactly the queries that answer "which neurons
   * does this dataset have" — never a lookup by id, which would silently drop ids somebody
   * pasted, and never the far end of a `ConnectsTo`, which would under-report synapse weight.
   *
   * Empty or absent means every neuron the backend labels as one, which is what the neuron index
   * always carries: the index is downloaded whole and narrowed on load, so a dataset read two
   * ways shares a single cached table rather than paying for two.
   */
  readonly population?: readonly PopulationFilter[]
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
    // Carried, where `annotations` cannot be: these are checkboxes rather than a fetched table,
    // so a reference reader gets the same neuron set an ordinary wire would deliver.
    ...(ref.population?.length ? { population: ref.population } : {}),
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
 * `data/units.ts` for why that is the common space rather than voxels. This field is
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

/**
 * Which template space coordinates are in — `FLYWIRE`, `JRCFIB2022M`, `MANC`.
 *
 * The fact `units` is not. Two neurons from different datasets can carry identical numbers and
 * be nowhere near each other, so a comparison across spaces is meaningless however honest the
 * units are — which is why NBLAST across datasets used to be recorded as unavailable rather
 * than refused. Named by flybrains' template id rather than by the dataset, because a dataset
 * is not a frame: `JRCFIB2018F` and `JRCFIB2018Fraw` are both "the hemibrain" and are a factor
 * of eight apart.
 *
 * **Absent means unknown**, the third thing `units` also distinguishes. Every dataset with no
 * registration anywhere says nothing here — the optic lobe, FIB-19, the mushroom body, the
 * synthetic connectomes — and so does a Custom node pointing at a deployment this build has
 * never heard of. Unknown is not a refusal; it is the ordinary state, and a consumer that
 * cannot proceed says which space it needed.
 *
 * A plain string rather than a union of the ids `data/transforms/manifest.json` happens to
 * carry today: the manifest is generated, this file is `src/core`, and a type that had to be
 * regenerated alongside a data file would make adding a landmark set a code change.
 */
export type TemplateSpaceId = string

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
  /**
   * What each point is part of, as SWC's structure codes — 1 soma, 2 axon, 3 basal and 4 apical
   * dendrite, 0 for a point the source left unlabelled. The vocabulary every source that labels
   * compartments already speaks: CAVE's skeleton service and every SWC file.
   *
   * **Absent means the source publishes no labels**, which is most of them — neuPrint, CATMAID and
   * level-2 skeletons carry none. Never inferred here: a split computed from synapses is a
   * *result* (`out.topology`), and one written into the geometry would be indistinguishable from
   * one the source measured. Where present it is exactly as long as `radii`.
   */
  readonly compartments?: Uint8Array
}

/**
 * Every array a skeleton holds — the one list, so a field added above is counted by the cache's
 * budget (`skeletonBytes`) and the memory readout (`ByteLedger`) alike, rather than by whichever
 * somebody remembered to edit.
 */
export function skeletonBuffers(s: Omit<SkeletonGeometry, 'id'>): ArrayBufferView[] {
  return s.compartments
    ? [s.positions, s.radii, s.parents, s.compartments]
    : [s.positions, s.radii, s.parents]
}

/**
 * Which of a dataset's skeleton routes a set of skeletons came from.
 *
 * **A skeleton is not one product, and which one you have changes what it can answer.** A
 * neuPrint SWC, a precomputed layer published beside a segmentation, a CAVE skeleton-service
 * reconstruction and a level-2 chunk decomposition are four different things about the same
 * neuron — tens of nodes against tens of thousands, radii or none — and until this existed a
 * scene said only "5 skeletons" about any of them. Cable length is the case that makes it
 * load-bearing rather than cosmetic: the same neuron measures differently down each route, with
 * nothing on screen to say a number came from a chunk graph.
 *
 * Carried on the value rather than derived from the dataset because the route is *chosen* — see
 * the Skeletons node's `source` param — so a graph can hold two sets from one dataset, and the
 * dataset id no longer answers which is which.
 *
 * `id` is the same string the node's param stores and `DataSource.skeletonSourcesFor` offers;
 * see `data/skeletonRoutes.ts` for the list and why they are shared across backends.
 */
export interface SkeletonProvenance {
  id: string
  /** Short name, for a card footer and a viewer caption. */
  label: string
  /** One sentence: what this route is, and what it costs. For a tooltip and the dropdown. */
  detail?: string
}

export interface SkeletonsValue {
  readonly kind: 'skeletons'
  readonly items: SkeletonGeometry[]
  /** One row per item, in the same order. Must contain `neuronId`. */
  readonly attributes: TableValue
  readonly bounds: Bounds3
  readonly units?: GeometryUnits
  readonly space?: TemplateSpaceId
  /** Which route answered. Absent only from a value built by something with no route to name. */
  readonly provenance?: SkeletonProvenance
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
   * The reduction factor a mesh set **achieved**, where one was asked for.
   *
   * Absent means full resolution. It is on the value because a reduction nobody can see is the
   * silent-thinning failure `labels thinned` and `cells merged` both exist to prevent: a mesh at
   * a fifth of its triangles looks like a mesh, and `lod`/`levels` say nothing about it — they
   * describe a level a *publisher* built, and this happened afterwards.
   *
   * Achieved rather than asked for, and that is the half to keep: `Downsample`'s default setting
   * is automatic, which has no asked-for factor at all, and an explicit one is approximate because
   * the grid that hits it is fitted. `achievedDownsample` is the one place that number is
   * computed. It was a `decimated: boolean` when the reduction was automatic and the factor was
   * nobody's decision; the number is what the caption has to name for the control to be findable
   * from the picture.
   */
  downsample?: number
  /**
   * How many of the pieces a source named actually arrived, where a mesh is assembled from many.
   *
   * The same argument as `downsample` above one notch worse, and it rides on the **value** rather
   * on a warning for a reason a warning cannot meet: a geometry cache means the second Run
   * fetches nothing, so a per-fetch sentence goes quiet while the same short mesh is still on
   * screen. A graphene neuron is hundreds of supervoxel fragments and a dropped one is tolerated
   * on purpose — one missing of 471 is a mesh, 449 missing is a picture of somebody's recent
   * edits, and nothing else about the value can tell those apart.
   *
   * Absent means the source does not assemble meshes from pieces, not that none went missing.
   */
  fragments?: { named: number; missing: number }
}

export interface MeshesValue {
  readonly kind: 'meshes'
  readonly items: MeshGeometry[]
  readonly attributes: TableValue
  readonly bounds: Bounds3
  readonly detail?: MeshDetail
  readonly units?: GeometryUnits
  readonly space?: TemplateSpaceId
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
  readonly space?: TemplateSpaceId
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

/**
 * A landmark-based spatial transform, as a value on a wire.
 *
 * **Not a table of six columns**, on `LayoutValue`'s and `LinkageValue`'s exact argument: a
 * transform is not data *about* anything, it is a mapping computed *for* one pair of spaces.
 * As a table it would accept any six numeric columns, need six pickers wherever it was used,
 * and be silently destroyed by a Sort upstream of whatever applied it — and the result of that
 * would be neurons in plausible wrong places rather than an error.
 *
 * The pairs are held in **nanometres on both sides**, converted at whatever edge read them, so
 * everything downstream of here works in one unit. That conversion is exact for a 3-D
 * thin-plate spline, whose kernel is homogeneous of degree one — see `data/transforms`.
 *
 * `id` is **provenance, not content**: whatever produced the landmarks, hashed the way the
 * scheduler hashes everything else (`DatasetAnnotations.key` is the same idea). It keys the
 * fitted-coefficient cache, so it has to change exactly when the landmarks would and no more
 * often — hashing three thousand float64s on every edit would be the alternative, and a
 * provenance key is already lying around.
 */
export interface TransformValue {
  readonly kind: 'transform'
  /** Provenance of whatever produced the landmarks. Keys the fitted-spline cache. */
  readonly id: string
  /** `count * 3` float64, xyz interleaved, nanometres. */
  readonly source: Float64Array
  /** The partner of each source landmark, same layout, same units. */
  readonly target: Float64Array
  readonly count: number
  /** What the card calls it. */
  readonly label?: string
  /**
   * The template space the target side is in, where whoever built this said so.
   *
   * Stamped onto geometry that goes through it, which is what lets everything downstream keep
   * checking — a second Transform, a Mirror looking for the right landmarks, NBLAST comparing
   * two sets. **Absent means unknown rather than unchanged**, the rule `units` established:
   * a custom transform whose author did not say lands geometry in a space nobody can name, and
   * saying so is better than claiming it stayed where it was.
   */
  readonly targetSpace?: string
}

/**
 * Neuroglancer layers, in the order they should be added to a scene.
 *
 * **A layer is opaque JSON here, deliberately.** Neuroglancer's layer schema is large, versioned,
 * and differs between the two viewer flavours (`scene.ts` carries the two it has had to reconcile
 * so far); modelling it would mean tracking somebody else's format and refusing anything it did
 * not recognise. The one thing this app *does* to a layer is written by whoever builds it, and
 * `Record<string, unknown>` is the honest type for the rest — the same treatment `NgScene` gets.
 *
 * It is in `src/core` and names no type from `src/data`, which is why it is spelled out rather
 * than importing `NgScene`'s layer shape: core sits under data, not beside it.
 */
export interface LayersValue {
  readonly kind: 'layers'
  readonly items: ReadonlyArray<Readonly<Record<string, unknown>>>
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
  | TransformValue
  | LayersValue

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
/**
 * Per-buffer boxes, so a scene that grows re-measures only what is new.
 *
 * A `Float32Array` of geometry is immutable by convention here — the transform nodes build a
 * `new Float32Array` rather than writing through their input, which is the same property
 * `geometryCache` depends on to hand back the array it holds rather than a copy. That makes a
 * box a pure function of the buffer's identity.
 *
 * What forced it: `onPartial` re-assembles the whole answer four times a second while a fetch
 * runs, and `boundsOf` was the dominant cost of doing so — a full pass over every vertex of
 * every body that had already arrived, ~12 times over for a 300-body run. Memoised, the first
 * publish measures each body once and every later one unions a handful of boxes.
 *
 * `null` for a buffer with no vertices, which must not fold a zero box into a real one.
 */
const BUFFER_BOUNDS = new WeakMap<Float32Array, Bounds3 | null>()

function boundsOfBuffer(positions: Float32Array): Bounds3 | null {
  if (positions.length === 0) return null
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const v = positions[i + axis]!
      if (v < min[axis]!) min[axis] = v
      if (v > max[axis]!) max[axis] = v
    }
  }
  return Number.isFinite(min[0]) ? { min, max } : null
}

export function boundsOf(buffers: readonly Float32Array[]): Bounds3 {
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const positions of buffers) {
    let box = BUFFER_BOUNDS.get(positions)
    if (box === undefined) {
      box = boundsOfBuffer(positions)
      BUFFER_BOUNDS.set(positions, box)
    }
    if (box === null) continue
    for (let axis = 0; axis < 3; axis++) {
      if (box.min[axis]! < min[axis]!) min[axis] = box.min[axis]!
      if (box.max[axis]! > max[axis]!) max[axis] = box.max[axis]!
    }
  }
  if (!Number.isFinite(min[0])) return EMPTY_BOUNDS
  return { min, max }
}

/**
 * Summed straight-line distance between connected points, in the skeleton's own units.
 *
 * Shared so the mock and the real decoder cannot disagree: geometry is normalised to
 * nanometres (see `data/units.ts`), and a traversal fix applied to one copy would
 * silently make the fixtures stop standing in for the thing they replace.
 */
const CABLE_LENGTH = new WeakMap<SkeletonGeometry, number>()

export function cableLength(skeleton: SkeletonGeometry): number {
  // Memoised on the geometry's identity, for `boundsOf`'s reason and with the same licence: a
  // skeleton is immutable once decoded, and this is one `Math.hypot` per node — the largest
  // single cost of re-assembling a partial answer while a fetch streams.
  const hit = CABLE_LENGTH.get(skeleton)
  if (hit !== undefined) return hit
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
  CABLE_LENGTH.set(skeleton, total)
  return total
}

/**
 * One triangle's area, from three vertex offsets into an xyz-interleaved buffer.
 *
 * Here rather than beside either caller because there are two of them in two layers —
 * `ui/viewers/roiProjection.ts` sums it for a region's surface area, and `nodes/lib` distributes
 * it across a mesh's vertices so `Distance between` can weight them — and `src/nodes` may not import
 * `src/ui`. The same move `quantileSorted` made into `core/stats.ts`, for the same reason: two
 * copies of one formula is what makes a reported surface area and a computed weight disagree
 * with nothing to say which is right.
 *
 * Half the magnitude of the cross product of two edges. Offsets rather than indices, because
 * every caller has already multiplied by three.
 *
 * **`Math.sqrt` of the sum rather than `Math.hypot`**, which is worth a line because the two are
 * not interchangeable in cost: V8 does not inline `hypot`, it being a builtin doing overflow-safe
 * scaling that no caller here needs — measured **13.6 ns a call against 6.2**, agreeing to 4e-16
 * relative on nanometre coordinates. This is called once per triangle, so a thousand neuron
 * meshes is a hundred and forty million of them.
 */
export function triangleArea(positions: Float32Array, a: number, b: number, c: number): number {
  const ux = positions[b]! - positions[a]!
  const uy = positions[b + 1]! - positions[a + 1]!
  const uz = positions[b + 2]! - positions[a + 2]!
  const vx = positions[c]! - positions[a]!
  const vy = positions[c + 1]! - positions[a + 1]!
  const vz = positions[c + 2]! - positions[a + 2]!
  const cx = uy * vz - uz * vy
  const cy = uz * vx - ux * vz
  const cz = ux * vy - uy * vx
  return Math.sqrt(cx * cx + cy * cy + cz * cz) / 2
}

/** Per-item axis-aligned box, six entries each: min xyz then max xyz. */
export type Boxes = Float64Array

/**
 * The volume a closed triangle mesh encloses, **signed by its winding**: positive when the faces'
 * normals point out, negative when the mesh is wound inside-out.
 *
 * The divergence theorem, one tetrahedron per face against the origin. The sign is the useful half
 * for anything reading a face's facing as "leaving" or "entering" — `Points in Volumes` does, and
 * the synthetic region meshes were once wound inward, which read every point inside as outside.
 */
export function signedVolume(positions: Float32Array, indices: Uint32Array): number {
  let sum = 0
  const triangles = Math.floor(indices.length / 3)
  for (let t = 0; t < triangles; t++) {
    const a = indices[t * 3]! * 3
    const b = indices[t * 3 + 1]! * 3
    const c = indices[t * 3 + 2]! * 3
    const ax = positions[a]!
    const ay = positions[a + 1]!
    const az = positions[a + 2]!
    const bx = positions[b]!
    const by = positions[b + 1]!
    const bz = positions[b + 2]!
    const cx = positions[c]!
    const cy = positions[c + 1]!
    const cz = positions[c + 2]!
    sum += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)
  }
  return sum / 6
}

/**
 * Each mesh's own bounding box, which is what makes the whole thing affordable.
 *
 * A dataset's primary set tiles the volume, so a point is in one region and its box is in two
 * or three. Without the prefilter every point costs a ray per region — sixty-three on
 * hemibrain, a hundred and forty-four on male-CNS — and every one of them misses.
 *
 * `boundsOf` rather than a sweep of our own, which is not merely the same twenty lines: it
 * **memoises each buffer's box** in a `WeakMap`, and every `MeshesValue` on the wire was
 * constructed by calling it (`iterables.ts`, `transformOps.ts`, every source), so in the
 * ordinary case the answer is already computed and this is a lookup. Written out here it was a
 * second full pass over every vertex of every volume — ~4.3 ms per million vertices, and 100%
 * of a second Run's cost, since the trees the `WeakMap` below holds are free by then.
 *
 * `Float64Array` rather than `Float32Array`: a box grown from float32 vertex coordinates and
 * then rounded *down* at the maximum would exclude the vertex it was built from, and the points
 * this is asked about sit on the same grid as those vertices. `Bounds3` holds plain doubles
 * widened from the same float32 reads, so nothing is lost on the way through.
 *
 * **Here rather than in `meshInside.ts`, where it began**, for the reason its own paragraphs give:
 * everything above is about *buffers*, not about surfaces, and it is a memo-reader over
 * `boundsOf` two lines up. It moved when `Distance between` became a second caller wanting the
 * same array for a different question — whether two neurons come near each other at all — which
 * a skeleton answers as readily as a mesh. `triangleArea` made the same move for a weaker
 * version of the same argument. `meshInside.ts` keeps `volumeBoxes`, which is about its
 * prefilter.
 *
 * Not `MeshBVH.getBoundingBox()`, for three reasons: it allocates a `Box3` per call, it needs
 * the tree — which is exactly what the prefilter runs *before* — and `computeBoundsUtils.js`
 * pads triangle bounds by `FLOAT32_EPSILON`, so the root box is conservatively larger and would
 * hand back strictly more ray candidates.
 */
export function boxesOf(items: readonly { positions: Float32Array }[]): Boxes {
  const boxes = new Float64Array(items.length * 6)
  items.forEach((item, i) => {
    if (item.positions.length === 0) {
      /*
       * An inverted box, which no point is in. `boundsOf` answers `EMPTY_BOUNDS` — a zero box at
       * the origin — for a buffer with no vertices, and taken literally that would make an empty
       * volume claim the one point at (0, 0, 0). It is the right answer for a *scene's* extent
       * and the wrong one for a containment prefilter.
       */
      boxes.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], i * 6)
      return
    }
    const box = boundsOf([item.positions])
    boxes.set([...box.min, ...box.max], i * 6)
  })
  return boxes
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

export function isTransformValue(v: Value | undefined): v is TransformValue {
  return !!v && v.kind === 'transform'
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

/**
 * How a geometry value's template space reads in a footer.
 *
 * Printed always, on `unitsLabel`'s rule and for `unitsLabel`'s reason. The **id**, not a
 * friendly name: the id is what has to match for two sets to be comparable, it is what navis
 * and flybrains call the same frame, and a footer reading "Hemibrain" could not tell
 * `JRCFIB2018F` from `JRCFIB2018Fraw`. The prose label lives on the space's manifest entry,
 * for dropdowns and messages, which are the surfaces with room for it.
 */
export function spaceLabel(space: TemplateSpaceId | undefined): string {
  return space ?? 'space unknown'
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
        `${skeletonPointCount(v).toLocaleString()} pts · ` +
        // Where they came from, which is the one thing about a skeleton set that a count cannot
        // imply — see `SkeletonProvenance`. Ahead of the space and the units because those two
        // are the same for every route a dataset has, and this is not.
        `${v.provenance ? `${v.provenance.label} · ` : ''}` +
        `${spaceLabel(v.space)} · ${unitsLabel(v.units)}`
      )
    case 'meshes':
      return (
        `${v.items.length} mesh${v.items.length === 1 ? '' : 'es'} · ` +
        `${meshTriangleCount(v).toLocaleString()} tris · ` +
        `${spaceLabel(v.space)} · ${unitsLabel(v.units)}`
      )
    case 'points':
      return (
        `${v.attributes.length.toLocaleString()} points · ` +
        `${spaceLabel(v.space)} · ${unitsLabel(v.units)}`
      )
    case 'layout': {
      const count = Object.keys(v.positions).length
      return `${count.toLocaleString()} placed${v.algorithm ? ` · ${v.algorithm}` : ''}`
    }
    case 'transform':
      return `${v.count.toLocaleString()} landmarks${v.targetSpace ? ` → ${v.targetSpace}` : ''}`
    case 'layers':
      return `${v.items.length} layer${v.items.length === 1 ? '' : 's'}`
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
