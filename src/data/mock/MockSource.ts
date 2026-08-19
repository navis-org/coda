/**
 * In-browser mock DataSource backed by the synthetic connectomes in `generate.ts`.
 *
 * Deliberately simulates latency (and honours AbortSignal while doing it). Without that,
 * every query resolves in the same microtask and the running/stale/cancel machinery never
 * gets exercised — which is exactly the machinery that has to be right before neuPrint
 * goes in behind this interface.
 */

import type {
  MatrixValue,
  MeshesValue,
  PointsValue,
  SkeletonGeometry,
  SkeletonsValue,
  TableValue,
} from '../../core/values'
import type { CellValue } from '../../core/values'
import { boundsOf, cableLength, makeMatrix, tableFromRows } from '../../core/values'
import type {
  AdjacencyRequest,
  CoarseGeometry,
  CoarseGeometryRequest,
  ConnectivityRequest,
  DataSource,
  DatasetInfo,
  FindNeuronsRequest,
  LabelMatch,
  GeometryRequest,
  NeuronIndexRequest,
  PathStepRequest,
  RoiCountsRequest,
  SourceCapabilities,
  SourceSchemas,
  SynapseRequest,
} from '../source'
import { CANONICAL_SCHEMAS, PATH_STEP_SCHEMA, delay, throwIfAborted } from '../source'
import { loadCachedTable, neuronIndexKey } from '../neuronIndex'
import type { MockConnection } from './generate'
import { getConnectome, mockDatasetIds, mockDatasetMeta } from './generate'
import { generateSkeleton, skeletonToTubeMesh, synapsePosition } from './morphology'

export interface MockSourceOptions {
  /** Simulated round-trip latency in ms. Set to 0 in tests. */
  latencyMs?: number
}

export class MockSource implements DataSource {
  readonly id = 'mock'
  readonly label = 'Mock connectome'
  readonly description =
    'Synthetic, deterministic datasets generated in the browser. No network, no credentials — for developing and demoing the editor.'
  readonly capabilities: SourceCapabilities = {
    rawQuery: false,
    skeletons: true,
    meshes: true,
    synapses: true,
    neuronIndex: true,
    paths: true,
    // Synthetic geometry generated in the browser. There is no bucket for an external
    // viewer to read, so there is no scene to publish.
    viewerScene: false,
  }
  readonly schemas: SourceSchemas = CANONICAL_SCHEMAS

  private datasets: DatasetInfo[] | undefined
  private latencyMs: number

  constructor(options: MockSourceOptions = {}) {
    this.latencyMs = options.latencyMs ?? 220
    // Dataset metadata is static here, so it's available synchronously from the start.
    this.datasets = this.buildDatasetList()
  }

  private buildDatasetList(): DatasetInfo[] {
    return mockDatasetIds().map((id) => {
      const meta = mockDatasetMeta(id)!
      const connectome = getConnectome(id)
      return {
        id,
        label: meta.label,
        description: meta.description,
        species: meta.species,
        version: meta.version,
        rois: meta.rois,
        statuses: ['Traced', 'Anchor', 'Assign'],
        ...(connectome ? { neuronCount: connectome.neurons.length } : {}),
      }
    })
  }

  async listDatasets(signal?: AbortSignal): Promise<DatasetInfo[]> {
    await delay(this.latencyMs / 3, signal)
    this.datasets ??= this.buildDatasetList()
    return this.datasets
  }

  peekDatasets(): DatasetInfo[] | undefined {
    return this.datasets
  }

  peekDataset(datasetId: string): DatasetInfo | undefined {
    return this.datasets?.find((d) => d.id === datasetId)
  }

  // -------------------------------------------------------------------------

