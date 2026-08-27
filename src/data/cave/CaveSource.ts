/**
 * CAVE as a Coda `DataSource`: datastacks, materializations, neurons and connectivity.
 *
 * The three modules beside this one carry the parts that are easy to get silently wrong —
 * `json.ts` the 64-bit ids, `api.ts` the endpoint shapes, `spec.ts` which table means what.
 * What is left here is the economics, and they are the opposite of neuPrint's:
 *
 * **neuPrint is queried; CAVE is downloaded.** neuPrint runs Cypher against a shared production
 * Neo4j, so every question is a round trip and `findNeurons` compiles a pattern into a query.
 * CAVE's query API has no regex worth using, no `GROUP BY`, and a 500,000-row cap it cannot
 * report to a browser — but the annotations are only a few tens of megabytes and are *already*
 * what the Explore widget wants. So this source fetches the neuron index once per dataset,
 * pivots it, caches it through the machinery Explore already has, and answers `findNeurons`
 * from memory. Every query after the first is instant, which is a genuine gain rather than a
 * consolation; the cost is that the first one waits for the download.
 *
 * That is also why `neuronFilter.ts` exists: filtering locally means Coda decides what a
 * pattern means, and it has to decide the same thing the mock does and the same thing
 * neuPrint's `=~` does, or one graph pointed at two backends quietly returns two answers.
 *
 * **Connectivity is a view, not an aggregation done here.** See `ConnectionViewSpec`. A
 * datastack without one refuses rather than downloading 244 million synapse rows to count them.
 */

import { describeDuration } from '../../core/limits'
import { ID_COLUMN_NAME, idText } from '../../core/ids'
import type { TableSchema } from '../../core/types'
import type { NeuronId } from '../../core/ids'
import type {
  DatasetAnnotations,
  CellValue,
  ColumnData,
  GeometryUnits,
  MatrixValue,
  MeshGeometry,
  MeshesValue,
  PointsValue,
  SkeletonGeometry,
  SkeletonsValue,
  TableValue,
} from '../../core/values'
import { boundsOf, getRow, makeTable, selectRows, tableFromRows } from '../../core/values'
import { geometryFrame } from '../transforms/spaces'
import type {
  AdjacencyRequest,
  CoarseGeometry,
  CoarseGeometryRequest,
  ConnectivityRequest,
  DataSource,
  DatasetInfo,
  FindNeuronsRequest,
  GeometryRequest,
  SourceCapabilities,
  SourceSchemas,
  SynapseRequest,
  ViewerSceneRequest,
} from '../source'
import { reportSourceLearned } from '../source'
import type { NeuronIndexRequest } from '../neuronIndex'
import type { Edge } from '../connectivity'
import { matrixFromEdges, typesOf } from '../connectivity'
import { loadCachedTable, neuronIndexKey } from '../neuronIndex'
import { compileLabelMatch, preparedRows, refuseUnfilterableRoi } from '../neuronFilter'
import { fieldTermsMatch } from '../terms'
import { mapWithConcurrency } from '../concurrency'
import type { GrapheneMeshSource } from './meshes'
import {
  MESH_WARN_NEURONS,
  decimateGridFor,
  fragmentConcurrencyFor,
  openGrapheneMeshes,
  readGrapheneMesh,
} from './meshes'
import type { MeshResult, MeshSource } from '../precomputed'
import {
  DEFAULT_TRIANGLE_BUDGET,
  fetchCoarseMesh,
  fetchMeshes as fetchFlatMeshes,
  meshProgress,
} from '../precomputed'
import type { SkeletonSource } from '../precomputed/skeletons'
import { fetchSkeletons as fetchFlatSkeletons, openSkeletonSource } from '../precomputed/skeletons'
import { FLAT_SKELETON_MB, FLAT_SKELETON_WARN, peekFlat, probeFlat } from './flat'
import type { CaveRequestOptions, CaveRow } from './client'
import type { DatastackInfo } from './api'
import { CaveError } from './client'
import {
  listDatastacks,
  queryTableChecked,
  queryView,
  uniqueStringValues,
  versionsMetadata,
} from './api'
import { getServer } from './credentials'
import {
  caveServerFor,
  datastackRecord,
  l2SourceFor,
  peekL2Cache,
  usableVersions,
} from './datastack'
import { codaColumn, defaultSchemas, neuronSchemaFor, schemasFor } from './schema'
import { withAnnotations } from '../annotations/schema'
import { L2_SKELETON_WARN, readL2Skeletons } from './l2'
import { byteLengthOf, cachedGeometry } from '../geometryCache'
import { caveScene } from './scene'
import type { NgScene } from '../neuroglancer/scene'
import type { DatastackSpec, NeuronTableSpec, SynapseTableSpec } from './spec'
import {
  DATASTACK_SPECS,
  STANDARD_SYNAPSE_COLUMNS,
  datasetIdFor,
  specFor,
  splitDatasetId,
} from './spec'

/**
 * What CAVE can do today, and every `false` is a node that refuses cleanly rather than a
 * feature quietly missing.
 *
 * Meshes and synapses are live; skeletons are not, and the reason is recorded on the flag
 * itself because it is a fact about the *service* rather than about this code. `paths` is a
 * real absence: it needs a hop aggregated server-side, which CAVE has no endpoint for. So are
 * all three ROI flags — FlyWire's neuropil assignments are a reference table on *synapses*, so
 * there is no per-region completeness table to read and a per-neuron breakdown would mean
 * reading a neuron's synapses and grouping them, which is the work the connection roll-up
 * exists to avoid.
 */
const CAVE_CAPABILITIES: SourceCapabilities = {
  rawQuery: false,
  /**
   * Skeletons are the one morphology CAVE has and Coda cannot use yet, and the blocker is the
   * service rather than the format. `skeleton_source` is a standard `neuroglancer_skeletons`
   * precomputed endpoint declaring `radius` and `compartment` — but it is a *cache that
   * generates on demand*, and for `flywire_fafb_public` it is empty: 100 proofread root ids
   * sampled from two places in the table, across skeleton versions 0 through 4, came back
   * `exists: false` for every one, and a queued generation had not landed after five minutes.
   * A fetch therefore blocks on generation, per neuron, against a node whose ceiling is 500.
   * Claiming the capability would make every Skeletons run hang instead of decline.
   */
  /*
   * Per **dataset**, through `capabilitiesFor`. `false` is the source-level answer because it is
   * the safe one for a datastack nothing is known about yet; six of the thirteen the info
   * service lists have a level-2 cache and override this to true.
   */
  skeletons: false,
  meshes: true,
  synapses: true,
  neuronIndex: true,
  roiCounts: false,
  paths: false,
  /*
   * Built rather than published: CAVE has no curated state per datastack, but the info record
   * names every part of one. See `scene.ts`.
   */
  viewerScene: true,
  roiSummary: false,
  // A CAVE datastack publishes no regions at all.
  roiFilter: false,
  roiMeshes: false,
}

/** Nanometres, which is what every geometry value in Coda is in. */
const NANOMETRES = [1, 1, 1] as const

/**
 * How many neurons' meshes are in flight at once.
 *
 * Each is itself a fan-out of several hundred fragment requests, so this is one factor of what
 * reaches the bucket — `fragmentConcurrencyFor` divides the fragment budget by it, and
 * `MESH_WARN_NEURONS` is where it starts saying how long the queue will be.
 */
const MESH_CONCURRENCY = 3

/** Per-datastack state: where it is served from, and what its neuron table looks like. */
interface DatastackState {
  /** Where this datastack's mesh fragments live, resolved once. */
  meshes?: Promise<GrapheneMeshSource>
  schemas?: SourceSchemas
  /** Annotation kinds in CAVE's own spelling — what the index pages by. */
  systems?: string[]
  discovering?: Promise<void>
  /**
   * Whether inference has already asked for discovery. Never cleared on failure.
   *
   * The same rule, and the same reason, as `listingRequested`: inference runs on every graph
   * mutation, so a discovery that failed and was retried from there is a request per keystroke —
   * or, with no token, an auth-failure popup per keystroke. `runDiscovery` sets `schemas` only
   * on the success path, so without this flag every failure is retried forever.
   *
   * The *Run* path (`neuronSchema`) deliberately calls `discover` regardless, so pressing Run is
   * still what retries. That is the same shape as the Sources panel being the recovery for a
   * failed listing.
   */
  discoveryRequested?: boolean
}

/**
 * The `IN` filters for one edge query, in whichever table's column names.
 *
 * Shared by both paths so a filter cannot be built for the view's columns and sent to the
 * synapse table — which would not error, it would filter on a column that does not exist.
 */
function idFilters(
  columns: { preColumn: string; postColumn: string },
  ids: { pre?: readonly NeuronId[]; post?: readonly NeuronId[] },
): Record<string, Array<string | number>> {
  return {
    ...(ids.pre ? { [columns.preColumn]: [...ids.pre] } : {}),
    ...(ids.post ? { [columns.postColumn]: [...ids.post] } : {}),
  }
}

/** What a truncated read costs here, in the words `refuseIfCapped` appends to. */
const INCOMPLETE_EDGES =
  'the edge list would be incomplete. Ask about fewer neurons, or use a datastack that ' +
  'publishes a connection roll-up'

const INCOMPLETE_INDEX =
  'the neuron index would be incomplete. This datastack is too large to read in one request, ' +
  'and Coda cannot page it yet'

export class CaveSource implements DataSource {
  readonly id = 'cave'
  readonly label = 'CAVE'
  readonly description =
    'FlyWire and other CAVE-hosted connectomes. Needs a CAVE token; every dataset is pinned to a materialization.'
  readonly capabilities = CAVE_CAPABILITIES
  readonly schemas: SourceSchemas = defaultSchemas()

