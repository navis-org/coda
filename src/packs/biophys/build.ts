/**
 * One neuron's skeleton and input synapses as a compartment model — the Compartment Model node's
 * work, kept out of the node so it can be tested without one.
 *
 * Everything source-shaped happens here and nowhere below: units, fragments, missing radii, the
 * soma, synapse placement. `src/biophys` then sees a clean cable tree in micrometres.
 *
 * ## The order is load-bearing
 *
 * 1. **Units and frame** are checked first: nanometres or refuse, skeleton and synapses in one
 *    space (`requireSynapseFrame`), since a model from voxels is a model of something else.
 * 2. **The soma is found before anything is measured from it**: the widest SWC-1 node, else the
 *    delivered root (warned). The tree is re-rooted there.
 * 3. **Only the soma's piece of the arbour is modelled.** A fragment that touches nothing can
 *    change nothing at the soma, and simulating one is NEURON's silent default; it is counted.
 * 4. **Radii are filled, then smoothed** — a filled node takes part in the smoothing like any other;
 *    the soma does not, its diameter being read first.
 * 5. **The soma becomes one section** when there is one to make: a cylinder as long as it is wide,
 *    which has a sphere's area, centred on the soma node, every fibre wired to its centre (NEURON's
 *    soma(0.5)) and starting at its own radius
 *    (`CableTree.startRadius`), so the junction carries no shoulder. Without one, the root stands
 *    in, and is a zero-area node a recording "at the soma" sits on.
 * 6. **Synapses are placed on edges, not snapped to nodes**: `projectSynapses` finds the nearest
 *    point on the arbour and `compartmentAt` the compartment holding it.
 *
 * ## An input is a row whose postsynaptic neuron is this one
 *
 * Asked of the row's two ends, never of `polarity` alone, because `polarity` means two opposite
 * things (`synapseEdges.ts` has the full account): on Synapses Between it is the end the point is
 * *drawn* at — `pre` by default, every row — while `neuronId` is always the presynaptic body; on a
 * Synapses cloud it is the queried neuron's *role*. So the node offers what Synapses to Edges
 * offers: a Presynaptic and a Postsynaptic column, read as they say (`fixed`, Synapses Between),
 * or flipped on rows whose polarity is `post` (`polarity`, a Synapses cloud). Reading `polarity`
 * as a role on Synapses Between's default drops every synapse it was wired for.
 *
 * ## Memoised on the inputs, not on the params
 *
 * The node is `cheap` and re-runs on every edit, while finding the soma, re-rooting a 300,000-node
 * arbour and projecting 60,000 synapses onto it depend on neither membrane, compartments nor
 * columns. They are kept per skeleton (and per cloud), whose values are immutable once decoded.
 */

import { ID_COLUMN_NAME, idText, numericId } from '../../core/ids'
import { positionOf } from '../../nodes/lib/anchors'
import { splitArbor } from '../../nodes/lib/splitCorrections'
import type {
  CellModelValue,
  ColumnData,
  PointsValue,
  SkeletonGeometry,
  SkeletonsValue,
  SynapseSign,
} from '../../core/values'
import { cableLength, getColumn } from '../../core/values'
import type { Orientation } from '../../nodes/lib/synapseEdges'
import { rowFlips } from '../../nodes/lib/synapseEdges'
import { NM_PER_UM } from '../../data/units'
import { widestSomaNode } from '../../data/soma'
import type { Arbor, Placement } from '../../nodes/lib/arborOps'
import { orientPlacement, projectSynapses, stampedRadius } from '../../nodes/lib/arborOps'
import { requireSkeletonUnits, requireSynapseFrame } from '../../nodes/lib/compartmentOps'
import { sitesFrom } from '../../nodes/lib/topologyOps'
import { agree, formatNumber, plural } from '../../style/format'
import type { CableTree, PlacingTree, SegmentRule } from '../../biophys/discretize'
import { compartmentAt, discretize } from '../../biophys/discretize'
import type { ChannelRow } from './channelRows'
import { resolveChannels } from './channelRows'
import { SYNAPSE_SOCKETS } from './synapseParams'
import type { RegionStroke } from './regions'
import { SOMA_REGION, paintedRegions, regionLabels, staleStrokes } from './regions'

