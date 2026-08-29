/**
 * neuPrint as a Coda DataSource.
 *
 * Everything specific to neuPrint lives under this file's imports: the Cypher is in
 * `cypher.ts`, the response mapping in `decode.ts`, the per-dataset schema discovery in
 * `schema.ts`. Nodes see the same interface the mock implements.
 *
 * The one place this source is *not* like the mock is timing. Mock metadata is available
 * synchronously from construction; here `listDatasets()` is a network call, and the
 * per-dataset schema behind `schemasFor()` needs two more. Until those land, this source
 * answers with the canonical schemas — honestly incomplete rather than blocking — and the
 * editor re-infers when they arrive. That is exactly what `peekDataset` was designed for.
 */

import type { TableSchema } from '../../core/types'
import type {
  ColumnData,
  GeometryUnits,
  MatrixValue,
  MeshesValue,
  PointsValue,
  SkeletonGeometry,
  SkeletonsValue,
  TableValue,
} from '../../core/values'
import {
  EMPTY_BOUNDS,
  boundsOf,
  cableLength,
  emptyTable,
  makeMatrix,
  makeTable,
  tableFromRows,
} from '../../core/values'
import type {
  AdjacencyRequest,
  CoarseGeometry,
  CoarseGeometryRequest,
  ConnectivityRequest,
  DataSource,
  DatasetInfo,
  FindNeuronsRequest,
  GeometryRequest,
  NeuronIndexRequest,
  PathStepRequest,
  RawQueryRequest,
  RoiCountsRequest,
  RoiMeshRequest,
  RoiSummaryRequest,
  SourceCapabilities,
  SourceSchemas,
  SynapseRequest,
  ViewerSceneRequest,
} from '../source'
import {
  CANONICAL_SCHEMAS,
  PATH_STEP_SCHEMA,
  ROI_CONNECTIVITY_SCHEMA,
  ROI_MESH_SCHEMA,
  reportSourceLearned,
  throwIfAborted,
} from '../source'
import { datasetSummaryKey, loadCachedTable, neuronIndexKey } from '../neuronIndex'
import { geometryFrame } from '../transforms/spaces'
import { fetchRoiMeshSet } from './roiMeshes'
import { superRoisFrom } from './roiHierarchy'
import type { MeshResult, MeshSource } from '../precomputed'
import {
  DEFAULT_TRIANGLE_BUDGET,
  fetchCoarseMesh,
  fetchMeshes,
  meshProgress,
  openMeshSource,
} from '../precomputed'
import { byteLengthOf, cachedGeometry } from '../geometryCache'
import {
  fetchDatasets,
  fetchRoiCompleteness,
  fetchRoiConnectivity,
  fetchSkeleton,
  runCypher,
} from './client'
import { roiCompletenessFromResponse, roiConnectivityFromResponse } from './roiSummary'
import { DEFAULT_SERVER, normaliseServer, serverLabel, sourceIdForServer } from './servers'
import {
  adjacencyCypher,
  connectivityCypher,
  findNeuronsCypher,
  idList,
  pathStepCypher,
  metaCypher,
  roiCountsCypher,
  sampleNeuronsCypher,
  sampleStatusesCypher,
  synapsesCypher,
} from './cypher'
import type { CypherResponse } from './decode'
import {
  inferTableFromCypher,
  roiCountsFromCypher,
  skeletonFromSwc,
  tableFromCypher,
} from './decode'
import type { NgScene } from '../neuroglancer/scene'
import { fetchNgState, meshSourceFromState } from './nglayers'
import type { DiscoveredSchema } from './schema'
import { discoverNeuronSchema, schemasFor } from './schema'
import type { VoxelScale } from './units'
import {
  IDENTITY_SCALE,
  geometryUnitsFor,
  scalePositions,
  scaleRadii,
  voxelScale,
} from './units'
import { mapWithConcurrency } from '../concurrency'

/**
 * Skeletons are one HTTP request per body — neuPrint has no batch endpoint — and each is
 * ~500ms of latency. Six at a time keeps a 50-neuron fetch to a few seconds without opening
 * fifty sockets against a server other people are using.
 */
const SKELETON_CONCURRENCY = 6

/**
 * The neuron columns a morphology attribute row carries, named once.
 *
 * It was written out three times — the query's return type, its accumulator, and now the
 * assembler that turns pairs into a value — and the three had to agree for a column to reach a
 * colour picker at all. Naming it is what lets the streaming path state that a partial is built
 * from the same rows as the final answer rather than merely look as if it is.
 */
interface NeuronRow {
  type: string | null
  instance: string | null
  status: string | null
  size: number | null
}

/**
 * The columns a morphology row shares between skeletons and meshes, appended in one place.
 *
 * The two assemblers differ only in `points` (nodes against vertices) and `cableLength` (a
 * number against null); everything before that was the same five pushes written twice, which is
 * invariant 3's failure one layer down — a new morphology column added to one and not the other
 * gives an attribute table and an item list that disagree, visible only after a run.
 */
function pushNeuronRow(
  data: Record<string, ColumnData>,
  neuronId: string,
  row: NeuronRow | undefined,
): void {
  // The column is `i64` because neuPrint's ids are nine to eleven digits and exact as doubles —
  // invariant 8's "what a source publishes does not change". A source whose ids are wider
  // declares `str` and pushes `neuronId` itself.
  data['neuronId']!.push(Number(neuronId))
  data['type']!.push(row?.type ?? null)
  data['instance']!.push(row?.instance ?? null)
  data['status']!.push(row?.status ?? null)
  data['size']!.push(row?.size ?? null)
}

/**
 * A neuron id out of a Cypher response, as the same decimal text a `NeuronId` carries.
 *
 * Named rather than inlined because it is an *agreement*: every map here keyed by id is keyed
 * by this, so a key built from a response and one built from a request must match exactly or
 * the row is silently dropped from a matrix or an attribute table. `String` is enough only
 * because neuPrint's ids are nine to eleven digits and survive the JSON round trip; a source
 * with wider ids has to keep them as text from the wire onwards, which is why `NeuronId` exists.
 */
function idKey(raw: unknown): string {
  return String(raw)
}