  private datasets: DatasetInfo[] | undefined
  private listing: Promise<DatasetInfo[]> | undefined
  private listingRequested = false
  /** Which global server produced `datasets`. A changed setting invalidates everything. */
  private listedFrom: string | undefined
  private readonly states = new Map<string, DatastackState>()

  // -------------------------------------------------------------------------
  // Datasets
  // -------------------------------------------------------------------------

  async listDatasets(signal?: AbortSignal): Promise<DatasetInfo[]> {
    const server = getServer()
    if (this.listedFrom !== server) this.reset(server)
    // Concurrent callers share one listing — a graph can hold several dataset nodes and each
    // one's inference peeks. Unlike the neuron index this is not persisted: it is small, and it
    // is the one thing that would tell us a materialization has expired.
    this.listing ??= this.runListing(server, signal).finally(() => {
      this.listing = undefined
    })
    return this.listing
  }

  peekDatasets(): DatasetInfo[] | undefined {
    if (!this.datasets && !this.listingRequested) {
      this.listingRequested = true
      // Swallowed: a peek has no caller to report to, and a 401 already travels on its own
      // channel to the Connections panel. Same trade as `NeuPrintSource.peekDatasets`.
      void this.listDatasets().catch(() => undefined)
    }
    return this.datasets
  }

  peekDataset(datasetId: string): DatasetInfo | undefined {
    return this.datasets?.find((d) => d.id === datasetId)
  }

  /**
   * Forget everything learned from one global server.
   *
   * `listing` is cleared with the rest, which is the part that matters: without it a listing for
   * the old server stays in flight, `listDatasets` hands that promise to a caller asking about
   * the new one, and the dataset picker quietly shows the previous deployment's datastacks.
   * `listedFrom` has exactly one writer for the same reason — it used to be re-pinned at the end
   * of `runListing`, which on that path put it back to the server being replaced.
   */
  private reset(server: string): void {
    this.listedFrom = server
    this.datasets = undefined
    this.listing = undefined
    this.listingRequested = false
    this.states.clear()
  }

  private async runListing(server: string, signal?: AbortSignal): Promise<DatasetInfo[]> {
    const options: CaveRequestOptions = signal ? { signal } : {}
    const available = new Set(await listDatastacks(server, options))
    /*
     * Only datastacks Coda has a spec for. The info service lists thirteen and most of them
     * would fail on the first Run — see `spec.ts` for why a CAVE datastack cannot describe its
     * own roles. Offering a dataset that cannot work is worse than not offering it.
     */
    const specs = DATASTACK_SPECS.filter((s) => available.has(s.datastack))
    const perSpec = await Promise.all(
      specs.map((spec) => this.listOne(spec, options).catch(() => [])),
    )
    this.datasets = perSpec.flat()
    reportSourceLearned(this.id)
    return this.datasets
  }

  private async listOne(
    spec: DatastackSpec,
    options: CaveRequestOptions,
  ): Promise<DatasetInfo[]> {
    const info = await datastackRecord(spec.datastack, options)
    const versions = await versionsMetadata(info.local_server, spec.datastack, options)
    // The same filter the materialization dropdown applies — see `usableVersions`.
    return usableVersions(versions).map((v) =>
      datasetInfoFor(spec, v.version, info, v.time_stamp, v.expires_on),
    )
  }

  /**
   * What this datastack can do, where it differs from the source.
   *
   * Skeletons only, and only when a peek has landed — `undefined` while neither has, which
   * `sourceSupports` reads as "same as the source", i.e. the safe `false`. `reportSourceLearned`
   * re-infers when an answer arrives, so the node stops refusing on its own.
   *
   * **Two independent sources of a skeleton, and both are peeked whatever the other says.** The
   * level-2 cache covers six of the thirteen datastacks the info service lists; a flat bucket
   * covers the released materializations somebody flattened. `flywire_fafb_public` is exactly the
   * case that makes asking both necessary — it has no L2 cache at all, so this answered a settled
   * `false` and the Skeletons node refused, while `gs://flywire_v141_m783/skeletons_mip_1` sat
   * there publishing them. `peekFlat` is called first so its read is *started* even in the branch
   * where L2 has already answered.
   */
  capabilitiesFor(datasetId: string): Partial<SourceCapabilities> | undefined {
    const parsed = splitDatasetId(datasetId)
    if (!parsed) return undefined
    const spec = specFor(parsed.datastack)
    const flat = spec ? peekFlat(spec, parsed.version) : undefined
    if (flat?.skeletonUrl) return { skeletons: true }
    const has = peekL2Cache(parsed.datastack)
    return has === undefined ? undefined : { skeletons: has }
  }

  // -------------------------------------------------------------------------
  // Schemas
  // -------------------------------------------------------------------------

  /**
   * Units and template space together. Always nanometres here; see `geometryFrame` for why the
   * two travel as one and when the space half is withheld.
   */
  private frame(datasetId: string): { units: GeometryUnits; space?: string } {
    return geometryFrame(this.id, datasetId, 'nm')
  }

  schemasFor(datasetId: string): SourceSchemas {
    const parsed = splitDatasetId(datasetId)
    const spec = parsed ? specFor(parsed.datastack) : undefined
    if (!spec) return this.schemas
    const state = this.state(spec.datastack)
    if (state.schemas) return state.schemas
    if (!state.discoveryRequested) {
      state.discoveryRequested = true
      // Swallowed: inference has no caller to report to, and a 401 already travels on its own
      // channel to the Connections panel.
      void this.discover(spec).catch(() => undefined)
    }
    return this.schemas
  }

  /**
   * Learn a datastack's annotation kinds. Idempotent, deduplicated, and cheap on purpose.
   *
   * `unique_string_values` is 52 kB where the annotations themselves are tens of megabytes,
   * which is what lets this run from inference while the index waits until something actually
   * asks for neurons.
   */
  private discover(spec: DatastackSpec): Promise<void> {
    const state = this.state(spec.datastack)
    if (state.schemas) return Promise.resolve()
    state.discovering ??= this.runDiscovery(spec, state).finally(() => {
      state.discovering = undefined
    })
    return state.discovering
  }

  private async runDiscovery(spec: DatastackSpec, state: DatastackState): Promise<void> {
    const server = await this.serverFor(spec)
    let systems: string[] = []
    if (spec.annotations) {
      const values = await uniqueStringValues(server, spec.datastack, spec.annotations.table)
      systems = [...(values[spec.annotations.systemColumn] ?? [])].sort()
    }
    state.systems = systems
    state.schemas = schemasFor(neuronSchemaFor(systems))
    reportSourceLearned(this.id)
  }

  // -------------------------------------------------------------------------
  // Neurons
  // -------------------------------------------------------------------------

  /**
   * The whole neuron table for a dataset, pivoted and cached.
   *
   * The fingerprint is the column list, as everywhere else here, so an index cached before
   * discovery learned about a new annotation kind is a miss rather than a table whose columns
   * disagree with the type the editor is advertising downstream.
   */
  async neuronIndex(req: NeuronIndexRequest): Promise<TableValue> {
    const { spec, version } = this.require(req.datasetId)

    /*
     * A wired annotation chain **replaces** the datastack's own labels, so it changes both what
     * the index contains and what it is keyed by. The key carries the chain, or two datasets
     * differing only in their annotations would share one cached table — and the *first* one
     * fetched would win, silently, for the rest of the session.
     */
    const annotations = req.annotations
    const schema = annotations
      ? withAnnotations(this.schemasFor(req.datasetId), annotations.table.schema).neurons
      : await this.neuronSchema(spec)
    return loadCachedTable({
      key: neuronIndexKey(this.id, req.datasetId, annotations?.key ?? ''),
      fingerprint: schema.columns.map((c) => c.name).join(','),
      ...(req.refresh ? { refresh: req.refresh } : {}),
      fetch: () => this.buildIndex(spec, version, schema, req),
    })
  }