export interface ModelOptions {
  readonly preset: CellModelValue['preset']
  readonly membrane: CellModelValue['membrane']
  readonly rule: SegmentRule
  /** Given to every node with no radius, nm. */
  readonly defaultRadius: number
  /** Moving-average window along each unbranched stretch, in nodes; 0 or 1 = off. */
  readonly smoothWindow: number
  /** µm. 0 takes the skeleton's labelled soma, or none. */
  readonly somaDiameter: number
  /** The Regions tab's strokes (`regions.ts`), painted over the skeleton's own labels in order. */
  readonly regionStrokes: readonly RegionStroke[]
  /** The card's channel list (`channelRows.ts`); resolved on the built cable. Empty = passive. */
  readonly channels: readonly ChannelRow[]
  /** °C the channels run at; read only when there are channels. */
  readonly temperature: number
  /** Each socket's mechanism, by sign; `synapseTypes` takes them in `SYNAPSE_SOCKETS`' order. */
  readonly excitatory: SynapseType
  readonly inhibitory: SynapseType
  /** A synapse further than this from the arbour is dropped, µm. */
  readonly maxSnap: number
}

type SynapseType = CellModelValue['synapseTypes'][number]

/** The card's two synapse sockets by sign, either or both wired. */
export type SynapseInputs = Partial<Readonly<Record<SynapseSign, SynapseInput>>>

/**
 * The cloud and the columns that say which end of each row is which — the node resolves them.
 * Under `polarity`, a row whose `polarity` is `post` has its two ends swapped before reading.
 */
export interface SynapseInput {
  readonly points: PointsValue
  readonly presynaptic?: ColumnData
  readonly postsynaptic?: ColumnData
  readonly orientation: Orientation
  readonly polarity?: ColumnData
  /** The presynaptic partner's type, as the row carries it. */
  readonly partnerType?: ColumnData
}

const MANY =
  'Compartment Model builds one neuron at a time, and the wire carries more. Pick one with ' +
  'Select One, or run a For Each over them.'

/** "… was left out", agreeing with the count. */
const leftOut = (n: number) => `${agree(n, 'was', 'were')} left out`

/** What depends on the skeleton alone: the soma, the re-rooted arbour, a stamped radius. */
interface Geometry {
  readonly labelled: number
  readonly arbor: Arbor
  readonly stamped: ReturnType<typeof stampedRadius>
  /** µm of cable on fragments that do not reach the soma. */
  readonly offCable: number
}

const GEOMETRY = new WeakMap<SkeletonGeometry, Geometry>()

function geometryOf(skeleton: SkeletonGeometry): Geometry {
  const hit = GEOMETRY.get(skeleton)
  if (hit) return hit
  const labelled = widestSomaNode(skeleton)
  // `splitArbor`'s default root and cache, so painting from it reuses this arbour, not a copy.
  const arbor = splitArbor(skeleton)
  let kept = 0
  for (const v of arbor.order) kept += arbor.edgeLength[v]!
  const geometry = {
    labelled,
    arbor,
    stamped: stampedRadius(skeleton, arbor),
    offCable: Math.max(0, cableLength(skeleton) - kept) / NM_PER_UM,
  }
  GEOMETRY.set(skeleton, geometry)
  return geometry
}

type CloudPlacement = Placement & { readonly distance: Float32Array }

/** Every row of a cloud placed on the arbour, with its distance from it — whatever the columns. */
const PLACEMENTS = new WeakMap<SkeletonGeometry, WeakMap<PointsValue, CloudPlacement>>()

function placementOf(skeleton: SkeletonGeometry, arbor: Arbor, points: PointsValue) {
  let byCloud = PLACEMENTS.get(skeleton)
  if (!byCloud) PLACEMENTS.set(skeleton, (byCloud = new WeakMap()))
  const hit = byCloud.get(points)
  if (hit) return hit
  const projection = projectSynapses(skeleton, sitesFrom(points))
  const placement = { ...orientPlacement(arbor, projection), distance: projection.distance }
  byCloud.set(points, placement)
  return placement
}

/**
 * What placing a point on a built model needs: its arbour, its compartment tree and how skeleton
 * nodes map onto it. Kept per value, so a record point lands by the rule a synapse did, and held
 * as plain fields rather than a closure, which would keep the whole of the build alive with it.
 */
