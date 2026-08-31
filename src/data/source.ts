/**
 * DataSource: the seam between nodes and whatever holds the connectome.
 *
 * Nodes never talk to neuPrint (or CAVE, or a file) directly — they take a DatasetValue,
 * resolve it to a DataSource, and call these methods. Adding a backend means implementing
 * this interface, not touching node code.
 *
 * Two design points worth defending:
 *
 * 1. `schemas` is static and synchronous. Column schemas must be known at *edit* time so
 *    the type system can propagate them and column pickers can populate before anything
 *    runs. A source that only learns its columns after a query cannot participate in
 *    schema inference, which is most of what makes the editor pleasant.
 *
 * 2. `peekDataset` is a synchronous cache read that may return undefined. It's how
 *    edit-time code (ROI enums, dataset labels) gets dataset metadata without an await.
 *    Honest about the fact that the answer may not have arrived yet.
 */

import type { PopulationFilter, TableSchema } from '../core/types'
import { column, tableSchema } from '../core/types'
import type {
  DatasetAnnotations,
  DatasetEdges,
  MatrixValue,
  MeshesValue,
  PointsValue,
  SkeletonGeometry,
  SkeletonProvenance,
  SkeletonsValue,
  TableValue,
} from '../core/values'
import type { SkeletonRouteId } from './skeletonRoutes'
import type { NgScene } from './neuroglancer/scene'
import type { NeuronIndexRequest } from './neuronIndex'
import type { FilterRow } from './filterRows'

export type { NeuronIndexRequest } from './neuronIndex'

import type { NeuronId } from '../core/ids'
import { ID_COLUMN_NAME } from '../core/ids'

export interface DatasetInfo {
  id: string
  label: string
  description?: string
  species?: string
  /**
   * Which neuroglancer deployment this dataset is meant to be opened in.
   *
   * A fact about the *dataset*, not a preference: CAVE's segmentation is behind its auth and
   * only a spelunker-flavoured viewer authenticates through `graphene://middleauth+…`, so the
   * built-in default renders such a scene with no segmentation and nothing saying why. Absent
   * where the source has no opinion, which is every neuPrint dataset — those states open
   * anywhere.
   */
  viewerSite?: string
  /** ROI names available for per-ROI queries, in a sensible display order. */
  rois: string[]
  /**
   * The non-overlapping subset of `rois`, when the source knows it.
   *
   * Per-ROI synapse counts nest — a synapse in `LO(R)` is also counted in its parent `OL(R)`
   * — so anything that *sums* ROI counts has to restrict itself to a set that tiles the
   * volume, or it silently double counts and reports totals larger than the neuron has
   * synapses. Undefined means "not known yet", which is a different answer from "empty" and
   * callers are expected to say so rather than sum anyway.
   */
  primaryRois?: string[]
  /**
   * Which group each primary region sits in, where the source publishes a hierarchy.
   *
   * The level *above* the primary set — `EB`, `FB`, `NO` and `PB` are all `CX` — which is what
   * lets a map of a hundred and forty-four regions be read a system at a time instead of hunted
   * across. Keyed by region rather than listed by group because both surfaces need it that way:
   * a filter asks "what is this one in", and the group list is the unique values.
   *
   * A region absent from this has no group, which is a real answer: hemibrain lists `AL(L)` and
   * `GNG` directly under the dataset root. Undefined altogether means the source published no
   * hierarchy, and the control that would filter by it is simply not offered.
   */
  roiSuper?: Record<string, string>
  /** Neuron statuses present in this dataset, for status filters. */
  statuses: string[]
  neuronCount?: number
  /** e.g. "v1.2.1" — surfaced so results are attributable to a dataset version. */
  version?: string
}

export type ConnectionDirection = 'outputs' | 'inputs'

/**
 * Accept only neurons whose `field` carries one of `values`.
 *
 * Separate from `typePattern`/`instancePattern` rather than folded into them, for two reasons
 * that pull the same way. It names the **property**, so it reaches whatever schema discovery
 * found — `class`, `hemilineage`, `superclass` — where those two are hardcoded to the only two
 * fields anyone had needed. And in its default (literal) form it compiles to an `IN` list,
 * which neuPrint has indexed; the equivalent regex alternation expresses the same set and
 * forces a scan of every `:Neuron` in the dataset.
 *
 * An empty `values` matches **nothing**, not everything. This is the opposite of the pattern
 * fields above and is deliberate: a pattern is a filter that narrows a population, so empty
 * means "do not narrow", while this is a lookup of a named set, so empty means there is
 * nothing to look up. A source implementing this must not silently return the whole dataset.
 */
export interface LabelMatch {
  /** Neuron property to test. Any column of the dataset's neuron schema. */
  field: string
  /** Labels to accept. Empty matches nothing. */
  values: readonly string[]
  /**
   * Treat each value as a regex rather than as a literal.
   *
   * Literal is the default because a label is text somebody copied out of a result — `SMP001(a)`
   * and `5-HT` carry regex metacharacters, and reading those as syntax turns a lookup into a
   * different question with no error to say so. Under `regex`, each value is matched with the
   * same anchored, whole-string semantics `typePattern` has, so the two agree.
   */
  regex?: boolean
  ignoreCase?: boolean
}