  async findNeurons(req: FindNeuronsRequest): Promise<TableValue> {
    await delay(this.latencyMs, req.signal)
    const connectome = this.require(req.datasetId)

    const typeRe = compileRegex(req.typePattern, 'type')
    const instanceRe = compileRegex(req.instancePattern, 'instance')
    const labelTest = compileLabelMatch(req.labels)
    // Present-and-empty means no neurons, matching the seam's documented rule and the Cypher
    // builder's `IN []` — a mock that read it as "no filter" would let a node pass its tests
    // here and return the whole dataset against the real source.
    const wantedIds = req.bodyIds ? new Set(req.bodyIds) : undefined
    const statuses = req.statuses?.length ? new Set(req.statuses) : undefined
    const minSize = req.minSize ?? 0

    let roiBodies: Set<number> | undefined
    if (req.roi) {
      roiBodies = new Set(
        connectome.roiCounts
          .filter((rc) => rc.roi === req.roi && rc.pre + rc.post > 0)
          .map((rc) => rc.bodyId),
      )
    }

    const matched = connectome.neurons.filter((n) => {
      if (typeRe && !typeRe.test(n.type)) return false
      if (instanceRe && !instanceRe.test(n.instance)) return false
      if (labelTest && !labelTest(n as unknown as Record<string, unknown>)) return false
      if (wantedIds && !wantedIds.has(n.bodyId)) return false
      if (statuses && !statuses.has(n.status)) return false
      if (n.size < minSize) return false
      if (roiBodies && !roiBodies.has(n.bodyId)) return false
      return true
    })

    // Stable order: by type then bodyId, so results are reproducible run to run.
    matched.sort((a, b) => a.type.localeCompare(b.type) || a.bodyId - b.bodyId)
    const limited = req.limit && req.limit > 0 ? matched.slice(0, req.limit) : matched

    return tableFromRows(
      this.schemas.neurons,
      limited.map((n) => ({
        bodyId: n.bodyId,
        type: n.type,
        instance: n.instance,
        status: n.status,
        size: n.size,
        pre: n.pre,
        post: n.post,
      })),
      'neurons',
    )
  }

  /**
   * Every neuron in the dataset, cached like the real thing.
   *
   * Goes through the same cache path as neuPrint deliberately: the mock is what the tests and
   * a tokenless visitor see, so if caching or deduplication is broken it should be broken here
   * too rather than only against a server nobody can run in CI.
   */
  async neuronIndex(req: NeuronIndexRequest): Promise<TableValue> {
    return loadCachedTable({
      key: neuronIndexKey(this.id, req.datasetId),
      fingerprint: this.schemas.neurons.columns.map((c) => c.name).join(','),
      ...(req.refresh ? { refresh: req.refresh } : {}),
      fetch: async () => {
        req.onProgress?.(0.1, 'loading neurons')
        const table = await this.findNeurons({
          datasetId: req.datasetId,
          ...(req.signal ? { signal: req.signal } : {}),
        })
        req.onProgress?.(1, 'ready')
        return table
      },
    })
  }

  /**
   * A coarse tube mesh, from the same seeded skeleton the 3D viewer would draw.
   *
   * Three radial segments rather than the viewer's five: a 96px thumbnail cannot show the
   * difference, and this is called once per visible row.
   */
  async fetchCoarseGeometry(req: CoarseGeometryRequest): Promise<CoarseGeometry | undefined> {
    const connectome = this.require(req.datasetId)
    const neuron = connectome.byId.get(req.bodyId)
    if (!neuron) return undefined
    await delay(this.latencyMs / 4, req.signal)
    const rois = connectome.roiCounts
      .filter((rc) => rc.bodyId === req.bodyId && rc.pre + rc.post > 0)
      .map((rc) => rc.roi)
    const skeleton = generateSkeleton(req.bodyId, rois, { targetPoints: 160 })
    const mesh = skeletonToTubeMesh(skeleton, 3)
    return { positions: mesh.positions, indices: mesh.indices }
  }

  async fetchConnectivity(req: ConnectivityRequest): Promise<TableValue> {
    await delay(this.latencyMs, req.signal)
    const connectome = this.require(req.datasetId)
    const minWeight = req.minWeight ?? 1
    const wanted = new Set(req.bodyIds)

    const rows: Array<Record<string, number | string>> = []
    for (const bodyId of wanted) {
      throwIfAborted(req.signal)
      const self = connectome.byId.get(bodyId)
      if (!self) continue
      const edges: MockConnection[] =
        (req.direction === 'outputs' ? connectome.out.get(bodyId) : connectome.in.get(bodyId)) ?? []
      for (const edge of edges) {
        if (edge.weight < minWeight) continue
        const partnerId = req.direction === 'outputs' ? edge.post : edge.pre
        const partner = connectome.byId.get(partnerId)
        rows.push({
          bodyId,
          bodyType: self.type,
          partnerId,
          partnerType: partner?.type ?? 'unknown',
          weight: edge.weight,
        })
      }
    }

    rows.sort(
      (a, b) =>
        (b.weight as number) - (a.weight as number) ||
        (a.bodyId as number) - (b.bodyId as number),
    )
    return tableFromRows(this.schemas.connectivity, rows)
  }