interface Placer {
  readonly arbor: Arbor
  readonly tree: PlacingTree
  /** Per skeleton node, its node in the cable tree. */
  readonly cableIndex: Int32Array
  readonly somaSet: Uint8Array
  readonly somaCompartment: number
}

const PLACERS = new WeakMap<CellModelValue, Placer>()

/** The compartment holding a point on the edge above skeleton node `v`, `t` of the way down. */
function compartmentOf(placer: Placer, v: number, t: number): number {
  return placer.somaSet[v]
    ? placer.somaCompartment
    : compartmentAt(placer.tree, placer.cableIndex[v]!, t)
}

/**
 * Each point of a cloud placed on a built model, by the rule its synapses were: the nearest point
 * on the arbour, in the compartment holding it (`-1` where that is on a piece the model left out),
 * and its distance from the arbour in µm.
 */
export function placePoints(
  value: CellModelValue,
  points: PointsValue,
): { compartment: Int32Array; distance: Float64Array } {
  const placer = PLACERS.get(value)
  if (!placer) throw new Error('This model was not built in this session; run it again.')
  const placement = placementOf(value.skeleton, placer.arbor, points)
  const compartment = Int32Array.from(placement.node, (v, i) =>
    v < 0 ? -1 : compartmentOf(placer, v, placement.t[i]!),
  )
  const distance = Float64Array.from(placement.distance, (d) => d / NM_PER_UM)
  return { compartment, distance }
}