export interface FindNeuronsRequest {
  datasetId: string
  /**
   * Labels *replacing* the dataset's own, when a source is wired to the Dataset node.
   *
   * A source that has its own annotation (neuPrint's are properties on the neuron) ignores this;
   * one that reads them from a table uses it instead of the table its spec names. Threaded here
   * rather than resolved from the dataset id, because a source has no view of the graph and the
   * chain is a fact about the wiring rather than about the dataset.
   */
  annotations?: DatasetAnnotations
  /**
   * The query itself: a list of `{field, operator, value}` rows, ANDed.
   *
   * Replaces `typePattern`, `instancePattern`, `statuses` and `minSize`, which were neuPrint's
   * own fields spelled as an interface. Every other backend paid for that: a **Min size** box on
   * a card whose datastack publishes no size, a `status` default of `Traced` filtering on a
   * column CAVE does not have, an **In ROI** dropdown of eighty real neuropils that narrowed
   * nothing. All three answered with a wrong count rather than an error.
   *
   * A row names a field of the dataset's **own** neuron schema, so what can be asked is what the
   * backend publishes — see `filterRows.ts` for the model and for the two lowerings every source
   * is expected to use rather than reimplement.
   *
   * Empty or absent means no narrowing at all, which is a real answer and a costly one: it is an
   * unbounded `MATCH (n:Neuron)`. The node above decides whether to warn about that; a source
   * honours it.
   */
  rows?: readonly FilterRow[]
  /** Exact (or regex) match of one property against a set of labels. */
  labels?: LabelMatch
  /**
   * Exactly these neurons, by id.
   *
   * Not expressible through `labels`, which compiles to a list of *string* literals — against
   * an integer property that matches nothing, silently. An empty array present means **no
   * neurons**, never "no filter": an unconfigured node firing an unbounded `MATCH (n:Neuron)`
   * at a shared production Neo4j is a hazard, not a default.
   */
  neuronIds?: readonly NeuronId[]
  /**
   * ROI the neuron must innervate.
   *
   * **Not a row, and it cannot be one.** In neuPrint a region is not a column: a neuron carries
   * one boolean property per ROI it innervates, so the test is `n.\`LO(R)\` IS NOT NULL` and the
   * name appears in no neuron schema. A field list driven by the schema therefore cannot offer
   * it, which is why this stays a named axis of its own — gated, on the card, by whether the
   * source can actually answer it rather than by whether `DatasetInfo.rois` is non-empty. Those
   * two came apart on CATMAID, whose volume list fills the picker while `findNeurons` could not
   * read it.
   */
  roi?: string
  /**
   * Which neurons the dataset means — the checkboxes on the dataset node, **OR-ed**.
   *
   * **Not rows, and the reason is only partly `roi`'s.** A region cannot be a row because it is
   * not a column; these could all be spelled as rows by whoever builds the request. Two things
   * stop them. The question is asked at the *dataset* rather than at the query — a few
   * checkboxes standing for every query below them — and lowering them to rows at each of those
   * call sites is the same clause written several times, which is how two of them come to
   * disagree. And `rows` are **ANDed**, where these are ORed among themselves: `traced` plus
   * `typed` means proofread *or* named, which no list of ANDed rows can say.
   *
   * A filter naming a column the dataset does not publish is dropped rather than compiled — see
   * `resolvePopulation`. That errs towards too many rows rather than none, which is the
   * direction somebody can see, and the dataset node warns about it at edit time.
   *
   * An explicit `status` row **removes the `traced` disjunct** — see `findNeuronsCypher`. The row
   * is the more specific statement of the two, and a dataset-level default that could contradict
   * it into zero rows is the failure that got the old `Traced` default removed from this
   * interface in the first place.
   */
  population?: readonly PopulationFilter[]
  limit?: number
  signal?: AbortSignal
}

/**
 * What every request naming a dataset carries.
 *
 * `datasetRequest` in `nodes/lib/datasetParam.ts` is the one projection of a `DatasetValue` onto
 * this, so a call site cannot supply the id and forget the labels that go with it.
 */
export interface DatasetRequest {
  datasetId: string
  /**
   * Labels replacing the dataset's own.
   *
   * Absent means the dataset uses whatever its backend publishes. A source is expected to honour
   * this: `CaveSource` reads it at every query that names a neuron.
   */
  annotations?: DatasetAnnotations
}

/**
 * A dataset request a user-supplied edge set can answer instead of the backend.
 *
 * `edges` is read by the funnel in `data/queries.ts` and by **no source**, which is the whole
 * difference from `annotations`: a chain changes what a backend's own query *returns*, where
 * this replaces the query. So it sits on its own interface rather than on `DatasetRequest` — a
 * backend implementing `findNeurons` or `fetchSkeletons` has no business being handed a field
 * nothing in it can honour, and `connectivityRequest` is correspondingly the only projection
 * that supplies one.
 */
export interface EdgeAnswerableRequest extends DatasetRequest {
  edges?: DatasetEdges
}

export interface ConnectivityRequest extends EdgeAnswerableRequest {
  neuronIds: NeuronId[]
  direction: ConnectionDirection
  minWeight?: number
  /**
   * Restrict every weight to these regions, and drop a connection left with nothing.
   *
   * Absent means the whole neuron, which is what every caller before this asked for. Present,
   * a row's `weight` is the number of synapses **inside** the named regions rather than the
   * connection's total — measured on male-cns body 10005, whose edges touching `LAL(L)` carry
   * 13,071 synapses of which 9,344 are actually in it, so the two readings differ by a third
   * and only one of them can be called "connectivity in LAL(L)".
   *
   * Gated by `capabilities.connectivityRois`. A source that cannot answer it must not silently
   * return whole-neuron weights: that is a wrong number wearing the right column name.
   */
  rois?: readonly string[]
  /**
   * One row per (pair, region) instead of one row per pair, with a `roi` column naming it.
   *
   * Meant as a **decomposition** — the rows are the connection taken apart, not new rows added
   * beside it — and `minWeight` is applied to the connection *before* the split for that reason
   * (see `connectivityCypher`), so turning this on never changes which partners are found.
   *
   * **How exact that is depends on the dataset, and it was measured rather than assumed.** Over
   * 20,000 sampled connections per dataset, summing the primary-region parts against the
   * connection's own weight:
   *
   *   male-cns:v1.0      256,276 synapses, 0 outside every primary region
   *   manc:v1.2.1        385,947 synapses, 7
   *   hemibrain:v1.2.1   274,844 synapses, 1,104   (0.4%, on 2.2% of connections)
   *   optic-lobe:v1.1    317,276 synapses, 2,746   (0.9%, on 4.7% of connections)
   *
   * So the primary set tiles male-CNS and MANC and very nearly tiles the other two: a small
   * number of synapses sit in no primary region at all and are **dropped** by a split over that
   * set. neuprint-python meets the same gap and buckets it under a synthetic `"NotPrimary"`
   * name; nothing here invents a region, so the shortfall is a documented loss rather than a row
   * claiming to be somewhere. Below a percent, and in the other direction from the failure that
   * matters — regions that *nest*, which double count, and which is what `rois` carrying a
   * non-overlapping set is for.
   */
  splitByRoi?: boolean
  signal?: AbortSignal
}

/**
 * How many synapses a neuron has in total, for turning a connection weight into a fraction.
 *
 * **The denominator is the whole question here, and the two available answers differ by more
 * than a factor of two.** On male-cns body 10005 (AOTU019, Traced) the outgoing weights sum to
 * 23,423 over every partner and to 9,324 over partners neuPrint labels `:Neuron` — the rest
 * goes to unnamed fragments below the segmentation threshold. Both are correct answers to
 * different questions, so the basis rides on the request and the node says which it used.
 *
 * Gated by `capabilities.synapseTotals`, and one `side` per request rather than both at once
 * because a normalisation only ever needs one: dividing by the postsynaptic neuron's input
 * total never asks what its outputs were.
 */
export interface SynapseTotalsRequest extends EdgeAnswerableRequest {
  neuronIds: NeuronId[]
  /** `inputs` totals incoming synapses, `outputs` outgoing. The same word `direction` uses. */
  side: ConnectionDirection
  basis: SynapseTotalsBasis
  signal?: AbortSignal
}

/**
 * Which synapses the denominator counts.
 *
 * `all` is every synapse the neuron makes, whether or not the thing on the other end was ever
 * reconstructed. `connected` counts only synapses onto partners the dataset considers real
 * neurons, which is the denominator used to compare edge weights **across** connectomes with
 * different proofreading rates — the whole reason this is a choice rather than a constant.
 */
