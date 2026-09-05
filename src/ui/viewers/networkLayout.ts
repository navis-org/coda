/**
 * Network layouts.
 *
 * Three come from graphology; `layered` is hand-rolled because graphology has no DAG
 * layout and pulling in dagre for one algorithm wasn't worth ~50kB. It is the classic
 * Sugiyama opening: longest-path layering, then barycentre ordering within each layer to
 * cut crossings. That is the shape circuit diagrams are drawn in — lamina → medulla →
 * lobula, or PN → KC → MBON — so it earns its place for connectomics.
 */

import type Graph from 'graphology'

import type { CellValue, NetworkValue } from '../../core/values'
import { getColumn } from '../../core/values'
import { componentsOfEdges } from '../../nodes/lib/networkOps'
import { groupByComponent, shelfPack } from './componentPack'
import { PREFUSE_DEFAULTS, prefuseLayout, prefuseRun } from './prefuseForce'

export type LayoutName =
  'forceatlas2' | 'prefuse' | 'circular' | 'layered' | 'columns' | 'grouped' | 'spectral'

export type Orientation = 'lr' | 'tb'

/** Where ForceAtlas2 starts from. */
export type ForceSeed = 'spectral' | 'circle'

/** Whether the quadtree approximation is used; `auto` defers to graphology's own threshold. */
export type BarnesHut = 'auto' | 'on' | 'off'

export interface LayoutOptions {
  layout: LayoutName
  /**
   * Positions handed in from upstream, which win over `layout` outright.
   *
   * Not a `LayoutName` of its own: whether positions arrived is a fact about the wiring, not
   * a choice somebody made in the styling panel, and expressing it as a mode would mean the
   * enum silently changing under them when they connect a wire. Ids the network does not have
   * are ignored, and network nodes this does not name fall back to the chosen layout — so a
   * layout computed before an upstream filter ran still places everything it can.
   */
  given?: Readonly<Record<string, { x: number; y: number }>> | undefined
  iterations?: number
  /** Node-attribute columns used by the `columns` layout. */
  xColumn?: string | undefined
  yColumn?: string | undefined
  /** `layered`: which way the layers run. Feed-forward circuits are usually drawn left→right. */
  orientation?: Orientation
  /** `layered`: take the layer from this column rather than from longest-path depth. */
  layerColumn?: string | undefined
  /** `grouped`: partition nodes by this column. */
  groupColumn?: string | undefined
  /** `forceatlas2`: what to start from. */
  seed?: ForceSeed
  /** `forceatlas2`: quadtree approximation. */
  barnesHut?: BarnesHut
  /** `forceatlas2`: how much link weight pulls. 0 ignores it, 1 is proportional. */
  weightInfluence?: number
  /**
   * `prefuse`: lay each connected component out on its own and pack the results.
   *
   * On by default, because it is the whole reason this layout exists — see
   * `prefusePositions`. Cytoscape spells the same choice as a "singlePartition" checkbox.
   */
  partition?: boolean
  /** `prefuse`: rest length of a link, which sets the scale of everything else. */
  springLength?: number
}

/**
 * ForceAtlas2 settings, with the quadtree choice resolved.
 *
 * `inferSettings` already switches Barnes-Hut on above 2,000 nodes, which is why a 3,000-node
 * graph is *already* getting it — the control exists to force it on below that threshold,
 * where it is still worth about 1.6×, or off when comparing layouts. Measured at 100
 * iterations on a 3-regular graph: 1,000 nodes 425ms → 259ms, 3,000 2656ms → 850ms, 6,000
 * 10710ms → 2013ms.
 */
export function forceSettings(
  infer: (graph: Graph) => Record<string, unknown>,
  graph: Graph,
  barnesHut: BarnesHut = 'auto',
  weightInfluence?: number,
): Record<string, unknown> {
  const settings: Record<string, unknown> = { ...infer(graph), adjustSizes: true }
  if (barnesHut !== 'auto') settings['barnesHutOptimize'] = barnesHut === 'on'
  if (weightInfluence !== undefined) {
    settings['edgeWeightInfluence'] = Math.max(0, Math.min(1, weightInfluence))
  }
  return settings
}

export interface Positioned {
  x: number
  y: number
}

export interface NetworkTopology {
  ids: string[]
  index: Map<string, number>
  /** Adjacency as index pairs, in edge order. */
  edges: Array<[number, number]>
  weights: number[]
}

/** Flatten a NetworkValue into index-based topology once, for every layout to share. */
export function readTopology(network: NetworkValue): NetworkTopology {
  const idColumn = getColumn(network.nodes, 'id')
  const ids = idColumn.map((cell) => String(cell ?? ''))
  const index = new Map(ids.map((id, i) => [id, i]))

  const sourceColumn = getColumn(network.edges, 'source')
  const targetColumn = getColumn(network.edges, 'target')
  const weightColumn = network.edges.data['weight'] ?? []

  const edges: Array<[number, number]> = []
  const weights: number[] = []
  for (let i = 0; i < network.edges.length; i++) {
    const a = index.get(String(sourceColumn[i] ?? ''))
    const b = index.get(String(targetColumn[i] ?? ''))
    if (a === undefined || b === undefined) continue
    edges.push([a, b])
    weights.push(Number(weightColumn[i] ?? 1) || 1)
  }
  return { ids, index, edges, weights }
}