export function buildCellModel(
  skeletons: SkeletonsValue,
  inputs: SynapseInputs,
  options: ModelOptions,
): CellModelValue {
  // 1. Units and frame: each wired cloud in the skeleton's.
  // A synapse's type is its socket's place in `SYNAPSE_SOCKETS`, the order `synapseTypes` takes.
  const sockets: Socket[] = SYNAPSE_SOCKETS.flatMap(({ sign, label }, type) => {
    const input = inputs[sign]
    return input ? [{ input, type, sign, label }] : []
  })
  for (const { input } of sockets) requireSynapseFrame(skeletons, input.points)
  if (sockets.length === 0) requireSkeletonUnits(skeletons)
  if (skeletons.items.length === 0) throw new Error('The skeleton wire carries no neuron.')
  if (skeletons.items.length > 1) throw new Error(MANY)
  const skeleton = skeletons.items[0]!
  const neuronId = idText(getColumn(skeletons.attributes, ID_COLUMN_NAME)[0]) ?? skeleton.id
  const n = skeleton.parents.length
  const notes: string[] = []

  // 2–3. The soma, the tree re-rooted at it, and only the piece holding it.
  const { labelled, arbor, stamped, offCable } = geometryOf(skeleton)
  const rootNode = arbor.root
  if (arbor.unreached > 0) {
    notes.push(
      `${plural(arbor.unreached, 'node')} (${formatNumber(Math.round(offCable))} µm of cable) ` +
        `${agree(arbor.unreached, 'is', 'are')} on fragments that do not reach the soma, and ` +
        `${leftOut(arbor.unreached)}: nothing there can affect it.`,
    )
  }

  // 4. Radii: fill, note a stamped floor, smooth.
  const radius = new Float64Array(n)
  let filled = 0
  for (const v of arbor.order) {
    const r = skeleton.radii[v]!
    if (Number.isFinite(r) && r > 0) radius[v] = r
    else {
      radius[v] = options.defaultRadius
      filled++
    }
  }
  if (filled > 0) {
    notes.push(
      `${formatNumber(filled)} of ${plural(arbor.order.length, 'node')} had no radius and ` +
        `${agree(filled, 'was', 'were')} given ${formatNumber(options.defaultRadius)} nm.`,
    )
  }
  if (stamped) {
    notes.push(
      `${Math.round(stamped.share * 100)}% of radii are ${formatNumber(stamped.radius)} nm — a ` +
        'skeletonisation floor rather than a measurement, so thin twigs carry more membrane and ' +
        'less axial resistance than they have.',
    )
  }
  // 5. The soma, as a section of its own where there is one to make. Read before any smoothing,
  // which would average the soma's radius with its neurite's and shrink it.
  const source: CellModelValue['soma']['source'] =
    options.somaDiameter > 0 ? 'added' : labelled >= 0 ? 'labelled' : 'root'
  const somaDiameter =
    source === 'added'
      ? options.somaDiameter
      : source === 'labelled'
        ? (2 * radius[rootNode]!) / NM_PER_UM
        : 0
  if (source === 'labelled' && !(skeleton.radii[rootNode]! > 0)) {
    notes.push(
      `The labelled soma has no radius, so it is ${formatNumber(somaDiameter)} µm across, from ` +
        'Default radius. Give a Soma diameter.',
    )
  }
  // The soma is found from the skeleton's own labels; the cable takes the painted ones, so a stroke
  // can relabel the soma's membrane for channels without moving the soma.
  const own = regionLabels(skeleton)
  const regions = paintedRegions(skeleton, options.regionStrokes, own)
  if (regions.stale > 0) notes.push(staleStrokes(regions.stale))
  const somaSet = new Uint8Array(n)
  if (labelled >= 0) {
    // The labelled blob around the soma node: soma nodes reached from it through soma nodes.
    for (const v of arbor.order) {
      if (own.label[v] !== SOMA_REGION) continue
      if (v === rootNode || somaSet[arbor.parent[v]!] === 1) somaSet[v] = 1
    }
  } else if (source === 'added') {
    somaSet[rootNode] = 1
  } else {
    notes.push(
      'No soma is labelled on this skeleton, so its root stands in: a point with no membrane of ' +
        'its own, joined to thin cable. A clamp or recording "at the soma" is at that point. Give ' +
        'a Soma diameter to add one.',
    )
  }

  // Smoothed only now, and never across the soma: averaging it with its fibre would thin the soma
  // and thicken the fibre's start, the shoulder `startRadius` exists to prevent.
  if (options.smoothWindow > 1)
    smoothAlongStretches(arbor, radius, options.smoothWindow, somaSet)

  // An added soma is no node's, so it is soma whatever its root was labelled or painted.
  const somaRegion = source === 'added' ? SOMA_REGION : regions.label[rootNode]!
  const cable = cableTree(
    skeleton,
    arbor,
    radius,
    regions.label,
    somaSet,
    somaDiameter,
    somaRegion,
  )
  const tree = discretize(cable.tree, {
    rule: options.rule,
    ra: options.membrane.ra,
    cm: options.membrane.cm,
  })
  // A cable with no membrane anywhere has nothing to integrate — a lone root, with no soma
  // diameter given — and every trace would come back NaN rather than an answer. (The bare root of
  // an ordinary cable has none of its own, and is held up by the cable around it.)
  if (!tree.area.some((a) => a > 0)) {
    throw new Error(
      'This skeleton has no cable to model: a single node, with no soma to give it membrane. ' +
        'Give a Soma diameter.',
    )
  }

  // The soma's compartment: the cable tree cuts the soma in two halves at its centre, where every
  // fibre is wired, and the centre itself is a junction node of no area; the clamp, the recording
  // and every synapse on a soma node go to the last compartment of the half ending there.
  let somaCompartment = 0
  if (cable.somaCentre >= 0) {
    const half = tree.sections[tree.nodeSection[cable.somaCentre]!]!
    somaCompartment = half.first + half.nseg - 1
  }
  const nodeCompartment = new Int32Array(n).fill(-1)
  for (const v of arbor.order) {
    nodeCompartment[v] = somaSet[v] ? somaCompartment : tree.nodeCompartment[cable.index[v]!]!
  }
  const placer: Placer = {
    arbor,
    // Only what placing reads, so the tree's positions are not kept alive beside the value.
    tree: {
      parent: tree.parent,
      sections: tree.sections,
      nodeSection: tree.nodeSection,
      nodeIndex: tree.nodeIndex,
    },
    cableIndex: cable.index,
    somaSet,
    somaCompartment,
  }

  // 6. Synapses.
  const synapses = placeSynapses(sockets, neuronId, skeleton, placer, options.maxSnap, notes)

  const channels = resolveChannels(
    options.channels,
    { regionNames: regions.names, region: tree.region, area: tree.area },
    notes,
  )

  const value: CellModelValue = {
    kind: 'cellModel',
    neuronId,
    compartments: {
      count: tree.count,
      parent: tree.parent,
      area: tree.area,
      gAxial: tree.gAxial,
      // Back in the skeleton's own units, so a viewer draws compartments over the neuron.
      position: tree.position.map((x) => x * NM_PER_UM),
      region: tree.region,
    },
    regionNames: regions.names,
    skeleton,
    ...(skeletons.space ? { space: skeletons.space } : {}),
    nodeCompartment,
    soma: {
      compartment: somaCompartment,
      source,
      ...(source === 'root' ? {} : { diameter: somaDiameter }),
    },
    membrane: options.membrane,
    channels,
    ...(channels.length > 0 ? { temperature: options.temperature } : {}),
    synapseTypes: SYNAPSE_SOCKETS.map(({ sign }) => options[sign]),
    ...synapses,
    preset: options.preset,
    notes,
  }
  PLACERS.set(value, placer)
  return value
}