export type SynapseTotalsBasis = 'all' | 'connected'

/**
 * One hop of a path traversal, over neurons or over cell types.
 *
 * Separate from `ConnectivityRequest` because the two answer different shapes and the
 * difference is the whole point of the node that uses this. Connectivity answers
 * *query-relative* per-neuron rows; a path step answers **already-aggregated edges between
 * group keys**, which is what lets the traversal run on the type graph.
 *
 * That aggregation has to happen in the backend rather than here. A type-level hop on
 * male-CNS touches every neuron of every frontier type — hundreds of thousands of synapse
 * groups — and collapses to a few hundred type→type rows. Doing it client-side would mean
 * downloading the former to compute the latter, per hop.
 *
 * The frontier arrives as two lists because a group key is a type *or* a neuron id: a neuron
 * with no type cannot be collapsed into one, so it stands as its own node. Passing the two
 * separately keeps both halves of the `WHERE` index-backed, where a
 * `coalesce(n.type, toString(n.bodyId)) IN [...]` would force a label scan.
 */
export interface PathStepRequest extends EdgeAnswerableRequest {
  /** Frontier cell types. Empty (or absent) when the traversal is at neuron level. */
  types?: string[]
  /** Frontier neuron ids — every neuron when not collapsing, the untyped ones when collapsing. */
  neuronIds?: NeuronId[]
  direction: ConnectionDirection
  /** Group by cell type before aggregating. False keeps one node per neuron. */
  collapseTypes: boolean
  /**
   * Discard edges whose *aggregated* weight is below this.
   *
   * Applied after the grouping, deliberately: at type level the threshold is a statement about
   * how much traffic runs between two populations, and applying it per synapse group first
   * would drop the many weak connections that add up to a strong pathway.
   */
  minWeight?: number
  signal?: AbortSignal
}

export interface AdjacencyRequest extends EdgeAnswerableRequest {
  sourceIds: NeuronId[]
  targetIds: NeuronId[]
  /** Aggregate per-neuron weights up to type level before building the matrix. */
  groupByType?: boolean
  signal?: AbortSignal
}

export interface RoiCountsRequest {
  datasetId: string
  neuronIds: NeuronId[]
  rois?: string[]
  signal?: AbortSignal
}

export interface GeometryRequest {
  datasetId: string
  /**
   * Labels replacing the dataset's own — see `FindNeuronsRequest.annotations`.
   *
   * Geometry carries an attribute row per item, and that row is what every 3D colour encoding
   * reads. Without this a Meshes node would advertise the chain's columns and hand back the
   * datastack's, which is invariant 3 across the seam.
   */
  annotations?: DatasetAnnotations
  neuronIds: NeuronId[]
  /**
   * Target triangle count for the whole set, for sources with levels of detail. The source
   * picks the finest level that fits; a source with one level ignores it.
   */
  triangleBudget?: number
  /**
   * Called as work lands, with a 0..1 fraction and an optional phase note.
   *
   * Geometry fetches are the only things in Coda slow enough for a progress indicator to be
   * worth anything, and they are slow *per body* — so the source has to report, because the
   * node calling it only knows that one long await is outstanding.
   */
  onProgress?: (fraction: number, note?: string) => void
  /**
   * Ignore any geometry already held for these ids and read them again.
   *
   * **Clear Cache** on the node, reaching `geometryCache.ts` — the same job `CachedTableSpec`'s
   * flag of this name does for the persistent table store. A fact about *this run*, never about
   * the document: it must not be saved, must not travel to whoever you send the graph to, and
   * must not take part in the provenance key.
   */
  refresh?: boolean
  /**
   * When the geometry being returned was actually read from a server.
   *
   * Wired to `ctx.reportFetched`, so a card fed from the session cache can say `cached 12m ago`
   * rather than passing off a held copy as a fresh read. Same contract and same name as
   * `CachedTableSpec.onFetched`: the stored time for a hit, `Date.now()` for a fresh read.
   */
  onFetched?: (at: number) => void
  /**
   * Say that this request will cost something the caller should know about, without refusing it.
   *
   * Wired to `ctx.warn`, and the reason it crosses the seam at all is that the cost is a fact
   * about the *backend* rather than about the node: a hundred neurons is one query against
   * neuPrint's ready-made skeletons and about fifty thousand requests against graphene meshes.
   * The node cannot know that, and the source cannot reach the card, so the number that used to
   * be a per-source refusal (`MAX_MESH_NEURONS`, `MAX_CATMAID_SKELETONS`) travels back this way
   * instead.
   *
   * Called before the work starts, so the warning is on the card while there is still something
   * to cancel. Repeats collapse at the far end, so a source may say it from inside a loop.
   */
  onWarn?: (message: string) => void
  /**
   * Hand back a partial answer as bodies land, so the scene fills instead of appearing at once.
   *
   * The same shape this call will eventually resolve to, holding a subset of the items **in the
   * order the full answer will use** — the node wires it straight to `ctx.publish`, and the
   * renderer keys items positionally, so an out-of-order partial would tear down and rebuild
   * every `BufferGeometry` after it. `cachedGeometry`'s `onPartial` satisfies that by
   * construction and rate-limits the calls; a source should not be inventing its own.
   *
   * Only the fan-out fetches call it. `fetchSynapses` inherits it through `SynapseRequest` and
   * never will: a synapse cloud is one query for the whole set, so there is no arrival to report
   * until there is an answer.
   */
  onPartial?: (partial: SkeletonsValue | MeshesValue) => void
  /**
   * Which of the dataset's skeleton routes to take, or absent for the source's own preference.
   *
   * One of `SkeletonRouteId`, and the same string `DataSource.skeletonSourcesFor` offered — see
   * `data/skeletonRoutes.ts`. Absent is not a synonym for the preferred one: it says *nobody
   * chose*, which is what lets a source fall back when the route it would rather take turns out
   * to answer for nothing (CAVE's skeleton service against a datastack whose cache is empty).
   *
   * **A route this dataset does not have is an error, never a substitution.** A Skeletons node
   * pinned to `published` and then repointed at a dataset with no published skeletons must say
   * so; quietly answering with the other route is the same failure a column picker makes when it
   * substitutes a column, and here it would silently swap a traced reconstruction for a chunk
   * decomposition in an NBLAST.
   *
   * Only read by `fetchSkeletons`. `fetchMeshes` has the same choice and it is simply **not
   * exposed** — `CaveSource.fetchMeshes` already prefers a flat pyramid over graphene without
   * asking anybody, which is the same decision made silently. One optional field read by one of
   * the two fetches is cheaper than a second request type; the mesh half is a control away.
   */
  skeletonSource?: SkeletonRouteId
  signal?: AbortSignal
}

export interface SynapseRequest extends GeometryRequest {
  /** Restrict to synapses of this polarity. Undefined returns both. */
  polarity?: 'pre' | 'post'
  minWeight?: number
}

export interface RawQueryRequest {
  datasetId: string
  query: string
  signal?: AbortSignal
}

