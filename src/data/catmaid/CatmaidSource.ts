/**
 * CATMAID as a Coda `DataSource`.
 *
 * The third backend, and the one whose *shape* differs most. neuPrint answers queries against a
 * graph database and CAVE answers them against a materialized snapshot; CATMAID is a manual
 * tracing environment, so what it holds is a few thousand carefully reconstructed skeletons and a
 * bag of human-written annotations, with no cell-type field anywhere. Three consequences run
 * through this file:
 *
 *  1. **Labels are derived, not read.** See `annotations.ts`. A `type` column exists because
 *     instances meta-annotate their type labels, and that is discovered rather than assumed.
 *  2. **The index is small and search is local.** All 5,601 skeletons of VFB's public FAFB, with
 *     names and annotations, are 1.42 MB and 2.0 s — cheaper than neuPrint's 6.9 MB. And
 *     `annotations/query-targets` matches names by *substring*, not regex (`^LC[0-9]+` matches
 *     nothing), so there is no server-side search worth pushing down. This is `CaveSource`'s
 *     arrangement for `CaveSource`'s reason, and `neuronFilter.ts` gets its third consumer.
 *  3. **Skeletons are enormous.** 0.9–1.3 MB each, uncompressed, because the server does not
 *     gzip — one FAFB antennal-lobe PN is 16,840 nodes where a CAVE L2 skeleton is ~150. That is
 *     the one place this backend needs a ceiling the others do not.
 */

import { ID_COLUMN_NAME, numericIds } from '../../core/ids'
import type {
  CellValue,
  GeometryUnits,
  MatrixValue,
  MeshesValue,
  MeshGeometry,
  PointsValue,
  SkeletonGeometry,
  SkeletonsValue,
  TableValue,
} from '../../core/values'
import {
  boundsOf,
  cableLength,
  getRow,
  makeMatrix,
  selectRows,
  tableFromRows,
} from '../../core/values'
import { geometryFrame } from '../transforms/spaces'
import { mapWithConcurrency } from '../concurrency'
import { compileLabelMatch, compileRegex, refuseUnfilterable } from '../neuronFilter'
import { loadCachedTable, neuronIndexKey } from '../neuronIndex'
import { byteLengthOf, cachedGeometry } from '../geometryCache'
import type { NeuronIndexRequest } from '../neuronIndex'
import type {
  AdjacencyRequest,
  ConnectivityRequest,
  DataSource,
  DatasetInfo,
  FindNeuronsRequest,
  GeometryRequest,
  RoiMeshRequest,
  SourceCapabilities,
  SourceSchemas,
  SynapseRequest,
} from '../source'
import { ROI_MESH_SCHEMA, reportSourceLearned, throwIfAborted } from '../source'
import type { AnnotationListResponse, CatmaidProject, CompactSkeleton } from './api'
import type { SkeletonSummary } from './api'
import {
  annotationList,
  compactSkeleton,
  connectivityMatrix,
  connectorLinks,
  listProjects,
  listSkeletons,
  listVolumes,
  skeletonConnectivity,
  skeletonSummaries,
  synapseWeight,
  volumeDetail,
} from './api'
import type { CatmaidLabels } from './annotations'
import { labelsForSkeleton, readVocabulary } from './annotations'
import { CATMAID_SCHEMAS } from './schema'
import { parseX3dMesh } from './x3d'

/**
 * How many skeletons one `annotationlist` POST asks about.
 *
 * Measured: 2,000 skeletons is ~520 kB and 0.7 s, and the whole of FAFB is three such calls.
 * Larger would work and buys nothing; smaller triples the round trips for a fixed payload.
 */
const ANNOTATION_CHUNK = 2000

/**
 * How many skeleton fetches run at once.
 *
 * Each is an independent GET of roughly a megabyte, so this is the number that decides the wait
 * rather than the total bytes. Kept at the low end of what a shared public instance should be
 * asked for: these are somebody's server and a tracing community's, not a CDN.
 */
const SKELETON_CONCURRENCY = 8

/**
 * The most skeletons one request will fetch.
 *
 * Set by transfer rather than by draw cost: 200 neurons is roughly 200 MB uncompressed and a
 * couple of minutes. It is far below the 500 a source publishing ready-made skeletons allows and
 * far above CAVE's graphene-mesh 20, which is the honest middle for a payload this size. The
 * ceiling moves the day the deployment turns on gzip — see `docs/catmaid_vfb.md`.
 */