  private async buildIndex(
    spec: DatastackSpec,
    version: number,
    schema: SourceSchemas['neurons'],
    req: NeuronIndexRequest,
  ): Promise<TableValue> {
    const options: CaveRequestOptions = req.signal ? { signal: req.signal } : {}

    /*
     * A wired chain replaces the datastack's labels, so its path fetches only the neuron list —
     * the built-in annotations would be five queries of up to 139,255 rows discarded a line
     * later. Two straight paths rather than one braided through three flags: the shared tail
     * below is what a single interleaved version kept losing, and did, for a phase.
     */
    if (req.annotations) {
      /*
       * **Which list, and it is a fact about the datastack rather than a preference.** Where one
       * publishes a neuron table, that is the population and the chain is left-joined onto it:
       * every neuron the segmentation knows about comes out, annotated or not, and an annotation
       * base full of ids that have since been edited away cannot put neurons in the index the
       * connectome can answer nothing about. Where it publishes none, the chain *is* the
       * population — which is not the same decision reversed, it is the only list there is.
       */
      req.onProgress?.(0.1, spec.neurons ? 'loading neurons' : 'reading annotations')
      // Narrowed to a local, because the await between the check and the read loses it.
      const neurons = spec.neurons
      let order: string[]
      if (neurons) {
        const server = await this.serverFor(spec)
        const rows = await this.readNeuronRows(spec, neurons, version, server, options, true)
        order = dedupedIds(rows.map((row) => row[neurons.idColumn]))
      } else {
        order = dedupedIds(req.annotations.table.data[ID_COLUMN_NAME] ?? [])
      }
      req.onProgress?.(0.9, 'building index')
      return this.finish(spec, version, joinIndex(order, req.annotations.table, schema), req)
    }

    /*
     * Nothing to enumerate and nothing wired to enumerate it. Refused rather than answered with
     * an empty table, which would read as a datastack with no neurons in it — and the fix is a
     * wire rather than anything about the data, so it is worth naming.
     */
    const neurons = spec.neurons
    if (!neurons) {
      throw new Error(
        `${spec.datastack} publishes no table listing its neurons, so Coda cannot enumerate ` +
          `them. Wire an Annotations source to the Dataset — whatever it names becomes the ` +
          `neuron list. Queries that start from ids you already have (Input IDs, Connectivity, ` +
          `Skeletons) need no such table.`,
      )
    }

    const server = await this.serverFor(spec)
    req.onProgress?.(0.1, 'loading neurons and annotations')
    const [neuronRows, perSystem] = await Promise.all([
      this.readNeuronRows(spec, neurons, version, server, options, false),
      this.loadAnnotations(spec, version, server, options),
    ])

    /*
     * Root id by the annotation table's reference key. Only this path needs it: the wired one
     * joins on the root id directly, because the chain is already keyed by `neuronId`.
     */
    const rootById = new Map<string, string>()
    for (const row of neuronRows) {
      const rootId = row[neurons.idColumn]
      if (rootId !== null && rootId !== undefined) rootById.set(String(row.id), String(rootId))
    }

    const annotations = new Map<string, Record<string, string>>()
    if (spec.annotations) {
      const { refColumn, valueColumn } = spec.annotations
      for (const [system, rows] of perSystem) {
        const name = codaColumn(system)
        for (const row of rows) {
          const rootId = rootById.get(String(row[refColumn]))
          const value = row[valueColumn]
          if (!rootId || value === null || value === undefined) continue
          let record = annotations.get(rootId)
          if (!record) {
            record = {}
            annotations.set(rootId, record)
          }
          record[name] = String(value)
        }
      }
    }

    req.onProgress?.(0.9, 'building index')
    return this.finish(
      spec,
      version,
      labelIndex(
        dedupedIds(neuronRows.map((row) => row[neurons.idColumn])),
        annotations,
        schema,
      ),
      req,
    )
  }

  /**
   * The neuron list.
   *
   * `id` is only fetched where it is read: the built-in path joins the annotation table through
   * it, and the wired one never touches it — about a third of a 6.5 MB response at 139,255 rows,
   * plus its share of `quoteWideIntegers` and the parse.
   */
  private async readNeuronRows(
    spec: DatastackSpec,
    neurons: NeuronTableSpec,
    version: number,
    server: string,
    options: CaveRequestOptions,
    idsOnly: boolean,
  ): Promise<CaveRow[]> {
    // Passed narrowed rather than read off `spec`, because `neurons` is optional now and a
    // method cannot inherit the caller's narrowing — a runtime guard here would be re-checking
    // something both call sites have already established.
    return queryTableChecked(
      server,
      spec.datastack,
      version,
      {
        table: neurons.table,
        columns: idsOnly ? [neurons.idColumn] : ['id', neurons.idColumn],
      },
      { consequence: INCOMPLETE_INDEX },
      options,
    )
  }

  /** The tail both paths share: the count the card reads, and the last progress tick. */
  private finish(
    spec: DatastackSpec,
    version: number,
    table: TableValue,
    req: NeuronIndexRequest,
  ): TableValue {
    this.noteNeuronCount(spec, version, table.length)
    req.onProgress?.(1, 'ready')
    return table
  }

  /**
   * Every annotation kind, one request each.
   *
   * A fix rather than a refinement. `hierarchical_neuron_annotations` is over CAVE's
   * 500,000-row cap in a single query — found live, on the first run of `live.test.ts`, where
   * the row-count endpoint had claimed 377,699 — so the whole table cannot be read at once and
   * `refuseIfCapped` was correctly making FlyWire unusable. Filtering by kind splits it into
   * five queries of 17k to 139k rows, all comfortably under, and the kinds come from discovery,
   * which has already run. The refusal stays as the backstop, now naming the kind that
   * overflowed.
   *
   * `Promise.all` rather than `mapWithConcurrency`: a dropped kind is a silently empty column
   * rather than a visible failure, so fail-fast is the semantics wanted here.
   */
  private loadAnnotations(
    spec: DatastackSpec,
    version: number,
    server: string,
    options: CaveRequestOptions,
  ): Promise<ReadonlyArray<readonly [string, CaveRow[]]>> {
    if (!spec.annotations) return Promise.resolve([])
    const { table, systemColumn, refColumn, valueColumn } = spec.annotations
    const { systems = [] } = this.state(spec.datastack)
    return Promise.all(
      systems.map(async (system) => {
        const rows = await queryTableChecked(
          server,
          spec.datastack,
          version,
          {
            table,
            filters: { equal: { [systemColumn]: system } },
            columns: [refColumn, valueColumn],
          },
          { of: `${table} (${system})`, consequence: INCOMPLETE_INDEX },
          options,
        )
        return [system, rows] as const
      }),
    )
  }

  /**
   * Fill in the neuron count once the index has actually been read.
   *
   * Not asked for at listing time, and that is a finding rather than a saving: the
   * materialization engine's `table/{t}/count` for `proofread_neurons` at v783 answers 127,978
   * while the table itself yields 137,181 distinct root ids. Whatever it counts, it is not what
   * a dataset card would be claiming — so the number comes from the rows Coda holds, and is
   * absent until then, which `DatasetInfo` already allows for.
   */
  private noteNeuronCount(spec: DatastackSpec, version: number, count: number): void {
    const info = this.datasets?.find((d) => d.id === datasetIdFor(spec.datastack, version))
    if (!info || info.neuronCount === count) return
    info.neuronCount = count
    reportSourceLearned(this.id)
  }