export interface ViewerSceneRequest {
  datasetId: string
  signal?: AbortSignal
}

export interface CoarseGeometryRequest {
  datasetId: string
  neuronId: NeuronId
  signal?: AbortSignal
}

/**
 * The cheapest drawable form of one neuron, in nanometres, in whichever shape the source has.
 *
 * A union rather than one shape, because the two backends that can answer this at all cannot
 * answer it in the same currency. A published mesh pyramid has a coarsest level; a `graphene://`
 * segmentation has no levels at all — one neuron is several hundred supervoxel fragments at full
 * resolution — but its level-2 chunk graph is two small requests, so for those datastacks a
 * skeleton is the only cheap representation in existence. Making a source fake the other one
 * means either meshing a skeleton or decimating a mesh into a tree, both of which are work done
 * to satisfy a type rather than to draw a picture.
 *
 * `kind` is required on both arms rather than inferred from which field is present: a source
 * that forgot it would otherwise be a silent fall-through to the mesh branch and an empty tile.
 */
export type CoarseGeometry =
  | {
      kind: 'mesh'
      /** xyz interleaved. */
      positions: Float32Array
      indices: Uint32Array
    }
  /**
   * `SkeletonGeometry` exactly, so the L2 reader's and CATMAID's decoder both hand their output
   * straight over — see `CaveSource.fetchCoarseGeometry`. `id` and `radii` ride along unused (on
   * a 16,840-node FAFB skeleton the radii are ~67 kB), which is still cheaper than a second shape
   * for the same thing. The mesh arm above is *not* `MeshGeometry` for the mirror-image reason:
   * `MeshResult` keys on `neuronId` and `MeshGeometry` on `id`, so reusing either would mean
   * renaming a field at the seam rather than passing a value through it.
   */
  | ({ kind: 'skeleton' } & SkeletonGeometry)

export interface SourceSchemas {
  /** Output of findNeurons. Must include a `neuronId` column. */
  neurons: TableSchema
  /** Output of fetchConnectivity. */
  connectivity: TableSchema
  /** Output of fetchRoiCounts. */
  roiCounts: TableSchema
  /** Per-skeleton and per-mesh attributes — what 3D encodings colour by. */
  morphology: TableSchema
  /** Per-synapse attributes, one row per point. */
  synapses: TableSchema
}

export interface SourceCapabilities {
  rawQuery: boolean
  skeletons: boolean
  meshes: boolean
  synapses: boolean
  /**
   * Whether the whole per-neuron attribute table can be fetched at once, which is what the
   * Explore widget searches. A source without it can still be queried by pattern; it just
   * cannot be browsed.
   */
  neuronIndex: boolean
  /**
   * Whether the source can answer one hop of a path traversal with the aggregation already
   * done — see `PathStepRequest`. A source without it can still be queried for connectivity;
   * the Paths node simply refuses rather than silently falling back to a client-side
   * aggregation whose cost is the thing this exists to avoid.
   */
  paths: boolean
  /**
   * Whether the source publishes a neuroglancer scene for its datasets — the curated state
   * an external viewer can be pointed at. Independent of `meshes`: the mock generates
   * geometry in the browser and has no bucket for anyone else to read.
   */
  viewerScene: boolean
  /**
   * Whether the source can describe a dataset's *regions* without being asked about neurons —
   * per-ROI traced-vs-total synapse counts, and region-to-region connectivity.
   *
   * Separate from `meshes` and from `fetchRoiCounts`, which both need a neuron id list. These
   * are facts about the whole volume, which is why they can answer a dataset node with
   * nothing else wired to it. A source without them makes the two ROI nodes refuse with a
   * message rather than fall back to summing a per-neuron fetch, which would mean downloading
   * the entire connectome to compute a figure the server already publishes.
   */
  roiSummary: boolean
  /**
   * Whether the source can break one neuron's synapses down by region.
   *
   * Separate from `roiSummary`, which is a fact about the whole *volume* and needs no neuron
   * ids. This is the per-neuron one — and it is a capability rather than a required method
   * because CAVE has no answer to it at all: FlyWire's neuropil assignments are a reference
   * table on synapses, so a per-region count means reading a neuron's synapses and grouping
   * them, which is the work its connection roll-up exists to avoid.
   *
   * It was a required method until the second real backend arrived, and the cost of that
   * showed up two levels away: `out.profile` fetches its regions in a `Promise.all` beside two
   * connectivity queries, so one rejection took all three down and every tile on the card
   * reported an error — on a neuron whose connectivity had loaded perfectly well.
   */
  roiCounts: boolean
  /**
   * Whether a neuron query can be narrowed to a **region**.
   *
   * Separate from every other ROI capability, and from `DatasetInfo.rois` above all, because
   * those two came apart and produced a silent wrong answer. CATMAID's `volumeList` fills `rois`
   * with eighty real neuropils so the ROI Viewer can draw them — and answering "which skeletons
   * are in this volume" needs a spatial query it has no bulk endpoint for. Find Neurons' region
   * picker read the *list*, so it offered eighty options that narrowed nothing and returned a
   * result too large to look wrong.
   *
   * A populated list is therefore not the question a card should ask. This is.
   */
  roiFilter: boolean
  /**
   * Whether a connectivity query can be restricted to regions, and split by them.
   *
   * Separate from `roiCounts`, which breaks one *neuron's* synapses down by region. This is the
   * same question asked of a *connection*, and the two come from different places: neuPrint
   * stores the per-region breakdown on the `ConnectsTo` relationship itself (`w.roiInfo`), so a
   * split costs nothing extra, while a source whose regions live on synapses would have to read
   * every synapse to answer. Declining is therefore the honest answer for CAVE and CATMAID, not
   * a gap — and it has to be declined rather than approximated, because returning whole-neuron
   * weights under a `roi` column is a wrong number with the right name on it.
   */
  connectivityRois: boolean
  /**
   * Whether the source can report a neuron's total synapse count, for normalising weights.
   *
   * Both bases of `SynapseTotalsBasis` or neither: a source that can only answer one of them
   * would make `Normalize by` a control whose options silently mean different things per
   * dataset. neuPrint answers both from properties it already publishes and from one aggregate
   * over the relationships it already has.
   */
  synapseTotals: boolean
  /**
   * Whether the source publishes a *mesh* per region — the neuropil shells themselves.
   *
   * Separate from `roiSummary`, which is the numbers, because the two are published in
   * different places and a source can plausibly have one without the other: neuPrint serves
   * the summaries from a cached endpoint and the geometry from another, and mushroombody
   * answers the first with zero rows. Separate from `meshes` for the reason `roiSummary` is
   * separate from `fetchRoiCounts` — that one needs a neuron id list, and this is a fact about
   * the volume, which is what lets it answer a dataset node with nothing else wired.
   */
  roiMeshes: boolean
}

