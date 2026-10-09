/**
 * The source behind every Custom Dataset: each question answered by the part that can.
 *
 * One registered instance, keyed by nothing — which parts a dataset is made of is in
 * `layout.ts`, looked up per dataset id. What it answers today:
 *
 *  - **Which neurons exist, and what they are called** — from the neuron table, which arrives on
 *    every request as `annotations` because the node publishes it there. So `findNeurons` and
 *    `neuronIndex` are the same three local lines CAVE, CATMAID and precomputed run
 *    (`neuronFilter.ts`), and `LC.*` is anchored here exactly as it is there.
 *  - **Meshes and skeletons** — handed to the dataset wired into that socket, under *its* dataset
 *    id, with the ids asked for passed through untouched. Whether those ids mean the same neurons
 *    in both places is the user's claim and nothing here can check it, so a fetch that comes back
 *    short says so.
 *
 *  - **Synapses** — from the wired synapse table, a lookup per question (`custom/synapses.ts`).
 *  - **Connectivity** — never here. A wired edge list (or synapse table, counted) travels on the
 *    value as `edges`, and the funnel in `data/queries.ts` answers every connectivity question
 *    from it before any source is asked, exactly as for a backend dataset with an edge set
 *    attached. So
 *    the two methods below are reached only with no edge list at all, and refuse by name rather
 *    than returning an empty table under a green node — `PrecomputedSource`'s arrangement. What
 *    the edge list does add here is **neurons**: with no table wired, the ids it mentions.
 *
 * ## The attribute table is rebuilt, never passed through
 *
 * A geometry value pairs each item with an attribute row, and the Meshes node declares that
 * row's columns at edit time from *this* source's morphology schema plus the neuron table
 * (`schemasFromType` → `withAnnotations`). The delegate's own attributes are whatever its backend
 * publishes, so passing them through would hand a picker `type` from neuPrint beside a neuron
 * table that calls it `cell_type` — invariant 3 broken in the direction no check catches. So the
 * row is rebuilt from the item and the neuron table, through the same `withAnnotations` both
 * halves read.
 */

import { ID_COLUMN_NAME } from '../../core/ids'
import type {
  DatasetAnnotations,
  DatasetEdges,
  MatrixValue,
  MeshesValue,
  PointsValue,
  SkeletonProvenance,
  SkeletonsValue,
  TableValue,
} from '../../core/values'
import { makeTable, selectRows, tableFromRows } from '../../core/values'
import type { TableSchema } from '../../core/types'
import { column, tableSchema } from '../../core/types'
import { morphologyAttributes } from '../annotations/labels'
import type { LoadedEdgeSet } from '../edges/store'
import { requireEdgeSet } from '../edges/store'
import {
  compileLabelMatch,
  matchIndexRows,
  preparedRows,
  refuseUnfilterableRoi,
} from '../neuronFilter'
import type {
  AdjacencyRequest,
  CoarseGeometry,
  CoarseGeometryRequest,
  CoarseRefusal,
  ConnectivityRequest,
  DataSource,
  DatasetInfo,
  FindNeuronsRequest,
  GeometryRequest,
  NeuronIndexRequest,
  SourceCapabilities,
  SourceSchemas,
  SynapseRequest,
  SynapsesBetweenRequest,
} from '../source'
import { CANONICAL_SCHEMAS, asksForNoSynapses, capabilityOf, requireSource } from '../source'
import { typesOf } from '../connectivity'
import { SYNAPSE_UNITS, warnIfConfidenceIgnored } from '../synapseUnits'
import type { SynapseTable } from './synapses'
import {
  emptySynapsesBetween,
  synapsePoints,
  synapseSchema,
  synapseTableFor,
  synapsesBetween,
} from './synapses'
import type { GeometryRole } from './layout'
import {
  CUSTOM_CAPABILITIES,
  CUSTOM_SOURCE_ID,
  GEOMETRY_ROLES,
  GEOMETRY_SOCKETS,
  buildFor,
  compositeCapabilities,
  layoutFor,
  partFor,
  resolvedPart,
} from './layout'

const ID_ONLY: TableSchema = tableSchema(column(ID_COLUMN_NAME, 'str'))

/**
 * The shapes before a neuron table is substituted in. `morphology` is the id and the point count
 * and nothing else, because those are the two facts every geometry item carries whichever
 * backend fetched it; every label comes from the neuron table.
 */
const CUSTOM_SCHEMAS: SourceSchemas = {
  neurons: ID_ONLY,
  connectivity: CANONICAL_SCHEMAS.connectivity,
  roiCounts: ID_ONLY,
  morphology: tableSchema(column(ID_COLUMN_NAME, 'str'), column('points', 'i64')),
  synapses: ID_ONLY,
}