/**
 * Layer assignment by longest path from a source.
 *
 * Real connectomes contain cycles (recurrent circuits are the norm), so this is not a DAG
 * algorithm with a cycle precondition. Instead it relaxes layers iteratively and caps the
 * number of passes: a cycle simply stops improving, rather than hanging.
 */
export function assignLayers(topology: NetworkTopology): number[] {
  const count = topology.ids.length
  const layer = new Int32Array(count)
  const maxPasses = Math.min(count, 64)

  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false
    for (const [from, to] of topology.edges) {
      if (from === to) continue
      if (layer[to]! < layer[from]! + 1) {
        layer[to] = layer[from]! + 1
        changed = true
      }
    }
    if (!changed) break
  }
  return [...layer]
}

/**
 * Layers read off a node attribute rather than derived from the topology.
 *
 * Longest-path depth answers "how far downstream is this?", which is the right question for a
 * circuit whose structure you do not know yet. Once you do know it, the useful axis is usually
 * something the data already says — `class` running sensory → interneuron → motor, or an ROI
 * ordering — and no amount of relaxation will recover that from edges alone.
 *
 * Distinct values are ordered numerically when they all parse as numbers and lexically
 * otherwise, so a numeric layer column does not sort 10 before 2. Missing values land in a
 * final layer of their own rather than silently joining layer zero.
 */
export function layersFromValues(values: Array<CellValue | undefined>): number[] {
  const seen: string[] = []
  const keys = values.map((cell) => {
    if (cell === null || cell === undefined || cell === '') return null
    const key = String(cell)
    if (!seen.includes(key)) seen.push(key)
    return key
  })

  const numeric = seen.every((key) => Number.isFinite(Number(key)))
  const ordered = [...seen].sort((a, b) =>
    numeric ? Number(a) - Number(b) : a.localeCompare(b),
  )
  const rank = new Map(ordered.map((key, index) => [key, index]))
  // Unlabelled nodes go last, where they read as "not placed" rather than as the first stage.
  return keys.map((key) => (key === null ? ordered.length : (rank.get(key) ?? ordered.length)))
}

/** Barycentre ordering: place each node near the mean position of its neighbours. */
function orderWithinLayers(topology: NetworkTopology, layers: number[]): number[] {
  const count = topology.ids.length
  const neighbours: number[][] = Array.from({ length: count }, () => [])
  for (const [from, to] of topology.edges) {
    neighbours[from]!.push(to)
    neighbours[to]!.push(from)
  }

  const byLayer = new Map<number, number[]>()
  for (let i = 0; i < count; i++) {
    const list = byLayer.get(layers[i]!) ?? []
    list.push(i)
    byLayer.set(layers[i]!, list)
  }

  const order = new Float64Array(count)
  for (const list of byLayer.values())
    list.forEach((node, position) => (order[node] = position))

  // A couple of sweeps is enough to remove most crossings; more has diminishing returns.
  for (let sweep = 0; sweep < 4; sweep++) {
    for (const list of byLayer.values()) {
      const scored = list.map((node) => {
        const near = neighbours[node]!
        if (near.length === 0) return { node, score: order[node]! }
        let sum = 0
        for (const other of near) sum += order[other]!
        return { node, score: sum / near.length }
      })
      scored.sort((a, b) => a.score - b.score || a.node - b.node)
      scored.forEach((entry, position) => (order[entry.node] = position))
    }
  }

  return [...order]
}

/**
 * Compute positions for every node.
 *
 * graphology's layouts are imported lazily inside this function so the network chunk only
 * loads them when a network is actually rendered.
 */