export interface DataSource {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly capabilities: SourceCapabilities
  /** Default schemas, used before a dataset is chosen and by sources with one shape. */
  readonly schemas: SourceSchemas
  /**
   * Schemas for one dataset, when they differ.
   *
   * neuPrint datasets do not share a neuron schema — hemibrain has `cellBodyFiber`, manc
   * has `hemilineage` — so a single static shape would either lie or under-report. Must
   * stay synchronous for the same reason `schemas` is: inference runs on every graph
   * mutation and cannot await. A source that is still learning should return its default
   * and start discovery in the background rather than block.
   *
   * **Still learning means returning `this.schemas` itself**, not a copy of it. That object
   * identity is the only signal a caller has that the answer is a fallback rather than this
   * dataset's own shape, and `discoveredNeuronSchema` reads it: the contents are legitimately
   * identical for a dataset publishing only the canonical columns, so nothing else can tell the
   * two apart. A source returning a fresh equivalent object would make every such caller believe
   * discovery had landed — silently, and forever.
   */
  schemasFor?(datasetId: string): SourceSchemas

  listDatasets(signal?: AbortSignal): Promise<DatasetInfo[]>
  /** Cached, synchronous. Undefined until `listDatasets` has resolved at least once. */
  peekDatasets(): DatasetInfo[] | undefined
  peekDataset(datasetId: string): DatasetInfo | undefined

  findNeurons(req: FindNeuronsRequest): Promise<TableValue>
  /**
   * Every neuron in a dataset with every scalar property, cached.
   *
   * Separate from `findNeurons` despite overlapping with `findNeurons({})` because the two
   * have opposite economics: a find is a fresh query the user asked for, while this is a
   * once-per-dataset bulk download whose whole point is to be reused. Implementations are
   * expected to cache it and to deduplicate concurrent callers.
   */
  neuronIndex?(req: NeuronIndexRequest): Promise<TableValue>
  fetchConnectivity(req: ConnectivityRequest): Promise<TableValue>
  /**
   * Per-neuron synapse totals, to `SYNAPSE_TOTALS_SCHEMA`.
   *
   * Optional and gated by `capabilities.synapseTotals`. Asked about the ids that appear in a
   * connectivity result rather than about the ones that were queried, so an id here may be
   * something the source does not consider a neuron at all — a fragment on the far end of an
   * edge. Such an id gets a **null** total rather than a zero: zero is a neuron with no
   * synapses, and dividing by it would silently produce an infinity where the honest answer is
   * "this denominator is not known".
   */
  fetchSynapseTotals?(req: SynapseTotalsRequest): Promise<TableValue>
  /**
   * One hop of a path traversal, aggregated to `PATH_STEP_SCHEMA`.
   *
   * Optional, and gated by `capabilities.paths`. The result is an edge list between *group
   * keys*, not between neurons — see `PathStepRequest` for why the grouping belongs on this
   * side of the seam.
   */
  fetchPathStep?(req: PathStepRequest): Promise<TableValue>
  fetchAdjacency(req: AdjacencyRequest): Promise<MatrixValue>
  /**
   * Per-neuron, per-region synapse counts.
   *
   * Optional and gated by `capabilities.roiCounts`. A source without it makes the ROI Counts
   * node decline at edit time, and Profile draw every tile but the regions one.
   */
  fetchRoiCounts?(req: RoiCountsRequest): Promise<TableValue>

  /**
   * Per-ROI traced-vs-total synapse counts, to `ROI_COMPLETENESS_SCHEMA`.
   *
   * Optional and gated by `capabilities.roiSummary`. Asks nothing about neurons, so it
   * answers a dataset node on its own.
   */
  fetchRoiCompleteness?(req: RoiSummaryRequest): Promise<TableValue>
  /**
   * Region-to-region connectivity, to `ROI_CONNECTIVITY_SCHEMA`.
   *
   * Long form — one row per ordered ROI pair — rather than a matrix, for the same reason
   * `fetchRoiCounts` is long: the reshape needs a *measure* chosen, and which measure to draw
   * is the node's question rather than the source's. Same call `roiCounts` makes.
   */
  fetchRoiConnectivity?(req: RoiSummaryRequest): Promise<TableValue>

  /**
   * One mesh per region, as an ordinary `MeshesValue`.
   *
   * Optional and gated by `capabilities.roiMeshes`. A `MeshesValue` rather than a new kind
   * because that type already pairs geometry with one attribute row per item, which is exactly
   * one row per region — so the region's name, whether it is primary, and anything else known
   * about it ride in the attribute table, where every colour encoding already knows how to
   * find them.
   *
   * **Geometry is nanometres, like everything else here.** A source whose meshes arrive in
   * voxels has to scale them, or the shells sit a whole factor away from the neurons anyone
   * draws beside them — with nothing failing, because both sets are internally consistent.
   */
  fetchRoiMeshes?(req: RoiMeshRequest): Promise<MeshesValue>

  /**
   * Cheapest geometry for a single neuron, for a thumbnail.
   *
   * Resolves `undefined` when the dataset has no *cheap* representation, and that refusal is
   * the load-bearing part: a browsable list wants ~10 kB per row, and a dataset publishing
   * only full-resolution meshes would hand back several megabytes each. Returning undefined
   * says "draw a placeholder" rather than quietly downloading 25 neurons at full detail to
   * fill one page of a list.
   */
  fetchCoarseGeometry?(req: CoarseGeometryRequest): Promise<CoarseGeometry | undefined>

  /**
   * The neuroglancer scene a dataset publishes, verbatim.
   *
   * Returned unedited on purpose — `neuroglancer/scene.ts` decides what to change, and it is
   * the same decision for every backend. Resolves `undefined` when the dataset publishes
   * none, which is a legitimate answer rather than an error: the mock has no bucket at all.
   * Implementations are expected to cache the result, including the undefined, since this is
   * called from a `cheap` node that re-runs on every restyle.
   */
  fetchViewerScene?(req: ViewerSceneRequest): Promise<NgScene | undefined>