/** One item of each part, for a message about a fetch that came back short. */
const NOUNS: Record<GeometryRole, string> = { meshes: 'mesh', skeletons: 'skeleton' }

const LABEL = 'Custom Dataset'

export class CompositeSource implements DataSource {
  readonly id = CUSTOM_SOURCE_ID
  readonly label = LABEL
  readonly description = 'A dataset assembled from parts wired into a Custom Dataset node.'
  readonly capabilities = CUSTOM_CAPABILITIES
  readonly schemas = CUSTOM_SCHEMAS

  /** One row per synaptic connection, the only thing a synapse table's rows can be. */
  readonly synapseUnits = [SYNAPSE_UNITS.links] as const

  /**
   * The canonical shapes, with the synapse schema a layout's carried columns make — what a
   * Synapses node below it declares before a Run, and what `synapsePoints` then fills.
   */
  schemasFor(datasetId: string): SourceSchemas {
    const synapses = layoutFor(datasetId)?.synapses
    return synapses ? { ...CUSTOM_SCHEMAS, synapses: synapseSchema(synapses) } : CUSTOM_SCHEMAS
  }

  capabilitiesFor(datasetId: string): Partial<SourceCapabilities> | undefined {
    const layout = layoutFor(datasetId)
    return layout ? compositeCapabilities(layout) : undefined
  }

  async listDatasets(): Promise<DatasetInfo[]> {
    return this.peekDatasets()
  }

  /**
   * Empty, and never undefined: there is no listing to wait for, and nothing should offer these in
   * a picker — a Custom Dataset is reached through its node, never chosen from a list.
   */
  peekDatasets(): DatasetInfo[] {
    return []
  }

  /**
   * An answer for any id a node published, so the readers that look a dataset up by id (a region
   * list, a label) get one rather than a pending state that never resolves. No regions and no
   * statuses, since no part supplies either yet.
   */
  peekDataset(datasetId: string): DatasetInfo | undefined {
    if (!layoutFor(datasetId)) return undefined
    return { id: datasetId, label: buildFor(datasetId)?.label ?? LABEL, rois: [], statuses: [] }
  }

  async neuronIndex(req: NeuronIndexRequest): Promise<TableValue> {
    const build = requireBuilt(req.datasetId)
    const table = req.annotations?.table ?? (await edgeListNeurons(build.edgeSet, req.signal))
    if (!table) throw new Error(NO_NEURON_TABLE)
    return table
  }

  /**
   * A neuron query, answered over the neuron table — or, with none wired, over the ids asked for,
   * and failing those over every id the edge list mentions.
   *
   * The second is the Input IDs case, and it answers what that node answers with no dataset at
   * all: the ids as given, never narrowed to the edge list — a neuron with no edges is still one.
   * Without a neuron table nothing here can say which neurons exist, so narrowing a pasted list
   * would be a claim with nothing behind it. Asked for neurons with
   * neither a table nor ids, it refuses: an empty answer would read as a dataset with no neurons.
   */
  async findNeurons(req: FindNeuronsRequest): Promise<TableValue> {
    const build = requireBuilt(req.datasetId)
    refuseUnfilterableRoi(req, LABEL)
    const index =
      req.annotations?.table ??
      (req.neuronIds
        ? idTable(req.neuronIds)
        : await edgeListNeurons(build.edgeSet, req.signal))
    if (!index) throw new Error(NO_NEURON_TABLE)
    const prepared = preparedRows(index, req, LABEL)
    const labelTest = compileLabelMatch(req.labels)
    return selectRows(index, matchIndexRows(index, req, prepared, labelTest))
  }

  fetchConnectivity(_req: ConnectivityRequest): Promise<TableValue> {
    return noConnectivity()
  }

  fetchAdjacency(_req: AdjacencyRequest): Promise<MatrixValue> {
    return noConnectivity()
  }

  /** A neuron set's synapses, from the wired synapse table — both ends unless a polarity is asked. */
  async fetchSynapses(req: SynapseRequest): Promise<PointsValue> {
    const table = requireSynapses(req.datasetId)
    warnIfConfidenceIgnored('This synapse table', req)
    return synapsePoints(
      table,
      req.polarity ? [req.polarity] : ['pre', 'post'],
      req.neuronIds,
      req.signal,
    )
  }