interface DatasetState {
  info: DatasetInfo
  discovered?: DiscoveredSchema
  schemas?: SourceSchemas
  /**
   * Voxels → nanometres, from `Meta.voxelSize`. Absent until discovery has run, and absent
   * afterwards for a dataset whose `Meta` does not say — which is a different fact from a 1:1
   * scale and is what `unitsFor` publishes on every geometry value.
   */
  scale?: VoxelScale
  /** Resolved once from the nglayers endpoint; null when the dataset publishes none. */
  meshSource?: MeshSource | null
  meshResolving?: Promise<MeshSource | null>
  /** The published neuroglancer state, from the same endpoint. Null when there is none. */
  scene?: NgScene | null
  sceneResolving?: Promise<NgScene | null>
  /** In flight, so two nodes inferring at once don't each trigger discovery. */
  discovering?: Promise<void>
}

export class NeuPrintSource implements DataSource {
  readonly id: string
  readonly label: string
  readonly description: string
  /** Deployment this instance talks to, canonicalised. See `servers.ts`. */
  readonly server: string
  readonly capabilities: SourceCapabilities = {
    rawQuery: true,
    skeletons: true,
    // Meshes do not come from neuPrintHTTP at all: they are read straight from the
    // neuroglancer precomputed buckets the dataset advertises, with no token.
    meshes: true,
    synapses: true,
    neuronIndex: true,
    paths: true,
    // Every neuPrint dataset publishes a neuroglancer state at the nglayers endpoint — the
    // same document the mesh source is resolved from.
    viewerScene: true,
    // The two `/api/cached/*` roll-ups. Published by every dataset the listing offers, though
    // a dataset with no ROI hierarchy of its own answers with nothing in it — mushroombody
    // returns zero rows and no pairs, which is a dataset that has no regions rather than a
    // failure, and is reported as such.
    roiCounts: true,
    roiSummary: true,
    roiFilter: true,
    roiMeshes: true,
  }
  readonly schemas: SourceSchemas = CANONICAL_SCHEMAS

  private states = new Map<string, DatasetState>()
  private ordered: DatasetInfo[] | undefined
  private listing: Promise<DatasetInfo[]> | undefined
  /** Whether a peek has already asked for the listing. See `peekDatasets`. */
  private listingRequested = false

  /**
   * One instance per deployment.
   *
   * Instances rather than a global base URL because two Custom neuPrint nodes may point at
   * different servers in the same graph, and a global would make the second one silently query
   * the first one's data. The dataset listing, discovered schemas and resolved mesh sources are
   * all per-deployment state, so they belong on the instance too.
   */
  constructor(server: string = DEFAULT_SERVER) {
    this.server = normaliseServer(server)
    this.id = sourceIdForServer(this.server)
    const host = serverLabel(this.server)
    this.label = this.server === DEFAULT_SERVER ? 'neuPrint' : `neuPrint (${host})`
    this.description =
      this.server === DEFAULT_SERVER
        ? 'Janelia neuPrint (neuprint.janelia.org) — hemibrain, MANC, optic-lobe, male-CNS and more. Needs a token and a same-origin proxy.'
        : `neuPrint at ${host}. Needs a token and a same-origin proxy.`
  }

  /**
   * Request options for this deployment.
   *
   * Every call goes through here rather than building `{signal}` inline, because a call site
   * that forgets the base URL does not fail — it quietly queries the *default* deployment and
   * returns plausible data from the wrong server.
   */
  private options(signal?: AbortSignal): { signal?: AbortSignal; server: string } {
    return { server: this.server, ...(signal ? { signal } : {}) }
  }

  // -------------------------------------------------------------------------
  // Datasets
  // -------------------------------------------------------------------------

  async listDatasets(signal?: AbortSignal): Promise<DatasetInfo[]> {
    // Deduplicated: the dataset picker, the connection panel and inference can all ask at
    // once on first load.
    this.listing ??= this.loadDatasets(signal).finally(() => {
      this.listing = undefined
    })
    return this.listing
  }

  private async loadDatasets(signal?: AbortSignal): Promise<DatasetInfo[]> {
    const raw = await fetchDatasets(this.options(signal))
    const infos: DatasetInfo[] = Object.entries(raw)
      .filter(([, entry]) => String(entry.hidden ?? 'False').toLowerCase() !== 'true')
      .map(([id, entry]) => {
        const [label, version] = splitDatasetId(id)
        return {
          id,
          label,
          ...(entry.description ? { description: entry.description } : {}),
          ...(version ? { version } : {}),
          rois: entry.ROIs ?? [],
          /*
           * The listing's `superLevelROIs` *is* `Meta.primaryRois`, checked set-for-set across
           * every dataset the server offers — hemibrain 63, MANC 59, male-CNS 144, optic-lobe
           * 89, fib19 and mushroombody 3 each, identical every time.
           *
           * Taking it here rather than waiting for discovery is what closes the window where a
           * caller has the ROI list but not the subset that tiles the volume. Anything summing
           * per-region counts has to filter to it, and until this it could only be learned from
           * `Meta` — two more round trips later, and never at all if that query failed. The
           * cost of being wrong is invisible: male-CNS publishes 5,619 regions against 144 that
           * tile, so an unfiltered total is out by a factor of thirty-nine.
           *
           * Discovery still overwrites it, since `Meta` is the documented source and this is the
           * same answer arriving sooner.
           */
          ...(entry.superLevelROIs?.length ? { primaryRois: entry.superLevelROIs } : {}),
          // Filled in by discovery; a status filter with one option is better than none.
          statuses: ['Traced'],
        }
      })
      .sort((a, b) => a.id.localeCompare(b.id))

    for (const info of infos) {
      const existing = this.states.get(info.id)
      /*
       * Re-listing must not un-learn what discovery found. `listDatasets` re-fetches on every
       * call — the Sources panel does exactly that — and a plain overwrite drops the statuses
       * and the primary ROI list back to their listing-time values. The statuses have been
       * carried across for that reason since they existed; `primaryRois` needs it for the same
       * one, and silently more: nothing downstream can tell a missing primary list from a
       * dataset whose regions genuinely all tile.
       */
      if (existing)
        existing.info = {
          ...info,
          statuses: existing.info.statuses,
          ...(existing.info.primaryRois ? { primaryRois: existing.info.primaryRois } : {}),
          // Same reason: `listDatasets` re-fetches on every call and the Sources panel does
          // exactly that, so a merge that dropped this would un-learn it after discovery.
          ...(existing.info.roiSuper ? { roiSuper: existing.info.roiSuper } : {}),
        }
      else this.states.set(info.id, { info })
    }
    this.ordered = infos.map((info) => this.states.get(info.id)!.info)
    // `peekDatasets` answers differently from here on, and a dataset node's "Latest" resolves
    // through it — so anything already inferred against the empty listing is now wrong.
    reportSourceLearned(this.id)
    return this.ordered
  }