  /** Morphology. Optional: a source may expose connectivity without geometry. */
  fetchSkeletons?(req: GeometryRequest): Promise<SkeletonsValue>
  /**
   * The skeleton routes *this dataset* has, best first.
   *
   * **Synchronous, and `undefined` means "not known yet"** — `capabilitiesFor`'s contract, and
   * for the same reason: this is read from `inferOutputs`/`validate` on every graph mutation, so
   * an implementation may start a probe but must never await one (invariant 2). It must fire
   * `reportSourceLearned` when the probe lands, or a dropdown offering one route keeps offering
   * one route for the life of the session.
   *
   * An empty array is a different answer again: this dataset has no skeletons at all, which
   * `capabilitiesFor` already says and which a caller here should not have to re-derive.
   *
   * **Order is the preference `fetchSkeletons` will apply with no `skeletonSource` set**, so the
   * dropdown's "Automatic" can name what it will actually get. A source that keeps the two in
   * different files is one edit away from a control that lies.
   *
   * Optional, and absent means "one route, unnamed" rather than "none" — every source that
   * answers `fetchSkeletons` at all has at least one. Implementing it is what buys the node its
   * dropdown; not implementing it costs only that.
   */
  skeletonSourcesFor?(datasetId: string): readonly SkeletonProvenance[] | undefined
  /**
   * What *this dataset* can do, where it differs from the source.
   *
   * **Synchronous, and `undefined` means "same as the source"** — `schemasFor`'s contract, and
   * it is read from `validate` on every graph mutation, so an implementation may start a fetch
   * but must never await one.
   *
   * It exists because `capabilities` is per **source** and one source can serve datasets that
   * genuinely differ. CAVE is the case: a datastack's skeletons depend on whether its
   * chunkedgraph has an L2 cache, which six of thirteen do — so a flat `skeletons: false` told
   * every FlyWire-production user a falsehood, and a flat `true` would tell every Aedes user the
   * opposite one. Only the keys that differ need be returned.
   */
  capabilitiesFor?(datasetId: string): Partial<SourceCapabilities> | undefined
  fetchMeshes?(req: GeometryRequest): Promise<MeshesValue>
  fetchSynapses?(req: SynapseRequest): Promise<PointsValue>

  rawQuery?(req: RawQueryRequest): Promise<TableValue>
}

// ---------------------------------------------------------------------------
// Canonical schemas
// ---------------------------------------------------------------------------

/**
 * Coda's canonical column names. Sources are expected to map onto these where the
 * concept exists, and may add extra columns — nodes address columns by name, so a
 * source with richer columns just gives you more to pick from.
 */
/**
 * What one hop of a path traversal returns, whatever the source.
 *
 * Fixed rather than per-dataset, unlike the schemas above: this table is consumed by the
 * traversal, never by a column picker, and every column is something the traversal needs to
 * take its next step. A source with richer per-neuron columns has nowhere to put them here,
 * because a row may stand for hundreds of neurons.
 *
 * `sourceId`/`targetId` are null exactly when the key names a *type*, which is what tells the
 * caller whether to feed the key back as a type or as a neuron id. `pairs` is how many
 * neuron→neuron connections were merged into the row — the honest denominator for a
 * type-level weight, and 1 at neuron level.
 */
export function pathStepSchema(idDType: 'i64' | 'str'): TableSchema {
  return tableSchema(
    column('source', 'str'),
    column('sourceType', 'str'),
    column('sourceId', idDType),
    column('target', 'str'),
    column('targetType', 'str'),
    column('targetId', idDType),
    column('weight', 'f64', 'synapses'),
    column('pairs', 'i64'),
  )
}

/**
 * The neuPrint shape, whose ids are exact as doubles.
 *
 * A *builder* rather than one constant, because the id dtype is the one thing here that is a
 * fact about the source rather than about the traversal -- invariant 8's "what a source
 * publishes as a dtype" -- and a source keyed by eighteen-digit text cannot put its ids in an
 * `i64` column without rounding them into different neurons. Safe to vary because this table
 * never reaches a column picker: it is the transport between a source and `pathOps`, which
 * reads both ends through `idText` and so takes either.
 */
export const PATH_STEP_SCHEMA: TableSchema = pathStepSchema('i64')

/**
 * The region column a split connectivity result carries, and the one spelling of its name.
 *
 * Shared rather than written at each end: the source builds the table and
 * `connectivityOutputSchema` advertises it, and a node that advertised `roi` while a source
 * filled `ROI` would leave every column picker downstream pointing at nothing — the failure
 * invariant 3 exists to prevent, one layer further out.
 */
export const CONNECTIVITY_ROI_COLUMN = 'roi'

/**
 * A connectivity schema with the region column appended.
 *
 * Appended rather than inserted so the columns a caller already addresses keep their positions;
 * nothing here is positional, but a decoder somewhere else is (`tableFromCypher` maps by index),
 * and a column that moves is the kind of change that type-checks.
 */
export function connectivitySchemaWithRoi(schema: TableSchema): TableSchema {
  if (schema.columns.some((c) => c.name === CONNECTIVITY_ROI_COLUMN)) return schema
  return tableSchema(...schema.columns, column(CONNECTIVITY_ROI_COLUMN, 'str'))
}

/**
 * What `fetchSynapseTotals` returns: one row per neuron asked about, or none.
 *
 * A row per neuron **that has an answer**, and a caller is expected to read it as a lookup
 * rather than positionally — an id the source has never heard of is simply absent, which is how
 * "not known" is said without a sentinel that arithmetic would happily consume.
 *
 * The id dtype is the source's, `pathStepSchema`'s rule and invariant 8's reason: an
 * eighteen-digit CAVE root id in an `i64` column is a different neuron.
 */
export function synapseTotalsSchema(idDType: 'i64' | 'str'): TableSchema {
  return tableSchema(column(ID_COLUMN_NAME, idDType), column('total', 'i64', 'synapses'))
}

/**
 * What either ROI summary needs: a dataset, and nothing else.
 *
 * Deliberately not carrying a `rois` filter, unlike `RoiCountsRequest`. Which regions are
 * summable is decided *from the answer* — see `primary` below — and a filter applied before
 * the rows exist would leave a caller unable to tell a region that was excluded from one the
 * dataset never had.
 */
export interface RoiSummaryRequest {
  datasetId: string
  signal?: AbortSignal
}

/**
 * The neuropil shells of a dataset.
 *
 * `rois` omitted means the dataset's primary set — the one that tiles the volume — rather than
 * every region it publishes. That default is the whole point: hemibrain lists 229 regions of
 * which 63 tile, and male-CNS 5,619 of which 144, so asking for "the regions" without
 * qualification and getting all of them would be thousands of requests for a picture in which
 * every shell is drawn inside another one.
 *
 * `onProgress` is here for the same reason `GeometryRequest` has it: this is slow *per region*,
 * and only the source knows how many have landed.
 */
export interface RoiMeshRequest {
  datasetId: string
  /** Which regions. Omitted means the dataset's primary set. */
  rois?: string[]
  onProgress?: (fraction: number, note?: string) => void
  signal?: AbortSignal
}

/**
 * Per-ROI synapse counts: how many belong to reconstructed neurons, against how many are
 * there at all.
 *
 * Fixed rather than per-dataset, like `PATH_STEP_SCHEMA`: every source that can answer this
 * answers it in exactly these terms, and there is nowhere for a richer one to put extra.
 *
 * Two columns carry the traps.
 *
 * **`primary` is the licence to sum.** A dataset's ROI list *nests* — hemibrain publishes
 * `AL(R)` and `AL-DA1(R)` as separate rows, and male-CNS publishes 5,412 rows that are mostly
 * medulla columns inside `ME(R)` — so adding the whole column up counts the same synapse
 * several times. Summing hemibrain's raw rows gives 21.0M presynaptic sites against a true
 * 9,428,400 over the 63 primary rows — a 2.2x overcount, and only the filtered figure agrees
 * with `Meta.totalPreCount` (9,496,606). Only `Meta.primaryRois` names a set that tiles the
 * volume, so the flag is set from
 * it and everything that totals anything filters on it first. Exactly the trap `roiInfo` sets
 * for the Profile widget's region bars, one level up.
 *
 * **The two fractions are null rather than zero where there is nothing to divide.** A region
 * with no synapses at all has *undefined* completeness, and `0` there would draw a confident
 * empty bar for a region nobody has looked at — the same reason `numeric()` exists in
 * `ui/encoding.ts`.
 */