  /** The synapses from one set onto another, oriented; see `synapsesBetween`. */
  async fetchSynapsesBetween(req: SynapsesBetweenRequest): Promise<PointsValue> {
    const table = requireSynapses(req.datasetId)
    if (asksForNoSynapses(req)) return emptySynapsesBetween()
    warnIfConfidenceIgnored('This synapse table', req)
    req.onWarn?.(
      'This synapse table has one position per synapse and nothing to say which end it is at, ' +
        'so Location moves no point and polarity is left empty.',
    )
    const types = req.annotations ? typesOf(req.annotations.table) : new Map<string, string>()
    return synapsesBetween(table, req, types)
  }

  fetchMeshes(req: GeometryRequest): Promise<MeshesValue> {
    return fetchGeometry(req, 'meshes', (source, request) => source.fetchMeshes?.(request))
  }

  fetchSkeletons(req: GeometryRequest): Promise<SkeletonsValue> {
    return fetchGeometry(req, 'skeletons', (source, request) =>
      source.fetchSkeletons?.(request),
    )
  }

  /**
   * A thumbnail from whichever geometry part can draw one cheaply — meshes first, the order the
   * sockets are listed in, and on to the next where one draws nothing: a Meshes part with no mesh
   * pyramid would otherwise blank every tile that the Skeletons part could have drawn. A refusal
   * stops the walk — it is an answer about this neuron, not an absence. Answered for a layout id
   * too, which is what lets Explore's tiles fill before a Run where the part's own dataset is
   * already known.
   */
  async fetchCoarseGeometry(
    req: CoarseGeometryRequest,
  ): Promise<CoarseGeometry | CoarseRefusal | undefined> {
    // A source already asked is not asked again under the other role: one dataset wired into
    // both sockets answers for its meshes *and* skeletons in one call, and a miss there is a miss.
    const asked = new Set<string>()
    for (const role of GEOMETRY_ROLES) {
      const part = resolvedPart(req.datasetId, role)
      if (!part?.source.fetchCoarseGeometry) continue
      if (!capabilityOf(part.source, part.datasetId, role)) continue
      const key = `${part.source.id}\u0001${part.datasetId}`
      if (asked.has(key)) continue
      asked.add(key)
      const answer = await part.source.fetchCoarseGeometry({
        ...req,
        datasetId: part.datasetId,
      })
      if (answer) return answer
    }
    return undefined
  }

  /**
   * The skeleton part's routes, so the Skeletons node's dropdown offers what its delegate does.
   * No skeleton part is "no skeletons", which the seam spells `[]`; an unresolved one is "not known
   * yet"; and a delegate without the method is one unnamed route, which the seam spells absence.
   */
  skeletonSourcesFor(datasetId: string): readonly SkeletonProvenance[] | undefined {
    if (!partFor(datasetId, 'skeletons')) return []
    const part = resolvedPart(datasetId, 'skeletons')
    return part?.source.skeletonSourcesFor?.(part.datasetId)
  }

  meshLevelsFor(datasetId: string): boolean | undefined {
    const part = resolvedPart(datasetId, 'meshes')
    return part?.source.meshLevelsFor?.(part.datasetId)
  }
}

/**
 * A geometry fetch, handed to the part that answers it: the delegate is asked under its own
 * dataset id, what comes back is checked for neurons it lacked, and every row is relabelled.
 * One body for both kinds, so a step added to one cannot be missed on the other.
 */
async function fetchGeometry<V extends MeshesValue | SkeletonsValue>(
  req: GeometryRequest,
  role: GeometryRole,
  fetch: (source: DataSource, req: GeometryRequest) => Promise<V> | undefined,
): Promise<V> {
  const { source, datasetId } = delegateFor(req.datasetId, role)
  const fetched = fetch(source, delegated(req, datasetId))
  if (!fetched) throw new Error(`${source.label} does not provide ${role}`)
  const value = await fetched
  warnShort(req, value.items, role, source.label)
  return relabel(value, req.annotations)
}

/**
 * The request as the delegate should see it: its own dataset id, **no annotations** — the neuron
 * table is ours, and a delegate that labels from annotations (CAVE) would otherwise do work whose
 * result `relabel` throws away — and partials relabelled on the way past, or a streamed scene is
 * coloured by columns the finished one does not have.
 */
function delegated(req: GeometryRequest, datasetId: string): GeometryRequest {
  const { annotations, onPartial, ...rest } = req
  return {
    ...rest,
    datasetId,
    ...(onPartial ? { onPartial: (partial) => onPartial(relabel(partial, annotations)) } : {}),
  }
}

function relabel<V extends MeshesValue | SkeletonsValue>(
  value: V,
  annotations: DatasetAnnotations | undefined,
): V {
  return {
    ...value,
    attributes: morphologyAttributes(CUSTOM_SCHEMAS, annotations, value.items),
  }
}

