/**
 * A neuroglancer precomputed URL as a `DataSource` — one **datasource**, not a dataset.
 *
 * The distinction is the whole design. A dataset is a connectome: neurons with types and
 * statuses, connectivity, regions, a published viewer state. A precomputed URL is one kind of
 * data at one address, and usually the only question it can answer is "give me the geometry for
 * these segment ids". So almost every capability here is false, and that is not a gap to be
 * filled in later — it is what the object is.
 *
 * It implements `DataSource` anyway, rather than being a new seam, because the three nodes that
 * matter already speak that interface: `Meshes`, `Skeletons` and `ROI Meshes` resolve
 * `dataset.sourceId` and call `fetchMeshes`. Making this a source is what lets them take a
 * neuroglancer URL with no change at all, and `SourceCapabilities` is already the machinery for
 * a source that can do one thing.
 *
 * ## One instance per URL
 *
 * Registered lazily by `precomputedSourceFor`, exactly as `neuPrintSourceFor` does for a
 * deployment: nodes resolve a source out of the global registry, so a node pointing at a bucket
 * needs a registered source for that bucket, and the only moment that can happen is when
 * something asks. The id carries the canonical spelling — `precomputed:precomputed://gs://…` —
 * so `backendOf` reads `precomputed` and two spellings of one bucket share an instance.
 *
 * ## Ids are text, and here that is load-bearing rather than pedantic
 *
 * Invariant 8. A precomputed segment id is a raw 64-bit key with no neuPrint-style guarantee of
 * fitting in a double: FlyWire and male-CNS root ids are eighteen digits. The morphology schema
 * therefore declares `str`, and nothing here rounds one through a number on its way to a shard
 * lookup.
 *
 * ## What it deliberately cannot do
 *
 * `fetchConnectivity` and `fetchAdjacency` throw: a bucket of geometry has no synapses, and
 * answering with an empty result would read as "nothing here is connected" — a wrong answer under
 * a green node, which is worse than the refusal. They throw rather than being gated because
 * `DataSource` makes them **required**, which is the one place this source is a special case
 * bolted onto the seam rather than an extension of it; the deeper fix is a `connectivity`
 * capability, exactly as `fetchRoiCounts`/`roiCounts` were split when the second backend arrived.
 *
 * Everything else is gated properly. `findNeurons` and `neuronIndex` are answered from the segment
 * -property sidecar where there is one and refuse by naming `Input IDs` where there is not; meshes,
 * skeletons and region shells each key on what the `info` declares.
 */

import type {
  MatrixValue,
  MeshDetail,
  MeshesValue,
  SkeletonGeometry,
  SkeletonProvenance,
  SkeletonsValue,
  TableValue,
} from '../../core/values'
import {
  boundsOf,
  cableLength,
  emptyTable,
  getRow,
  makeTable,
  selectRows,
} from '../../core/values'
import type { TableSchema } from '../../core/types'
import { column, tableSchema } from '../../core/types'
import type {
  AdjacencyRequest,
  ConnectivityRequest,
  DataSource,
  DatasetInfo,
  FindNeuronsRequest,
  GeometryRequest,
  NeuronIndexRequest,
  RoiMeshRequest,
  SourceCapabilities,
  SourceSchemas,
} from '../source'
import { ROI_MESH_SCHEMA, requireSkeletonRoute } from '../source'
import { compileLabelMatch, preparedRows, refuseUnfilterableRoi } from '../neuronFilter'
import { fieldTermsMatch } from '../terms'
import { ID_COLUMN_NAME } from '../../core/ids'
import { geometryFrame } from '../transforms/spaces'
import type { NgSourceRef } from '../neuroglancer/sourceUrl'
import type { MeshResult, MeshSource } from './index'
import { DEFAULT_TRIANGLE_BUDGET, fetchMeshes, meshProgress, openMeshDir } from './index'
import type { SkeletonSource } from './skeletons'
import { fetchSkeletons, openSkeletonSource, skeletonFetchOptions } from './skeletons'
import { idsForLabels, labelsOf, readSegmentProperties } from './segmentProperties'
import { loadCachedTable, neuronIndexKey } from '../neuronIndex'
import type { PrecomputedDescription } from './probe'
import { peekPrecomputed, probePrecomputed } from './probe'
import { SKELETON_ROUTES, route } from '../skeletonRoutes'