export const ROI_COMPLETENESS_SCHEMA: TableSchema = tableSchema(
  column('roi', 'str'),
  column('pre', 'i64', 'synapses'),
  column('post', 'i64', 'synapses'),
  column('totalPre', 'i64', 'synapses'),
  column('totalPost', 'i64', 'synapses'),
  column('preCompleteness', 'f64'),
  column('postCompleteness', 'f64'),
  column('primary', 'bool'),
)

/**
 * Region-to-region connectivity, one row per ordered pair.
 *
 * `count` and `weight` are both published and they are **not** the same measure in different
 * units: on hemibrain `AB(L)→BU(L)` reports `count: 13, weight: 3.11`, so weight is scaled or
 * normalised rather than additive. Both are carried because both are what the server said;
 * what a viewer should *label* the weight is a separate question, and until it is settled the
 * node that draws a matrix from this defaults to `count`, which is unambiguous.
 */
export const ROI_CONNECTIVITY_SCHEMA: TableSchema = tableSchema(
  column('source', 'str'),
  column('target', 'str'),
  column('count', 'i64'),
  column('weight', 'f64'),
)

/**
 * What a source says about each region mesh it hands back, one row per item.
 *
 * Deliberately small. `roi` is the identity, and `MeshGeometry.id` carries the same string —
 * and `primary` is the one qualifier a caller cannot work out for itself. Everything else the
 * ROIs widget shows is either derived from the geometry (volume, surface area) or lives in the
 * completeness table, and joining those in here would make one endpoint's answer depend on
 * another's having landed.
 *
 * A source with more to say may add columns; nodes address columns by name.
 */
export const ROI_MESH_SCHEMA: TableSchema = tableSchema(
  column('roi', 'str'),
  column('primary', 'bool'),
)

export const CANONICAL_SCHEMAS: SourceSchemas = {
  neurons: tableSchema(
    column('neuronId', 'i64'),
    column('type', 'str'),
    column('instance', 'str'),
    column('status', 'str'),
    column('size', 'i64', 'voxels'),
    column('pre', 'i64', 'synapses'),
    column('post', 'i64', 'synapses'),
  ),
  connectivity: tableSchema(
    column('neuronId', 'i64'),
    column('neuronType', 'str'),
    column('partnerId', 'i64'),
    column('partnerType', 'str'),
    column('weight', 'i64', 'synapses'),
  ),
  roiCounts: tableSchema(
    column('neuronId', 'i64'),
    column('type', 'str'),
    column('roi', 'str'),
    column('pre', 'i64', 'synapses'),
    column('post', 'i64', 'synapses'),
  ),
  morphology: tableSchema(
    column('neuronId', 'i64'),
    column('type', 'str'),
    column('instance', 'str'),
    column('status', 'str'),
    column('size', 'i64', 'voxels'),
    column('points', 'i64'),
    // Nanometres, not voxels: geometry is normalised to physical units so meshes and
    // skeletons share a scene. See `data/units.ts`.
    column('cableLength', 'f64', 'nm'),
  ),
  synapses: tableSchema(
    column('neuronId', 'i64'),
    column('type', 'str'),
    column('partnerId', 'i64'),
    column('partnerType', 'str'),
    column('polarity', 'str'),
    column('weight', 'i64', 'synapses'),
  ),
}

// ---------------------------------------------------------------------------
// Source registry
// ---------------------------------------------------------------------------

/**
 * The backend behind a source id — a key of `BACKENDS`.
 *
 * The part before the colon, since a non-default deployment registers under a keyed id:
 * `neuprint:https://…` (see `sourceIdForServer`) and `catmaid:https://…` are still
 * neuPrint and CATMAID as far as which API answers them, which is the whole of what a reader of
 * this wants to know. `cave` and `mock` register once each and come back unchanged.
 *
 * Here, beside the registry that mints these ids, because the readers are in three layers that
 * cannot all see each other: a node's `validate` gates a refusal on it, the notebook exporter
 * gates an emitter on it, and `data/transforms/spaces.ts` decides a dataset's template space
 * with it. It began private to the exporter and moved once already; each move happened because
 * the alternative was a second spelling of the colon rule — which is the drift `backendName`'s
 * own comment records happening to the table it reads.
 */
export function backendOf(sourceId: string): string {
  const at = sourceId.indexOf(':')
  return at === -1 ? sourceId : sourceId.slice(0, at)
}

const sources = new Map<string, DataSource>()

export function registerSource(source: DataSource): DataSource {
  sources.set(source.id, source)
  return source
}

// ---------------------------------------------------------------------------
// "A source learned something" — the signal that inference is now out of date
// ---------------------------------------------------------------------------

const learnedListeners = new Set<(sourceId: string) => void>()

/**
 * Announce that a source has filled in something `inferOutputs` reads *synchronously* — a
 * dataset listing, a discovered schema.
 *
 * This exists because those two facts arrive asynchronously and inference must not await
 * (invariant 2). So inference runs against whatever is cached, degrades, and is never asked
 * again: nothing recomputes it when the answer finally lands. What that looked like was a
 * dataset node whose `version` is "Latest" — the id comes from `peekDatasets()`, which is empty
 * on a fresh session — inferring a Dataset type with *no dataset id*, so the Explore widget
 * downstream said "Connect a Dataset to browse its neurons" beside a pipeline that had just run
 * to completion. It recovered on any graph edit at all, which is the signature of stale
 * inference rather than of a broken widget.
 *
 * A separate channel rather than a return value, for the same reason `reportAuthFailure` is
 * one: the fact is learned deep inside a fetch that several unrelated callers may have started,
 * and `src/data` cannot import the store to push it anywhere.
 *
 * Fire it only for things inference reads. It is not a data-changed event — nothing here
 * invalidates a cached result.
 */
/**
 * What a source can do **for one dataset**, which is the only way capabilities should be read.
 *
 * `capabilities` is per source and `capabilitiesFor` is the per-dataset override; reading the
 * first directly skips the second. That matters because the two halves of a gate are usually in
 * different layers — `validate` refuses at edit time and `evaluate` at run time — so a reader
 * that bypasses the override makes them disagree, with nothing type-checking the pair. Six
 * readers did exactly that when the override was introduced.
 */