export const MAX_CATMAID_SKELETONS = 200

const CATMAID_CAPABILITIES: SourceCapabilities = {
  rawQuery: false,
  skeletons: true,
  /*
   * No neuron meshes. CATMAID stores skeletons, not segmentations — its `volumes` are neuropil
   * shells, which is `roiMeshes` below and a different question. A source claiming this would
   * make the Meshes node offer something nothing can answer.
   */
  meshes: false,
  synapses: true,
  neuronIndex: true,
  /* No aggregated hop endpoint, so the Paths node declines rather than doing it client-side. */
  paths: false,
  viewerScene: false,
  /* No per-region completeness or region-to-region table is published. */
  roiSummary: false,
  roiCounts: false,
  roiMeshes: true,
}

interface ProjectState {
  /** Every skeleton id in the project — needed before the labels, and by itself. */
  skeletonIds?: Promise<number[]>
  /** The whole-instance annotation index, once built. */
  labels?: Promise<LabelIndex>
  volumes?: Promise<VolumeEntry[]>
}

interface VolumeEntry {
  id: number
  name: string
  comment: string | null
}

/**
 * Everything the neuron table needs about labels, **already derived**.
 *
 * The raw `AnnotationListResponse` is deliberately *not* kept. `labelsForSkeleton` allocates a
 * `Set` and joins a string per call, and four call sites wanted labels — one of them once per
 * synapse *link*, which is tens of thousands of times for a densely traced FAFB neuron. Deriving
 * once here makes every one of them a map lookup, and it lets the response — 5,601 skeleton
 * entries, ~6,000 annotation names and the metaannotation graph — be collected rather than held
 * for the life of the tab beside the neuron table built from it.
 */
interface LabelIndex {
  skeletonIds: number[]
  labels: Map<number, CatmaidLabels>
}

/** What a skeleton the annotation graph has never heard of gets. Shared, so it is one object. */
/**
 * One `compact-detail` response into geometry.
 *
 * Lifted out of `fetchSkeletons` so the session cache can hold the *result* rather than the
 * response — see the note at its call site. CATMAID names parents by **node id**, and a skeleton
 * is an array in no particular order, so the tree is rebuilt through an id→index map; emitting
 * parents as ids would satisfy the type and break every consumer that walks the array once, the
 * SWC writer included.
 */
function decodeCompactSkeleton(id: string, skeleton: CompactSkeleton): SkeletonGeometry {
  const nodes = skeleton[0]
  const positions = new Float32Array(nodes.length * 3)
  const radii = new Float32Array(nodes.length)
  const parents = new Int32Array(nodes.length)

  const position = new Map<number, number>()
  nodes.forEach((node, i) => position.set(node[0], i))
  nodes.forEach((node, i) => {
    positions[i * 3] = node[3]
    positions[i * 3 + 1] = node[4]
    positions[i * 3 + 2] = node[5]
    // −1 means "unset" in CATMAID, and a negative radius drawn as a tube is a spike.
    radii[i] = node[6] > 0 ? node[6] : 0
    const parent = node[1]
    parents[i] = parent === null ? -1 : (position.get(parent) ?? -1)
  })
  return { id, positions, radii, parents }
}

const EMPTY_LABELS: CatmaidLabels = {
  name: null,
  type: null,
  instance: null,
  ontology: null,
  annotations: null,
}

export class CatmaidSource implements DataSource {
  readonly id: string
  readonly label: string
  readonly description =
    'A CATMAID instance: manually traced skeletons with free-text names and annotations.'
  readonly capabilities = CATMAID_CAPABILITIES
  readonly schemas: SourceSchemas = CATMAID_SCHEMAS

  private readonly server: string
  private projects: DatasetInfo[] | undefined
  private listing: Promise<DatasetInfo[]> | undefined
  private listingRequested = false
  private readonly states = new Map<string, ProjectState>()

  constructor(server: string, id: string, label: string) {
    this.server = server
    this.id = id
    this.label = label
  }

