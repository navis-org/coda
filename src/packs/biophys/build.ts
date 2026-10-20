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
import type { Arbor, Placement } from '../../nodes/lib/arborOps'
import { orientPlacement, projectSynapses, stampedRadius } from '../../nodes/lib/arborOps'
import { requireSkeletonUnits, requireSynapseFrame } from '../../nodes/lib/compartmentOps'
import { sitesFrom } from '../../nodes/lib/topologyOps'
import { agree, formatNumber, plural } from '../../style/format'
import type { CableTree, PlacingTree, SegmentRule } from '../../biophys/discretize'
import {
  compartmentAt,
  discretize,
  edgeShareAt,
  edgeSpans,
  edgeStartRadius,
} from '../../biophys/discretize'
import type { ChannelRow } from './channelRows'
import { resolveChannels } from './channelRows'
import { SYNAPSE_SOCKETS } from './synapseParams'
import type { ModelRegionOptions, SomaMode } from './regions'
import {
  SOMA_REGION,
  filledRadius,
  modelRegions,
  refusedStrokes,
  staleStrokes,
} from './regions'

export interface ModelOptions {
  readonly preset: CellModelValue['preset']
  readonly membrane: CellModelValue['membrane']
  /** Membrane per µm² of reconstructed surface (`CellModelValue.areaFactor`); 1 = as reconstructed. */
  readonly areaFactor: number
  readonly rule: SegmentRule
  /**
   * What the regions are made of (`modelRegions`): the strokes, the soma's mode and size, and the
   * radius a node with none is given, nm. Passed whole, the Regions tab reading the same object.
   */
  readonly regions: ModelRegionOptions
  /** Moving-average window along each unbranched stretch, in nodes; 0 or 1 = off. */
  readonly smoothWindow: number
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

/** What depends on the skeleton alone: the re-rooted arbour, a stamped radius. */
interface Geometry {
  readonly arbor: Arbor
  readonly stamped: ReturnType<typeof stampedRadius>
  /** µm of cable on fragments that do not reach the soma. */
  readonly offCable: number
}

const GEOMETRY = new WeakMap<SkeletonGeometry, Geometry>()

function geometryOf(skeleton: SkeletonGeometry): Geometry {
  const hit = GEOMETRY.get(skeleton)
  if (hit) return hit
  // `splitArbor`'s default root and cache, so painting from it reuses this arbour, not a copy.
  const arbor = splitArbor(skeleton)
  let kept = 0
  for (const v of arbor.order) kept += arbor.edgeLength[v]!
  const geometry = {
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
  /** Per skeleton node, 1 where the model leaves it out: placed there, a point lands nowhere. */
  readonly ignored: Uint8Array
  readonly somaCompartment: number
  /**
   * Per skeleton node whose edge leaves the idealised soma (`fibreEdges`): where a point `t` down
   * that edge is along the cable's, `from + t · per` of it.
   */
  readonly fibres: ReadonlyMap<number, { readonly from: number; readonly per: number }>
}

const PLACERS = new WeakMap<CellModelValue, Placer>()

/** The compartment holding a point on the edge above skeleton node `v`, `t` of the way down. */
function compartmentOf(placer: Placer, v: number, t: number): number {
  if (placer.ignored[v]) return -1
  if (placer.somaSet[v]) return placer.somaCompartment
  const node = placer.cableIndex[v]!
  const fibre = placer.fibres.get(v)
  if (!fibre) return compartmentAt(placer.tree, node, t)
  // Inside the soma's radius is the soma's, as a point on a node it replaced is — never the
  // zero-area junction at its centre that `compartmentAt` answers there.
  const along = Math.min(1, Math.max(0, fibre.from + t * fibre.per))
  return along <= edgeShareAt(placer.tree, node)
    ? placer.somaCompartment
    : compartmentAt(placer.tree, node, along)
}

/**
 * Each fibre leaving an idealised soma, by its skeleton node: its skeleton edge runs from a node the
 * soma replaced — often several µm out — and its cable from the soma's centre, so a point `t` down
 * the first is the projection onto the second, `from + t · per` of it. Read as the cable's own `t`,
 * a point outside the soma landed in it wherever the replaced node was far from the centre.
 */
function fibreEdges(
  skeleton: SkeletonGeometry,
  arbor: Arbor,
  somaSet: Uint8Array,
  notCable: Uint8Array,
): Map<number, { from: number; per: number }> {
  const fibres = new Map<number, { from: number; per: number }>()
  const q = skeleton.positions
  const [cx, cy, cz] = positionOf(q, arbor.root)
  for (const v of arbor.order) {
    const p = arbor.parent[v]!
    if (p < 0 || notCable[v] || !somaSet[p]) continue
    const [px, py, pz] = positionOf(q, p)
    const [vx, vy, vz] = positionOf(q, v)
    const [ex, ey, ez] = [vx - cx, vy - cy, vz - cz]
    const square = ex * ex + ey * ey + ez * ez
    if (!(square > 0)) continue
    fibres.set(v, {
      from: ((px - cx) * ex + (py - cy) * ey + (pz - cz) * ez) / square,
      per: ((vx - px) * ex + (vy - py) * ey + (vz - pz) * ez) / square,
    })
  }
  return fibres
}

/**
 * A soma radius no neuron has: past it, a soma is a unit slip far more often than a cell. Fly somata
 * are a few µm across and the largest vertebrate ones about 100.
 */
export const MAX_SOMA_RADIUS_UM = 50

/** How to get an idealised soma of a size you choose, under either soma mode, ending in `what`. */
function somaRemedy(mode: SomaMode, what: string): string {
  return mode === 'replace'
    ? `Give a Soma diameter to ${what}`
    : `Set Soma to cut off and replace, and give a Soma diameter, to ${what}`
}

/**
 * The warning for a soma larger than any neuron's, or undefined. A soma millimetres across holds
 * nearly all of the membrane, so the cell's input resistance collapses and every injected current
 * moves it by a fraction of a millivolt — a model that looks passive and broken, and a Fit Model
 * that can only draw a flat line. For the card's `validate` and the build alike.
 */
export function oversizedSoma(
  diameter: number,
  /** The soma mode, where the diameter is the labelled node's; absent for a typed Soma diameter. */
  labelledUnder?: SomaMode,
): string | undefined {
  if (!(diameter / 2 > MAX_SOMA_RADIUS_UM)) return undefined
  const [what, remedy] =
    labelledUnder === undefined
      ? ['Soma diameter makes a soma', 'Is the diameter meant in µm?']
      : ['The soma the skeleton labels is', `${somaRemedy(labelledUnder, 'replace it')}.`]
  return (
    `${what} ${formatNumber(diameter)} µm across, larger than any neuron's (a fly's is a few µm). ` +
    `It holds nearly all of the membrane, so currents barely move the voltage. ${remedy}`
  )
}

/**
 * Each edge's compartments: the edge into node `v` runs `t` from 0 at its parent to 1 at `v`, and
 * is cut where a compartment ends (`edgeSpans`). Spans for `v` are `start[v]` to `start[v + 1]`,
 * each `(t0, t1, compartment, shade)`; the root has none.
 */
interface EdgeCompartments {
  readonly start: Int32Array
  readonly t0: Float32Array
  readonly t1: Float32Array
  readonly compartment: Int32Array
  /**
   * 0 or 1, alternating along each section and continuing into each child (`sectionParity`), so a
   * compartment differs from those before and after it; siblings meeting at a branch point can
   * share one, two shades not separating three. Compartment numbers cannot say it: each section
   * takes its segments and a junction, so a run of one-segment sections shares one parity.
   */
  readonly shade: Uint8Array
}

/**
 * The built model as the solver has it, to be drawn literally: its cable tree as a skeleton in nm,
 * rooted at node 0 — the soma's centre, where every neurite is wired, or the bare root without a
 * soma — with the soma section's two ends left out, the soma being drawn whole as what it is (a
 * cylinder as long as it is wide; `value.soma.diameter`). No node the soma replaced or the Regions
 * tab ignored is in it: they are no cable.
 */
export interface ModelCable {
  readonly skeleton: SkeletonGeometry
  /** Per node, the radius the edge into it has, nm: its ends' mean, from `edgeStartRadius`. */
  readonly edgeRadius: Float32Array
  /** Per node, the cable length of the edge into it, nm: what is inside a soma is no cable. */
  readonly edgeLength: Float32Array
  /**
   * Per node, the share of the edge into it inside the soma it starts in (`edgeShareAt`), 0 to 1:
   * where its first span begins. A drawing whose lengths are cable alone (λ) starts the edge there.
   */
  readonly edgeShare: Float32Array
  readonly edges: EdgeCompartments
  /**
   * Per compartment, what a hover says of it: µm of cable it covers, its mean diameter along that
   * cable (µm), and which segment of its section it is, of how many — 0, 0, -1, 0 for a junction,
   * which is no segment. A soma drawn whole (`value.soma.diameter`) covers no drawn cable.
   */
  readonly compartments: {
    readonly length: Float64Array
    readonly diameter: Float64Array
    readonly segment: Int32Array
    readonly of: Int32Array
  }
  /**
   * The compartments of a soma drawn whole: its sections' segments and the junctions at their ends
   * — what hovering the block stands for. Empty where the soma is not made (`value.soma.diameter`).
   */
  readonly somaCompartments: readonly number[]
}

/**
 * The compartment at `t` along the edge into `v` (`edges`' convention), or undefined where that is
 * no cable of the edge's own: inside the soma it starts in, or the root.
 */
export function cableCompartmentAt(
  cable: ModelCable,
  v: number,
  t: number,
): number | undefined {
  const { start, t0, t1, compartment } = cable.edges
  for (let k = start[v]!; k < start[v + 1]!; k++) {
    if (t < t0[k]!) return undefined
    if (t <= t1[k]!) return compartment[k]
  }
  return undefined
}

/** The cable tree as a built model was discretised from, until `modelCable` has read it. */
interface KeptCable {
  readonly positions: Float32Array
  readonly radii: Float32Array
  readonly parent: Int32Array
  readonly startRadius: Float32Array
  /** The soma section's two ends, beside its centre — what `cableTree` adds the soma as. */
  readonly somaEnds: readonly number[]
}

/**
 * Each section's starting shade, 0 or 1: its parent's flipped past the parent's segments, so a
 * child's first compartment always differs from its parent's last — whatever either's `nseg`.
 * Sections are listed parents first.
 */
function sectionParity(tree: Pick<PlacingTree, 'sections'>): Uint8Array {
  const parity = new Uint8Array(tree.sections.length)
  tree.sections.forEach((sec, i) => {
    const p = sec.parentSection
    if (p >= 0) parity[i] = (parity[p]! + tree.sections[p]!.nseg) % 2
  })
  return parity
}

const CABLES = new WeakMap<CellModelValue, KeptCable>()
const MODEL_CABLES = new WeakMap<CellModelValue, ModelCable>()

export function modelCable(value: CellModelValue): ModelCable | undefined {
  const hit = MODEL_CABLES.get(value)
  if (hit) return hit
  const placer = PLACERS.get(value)
  const cable = CABLES.get(value)
  if (!placer || !cable) return undefined
  const { tree } = placer
  const count = cable.parent.length
  const keep = new Int32Array(count).fill(-1)
  let kept = 0
  for (let c = 0; c < count; c++) if (!cable.somaEnds.includes(c)) keep[c] = kept++
  const from = new Int32Array(kept)
  for (let c = 0; c < count; c++) if (keep[c]! >= 0) from[keep[c]!] = c
  const parents = Int32Array.from(from, (c) => keep[cable.parent[c]!] ?? -1)
  const positions = new Float32Array(kept * 3)
  const radii = new Float32Array(kept)
  const edgeRadius = new Float32Array(kept)
  const edgeLength = new Float32Array(kept)
  const edgeShare = new Float32Array(kept)
  const parity = sectionParity(tree)
  const start = new Int32Array(kept + 1)
  const t0: number[] = []
  const t1: number[] = []
  const compartment: number[] = []
  const shade: number[] = []
  const counted = value.compartments.count
  const segmentLength = new Float64Array(counted)
  const across = new Float64Array(counted)
  const segment = new Int32Array(counted).fill(-1)
  const of = new Int32Array(counted)
  tree.sections.forEach(({ first, nseg }) => {
    for (let k = 0; k < nseg; k++) {
      segment[first + k] = k
      of[first + k] = nseg
    }
  })
  const soma = new Set<number>()
  for (const { nodes, first, nseg } of tree.sections) {
    if (!nodes.some((n) => cable.somaEnds.includes(n))) continue
    soma.add(tree.parent[first]!)
    for (let k = 0; k <= nseg; k++) soma.add(first + k)
  }
  from.forEach((c, v) => {
    for (let k = 0; k < 3; k++) positions[v * 3 + k] = cable.positions[c * 3 + k]! * NM_PER_UM
    radii[v] = cable.radii[c]! * NM_PER_UM
    start[v] = compartment.length
    if (parents[v]! < 0) return
    const p = cable.parent[c]!
    edgeRadius[v] = ((edgeStartRadius(cable, c) + cable.radii[c]!) / 2) * NM_PER_UM
    const length = Math.hypot(
      cable.positions[c * 3]! - cable.positions[p * 3]!,
      cable.positions[c * 3 + 1]! - cable.positions[p * 3 + 1]!,
      cable.positions[c * 3 + 2]! - cable.positions[p * 3 + 2]!,
    )
    const share = edgeShareAt(tree, c)
    edgeShare[v] = share
    edgeLength[v] = length * (1 - share) * NM_PER_UM
    const s = tree.nodeSection[c]!
    for (const span of edgeSpans(tree, c)) {
      t0.push(span.t0)
      t1.push(span.t1)
      compartment.push(span.compartment)
      shade.push((span.segment + parity[s]!) % 2)
      const piece = (span.t1 - span.t0) * length
      segmentLength[span.compartment]! += piece
      across[span.compartment]! += piece * 2 * (edgeRadius[v]! / NM_PER_UM)
    }
  })
  start[kept] = compartment.length
  const out: ModelCable = {
    skeleton: { id: value.skeleton.id, positions, radii, parents },
    edgeRadius,
    edgeLength,
    edgeShare,
    edges: {
      start,
      t0: Float32Array.from(t0),
      t1: Float32Array.from(t1),
      compartment: Int32Array.from(compartment),
      shade: Uint8Array.from(shade),
    },
    compartments: {
      length: segmentLength,
      diameter: across.map((d, c) => (segmentLength[c]! > 0 ? d / segmentLength[c]! : 0)),
      segment,
      of,
    },
    somaCompartments: [...soma].sort((a, b) => a - b),
  }
  MODEL_CABLES.set(value, out)
  CABLES.delete(value)
  return out
}

/**
 * `to`, a model made from the built `from` on the same cable — Fit Model's, another membrane on it —
 * registered as placing points and drawing as `from` does: both are the cable's, which a membrane
 * does not move. Without it `placePoints` refuses the derived model as one never built.
 */
export function onSameCable(from: CellModelValue, to: CellModelValue): CellModelValue {
  const placer = PLACERS.get(from)
  if (placer) PLACERS.set(to, placer)
  const drawn = MODEL_CABLES.get(from)
  if (drawn) MODEL_CABLES.set(to, drawn)
  const kept = CABLES.get(from)
  if (kept) CABLES.set(to, kept)
  return to
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
  const { arbor, stamped, offCable } = geometryOf(skeleton)
  const rootNode = arbor.root
  if (arbor.unreached > 0) {
    notes.push(
      `${plural(arbor.unreached, 'node')} (${formatNumber(Math.round(offCable))} µm of cable) ` +
        `${agree(arbor.unreached, 'is', 'are')} on fragments that do not reach the soma, and ` +
        `${leftOut(arbor.unreached)}: nothing there can affect it.`,
    )
  }
  // The regions the model is built with — what the soma replaces, what is ignored — the one
  // statement the Regions tab draws as well (`modelRegions`), so the picture is the model.
  const regions = modelRegions(skeleton, options.regions)
  const { somaMode, defaultRadius } = options.regions
  const { somaSet, ignored, notCable, source, somaDiameter } = regions
  if (regions.stale > 0) notes.push(staleStrokes(regions.stale))
  if (regions.refused > 0) notes.push(refusedStrokes(regions.refused))

  // 4. Radii: fill, note a stamped floor, smooth.
  const radius = new Float64Array(n)
  let filled = 0
  for (const v of arbor.order) {
    if (ignored[v]) continue
    const own = filledRadius(skeleton.radii[v]!, 0)
    radius[v] = own || defaultRadius
    if (!own) filled++
  }
  if (filled > 0) {
    // Out of the nodes kept: an ignored branch's radii are never read, so it is no denominator.
    notes.push(
      `${formatNumber(filled)} of ${plural(arbor.order.length - regions.ignoredCount, 'node')} had no radius and ` +
        `${agree(filled, 'was', 'were')} given ${formatNumber(defaultRadius)} nm.`,
    )
  }
  if (stamped) {
    notes.push(
      `${Math.round(stamped.share * 100)}% of radii are ${formatNumber(stamped.radius)} nm — a ` +
        'skeletonisation floor rather than a measurement, so thin twigs carry more membrane and ' +
        'less axial resistance than they have.',
    )
  }
  // 5. The soma: an idealised section where one is made (`modelRegions` says which nodes it
  // replaces), its diameter read before any smoothing, which would thin it towards its neurite's.
  if (somaDiameter > 0 && source === 'labelled' && regions.labelledUnmeasured) {
    notes.push(
      `The labelled soma has no radius, so it is ${formatNumber(somaDiameter)} µm across, from ` +
        'Default radius. Give a Soma diameter.',
    )
  }
  // A typed diameter is the card's `validate` to say, before any run; a labelled one only shows here.
  const oversized =
    source === 'labelled' ? oversizedSoma(regions.labelledDiameter, somaMode) : undefined
  if (oversized) notes.push(oversized)
  if (source === 'root') {
    notes.push(
      'No soma is labelled on this skeleton, so its root stands in: a point with no membrane of ' +
        'its own, joined to thin cable. A clamp or recording "at the soma" is at that point. ' +
        `${somaRemedy(somaMode, 'add one')}.`,
    )
  }

  // Smoothed only now, and never across the soma: averaging it with its fibre would thin the soma
  // and thicken the fibre's start, the shoulder `startRadius` exists to prevent.
  if (options.smoothWindow > 1)
    smoothAlongStretches(arbor, radius, options.smoothWindow, notCable)

  // An added soma is no node's, so it is soma whatever its root was labelled or painted.
  const somaRegion = source === 'added' ? SOMA_REGION : regions.label[rootNode]!
  const cable = cableTree(
    skeleton,
    arbor,
    radius,
    regions.label,
    somaSet,
    notCable,
    somaDiameter,
    somaRegion,
  )
  // Extra membrane is extra capacitance per unit length, so d_lambda cuts for it, as NEURON's does
  // where a spine factor is folded into cm.
  const { areaFactor } = options
  const tree = discretize(cable.tree, {
    rule: options.rule,
    ra: options.membrane.ra,
    cm: options.membrane.cm * areaFactor,
  })
  const area = areaFactor === 1 ? tree.area : tree.area.map((a) => a * areaFactor)
  // A cable with no membrane anywhere has nothing to integrate — a lone root, with no soma
  // diameter given — and every trace would come back NaN rather than an answer. (The bare root of
  // an ordinary cable has none of its own, and is held up by the cable around it.)
  if (!tree.area.some((a) => a > 0)) {
    throw new Error(
      'This skeleton has no cable to model: a single node, with no soma to give it membrane. ' +
        `${somaRemedy(somaMode, 'add one')}.`,
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
    if (ignored[v]) continue
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
    ignored,
    somaCompartment,
    fibres: cable.somaCentre >= 0 ? fibreEdges(skeleton, arbor, somaSet, notCable) : new Map(),
  }

  // 6. Synapses.
  const synapses = placeSynapses(sockets, neuronId, skeleton, placer, options.maxSnap, notes)

  const channels = resolveChannels(
    options.channels,
    { regionNames: regions.names, region: tree.region, area },
    notes,
    somaRemedy(somaMode, 'add one'),
  )

  const value: CellModelValue = {
    kind: 'cellModel',
    neuronId,
    compartments: {
      count: tree.count,
      parent: tree.parent,
      area,
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
      ...(somaDiameter > 0 ? { diameter: somaDiameter } : {}),
    },
    membrane: options.membrane,
    ...(areaFactor !== 1 ? { areaFactor } : {}),
    channels,
    ...(channels.length > 0 ? { temperature: options.temperature } : {}),
    synapseTypes: SYNAPSE_SOCKETS.map(({ sign }) => options[sign]),
    ...synapses,
    preset: options.preset,
    notes,
  }
  PLACERS.set(value, placer)
  // What the Model tab draws the model from, trimmed to what `modelCable` reads; dropped once it has.
  CABLES.set(value, {
    positions: Float32Array.from(cable.tree.positions),
    radii: Float32Array.from(cable.tree.radii),
    parent: cable.tree.parent,
    startRadius: Float32Array.from(cable.tree.startRadius ?? []),
    somaEnds: cable.somaEnds,
  })
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
  /** Nodes left out — the soma, ignored branches — so a stretch starts below them and stops above. */
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
      // Nor into a node left out — an ignored branch's radii were never filled, and are 0.
      const next = arbor.childList[arbor.childStart[v]!]!
      if (skip[next]) break
      v = next
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
  /** Nodes that are no cable of their own: the soma's, and those left out of the model. */
  notCable: Uint8Array,
  somaDiameter: number,
  /** The soma section's region: its node's, or soma for an added one. */
  somaRegion: number,
): { tree: CableTree; index: Int32Array; somaCentre: number; somaEnds: readonly number[] } {
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
  const startOffset = new Float64Array(size)
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
  let somaEnds: readonly number[] = []
  if (somaDiameter > 0) {
    // Along the first fibre leaving the soma, so a drawing of it points the way the neuron does —
    // the first one not sitting on the soma node, or a duplicated node gives no direction.
    const [x0, y0, z0] = positionOf(q, root)
    const fibre = arbor.order.find((v) => {
      if (notCable[v]) return false
      const [x, y, z] = positionOf(q, v)
      return x !== x0 || y !== y0 || z !== z0
    })
    const [fx, fy, fz] = fibre === undefined ? [x0 + 1, y0, z0] : positionOf(q, fibre)
    const half = (somaDiameter * NM_PER_UM) / 2 / (Math.hypot(fx - x0, fy - y0, fz - z0) || 1)
    const [dx, dy, dz] = [(fx - x0) * half, (fy - y0) * half, (fz - z0) * half]
    const r = somaDiameter / 2
    const start = add(x0 - dx, y0 - dy, z0 - dz, r, -1, somaRegion)
    somaCentre = add(x0, y0, z0, r, start, somaRegion)
    somaEnds = [start, add(x0 + dx, y0 + dy, z0 + dz, r, somaCentre, somaRegion)]
  }

  for (const v of arbor.order) {
    if (notCable[v]) continue
    const p = arbor.parent[v]!
    const r = radius[v]! / NM_PER_UM
    const fromSoma = somaCentre >= 0 && (p < 0 || somaSet[p] === 1)
    const above = fromSoma ? somaCentre : p < 0 ? -1 : index[p]!
    index[v] = add(q[v * 3]!, q[v * 3 + 1]!, q[v * 3 + 2]!, r, above, label[v]!)
    // A fibre leaving the soma starts at its own radius, not the soma's.
    if (fromSoma) {
      startRadius[index[v]!] = r
      // And at the soma's surface: the stretch from its centre is the soma's own membrane.
      startOffset[index[v]!] = somaDiameter / 2
    }
  }
  return {
    tree: {
      positions: positions.subarray(0, count * 3),
      radii: radii.subarray(0, count),
      parent: parent.subarray(0, count),
      labels: labels.subarray(0, count),
      startRadius: startRadius.subarray(0, count),
      startOffset: startOffset.subarray(0, count),
    },
    index,
    somaCentre,
    somaEnds,
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
    let onIgnored = 0
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
      if (placer.ignored[v]) {
        onIgnored++
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
    if (onIgnored > 0) {
      say(
        `${plural(onIgnored, 'synapse')} ${agree(onIgnored, 'lies', 'lie')} on branches painted ` +
          `ignored and ${leftOut(onIgnored)}.`,
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