export async function computeLayout(
  network: NetworkValue,
  options: LayoutOptions,
): Promise<Map<string, Positioned>> {
  const topology = readTopology(network)
  const positions = new Map<string, Positioned>()
  const count = topology.ids.length
  if (count === 0) return positions

  /*
   * Given positions are checked before the algorithm, and are *not* normalised — unlike every
   * computed layout here. An upstream layout is in real units somebody chose (ELK's, in the
   * Paths node's case) and sigma's `autoRescale` frames it regardless; rescaling it here would
   * only make the numbers disagree with the value that produced them.
   *
   * Nodes the layout does not mention fall through to the chosen algorithm rather than
   * stacking at the origin, which is what makes a partly-stale layout degrade instead of
   * collapsing.
   */
  if (options.given) {
    const given = options.given
    const missing: string[] = []
    for (const id of topology.ids) {
      const at = given[id]
      if (at && Number.isFinite(at.x) && Number.isFinite(at.y))
        positions.set(id, { x: at.x, y: at.y })
      else missing.push(id)
    }
    if (positions.size > 0) {
      if (missing.length > 0) {
        // Ring the strays around the given field rather than dropping them on it.
        const radius = fieldRadius(positions) * 1.15 + 50
        missing.forEach((id, i) => {
          const angle = (i / missing.length) * Math.PI * 2
          positions.set(id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius })
        })
      }
      return positions
    }
    // Nothing matched — a layout for a different node set. Fall through and compute one.
    positions.clear()
  }

  if (options.layout === 'columns') {
    const xData = options.xColumn ? network.nodes.data[options.xColumn] : undefined
    const yData = options.yColumn ? network.nodes.data[options.yColumn] : undefined
    topology.ids.forEach((id, i) => {
      // Missing or non-numeric coordinates fall back to a ring, so a bad column choice
      // still produces a readable picture instead of every node stacked at the origin.
      const x = Number(xData?.[i])
      const y = Number(yData?.[i])
      const angle = (i / count) * Math.PI * 2
      positions.set(id, {
        x: Number.isFinite(x) ? x : Math.cos(angle) * 100,
        y: Number.isFinite(y) ? y : Math.sin(angle) * 100,
      })
    })
    return normalise(positions)
  }

  if (options.layout === 'layered') {
    const column = options.layerColumn ? network.nodes.data[options.layerColumn] : undefined
    const layers = column
      ? layersFromValues(Array.from({ length: count }, (_, i) => column[i]))
      : assignLayers(topology)
    const order = orderWithinLayers(topology, layers)
    // Top-down swaps the two axes rather than rotating, so the *spacing* swaps with them:
    // layers stay far apart along their own axis and nodes stay close along theirs.
    const vertical = options.orientation === 'tb'
    topology.ids.forEach((id, i) => {
      const depth = layers[i]! * LAYER_GAP
      const across = order[i]! * WITHIN_LAYER_GAP
      positions.set(id, vertical ? { x: across, y: depth } : { x: depth, y: across })
    })
    return normalise(positions)
  }

  if (options.layout === 'grouped') {
    return normalise(groupedPositions(network, topology, options.groupColumn))
  }

  if (options.layout === 'spectral') {
    return normalise(spectralPositions(topology))
  }

  if (options.layout === 'prefuse') {
    return normalise(await prefusePositions(topology, options))
  }

  if (options.layout === 'circular') {
    const { default: circular } = await import('graphology-layout/circular')
    const graph = await toGraphology(network, topology)
    const result = circular(graph, { scale: 100 }) as unknown as Record<string, Positioned>
    for (const [id, position] of Object.entries(result)) positions.set(id, position)
    return normalise(positions)
  }

  /*
   * ForceAtlas2 returns only its *seed* now; the settling itself happens in a worker against
   * the live graph — see `startForceLayout`. So this is a circle, which is what FA2 needs to
   * begin with: non-coincident starting positions, or the repulsion has no direction to push
   * in and every node sits on the origin forever.
   *
   * Deliberately not normalised, unlike every other layout here. Normalising would hand FA2 a
   * 1000-unit box when its gravity and scaling settings were tuned against this one, and
   * sigma's `autoRescale` frames the result regardless — including while it is still moving.
   */
  seedPositions(topology, positions, options.seed ?? 'circle')

  // Small enough to settle here, in less time than a single animated frame would have cost.
  if (!needsForceWorker(count)) {
    const [{ default: forceAtlas2 }, graph] = await Promise.all([
      import('graphology-layout-forceatlas2'),
      toGraphology(network, topology),
    ])
    for (const [id, at] of positions) {
      graph.setNodeAttribute(id, 'x', at.x)
      graph.setNodeAttribute(id, 'y', at.y)
    }
    forceAtlas2.assign(graph, {
      iterations: Math.max(10, options.iterations ?? 220),
      settings: forceSettings(
        forceAtlas2.inferSettings,
        graph,
        options.barnesHut,
        options.weightInfluence,
      ),
    })
    graph.forEachNode((id, attrs) => {
      positions.set(id, { x: Number(attrs.x), y: Number(attrs.y) })
    })
  }

  return positions
}

/**
 * Fill in ForceAtlas2's starting positions.
 *
 * A circle is the classic seed and its only virtue is that no two nodes coincide — without
 * that the repulsion has no direction to push along.
 *
 * Seeding from the spectral embedding *should* hand FA2 the global arrangement and leave it
 * only the local refinement, and it is a standard technique. It is offered, and it is not the
 * default, because no benchmark here could demonstrate the win: three synthetic attempts each
 * turned out to measure something else (a blob's scale, a circulant cluster's own low
 * eigenvalues, and index adjacency, which a circle seed satisfies by construction). Defaulting
 * to an unvalidated change is exactly the habit the palette rules exist to prevent — so the
 * circle stays the default until a real connectome says otherwise.
 *
 * The circle is also the fallback whenever the embedding degenerates.
 */