  async findNeurons(req: FindNeuronsRequest): Promise<TableValue> {
    const index = await this.neuronIndex({
      datasetId: req.datasetId,
      // Forwarded, or a wired chain reaches the *type* and never the rows: three query nodes
      // advertised its columns and returned the datastack's, and a second whole index was built
      // and cached under the unannotated key.
      ...(req.annotations ? { annotations: req.annotations } : {}),
      ...(req.signal ? { signal: req.signal } : {}),
    })

    const prepared = preparedRows(index, req, 'This CAVE datastack')
    const labelTest = compileLabelMatch(req.labels)
    // Present-and-empty means no neurons, never "no filter" — the seam's documented rule, and
    // the one an unconfigured node depends on.
    const wantedIds = req.neuronIds ? new Set<string>(req.neuronIds) : undefined

    /*
     * The one filter a CAVE datastack has nothing to answer with, refused before a row is read.
     *
     * `roi` is unreachable from the UI here — the picker is fed from `DatasetInfo.rois`, which is
     * empty — so this is what a graph saved against another backend meets. `minSize` and `status`
     * used to need the same treatment and no longer do: they are rows now, and a row can only
     * name a column this datastack's own schema publishes. The failure that motivated it was
     * `Number(index.data.size?.[i] ?? 0)` against a column no CAVE index has, which put every
     * neuron below any non-zero floor and answered nothing at all.
     */
    refuseUnfilterableRoi(req, 'This CAVE datastack')

    /*
     * Columns are hoisted by `prepareFieldTerms`, and a row record is built only for `labels` —
     * the one filter that genuinely needs a whole row. Materialising every row first cost 139,255
     * objects per query, discarded overwhelmingly by the very next line.
     */
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

  // -------------------------------------------------------------------------
  // Connectivity
  // -------------------------------------------------------------------------

  async fetchConnectivity(req: ConnectivityRequest): Promise<TableValue> {
    const { spec, version } = this.require(req.datasetId)

    // Query-relative, which is what the seam promises: `neuronId` is always the neuron that was
    // asked about, whichever way the synapse points. The Connectivity node re-orients into
    // pre/post itself — see `nodes/lib/connectivityOps.ts`.
    const outputs = req.direction === 'outputs'

    // Together: the type lookup may have to download the index, and there is no reason for the
    // connectivity query to wait behind it.
    const [edges, types] = await Promise.all([
      this.edges(
        spec,
        version,
        outputs ? { pre: req.neuronIds } : { post: req.neuronIds },
        req.minWeight,
        req.signal,
      ),
      this.typeLookup(req),
    ])
    return tableFromRows(
      this.schemasFor(req.datasetId).connectivity,
      edges.map((edge) => {
        const neuronId = outputs ? edge.pre : edge.post
        const partnerId = outputs ? edge.post : edge.pre
        return {
          [ID_COLUMN_NAME]: neuronId,
          neuronType: types.get(neuronId) ?? null,
          partnerId,
          partnerType: types.get(partnerId) ?? null,
          weight: edge.weight,
        }
      }),
    )
  }

  async fetchAdjacency(req: AdjacencyRequest): Promise<MatrixValue> {
    const { spec, version } = this.require(req.datasetId)

    const [edges, types] = await Promise.all([
      this.edges(
        spec,
        version,
        { pre: req.sourceIds, post: req.targetIds },
        undefined,
        req.signal,
      ),
      req.groupByType ? this.typeLookup(req) : undefined,
    ])
    return matrixFromEdges(edges, req.sourceIds, req.targetIds, types)
  }

  /**
   * An edge list, from the roll-up view if there is one and from the synapses if not.
   *
   * **Two paths that answer the same question at very different prices**, which is why the view
   * is preferred wherever it exists rather than being one option among two. FlyWire's
   * `valid_connection_v2` is the server having done this aggregation once, and it can push the
   * weight cut down with it: on one neuron's outputs that is 183 rows at 16 kB against 4,818 at
   * 410 kB. The synapse path can push neither — CAVE's query API has no `GROUP BY`, so every
   * synapse of every queried neuron is transferred and counted here, and `minWeight` can only be
   * applied *after* counting.
   *
   * It is still worth having, and by a long way: most CAVE datastacks publish no roll-up at all,
   * so the alternative is not a cheaper query but no connectivity. Measured on Aedes, which is
   * exactly that case — one neuron's 719 synapses arrive in 1.1 s and 111 kB and collapse to 508
   * partners. The shape is `connecto`'s, which solved this first.
   */
  private async edges(
    spec: DatastackSpec,
    version: number,
    ids: { pre?: readonly NeuronId[]; post?: readonly NeuronId[] },
    minWeight: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Edge[]> {
    const server = await this.serverFor(spec)
    const options: CaveRequestOptions = signal ? { signal } : {}

    if (spec.connections) {
      const links = spec.connections
      const rows = await queryView(
        server,
        spec.datastack,
        version,
        {
          view: links.view,
          filters: {
            in: idFilters(links, ids),
            // Applied by the server, before anything is sent.
            ...(minWeight && minWeight > 1
              ? { atLeast: { [links.weightColumn]: minWeight } }
              : {}),
          },
          columns: [links.preColumn, links.postColumn, links.weightColumn],
        },
        options,
      )
      return rows.map((row) => ({
        pre: String(row[links.preColumn]),
        post: String(row[links.postColumn]),
        weight: Number(row[links.weightColumn] ?? 0),
      }))
    }

    const synapses = await this.synapsesFor(spec, options)
    if (!synapses) {
      throw new CaveError(
        `${spec.label} publishes neither a connection roll-up nor a synapse table, so Coda ` +
          `cannot build an edge list from it.`,
      )
    }

    /*
     * Only the two id columns are asked for, which is what makes this affordable. Note the
     * server sends more than that anyway: `select_columns` on a `*_pt_root_id` returns the whole
     * bound point, so the supervoxel id comes along and the transfer is about twice what the two
     * columns suggest. Measured rather than assumed, on Aedes.
     */
    const rows = await queryTableChecked(
      server,
      spec.datastack,
      version,
      {
        table: synapses.table,
        filters: { in: idFilters(synapses, ids) },
        columns: [synapses.preColumn, synapses.postColumn],
      },
      { consequence: INCOMPLETE_EDGES },
      options,
    )

    /*
     * Counted with a joined key rather than a nested map: a neuron id is decimal digits by
     * invariant 8's grammar, so `|` cannot occur in one and the join is unambiguous — the
     * separator collision `uploads.ts` records is not reachable here.
     */
    const counts = new Map<string, Edge>()
    for (const row of rows) {
      const pre = idText(row[synapses.preColumn] ?? null)
      const post = idText(row[synapses.postColumn] ?? null)
      if (pre === null || post === null) continue
      const key = `${pre}|${post}`
      const seen = counts.get(key)
      if (seen) seen.weight += 1
      else counts.set(key, { pre, post, weight: 1 })
    }

    // The key is never read back — the edge holds its own ends — so `|` only has to keep two
    // pairs apart, which digits do. After counting, never before: there is no synapse-level
    // equivalent of a weight cut.
    const floor = minWeight && minWeight > 1 ? minWeight : 0
    return [...counts.values()].filter((edge) => edge.weight >= floor)
  }

  /**
   * Which table holds this datastack's synapses, if any.
   *
   * Three answers in order, and the order is the point. **A configured spec wins**, because it
   * can name a curated table and the column that scores it — FlyWire's `synapses_nt_v1` with
   * `cleft_score`, which the datastack itself declares as `synapse_table: null`. **Otherwise the
   * datastack's own declaration**, which is what makes a hand-named datastack work with no
   * configuration: 7 of the 13 the info service lists set it, Aedes among them. Its columns are
   * the standard `synapse` schema's, which is a definition rather than a guess.
   */
  private async synapsesFor(
    spec: DatastackSpec,
    options: CaveRequestOptions,
  ): Promise<SynapseTableSpec | undefined> {
    if (spec.synapses) return spec.synapses
    const declared = (await datastackRecord(spec.datastack, options)).synapse_table
    return declared ? { table: declared, ...STANDARD_SYNAPSE_COLUMNS } : undefined
  }

  // -------------------------------------------------------------------------
  // Neuroglancer
  // -------------------------------------------------------------------------

  /**
   * A scene assembled from the datastack's own info record.
   *
   * Cached by `datastackRecord` rather than here — the record is memoised per datastack and this
   * is pure over it, so the `cheap` node asking on every restyle costs one object.
   */
  async fetchViewerScene(req: ViewerSceneRequest): Promise<NgScene | undefined> {
    const { spec } = this.require(req.datasetId)
    const options: CaveRequestOptions = req.signal ? { signal: req.signal } : {}
    return caveScene(spec.datastack, await datastackRecord(spec.datastack, options))
  }

  // -------------------------------------------------------------------------
  // Morphology
  // -------------------------------------------------------------------------

  /**
   * Neuron meshes, from whichever of the two segmentations this materialization has.
   *
   * **A flat bucket wins wherever there is one, and the gap is not a tuning difference.**
   * Graphene publishes supervoxel fragments at full resolution and has no levels at all, so one
   * FlyWire neuron is 492 range requests and ~1.2 MB, and `decimateMesh` is what makes a scene
   * of them survivable. `gs://flywire_v141_m783` answers the same neuron in two range requests
   * off a 3-to-5 level pyramid. See `DatastackSpec.flat` for which materializations have one and
   * why BANC's bucket is deliberately not among them.
   */
  async fetchMeshes(req: GeometryRequest): Promise<MeshesValue> {
    const { spec, version } = this.require(req.datasetId)
    const flat = await this.flatMeshDir(spec, version, req.signal)
    return flat ? this.flatMeshes(req, spec, flat) : this.grapheneMeshes(req, spec)
  }

  /**
   * The flat route: a published pyramid, read by `precomputed/index.ts` unchanged.
   *
   * Nanometres with no conversion, and that is measured rather than assumed — the mesh bounding
   * box for FlyWire v783's `720575940633370649` is x 682,703–723,512 nm, against 682,704–723,568
   * for the same neuron's published skeleton. The `transform` in the mesh `info` is what does it,
   * and `fragmentTransform` already applies it.
   */
  private async flatMeshes(
    req: GeometryRequest,
    spec: DatastackSpec,
    source: MeshSource,
  ): Promise<MeshesValue> {
    let types: Map<string, string> | undefined
    const typesReady = this.morphologyTypes(req).then((t) => (types = t))
    const assemble = (meshes: readonly MeshResult[], detail?: MeshesValue['detail']) =>
      this.meshValue(
        req,
        meshes.map((mesh) => ({ id: mesh.neuronId, positions: mesh.positions, indices: mesh.indices })),
        types,
        detail,
      )

    const result = await fetchFlatMeshes(source, req.neuronIds, {
      ...(req.signal ? { signal: req.signal } : {}),
      ...(req.refresh ? { refresh: true } : {}),
      ...(req.onFetched ? { onFetched: req.onFetched } : {}),
      ...(req.onProgress ? { onProgress: meshProgress(req.onProgress) } : {}),
      triangleBudget: req.triangleBudget ?? DEFAULT_TRIANGLE_BUDGET,
      // No `detail` on a partial: the caption's triangle count is only true of the whole batch.
      ...(req.onPartial ? { onPartial: (meshes) => req.onPartial?.(assemble(meshes)) } : {}),
    })

    /*
     * Reported, because it means something specific here that it does not mean for a bucket
     * somebody pasted. A flat segmentation holds *this materialization's* root ids and no
     * others, so a miss is usually an id from a different version rather than a neuron nobody
     * meshed — and the graphene route, which answers for any root id ever minted, is the thing
     * to say so.
     */
    if (result.missing.length > 0) {
      req.onWarn?.(
        `${result.missing.length.toLocaleString()} of ${req.neuronIds.length.toLocaleString()} ` +
          `neurons have no mesh in ${spec.label}'s published segmentation for this version, so ` +
          `they are not in this result. A flat segmentation holds the root ids that were current ` +
          `when it was written; an id from another materialization will not be in it.`,
      )
    }

    await typesReady
    return assemble(
      result.meshes,
      result.lod !== undefined && result.levels !== undefined
        ? { lod: result.lod, levels: result.levels, triangles: result.triangles }
        : undefined,
    )
  }

  /**
   * The graphene route: one manifest and several hundred Draco fragments apiece.
   *
   * The cost is said here rather than on the node, because it is a fact about graphene and not
   * about the Meshes node: the same node against neuPrint's multi-resolution meshes is cheap at
   * a thousand, where this is 492 requests and ~1.2 MB for *one* neuron. That is what
   * `onWarn` exists for — the node cannot know it, and the source cannot reach the card.
   *
   * It was a refusal at twenty until it became clear what that meant: twenty is a figure, and a
   * FlyWire question about a hundred neurons is an ordinary question. So the number stayed and
   * its verdict changed — past `MESH_WARN_NEURONS` the fetch says how long it will be and then
   * goes and does it, with `MESH_CONCURRENCY` and the session geometry cache doing the actual
   * work of making that survivable.
   */
  private async grapheneMeshes(req: GeometryRequest, spec: DatastackSpec): Promise<MeshesValue> {
    // No materialization here, deliberately: a graphene mesh is keyed by root id, and a root id
    // names one immutable agglomeration — an edit mints a new one — so the mesh for an id from
    // v783 is the same mesh whichever version named it. The flat route above is the opposite
    // case, which is why it is keyed by version and this is not.
    if (req.neuronIds.length > MESH_WARN_NEURONS) {
      /*
       * FlyWire's numbers, and deliberately the slow end rather than a mean: 492 fragments and
       * ~1.2 MB apiece, eight at a time, which is about four seconds a neuron. How far off that
       * is for another datastack depends on how its meshing agglomerates — BANC's answers one
       * neuron in 61 fragments, because it serves chunkedgraph layers 2–6 rather than leaves. An
       * estimate that is never shorter than the wait is the right kind of wrong for a warning.
       */
      req.onWarn?.(
        `${req.neuronIds.length.toLocaleString()} graphene meshes from ${spec.label} is up to ` +
          `${describeDuration(req.neuronIds.length * 4)} and around ` +
          `${Math.round(req.neuronIds.length * 1.2)} MB. A graphene mesh has no level of ` +
          `detail, so each one is dozens to hundreds of requests — this is the slow route, and ` +
          `a materialization with a flat segmentation beside it does the same set in two ` +
          `requests a neuron. Fetching anyway; cancel if that is not what you meant.`,
      )
    }

    const source = await this.meshSource(spec, req.signal)
    const options: CaveRequestOptions = req.signal ? { signal: req.signal } : {}

    /*
     * The caller's triangle budget decides how hard each mesh is decimated — see
     * `decimateGridFor`. This is the one source in the tree that can honour `triangleBudget`
     * exactly rather than snapping to a published level, because graphene has no levels but
     * `decimateMesh` has a continuous knob.
     */
    const inFlight = Math.min(MESH_CONCURRENCY, req.neuronIds.length)
    const grid = decimateGridFor(
      req.triangleBudget ?? DEFAULT_TRIANGLE_BUDGET,
      req.neuronIds.length,
    )
    const fragmentLimit = fragmentConcurrencyFor(inFlight)

    /*
     * Cached per root id, and this is the source where it matters most: one graphene mesh is
     * several hundred Range requests and about a megabyte, so re-fetching twenty because a
     * twenty-first was added is thousands of round trips for nothing.
     *
     * Safe to hold indefinitely for the reason stated above — a root id names one immutable
     * agglomeration, and an edit mints a new id — but the *decimation* is not part of the id, so
     * it goes in the key. `decimateGridFor` depends on both the triangle budget and the batch
     * size, so a scene grown from twenty neurons to forty legitimately re-reads them all.
     */
    // Started alongside the download rather than before it, and nothing publishes until it lands
    // — see `morphologyTypes`.
    let types: Map<string, string> | undefined
    const typesReady = this.morphologyTypes(req).then((t) => (types = t))

    /**
     * The whole value from one walk, so a partial and the final answer cannot build it two ways.
     *
     * Items carry their own id rather than being zipped against a second list by index — the
     * shape `NeuPrintSource.fetchMeshes` already uses, and the one that cannot fall out of step.
     */
    const assemble = (
      pairs: ReadonlyArray<[string, Omit<MeshGeometry, 'id'>]>,
      detail?: MeshesValue['detail'],
    ): MeshesValue =>
      this.meshValue(
        req,
        pairs.map(([id, mesh]) => ({ id, ...mesh })),
        types,
        detail,
      )

    let done = 0
    const fetched = await cachedGeometry<Omit<MeshGeometry, 'id'>>({
      ids: req.neuronIds,
      key: (id) => `cave:${this.id}:${req.datasetId}:mesh:${grid}:${id}`,
      bytes: (m) => byteLengthOf(m.positions, m.indices),
      refresh: req.refresh,
      onFetched: req.onFetched,
      readyBefore: typesReady,
      onPartial: req.onPartial && ((pairs) => req.onPartial?.(assemble(pairs))),
      fetch: async (missing, deliver) => {
        await mapWithConcurrency(missing, MESH_CONCURRENCY, async (neuronId) => {
          const mesh = await readGrapheneMesh(source, neuronId, grid, fragmentLimit, options)
          req.onProgress?.(++done / missing.length, `${done}/${missing.length} meshes`)
          if (mesh) deliver(neuronId, { positions: mesh.positions, indices: mesh.indices })
        })
      },
    })

    const triangles = fetched.ordered.reduce((sum, [, m]) => sum + m.indices.length / 3, 0)
    await typesReady
    /*
     * One level, and decimated — which the caption has to say. Graphene publishes supervoxel
     * fragments at full resolution, so `lod`/`levels` describe nothing here; what a reader needs
     * to know is that 98% of the triangles were merged away, on the same rule that keeps `labels
     * thinned` and `cells merged` on screen.
     */
    return assemble(fetched.ordered, { lod: 0, levels: 1, triangles, decimated: true })
  }

  /**
   * Skeletons, from whichever of the two routes this materialization has.
   *
   * **Published beats built, and they are not the same product.** A flat bucket's
   * `skeletons_mip_1` is a skeletonisation of the segmentation itself — measured across ten
   * FlyWire v783 neurons, 14,559 to 338,087 nodes with a radius and a cross-sectional area on
   * every one. An L2 skeleton is one node per level-2 chunk, tens to a few thousand, and is the
   * right shape for NBLAST and cable length but is a chunk decomposition rather than a
   * reconstruction. Where a datastack has both, the published one is the better answer and costs
   * one request per neuron instead of two.
   *
   * In practice no datastack has both, and the reason is the same fact twice: FlyWire's
   * skeletons exist *because* it has no L2 cache to build any from, and the datastacks with a
   * cache (BANC, minnie65, Aedes) have no flat pyramid worth naming. The preference is written
   * down anyway, because "they never coexist" is a fact about today's spec table rather than
   * about CAVE.
   *
   * The gate is per **dataset**, not per source, and this refuses again at run time because a
   * peek can be `undefined` when the node was configured.
   */
  async fetchSkeletons(req: GeometryRequest): Promise<SkeletonsValue> {
    const { spec, version } = this.require(req.datasetId)
    const flat = await this.flatSkeletonDir(spec, version, req.signal)
    if (flat) return this.flatSkeletons(req, spec, flat)
    return this.l2Skeletons(req, spec)
  }

  /**
   * The published route: one request per neuron, out of the bucket's shard index.
   *
   * Nanometres already — measured, x 682,704–723,568 for FlyWire v783's `720575940633370649`,
   * matching that neuron's mesh — so `parseSkeleton`'s identity transform is the whole of the
   * conversion. `spanningForest` inside it is what makes `parents` a rooted tree in visit order,
   * which is the invariant every consumer that walks to a root depends on.
   */
  private async flatSkeletons(
    req: GeometryRequest,
    spec: DatastackSpec,
    source: SkeletonSource,
  ): Promise<SkeletonsValue> {
    if (req.neuronIds.length > FLAT_SKELETON_WARN) {
      const megabytes = Math.round(req.neuronIds.length * FLAT_SKELETON_MB)
      req.onWarn?.(
        `${req.neuronIds.length.toLocaleString()} skeletons from ${spec.label} is around ` +
          `${megabytes.toLocaleString()} MB and ${describeDuration(req.neuronIds.length * 0.2)}. ` +
          `These are skeletonised at mip 1 — tens of thousands of nodes each, not the few ` +
          `hundred a chunk-graph skeleton has — so the cost here is memory rather than the ` +
          `wait. Fetching anyway; cancel if that is not what you meant.`,
      )
    }

    // Started alongside the download and read from a local, never an instance field: one source
    // serves every graph in the tab, so per-request state on `this` is one run reading another's.
    let types: Map<string, string> | undefined
    const typesReady = this.morphologyTypes(req).then((t) => (types = t))
    const assemble = (items: readonly SkeletonGeometry[]): SkeletonsValue => ({
      kind: 'skeletons',
      items: [...items],
      attributes: this.morphologyTable(req, items, types),
      bounds: boundsOf(items.map((item) => item.positions)),
      ...this.frame(req.datasetId),
    })

    const result = await fetchFlatSkeletons(source, req.neuronIds, {
      ...(req.signal ? { signal: req.signal } : {}),
      ...(req.refresh ? { refresh: true } : {}),
      ...(req.onFetched ? { onFetched: req.onFetched } : {}),
      ...(req.onPartial ? { onPartial: (items) => req.onPartial?.(assemble(items)) } : {}),
      ...(req.onProgress
        ? {
            onProgress: (done: number, total: number) =>
              req.onProgress?.(done / Math.max(1, total), `${done}/${total} skeletons`),
          }
        : {}),
    })
    if (result.missing.length > 0) {
      req.onWarn?.(
        `${result.missing.length.toLocaleString()} of ` +
          `${req.neuronIds.length.toLocaleString()} neurons have no skeleton in ` +
          `${spec.label}'s published segmentation for this version, so they are not in this ` +
          `result.`,
      )
    }
    await typesReady
    return assemble(result.skeletons)
  }

  /**
   * The built route: two requests per neuron against the level-2 cache.
   *
   * The chunk graph, then the cache's representative coordinates — about 1.6 s. See `l2.ts` for
   * why this rather than the skeleton service several datastacks also publish.
   */
  private async l2Skeletons(req: GeometryRequest, spec: DatastackSpec): Promise<SkeletonsValue> {
    const options: CaveRequestOptions = req.signal ? { signal: req.signal } : {}

    if (req.neuronIds.length > L2_SKELETON_WARN) {
      // Two chunkedgraph reads apiece, sixteen at a time: ~0.3 s a neuron once warm.
      req.onWarn?.(
        `${req.neuronIds.length.toLocaleString()} skeletons from ${spec.label} is ` +
          `${describeDuration(req.neuronIds.length * 0.3)}. Each one is built from the ` +
          `level-2 cache rather than read ready-made, so this datastack is the slow way to get ` +
          `a skeleton. Building anyway.`,
      )
    }

    // The gate hands back what it resolved, so the segmentation URL is parsed once rather than
    // here and again inside the check.
    const source = await l2SourceFor(spec.datastack, options)
    if (!source) {
      throw new CaveError(
        `${spec.label} has no level-2 cache to build skeletons from, and no published skeletons ` +
          `for this materialization either. That is a fact about the datastack rather than ` +
          `about this graph — meshes and synapses are unaffected.`,
      )
    }

    /*
     * Warmed before the skeletons rather than awaited after them. The attribute table's
     * expensive half is `typeLookup`, which depends only on the request and can be the full
     * 139,255-row index download on a Skeletons node fed by an id list that never went through
     * Find Neurons. `loadCachedTable` shares an in-flight promise, so starting it here cannot
     * double-fetch — it just overlaps the whole skeleton fetch instead of following it. Skipped
     * where a chain is wired, because `morphologyAttributes` does not consult the index then.
     */
    if (!req.annotations) void this.typeLookup(req).catch(() => undefined)

    /*
     * Two requests per neuron and about 1.6 s each, so the session cache is worth more here than
     * the code it costs. Nothing but the root id decides the geometry — the level-2 cache
     * publishes `rep_coord_nm` and no conversion happens anywhere — so unlike the mesh above,
     * this key needs no parameter beyond the id.
     */
    const skeletons = await cachedGeometry<SkeletonGeometry>({
      ids: req.neuronIds,
      key: (id) => `cave:${this.id}:${req.datasetId}:l2skel:${id}`,
      bytes: (s) => byteLengthOf(s.positions, s.radii, s.parents),
      refresh: req.refresh,
      onFetched: req.onFetched,
      /*
       * No `onPartial`, and this is the one geometry fetch that cannot have one.
       *
       * `readL2Skeletons` is not a per-neuron fan-out that happens to be batched: it reads every
       * neuron's chunk graph, pools the chunk ids across the whole set, and reads their
       * coordinates in as few requests as it takes (`ATTRIBUTE_BATCH`). No skeleton exists until
       * that pooled read lands, so there is nothing to hand over early. Making it streamable
       * means reading attributes per neuron, which is more requests for a slower result — the
       * opposite trade to the one that made the batching worth writing.
       */
      fetch: async (missing, deliver) => {
        const read = await readL2Skeletons(source, missing, options, req.onProgress)
        for (const item of read) deliver(item.id, item)
      },
    })
    const items = skeletons.ordered.map(([, item]) => item)
    return {
      kind: 'skeletons',
      items,
      attributes: this.morphologyTable(req, items, await this.morphologyTypes(req)),
      bounds: boundsOf(items.map((i) => i.positions)),
      // The cache publishes `rep_coord_nm`, so no conversion happens anywhere.
      ...this.frame(req.datasetId),
    }
  }

  /**
   * A neuron's synapses as a point cloud, straight out of the synapse table.
   *
   * The cheapest capability on this source and the one that needed no new transport: it is
   * `queryTable` with a root-id filter, which is the same call connectivity makes. Positions
   * come back in nanometres because the request asks for them that way — see
   * `SynapseTableSpec`.
   */
  async fetchSynapses(req: SynapseRequest): Promise<PointsValue> {
    const { spec, version } = this.require(req.datasetId)
    const options: CaveRequestOptions = req.signal ? { signal: req.signal } : {}
    // The same resolution the edge list uses, so a datastack that can answer connectivity by
    // aggregation can also draw the synapses it aggregated. `positionColumn` is a *stem* the API
    // splits into `_x`/`_y`/`_z` — checked to behave identically on a declared table and a
    // configured one, which is what makes the standard columns usable here as well.
    const synapses = await this.synapsesFor(spec, options)
    if (!synapses) {
      throw new CaveError(`${spec.label} publishes no synapse table.`)
    }
    const server = await this.serverFor(spec)

    /*
     * `polarity` picks which end of the synapse the neuron is, which is also which end the
     * position describes. Undefined means both, so both queries run and the clouds are
     * concatenated — CAVE has no "either end" filter, and an `IN` on both columns would be an
     * AND rather than an OR.
     */
    const sides: Array<'pre' | 'post'> = req.polarity ? [req.polarity] : ['pre', 'post']
    const columns = [synapses.preColumn, synapses.postColumn, synapses.positionColumn]
    if (synapses.scoreColumn) columns.push(synapses.scoreColumn)

    /*
     * `minWeight` is applied by the *server*, which is the only place it is worth anything: it is
     * the one filter that cuts the download, against a query whose only other backstop is
     * `refuseIfCapped` — which refuses at whatever the *server* says this query holds, not at a
     * number of ours. The same `atLeast` clause the connection view uses.
     * It reads the table's confidence column, so a source whose spec names none simply cannot
     * honour it — and says nothing, because the node's default of 1 excludes nothing anyway.
     */
    const cut = req.minWeight && req.minWeight > 1 && synapses.scoreColumn
    req.onProgress?.(0.15, 'querying')

    const perSide = await Promise.all(
      sides.map(async (side) => {
        const column = side === 'pre' ? synapses.preColumn : synapses.postColumn
        const rows = await queryTableChecked(
          server,
          spec.datastack,
          version,
          {
            table: synapses.table,
            filters: {
              in: { [column]: [...req.neuronIds] },
              ...(cut ? { atLeast: { [synapses.scoreColumn!]: req.minWeight! } } : {}),
            },
            columns,
            resolution: NANOMETRES,
          },
          { of: `${synapses.table} (${side})`, consequence: INCOMPLETE_INDEX },
          req.signal ? { signal: req.signal } : {},
        )
        return [side, rows] as const
      }),
    )

    const total = perSide.reduce((sum, [, rows]) => sum + rows.length, 0)
    req.onProgress?.(0.7, `${total} synapses`)
    return synapsePoints(
      perSide,
      synapses,
      this.schemasFor(req.datasetId).synapses,
      this.frame(req.datasetId),
    )
  }

  /**
   * Cheapest geometry for one neuron, for a thumbnail — in whichever shape this datastack has.
   *
   * **Two routes, and the second is a skeleton rather than a mesh**, which is why
   * `CoarseGeometry` is a union at all. A materialization with a flat pyramid beside it answers
   * the coarsest published level. Everything else has only `graphene://`, where the cheapest
   * mesh is the *only* mesh: several hundred supervoxel fragments at full resolution, ~1.2 MB,
   * with no level to trade against — a page of 25 rows would be tens of megabytes, which is
   * exactly the case `fetchCoarseGeometry`'s docstring says to answer `undefined` for.
   *
   * The level-2 chunk graph is the way out. Two small requests give the neuron's shape — a few
   * hundred chunks with a representative coordinate each — and that is a drawing. It is what the
   * Skeletons node already builds, so this is `readL2Skeletons` for one neuron and no new
   * transport; `l2SourceFor` is the same gate, so a datastack with no cache still answers
   * `undefined` and draws the placeholder.
   *
   * **It costs one neuron's worth of batching, knowingly.** `readL2Skeletons` pools chunk ids
   * across a whole request and reads their coordinates in a handful of calls, which is what makes
   * a hundred skeletons a hundred graph reads plus about three attribute reads rather than two
   * hundred round trips. `CoarseGeometryRequest` is one neuron, so a page of 25 gives that up:
   * 25 chunk-graph reads plus 25 attribute reads, instead of 25 plus about one. Widening the seam to a page would mean a batching protocol between the
   * component and every source for a picture that is already gated at four concurrent and cached
   * in IndexedDB after the first look.
   */
  async fetchCoarseGeometry(req: CoarseGeometryRequest): Promise<CoarseGeometry | undefined> {
    const parsed = splitDatasetId(req.datasetId)
    const spec = parsed ? specFor(parsed.datastack) : undefined
    if (!spec || !parsed) return undefined
    const options: CaveRequestOptions = req.signal ? { signal: req.signal } : {}

    const pyramid = await this.flatMeshDir(spec, parsed.version, req.signal)
    if (pyramid) {
      const mesh = await fetchCoarseMesh(pyramid, req.neuronId, options)
      return mesh && { kind: 'mesh', ...mesh }
    }

    const l2 = await l2SourceFor(spec.datastack, options)
    if (!l2) return undefined
    const [skeleton] = await readL2Skeletons(l2, [req.neuronId], options)
    return skeleton ? { kind: 'skeleton', ...skeleton } : undefined
  }

  /**
   * Geometry and its attribute rows as one `MeshesValue`. Both mesh routes end here.
   *
   * Shared rather than written once per route, because the part that differs between them is
   * only where the triangles came from: the attribute table, the bounds and the frame are
   * properties of the *dataset*. Written twice, the flat route was the one that would quietly
   * lose `space` off `frame` and put a scene a template apart from the neurons beside it.
   *
   * `detail` is the one field a partial has no honest answer for, since it describes the whole
   * batch, so it arrives as an argument rather than being recomputed here.
   */
  private meshValue(
    req: GeometryRequest,
    items: MeshGeometry[],
    types: Map<string, string> | undefined,
    detail?: MeshesValue['detail'],
  ): MeshesValue {
    return {
      kind: 'meshes',
      items,
      attributes: this.morphologyTable(req, items, types),
      bounds: boundsOf(items.map((i) => i.positions)),
      ...(detail ? { detail } : {}),
      // Nanometres either way, and not by conversion — measured on both routes.
      ...this.frame(req.datasetId),
    }
  }

  /**
   * The flat bucket's mesh directory, opened — or nothing, which is the ordinary case.
   *
   * **Only a pyramid counts.** A `legacy` directory is one level at full resolution, which is
   * what graphene already gives and a good deal heavier: banc's flat bucket answers 28.4 MB and
   * 60.8 MB for two neurons the graphene route serves in ~200 kB of Draco. So a flat bucket that
   * turns out to publish legacy meshes is *not* used, and the caller falls back rather than
   * being told it has a better source than it has.
   *
   * Costs no requests of its own: `probePrecomputed` read the bucket's `info`, followed it to
   * the mesh directory and opened it, all memoised per URL.
   */
  private async flatMeshDir(
    spec: DatastackSpec,
    version: number,
    signal: AbortSignal | undefined,
  ): Promise<MeshSource | undefined> {
    const flat = await probeFlat(spec, version, signal ? { signal } : {})
    return flat?.mesh?.format === 'multilod-draco' ? flat.mesh : undefined
  }

  /**
   * The flat bucket's skeleton directory, opened — or nothing.
   *
   * Falls back to opening it here when the probe could not: `tryOpen` swallows a transient
   * failure and caches the probe as a *success* with no opened directory, so keying the refusal
   * on the opened copy would report "no skeletons" for the rest of the session after one blip.
   * `skeletonUrl` is what says the bucket *names* skeletons; see `PrecomputedSource.meshDir`.
   */
  private async flatSkeletonDir(
    spec: DatastackSpec,
    version: number,
    signal: AbortSignal | undefined,
  ): Promise<SkeletonSource | undefined> {
    const flat = await probeFlat(spec, version, signal ? { signal } : {})
    if (!flat?.skeletonUrl) return undefined
    return (
      flat.skeletons ??
      (await openSkeletonSource(flat.skeletonUrl, signal ? { signal } : {}).catch(() => undefined))
    )
  }

  /** Where a datastack's meshes live, asked for once. */
  private meshSource(
    spec: DatastackSpec,
    signal: AbortSignal | undefined,
  ): Promise<GrapheneMeshSource> {
    const state = this.state(spec.datastack)
    const options: CaveRequestOptions = signal ? { signal } : {}
    state.meshes ??= (async () => {
      const info = await datastackRecord(spec.datastack, options)
      // The two absences are said apart: a datastack that names no segmentation at all, and one
      // whose segmentation names a bucket this cannot read. One message for both would assert
      // something false about whichever case it was not written for.
      if (!info.segmentation_source) {
        throw new CaveError(`${spec.label} names no segmentation, so it has no neuron meshes.`)
      }
      const source = await openGrapheneMeshes(info.segmentation_source, options)
      if (!source) {
        throw new CaveError(
          `${spec.label}'s segmentation (${info.segmentation_source}) is not a graphene source ` +
            `Coda can read meshes from.`,
        )
      }
      return source
    })().catch((error: unknown) => {
      state.meshes = undefined
      throw error
    })
    return state.meshes
  }

  /**
   * The attribute row per fetched item, joined from the index.
   *
   * A `MeshesValue` pairs geometry with one row apiece, and that table is what every colour
   * encoding reads — so a mesh set with no type column would draw in one colour with a picker
   * offering nothing. The index is already in hand by the time anyone fetches morphology.
   */
  /**
   * The type lookup a morphology attribute table needs, or nothing when the chain supplies it.
   *
   * With a chain wired its labels *are* the labels, so `type` comes from `labelsFor` and the
   * datastack's index is neither needed nor consulted. It was awaited unconditionally and then
   * overwrote the chain's own `type` one line later — the opposite of what the socket promises,
   * and on a cold path (Meshes fed by an id list that never went through Find Neurons) it built
   * a whole 139,255-row index to label twenty meshes.
   *
   * Separate from the table build so that the streaming path can start it alongside the download
   * and publish once it lands, rather than either blocking the download on it or publishing a
   * scene whose every `type` is null and then restyling it wholesale.
   */
  private async morphologyTypes(req: GeometryRequest): Promise<Map<string, string> | undefined> {
    return req.annotations ? undefined : await this.typeLookup(req)
  }

  /**
   * The table itself, synchronous, so a partial answer can be assembled inside a callback.
   *
   * Only the id and the point count are read, which both geometry kinds carry — so meshes and
   * skeletons share this rather than each building an attribute table that could disagree about
   * which columns a morphology row has.
   */
  private morphologyTable(
    req: GeometryRequest,
    items: ReadonlyArray<{ id: string; positions: Float32Array }>,
    types: Map<string, string> | undefined,
  ): TableValue {
    return tableFromRows(
      withAnnotations(this.schemasFor(req.datasetId), req.annotations?.table.schema).morphology,
      items.map((item) => ({
        [ID_COLUMN_NAME]: item.id,
        ...labelsFor(req.annotations, item.id),
        ...(types ? { type: types.get(item.id) ?? null } : {}),
        points: item.positions.length / 3,
      })),
    )
  }

  /**
   * Neuron id → cell type, out of the cached index.
   *
   * A connectivity table without types is readable by nothing — the Network viewer's labels,
   * the Connectivity node's `preType`/`postType`, and every Group By downstream all want them —
   * and by the time anyone runs Connectivity the index is already in hand, because whatever
   * produced the neuron list needed it. A partner outside the annotated set has no type, which
   * is the honest answer rather than a gap.
   *
   * Memoised on the index's identity by `typesOf`, because this is called once per hop per
   * direction: `Hops: 3, Direction: both` is six calls in one Run, and Profile pays two per page
   * turn. Building a hundred thousand entries six times over to get the same answer is the
   * `searchIndexFor`/`statsFor` case exactly.
   */
  private async typeLookup(req: {
    datasetId: string
    annotations?: DatasetAnnotations
    signal?: AbortSignal
  }): Promise<Map<string, string>> {
    const index = await this.neuronIndex({
      datasetId: req.datasetId,
      ...(req.annotations ? { annotations: req.annotations } : {}),
      ...(req.signal ? { signal: req.signal } : {}),
    })
    return typesOf(index)
  }

  // -------------------------------------------------------------------------
  // Resolution helpers
  // -------------------------------------------------------------------------

  private state(datastack: string): DatastackState {
    let state = this.states.get(datastack)
    if (!state) {
      state = {}
      this.states.set(datastack, state)
    }
    return state
  }

  /** Parse and wire a dataset id, or say precisely which half is wrong. */
  private require(datasetId: string): { spec: DatastackSpec; version: number } {
    const parsed = splitDatasetId(datasetId)
    if (!parsed) {
      throw new CaveError(
        `"${datasetId}" does not name a CAVE dataset. Expected datastack:materialization, ` +
          `for example flywire_fafb_public:783.`,
      )
    }
    const spec = specFor(parsed.datastack)
    if (!spec) {
      throw new CaveError(
        `Coda has no wiring for the CAVE datastack "${parsed.datastack}". A datastack has to ` +
          `say which of its tables are neurons and which are connections — see ` +
          `src/data/cave/spec.ts.`,
      )
    }
    return { spec, version: parsed.version }
  }

  /** The neuron schema for a datastack, waiting for discovery if it has not run. */
  private async neuronSchema(spec: DatastackSpec): Promise<SourceSchemas['neurons']> {
    await this.discover(spec)
    return (this.state(spec.datastack).schemas ?? this.schemas).neurons
  }

  /** The server a datastack is served from. */
  private serverFor(spec: DatastackSpec): Promise<string> {
    return caveServerFor(spec.datastack)
  }
}

// ---------------------------------------------------------------------------

/**
 * Ids in the order given, deduplicated, first occurrence winning.
 *
 * Server order rather than a sort: it is stable across calls, and sorting eighteen-digit text
 * would put the neurons in an order nobody asked for. Deduplicated because both sources of a
 * neuron list can repeat one — a CAVE neuron table is keyed by a *point*, so one segment
 * carrying two of them is two rows, and an annotation base is somebody's spreadsheet — and a
 * repeat is double-counted by everything downstream that sums a weight.
 *
 * Through `idText`, which is the cell rule (invariant 8) rather than `String()`: it refuses a
 * number too wide to be exact instead of propagating the rounded form, which on this path is a
 * different neuron.
 */
function dedupedIds(cells: Iterable<CellValue | undefined>): string[] {
  const order: string[] = []
  const seen = new Set<string>()
  for (const cell of cells) {
    const id = idText(cell ?? null)
    if (id === null || seen.has(id)) continue
    seen.add(id)
    order.push(id)
  }
  return order
}

/**
 * The built-in path's table: the datastack's own labels, by root id.
 *
 * Column-wise for `joinIndex`'s reason — 139,255 row objects handed to `tableFromRows`, which
 * then re-reads every key, is two walks and a per-row allocation for a table this already holds
 * every value of.
 */
function labelIndex(
  order: readonly string[],
  labels: ReadonlyMap<string, Record<string, string>>,
  schema: TableSchema,
): TableValue {
  const data: Record<string, ColumnData> = {}
  for (const col of schema.columns) data[col.name] = []
  const ids = data[ID_COLUMN_NAME]!
  const targets = schema.columns
    .filter((c) => c.name !== ID_COLUMN_NAME)
    .map((c) => ({ name: c.name, into: data[c.name]! }))

  for (const rootId of order) {
    ids.push(rootId)
    const record = labels.get(rootId)
    for (const { name, into } of targets) into.push(record?.[name] ?? null)
  }
  return makeTable(schema, data, 'neurons')
}

/**
 * The datastack's neurons, labelled from the chain.
 *
 * A **left** join on the datastack's own order: every neuron the segmentation knows about comes
 * out, annotated or not. The other direction would let an annotation base decide which neurons
 * exist — and those bases routinely carry rows for ids that have since been edited away, which
 * would put neurons in the index that the connectome cannot answer a single query about.
 */
function joinIndex(
  order: readonly string[],
  annotations: TableValue,
  schema: TableSchema,
): TableValue {
  const at = annotationIndex(annotations)

  // Column arrays resolved once, not looked up by name per cell: 139,255 rows times a chain's
  // columns is millions of string-keyed loads otherwise. The hoist `findNeurons` already carries.
  const data: Record<string, ColumnData> = {}
  for (const col of schema.columns) data[col.name] = []
  const ids = data[ID_COLUMN_NAME]!
  const targets = schema.columns
    .filter((c) => c.name !== ID_COLUMN_NAME)
    .map((c) => ({ into: data[c.name]!, from: annotations.data[c.name] }))

  for (const rootId of order) {
    ids.push(rootId)
    const row = at.get(rootId)
    for (const { into, from } of targets) {
      into.push(row === undefined ? null : (from?.[row] ?? null))
    }
  }
  return makeTable(schema, data, 'neurons')
}

/** One neuron's labels out of a chain, by id. */
function labelsFor(
  annotations: DatasetAnnotations | undefined,
  id: string,
): Record<string, CellValue> {
  if (!annotations) return {}
  const index = annotationIndex(annotations.table)
  const row = index.get(id)
  if (row === undefined) return {}
  const labels: Record<string, CellValue> = {}
  for (const col of annotations.table.schema.columns) {
    if (col.name === ID_COLUMN_NAME) continue
    labels[col.name] = annotations.table.data[col.name]?.[row] ?? null
  }
  return labels
}

/**
 * Row index of an annotation table, built once per table.
 *
 * A `WeakMap` on the table itself, `typesOf`'s idiom: `labelsFor` is called per item, and
 * rebuilding a 58,000-entry map twenty times over to place twenty meshes is the case that memo
 * exists for.
 */
const annotationRows = new WeakMap<TableValue, Map<string, number>>()

function annotationIndex(table: TableValue): Map<string, number> {
  const cached = annotationRows.get(table)
  if (cached) return cached
  const index = new Map<string, number>()
  const ids = table.data[ID_COLUMN_NAME] ?? []
  for (let i = 0; i < table.length; i++) {
    const id = String(ids[i] ?? '')
    if (id && !index.has(id)) index.set(id, i)
  }
  annotationRows.set(table, index)
  return index
}

/**
 * Synapse rows to a point cloud, with one attribute row per point.
 *
 * `polarity` is what a caller asked for and also what each row *is*, so it rides in the
 * attributes: a cloud fetched for both ends is two populations in one buffer, and without the
 * column nothing downstream could colour them apart.
 *
 * The neuron the cloud is *about* is the end that matched the filter, and the partner is the
 * other — the same query-relative rule `fetchConnectivity` follows, so a Synapses node and a
 * Connectivity node on one neuron agree about which id is whose.
 */
function synapsePoints(
  perSide: ReadonlyArray<readonly ['pre' | 'post', CaveRow[]]>,
  spec: SynapseTableSpec,
  schema: SourceSchemas['synapses'],
  /** From `CaveSource.frame`, so the datastack-to-space rule stays in one place. */
  frame: { units: GeometryUnits; space?: string },
): PointsValue {
  const total = perSide.reduce((sum, [, rows]) => sum + rows.length, 0)
  const positions = new Float32Array(total * 3)

  /*
   * Column arrays filled by index, not row objects handed to `tableFromRows` — whose own
   * docstring says "not hot paths", and this is one: a cloud is bounded by `CAVE_MAX_ROWS`, and
   * the row-object form measured 128 ms against 9 ms at that size. The loop below already has
   * every value, so there is nothing to gain by materialising a record first.
   */
  const neuronIds = new Array<string>(total)
  const partnerIds = new Array<string>(total)
  const polarities = new Array<string>(total)
  const weights = new Array<number>(total)

  // Hoisted: the API splits a position column into three, and rebuilding these three strings per
  // row is a fresh key and a fresh lookup for every synapse.
  const xKey = `${spec.positionColumn}_x`
  const yKey = `${spec.positionColumn}_y`
  const zKey = `${spec.positionColumn}_z`

  let at = 0
  for (const [side, sideRows] of perSide) {
    const own = side === 'pre' ? spec.preColumn : spec.postColumn
    const other = side === 'pre' ? spec.postColumn : spec.preColumn
    for (const row of sideRows) {
      positions[at * 3] = Number(row[xKey] ?? 0)
      positions[at * 3 + 1] = Number(row[yKey] ?? 0)
      positions[at * 3 + 2] = Number(row[zKey] ?? 0)
      neuronIds[at] = String(row[own])
      partnerIds[at] = String(row[other])
      polarities[at] = side
      weights[at] = spec.scoreColumn ? Number(row[spec.scoreColumn] ?? 0) : 1
      at++
    }
  }

  return {
    kind: 'points',
    positions,
    attributes: makeTable(schema, {
      [ID_COLUMN_NAME]: neuronIds,
      partnerId: partnerIds,
      polarity: polarities,
      weight: weights,
    }),
    bounds: boundsOf([positions]),
    ...frame,
  }
}

/**
 * Which of a datastack's tables Coda reads, appended to the publisher's own blurb.
 *
 * **A CAVE datastack does not describe its own roles** — `spec.ts` says why at length — so the
 * four bindings are Coda's editorial decision, taken in a source file the user cannot see. Every
 * other backend's roles are self-evident from the data; here, "why are there no cell types on
 * BANC?" had no answer anywhere in the app, and the honest one is "because no annotation table is
 * configured for it".
 *
 * **Marked as Coda's, because the paragraph above it is not.** The Description card exists to
 * carry the *publisher's* text, and a reader has no other way to tell where the quotation stops.
 *
 * **An unbound role is a line, not an omission.** That is the whole point: a missing annotation
 * table is exactly the thing somebody is looking for an explanation of, and a list that silently
 * skipped it would answer the easy question and not the one being asked.
 *
 * Base markdown only — `**` and backticks. `parseMarkdown`'s extended kinds are opt-in and this
 * text renders through the same path as a blurb from whatever deployment a Custom node points at.
 */
function codaReads(spec: DatastackSpec, version: number, info: DatastackInfo): string {
  const rows = [
    `- Neurons — ${spec.neurons ? `\`${spec.neurons.table}\`` : 'no table; an annotation source wired to the dataset is the neuron list'}`,
    `- Annotations — ${spec.annotations ? `\`${spec.annotations.table}\`` : 'none configured; wire an annotation source for cell types'}`,
  ]
  // The same precedence `synapsesFor` applies, said in the same order: the spec wins, then the
  // datastack's own declaration — which is what makes 7 of the 13 work with no configuration.
  const synapses = spec.synapses?.table ?? info.synapse_table ?? undefined
  rows.push(
    `- Connectivity — ${
      spec.connections
        ? `\`${spec.connections.view}\` (a view, aggregated server-side)`
        : synapses
          ? `counted from \`${synapses}\`, since this datastack publishes no roll-up view`
          : 'unavailable: no roll-up view and no synapse table'
    }`,
    `- Synapses — ${synapses ? `\`${synapses}\`` : 'none published'}`,
  )
  /*
   * Said from the spec rather than from a probe, and that is a deliberate narrowing of what this
   * line claims: it reports which bucket is *configured*, exactly as every row above reports
   * which table is configured. Probing to find out whether it answers today would put a request
   * per datastack behind the dataset picker, and the answer would then be about the network
   * rather than about the datastack.
   */
  const flat = spec.flat?.[version]
  rows.push(
    `- Morphology — ${
      flat
        ? `\`${flat}\`, the flat segmentation published for this materialization`
        : 'built from the graphene segmentation, which has no level of detail'
    }`,
  )
  return `**Coda reads this datastack as:**\n\n${rows.join('\n')}`
}

function datasetInfoFor(
  spec: DatastackSpec,
  version: number,
  info: DatastackInfo,
  timestamp?: string,
  expires?: string,
): DatasetInfo {
  const dated = timestamp ? ` materialized ${timestamp.slice(0, 10)}` : ''
  const ends = expires ? `, expires ${expires.slice(0, 10)}` : ''
  const viewerSite = info.viewer_site
  return {
    id: datasetIdFor(spec.datastack, version),
    label: `${spec.label} ${version}`,
    description:
      `${spec.description}\n\nMaterialization ${version}${dated}${ends}.` +
      `\n\n${codaReads(spec, version, info)}`,
    // Absent where the spec names none, which a hand-named datastack cannot. Optional on
    // `DatasetInfo` for exactly that, so the card leaves the row off rather than guessing.
    ...(spec.species ? { species: spec.species } : {}),
    // No neuropil regions: FlyWire's are annotations on synapses rather than a published region
    // set, so every ROI-shaped control correctly finds nothing to offer.
    rois: [],
    // No status property either, so Find Neurons' status picker offers only "Any" — the honest
    // state rather than a filter that would match nothing.
    statuses: [],
    version: String(version),
    // The datastack's own `viewer_site`. Not decoration: the segmentation is behind CAVE's auth
    // and only a spelunker-flavoured viewer speaks `middleauth+`, so the built-in default draws
    // the EM and no neurons.
    ...(viewerSite ? { viewerSite } : {}),
  }
}
