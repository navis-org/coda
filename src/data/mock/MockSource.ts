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
  MeshGeometry,
  MeshesValue,
  PointsValue,
  SkeletonGeometry,
  SkeletonsValue,
  TableValue,
} from '../../core/values'
import { numericId } from '../../core/ids'
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
  RoiMeshRequest,
  RoiSummaryRequest,
  SourceCapabilities,
  SourceSchemas,
  SynapseRequest,
} from '../source'
import {
  CANONICAL_SCHEMAS,
  PATH_STEP_SCHEMA,
  ROI_COMPLETENESS_SCHEMA,
  ROI_MESH_SCHEMA,
  ROI_CONNECTIVITY_SCHEMA,
  delay,
  throwIfAborted,
} from '../source'
import { loadCachedTable, neuronIndexKey } from '../neuronIndex'
import type { MockConnection, MockConnectome } from './generate'
import { getConnectome, mockDatasetIds, mockDatasetMeta } from './generate'
import {
  generateRoiMesh,
  generateSkeleton,
  skeletonToTubeMesh,
  synapsePosition,
} from './morphology'

export interface MockSourceOptions {
  /** Simulated round-trip latency in ms. Set to 0 in tests. */
  latencyMs?: number
}

/**
 * Request ids as the numbers the generated connectome is keyed by.
 *
 * A `NeuronId` crosses the DataSource seam as text, and each source converts at its own edge;
 * this is the mock's edge. The conversion is exact here by construction — `generate.ts` mints
 * small sequential ids, nowhere near `Number.MAX_SAFE_INTEGER`.
 */