function seedPositions(
  topology: NetworkTopology,
  positions: Map<string, Positioned>,
  seed: ForceSeed,
): void {
  const count = topology.ids.length
  const axes = seed === 'spectral' ? spectralAxes(topology) : undefined

  if (axes) {
    // Scaled to the radius a circle seed would have used, so FA2's gravity and scaling — tuned
    // against that scale — behave the same whichever seed it was given.
    const span = (v: number[]) => Math.max(SPECTRAL_MIN_SPREAD, Math.max(...v) - Math.min(...v))
    const scale = (2 * SEED_RADIUS) / Math.max(span(axes[0]), span(axes[1]))
    topology.ids.forEach((id, i) => {
      positions.set(id, { x: axes[0][i]! * scale, y: axes[1][i]! * scale })
    })
    return
  }

  topology.ids.forEach((id, i) => {
    const angle = (i / count) * Math.PI * 2
    positions.set(id, { x: Math.cos(angle) * SEED_RADIUS, y: Math.sin(angle) * SEED_RADIUS })
  })
}

const SEED_RADIUS = 50

async function toGraphology(network: NetworkValue, topology: NetworkTopology) {
  const { default: Graph } = await import('graphology')
  const graph = new Graph({ type: network.directed ? 'directed' : 'undirected', multi: false })
  for (const id of topology.ids) graph.addNode(id)
  topology.edges.forEach(([from, to], i) => {
    const source = topology.ids[from]!
    const target = topology.ids[to]!
    if (source === target) return // self-loops have no layout meaning
    if (graph.hasEdge(source, target)) return
    graph.addEdge(source, target, { weight: topology.weights[i] ?? 1 })
  })
  return graph
}

/**
 * Spectral embedding: the graph's own principal axes.
 *
 * Coordinates come from the eigenvectors of the Laplacian **L = D − A** for its smallest
 * non-trivial eigenvalues — the Fiedler vector and the one after it. That embedding places
 * densely-connected groups together and pushes weakly-linked ones apart, which is the global
 * structure a force layout otherwise has to discover by pushing nodes around for thousands of
 * iterations. As a layout in its own right it is deterministic and instant; as a *seed* for
 * ForceAtlas2 it is the difference between refining a picture and building one.
 *
 * Power iteration on **B = cI − L**, since power iteration finds the *largest* eigenvalue and
 * the ones wanted here are the smallest. `c = 2·maxWeightedDegree` bounds λmax(L), so B is
 * positive semi-definite and its largest eigenvalues are L's smallest. Each vector is
 * orthogonalised against the constant vector (L's eigenvalue-0 eigenvector) and against the
 * vectors already found, so the second axis cannot collapse onto the first.
 *
 * Unweighted on purpose: synaptic weights span orders of magnitude, and letting them into the
 * Laplacian lets a handful of strong links dominate the embedding. Structure is what is being
 * asked for here; the weights get their say in ForceAtlas2 and in the link widths.
 *
 * A disconnected graph has one zero eigenvalue per component, so the leading vectors become
 * component indicators — every component collapses to a point. That is degenerate rather than
 * wrong, and `spectralPositions` reports it so the caller can fall back.
 */
const SPECTRAL_ITERATIONS = 200
/** Below this spread on an axis, the embedding has collapsed and is not worth drawing. */
const SPECTRAL_MIN_SPREAD = 1e-6

function adjacency(topology: NetworkTopology): number[][] {
  const near: number[][] = Array.from({ length: topology.ids.length }, () => [])
  for (const [from, to] of topology.edges) {
    if (from === to) continue
    near[from]!.push(to)
    near[to]!.push(from)
  }
  return near
}

/**
 * Two spectral axes, or `undefined` when the embedding degenerates.
 *
 * Exported for its tests: this is pure arithmetic over a topology, which is exactly the sort
 * of thing that can be pinned down without a renderer.
 */