/**
 * Smooth radii with a centred moving average along each unbranched stretch — navis's
 * `smooth_skeleton(to_smooth='radius')` — never across a branch point, where averaging a trunk
 * with its twigs would thin the trunk.
 */
function smoothAlongStretches(
  arbor: Arbor,
  radius: Float64Array,
  window: number,
  /** Nodes left out — the soma — so a stretch starts below them. */
  skip: Uint8Array,
): void {
  const half = Math.floor(window / 2)
  const children = (v: number) => arbor.childStart[v + 1]! - arbor.childStart[v]!
  // One buffer each for every stretch, rather than two arrays per stretch.
  const stretch = new Int32Array(arbor.order.length)
  const before = new Float64Array(arbor.order.length)
  for (const start of arbor.order) {
    if (skip[start]) continue
    // A stretch starts at the root, just below a branch point or just below the soma, and runs
    // while there is one child.
    const p = arbor.parent[start]!
    if (p >= 0 && children(p) === 1 && !skip[p]) continue
    let length = 0
    let v = start
    for (;;) {
      stretch[length] = v
      before[length++] = radius[v]!
      if (children(v) !== 1) break
      v = arbor.childList[arbor.childStart[v]!]!
    }
    // A running sum over the window, clipped at the stretch's ends.
    let sum = 0
    for (let k = 0; k <= Math.min(length - 1, half); k++) sum += before[k]!
    for (let i = 0; i < length; i++) {
      const lo = Math.max(0, i - half)
      const hi = Math.min(length - 1, i + half)
      radius[stretch[i]!] = sum / (hi - lo + 1)
      if (i + half + 1 < length) sum += before[i + half + 1]!
      if (i - half >= 0) sum -= before[i - half]!
    }
  }
}

/**
 * The cable tree `discretize` takes, in µm: the re-rooted arbour minus every node off the soma's
 * piece, and, where there is a soma, its labelled nodes replaced by one section — a cylinder
 * `diameter` long and `diameter` across, centred on the soma node along its first fibre, every
 * fibre wired to its centre.
 */