  /**
   * The listing if it has landed — and the request that makes it land, the first time
   * somebody peeks and finds nothing.
   *
   * A peek that quietly starts a fetch is the same trade `schemasFor` already takes and for
   * the same reason: `inferOutputs` may not await (invariant 2), so the only way inference
   * ever gets a real answer is to ask for one and be re-run when it arrives. Without it the
   * chain never starts on a fresh session — a dataset node on "Latest" reads its id out of
   * here, so no listing means no dataset id, which means `schemasFor` is never called, which
   * means discovery never runs. Everything downstream then types itself against the canonical
   * seven neuron columns until the *first Run* happens to fetch a listing as a side effect,
   * which is why that run behaved differently from the second.
   *
   * Once per instance, not once per peek: inference runs on every graph mutation, and a
   * failed listing that retried from here would be a request per keystroke. An explicit
   * `listDatasets()` — the Sources panel, a node's `evaluate` — still retries.
   */
  peekDatasets(): DatasetInfo[] | undefined {
    if (!this.ordered && !this.listingRequested) {
      this.listingRequested = true
      // Swallowed: a peek has no caller to report to, and a 401 already goes out on its own
      // channel to the Sources panel.
      void this.listDatasets().catch(() => undefined)
    }
    return this.ordered
  }

  peekDataset(datasetId: string): DatasetInfo | undefined {
    return this.states.get(datasetId)?.info
  }

  /**
   * Per-dataset schemas, synchronously.
   *
   * Returns the canonical schemas until discovery has run, and kicks discovery off in the
   * background. Inference is called on every graph mutation and must never await, so this
   * cannot block — the cost is one extra inference pass once the real schema lands.
   */
  schemasFor(datasetId: string): SourceSchemas {
    const state = this.states.get(datasetId)
    if (state?.schemas) return state.schemas
    /*
     * No state means the listing has not landed yet, which is exactly when discovery is most
     * needed rather than a reason to skip it — `discover` creates the placeholder state
     * itself. This used to bail, and a *pinned* dataset never recovered: a saved graph naming
     * `male-cns:v1.0` has a concrete id at edit time and needs no listing, so nothing else was
     * ever going to ask, and every column picker downstream stayed on the canonical seven.
     */
    void this.discover(datasetId)
    return this.schemas
  }

  /** Learn a dataset's neuron properties and statuses. Idempotent and deduplicated. */
  async discover(datasetId: string, signal?: AbortSignal): Promise<void> {
    const state = this.states.get(datasetId) ?? { info: placeholderInfo(datasetId) }
    this.states.set(datasetId, state)
    if (state.schemas) return
    state.discovering ??= this.runDiscovery(state, datasetId, signal).finally(() => {
      state.discovering = undefined
    })
    return state.discovering
  }

  private async runDiscovery(
    state: DatasetState,
    datasetId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const options = this.options(signal)
    const [meta, sample, statuses] = await Promise.all([
      runCypher(metaCypher(), datasetId, options).catch(() => undefined),
      runCypher(sampleNeuronsCypher(), datasetId, options).catch(() => undefined),
      runCypher(sampleStatusesCypher(), datasetId, options).catch(() => undefined),
    ])

    const declared = parseJsonMap(meta?.data?.[0]?.[0])
    // RETURN order: neuronProperties, primaryRois, superLevelRois, statusDefinitions,
    // voxelSize, voxelUnits, roiHierarchy.
    // voxelSize, voxelUnits.
    state.scale = voxelScale(meta?.data?.[0]?.[4], meta?.data?.[0]?.[5])

    /*
     * The primary ROI list, which is the only set whose per-ROI counts may be summed.
     * `roiInfo` nests, so a neuron's synapses in `LO(R)` are counted again in `OL(R)` — the
     * Profile widget's region bars and hemisphere split both add these up, and without this
     * they would report roughly twice the neuron's real synapse count.
     *
     * Kept off the datasets listing on purpose: `/api/dbmeta/datasets` publishes the whole
     * ROI hierarchy under `ROIs`, and only Meta distinguishes the tiling subset.
     */
    const primaryRois = stringList(meta?.data?.[0]?.[1])
    if (primaryRois.length) state.info = { ...state.info, primaryRois }

    /*
     * The group above each primary region, where the dataset publishes a hierarchy.
     *
     * `m.roiHierarchy` is a JSON *string* in Neo4j — neuprint-python decodes it server-side with
     * `apoc.convert.fromJsonMap`, which this does not depend on, so it arrives raw and is parsed
     * here. Derived after `primaryRois` rather than beside it, because the tree alone cannot say
     * which of its nodes are the ones that tile the volume.
     */
    const roiSuper = superRoisFrom(meta?.data?.[0]?.[6], primaryRois)
    if (Object.keys(roiSuper).length) state.info = { ...state.info, roiSuper }
    const sampled = (sample?.data ?? [])
      .map((row) => row[0])
      .filter(
        (value): value is Record<string, unknown> =>
          Boolean(value) && typeof value === 'object',
      )

    const discovered = discoverNeuronSchema({
      ...(declared ? { declared } : {}),
      sampled,
      rois: state.info.rois,
    })
    state.discovered = discovered
    state.schemas = schemasFor(discovered)

    const seen = (statuses?.data ?? [])
      .map((row) => row[0])
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
    if (seen.length) state.info = { ...state.info, statuses: [...new Set(seen)].sort() }

    // The list handed out by peekDatasets holds the object as it was before discovery, so
    // swap the freshened one in. Unconditional, and that matters: it carries the primary ROI
    // list as well as the statuses now, and a dataset whose status sample came back empty
    // would otherwise keep handing out an info with no primaryRois on it.
    const index = this.ordered?.findIndex((d) => d.id === datasetId) ?? -1
    if (this.ordered && index >= 0) this.ordered[index] = state.info

    // `schemasFor` promised "one extra inference pass once the real schema lands" — this is
    // what actually causes that pass. Without it a column picker offers the canonical seven
    // columns until something unrelated makes the graph change.
    reportSourceLearned(this.id)
  }