  /**
   * One hop of a path traversal, aggregated exactly as the Cypher does.
   *
   * Written against the same contract rather than "whatever the traversal happens to need":
   * the whole point of the mock is that a node passing here is exercising the real semantics.
   * So the grouping, the null-type fallback and the after-the-sum threshold all match
   * `pathStepCypher`, and `pathOps.test.ts` can drive the real BFS with no network.
   */
  async fetchPathStep(req: PathStepRequest): Promise<TableValue> {
    await delay(this.latencyMs, req.signal)
    const connectome = this.require(req.datasetId)
    const outward = req.direction === 'outputs'
    const types = new Set(req.types ?? [])
    const ids = new Set(req.bodyIds ?? [])

    // Group key of a neuron: its type when collapsing and it has one, else its own body id.
    const keyOf = (bodyId: number): { key: string; type: string | null; id: number | null } => {
      const neuron = connectome.byId.get(bodyId)
      const type = neuron?.type ?? null
      if (req.collapseTypes && type) return { key: type, type, id: null }
      return { key: String(bodyId), type, id: bodyId }
    }

    type Merged = Record<string, CellValue> & { weight: number; pairs: number }
    const merged = new Map<string, Merged>()

    for (const [bodyId, neuron] of connectome.byId) {
      throwIfAborted(req.signal)
      const inFrontier = ids.has(bodyId) || (neuron.type ? types.has(neuron.type) : false)
      if (!inFrontier) continue
      const edges: MockConnection[] =
        (outward ? connectome.out.get(bodyId) : connectome.in.get(bodyId)) ?? []
      for (const edge of edges) {
        const farId = outward ? edge.post : edge.pre
        if (!connectome.byId.has(farId)) continue
        const near = keyOf(bodyId)
        const far = keyOf(farId)
        // Rows are always presynaptic → postsynaptic, whichever end the frontier was.
        const pre = outward ? near : far
        const post = outward ? far : near
        const mapKey = `${pre.key}\u0000${post.key}`
        const existing = merged.get(mapKey)
        if (existing) {
          existing.weight += edge.weight
          existing.pairs += 1
        } else {
          merged.set(mapKey, {
            source: pre.key,
            sourceType: pre.type,
            sourceId: pre.id,
            target: post.key,
            targetType: post.type,
            targetId: post.id,
            weight: edge.weight,
            pairs: 1,
          })
        }
      }
    }

    // After the sum, not before — see `PathStepRequest.minWeight`.
    const min = Math.max(1, Math.floor(req.minWeight ?? 1))
    const rows = [...merged.values()]
      .filter((row) => row.weight >= min)
      .sort(
        (a, b) =>
          b.weight - a.weight ||
          String(a.source).localeCompare(String(b.source)) ||
          String(a.target).localeCompare(String(b.target)),
      )
    return tableFromRows(PATH_STEP_SCHEMA, rows)
  }

  async fetchAdjacency(req: AdjacencyRequest): Promise<MatrixValue> {
    await delay(this.latencyMs, req.signal)
    const connectome = this.require(req.datasetId)
    const groupByType = req.groupByType ?? true

    const rowKeys = this.keysFor(connectome, req.sourceIds, groupByType)
    const colKeys = this.keysFor(connectome, req.targetIds, groupByType)
    const rowIndex = new Map(rowKeys.labels.map((label, i) => [label, i]))
    const colIndex = new Map(colKeys.labels.map((label, i) => [label, i]))

    const values = new Float64Array(rowKeys.labels.length * colKeys.labels.length)
    const targets = new Set(req.targetIds)

    for (const bodyId of req.sourceIds) {
      throwIfAborted(req.signal)
      const rowKey = rowKeys.keyOf.get(bodyId)
      if (rowKey === undefined) continue
      const r = rowIndex.get(rowKey)
      if (r === undefined) continue
      for (const edge of connectome.out.get(bodyId) ?? []) {
        if (!targets.has(edge.post)) continue
        const colKey = colKeys.keyOf.get(edge.post)
        if (colKey === undefined) continue
        const c = colIndex.get(colKey)
        if (c === undefined) continue
        const at = r * colKeys.labels.length + c
        values[at] = (values[at] ?? 0) + edge.weight
      }
    }

    return makeMatrix(rowKeys.labels, colKeys.labels, values, 'synapses')
  }