export function spectralAxes(topology: NetworkTopology): [number[], number[]] | undefined {
  const n = topology.ids.length
  if (n < 3) return undefined
  /*
   * With no edges L is the zero matrix, so B is a multiple of the identity and power
   * iteration hands back whatever it started from — an arbitrary pattern that *looks*
   * non-degenerate to a spread check but says nothing about a graph. There is no structure
   * to embed, and saying so is what lets the caller fall back to a ring.
   */
  if (topology.edges.length === 0) return undefined

  const near = adjacency(topology)
  const degree = near.map((list) => list.length)
  const shift = 2 * Math.max(1, ...degree)

  // B·v = (c − deg(i))·v[i] + Σ v[j], the neighbour sum standing in for −L's off-diagonal.
  const apply = (v: number[]): number[] => {
    const out = new Array<number>(n)
    for (let i = 0; i < n; i++) {
      let sum = 0
      for (const j of near[i]!) sum += v[j]!
      out[i] = (shift - degree[i]!) * v[i]! + sum
    }
    return out
  }

  const normalise2 = (v: number[]): number => {
    let norm = 0
    for (const x of v) norm += x * x
    norm = Math.sqrt(norm)
    if (norm < SPECTRAL_MIN_SPREAD) return 0
    for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm
    return norm
  }

  const orthogonalise = (v: number[], against: number[][]): void => {
    // The constant vector first: it is L's eigenvalue-0 eigenvector, and leaving it in would
    // hand back a translation rather than an axis.
    let mean = 0
    for (const x of v) mean += x
    mean /= v.length
    for (let i = 0; i < v.length; i++) v[i] = v[i]! - mean

    for (const u of against) {
      let dot = 0
      for (let i = 0; i < v.length; i++) dot += v[i]! * u[i]!
      for (let i = 0; i < v.length; i++) v[i] = v[i]! - dot * u[i]!
    }
  }

  const found: number[][] = []
  for (let axis = 0; axis < 2; axis++) {
    // Deterministic start — a layout that is cached and re-derived must not wander between
    // runs. The irrational multiplier just avoids a start that is orthogonal to what we want.
    let v = Array.from({ length: n }, (_, i) => Math.sin((i + 1) * (axis + 1) * 2.399963))
    orthogonalise(v, found)
    if (normalise2(v) === 0) return undefined

    for (let step = 0; step < SPECTRAL_ITERATIONS; step++) {
      v = apply(v)
      orthogonalise(v, found)
      if (normalise2(v) === 0) return undefined
    }
    found.push(v)
  }

  const [x, y] = found as [number[], number[]]
  const spread = (v: number[]) => Math.max(...v) - Math.min(...v)
  if (spread(x) < SPECTRAL_MIN_SPREAD || spread(y) < SPECTRAL_MIN_SPREAD) return undefined
  return [x, y]
}

/** Spectral positions, falling back to a ring where the embedding degenerates. */
function spectralPositions(topology: NetworkTopology): Map<string, Positioned> {
  const positions = new Map<string, Positioned>()
  const axes = spectralAxes(topology)
  const count = topology.ids.length
  topology.ids.forEach((id, i) => {
    if (axes) positions.set(id, { x: axes[0][i]!, y: axes[1][i]! })
    else {
      const angle = (i / count) * Math.PI * 2
      positions.set(id, { x: Math.cos(angle) * 100, y: Math.sin(angle) * 100 })
    }
  })
  return positions
}

/** Layered spacing, in layout units before normalisation. */
const LAYER_GAP = 140
const WITHIN_LAYER_GAP = 46

/**
 * Nodes clustered by a categorical attribute.
 *
 * The layout connectomics reaches for most often and the one graphology has no answer to:
 * put every neuron of a class, a side or an ROI together, and the question "does this group
 * talk to that one?" becomes a matter of looking rather than of tracing individual links.
 *
 * Groups are laid on a ring ordered by size, largest first, so the biggest clusters are
 * adjacent and the eye starts where the mass is. Within a group nodes take their own small
 * ring, its radius growing with the square root of the count so a group of forty is not forty
 * times the area of a group of one. Entirely deterministic: no seeding, no relaxation.
 */
function groupedPositions(
  network: NetworkValue,
  topology: NetworkTopology,
  columnName: string | undefined,
): Map<string, Positioned> {
  const positions = new Map<string, Positioned>()
  const data = columnName ? network.nodes.data[columnName] : undefined

  const groups = new Map<string, number[]>()
  topology.ids.forEach((_id, i) => {
    const cell = data?.[i]
    const key = cell === null || cell === undefined || cell === '' ? '—' : String(cell)
    const list = groups.get(key)
    if (list) list.push(i)
    else groups.set(key, [i])
  })

  // Size first, then key, so the arrangement cannot depend on insertion order.
  const ordered = [...groups.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  )
  const ringRadius = Math.max(GROUP_RING_MIN, ordered.length * GROUP_RING_STEP)

  ordered.forEach(([, members], groupIndex) => {
    const angle = (groupIndex / ordered.length) * Math.PI * 2
    // A single group has no ring to sit on; centring it avoids an off-centre lone cluster.
    const centre =
      ordered.length === 1
        ? { x: 0, y: 0 }
        : { x: Math.cos(angle) * ringRadius, y: Math.sin(angle) * ringRadius }
    const spread = Math.sqrt(members.length) * MEMBER_SPREAD

    members.forEach((node, memberIndex) => {
      if (members.length === 1) {
        positions.set(topology.ids[node]!, centre)
        return
      }
      const theta = (memberIndex / members.length) * Math.PI * 2
      positions.set(topology.ids[node]!, {
        x: centre.x + Math.cos(theta) * spread,
        y: centre.y + Math.sin(theta) * spread,
      })
    })
  })

  return positions
}

const GROUP_RING_MIN = 260
const GROUP_RING_STEP = 70
const MEMBER_SPREAD = 26