  /** Voxels → nanometres for a dataset. Identity until discovery has run. */
  private scaleFor(datasetId: string): VoxelScale {
    return this.states.get(datasetId)?.scale ?? IDENTITY_SCALE
  }

  /**
   * What this dataset's fetched coordinates are in, which is a fact about `Meta` rather than
   * about the geometry.
   *
   * neuPrint returns skeleton and synapse coordinates in dataset voxels, so a scale we could
   * not read leaves them exactly that: voxels, of a size nobody here knows. Naming that is the
   * difference between NBLAST refusing and NBLAST scoring a hemibrain eight times too small,
   * which is well inside the range its matrix finds plausible.
   */
  private unitsFor(datasetId: string): GeometryUnits {
    // Read from the state rather than through `scaleFor`, which coalesces to the identity and
    // so cannot tell "1:1" from "we never found out" — the one distinction this exists for.
    return geometryUnitsFor(this.states.get(datasetId)?.scale)
  }

  /**
   * Units and template space together, from whatever scale this dataset yielded.
   *
   * The pairing rule — and why a dataset in unknown voxels claims no space — is
   * `geometryFrame`'s. This just supplies the units half.
   */
  private frame(datasetId: string): { units: GeometryUnits; space?: string } {
    return geometryFrame(this.id, datasetId, this.unitsFor(datasetId))
  }

  /**
   * The same, for geometry that is in physical nanometres whatever `Meta` said.
   *
   * Precomputed meshes take no voxel scale, so their frame does not depend on a lookup that may
   * have failed — and a dataset can therefore be in its template space for meshes and in
   * unknown voxels for skeletons at the same time. Not a contradiction: two fetches, two
   * provenances.
   */
  private nmFrame(datasetId: string): { units: GeometryUnits; space?: string } {
    return geometryFrame(this.id, datasetId, 'nm')
  }

  /** Extra neuron properties this dataset's queries should request. */
  private extras(datasetId: string): string[] {
    return this.states.get(datasetId)?.discovered?.extras ?? []
  }