/**
 * Say when geometry came back for fewer neurons than were asked about.
 *
 * A warning, never a refusal: a published segmentation routinely lacks meshes for a few ids. When
 * it lacks *all* of them the likelier story is that the neuron table and the geometry part number
 * their neurons differently — the one thing this node cannot check — so that case says so.
 */
function warnShort(
  req: GeometryRequest,
  items: ReadonlyArray<{ id: string }>,
  role: GeometryRole,
  from: string,
): void {
  if (!req.onWarn || req.neuronIds.length === 0) return
  const got = new Set(items.map((item) => item.id))
  const missing = new Set(req.neuronIds.filter((id) => !got.has(id))).size
  if (missing === 0) return
  const asked = new Set(req.neuronIds).size
  const noun = NOUNS[role]
  req.onWarn(
    missing === asked
      ? `${from} returned no ${noun} for any of the ${asked} neurons asked for. Check that ` +
          `the dataset wired into \`${GEOMETRY_SOCKETS[role]}\` uses the same ids as the neuron table.`
      : `${missing} of ${asked} neurons have no ${noun} in ${from}.`,
  )
}

const NO_NEURON_TABLE =
  'This Custom Dataset has no neuron table, so it cannot say which neurons it has. Wire a ' +
  'table into its `Neurons` socket or an edge list into `Edges`, or name the neurons with an Input ' +
  'IDs node.'

/**
 * The neurons an edge list names — every id at either end, unlabelled, in the order the list first
 * mentions them — or undefined with no edge list. Read from the loaded set, so asking for them
 * builds it: the same read the first connectivity question would pay.
 */
async function edgeListNeurons(
  edges: DatasetEdges | undefined,
  signal: AbortSignal | undefined,
): Promise<TableValue | undefined> {
  if (!edges) return undefined
  const set = await requireEdgeSet(edges, signal)
  let table = edgeListTables.get(set)
  if (!table) {
    // The dictionary is already one entry per id, so it *is* the column: no copy, no rows.
    table = makeTable(ID_ONLY, { [ID_COLUMN_NAME]: set.ids }, 'neurons')
    edgeListTables.set(set, table)
  }
  return table
}

/**
 * One table per loaded set, and the same object every time. The connectivity funnel asks for the
 * neuron index on every question — per hop, for Paths — to look types up, and `typesOf` caches by
 * identity, so a fresh table each time would be millions of cells built to find no type column.
 */
const edgeListTables = new WeakMap<LoadedEdgeSet, TableValue>()

/**
 * A layout id is what a type carries, and only a Run turns it into something that can answer —
 * so being handed one means somebody read the type (a `reference` port) or asked before the run.
 * A build id this session no longer holds is the same state reached the other way round.
 */
function requireBuilt(datasetId: string) {
  // A layout id is never a key of the build map, so one lookup answers both cases.
  const build = buildFor(datasetId)
  if (!build) {
    throw new Error(
      'This Custom Dataset has not run yet, so what it holds is not known. Run it, and wire ' +
        'it as an ordinary input instead of a reference.',
    )
  }
  return build
}

/** The build's synapse table, or a refusal naming the socket to wire. */
function requireSynapses(datasetId: string): SynapseTable {
  const id = requireBuilt(datasetId).synapseTable
  const table = id ? synapseTableFor(id) : undefined
  if (table) return table
  throw new Error(
    id
      ? 'This Custom Dataset’s synapse table is no longer held in this tab. Select the Custom ' +
          'Dataset node, press Invalidate in the inspector, and run again.'
      : 'This Custom Dataset has no synapses. Wire a synapse table into its `Synapses` socket.',
  )
}

function delegateFor(
  datasetId: string,
  role: GeometryRole,
): { source: DataSource; datasetId: string } {
  const part = requireBuilt(datasetId)[role]
  // A build's parts come from resolved values, so both ids are there whenever the part is.
  if (!part?.sourceId || !part.datasetId) {
    throw new Error(
      `This Custom Dataset has no ${role}. Wire a dataset into its ` +
        `\`${GEOMETRY_SOCKETS[role]}\` socket to take them from.`,
    )
  }
  return { source: requireSource(part.sourceId), datasetId: part.datasetId }
}

/** The ids asked for, as a one-column neuron table. Deduplicated, first occurrence kept. */
function idTable(ids: readonly string[]): TableValue {
  return tableFromRows(
    ID_ONLY,
    [...new Set(ids)].map((id) => ({ [ID_COLUMN_NAME]: id })),
    'neurons',
  )
}

function noConnectivity<T>(): Promise<T> {
  return Promise.reject(
    new Error(
      'This Custom Dataset has no connectivity. Wire an edge list into its `Edges` socket: a ' +
        'table or a Link Table file with a column for each end.',
    ),
  )
}
