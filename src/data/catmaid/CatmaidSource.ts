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

import { ID_COLUMN_NAME } from '../../core/ids'
import type { NeuronId } from '../../core/ids'
import type { TableSchema } from '../../core/types'
import type {
  CellValue,
  MatrixValue,
  MeshesValue,
  MeshGeometry,
  PointsValue,
  SkeletonGeometry,
  SkeletonsValue,
  TableValue,
} from '../../core/values'
import { boundsOf, makeMatrix, tableFromRows } from '../../core/values'
import { mapWithConcurrency } from '../concurrency'
import { compileLabelMatch, compileRegex } from '../neuronFilter'
import { loadCachedTable, neuronIndexKey } from '../neuronIndex'
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
import type { AnnotationListResponse, CatmaidProject } from './api'
import {
  annotationList,
  cableLengths,
  compactSkeleton,
  connectivityMatrix,
  connectorLinks,
  listProjects,
  listSkeletons,
  listVolumes,
  skeletonConnectivity,
  skeletonNumber,
  skeletonSummaries,
  synapseWeight,
  volumeDetail,
} from './api'
import type { CatmaidVocabulary } from './annotations'
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
  /** The whole-instance annotation index, once built. */
  labels?: Promise<LabelIndex>
  volumes?: Promise<{ id: number; name: string; comment: string | null }[]>
}

/** Everything the neuron table needs about labels, keyed by skeleton id. */
interface LabelIndex {
  vocabulary: CatmaidVocabulary
  response: AnnotationListResponse
  skeletonIds: number[]
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

  // -------------------------------------------------------------------------
  // Datasets — a CATMAID *project*
  // -------------------------------------------------------------------------