/**
 * Where the size of a legacy fetch starts being worth a sentence.
 *
 * A cost only the *backend* knows, which is what `GeometryRequest.onWarn` exists for: a
 * multi-resolution source picks a level to fit the batch, and a legacy one sends full resolution
 * whatever anybody set Detail to — a few megabytes a neuron. The node cannot know which kind of
 * directory it is pointed at, and this can. Twenty-five because that is roughly where a full-
 * resolution batch crosses a hundred megabytes on the datasets in reach.
 */
const LEGACY_WARN = 25

/**
 * Schemas for a source that publishes geometry and nothing else.
 *
 * `morphology` is the only one that reaches a user: it is what a 3D viewer's `colour by` picker
 * offers for the geometry fetched from here. It is deliberately small — there is no cell type or
 * status to put in it, and a column that is *always* null is worse than an absent one, because a
 * picker offers it and then colours everything the same.
 *
 * `cableLength` is the one column that is null on one path and real on the other: a mesh has no
 * cable, a skeleton does, and it is the only number this source can say about a neuron's shape
 * beyond how many points it has. That is `CANONICAL_SCHEMAS`' own arrangement — `NeuPrintSource`
 * pushes null there for meshes too — rather than an exception being made here.
 *
 * The other four are required by the interface and unreachable in practice, since every
 * capability that would return one is false. They are stated at their smallest rather than
 * copied from `CANONICAL_SCHEMAS`, so nothing downstream can advertise a `weight` column that no
 * call here will ever fill.
 */
const ID_ONLY: TableSchema = tableSchema(column('neuronId', 'str'))

const PRECOMPUTED_SCHEMAS: SourceSchemas = {
  neurons: ID_ONLY,
  connectivity: ID_ONLY,
  roiCounts: ID_ONLY,
  morphology: tableSchema(
    column('neuronId', 'str'),
    column('points', 'i64'),
    // Nanometres, like every coordinate this source hands back — see `frame`.
    column('cableLength', 'f64', 'nm'),
  ),
  synapses: ID_ONLY,
}

/**
 * What this source can do before anything has been read.
 *
 * `meshes` is **true here and narrowed by `capabilitiesFor`**, which is the opposite of how it
 * looks like it should go. The reason is invariant 2: the probe is asynchronous, so on a fresh
 * session nothing is known yet — and a pessimistic default would put "This data source has no
 * meshes" on a perfectly good Meshes node for the first second of every load, which is exactly
 * the unresolved-refuses-nothing rule `capabilityOf` states. Once the probe lands the answer is
 * the honest one, in both directions.
 *
 * `skeletons`, `neuronIndex` and `roiMeshes` are optimistic for the same reason and narrowed the
 * same way: a segmentation names its mesh directory, its skeleton directory and its segment
 * properties in one `info`, so the probe learns all three at once and they are the same kind of
 * answer.
 */
const PRECOMPUTED_CAPABILITIES: SourceCapabilities = {
  rawQuery: false,
  skeletons: true,
  meshes: true,
  synapses: false,
  neuronIndex: true,
  paths: false,
  viewerScene: false,
  roiSummary: false,
  roiCounts: false,
  roiFilter: false,
  // A precomputed layer publishes geometry. There is no connectivity here to restrict or total.
  connectivityRois: false,
  synapseTotals: false,
  roiMeshes: true,
}