/**
 * Above this many nodes, ForceAtlas2 settles in a worker; below it, right here.
 *
 * Measured, on a 3-regular graph at 220 iterations: 100 nodes 18ms, 200 33ms, 400 122ms,
 * **600 254ms**, 800 451ms, 1200 986ms. The curve is super-linear until `inferSettings` turns
 * Barnes-Hut on well above this range, so the threshold is where a *blocking* run stops being
 * imperceptible rather than where the maths changes.
 *
 * The point is that animation is not free: each iteration costs a postMessage round trip, so
 * 220 of them is 220 round trips however trivial the graph. A 200-node graph reaches the same
 * 220 iterations in 33ms of straight compute. Below the threshold there is no settling worth
 * watching, only a wait to sit through, so the layout simply arrives finished.
 */
export const FORCE_SYNC_BELOW = 600

export function needsForceWorker(nodeCount: number): boolean {
  return nodeCount > FORCE_SYNC_BELOW
}

/**
 * Nominal cost of one supervised ForceAtlas2 iteration, in milliseconds.
 *
 * The supervisor exposes no iteration counter, so `iterations` becomes a *time* budget on the
 * worker path — exact on the synchronous path below `FORCE_SYNC_BELOW`, nominal above it.
 *
 * What actually paces the loop is the iteration itself. `handleMessage` applies the positions
 * and calls `askForIterations` synchronously, so a cycle is one postMessage round trip; sigma
 * renders on its own `requestAnimationFrame` and never blocks it, and the apply pass is a
 * single bulk `updateEachNodeAttributes` costing 0.05ms at 3,000 nodes. Measured per-iteration
 * compute: 1,000 nodes 4.7ms (~213/s), 3,000 14.2ms (~70/s), 6,000 20.8ms (~48/s).
 *
 * So no constant is right at every size — this one is calibrated around three thousand nodes,
 * where a large graph actually needs the worker, and over-delivers below that. An earlier
 * comment here claimed the loop was gated at one iteration per frame; it is not, and the
 * number being close at 3,000 nodes was a coincidence.
 */
const MS_PER_ITERATION = 16
const MAX_SETTLE_MS = 8_000

export function settleDuration(iterations: number | undefined): number {
  const budget = Math.max(10, iterations ?? 220) * MS_PER_ITERATION
  return Math.min(MAX_SETTLE_MS, budget)
}

/** The slice of `graphology-layout-forceatlas2/worker` the viewer drives. */
export interface ForceSupervisor {
  isRunning(): boolean
  start(): void
  stop(): void
  kill(): void
}

/**
 * Run ForceAtlas2 in a web worker, mutating the graph's positions as it settles.
 *
 * The synchronous version this replaces ran every iteration in one blocking call, so a few
 * thousand nodes froze the tab and the "laying out…" note could not even paint. A supervisor
 * costs the layout's determinism — where it stops now depends on wall-clock — which is free
 * here because positions are never persisted and `layout` is presentational.
 *
 * The graph must be fully built first: the supervisor listens for `nodeAdded`/`edgeAdded` and
 * respawns its worker on each one, so starting it early would restart the layout per node.
 */
/**
 * Run the remaining iterations synchronously and land on the settled layout.
 *
 * The escape from watching a large graph converge. This blocks the main thread outright, which
 * is acceptable here in a way it is not for the automatic path, because it only ever runs on an
 * explicit press — someone asking to skip to the end has said they would rather wait than
 * watch. The wall-clock bound is what stops an unbounded graph blocking indefinitely; at ten
 * seconds it is a backstop, not a comfort limit, and a big graph really will lock the tab up
 * for that long.
 *
 * Note the deadline is only checked *between* batches, so the last one can overrun it — by up
 * to a batch's worth of iterations, which on a large graph is a second or two.
 */
export async function skipToSettled(
  graph: Graph,
  iterations: number,
  barnesHut?: BarnesHut,
  weightInfluence?: number,
): Promise<void> {
  const { default: forceAtlas2 } = await import('graphology-layout-forceatlas2')
  const settings = forceSettings(forceAtlas2.inferSettings, graph, barnesHut, weightInfluence)
  const deadline = Date.now() + SKIP_BUDGET_MS
  let remaining = Math.max(10, iterations)
  while (remaining > 0 && Date.now() < deadline) {
    const batch = Math.min(SKIP_BATCH, remaining)
    forceAtlas2.assign(graph, { iterations: batch, settings })
    remaining -= batch
  }
}

/** Longest the skip may block, and the granularity at which it checks the clock. */
const SKIP_BUDGET_MS = 10_000
const SKIP_BATCH = 100

export async function startForceLayout(
  graph: Graph,
  barnesHut?: BarnesHut,
  weightInfluence?: number,
): Promise<ForceSupervisor> {
  const [{ default: FA2Layout }, { default: forceAtlas2 }] = await Promise.all([
    import('graphology-layout-forceatlas2/worker'),
    import('graphology-layout-forceatlas2'),
  ])
  const supervisor = new FA2Layout(graph, {
    settings: forceSettings(forceAtlas2.inferSettings, graph, barnesHut, weightInfluence),
  })
  supervisor.start()
  return supervisor
}