  private neuronSchema(datasetId: string): TableSchema {
    return this.states.get(datasetId)?.schemas?.neurons ?? this.schemas.neurons
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  async findNeurons(req: FindNeuronsRequest): Promise<TableValue> {
    // Discovery must settle first: the RETURN clause and the schema are derived from the
    // same `extras` list, and a query built before discovery would return seven columns
    // against a schema expecting more.
    await this.discover(req.datasetId, req.signal)
    throwIfAborted(req.signal)
    // The schema as well as the extras, and off the same discovery: `extras` says what the
    // `RETURN` list carries, and the schema says which of those columns answer `typed`. Handing
    // over only the first left every population filter resolving to nothing and silently
    // dropped, which is a query that returns too many rows and looks right.
    const cypher = findNeuronsCypher(
      req,
      this.extras(req.datasetId),
      this.neuronSchema(req.datasetId),
    )
    const response = await runCypher(cypher, req.datasetId, this.options(req.signal))
    return tableFromCypher(response, this.neuronSchema(req.datasetId), 'neurons')
  }

  /**
   * Every `:Neuron` in a dataset, with every property discovery found.
   *
   * Deliberately unfiltered — no status, no size floor. The Explore widget's promise is that
   * an empty search box shows you the whole dataset, and a hidden `status = "Traced"` would
   * make "everything" quietly mean "everything anyone has finished tracing" (165,122 of
   * male-CNS's 176,422). Measured cost of the honest version: 6.9 MB gzipped, ~5 s, once per
   * dataset per month.
   *
   * `limit: 0` is what makes this the same query as an unconstrained Find Neurons, which is
   * why there is no second Cypher builder to keep in sync.
   */
  async neuronIndex(req: NeuronIndexRequest): Promise<TableValue> {
    // Before the fingerprint, not after: the column list *is* the fingerprint, and discovery
    // is what decides it. Reversing these caches a seven-column table under the twenty-column
    // schema the editor is advertising downstream.
    await this.discover(req.datasetId, req.signal)
    throwIfAborted(req.signal)

    return loadCachedTable({
      key: neuronIndexKey(this.id, req.datasetId),
      fingerprint: this.neuronSchema(req.datasetId)
        .columns.map((c) => c.name)
        .join(','),
      ...(req.refresh ? { refresh: req.refresh } : {}),
      fetch: async () => {
        req.onProgress?.(0.1, 'downloading index')
        const table = await this.findNeurons({
          datasetId: req.datasetId,
          ...(req.signal ? { signal: req.signal } : {}),
        })
        req.onProgress?.(1, `${table.length.toLocaleString()} neurons`)
        return table
      },
    })
  }

  /**
   * One neuron at the coarsest level of detail available, for a thumbnail.
   *
   * Two guard rails, both measured rather than guessed:
   *
   *  - **Multi-resolution only.** A dataset serving `neuroglancer_legacy_mesh` has exactly one
   *    level, so the same call would pull megabytes per row and a 25-row page would be a
   *    hundred-megabyte page. Undefined means "draw a placeholder".
   *  - **A per-body byte cap**, set above every size seen rather than at a percentile. Even
   *    the coarsest level has a long tail — sampled across hemibrain it is 264 bytes at the
   *    median, 14 kB at p90 and 508 kB at the maximum (male-CNS: 7.3 kB, 23 kB, 169 kB) — and
   *    a cap pitched into that tail blanks the giant fibres and tracts, which are both the
   *    heaviest coarse meshes and the ones anyone is looking for. See `THUMBNAIL_MAX_BYTES`.
   *    The manifest carries the size, so a refusal costs no download either way.
   */
  async fetchCoarseGeometry(req: CoarseGeometryRequest): Promise<CoarseGeometry | undefined> {
    const source = await this.meshSourceFor(req.datasetId, req.signal)
    if (!source) return undefined
    const mesh = await fetchCoarseMesh(source, req.neuronId, req.signal ? { signal: req.signal } : {})
    return mesh && { kind: 'mesh', ...mesh }
  }

  async fetchConnectivity(req: ConnectivityRequest): Promise<TableValue> {
    const schema = schemasFor(emptyDiscovered()).connectivity
    if (req.neuronIds.length === 0) return emptyTable(schema)
    const response = await runCypher(
      connectivityCypher(req),
      req.datasetId,
      this.options(req.signal),
    )
    return tableFromCypher(response, schema)
  }

  async fetchPathStep(req: PathStepRequest): Promise<TableValue> {
    if (!req.types?.length && !req.neuronIds?.length) return emptyTable(PATH_STEP_SCHEMA)
    const response = await runCypher(
      pathStepCypher(req),
      req.datasetId,
      this.options(req.signal),
    )
    return tableFromCypher(response, PATH_STEP_SCHEMA)
  }

  async fetchAdjacency(req: AdjacencyRequest): Promise<MatrixValue> {
    if (req.sourceIds.length === 0 || req.targetIds.length === 0) {
      return makeMatrix([], [], new Float64Array(0), 'synapses')
    }
    const response = await runCypher(
      adjacencyCypher(req),
      req.datasetId,
      this.options(req.signal),
    )
    return matrixFromConnections(response, req)
  }

  async fetchRoiCounts(req: RoiCountsRequest): Promise<TableValue> {
    const schema = schemasFor(emptyDiscovered()).roiCounts
    if (req.neuronIds.length === 0) return emptyTable(schema)
    const response = await runCypher(
      roiCountsCypher(req),
      req.datasetId,
      this.options(req.signal),
    )
    return roiCountsFromCypher(response, req.rois)
  }

  /**
   * Per-ROI traced-vs-total synapse counts.
   *
   * Discovery first, and it is load-bearing rather than defensive: the `primary` column is set
   * from `Meta.primaryRois`, which only `runDiscovery` fetches. Answering before it lands would
   * mark every row's summability *unknown* on a fresh session and known on the next call —
   * exactly the "runs twice, answers differently" signature this codebase keeps tripping over.
   *
   * `discover` is idempotent and deduplicated, so the wait is paid once per dataset and is
   * usually already over: a dataset node on the same graph has normally triggered it.
   */
  async fetchRoiCompleteness(req: RoiSummaryRequest): Promise<TableValue> {
    await this.discover(req.datasetId, req.signal)
    throwIfAborted(req.signal)
    const primaryRois = this.states.get(req.datasetId)?.info.primaryRois

    return loadCachedTable({
      key: datasetSummaryKey('roi-completeness', this.id, req.datasetId),
      /*
       * The primary list is in the fingerprint, not just the key. It decides the `primary`
       * column, and discovery can land *after* a first call has already cached a table whose
       * every row says "not known yet" — a mismatch has to be a miss, or that table outlives
       * the knowledge that would fix it and the summable rows never appear.
       */
      fingerprint: primaryRois ? primaryRois.join(',') : 'no-primary-rois',
      fetch: async () => {
        const response = await fetchRoiCompleteness(req.datasetId, this.options(req.signal))
        return roiCompletenessFromResponse(response, { primaryRois })
      },
    })
  }

  /**
   * The neuropil shells, one request per region.
   *
   * **Discovery first, and for the same reason `fetchRoiCompleteness` waits.** Two things come
   * out of it that this cannot be right without: `Meta.primaryRois`, which decides *which*
   * regions to ask for, and `Meta.voxelSize`, which decides what the coordinates mean. Answering
   * before it lands would fetch the wrong set at the wrong scale and look entirely plausible —
   * the shells would be internally consistent and eight times the size of every neuron.
   *
   * Uncached, deliberately. The result is tens of megabytes of geometry and the widget caches
   * something else entirely: it flattens these into three planes of polyline, a few tens of
   * kilobytes, and throws the meshes away. Caching them here would store the expensive form of a
   * value nobody keeps.
   */
  async fetchRoiMeshes(req: RoiMeshRequest): Promise<MeshesValue> {
    await this.discover(req.datasetId, req.signal)
    throwIfAborted(req.signal)
    const state = this.states.get(req.datasetId)
    const info = state?.info

    /*
     * The primary set by default. hemibrain lists 230 regions of which 63 tile the volume and
     * male-CNS 5,619 of which 144 — so asking for "the regions" unqualified would be thousands
     * of multi-megabyte requests to draw every shell inside another one.
     */
    const rois = req.rois ?? info?.primaryRois ?? info?.rois ?? []
    if (rois.length === 0) {
      return {
        kind: 'meshes',
        items: [],
        attributes: emptyTable(ROI_MESH_SCHEMA),
        bounds: EMPTY_BOUNDS,
        ...this.frame(req.datasetId),
      }
    }

    const result = await fetchRoiMeshSet(req.datasetId, rois, state?.scale ?? IDENTITY_SCALE, {
      ...this.options(req.signal),
      ...(req.onProgress ? { onProgress: req.onProgress } : {}),
    })

    const primary = new Set(info?.primaryRois ?? [])
    const rows = result.items.map((item) => ({
      roi: item.id,
      // Unknown is not false: a dataset whose `Meta` never named a primary set should not have
      // every region reported as nested inside another one.
      primary: primary.size > 0 ? primary.has(item.id) : true,
    }))

    return {
      kind: 'meshes',
      items: result.items,
      attributes: tableFromRows(ROI_MESH_SCHEMA, rows),
      bounds: boundsOf(result.items.map((item) => item.positions)),
      ...this.frame(req.datasetId),
    }
  }

  /**
   * Region-to-region connectivity, long form.
   *
   * No discovery needed — nothing here is per-dataset-schema, and the pairs name their own
   * regions. Left as a plain fetch rather than made to match its sibling above, because a wait
   * that buys nothing is a wait.
   */
  async fetchRoiConnectivity(req: RoiSummaryRequest): Promise<TableValue> {
    return loadCachedTable({
      key: datasetSummaryKey('roi-connectivity', this.id, req.datasetId),
      // Nothing per-dataset decides this table's shape, so the schema's own column list is the
      // whole of what could invalidate it.
      fingerprint: ROI_CONNECTIVITY_SCHEMA.columns.map((c) => c.name).join(','),
      fetch: async () => {
        const response = await fetchRoiConnectivity(req.datasetId, this.options(req.signal))
        return roiConnectivityFromResponse(response)
      },
    })
  }

  async rawQuery(req: RawQueryRequest): Promise<TableValue> {
    const response = await runCypher(req.query, req.datasetId, this.options(req.signal))
    return inferTableFromCypher(response)
  }

  // -------------------------------------------------------------------------
  // Morphology
  // -------------------------------------------------------------------------

  async fetchSkeletons(req: GeometryRequest): Promise<SkeletonsValue> {
    await this.discover(req.datasetId, req.signal)
    const scale = this.scaleFor(req.datasetId)
    const schema = schemasFor(emptyDiscovered()).morphology
    if (req.neuronIds.length === 0) {
      return {
        kind: 'skeletons',
        items: [],
        attributes: emptyTable(schema),
        bounds: EMPTY_BOUNDS,
        ...this.frame(req.datasetId),
      }
    }

    /*
     * One request per body, a few at a time — for the bodies not already held.
     *
     * `cachedGeometry` is what makes adding a neuron to a scene cost one request rather than
     * twenty-one: the node above re-runs on any change to its Neurons input, by invariant 4, and
     * asks for the whole list every time. Progress counts against the *missing* list, so a
     * mostly-cached run says `2/2` rather than crawling to `21/21` with nineteen instant steps.
     *
     * The attribute query is not cached and stays one round trip for the whole set — see
     * `fetchNeuronRows`.
     */
    /*
     * Assembly hoisted out of the return, because a partial answer is the same walk over fewer
     * pairs. Writing it twice is what invariant 3's reasoning warns about one layer down: the
     * attribute table and the item list are two halves of one value, and a partial that built
     * them differently would colour the streamed scene by a different rule than the final one.
     */
    const assemble = (
      pairs: ReadonlyArray<[string, SkeletonGeometry]>,
      meta: Map<string, NeuronRow>,
    ): SkeletonsValue => {
      const data: Record<string, ColumnData> = {}
      for (const col of schema.columns) data[col.name] = []
      for (const [neuronId, item] of pairs) {
        pushNeuronRow(data, neuronId, meta.get(neuronId))
        data['points']!.push(item.parents.length)
        data['cableLength']!.push(cableLength(item))
      }
      const items = pairs.map(([, item]) => item)
      return {
        kind: 'skeletons',
        items,
        attributes: makeTable(schema, data),
        bounds: boundsOf(items.map((item) => item.positions)),
        ...this.frame(req.datasetId),
      }
    }

    // Started here so it races the geometry rather than gating it; `readyBefore` is what holds
    // the first publish until it lands. `rows` is only how the partial reads what landed.
    let rows: Map<string, NeuronRow> = new Map()
    const attributesReady = this.fetchNeuronRows(req.datasetId, req.neuronIds, req.signal).then(
      (r) => (rows = r),
    )

    const [, skeletons] = await Promise.all([
      attributesReady,
      cachedGeometry<SkeletonGeometry>({
        ids: req.neuronIds,
        // The voxel scale is folded in because it is applied *before* the geometry is stored: a
        // cached skeleton is already in nanometres, and a dataset whose `Meta` changed scale
        // would otherwise hand back the old one silently.
        key: (id) => `neuprint:${this.id}:${req.datasetId}:skel:${scale.join(',')}:${id}`,
        bytes: (s) => byteLengthOf(s.positions, s.radii, s.parents),
        refresh: req.refresh,
        onFetched: req.onFetched,
        readyBefore: attributesReady,
        onPartial: req.onPartial && ((ordered) => req.onPartial?.(assemble(ordered, rows))),
        fetch: async (missing, deliver) => {
          let fetched = 0
          await mapWithConcurrency(missing, SKELETON_CONCURRENCY, async (neuronId) => {
            throwIfAborted(req.signal)
            const swc = await fetchSkeleton(req.datasetId, neuronId, this.options(req.signal))
            const skeleton = skeletonFromSwc(neuronId, swc)
            // neuPrint returns voxels; the scene is in nanometres so meshes line up.
            scalePositions(skeleton.positions, scale)
            scaleRadii(skeleton.radii, scale)
            /*
             * Counted on *completion*, in a closure. An ordinal handed out when the task was
             * dispatched runs backwards here: six workers start at once and finish in whatever
             * order the network returns, so progress went 0.6 → 0.4 → 0.8 → 0.2 → 1.
             *
             * Fractions rather than counts, because the node calling this does not know how many
             * bodies were asked for.
             */
            req.onProgress?.(++fetched / missing.length, `${fetched}/${missing.length} skeletons`)
            deliver(neuronId, skeleton)
          })
        },
      }),
    ])

    // `ordered` is already in the *requested* order rather than the order the network answered,
    // so a partly-cached batch draws the same way a fresh one does. See `CachedGeometryResult`.
    return assemble(skeletons.ordered, rows)
  }

  async fetchSynapses(req: SynapseRequest): Promise<PointsValue> {
    await this.discover(req.datasetId, req.signal)
    const scale = this.scaleFor(req.datasetId)
    const schema = schemasFor(emptyDiscovered()).synapses
    if (req.neuronIds.length === 0) {
      return {
        kind: 'points',
        positions: new Float32Array(0),
        attributes: emptyTable(schema),
        bounds: EMPTY_BOUNDS,
        ...this.frame(req.datasetId),
      }
    }
    req.onProgress?.(0.15, 'querying')
    const response = await runCypher(
      synapsesCypher(req),
      req.datasetId,
      this.options(req.signal),
    )
    req.onProgress?.(0.7, `${response.data.length} synapses`)

    // RETURN order: neuronId, type, polarity, x, y, z, confidence.
    const positions = new Float32Array(response.data.length * 3)
    const data: Record<string, ColumnData> = {
      neuronId: [],
      type: [],
      polarity: [],
      confidence: [],
    }
    response.data.forEach((row, i) => {
      positions[i * 3] = (Number(row[3]) || 0) * scale[0]
      positions[i * 3 + 1] = (Number(row[4]) || 0) * scale[1]
      positions[i * 3 + 2] = (Number(row[5]) || 0) * scale[2]
      data['neuronId']!.push(Number(row[0]))
      data['type']!.push(row[1] === null || row[1] === undefined ? null : String(row[1]))
      data['polarity']!.push(row[2] === null || row[2] === undefined ? null : String(row[2]))
      data['confidence']!.push(Number(row[6]))
    })

    return {
      kind: 'points',
      positions,
      attributes: makeTable(schema, data),
      bounds: boundsOf([positions]),
      ...this.frame(req.datasetId),
    }
  }

  /**
   * Meshes, read straight from the dataset's neuroglancer bucket.
   *
   * Nothing here touches neuPrint except the one call that asks *where* the meshes are.
   * That matters: the buckets need no token, and three of the four datasets serve them with
   * open CORS, so meshes work in a deployed build even where the Cypher API cannot reach.
   *
   * Detail is chosen by fitting a triangle budget rather than fixed, because the spread is
   * enormous — one hemibrain neuron is 2.0 MB at the finest level and 10.8 kB at the
   * coarsest. `lodNote` carries which level was used so the viewer can say so instead of
   * quietly showing a blob.
   */
  async fetchMeshes(req: GeometryRequest): Promise<MeshesValue> {
    const schema = schemasFor(emptyDiscovered()).morphology
    if (req.neuronIds.length === 0) {
      return {
        kind: 'meshes',
        items: [],
        attributes: emptyTable(schema),
        bounds: EMPTY_BOUNDS,
        // Precomputed meshes arrive in physical nanometres and take no voxel scale, so unlike
        // every other geometry here their frame does not depend on what `Meta` said.
        ...this.nmFrame(req.datasetId),
      }
    }

    const source = await this.meshSourceFor(req.datasetId, req.signal)
    if (!source) {
      throw new Error(
        `${req.datasetId} does not publish a mesh source. Only some neuPrint datasets do — ` +
          `hemibrain, MANC, optic-lobe and male-CNS work.`,
      )
    }

    /** Same two halves from the same walk, for a partial and for the final answer alike. */
    const assemble = (
      meshes: readonly MeshResult[],
      meta: Map<string, NeuronRow>,
      detail?: { lod: number; levels: number; triangles: number },
    ): MeshesValue => {
      const data: Record<string, ColumnData> = {}
      for (const col of schema.columns) data[col.name] = []
      for (const mesh of meshes) {
        pushNeuronRow(data, mesh.neuronId, meta.get(mesh.neuronId))
        // `points` is vertices here, matching what a mesh actually has.
        data['points']!.push(mesh.positions.length / 3)
        data['cableLength']!.push(null)
      }
      return {
        kind: 'meshes',
        items: meshes.map((mesh) => ({
          id: mesh.neuronId,
          positions: mesh.positions,
          indices: mesh.indices,
        })),
        attributes: makeTable(schema, data),
        bounds: boundsOf(meshes.map((mesh) => mesh.positions)),
        ...(detail ? { detail } : {}),
        ...this.nmFrame(req.datasetId),
      }
    }

    // Raced rather than awaited first, and held by `readyBefore` — see `fetchSkeletons`.
    let rows: Map<string, NeuronRow> = new Map()
    const attributesReady = this.fetchNeuronRows(req.datasetId, req.neuronIds, req.signal).then(
      (r) => (rows = r),
    )

    const [, result] = await Promise.all([
      attributesReady,
      fetchMeshes(source, req.neuronIds, {
        ...(req.signal ? { signal: req.signal } : {}),
        ...(req.refresh ? { refresh: true } : {}),
        ...(req.onFetched ? { onFetched: req.onFetched } : {}),
        /*
         * No `detail` on a partial. The caption reads "level 3 of 4 · 1.4M triangles", and the
         * triangle count is only true of the whole batch — a growing one would tick upward and
         * read as the level changing under the viewer, which is the one thing that caption exists
         * to rule out. It arrives with the complete answer.
         */
        readyBefore: attributesReady,
        onPartial: req.onPartial && ((meshes) => req.onPartial?.(assemble(meshes, rows))),
        triangleBudget: req.triangleBudget ?? DEFAULT_TRIANGLE_BUDGET,
        ...(req.onProgress ? { onProgress: meshProgress(req.onProgress) } : {}),
      }),
    ])

    return assemble(
      result.meshes,
      rows,
      result.lod !== undefined && result.levels !== undefined
        ? { lod: result.lod, levels: result.levels, triangles: result.triangles }
        : undefined,
    )
  }

  /** Per-dataset scratch space, created on first use. Everything cached per dataset uses it. */
  private stateFor(datasetId: string): DatasetState {
    const existing = this.states.get(datasetId)
    if (existing) return existing
    const created: DatasetState = { info: placeholderInfo(datasetId) }
    this.states.set(datasetId, created)
    return created
  }

  /**
   * The dataset's published neuroglancer state.
   *
   * Cached per dataset, the failure included, because the node that asks is `cheap`: it
   * re-runs on every restyle, and a dataset with no state would otherwise re-request on
   * every colour change. `null` is stored for "asked, there isn't one" and returned as
   * `undefined`, which is what the interface promises.
   */
  async fetchViewerScene(req: ViewerSceneRequest): Promise<NgScene | undefined> {
    return (await this.ngState(req.datasetId, req.signal)) ?? undefined
  }

  /**
   * The dataset's published neuroglancer document, fetched at most once.
   *
   * Both the viewer scene and the mesh source come out of this one file — 38 kB and 38
   * layers on male-CNS — so it is resolved here rather than in each consumer, or a graph
   * carrying both a Meshes node and a Neuroglancer node would download it twice.
   */
  private async ngState(datasetId: string, signal?: AbortSignal): Promise<NgScene | null> {
    const state = this.stateFor(datasetId)
    if (state.scene !== undefined) return state.scene

    state.sceneResolving ??= fetchNgState(datasetId, this.options(signal))
      .catch(() => null)
      .then((resolved) => {
        state.scene = resolved
        return resolved
      })
      .finally(() => {
        state.sceneResolving = undefined
      })
    return state.sceneResolving
  }

  /** Where a dataset's meshes live. Resolved once and cached, including the "none" answer. */
  private async meshSourceFor(
    datasetId: string,
    signal?: AbortSignal,
  ): Promise<MeshSource | null> {
    const state = this.stateFor(datasetId)
    if (state.meshSource !== undefined) return state.meshSource

    state.meshResolving ??= (async () => {
      const published = await this.ngState(datasetId, signal)
      const ref = published ? meshSourceFromState(published, datasetId) : undefined
      if (!ref) return null
      return openMeshSource(ref.url, { ...(signal ? { signal } : {}) }).catch(() => null)
    })()
      .then((resolved) => {
        state.meshSource = resolved
        return resolved
      })
      .finally(() => {
        state.meshResolving = undefined
      })
    return state.meshResolving
  }

  /** neuronId -> the few neuron columns morphology attributes need. */
  private async fetchNeuronRows(
    datasetId: string,
    neuronIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<Map<string, NeuronRow>> {
    const out = new Map<string, NeuronRow>()
    if (neuronIds.length === 0) return out
    const cypher = [
      'MATCH (n:Neuron)',
      `WHERE n.bodyId IN ${idList(neuronIds)}`,
      'RETURN n.bodyId, n.type, n.instance, n.status, n.size',
    ].join('\n')
    const response = await runCypher(cypher, datasetId, this.options(signal))
    for (const row of response.data) {
      out.set(idKey(row[0]), {
        type: row[1] === null || row[1] === undefined ? null : String(row[1]),
        instance: row[2] === null || row[2] === undefined ? null : String(row[2]),
        status: row[3] === null || row[3] === undefined ? null : String(row[3]),
        size: row[4] === null || row[4] === undefined ? null : Number(row[4]),
      })
    }
    return out
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


/** `hemibrain:v1.2.1` -> label "hemibrain", version "v1.2.1". */
export function splitDatasetId(id: string): [string, string | undefined] {
  const at = id.indexOf(':')
  return at === -1 ? [id, undefined] : [id.slice(0, at), id.slice(at + 1)]
}

function placeholderInfo(datasetId: string): DatasetInfo {
  const [label, version] = splitDatasetId(datasetId)
  return {
    id: datasetId,
    label,
    ...(version ? { version } : {}),
    rois: [],
    statuses: ['Traced'],
  }
}

/**
 * A Meta property that is a list of strings.
 *
 * Tolerant of both shapes because neuPrint is inconsistent about them: some list properties
 * come back as real JSON arrays and others as a JSON string holding one. Anything else — a
 * null, a scalar, a list of numbers — yields an empty list, which callers read as "not known"
 * rather than "known to be empty".
 */
function stringList(raw: unknown): string[] {
  const value = typeof raw === 'string' ? tryParse(raw) : raw
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
}

function tryParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function parseJsonMap(raw: unknown): Record<string, string> | undefined {
  if (!raw) return undefined
  if (typeof raw === 'object') return raw as Record<string, string>
  if (typeof raw !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : undefined
  } catch {
    return undefined
  }
}

function emptyDiscovered(): DiscoveredSchema {
  return discoverNeuronSchema({})
}

/**
 * Pivot a connection list into a matrix.
 *
 * Rows and columns keep the *requested* order rather than the order the database happened
 * to return, so an adjacency matrix lines up with the neuron table it came from and a
 * missing pair reads as a zero rather than shifting the grid.
 */
function matrixFromConnections(response: CypherResponse, req: AdjacencyRequest): MatrixValue {
  /*
   * Both endpoint ids are stringified once, here, and indexed by row below.
   *
   * The label pass and the matrix pass each need the same two keys, and every id neuPrint
   * sends is a JSON number — so doing it per pass is two to four `String()` allocations per
   * row where two will do. On a 2000x2000 adjacency that is a few hundred thousand transient
   * strings. Two pointer arrays are both cheaper and smaller than the duplicates they replace.
   */
  const rows = response.data
  const srcKeys = new Array<string>(rows.length)
  const dstKeys = new Array<string>(rows.length)
  const label = new Map<string, string>()
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    const src = (srcKeys[i] = idKey(row[0]))
    const dst = (dstKeys[i] = idKey(row[2]))
    if (typeof row[1] === 'string') label.set(src, row[1])
    if (typeof row[3] === 'string') label.set(dst, row[3])
  }

  if (req.groupByType) {
    const key = (id: string) => label.get(id) ?? id
    const rowKeys = [...new Set(req.sourceIds.map(key))]
    const colKeys = [...new Set(req.targetIds.map(key))]
    const rowIndex = new Map(rowKeys.map((k, i) => [k, i]))
    const colIndex = new Map(colKeys.map((k, i) => [k, i]))
    const values = new Float64Array(rowKeys.length * colKeys.length)
    for (let i = 0; i < rows.length; i++) {
      const r = rowIndex.get(key(srcKeys[i]!))
      const c = colIndex.get(key(dstKeys[i]!))
      if (r === undefined || c === undefined) continue
      values[r * colKeys.length + c] =
        (values[r * colKeys.length + c] ?? 0) + Number(rows[i]![4] ?? 0)
    }
    return makeMatrix(rowKeys, colKeys, values, 'synapses')
  }

  const rowIndex = new Map(req.sourceIds.map((id, i) => [id, i]))
  const colIndex = new Map(req.targetIds.map((id, i) => [id, i]))
  const values = new Float64Array(req.sourceIds.length * req.targetIds.length)
  for (let i = 0; i < rows.length; i++) {
    const r = rowIndex.get(srcKeys[i]!)
    const c = colIndex.get(dstKeys[i]!)
    if (r === undefined || c === undefined) continue
    values[r * req.targetIds.length + c] = Number(rows[i]![4] ?? 0)
  }
  const name = (id: string) => {
    const type = label.get(id)
    return type ? `${type} ${id}` : id
  }
  return makeMatrix(req.sourceIds.map(name), req.targetIds.map(name), values, 'synapses')
}