  /**
   * Memoise a promise on a slot, **dropping it if it rejects**.
   *
   * One helper rather than three spellings of `slot ??= run()`, because the three had already
   * diverged on the half that matters: a plain `??=` caches a *rejection* and replays it for the
   * life of the tab, so one failed listing on a flaky connection means the dataset picker stays
   * empty until a reload. Keeping the resolved value is the whole point; keeping the failure is
   * never what anybody wanted.
   */
  private once<T>(
    read: () => Promise<T> | undefined,
    write: (value: Promise<T> | undefined) => void,
    run: () => Promise<T>,
  ): Promise<T> {
    const held = read()
    if (held) return held
    const started = run().catch((error: unknown) => {
      write(undefined)
      throw error
    })
    write(started)
    return started
  }

  // -------------------------------------------------------------------------
  // Datasets — a CATMAID *project*
  // -------------------------------------------------------------------------

  async listDatasets(signal?: AbortSignal): Promise<DatasetInfo[]> {
    return this.once(
      () => this.listing,
      (value) => {
        this.listing = value
      },
      () => this.runListing(signal),
    )
  }

  /**
   * Cached, synchronous, and it **starts the listing the first time it cannot answer** —
   * `peekDatasets`' contract on every source here, and for its reason: inference reads this
   * without awaiting, so a peek that only ever said "I don't know" would leave a dataset node on
   * "Latest" publishing a type with no dataset id in it until somebody pressed Run.
   *
   * Once per instance, not once per peek: inference runs on every graph mutation, and a failed
   * listing retried from there is a request per keystroke.
   */
  peekDatasets(): DatasetInfo[] | undefined {
    if (!this.projects && !this.listingRequested) {
      this.listingRequested = true
      void this.listDatasets().catch(() => undefined)
    }
    return this.projects
  }

  peekDataset(datasetId: string): DatasetInfo | undefined {
    return this.peekDatasets()?.find((dataset) => dataset.id === datasetId)
  }

  private async runListing(signal?: AbortSignal): Promise<DatasetInfo[]> {
    const projects = await listProjects(this.server, signal ? { signal } : {})
    this.projects = projects.map((project) => this.describeProject(project))
    reportSourceLearned(this.id)
    return this.projects
  }

  /**
   * A project as a `DatasetInfo`.
   *
   * The id is the **project id as text**, which is per-instance rather than portable — project 1
   * is FAFB here and something else on a lab server. That is honest: CATMAID is software rather
   * than a service, so there is no cross-instance dataset name to use, and the source id already
   * carries which server this is.
   *
   * `statuses` is empty because CATMAID has none, and `rois` is filled from the volume list only
   * once something asks — a listing that fetched 80 volumes to name them would make opening the
   * dataset picker an expensive act.
   */
  /**
   * Units and template space together. Always nanometres here; see `geometryFrame` for why the
   * two travel as one and when the space half is withheld.
   */
  private frame(datasetId: string): { units: GeometryUnits; space?: string } {
    return geometryFrame(this.id, datasetId, 'nm')
  }

  private describeProject(project: CatmaidProject): DatasetInfo {
    return {
      id: String(project.id),
      label: project.title,
      ...(project.comment ? { description: project.comment } : {}),
      rois: [],
      statuses: [],
    }
  }

  private state(datasetId: string): ProjectState {
    let state = this.states.get(datasetId)
    if (!state) {
      state = {}
      this.states.set(datasetId, state)
    }
    return state
  }