  async listDatasets(signal?: AbortSignal): Promise<DatasetInfo[]> {
    this.listing ??= this.runListing(signal)
    return this.listing
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
    const index = await this.labelIndex(req.datasetId, options, req.onProgress)
    throwIfAborted(req.signal)

    req.onProgress?.(0.9, 'sizes')
    // A missing roll-up is a null column, not a failed index: the names and types are the
    // answer somebody asked for, and refusing the lot because a secondary call was unavailable
    // is the `out.profile` failure this codebase already records.
    const summaries = await skeletonSummaries(
      this.server,
      projectId,
      index.skeletonIds,
      options,
    ).catch(() => ({}) as Record<string, { num_nodes: number; cable_length: number }>)

    const rows: Array<Record<string, CellValue>> = []
    for (const skeletonId of index.skeletonIds) {
      const labels = labelsForSkeleton(index.response, index.vocabulary, skeletonId)
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

  /** The annotation graph for the whole project, fetched once and held. */
  private labelIndex(
    datasetId: string,
    options: { signal?: AbortSignal },
    onProgress?: (fraction: number, note?: string) => void,
  ): Promise<LabelIndex> {
    const state = this.state(datasetId)
    state.labels ??= this.runLabelIndex(datasetId, options, onProgress).catch(
      (error: unknown) => {
        // A failed index must not be cached as a rejected promise, or every later call replays the
        // same failure without ever retrying. Same rule the discovery flags follow.
        state.labels = undefined
        throw error
      },
    )
    return state.labels
  }

  private async runLabelIndex(
    datasetId: string,
    options: { signal?: AbortSignal },
    onProgress?: (fraction: number, note?: string) => void,
  ): Promise<LabelIndex> {
    const projectId = this.projectId(datasetId)
    const skeletonIds = await listSkeletons(this.server, projectId, undefined, options)

    const merged: AnnotationListResponse = {
      skeletons: {},
      annotations: {},
      neuronnames: {},
      metaannotations: {},
    }
    for (let offset = 0; offset < skeletonIds.length; offset += ANNOTATION_CHUNK) {
      throwIfAborted(options.signal)
      const chunk = skeletonIds.slice(offset, offset + ANNOTATION_CHUNK)
      const part = await annotationList(this.server, projectId, chunk, options)
      Object.assign(merged.skeletons, part.skeletons)
      Object.assign(merged.annotations, part.annotations)
      Object.assign(merged.neuronnames, part.neuronnames)
      Object.assign(merged.metaannotations, part.metaannotations)
      // The first phase was the id list; leave the last tenth for building the table.
      onProgress?.(0.1 + (0.8 * (offset + chunk.length)) / skeletonIds.length, 'annotations')
    }

    return { vocabulary: readVocabulary(merged), response: merged, skeletonIds }
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
   */
  async findNeurons(req: FindNeuronsRequest): Promise<TableValue> {
    const index = await this.neuronIndex({
      datasetId: req.datasetId,
      ...(req.signal ? { signal: req.signal } : {}),
    })

    const typeRe = compileRegex(req.typePattern, 'type')
    const instanceRe = compileRegex(req.instancePattern, 'instance')
    const labelMatch = compileLabelMatch(req.labels)
    const wanted = req.neuronIds ? new Set(req.neuronIds.map(String)) : undefined

    const rows: Array<Record<string, CellValue>> = []
    const columns = index.schema.columns.map((column) => column.name)
    for (let i = 0; i < index.length; i += 1) {
      const row: Record<string, CellValue> = {}
      for (const name of columns) row[name] = index.data[name]?.[i] ?? null

      if (wanted && !wanted.has(String(row[ID_COLUMN_NAME]))) continue
      if (typeRe && !(typeof row.type === 'string' && typeRe.test(row.type))) continue
      if (instanceRe && !(typeof row.instance === 'string' && instanceRe.test(row.instance)))
        continue
      if (labelMatch && !labelMatch(row)) continue
      rows.push(row)
      if (req.limit && rows.length >= req.limit) break
    }

    return tableFromRows(this.schemas.neurons, rows, 'neurons')
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
    const queried = req.neuronIds.map(Number).filter(Number.isSafeInteger)
    if (queried.length === 0) return tableFromRows(this.schemas.connectivity, [])

    const response = await skeletonConnectivity(this.server, projectId, queried, options)
    const side = req.direction === 'outputs' ? response.outgoing : response.incoming
    const types = await this.typeLookup(req.datasetId, options)

    const rows: Array<Record<string, CellValue>> = []
    for (const [partnerId, entry] of Object.entries(side ?? {})) {
      for (const [queryId, byConfidence] of Object.entries(entry.skids)) {
        const weight = synapseWeight(byConfidence)
        if (req.minWeight && weight < req.minWeight) continue
        rows.push({
          [ID_COLUMN_NAME]: Number(queryId),
          neuronType: types.get(Number(queryId)) ?? null,
          partnerId: Number(partnerId),
          partnerType: types.get(Number(partnerId)) ?? null,
          weight,
        })
      }
    }
    return tableFromRows(this.schemas.connectivity, rows)
  }

  async fetchAdjacency(req: AdjacencyRequest): Promise<MatrixValue> {
    const projectId = this.projectId(req.datasetId)
    const options = req.signal ? { signal: req.signal } : {}
    const rows = req.sourceIds.map(Number).filter(Number.isSafeInteger)
    const columns = req.targetIds.map(Number).filter(Number.isSafeInteger)
    const matrix = await connectivityMatrix(this.server, projectId, rows, columns, options)
    const types = await this.typeLookup(req.datasetId, options)

    const label = (id: number): string =>
      req.groupByType ? (types.get(id) ?? String(id)) : String(id)

    const values = new Float64Array(rows.length * columns.length)
    rows.forEach((source, r) => {
      const line = matrix[String(source)] ?? {}
      columns.forEach((target, c) => {
        values[r * columns.length + c] = line[String(target)] ?? 0
      })
    })
    return makeMatrix(rows.map(label), columns.map(label), values, 'synapses', 'count')
  }

  /** Skeleton id → derived type, for labelling connectivity rows. Memoised per project. */
  private async typeLookup(
    datasetId: string,
    options: { signal?: AbortSignal },
  ): Promise<Map<number, string>> {
    const index = await this.labelIndex(datasetId, options)
    const types = new Map<number, string>()
    for (const skeletonId of index.skeletonIds) {
      const labels = labelsForSkeleton(index.response, index.vocabulary, skeletonId)
      if (labels.type) types.set(skeletonId, labels.type)
    }
    return types
  }

  // -------------------------------------------------------------------------
  // Morphology
  // -------------------------------------------------------------------------

  async fetchSkeletons(req: GeometryRequest): Promise<SkeletonsValue> {
    const projectId = this.projectId(req.datasetId)
    const options = req.signal ? { signal: req.signal } : {}
    const ids = req.neuronIds.map(Number).filter(Number.isSafeInteger)
    if (ids.length > MAX_CATMAID_SKELETONS) {
      throw new Error(
        `${ids.length} skeletons is above this backend's ceiling of ${MAX_CATMAID_SKELETONS}. ` +
          `CATMAID serves densely traced skeletons uncompressed — roughly a megabyte each — so ` +
          `this is a transfer limit rather than a drawing one. Narrow the selection upstream.`,
      )
    }

    let done = 0
    const fetched = await mapWithConcurrency(ids, SKELETON_CONCURRENCY, async (id) => {
      const skeleton = await compactSkeleton(this.server, projectId, id, false, options)
      done += 1
      req.onProgress?.(done / ids.length, 'skeletons')
      return { id, skeleton }
    })

    const items: SkeletonGeometry[] = []
    const rows: Array<Record<string, CellValue>> = []
    const index = await this.labelIndex(req.datasetId, options).catch(() => undefined)

    for (const entry of fetched) {
      if (!entry) continue
      const nodes = entry.skeleton[0]
      const positions = new Float32Array(nodes.length * 3)
      const radii = new Float32Array(nodes.length)
      const parents = new Int32Array(nodes.length)

      // CATMAID names parents by *node id*; a skeleton is an array in no particular order, so the
      // tree is rebuilt through an id→index map. Emitting parents as ids would satisfy the type
      // and break every consumer that walks the array.
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

      items.push({ id: String(entry.id), positions, radii, parents })
      const labels = index
        ? labelsForSkeleton(index.response, index.vocabulary, entry.id)
        : { name: null, type: null, instance: null }
      rows.push({
        [ID_COLUMN_NAME]: entry.id,
        name: labels.name,
        type: labels.type,
        instance: labels.instance,
        points: nodes.length,
        cableLength: null,
      })
    }

    await this.fillCable(req.datasetId, rows, req.signal)
    return {
      kind: 'skeletons',
      items,
      attributes: tableFromRows(this.schemas.morphology, rows),
      bounds: boundsOf(items.map((item) => item.positions)),
      // Project coordinates are nanometres — see `POINTS_ARE_NM`. Declared rather than left
      // absent, because NBLAST refuses anything that is not `nm` and absent means unknown.
      units: 'nm',
    }
  }

  private async fillCable(
    datasetId: string,
    rows: Array<Record<string, CellValue>>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (rows.length === 0) return
    try {
      const lengths = await cableLengths(
        this.server,
        this.projectId(datasetId),
        rows.map((row) => Number(row[ID_COLUMN_NAME])),
        signal ? { signal } : {},
      )
      for (const row of rows) {
        const value = lengths[String(row[ID_COLUMN_NAME])]
        if (value !== undefined) row.cableLength = value
      }
    } catch {
      // As `fillSizes`: a missing roll-up is a null column, not a failed fetch.
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
    const ids = req.neuronIds.map(Number).filter(Number.isSafeInteger)
    const relations: Array<'presynaptic_to' | 'postsynaptic_to'> =
      req.polarity === 'pre'
        ? ['presynaptic_to']
        : req.polarity === 'post'
          ? ['postsynaptic_to']
          : ['presynaptic_to', 'postsynaptic_to']

    const index = await this.labelIndex(req.datasetId, options).catch(() => undefined)
    const points: number[] = []
    const rows: Array<Record<string, CellValue>> = []

    for (const relation of relations) {
      if (ids.length === 0) break
      const { links } = await connectorLinks(this.server, projectId, ids, relation, options)
      for (const link of links) {
        const [skeletonId, connectorId, x, y, z, confidence] = link
        points.push(x, y, z)
        const labels = index
          ? labelsForSkeleton(index.response, index.vocabulary, skeletonId)
          : { type: null }
        rows.push({
          [ID_COLUMN_NAME]: skeletonId,
          type: labels.type,
          connectorId,
          polarity: relation === 'presynaptic_to' ? 'pre' : 'post',
          confidence,
        })
      }
    }

    const positions = Float32Array.from(points)
    return {
      kind: 'points',
      positions,
      attributes: tableFromRows(this.schemas.synapses, rows),
      bounds: boundsOf([positions]),
      units: 'nm',
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
      units: 'nm',
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

/** Unused today, kept honest: the schema a table built from `findNeurons` carries. */
export function catmaidNeuronSchema(): TableSchema {
  return CATMAID_SCHEMAS.neurons
}

/** Skeleton ids are small integers, but the seam carries text (invariant 8). */
export function catmaidNeuronId(id: NeuronId): number | undefined {
  return skeletonNumber(id)
}