  async fetchRoiCounts(req: RoiCountsRequest): Promise<TableValue> {
    await delay(this.latencyMs, req.signal)
    const connectome = this.require(req.datasetId)
    const wanted = new Set(req.bodyIds)
    const roiFilter = req.rois?.length ? new Set(req.rois) : undefined

    const rows = connectome.roiCounts
      .filter((rc) => wanted.has(rc.bodyId) && (!roiFilter || roiFilter.has(rc.roi)))
      .map((rc) => ({
        bodyId: rc.bodyId,
        type: connectome.byId.get(rc.bodyId)?.type ?? 'unknown',
        roi: rc.roi,
        pre: rc.pre,
        post: rc.post,
      }))

    return tableFromRows(this.schemas.roiCounts, rows)
  }

  // --- morphology ----------------------------------------------------------

  async fetchSkeletons(req: GeometryRequest): Promise<SkeletonsValue> {
    await delay(this.latencyMs * 1.5, req.signal)
    const connectome = this.require(req.datasetId)

    const items: SkeletonGeometry[] = []
    const rows: Array<Record<string, number | string>> = []

    for (const bodyId of req.bodyIds) {
      throwIfAborted(req.signal)
      const neuron = connectome.byId.get(bodyId)
      if (!neuron) continue
      const rois = connectome.roiCounts
        .filter((rc) => rc.bodyId === bodyId)
        .sort((a, b) => b.pre + b.post - (a.pre + a.post))
        .map((rc) => rc.roi)

      const skeleton = generateSkeleton(bodyId, rois)
      items.push(skeleton)
      rows.push({
        bodyId,
        type: neuron.type,
        instance: neuron.instance,
        status: neuron.status,
        size: neuron.size,
        points: skeleton.parents.length,
        cableLength: Math.round(cableLength(skeleton)),
      })
    }

    return {
      kind: 'skeletons',
      items,
      attributes: tableFromRows(this.schemas.morphology, rows),
      bounds: boundsOf(items.map((s) => s.positions)),
    }
  }

  async fetchMeshes(req: GeometryRequest): Promise<MeshesValue> {
    // Meshes are generated from the same skeletons, so the two views always agree.
    const skeletons = await this.fetchSkeletons(req)
    throwIfAborted(req.signal)
    const items = skeletons.items.map((s) => skeletonToTubeMesh(s))
    return {
      kind: 'meshes',
      items,
      attributes: skeletons.attributes,
      bounds: boundsOf(items.map((m) => m.positions)),
    }
  }

  async fetchSynapses(req: SynapseRequest): Promise<PointsValue> {
    await delay(this.latencyMs, req.signal)
    const connectome = this.require(req.datasetId)
    const minWeight = req.minWeight ?? 1

    const positions: number[] = []
    const rows: Array<Record<string, number | string>> = []

    for (const bodyId of req.bodyIds) {
      throwIfAborted(req.signal)
      const neuron = connectome.byId.get(bodyId)
      if (!neuron) continue
      // The skeleton is regenerated here rather than cached, because it is seeded and
      // therefore identical — synapses land on the same arbor the 3D viewer draws.
      const rois = connectome.roiCounts
        .filter((rc) => rc.bodyId === bodyId)
        .map((rc) => rc.roi)
      const skeleton = generateSkeleton(bodyId, rois)

      let index = 0
      const emit = (partnerId: number, weight: number, polarity: 'pre' | 'post') => {
        if (weight < minWeight) return
        if (req.polarity && req.polarity !== polarity) return
        const [x, y, z] = synapsePosition(skeleton, index++)
        positions.push(x, y, z)
        rows.push({
          bodyId,
          type: neuron.type,
          partnerId,
          partnerType: connectome.byId.get(partnerId)?.type ?? 'unknown',
          polarity,
          weight,
        })
      }

      for (const edge of connectome.out.get(bodyId) ?? []) emit(edge.post, edge.weight, 'pre')
      for (const edge of connectome.in.get(bodyId) ?? []) emit(edge.pre, edge.weight, 'post')
    }

    const buffer = Float32Array.from(positions)
    return {
      kind: 'points',
      positions: buffer,
      attributes: tableFromRows(this.schemas.synapses, rows),
      bounds: boundsOf([buffer]),
    }
  }