export function capabilityOf(
  source: DataSource | undefined,
  datasetId: string | undefined,
  capability: keyof SourceCapabilities,
): boolean {
  if (!source) return true
  const forDataset = datasetId ? source.capabilitiesFor?.(datasetId) : undefined
  return forDataset?.[capability] ?? source.capabilities[capability]
}

/**
 * The skeleton routes a dataset has, read the way `capabilityOf` reads a capability.
 *
 * It merges nothing — unlike `capabilityOf`, which has a per-dataset override to fold in — so
 * what it buys is the *seam*: `src/nodes` asks here rather than reaching into
 * `source.skeletonSourcesFor`, which is the same rule capabilities follow and for the same
 * reason, that a fact with three meanings should have one reader.
 *
 * Three answers and they are all different: `undefined` (a probe has not landed, or the source
 * names no routes — offer nothing and say nothing), `[]` (this dataset has no skeletons —
 * `capabilityOf(…, 'skeletons')` is the question to ask instead), and a list, best first.
 */
export function skeletonRoutesOf(
  source: DataSource | undefined,
  datasetId: string | undefined,
): readonly SkeletonProvenance[] | undefined {
  if (!source || !datasetId) return undefined
  return source.skeletonSourcesFor?.(datasetId)
}

/**
 * Refuse a route this source has never heard of, in one sentence written once.
 *
 * **Three of the five sources did not read `skeletonSource` at all**, which is the gap this
 * closes: a Skeletons node pinned to `published` and repointed at a CATMAID project got the
 * tracing, labelled as the tracing, with nothing anywhere saying the choice had been dropped —
 * the exact silent swap `GeometryRequest.skeletonSource` forbids. Written per backend it was
 * three sources' worth of a rule nobody was obliged to implement, and two wordings of it in the
 * two that did.
 *
 * The **vocabulary** half only: whether this backend can ever serve that route. Whether *this
 * dataset* has it stays with the source, because that is a live question about a bucket or a
 * cache — `CaveSource.fetchSkeletons` still refuses a `published` route on a materialization
 * nobody flattened, and says which materialization.
 */
export function requireSkeletonRoute(
  label: string,
  requested: SkeletonRouteId | undefined,
  served: readonly SkeletonProvenance[],
): void {
  if (!requested || served.some((route) => route.id === requested)) return
  throw new Error(
    `${label} has no "${requested}" skeletons — it offers ` +
      `${served.map((route) => route.label).join(', ')}. Set the Skeletons node's Source back ` +
      `to Automatic, which picks whichever route this dataset does have.`,
  )
}

/**
 * Whether a dataset can answer one hop of a path traversal.
 *
 * One predicate because the question has **three** readers in three layers — the Paths node's
 * `validate` (before a run), its `evaluate` (at the start of one) and `queries.ts` (at the hop
 * itself) — and they had already parted company: two required `paths` and the third only checked
 * that a method existed, so a source with `fetchPathStep` and `paths: false` was refused by the
 * node and accepted by the funnel. Inert only because the node happened to run first.
 *
 * It sits here rather than in `src/nodes` for `capabilityOf`'s own stated reason: a per-dataset
 * fact is useless to a reader that skips the resolver, and the readers are in different layers.
 * An attached edge set is a third input to the same gate — it *adds* the capability, because a
 * local edge list answers a hop that CAVE's API cannot.
 */
export function canTracePaths(
  source: DataSource | undefined,
  datasetId: string | undefined,
  hasEdgeSet: boolean,
): boolean {
  if (hasEdgeSet) return true
  /*
   * An unresolved source refuses nothing — `capabilityOf`'s own rule, and it has to be applied
   * *before* the method check rather than delegated to it. A Paths node whose Dataset socket
   * carries the declared `T.dataset()` fallback has no source to ask, which is invariant 2's
   * ordinary cold-session state; short-circuiting on `fetchPathStep` there reported "cannot
   * trace paths" on a node that is perfectly fine.
   */
  if (!source) return true
  return Boolean(source.fetchPathStep) && capabilityOf(source, datasetId, 'paths')
}

/**
 * Whether a connectivity query on this dataset can be restricted to regions and split by them.
 *
 * `canTracePaths`'s shape with the edge-set arm **inverted**, and that is the substance rather
 * than an omission. An attached edge set *replaces* the query — `connectivityFor` answers from
 * it and never asks the backend — and a file of `pre, post, weight` says nothing about where
 * along either neuron those synapses are. So the set does not add the capability the way it
 * adds `paths`; it removes it, whatever the backend behind the dataset could have done.
 *
 * Refusing is the only safe answer there. Falling through to the backend would put the
 * *server's* region breakdown under the *file's* weights, which is two connectomes in one table
 * with nothing on the card to say so — the failure `connectivityFor`'s "it refuses; it never
 * falls back" exists to prevent, arriving through a different door.
 */
export function canSplitConnectivityByRoi(
  source: DataSource | undefined,
  datasetId: string | undefined,
  hasEdgeSet: boolean,
): boolean {
  if (hasEdgeSet) return false
  // An unresolved source refuses nothing — `capabilityOf`'s rule, applied before the flag for
  // `canTracePaths`'s reason: a cold Dataset socket is invariant 2's ordinary state, not a no.
  if (!source) return true
  return capabilityOf(source, datasetId, 'connectivityRois')
}

/**
 * Whether this dataset can supply the denominators that turn a weight into a fraction.
 *
 * The same three arms as `canSplitConnectivityByRoi`, and the edge-set one refuses for a sharper
 * reason: an edge set could perfectly well total its own weights, but its numerator and the
 * backend's denominator are counts of different things. A file holding one lab's curated subset
 * of hemibrain, normalised against hemibrain's published synapse totals, produces fractions that
 * are individually plausible and collectively meaningless.
 */
export function canTotalSynapses(
  source: DataSource | undefined,
  datasetId: string | undefined,
  hasEdgeSet: boolean,
): boolean {
  if (hasEdgeSet) return false
  if (!source) return true
  return Boolean(source.fetchSynapseTotals) && capabilityOf(source, datasetId, 'synapseTotals')
}

export function reportSourceLearned(sourceId: string): void {
  for (const listener of learnedListeners) listener(sourceId)
}

/** Subscribe to `reportSourceLearned`. Returns an unsubscribe. */
export function subscribeSourceLearned(listener: (sourceId: string) => void): () => void {
  learnedListeners.add(listener)
  return () => learnedListeners.delete(listener)
}

export function getSource(id: string): DataSource | undefined {
  return sources.get(id)
}

export function requireSource(id: string): DataSource {
  const source = sources.get(id)
  if (!source) {
    throw new Error(
      `No data source "${id}" is registered. Available: ${[...sources.keys()].join(', ') || '(none)'}`,
    )
  }
  return source
}

export function allSources(): DataSource[] {
  return [...sources.values()]
}

/** Cooperative abort check for long synchronous loops inside a source. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
}

/** Await a delay that rejects on abort — used to simulate/absorb network latency. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    throwIfAborted(signal)
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    if (signal?.aborted) {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