/** `gs://flyem-male-cns/v1.0/segmentation` → `flyem-male-cns/segmentation`. */
export function datasourceLabel(location: string): string {
  const parts = location
    .replace(/^[a-z0-9+-]+:\/\//i, '')
    .split('/')
    .filter(Boolean)
  if (parts.length <= 1) return parts[0] ?? location
  return `${parts[0]}/${parts[parts.length - 1]}`
}

/** The registered id for a canonical source spelling. One place, so a lookup cannot miss. */
export function precomputedSourceId(canonical: string): string {
  return `precomputed:${canonical}`
}

/**
 * What this source's skeletons are, said once.
 *
 * A bucket's skeleton directory is exactly the thing every other backend calls its "published"
 * route — the same `neuroglancer_skeletons` format, the same reader — so it carries the same id.
 * That is what lets a Skeletons node pinned to `published` keep meaning something when its
 * Dataset node is repointed from a Neuroglancer Source at male-CNS onto neuPrint's male-CNS.
 */
const PRECOMPUTED_ROUTE = route(
  SKELETON_ROUTES.published,
  'The `neuroglancer_skeletons` directory this source points at, or the one its volume names. ' +
    'One request per segment. Radii only where the directory declares a float32 `radius` vertex ' +
    'attribute, which many do not — male-CNS declares none, so every radius there is 0.',
)

export class PrecomputedSource implements DataSource {
  readonly id: string
  readonly label: string
  readonly capabilities = PRECOMPUTED_CAPABILITIES
  readonly schemas = PRECOMPUTED_SCHEMAS

  /** The parsed spec this source was built from. `url` is the directory everything reads. */
  readonly ref: NgSourceRef
  /** Dataset id, and the only one: a datasource holds exactly one thing. */
  readonly datasetId: string

  /** Whether a background probe has been started on behalf of a synchronous caller. */
  private probing = false
  /**
   * The description the held `DatasetInfo` was built from, and the info itself.
   *
   * Held rather than rebuilt per call because `peekDatasets`/`peekDataset` are read from
   * `inferOutputs` and `validate` on every graph mutation, and from React render paths where the
   * array's identity is a memo key — invariant 7. Every other source stores this for the same
   * reason; a fresh array of a fresh object on each peek is three allocations that also defeat
   * every downstream `useMemo`.
   *
   * Keyed on the **description's identity** rather than cached outright, so it rebuilds if the
   * probe ever answers with a different object — a retry after a failure, or a cache cleared
   * underneath. An `info` is immutable per URL, so in practice this is built once.
   */
  /**
   * Everything derived from the two facts this source learns, and the two facts themselves.
   *
   * One object rather than four fields because they are written together, in one place, and read
   * by identity: `peekDatasets`, `capabilitiesFor` and `schemasFor` all run from `inferOutputs`
   * on every graph mutation, and a fresh array or object per call is the allocation invariant 7
   * is about. Keeping them in one record is also what makes the change guard a single comparison
   * rather than four that can disagree.
   *
   * `source` and `labels` are both keys because the two arrive at different times: the probe
   * lands in one round trip, and the sidecar is a separate, larger download started only when
   * something asks for a name. Rebuilding when either changes is what lets a region picker fill
   * the moment the labels arrive, without rebuilding on every peek in between.
   */
  private cache?: {
    source: PrecomputedDescription
    labels: TableValue | undefined
    datasets: DatasetInfo[]
    capabilities: Partial<SourceCapabilities>
    schemas: SourceSchemas
  }
  /** Whether the sidecar load has been started on behalf of a synchronous caller. */
  private loadingLabels = false

  private readonly onLearned: ((sourceId: string) => void) | undefined

  constructor(ref: NgSourceRef, onLearned?: (sourceId: string) => void) {
    this.ref = ref
    this.datasetId = ref.canonical
    this.id = precomputedSourceId(ref.canonical)
    this.label = datasourceLabel(ref.location)
    this.onLearned = onLearned
  }

  /**
   * Start a probe on behalf of a synchronous caller, once, and record what it found.
   *
   * The `peekDatasets` rule: a peek that cannot answer starts the fetch that would, or the first
   * Run of a session behaves differently from the second. `reportSourceLearned` is the other half
   * — inference has already run against the degraded answer and nothing would recompute it
   * otherwise (invariant 2). Passed in rather than imported so this class stays a plain reader.
   */
  private ensureProbe(): PrecomputedDescription | undefined {
    const known = this.ref.url ? peekPrecomputed(this.ref.url) : undefined
    if (known?.ok) return this.remember(known.source)
    if (known || !this.ref.url) return undefined
    if (!this.probing) {
      this.probing = true
      void probePrecomputed(this.ref.url).then(() => this.onLearned?.(this.id))
    }
    return undefined
  }

  /**
   * Record a description and build the one `DatasetInfo` it implies, if it is new.
   *
   * `rois` and `statuses` are empty and stay that way until segment properties are read: a
   * region list is the *labels* a source publishes, and inventing one out of segment ids would
   * fill a picker with eighteen-digit numbers nobody can choose between.
   */
  private remember(source: PrecomputedDescription): PrecomputedDescription {
    const properties = this.ensureLabels(source)
    if (this.cache?.source !== source || this.cache.labels !== properties) {
      const datasets: DatasetInfo[] = [
        {
          id: this.datasetId,
          label: this.label,
          description: source.summary,
          /*
           * A precomputed source's "regions" are simply its labelled segments — there is no other
           * definition available, and nothing in a sidecar says which of its labels nest. So this
           * is the whole label set rather than a primary subset, and `fetchRoiMeshes` says the
           * same thing about `primary`.
           */
          rois: properties ? labelsOf(properties) : [],
          statuses: [],
        },
      ]
      this.cache = {
        source,
        labels: properties,
        datasets,
        /*
         * Built here rather than looked up in a table of every combination, because this is where
         * the facts arrive and where the identity has to be stable. `roiMeshes` needs **both** a
         * mesh directory and names: without the sidecar the region picker would offer
         * eighteen-digit segment ids.
         */
        capabilities: Object.freeze({
          meshes: Boolean(source.meshUrl),
          skeletons: Boolean(source.skeletonUrl),
          neuronIndex: Boolean(source.segmentPropertiesUrl),
          roiMeshes: Boolean(source.segmentPropertiesUrl && source.meshUrl),
        }),
        schemas: properties
          ? { ...PRECOMPUTED_SCHEMAS, neurons: properties.schema }
          : PRECOMPUTED_SCHEMAS,
      }
    }
    return source
  }

  /**
   * The sidecar if it has arrived, starting the load once if it has not.
   *
   * `peekDatasets`' rule one level in: a peek that cannot answer starts the fetch that would, or
   * the ROI Meshes picker stays empty until something else happens to run. `onLearned` is the
   * other half — inference has already run against the empty region list and nothing recomputes
   * it otherwise (invariant 2).
   *
   * Deliberately **not** started by the probe. This is a separate and much larger document —
   * hemibrain's segmentation publishes 22,706 labelled ids — and the probe runs from an edit-time
   * peek on a `cheap` node, so downloading it because somebody typed a URL is invariant 6's
   * hazard. It loads when something actually asks for a name.
   */
  private ensureLabels(source: PrecomputedDescription): TableValue | undefined {
    if (this.labelTable) return this.labelTable
    if (!source.segmentPropertiesUrl) return undefined
    if (!this.loadingLabels) {
      this.loadingLabels = true
      // Through `neuronIndex`, not around it: one path means a sidecar already in the persistent
      // store fills the region picker with no request at all, and Clear Cache drops the copy the
      // picker is reading from rather than one of two.
      void this.neuronIndex({ datasetId: this.datasetId })
        .then(() => this.onLearned?.(this.id))
        .catch(() => {
          // A failure is reported by whichever node actually asked; retrying on the next peek
          // would put a request behind every graph mutation.
        })
    }
    return undefined
  }

  /** The sidecar, once any load of it has landed. Written by `neuronIndex`, read by every peek. */
  private labelTable?: TableValue

  /**
   * The neuron schema the sidecar implies, once it has landed.
   *
   * Synchronous and cached by identity, like `peekDatasets` and for the same reason: this runs
   * from `inferOutputs` on every graph mutation, and it is what fills Find Neurons' field
   * dropdown with the columns *this* source publishes rather than a canonical guess.
   */
  schemasFor(): SourceSchemas {
    // `ensureProbe` records what it finds, so there is nothing to remember again here.
    this.ensureProbe()
    return this.cache?.schemas ?? this.schemas
  }

  /**
   * The source description, awaited — or a throw naming what stopped it.
   *
   * The one place either failure is worded, because both used to be written twice: a location
   * Coda cannot fetch from, and a location it could not read. `retry` comes only from an explicit
   * Run; see `ProbeOptions`.
   */
  async describe(
    options: { signal?: AbortSignal; retry?: boolean } = {},
  ): Promise<PrecomputedDescription> {
    if (!this.ref.url) {
      throw new Error(
        `${this.ref.canonical} is not a location Coda can fetch from. Object stores (gs://, ` +
          `s3://) and plain https:// directories work; dvid:// and brainmaps:// do not.`,
      )
    }
    const probe = await probePrecomputed(this.ref.url, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.retry ? { retry: true } : {}),
    })
    if (!probe.ok) throw new Error(`Could not read ${this.ref.location}: ${probe.error}`)
    return this.remember(probe.source)
  }

  /**
   * The narrowing half of the optimistic default above.
   *
   * A **failed** probe returns undefined rather than `NO_MESHES`, which is the difference between
   * "there are no meshes here" and "nobody could read this". The node holding the URL is already
   * showing the error; a second refusal downstream would name the wrong cause.
   *
   * Keyed on what the source **names** rather than on whether the directory opened, so a read
   * that failed transiently does not turn into a standing edit-time refusal.
   */
  capabilitiesFor(): Partial<SourceCapabilities> | undefined {
    this.ensureProbe()
    return this.cache?.capabilities
  }

  /**
   * One route, named: whatever this URL points at.
   *
   * A Neuroglancer Source node *is* a skeleton directory, or names one, so there is nothing here
   * to choose between — but the Skeletons node builds its dropdown from this list, and a source
   * that answers nothing leaves it saying "Automatic" about a route it cannot name. `undefined`
   * until the probe settles, for the reason `capabilitiesFor` above returns `undefined` then:
   * this runs from `inferOutputs`.
   */
  skeletonSourcesFor(): readonly SkeletonProvenance[] | undefined {
    this.ensureProbe()
    const capabilities = this.cache?.capabilities
    if (!capabilities) return undefined
    return capabilities.skeletons ? [PRECOMPUTED_ROUTE] : []
  }

  async listDatasets(signal?: AbortSignal): Promise<DatasetInfo[]> {
    await this.describe(signal ? { signal } : {})
    return this.cache?.datasets ?? []
  }

  peekDatasets(): DatasetInfo[] | undefined {
    this.ensureProbe()
    return this.cache?.datasets
  }

  peekDataset(datasetId: string): DatasetInfo | undefined {
    return datasetId === this.datasetId ? this.peekDatasets()?.[0] : undefined
  }

  /**
   * Every labelled segment, as a table.
   *
   * The sidecar *is* the index: it is one document listing every segment the source names, which
   * is exactly the shape `neuronIndex` exists for, so there is nothing to page or accumulate.
   * Memoised in `segmentProperties.ts`, which is where the deduplication of concurrent callers
   * lives — the seam asks implementations for both.
   */
  async neuronIndex(req: NeuronIndexRequest): Promise<TableValue> {
    const url = await this.propertiesUrl(req.signal)
    const table = await loadCachedTable({
      key: neuronIndexKey(this.id, this.datasetId),
      /*
       * The sidecar's URL, because the shape cannot be known before it is read — the columns are
       * whatever properties it publishes. Two different sidecars are two different shapes, and the
       * same one re-published under one URL is what `maxAgeMs` is for.
       */
      fingerprint: url,
      ...(req.refresh ? { refresh: req.refresh } : {}),
      fetch: () => readSegmentProperties(url, req.signal ? { signal: req.signal } : {}),
    })
    // Recorded for the synchronous peeks — the region picker and `schemasFor` — which cannot await
    // and would otherwise start a second load of a document already in hand.
    this.labelTable = table
    return table
  }

  /**
   * A neuron query answered **locally**, over the sidecar.
   *
   * The same three lines `CaveSource` and `CatmaidSource` run, through the same helpers, which is
   * what stops three backends disagreeing about whether `LC.*` matches `LPLC1` — see
   * `neuronFilter.ts`. What differs is only the refusal below it.
   */
  async findNeurons(req: FindNeuronsRequest): Promise<TableValue> {
    const index = await this.neuronIndex({
      datasetId: req.datasetId,
      ...(req.signal ? { signal: req.signal } : {}),
    })

    const prepared = preparedRows(index, req, 'This neuroglancer datasource')
    const labelTest = compileLabelMatch(req.labels)
    // Present-and-empty means no neurons, never "no filter" — the seam's documented rule, and the
    // one an unconfigured node depends on.
    const wantedIds = req.neuronIds ? new Set<string>(req.neuronIds) : undefined
    // A precomputed source has no regions to narrow by, and `DatasetInfo.rois` being full of its
    // *labels* is exactly the trap this refusal was written for on CATMAID.
    refuseUnfilterableRoi(req, 'This neuroglancer datasource')

    const ids = index.data[ID_COLUMN_NAME] ?? []
    const matched: number[] = []
    for (let i = 0; i < index.length; i++) {
      if (wantedIds && !wantedIds.has(String(ids[i]))) continue
      if (!fieldTermsMatch(prepared, i)) continue
      if (labelTest && !labelTest(getRow(index, i))) continue
      matched.push(i)
    }
    const limited = req.limit && req.limit > 0 ? matched.slice(0, req.limit) : matched
    return selectRows(index, limited)
  }

  /**
   * Region shells, by name.
   *
   * The one place the two halves of a sidecar-bearing source meet: the names come from the
   * segment properties and the geometry from the mesh directory, keyed by the ids the sidecar
   * pairs them with. `MeshGeometry.id` carries the **label**, not the segment id, because that is
   * what `ROI_MESH_SCHEMA` says a region is called and what every consumer draws in a legend.
   *
   * `rois` omitted means every label this source publishes. That differs from neuPrint, where the
   * default is the *primary* set — the subset that tiles the volume — because nothing in a
   * precomputed sidecar says which of its labels nest. `primary` is `true` for every row for the
   * same reason: it is the licence to sum, and a source that cannot distinguish has no grounds to
   * withhold it from some rows and not others.
   */
  async fetchRoiMeshes(req: RoiMeshRequest): Promise<MeshesValue> {
    /*
     * Through `neuronIndex`, not around it. Reading the sidecar directly fetched half a megabyte
     * a second time on hemibrain, ignored `refresh`, and handed `idsForLabels` a different table
     * object each call — which defeats the `LABEL_INDEX` memo keyed on its identity.
     */
    const [properties, source] = await Promise.all([
      this.neuronIndex({ datasetId: req.datasetId }),
      this.meshDir(req.signal),
    ])

    /*
     * The stored list, not a fresh `labelsOf`: `remember` built exactly this from the same table
     * when the sidecar landed, and re-deriving it means uniquing and collating 22,706 strings
     * again per fetch.
     */
    const stored = this.cache?.datasets[0]?.rois
    /*
     * `.length`, not `??`. The stored list is `[]` until the sidecar has landed *and* a peek has
     * rebuilt the cache from it — and `[] ?? labelsOf(...)` is `[]`, so an ROI Meshes node run
     * with an empty picker on a cold source fetched nothing at all and said nothing about it.
     */
    const wanted = req.rois?.length ? req.rois : stored?.length ? stored : labelsOf(properties)
    const hits = idsForLabels(properties, wanted)
    if (hits.length === 0) {
      return {
        kind: 'meshes',
        items: [],
        attributes: emptyTable(ROI_MESH_SCHEMA),
        bounds: boundsOf([]),
        ...this.frame(),
      }
    }

    let done = 0
    const result = await fetchMeshes(
      source,
      hits.map((hit) => hit.id),
      {
        ...(req.signal ? { signal: req.signal } : {}),
        // Region shells are few and large, and the whole point is to draw them together — so no
        // budget-driven coarsening beyond the default the mesh reader already applies.
        onProgress: (_at, total, phase) => {
          if (phase === 'fragments')
            req.onProgress?.(++done / Math.max(1, total), `${done}/${total} regions`)
        },
      },
    )

    // Back onto labels, by id, so a region the source had no mesh for is simply absent rather
    // than shifting every later row onto the wrong name.
    const labelById = new Map(hits.map((hit) => [hit.id, hit.label]))
    const items = result.meshes.map((mesh) => ({
      id: labelById.get(mesh.neuronId) ?? mesh.neuronId,
      positions: mesh.positions,
      indices: mesh.indices,
    }))
    return {
      kind: 'meshes',
      items,
      attributes: makeTable(ROI_MESH_SCHEMA, {
        roi: items.map((item) => item.id),
        primary: items.map(() => true),
      }),
      bounds: boundsOf(items.map((item) => item.positions)),
      ...this.frame(),
    }
  }

  /** The sidecar's URL, or the refusal that names what this source publishes instead. */
  private async propertiesUrl(signal: AbortSignal | undefined): Promise<string> {
    const source = await this.describe(signal ? { signal } : {})
    if (!source.segmentPropertiesUrl) {
      throw new Error(
        `${this.ref.canonical} publishes no segment properties, so its segments have no names ` +
          `and nothing can list them — it is ${source.summary}. Supply the ids with an Input IDs ` +
          `node instead.`,
      )
    }
    return source.segmentPropertiesUrl
  }

  fetchConnectivity(_req: ConnectivityRequest): Promise<TableValue> {
    return this.noConnectivity()
  }

  fetchAdjacency(_req: AdjacencyRequest): Promise<MatrixValue> {
    return this.noConnectivity()
  }

  /** One message for the two calls that ask the same impossible question. */
  private noConnectivity<T>(): Promise<T> {
    return Promise.reject(
      new Error(
        `${this.label} publishes geometry, not connectivity. Wire a Dataset node for that.`,
      ),
    )
  }

  // -------------------------------------------------------------------------
  // Geometry
  // -------------------------------------------------------------------------

  async fetchMeshes(req: GeometryRequest): Promise<MeshesValue> {
    if (req.neuronIds.length === 0) return this.assemble([])

    const source = await this.meshDir(req.signal)
    /*
     * Said before the work starts, so it is on the card while there is still something to
     * cancel — `onWarn`'s contract. It is also the only place the fact is available: the node
     * knows how many neurons it asked for and cannot know that this particular directory has no
     * levels of detail to trade against that number.
     */
    if (source.format === 'legacy' && req.neuronIds.length > LEGACY_WARN) {
      req.onWarn?.(
        `${this.label} publishes single-resolution meshes, so all ${req.neuronIds.length} arrive ` +
          `at full detail — a few megabytes each — whatever Detail is set to. The fetch goes ` +
          `ahead either way.`,
      )
    }

    const result = await fetchMeshes(source, req.neuronIds, {
      ...(req.signal ? { signal: req.signal } : {}),
      ...(req.refresh ? { refresh: true } : {}),
      ...(req.onFetched ? { onFetched: req.onFetched } : {}),
      ...(req.onProgress ? { onProgress: meshProgress(req.onProgress) } : {}),
      triangleBudget: req.triangleBudget ?? DEFAULT_TRIANGLE_BUDGET,
      // No `detail` on a partial: the caption's triangle count is only true of the whole batch,
      // and a growing one reads as the level changing under the viewer.
      ...(req.onPartial
        ? { onPartial: (meshes) => req.onPartial?.(this.assemble(meshes)) }
        : {}),
    })

    return this.assemble(
      result.meshes,
      result.lod !== undefined && result.levels !== undefined
        ? { lod: result.lod, levels: result.levels, triangles: result.triangles }
        : undefined,
    )
  }

  /**
   * Geometry and its attribute rows as one value.
   *
   * Used for the empty answer too, rather than spelling that case out: `boundsOf([])` is
   * `EMPTY_BOUNDS` and an empty column set is `emptyTable`, so the two were the same object
   * written twice — which is how the frame comes to be stamped on one of them and not the other.
   */
  private assemble(meshes: readonly MeshResult[], detail?: MeshDetail): MeshesValue {
    const schema = this.schemas.morphology
    return {
      kind: 'meshes',
      items: meshes.map((mesh) => ({
        id: mesh.neuronId,
        positions: mesh.positions,
        indices: mesh.indices,
      })),
      attributes: makeTable(schema, {
        // Text, straight through: invariant 8. A shard key that has been through a double is a
        // different neuron with nothing to say so.
        neuronId: meshes.map((mesh) => mesh.neuronId),
        // Vertices, which is what a mesh actually has. A mesh has no cable.
        points: meshes.map((mesh) => mesh.positions.length / 3),
        cableLength: meshes.map(() => null),
      }),
      bounds: boundsOf(meshes.map((mesh) => mesh.positions)),
      ...(detail ? { detail } : {}),
      ...this.frame(),
    }
  }

  async fetchSkeletons(req: GeometryRequest): Promise<SkeletonsValue> {
    requireSkeletonRoute(this.label, req.skeletonSource, [PRECOMPUTED_ROUTE])
    if (req.neuronIds.length === 0) return this.assembleSkeletons([])

    const source = await this.skeletonDir(req.signal)
    const result = await fetchSkeletons(
      source,
      req.neuronIds,
      skeletonFetchOptions(
        req,
        req.onPartial && ((skeletons) => req.onPartial?.(this.assembleSkeletons(skeletons))),
      ),
    )
    /*
     * Said rather than assembled and dropped. A segment with no skeleton is an ordinary answer —
     * not every segment is reconstructed — but a scene quietly holding fewer neurons than were
     * asked for is the kind of thing somebody notices two steps later, if at all. The mesh path
     * has `onWarn` for a cost only the backend knows; this is a *result* only the backend knows.
     */
    if (result.missing.length > 0) {
      req.onWarn?.(
        `${result.missing.length} of ${req.neuronIds.length} segments have no skeleton in ` +
          `${this.label}, so they are not in this result.`,
      )
    }
    return this.assembleSkeletons(result.skeletons)
  }

  /**
   * Skeletons and their attribute rows as one value.
   *
   * `assemble`'s twin, and the reason the two are not one function: the attribute *columns* are
   * shared but what fills them is not — `points` is vertices either way, and `cableLength` is the
   * one number a skeleton can answer and a mesh cannot. Merging them would mean a parameter
   * saying which of the two this is, which is the branch written out anyway.
   */
  private assembleSkeletons(items: readonly SkeletonGeometry[]): SkeletonsValue {
    const schema = this.schemas.morphology
    return {
      kind: 'skeletons',
      items: [...items],
      attributes: makeTable(schema, {
        neuronId: items.map((item) => item.id),
        points: items.map((item) => item.parents.length),
        // `core/values`' own, memoised on the geometry's identity — which is what keeps a
        // streaming fetch from re-summing every skeleton already delivered on each partial.
        cableLength: items.map((item) => cableLength(item)),
      }),
      bounds: boundsOf(items.map((item) => item.positions)),
      provenance: PRECOMPUTED_ROUTE,
      ...this.frame(),
    }
  }

  /**
   * The skeleton directory, opened.
   *
   * `meshDir`'s twin: it costs no requests, because the probe opened it already. The refusal is
   * likewise the one the probe cannot state — a source that reads perfectly well and simply has
   * no skeletons in it, which is most of them.
   */
  private async skeletonDir(signal: AbortSignal | undefined): Promise<SkeletonSource> {
    const source = await this.describe(signal ? { signal } : {})
    if (!source.skeletonUrl) {
      throw new Error(
        `${this.ref.canonical} publishes no skeletons — it is ${source.summary}. A segmentation ` +
          `names its skeleton directory in the same info that names its meshes, and most name ` +
          `neither.`,
      )
    }
    // Keyed on the URL rather than the opened copy — see `meshDir` for why they are not the
    // same question.
    return source.skeletons ?? openSkeletonSource(source.skeletonUrl, signal ? { signal } : {})
  }

  /**
   * The mesh directory, opened.
   *
   * Usually costs no requests: the probe opened it already and holds the result precisely so that
   * the first Run does not re-read an `info` it has seen.
   *
   * **The refusal keys on `meshUrl`, not on the opened copy**, and that distinction is the whole
   * of this method. `tryOpen` swallows a transient failure, and the probe is then cached as a
   * *success* with no opened directory — so refusing here on `mesh` would report
   * "publishes no meshes" forever after one CORS blip, on a source whose `capabilitiesFor` (which
   * reads `meshUrl`) still says it has them. Absent means "not opened", so open it, and let that
   * attempt say what actually went wrong.
   */
  private async meshDir(signal: AbortSignal | undefined): Promise<MeshSource> {
    const source = await this.describe(signal ? { signal } : {})
    if (!source.meshUrl) {
      throw new Error(
        `${this.ref.canonical} publishes no meshes — it is ${source.summary}. Point this node ` +
          `at a segmentation that names a mesh directory, or at the mesh directory itself.`,
      )
    }
    // `openMeshDir`, not `openMeshSource`: `meshUrl` is a directory the volume already named, so
    // the question "what is this URL" is settled — and a legacy one commonly has no `info`.
    return source.mesh ?? openMeshDir(source.meshUrl, signal ? { signal } : {})
  }

  /**
   * Units and template space for anything this hands back.
   *
   * Precomputed geometry is physical nanometres by construction. The space comes back empty for
   * every datasource, because `spaceForDataset` is keyed on a dataset id it has an entry for and
   * a bucket URL is not one — which is the honest answer: nothing here says a bucket holds
   * hemibrain, so a Transform node has no grounds to warp it.
   */
  private frame() {
    return geometryFrame(this.id, this.datasetId, 'nm')
  }
}