function cableTree(
  skeleton: SkeletonGeometry,
  arbor: Arbor,
  radius: Float64Array,
  label: Int32Array,
  somaSet: Uint8Array,
  somaDiameter: number,
  /** The soma section's region: its node's, or soma for an added one. */
  somaRegion: number,
): { tree: CableTree; index: Int32Array; somaCentre: number } {
  const n = skeleton.parents.length
  const { positions: q } = skeleton
  const index = new Int32Array(n).fill(-1)
  // At most the reached nodes and the soma's three points; written in place, trimmed at the end.
  const size = arbor.order.length + 3
  const positions = new Float64Array(size * 3)
  const radii = new Float64Array(size)
  const parent = new Int32Array(size)
  const labels = new Int32Array(size)
  const startRadius = new Float64Array(size).fill(NaN)
  let count = 0
  const add = (x: number, y: number, z: number, r: number, p: number, label: number) => {
    positions[count * 3] = x / NM_PER_UM
    positions[count * 3 + 1] = y / NM_PER_UM
    positions[count * 3 + 2] = z / NM_PER_UM
    radii[count] = r
    parent[count] = p
    labels[count] = label
    return count++
  }
  const root = arbor.root

  // The soma: a cylinder as long as it is wide, centred on the soma node and laid along the first
  // fibre, its centre a node of its own — and **every fibre is wired to that centre**, NEURON's
  // soma(0.5). Wired to one end instead, a fibre leaving another way crossed an invented bridge
  // of thin cable, several µm long and tens of MΩ, that is in no skeleton.
  let somaCentre = -1
  if (somaDiameter > 0) {
    // Along the first fibre leaving the soma, so a drawing of it points the way the neuron does —
    // the first one not sitting on the soma node, or a duplicated node gives no direction.
    const [x0, y0, z0] = positionOf(q, root)
    const fibre = arbor.order.find((v) => {
      if (somaSet[v]) return false
      const [x, y, z] = positionOf(q, v)
      return x !== x0 || y !== y0 || z !== z0
    })
    const [fx, fy, fz] = fibre === undefined ? [x0 + 1, y0, z0] : positionOf(q, fibre)
    const half = (somaDiameter * NM_PER_UM) / 2 / (Math.hypot(fx - x0, fy - y0, fz - z0) || 1)
    const [dx, dy, dz] = [(fx - x0) * half, (fy - y0) * half, (fz - z0) * half]
    const r = somaDiameter / 2
    const start = add(x0 - dx, y0 - dy, z0 - dz, r, -1, somaRegion)
    somaCentre = add(x0, y0, z0, r, start, somaRegion)
    add(x0 + dx, y0 + dy, z0 + dz, r, somaCentre, somaRegion)
  }

  for (const v of arbor.order) {
    if (somaSet[v]) continue
    const p = arbor.parent[v]!
    const r = radius[v]! / NM_PER_UM
    const fromSoma = somaCentre >= 0 && (p < 0 || somaSet[p] === 1)
    const above = fromSoma ? somaCentre : p < 0 ? -1 : index[p]!
    index[v] = add(q[v * 3]!, q[v * 3 + 1]!, q[v * 3 + 2]!, r, above, label[v]!)
    // A fibre leaving the soma starts at its own radius, not the soma's.
    if (fromSoma) startRadius[index[v]!] = r
  }
  return {
    tree: {
      positions: positions.subarray(0, count * 3),
      radii: radii.subarray(0, count),
      parent: parent.subarray(0, count),
      labels: labels.subarray(0, count),
      startRadius: startRadius.subarray(0, count),
    },
    index,
    somaCentre,
  }
}

/** The partner of a synapse whose presynaptic end is unnamed: no column, or an empty cell. */
export const NO_PARTNER = '-'

/** A socket's cloud, the mechanism its synapses take, and what to call it in a note. */
interface Socket {
  readonly input: SynapseInput
  /** Index into `synapseTypes`. */
  readonly type: number
  readonly sign: SynapseSign
  /** What a note about its synapses calls it. */
  readonly label: string
}

/**
 * Each input synapse of every wired socket placed on a compartment, with its partner and the
 * socket's type; every row left out counted, per socket. A partner on both sockets is one partner
 * (`partners.inhibitory` counts its share), and the card says how many are.
 */