/** Rescale into a stable box so camera framing does not depend on the layout's units. */
/** Half the diagonal of the placed field, for parking nodes the layout did not name. */
function fieldRadius(positions: Map<string, Positioned>): number {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const { x, y } of positions.values()) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  if (!Number.isFinite(minX)) return 0
  return Math.hypot(maxX - minX, maxY - minY) / 2
}

function normalise(positions: Map<string, Positioned>): Map<string, Positioned> {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const { x, y } of positions.values()) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  if (!Number.isFinite(minX)) return positions

  const width = maxX - minX || 1
  const height = maxY - minY || 1
  const scale = 1000 / Math.max(width, height)
  for (const [id, position] of positions) {
    positions.set(id, {
      x: (position.x - (minX + maxX) / 2) * scale,
      y: (position.y - (minY + maxY) / 2) * scale,
    })
  }
  return positions
}

/**
 * Longest the prefuse layout may run before it lands on wherever it has reached.
 *
 * A flat wall-clock deadline rather than a per-node estimate: the partition makes the cost
 * unpredictable from the node count alone — 36,000 nodes in twelve thousand pieces is half a
 * second, and the same 36,000 in one piece is measured at 29 seconds — so the only honest
 * bound is the clock. Measured on one connected component at 100 iterations: 500 nodes 200ms,
 * 1,000 432ms, 2,000 992ms, 5,000 2914ms, 10,000 6481ms, 36,000 29024ms.
 *
 * Stopping early is a degraded picture, never a refusal. See
 * [docs/limits.md](../../../docs/limits.md).
 */
const PREFUSE_BUDGET_MS = 8_000

/** How often the layout hands the thread back, in milliseconds of work. */
const PREFUSE_YIELD_MS = 60

/**
 * Above this many nodes, one component is run in *slices* rather than in one blocking call.
 *
 * The component loop's own yield cannot interrupt a single component, and an ordinary
 * connectome is a single component — so without this the default layout freezes the tab for
 * the whole run. Measured at the shipped 100 passes: 100 nodes 31ms, 200 **61ms**, 400 142ms,
 * 600 236ms, 1,000 424ms, 2,000 965ms, 5,000 2,929ms.
 *
 * 200 is where a whole component costs one yield window, so below it slicing buys nothing —
 * the component finishes inside the pause it would otherwise have taken. The same reasoning as
 * `FORCE_SYNC_BELOW`, measured for this layout rather than inherited from ForceAtlas2's.
 */
const PREFUSE_SLICE_ABOVE = 200

/**
 * Gutter between packed components, as a multiple of the link length.
 *
 * Derived rather than constant: `springLength` is the scale everything else in this layout
 * follows, and its own help says so. Pinning the gutter to the *default* 50 instead would mean
 * that at the top of the slider components are ten times bigger and the gap is not — so the
 * packing's one guarantee, that boxes read as separate, quietly stops holding at exactly the
 * moment somebody touches the knob it refers to.
 */
const COMPONENT_GAP_RATIO = 2

/**
 * Prefuse's force layout, per connected component, packed.
 *
 * **The partitioning is the part that matters**, and it is worth saying why, because the
 * obvious reading of this feature — "a better force law" — is measurably false. On the real
 * 36k-node correspondence graph this was built for (11,936 components, largest 39 nodes),
 * scored by how much of a node's on-screen neighbourhood belongs to its own component:
 *
 * | layout                              | time  | purity |
 * | ----------------------------------- | ----- | ------ |
 * | ForceAtlas2, ~25 iters (its budget) | 2.6s  | 0.047  |
 * | ForceAtlas2, 1,000 iterations       | 115s  | 0.033  |
 * | spectral                            | 0.2s  | 0.219  |
 * | **prefuse, whole graph**            | 8s    | 0.009  |
 * | **prefuse, per component**          | 0.6s  | 0.431  |
 * | a naive grid packing, for reference | —     | 0.367  |
 *
 * Two things to read off it. ForceAtlas2 gets **worse** the longer it runs — it converges, and
 * what it converges to is a uniform pile, because gravity draws every component to one well and
 * no edge exists to push two of them apart. And prefuse on the whole graph is *worse than
 * ForceAtlas2*: the force law on its own buys nothing at all. What buys everything is refusing
 * to ask a force simulation a question it cannot answer — where should two unconnected things
 * sit? — and answering it by packing instead. Cytoscape does the same thing, which is why its
 * "Prefuse Force Directed" output looks like this and ours did not.
 *
 * Left unpartitioned the layout is still offered, because on a graph that really is connected
 * the partition is a no-op and the comparison is worth being able to make.
 */