function numericIds(ids: readonly string[]): number[] {
  const out: number[] = []
  for (const id of ids) {
    const n = numericId(id)
    if (n !== undefined) out.push(n)
  }
  return out
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
    // Implemented rather than declined, though nothing here is fetched from anywhere. The
    // generated connectome already carries per-ROI counts and a connection list, so both
    // summaries are ordinary roll-ups over data that exists — and implementing them is what
    // lets the bundled examples, the node tests and a token-less session exercise these paths
    // at all. The capability flag is for a source that genuinely cannot, not a way of leaving
    // the mock behind.
    roiSummary: true,
    roiMeshes: true,
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
        // The synthetic ROIs are flat — no region here contains another — so the whole list
        // tiles and every one of them is summable. Stated rather than left undefined, because
        // undefined means "not known yet" and would have anything that totals a per-ROI column
        // refuse to, against a dataset where totalling is exactly right.
        primaryRois: meta.rois,
        roiSuper: mockRoiSuper(meta.rois),
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
    const wantedIds = req.neuronIds ? new Set(numericIds(req.neuronIds)) : undefined
    const statuses = req.statuses?.length ? new Set(req.statuses) : undefined
    const minSize = req.minSize ?? 0

    let roiBodies: Set<number> | undefined
    if (req.roi) {
      roiBodies = new Set(
        connectome.roiCounts
          .filter((rc) => rc.roi === req.roi && rc.pre + rc.post > 0)
          .map((rc) => rc.neuronId),
      )
    }

    const matched = connectome.neurons.filter((n) => {
      if (typeRe && !typeRe.test(n.type)) return false
      if (instanceRe && !instanceRe.test(n.instance)) return false
      if (labelTest && !labelTest(n as unknown as Record<string, unknown>)) return false
      if (wantedIds && !wantedIds.has(n.neuronId)) return false
      if (statuses && !statuses.has(n.status)) return false
      if (n.size < minSize) return false
      if (roiBodies && !roiBodies.has(n.neuronId)) return false
      return true
    })

    // Stable order: by type then neuronId, so results are reproducible run to run.
    matched.sort((a, b) => a.type.localeCompare(b.type) || a.neuronId - b.neuronId)
    const limited = req.limit && req.limit > 0 ? matched.slice(0, req.limit) : matched

    return tableFromRows(
      this.schemas.neurons,
      limited.map((n) => ({
        neuronId: n.neuronId,
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
    const neuronId = Number(req.neuronId)
    const neuron = connectome.byId.get(neuronId)
    if (!neuron) return undefined
    await delay(this.latencyMs / 4, req.signal)
    const rois = connectome.roiCounts
      .filter((rc) => rc.neuronId === neuronId && rc.pre + rc.post > 0)
      .map((rc) => rc.roi)
    const skeleton = generateSkeleton(neuronId, rois, { targetPoints: 160 })
    const mesh = skeletonToTubeMesh(skeleton, 3)
    return { positions: mesh.positions, indices: mesh.indices }
  }

  async fetchConnectivity(req: ConnectivityRequest): Promise<TableValue> {
    await delay(this.latencyMs, req.signal)
    const connectome = this.require(req.datasetId)
    const minWeight = req.minWeight ?? 1
    const wanted = new Set(numericIds(req.neuronIds))

    const rows: Array<Record<string, number | string>> = []
    for (const neuronId of wanted) {
      throwIfAborted(req.signal)
      const self = connectome.byId.get(neuronId)
      if (!self) continue
      const edges: MockConnection[] =
        (req.direction === 'outputs'
          ? connectome.out.get(neuronId)
          : connectome.in.get(neuronId)) ?? []
      for (const edge of edges) {
        if (edge.weight < minWeight) continue
        const partnerId = req.direction === 'outputs' ? edge.post : edge.pre
        const partner = connectome.byId.get(partnerId)
        rows.push({
          neuronId,
          neuronType: self.type,
          partnerId,
          partnerType: partner?.type ?? 'unknown',
          weight: edge.weight,
        })
      }
    }

    rows.sort(
      (a, b) =>
        (b.weight as number) - (a.weight as number) ||
        (a.neuronId as number) - (b.neuronId as number),
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
    const ids = new Set(numericIds(req.neuronIds ?? []))

    // Group key of a neuron: its type when collapsing and it has one, else its own neuron id.
    const keyOf = (neuronId: number): { key: string; type: string | null; id: number | null } => {
      const neuron = connectome.byId.get(neuronId)
      const type = neuron?.type ?? null
      if (req.collapseTypes && type) return { key: type, type, id: null }
      return { key: String(neuronId), type, id: neuronId }
    }

    type Merged = Record<string, CellValue> & { weight: number; pairs: number }
    const merged = new Map<string, Merged>()

    for (const [neuronId, neuron] of connectome.byId) {
      throwIfAborted(req.signal)
      const inFrontier = ids.has(neuronId) || (neuron.type ? types.has(neuron.type) : false)
      if (!inFrontier) continue
      const edges: MockConnection[] =
        (outward ? connectome.out.get(neuronId) : connectome.in.get(neuronId)) ?? []
      for (const edge of edges) {
        const farId = outward ? edge.post : edge.pre
        if (!connectome.byId.has(farId)) continue
        const near = keyOf(neuronId)
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

    const sourceIds = numericIds(req.sourceIds)
    const targetIds = numericIds(req.targetIds)
    const rowKeys = this.keysFor(connectome, sourceIds, groupByType)
    const colKeys = this.keysFor(connectome, targetIds, groupByType)
    const rowIndex = new Map(rowKeys.labels.map((label, i) => [label, i]))
    const colIndex = new Map(colKeys.labels.map((label, i) => [label, i]))

    const values = new Float64Array(rowKeys.labels.length * colKeys.labels.length)
    const targets = new Set(targetIds)

    for (const neuronId of sourceIds) {
      throwIfAborted(req.signal)
      const rowKey = rowKeys.keyOf.get(neuronId)
      if (rowKey === undefined) continue
      const r = rowIndex.get(rowKey)
      if (r === undefined) continue
      for (const edge of connectome.out.get(neuronId) ?? []) {
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
    const wanted = new Set(numericIds(req.neuronIds))
    const roiFilter = req.rois?.length ? new Set(req.rois) : undefined

    const rows = connectome.roiCounts
      .filter((rc) => wanted.has(rc.neuronId) && (!roiFilter || roiFilter.has(rc.roi)))
      .map((rc) => ({
        neuronId: rc.neuronId,
        type: connectome.byId.get(rc.neuronId)?.type ?? 'unknown',
        roi: rc.roi,
        pre: rc.pre,
        post: rc.post,
      }))

    return tableFromRows(this.schemas.roiCounts, rows)
  }

  /**
   * Per-ROI traced-vs-total synapse counts.
   *
   * Everything in a generated connectome is by definition reconstructed, so a literal answer
   * would be 100% everywhere — which draws a flat bar and tests nothing. Instead each region
   * is given a stable "reconstructed fraction" derived from its own name, so the mock has the
   * shape of real data (varied, between about half and nearly all) while staying
   * deterministic: `evaluate` must be reproducible from its params alone (invariant 4), and a
   * roll-up that reached for `Math.random` would invalidate its own cache entry on every run.
   *
   * The two fractions are computed back from the *rounded* totals rather than from the factor
   * that produced them, so the columns agree with each other exactly — the same rule the
   * `*Schema`/`*Table` pairs in `tableOps.ts` follow.
   */
  async fetchRoiCompleteness(req: RoiSummaryRequest): Promise<TableValue> {
    await delay(this.latencyMs, req.signal)
    const connectome = this.require(req.datasetId)

    const pre = new Map<string, number>()
    const post = new Map<string, number>()
    for (const rc of connectome.roiCounts) {
      pre.set(rc.roi, (pre.get(rc.roi) ?? 0) + rc.pre)
      post.set(rc.roi, (post.get(rc.roi) ?? 0) + rc.post)
    }

    const rows = connectome.rois.map((roi) => {
      const tracedPre = pre.get(roi) ?? 0
      const tracedPost = post.get(roi) ?? 0
      const reconstructed = mockReconstructedFraction(roi)
      const totalPre = Math.round(tracedPre / reconstructed)
      const totalPost = Math.round(tracedPost / reconstructed)
      return {
        roi,
        pre: tracedPre,
        post: tracedPost,
        totalPre,
        totalPost,
        preCompleteness: totalPre > 0 ? tracedPre / totalPre : null,
        postCompleteness: totalPost > 0 ? tracedPost / totalPost : null,
        primary: true,
      }
    })

    return tableFromRows(ROI_COMPLETENESS_SCHEMA, rows)
  }

  /**
   * Region-to-region connectivity, long form.
   *
   * Each neuron is attributed to the single region it has most synapses in, and connections
   * are rolled up over those. Attributing a connection's *synapses* across every region both
   * neurons touch would be more faithful and costs `connections × rois²`, which on the larger
   * synthetic dataset is not a thing to do on every run for a picture that reads the same.
   *
   * Note `weight` here is a synapse sum, while neuPrint's is normalised — measured on
   * hemibrain, `AB(L)→BU(L)` reports `count: 13, weight: 3.11`, so the real one is not
   * additive. The two are therefore *not* comparable, which is safe only because nothing reads
   * the column's meaning: the node that draws a matrix defaults to `count` for exactly this
   * reason. Do not build anything on `weight` agreeing across sources until the real one's
   * definition is settled.
   */
  async fetchRoiConnectivity(req: RoiSummaryRequest): Promise<TableValue> {
    await delay(this.latencyMs, req.signal)
    const connectome = this.require(req.datasetId)
    const home = mockHomeRois(connectome)

    const pairs = new Map<string, Map<string, { count: number; weight: number }>>()
    for (const c of connectome.connections) {
      const from = home.get(c.pre)
      const to = home.get(c.post)
      if (!from || !to) continue
      let row = pairs.get(from)
      if (!row) {
        row = new Map()
        pairs.set(from, row)
      }
      const cell = row.get(to)
      if (cell) {
        cell.count += 1
        cell.weight += c.weight
      } else {
        row.set(to, { count: 1, weight: c.weight })
      }
    }

    // Sorted, so the row order is stable across runs — it reaches a provenance key by way of
    // the node that consumes it, and a Map's insertion order follows the connection list.
    const rows: Array<Record<string, CellValue>> = []
    for (const from of [...pairs.keys()].sort()) {
      const row = pairs.get(from)!
      for (const to of [...row.keys()].sort()) {
        const cell = row.get(to)!
        rows.push({ source: from, target: to, count: cell.count, weight: cell.weight })
      }
    }

    return tableFromRows(ROI_CONNECTIVITY_SCHEMA, rows)
  }

  /**
   * A shell per region.
   *
   * Every region the connectome names, because the mock's are all primary — `fetchRoiCompleteness`
   * above says so for the same set. A real source has to filter, which is why `rois` is on the
   * request at all.
   *
   * Progress is reported per region rather than once at the end. It costs nothing here, where
   * the shells are generated in a loop, and it is the shape the real source needs: the run ring
   * is the only thing that makes a sixty-request fetch tolerable, and only the source knows how
   * many have landed.
   */
  async fetchRoiMeshes(req: RoiMeshRequest): Promise<MeshesValue> {
    await delay(this.latencyMs, req.signal)
    const connectome = this.require(req.datasetId)
    const rois = req.rois ?? connectome.rois

    const items: MeshGeometry[] = []
    const rows: Array<Record<string, string | boolean>> = []
    for (const roi of rois) {
      throwIfAborted(req.signal)
      items.push(generateRoiMesh(roi))
      rows.push({ roi, primary: true })
      req.onProgress?.(items.length / Math.max(1, rois.length), roi)
    }

    return {
      kind: 'meshes',
      items,
      attributes: tableFromRows(ROI_MESH_SCHEMA, rows),
      bounds: boundsOf(items.map((m) => m.positions)),
      units: 'nm',
    }
  }

  // --- morphology ----------------------------------------------------------

  async fetchSkeletons(req: GeometryRequest): Promise<SkeletonsValue> {
    await delay(this.latencyMs * 1.5, req.signal)
    const connectome = this.require(req.datasetId)

    const items: SkeletonGeometry[] = []
    const rows: Array<Record<string, number | string>> = []

    for (const neuronId of numericIds(req.neuronIds)) {
      throwIfAborted(req.signal)
      const neuron = connectome.byId.get(neuronId)
      if (!neuron) continue
      const rois = connectome.roiCounts
        .filter((rc) => rc.neuronId === neuronId)
        .sort((a, b) => b.pre + b.post - (a.pre + a.post))
        .map((rc) => rc.roi)

      const skeleton = generateSkeleton(neuronId, rois)
      items.push(skeleton)
      rows.push({
        neuronId,
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
      // Synthetic, but generated in nm-like units, so it says so rather than leaving a
      // consumer to guess — the brain is simply a small one.
      units: 'nm',
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
      units: 'nm',
    }
  }

  async fetchSynapses(req: SynapseRequest): Promise<PointsValue> {
    await delay(this.latencyMs, req.signal)
    const connectome = this.require(req.datasetId)
    const minWeight = req.minWeight ?? 1

    const positions: number[] = []
    const rows: Array<Record<string, number | string>> = []

    for (const neuronId of numericIds(req.neuronIds)) {
      throwIfAborted(req.signal)
      const neuron = connectome.byId.get(neuronId)
      if (!neuron) continue
      // The skeleton is regenerated here rather than cached, because it is seeded and
      // therefore identical — synapses land on the same arbor the 3D viewer draws.
      const rois = connectome.roiCounts.filter((rc) => rc.neuronId === neuronId).map((rc) => rc.roi)
      const skeleton = generateSkeleton(neuronId, rois)

      let index = 0
      const emit = (partnerId: number, weight: number, polarity: 'pre' | 'post') => {
        if (weight < minWeight) return
        if (req.polarity && req.polarity !== polarity) return
        const [x, y, z] = synapsePosition(skeleton, index++)
        positions.push(x, y, z)
        rows.push({
          neuronId,
          type: neuron.type,
          partnerId,
          partnerType: connectome.byId.get(partnerId)?.type ?? 'unknown',
          polarity,
          weight,
        })
      }

      for (const edge of connectome.out.get(neuronId) ?? []) emit(edge.post, edge.weight, 'pre')
      for (const edge of connectome.in.get(neuronId) ?? []) emit(edge.pre, edge.weight, 'post')
    }

    const buffer = Float32Array.from(positions)
    return {
      kind: 'points',
      positions: buffer,
      attributes: tableFromRows(this.schemas.synapses, rows),
      bounds: boundsOf([buffer]),
      units: 'nm',
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

  /** Map neuron ids to matrix row/column keys — either their type or their own id. */
  private keysFor(
    connectome: NonNullable<ReturnType<typeof getConnectome>>,
    neuronIds: number[],
    groupByType: boolean,
  ): { labels: string[]; keyOf: Map<number, string> } {
    const keyOf = new Map<number, string>()
    const labels: string[] = []
    const seen = new Set<string>()
    for (const neuronId of neuronIds) {
      const neuron = connectome.byId.get(neuronId)
      if (!neuron) continue
      const key = groupByType ? neuron.type : String(neuronId)
      keyOf.set(neuronId, key)
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

/**
 * A stable "reconstructed fraction" for one region, derived from its name.
 *
 * FNV-1a over the name, mapped into 0.55–0.99. Deterministic and stateless, which is the
 * point: `evaluate` has to be reproducible from its params alone (invariant 4), so a mock
 * roll-up that reached for `Math.random` would hand back different numbers on every run and
 * invalidate its own cache entry. Seeding a generator would work too and would have to be
 * threaded through; a hash of the input needs nothing carried.
 *
 * The range is chosen to look like a real dataset rather than to flatter one: hemibrain
 * measures 91% of presynaptic sites and 39% of postsynaptic ones reconstructed, so a spread
 * this wide is the honest shape for a completeness bar to have.
 */
function mockReconstructedFraction(roi: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < roi.length; i++) {
    hash ^= roi.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return 0.55 + (hash % 4400) / 10_000
}

/**
 * Each neuron's single home region — where it has the most synapses.
 *
 * Ties break on the region name rather than on whichever row came first, so the answer cannot
 * depend on the order `roiCounts` happens to have been generated in. That order is stable
 * today; relying on it would be a dependency nothing states and nothing checks.
 */
function mockHomeRois(connectome: MockConnectome): Map<number, string> {
  const best = new Map<number, { roi: string; synapses: number }>()
  for (const rc of connectome.roiCounts) {
    const synapses = rc.pre + rc.post
    const current = best.get(rc.neuronId)
    if (
      !current ||
      synapses > current.synapses ||
      (synapses === current.synapses && rc.roi < current.roi)
    ) {
      best.set(rc.neuronId, { roi: rc.roi, synapses })
    }
  }
  return new Map([...best].map(([neuronId, { roi }]) => [neuronId, roi]))
}

/**
 * A synthetic region hierarchy, so the grouping control is demonstrable with no token.
 *
 * neuPrint publishes `Meta.roiHierarchy` and the real source derives this from it; the mock has
 * no such tree, so the groups are declared. They are the anatomy the mock's regions actually
 * belong to — the mushroom body lobes really are one system — rather than arbitrary buckets,
 * because a control demonstrated on nonsense teaches the wrong thing about what it is for.
 *
 * A region absent from the table has no group, which is the case that matters: hemibrain lists
 * `AL(L)` and `GNG` directly under the dataset root, so "ungrouped" has to be a state the widget
 * can draw rather than an oversight.
 */
const MOCK_ROI_GROUPS: Record<string, string> = {
  'ME(R)': 'Optic lobe',
  'LO(R)': 'Optic lobe',
  'LOP(R)': 'Optic lobe',
  'CA(R)': 'Mushroom body',
  'PED(R)': 'Mushroom body',
  'aL(R)': 'Mushroom body',
  "a'L(R)": 'Mushroom body',
  'bL(R)': 'Mushroom body',
  "b'L(R)": 'Mushroom body',
  'gL(R)': 'Mushroom body',
  'PVLP(R)': 'Ventrolateral',
  'PLP(R)': 'Ventrolateral',
  'SLP(R)': 'Superior',
  'SMP(R)': 'Superior',
  // AL(R), LH(R) and AOTU(R) are deliberately ungrouped.
}

function mockRoiSuper(rois: readonly string[]): Record<string, string> {
  const groups: Record<string, string> = {}
  for (const roi of rois) {
    const group = MOCK_ROI_GROUPS[roi]
    if (group) groups[roi] = group
  }
  return groups
}