function placeSynapses(
  sockets: readonly Socket[],
  neuronId: string,
  skeleton: SkeletonGeometry,
  placer: Placer,
  maxSnap: number,
  notes: string[],
): Pick<CellModelValue, 'synapses' | 'sites' | 'partners'> {
  const compartment: number[] = []
  const type: number[] = []
  const siteNode: number[] = []
  const siteT: number[] = []
  const partner: number[] = []
  const partnerIndex = new Map<string, number>()
  const ids: string[] = []
  const types: (string | null)[] = []
  const counts: number[] = []
  const inhibitory: number[] = []
  const limit = maxSnap * NM_PER_UM

  // The neuron's id as a number too, so a numeric id column is compared without making text of
  // every row; only an id a float holds exactly has one (invariant 8).
  const numeric = numericId(neuronId)
  const isThisNeuron = (cell: ColumnData[number] | undefined) =>
    typeof cell === 'number' ? cell === numeric : idText(cell) === neuronId
  // Which partners each socket reached, for the count of those on both.
  const reached = sockets.map(() => new Set<number>())
  // A note names its socket wherever the inhibitory one is in play; alone, the excitatory one is
  // simply "the synapses", as it was before there were two.
  const named = sockets.some((socket) => socket.sign === 'inhibitory')

  for (const [k, { input, type: kind, sign, label }] of sockets.entries()) {
    const placement = placementOf(skeleton, placer.arbor, input.points)
    const rows = input.points.attributes.length
    const before = compartment.length
    let notInput = 0
    let unreadable = 0
    let unplaced = 0
    let far = 0
    for (let row = 0; row < rows; row++) {
      let pre = input.presynaptic?.[row]
      let post = input.postsynaptic?.[row]
      if (input.orientation === 'polarity') {
        // Synapses to Edges' rule (`rowFlips`); an unreadable row is left out here, where an edge
        // list keeps it as it is, since a synapse on the wrong neuron is a wrong model.
        const flips = rowFlips(input.polarity?.[row])
        if (flips === undefined) {
          unreadable++
          continue
        }
        if (flips) [pre, post] = [post, pre]
      }
      // Without a Postsynaptic column every row is taken as an input; the card says so below.
      if (input.postsynaptic && !isThisNeuron(post)) {
        notInput++
        continue
      }
      // Far first: a synapse the locator gave up on (distance Infinity) is far, not on a fragment.
      if (placement.distance[row]! > limit) {
        far++
        continue
      }
      const v = placement.node[row]!
      if (v < 0) {
        unplaced++
        continue
      }
      compartment.push(compartmentOf(placer, v, placement.t[row]!))
      type.push(kind)
      siteNode.push(v)
      siteT.push(placement.t[row]!)
      const id = idText(pre) ?? NO_PARTNER
      let p = partnerIndex.get(id)
      if (p === undefined) {
        p = ids.length
        partnerIndex.set(id, p)
        ids.push(id)
        types.push(null)
        counts.push(0)
        inhibitory.push(0)
      }
      // The first type a row names, whichever socket it came on.
      if (types[p] === null) {
        const named = input.partnerType?.[row]
        if (named !== null && named !== undefined) types[p] = String(named)
      }
      counts[p]!++
      if (sign === 'inhibitory') inhibitory[p]!++
      reached[k]!.add(p)
      partner.push(p)
    }

    const say = (sentence: string) => notes.push(named ? `${label}: ${sentence}` : sentence)
    if (!input.presynaptic && compartment.length > before) {
      say(
        `No Presynaptic column, so every synapse is one partner, \`${NO_PARTNER}\`, and fires together.`,
      )
    }
    if (!input.postsynaptic) {
      say(
        'No Postsynaptic column resolved, so every row of the cloud was taken as an input to this neuron.',
      )
    }
    if (notInput > 0) {
      say(
        `${plural(notInput, 'row')} of ${formatNumber(rows)} ${agree(notInput, 'does', 'do')} not ` +
          `have ${neuronId} as the postsynaptic neuron — its outputs, or other neurons' synapses — ` +
          `and ${leftOut(notInput)}.` +
          (compartment.length === before
            ? ' None is an input: check Orientation, and which columns are Presynaptic and Postsynaptic.'
            : ''),
      )
    }
    if (unreadable > 0) {
      say(
        `${plural(unreadable, 'row')} ${agree(unreadable, 'has', 'have')} a polarity that is neither ` +
          '`pre` nor `post`, so which end is which cannot be read; left out.',
      )
    }
    if (unplaced > 0) {
      say(
        `${plural(unplaced, 'synapse')} ${agree(unplaced, 'lies', 'lie')} on fragments off the ` +
          `soma's piece and ${leftOut(unplaced)}.`,
      )
    }
    if (far > 0) {
      say(
        `${plural(far, 'synapse')} ${agree(far, 'is', 'are')} more than ${formatNumber(maxSnap)} µm ` +
          `from the arbour and ${leftOut(far)}. Check that the cloud is this ` +
          'neuron’s.',
      )
    }
  }

  if (reached.length === 2) {
    let both = 0
    for (const p of reached[0]!) if (reached[1]!.has(p)) both++
    if (both > 0) {
      notes.push(
        `${plural(both, 'partner')} ${agree(both, 'has', 'have')} synapses on both sockets. ` +
          `${agree(both, 'It fires', 'Each fires')} as one partner, each synapse with its own ` +
          'socket’s mechanism.',
      )
    }
  }

  return {
    synapses: {
      compartment: Int32Array.from(compartment),
      type: Int32Array.from(type),
      partner: Int32Array.from(partner),
    },
    // `placement` is read on the re-rooted arbour, so each edge runs from its parent there.
    sites: {
      node: Int32Array.from(siteNode),
      from: Int32Array.from(siteNode, (v) => placer.arbor.parent[v]!),
      t: Float32Array.from(siteT),
    },
    partners: {
      id: ids,
      type: types,
      synapses: Int32Array.from(counts),
      inhibitory: Int32Array.from(inhibitory),
    },
  }
}