async function prefusePositions(
  topology: NetworkTopology,
  options: LayoutOptions,
): Promise<Map<string, Positioned>> {
  /*
   * `iterations` is deliberately not read. It belongs to ForceAtlas2, whose default of 220 is
   * tuned for a layout that keeps improving; prefuse's annealing schedule is defined *relative
   * to the pass count*, so a larger number does not refine the picture, it stretches the
   * cooling curve. Measured: 100 passes score 0.431 on the 36k-node graph in 536ms, 220 score
   * 0.376 in 1,126ms. Cytoscape's 100 is the number its output was judged at, and it stands.
   */
  const settings = {
    ...PREFUSE_DEFAULTS,
    springLength: Math.max(1, options.springLength ?? PREFUSE_DEFAULTS.springLength),
  }
  const positions = new Map<string, Positioned>()
  const deadline = Date.now() + PREFUSE_BUDGET_MS
  const breathe = () => new Promise((resolve) => setTimeout(resolve, 0))

  /**
   * Lay one node set out, handing the thread back if it is big enough to be worth it.
   *
   * Small components run straight through — the object and the clock reads would cost more
   * than the pause they save. Above `PREFUSE_SLICE_ABOVE` the run is advanced a pass at a time
   * against the clock, which is what keeps a single large component from freezing the tab.
   */
  const layOut = async (count: number, edges: Array<[number, number]>) => {
    if (count <= PREFUSE_SLICE_ABOVE) return prefuseLayout(count, edges, settings)
    const run = prefuseRun(count, edges, settings)
    let checkpoint = Date.now()
    while (!run.advance(1)) {
      const now = Date.now()
      if (now > deadline) break
      if (now - checkpoint > PREFUSE_YIELD_MS) {
        checkpoint = now
        await breathe()
      }
    }
    return run.positions
  }

  if (options.partition === false) {
    await breathe()
    const out = await layOut(topology.ids.length, topology.edges)
    topology.ids.forEach((id, i) => positions.set(id, { x: out.x[i]!, y: out.y[i]! }))
    return positions
  }

  const groups = groupByComponent(componentsOfEdges(topology.ids.length, topology.edges))

  // Local index for every node, then every edge bucketed to its component in one pass. Asking
  // each component to filter the whole edge list instead is O(components × edges), which on
  // this graph is 295 million comparisons and took ten times longer than the layout itself.
  const groupOf = new Int32Array(topology.ids.length)
  const localOf = new Int32Array(topology.ids.length)
  groups.forEach((members, g) => {
    members.forEach((member, k) => {
      groupOf[member] = g
      localOf[member] = k
    })
  })
  const buckets: Array<Array<[number, number]>> = groups.map(() => [])
  for (const [a, b] of topology.edges) {
    if (a === b) continue
    buckets[groupOf[a]!]!.push([localOf[a]!, localOf[b]!])
  }

  const laid: Array<{ x: Float64Array; y: Float64Array }> = []
  const boxes: Array<{ width: number; height: number }> = []
  let checkpoint = Date.now()
  /*
   * Once the budget is gone the remaining components still have to be *placed* — they keep
   * their seed and get packed like everything else, rather than vanishing — but there is no
   * point spending passes on them. `halt` says so on the first ask.
   */
  let stopped = false
  const halt = () => true
  for (let g = 0; g < groups.length; g++) {
    const members = groups[g]!
    const out = stopped
      ? prefuseLayout(members.length, buckets[g]!, settings, halt)
      : await layOut(members.length, buckets[g]!)
    // Shift each component's own origin to its top-left, so packing can treat it as a box.
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (let k = 0; k < members.length; k++) {
      if (out.x[k]! < minX) minX = out.x[k]!
      if (out.x[k]! > maxX) maxX = out.x[k]!
      if (out.y[k]! < minY) minY = out.y[k]!
      if (out.y[k]! > maxY) maxY = out.y[k]!
    }
    for (let k = 0; k < members.length; k++) {
      out.x[k]! -= minX
      out.y[k]! -= minY
    }
    laid.push(out)
    boxes.push({ width: maxX - minX, height: maxY - minY })

    // Hand the thread back between components too, or twelve thousand small ones add up to a
    // freeze even though no single one of them does. The clock is read here rather than inside
    // the simulation: asking once per *pass* is 1.2 million `Date.now()` calls on the graph
    // this was built for, to police a budget that runs out between components anyway.
    const now = Date.now()
    if (now - checkpoint > PREFUSE_YIELD_MS) {
      checkpoint = now
      stopped = stopped || now > deadline
      await breathe()
    }
  }

  const packed = shelfPack(boxes, COMPONENT_GAP_RATIO * settings.springLength)
  groups.forEach((members, g) => {
    const out = laid[g]!
    const spot = packed.at[g]!
    members.forEach((member, k) => {
      positions.set(topology.ids[member]!, { x: spot.x + out.x[k]!, y: spot.y + out.y[k]! })
    })
  })
  return positions
}