  // -------------------------------------------------------------------------

  private require(datasetId: string) {
    const connectome = getConnectome(datasetId)
    if (!connectome) {
      throw new Error(
        `Unknown mock dataset "${datasetId}". Available: ${mockDatasetIds().join(', ')}`,
      )
    }
    return connectome
  }

  /** Map body ids to matrix row/column keys — either their type or their own id. */
  private keysFor(
    connectome: NonNullable<ReturnType<typeof getConnectome>>,
    bodyIds: number[],
    groupByType: boolean,
  ): { labels: string[]; keyOf: Map<number, string> } {
    const keyOf = new Map<number, string>()
    const labels: string[] = []
    const seen = new Set<string>()
    for (const bodyId of bodyIds) {
      const neuron = connectome.byId.get(bodyId)
      if (!neuron) continue
      const key = groupByType ? neuron.type : String(bodyId)
      keyOf.set(bodyId, key)
      if (!seen.has(key)) {
        seen.add(key)
        labels.push(key)
      }
    }
    labels.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    return { labels, keyOf }
  }
}

/**
 * Compile a user-supplied regex, anchored to the whole string.
 *
 * Anchoring matters for fidelity: Neo4j's `=~` (and therefore neuPrint's type search)
 * matches the *entire* value, so `LC.*` selects LC4/LC6/LC9 but not LPLC1. An unanchored
 * mock would train the wrong intuition and then silently change results the day a real
 * neuPrint source is plugged in behind this interface.
 */
/**
 * The mock's half of `LabelMatch`, kept beside `compileRegex` because it has to agree with it.
 *
 * Two agreements are load-bearing and neither is checkable by a type. The regex form wraps in
 * `^(?:…)$` exactly as `compileRegex` does, because neuPrint's `=~` anchors and the mock exists
 * to behave the same way. And a null or absent property fails every mode, matching Cypher's
 * three-valued `WHERE` — a missing `hemilineage` is not a match for the empty string.
 *
 * Undefined for an absent or empty match, which is the caller's signal to apply no filter at
 * all; an empty `values` never reaches here, because a lookup of nothing is answered before
 * the request is built.
 */
function compileLabelMatch(
  match: LabelMatch | undefined,
): ((row: Record<string, unknown>) => boolean) | undefined {
  if (!match || match.values.length === 0) return undefined
  const { field, ignoreCase } = match

  if (match.regex) {
    const flags = ignoreCase ? 'i' : ''
    const res = match.values.map((v) => {
      try {
        return new RegExp(`^(?:${v})$`, flags)
      } catch (err) {
        throw new Error(`Invalid ${field} pattern /${v}/: ${(err as Error).message}`)
      }
    })
    return (row) => {
      const value = row[field]
      if (value === null || value === undefined) return false
      const text = String(value)
      return res.some((re) => re.test(text))
    }
  }

  const wanted = new Set(match.values.map((v) => (ignoreCase ? v.toLowerCase() : v)))
  return (row) => {
    const value = row[field]
    if (value === null || value === undefined) return false
    const text = String(value)
    return wanted.has(ignoreCase ? text.toLowerCase() : text)
  }
}

function compileRegex(pattern: string | undefined, field: string): RegExp | undefined {
  if (!pattern) return undefined
  try {
    return new RegExp(`^(?:${pattern})$`)
  } catch (err) {
    throw new Error(`Invalid ${field} pattern /${pattern}/: ${(err as Error).message}`)
  }
}