  private projectId(datasetId: string): number {
    const id = Number(datasetId)
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error(
        `"${datasetId}" is not a CATMAID project id. A CATMAID dataset is a project, numbered per instance.`,
      )
    }
    return id
  }

  // -------------------------------------------------------------------------
  // The neuron index, which is what everything else is answered from
  // -------------------------------------------------------------------------

  async neuronIndex(req: NeuronIndexRequest): Promise<TableValue> {
    const schema = this.schemas.neurons
    return loadCachedTable({
      key: neuronIndexKey(this.id, req.datasetId),
      fingerprint: schema.columns.map((column) => column.name).join(','),
      ...(req.refresh ? { refresh: req.refresh } : {}),
      fetch: () => this.buildIndex(req),
    })
  }

  /**
   * Every skeleton, with its name, derived type and remaining annotations.
   *
   * Three phases, which is what the progress bar reports: the skeleton id list, the annotation
   * graph in chunks, then one summary call for node counts and cable lengths.
   *
   * That last one is worth its bytes rather than deferred to `findNeurons`. Measured on FAFB it
   * is a single POST — 1.77 MB, 0.72 s for all 5,601 — against 1.42 MB for the labels, so it
   * roughly doubles a download that is cached for a month and paid once. The alternative was
   * declaring `nodes` and `cableLength` and leaving them null in the index, which is precisely
   * what `CATMAID_NEURON_SCHEMA` refuses to do for `status`: a column that is always empty is
   * worse than an absent one, because every picker downstream offers it.
   */
  private async buildIndex(req: NeuronIndexRequest): Promise<TableValue> {
    const projectId = this.projectId(req.datasetId)
    const options = req.signal ? { signal: req.signal } : {}
    req.onProgress?.(0.05, 'skeletons')

    /*
     * The id list first, then the two legs that need it **together**. The annotation graph is
     * ~1.4 MB over three POSTs and the summaries a single 1.8 MB POST, and neither reads the
     * other — awaiting them in turn parked 0.7 s behind 2.0 s for nothing. `CaveSource` makes the
     * same call about its own two legs ("5.76 s to 4.04 s").
     */
    const skeletonIds = await this.skeletonIds(req.datasetId, options)
    throwIfAborted(req.signal)
    const [index, summaries] = await Promise.all([
      this.labelIndex(req.datasetId, options, req.onProgress),
      // A missing roll-up is a null column, not a failed index: the names and types are the
      // answer somebody asked for, and refusing the lot because a secondary call was unavailable
      // is the `out.profile` failure this codebase already records.
      skeletonSummaries(this.server, projectId, skeletonIds, options).catch(
        () => ({}) as Record<string, SkeletonSummary>,
      ),
    ])
    throwIfAborted(req.signal)

    const rows: Array<Record<string, CellValue>> = []
    for (const skeletonId of index.skeletonIds) {
      const labels = index.labels.get(skeletonId) ?? EMPTY_LABELS
      const summary = summaries[String(skeletonId)]
      rows.push({
        [ID_COLUMN_NAME]: skeletonId,
        name: labels.name,
        type: labels.type,
        instance: labels.instance,
        ontologyId: labels.ontology,
        annotations: labels.annotations,
        nodes: summary?.num_nodes ?? null,
        cableLength: summary?.cable_length ?? null,
      })
    }
    req.onProgress?.(1, 'ready')
    return tableFromRows(this.schemas.neurons, rows, 'neurons')
  }

  /** Every skeleton id in the project, fetched once. Both index legs start from it. */
  private skeletonIds(datasetId: string, options: { signal?: AbortSignal }): Promise<number[]> {
    const state = this.state(datasetId)
    return this.once(
      () => state.skeletonIds,
      (value) => {
        state.skeletonIds = value
      },
      () => listSkeletons(this.server, this.projectId(datasetId), undefined, options),
    )
  }

  /** The annotation graph for the whole project, fetched once and derived once. */
  private labelIndex(
    datasetId: string,
    options: { signal?: AbortSignal },
    onProgress?: (fraction: number, note?: string) => void,
  ): Promise<LabelIndex> {
    const state = this.state(datasetId)
    return this.once(
      () => state.labels,
      (value) => {
        state.labels = value
      },
      () => this.runLabelIndex(datasetId, options, onProgress),
    )
  }

  private async runLabelIndex(
    datasetId: string,
    options: { signal?: AbortSignal },
    onProgress?: (fraction: number, note?: string) => void,
  ): Promise<LabelIndex> {
    const projectId = this.projectId(datasetId)
    const skeletonIds = await this.skeletonIds(datasetId, options)

    const chunks: number[][] = []
    for (let offset = 0; offset < skeletonIds.length; offset += ANNOTATION_CHUNK) {
      chunks.push(skeletonIds.slice(offset, offset + ANNOTATION_CHUNK))
    }

    /*
     * Concurrently, because the chunks ask about disjoint id sets and are merged by assignment —
     * three sequential 0.7 s calls for what one round trip's worth of wall clock buys.
     *
     * `Promise.all` rather than `mapWithConcurrency`, deliberately: that one turns a per-item
     * failure into `undefined`, which for a chunk means two thousand neurons silently arriving
     * with no labels at all. A whole index is the wrong granularity to degrade at. What is given
     * up is a monotonic progress bar — it now reports chunks as they land.
     */
    let landed = 0
    const parts = await Promise.all(
      chunks.map(async (chunk) => {
        const part = await annotationList(this.server, projectId, chunk, options)
        landed += chunk.length
        // The id list was the first tenth; leave the last for deriving and building the table.
        onProgress?.(0.1 + (0.8 * landed) / skeletonIds.length, 'annotations')
        return part
      }),
    )

    const merged: AnnotationListResponse = {
      skeletons: {},
      annotations: {},
      neuronnames: {},
      metaannotations: {},
    }
    for (const part of parts) {
      Object.assign(merged.skeletons, part.skeletons)
      Object.assign(merged.annotations, part.annotations)
      Object.assign(merged.neuronnames, part.neuronnames)
      Object.assign(merged.metaannotations, part.metaannotations)
    }

    /*
     * Derived here, once, and the raw response dropped — see `LabelIndex`. Every consumer wants
     * a lookup rather than a walk, and the one that wanted `.type` per synapse link was paying
     * a `Set` allocation and a string join for it.
     */
    const vocabulary = readVocabulary(merged)
    const labels = new Map<number, CatmaidLabels>()
    for (const skeletonId of skeletonIds) {
      labels.set(skeletonId, labelsForSkeleton(merged, vocabulary, skeletonId))
    }
    return { skeletonIds, labels }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /**
   * Filtered locally off the index, for the reason in the module note: CATMAID's own name search
   * is a case-insensitive substring, so pushing a pattern down would answer a different question
   * from every other backend and would do it silently.
   *
   * **`req.statuses` is ignored outright.** CATMAID publishes no statuses, so `DatasetInfo`
   * carries none and the picker offers only `Any` — but a node's stored default survives into the
   * request regardless, and a source that filtered on it would drop every row for a value nobody
   * chose. That failure is live on CAVE today; it is not repeated here.
   *
   * **`req.roi` is refused rather than ignored**, and the difference is that somebody chose it.
   * `volumeList` fills `DatasetInfo.rois` with eighty real neuropils so the ROIs viewer can draw
   * them, which also populates Find Neurons' **In ROI** — and answering "which skeletons are in
   * this volume" needs a spatial query CATMAID has no bulk endpoint for. Silently ignoring it
   * returns a result that is too *large* and looks exactly like a correct one. `minSize` goes the
   * same way: it means a voxel count, and CATMAID measures a neuron in nodes and cable.
   */
  async findNeurons(req: FindNeuronsRequest): Promise<TableValue> {
    const index = await this.neuronIndex({
      datasetId: req.datasetId,
      ...(req.signal ? { signal: req.signal } : {}),
    })

    refuseUnfilterable(req, { size: false, roi: false }, 'CATMAID')

    const typeRe = compileRegex(req.typePattern, 'type')
    const instanceRe = compileRegex(req.instancePattern, 'instance')
    const labelMatch = compileLabelMatch(req.labels)
    const wanted = req.neuronIds ? new Set(numericIds(req.neuronIds)) : undefined

    /*
     * Columns hoisted and the row built **only** for `labelMatch`, which is the one filter that
     * needs a whole row. `CaveSource` documents the same fix: materialising every row first cost
     * it 139,255 objects per query, "discarded, overwhelmingly, by the very next line".
     *
     * And the result is `selectRows` rather than a rebuilt table, which matters beyond the
     * allocation: `tableFromRows` mints a fresh `TableValue`, throwing away the object identity
     * that `searchIndexFor` and `statsFor` key their `WeakMap`s on.
     */
    const ids = index.data[ID_COLUMN_NAME] ?? []
    const types = index.data.type ?? []
    const instances = index.data.instance ?? []

    const matched: number[] = []
    for (let i = 0; i < index.length; i += 1) {
      if (wanted && !wanted.has(Number(ids[i]))) continue
      if (typeRe) {
        const value = types[i]
        if (typeof value !== 'string' || !typeRe.test(value)) continue
      }
      if (instanceRe) {
        const value = instances[i]
        if (typeof value !== 'string' || !instanceRe.test(value)) continue
      }
      if (labelMatch && !labelMatch(getRow(index, i))) continue
      matched.push(i)
      if (req.limit && matched.length >= req.limit) break
    }

    return selectRows(index, matched)
  }

  /**
   * Partners, query-relative, exactly as neuPrint's is.
   *
   * The weight is `synapseWeight` — the **sum** of CATMAID's confidence-bucketed array. See the
   * note on `ConnectivityResponse`; taking the last bucket looks right and undercounts by about a
   * percent.
   */
  async fetchConnectivity(req: ConnectivityRequest): Promise<TableValue> {
    const projectId = this.projectId(req.datasetId)
    const options = req.signal ? { signal: req.signal } : {}
    const queried = numericIds(req.neuronIds)
    if (queried.length === 0) return tableFromRows(this.schemas.connectivity, [])

    const response = await skeletonConnectivity(this.server, projectId, queried, options)
    const side = req.direction === 'outputs' ? response.outgoing : response.incoming
    const labels = await this.labelIndex(req.datasetId, options)

    const rows: Array<Record<string, CellValue>> = []
    for (const [partnerId, entry] of Object.entries(side ?? {})) {
      for (const [queryId, byConfidence] of Object.entries(entry.skids)) {
        const weight = synapseWeight(byConfidence)
        if (req.minWeight && weight < req.minWeight) continue
        rows.push({
          [ID_COLUMN_NAME]: Number(queryId),
          neuronType: labels.labels.get(Number(queryId))?.type ?? null,
          partnerId: Number(partnerId),
          partnerType: labels.labels.get(Number(partnerId))?.type ?? null,
          weight,
        })
      }
    }
    return tableFromRows(this.schemas.connectivity, rows)
  }

  async fetchAdjacency(req: AdjacencyRequest): Promise<MatrixValue> {
    const projectId = this.projectId(req.datasetId)
    const options = req.signal ? { signal: req.signal } : {}
    const rows = numericIds(req.sourceIds)
    const columns = numericIds(req.targetIds)
    const matrix = await connectivityMatrix(this.server, projectId, rows, columns, options)
    const labels = await this.labelIndex(req.datasetId, options)

    const label = (id: number): string =>
      req.groupByType ? (labels.labels.get(id)?.type ?? String(id)) : String(id)

    const values = new Float64Array(rows.length * columns.length)
    rows.forEach((source, r) => {
      const line = matrix[String(source)] ?? {}
      columns.forEach((target, c) => {
        values[r * columns.length + c] = line[String(target)] ?? 0
      })
    })
    return makeMatrix(rows.map(label), columns.map(label), values, 'synapses', 'count')
  }

  // -------------------------------------------------------------------------
  // Morphology
  // -------------------------------------------------------------------------

  async fetchSkeletons(req: GeometryRequest): Promise<SkeletonsValue> {
    const projectId = this.projectId(req.datasetId)
    const options = req.signal ? { signal: req.signal } : {}
    const ids = numericIds(req.neuronIds)
    if (ids.length > MAX_CATMAID_SKELETONS) {
      throw new Error(
        `${ids.length} skeletons is above this backend's ceiling of ${MAX_CATMAID_SKELETONS}. ` +
          `CATMAID serves densely traced skeletons uncompressed — roughly a megabyte each — so ` +
          `this is a transfer limit rather than a drawing one. Narrow the selection upstream.`,
      )
    }

    /*
     * Cached per skeleton id for the session, on the same terms as neuPrint and CAVE — and this
     * is the one backend where that is a *decision* rather than a consequence.
     *
     * A neuPrint body id and a CAVE root id both name immutable geometry; a CATMAID skeleton is
     * live tracing data that somebody may be editing while you look at it. Caching it is worth
     * far more here — CATMAID serves densely traced skeletons uncompressed, roughly a megabyte
     * each — and the way back is **Clear Cache** on the node, which is why `neuron.skeletons`
     * declares `dataCache` and the card carries a `cached 12m ago ⟳` badge. Nothing here ages
     * silently; it just does not expire on its own.
     */
    let done = 0
    const skeletons = await cachedGeometry<SkeletonGeometry>({
      ids: ids.map(String),
      key: (id) => `catmaid:${this.id}:${projectId}:skel:${id}`,
      bytes: (s) => byteLengthOf(s.positions, s.radii, s.parents),
      refresh: req.refresh,
      onFetched: req.onFetched,
      /*
       * The **decoded** geometry is what goes in, not the response it came from.
       *
       * Two reasons, and the second is the one that bites. A `CompactSkeleton` is an array of
       * boxed rows, so its footprint is three or four times what a byte count over typed arrays
       * would say — and the budget is in bytes. And decoding is not free: rebuilding the
       * id→index map for a 16,840-node FAFB neuron on every cache *hit* would give back most of
       * what the cache was for. Labels stay outside, because they come from the project-wide
       * annotation index rather than from the skeleton.
       */
      fetch: async (missing) => {
        const out = new Map<string, SkeletonGeometry>()
        await mapWithConcurrency(missing, SKELETON_CONCURRENCY, async (id) => {
          const skeleton = await compactSkeleton(this.server, projectId, Number(id), false, options)
          done += 1
          req.onProgress?.(done / missing.length, 'skeletons')
          out.set(id, decodeCompactSkeleton(id, skeleton))
        })
        return out
      },
    })

    const index = await this.labelIndex(req.datasetId, options).catch(() => undefined)
    const items = skeletons.ordered.map(([, item]) => item)
    const rows: Array<Record<string, CellValue>> = skeletons.ordered.map(([id, item]) => {
      const labels = index?.labels.get(Number(id)) ?? EMPTY_LABELS
      return {
        [ID_COLUMN_NAME]: Number(id),
        name: labels.name,
        type: labels.type,
        instance: labels.instance,
        points: item.parents.length,
        /*
         * Measured from the geometry rather than fetched. `cableLength` is shared with the
         * neuPrint decoder and the mock so the three cannot disagree, the points are already
         * nanometres, and the tree is in hand — so the alternative was an extra round trip
         * against a shared community server for a number already sitting in memory.
         */
        cableLength: cableLength(item),
      }
    })

    return {
      kind: 'skeletons',
      items,
      attributes: tableFromRows(this.schemas.morphology, rows),
      bounds: boundsOf(items.map((item) => item.positions)),
      // Project coordinates are nanometres — see `POINTS_ARE_NM`. Declared rather than left
      // absent, because NBLAST refuses anything that is not `nm` and absent means unknown.
      ...this.frame(req.datasetId),
    }
  }

  /**
   * Synapse clouds, from the connector-link tables.
   *
   * Two GETs rather than one, because CATMAID filters links by *one* relation at a time and
   * there is no either-end mode — the same shape CAVE's synapse fetch has, arrived at from a
   * different API. `polarity` rides in the attribute table for that reason: a cloud fetched for
   * both ends is two populations in one buffer.
   */
  async fetchSynapses(req: SynapseRequest): Promise<PointsValue> {
    const projectId = this.projectId(req.datasetId)
    const options = req.signal ? { signal: req.signal } : {}
    const ids = numericIds(req.neuronIds)
    const relations: Array<'presynaptic_to' | 'postsynaptic_to'> =
      req.polarity === 'pre'
        ? ['presynaptic_to']
        : req.polarity === 'post'
          ? ['postsynaptic_to']
          : ['presynaptic_to', 'postsynaptic_to']

    const index = await this.labelIndex(req.datasetId, options).catch(() => undefined)

    /*
     * Both relations at once. They are independent GETs over the same id set — CATMAID has no
     * either-end filter, which is why there are two at all — so awaiting them in turn doubled
     * the wait on the default path for nothing. Flattened in relation order afterwards, so the
     * `polarity` grouping stays stable rather than following whichever landed first.
     */
    const responses =
      ids.length === 0
        ? []
        : await Promise.all(
            relations.map((relation) =>
              connectorLinks(this.server, projectId, ids, relation, options),
            ),
          )

    const points: number[] = []
    const rows: Array<Record<string, CellValue>> = []
    responses.forEach(({ links }, at) => {
      const polarity = relations[at] === 'presynaptic_to' ? 'pre' : 'post'
      for (const link of links) {
        const [skeletonId, connectorId, x, y, z, confidence] = link
        points.push(x, y, z)
        rows.push({
          [ID_COLUMN_NAME]: skeletonId,
          // A map lookup rather than a derivation: this runs once per *link*, which for a
          // densely traced FAFB neuron is tens of thousands of times.
          type: index?.labels.get(skeletonId)?.type ?? null,
          connectorId,
          polarity,
          confidence,
        })
      }
    })

    const positions = Float32Array.from(points)
    return {
      kind: 'points',
      positions,
      attributes: tableFromRows(this.schemas.synapses, rows),
      bounds: boundsOf([positions]),
      ...this.frame(req.datasetId),
    }
  }

  // -------------------------------------------------------------------------
  // Region meshes
  // -------------------------------------------------------------------------

  /**
   * The neuropil shells a project publishes.
   *
   * CATMAID calls these *volumes* and they are the closest thing it has to neuPrint's ROIs: 80
   * of them on FAFB, named `LAL_L`, `MB_PED_R` and so on, each about 93 kB of X3D. They carry
   * server-computed `area` and `volume`, which is more than either other backend publishes.
   *
   * Every region is `primary: true`. CATMAID has no hierarchy among volumes — they are a flat
   * list somebody drew — so nothing here nests, and saying so is what lets the ROIs viewer sum
   * them without the double-counting `roiInfo` causes on neuPrint.
   */
  async fetchRoiMeshes(req: RoiMeshRequest): Promise<MeshesValue> {
    const projectId = this.projectId(req.datasetId)
    const options = req.signal ? { signal: req.signal } : {}
    const available = await this.volumeList(req.datasetId, options)
    const wanted = req.rois
      ? available.filter((volume) => req.rois?.includes(volume.name))
      : available

    let done = 0
    const fetched = await mapWithConcurrency(wanted, SKELETON_CONCURRENCY, async (volume) => {
      const detail = await volumeDetail(this.server, projectId, volume.id, options)
      done += 1
      req.onProgress?.(done / wanted.length, 'regions')
      return { name: volume.name, mesh: parseX3dMesh(detail.mesh) }
    })

    const items: MeshGeometry[] = []
    const rows: Array<Record<string, CellValue>> = []
    for (const entry of fetched) {
      if (!entry) continue
      items.push({
        id: entry.name,
        positions: entry.mesh.positions,
        indices: entry.mesh.indices,
      })
      rows.push({ roi: entry.name, primary: true })
    }

    return {
      kind: 'meshes',
      items,
      attributes: tableFromRows(ROI_MESH_SCHEMA, rows),
      bounds: boundsOf(items.map((item) => item.positions)),
      ...this.frame(req.datasetId),
    }
  }

  /**
   * The volume list, as records.
   *
   * `/volumes/` answers `{columns, data}` — a column table rather than an array of objects, which
   * is worth converting at the edge: the obvious `VolumeRow[]` reading parses without error and
   * yields `undefined` for every field.
   */
  private volumeList(
    datasetId: string,
    options: { signal?: AbortSignal },
  ): Promise<{ id: number; name: string; comment: string | null }[]> {
    const state = this.state(datasetId)
    state.volumes ??= (async () => {
      const body = await listVolumes(this.server, this.projectId(datasetId), options)
      const idAt = body.columns.indexOf('id')
      const nameAt = body.columns.indexOf('name')
      const commentAt = body.columns.indexOf('comment')
      if (idAt === -1 || nameAt === -1) {
        throw new Error('CATMAID volume list is missing an id or name column')
      }
      const volumes = body.data.map((row) => ({
        id: Number(row[idAt]),
        name: String(row[nameAt]),
        comment: commentAt === -1 ? null : ((row[commentAt] as string | null) ?? null),
      }))
      // The listing publishes no ROI names until something asks; fill them in now that we know,
      // so the region pickers populate. Re-infers through `reportSourceLearned`.
      const dataset = this.projects?.find((entry) => entry.id === datasetId)
      if (dataset) {
        const named = volumes.map((volume) => volume.name).sort()
        this.projects = this.projects?.map((entry) =>
          entry.id === datasetId ? { ...entry, rois: named, primaryRois: named } : entry,
        )
        reportSourceLearned(this.id)
      }
      return volumes
    })().catch((error: unknown) => {
      state.volumes = undefined
      throw error
    })
    return state.volumes
  }
}
