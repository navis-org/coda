/**
 * A compartment model's regions: the names channels are placed on (`channelRows.ts`). They start as
 * the skeleton's own labels (`regionLabels`) and can be **painted** in the Compartment Model's
 * Regions tab, the Axon/Dendrite Split editor's gesture: everything distal of a point, or everything
 * else, becomes a named region (`RegionStroke`).
 *
 * Strokes are applied in order and a later one paints over an earlier one and over the skeleton's
 * labels, so every node ends in exactly one region and regions never overlap — an initiation zone
 * between two points is "distal of A → SIZ", then "distal of B → axon". Anchored by position, with
 * the root each was made against, as split corrections are (`paintSubtrees`), so a re-fetch that
 * renumbers nodes keeps them; one that lands nowhere is counted on the card.
 *
 * **Two regions shape the model, not only its channels** (`modelRegions`, the one statement the
 * build and the Regions tab both read): under "cut off and replace" the `soma` painted around the
 * soma node is what the idealised soma replaces — starting from the skeleton's taper (`somaNodes`)
 * and adjusted by strokes — and `ignored` leaves its subtree out of the model altogether.
 */

import type { CellModelValue, SkeletonGeometry } from '../../core/values'
import { SWC_SOMA, compartmentKey, compartmentName } from '../../core/values'
import { widestSomaNode } from '../../data/soma'
import { NM_PER_UM } from '../../data/units'
import type { Arbor } from '../../nodes/lib/arborOps'
import type { StoredStroke } from '../../nodes/lib/splitCorrections'
import {
  CORRECTION_SCOPES,
  SCOPE_WORDS,
  fillScope,
  placeStroke,
  readStrokes,
  splitArbor,
} from '../../nodes/lib/splitCorrections'
import { positionOf } from '../../nodes/lib/anchors'
import { agree, plural } from '../../style/format'
import { UNLABELLED_REGION, isNameableRegion } from './channelRows'

/** The param the Regions tab writes: one `RegionStroke` as JSON per entry, in order. */
export const REGIONS_PARAM = 'paintedRegions'

/**
 * Which nodes a stroke paints: the split's two subtree scopes, and `upTo` — the path from the soma
 * out to the clicked node with the dead ends no farther out than it, which is how a cell body is
 * outlined, one click per neurite leaving it.
 */
export const REGION_SCOPES = [...CORRECTION_SCOPES, 'upTo'] as const
export type RegionScope = (typeof REGION_SCOPES)[number]

export const REGION_SCOPE_WORDS: Readonly<Record<RegionScope, string>> = {
  ...SCOPE_WORDS,
  upTo: 'From the soma to here',
}

export interface RegionStroke extends StoredStroke<RegionScope> {
  /** The region it paints: a new name, or one the model already has (`axon` restores it); `''` ignoring. */
  readonly region: string
  /**
   * Leaves what it paints out of the model, rather than naming it — a flag and never a region name,
   * since any name could be one somebody already gave a region. A build without the flag reads the
   * stroke's empty region as malformed and drops it, rather than painting a region.
   */
  readonly ignore?: true
  /** The root "distal" was measured from, nm: always stored, the editor drawing from one. */
  readonly root: readonly [number, number, number]
}

export function writeRegionStroke(stroke: RegionStroke): string {
  return JSON.stringify(stroke)
}

/**
 * The stored strokes, anything malformed dropped — a hand-edited file's stray entry included, and
 * one painting `unlabelled`, which no channel row can name.
 */
export function readRegionStrokes(raw: unknown): RegionStroke[] {
  return readStrokes(
    raw,
    (stroke, { region, ignore }) => {
      const { root } = stroke
      if (!root) return undefined
      if (ignore === true) return { ...stroke, root, region: '', ignore: true }
      const name = typeof region === 'string' ? region.trim() : ''
      return isNameableRegion(name) ? { ...stroke, root, region: name } : undefined
    },
    REGION_SCOPES,
  )
}

/** What an ignoring stroke is called where a region's name would be: the list, the key. */
export const IGNORED_LABEL = 'ignored'

/** The code an ignoring stroke paints: in no region, so no index into any names table. */
const IGNORE_CODE = -1

/** The card's and the Regions tab's sentence for strokes that would ignore the soma itself. */
export function refusedStrokes(n: number): string {
  return (
    `${plural(n, 'stroke')} would ignore the soma, and with it the whole model, ` +
    `and ${agree(n, 'is', 'are')} not applied. Ignore a branch away from the soma.`
  )
}

/** The card's and the Regions tab's one sentence for strokes that land on no node. */
export function staleStrokes(n: number): string {
  return (
    `${plural(n, 'painted stroke')} ${agree(n, 'lands', 'land')} on no node of this skeleton ` +
    `and ${agree(n, 'is', 'are')} not applied.`
  )
}

/** The region every soma is, whatever labelled it: index 1 of every model's names. */
export const SOMA_REGION = 1

/**
 * A region per node as an index into a names table of the model's own — `unlabelled` at 0, the
 * soma at 1, then each other region the skeleton has, by name. Named by `compartmentKey`, the one
 * reading of a label in either vocabulary: a computed split (`split`, the Axon/Dendrite Split's
 * axon, dendrite and linker) where there is one, else the source's SWC codes, basal and apical both
 * `dendrite`. So a channel placed on `axon` means the same wherever the labels came from. The soma
 * is the source's own label either way, a split having none; a code neither vocabulary has keeps
 * its SWC name.
 */
/**
 * Kept per skeleton: it depends on nothing else, and the Compartment Model, a `cheap` node, asks on
 * every edit — as does its Regions tab. Callers read it and never write it; `modelRegions` copies
 * before painting.
 */
const LABELS = new WeakMap<SkeletonGeometry, { label: Int32Array; names: string[] }>()

export function regionLabels(skeleton: SkeletonGeometry): {
  label: Int32Array
  names: string[]
} {
  const hit = LABELS.get(skeleton)
  if (hit) return hit
  const labels = labelRegions(skeleton)
  LABELS.set(skeleton, labels)
  return labels
}

function labelRegions(skeleton: SkeletonGeometry): {
  label: Int32Array
  names: string[]
} {
  const names = [UNLABELLED_REGION, 'soma']
  const index = new Map<string, number>([['soma', SOMA_REGION]])
  const n = skeleton.parents.length
  const label = new Int32Array(n)
  const { compartments: codes, split } = skeleton
  for (let v = 0; v < n; v++) {
    const code = codes?.[v] ?? 0
    const name =
      code === SWC_SOMA
        ? 'soma'
        : split
          ? compartmentKey(split[v]!, true)
          : code > 0
            ? (compartmentKey(code, false) ?? compartmentName(code) ?? `swc ${code}`)
            : undefined
    if (!name) continue
    let i = index.get(name)
    if (i === undefined) {
      i = names.length
      index.set(name, i)
      names.push(name)
    }
    label[v] = i
  }
  return { label, names }
}

/**
 * This neuron's strokes painted over `base`, in order: per node an index into `names`, a stroke's
 * new region added to the table where it first lands. `stale` counts the strokes that landed
 * nowhere, `refused` those that would ignore the soma node (`soma`, the root the model is built
 * from), which are not applied. Writes into `base.label`, which the caller owns.
 */
function paintStrokes(
  skeleton: SkeletonGeometry,
  strokes: readonly RegionStroke[],
  base: { label: Int32Array; names: readonly string[] },
  soma: number,
): { label: Int32Array; names: string[]; stale: number; refused: number } {
  const { label } = base
  const names = [...base.names]
  let stale = 0
  let refused = 0
  for (const s of strokes) {
    const placed = placeStroke(skeleton, s.at, s.root)
    if (!placed) {
      stale++
      continue
    }
    if (s.ignore && covers(placed, s.scope, soma)) {
      refused++
      continue
    }
    // A name joins the table only where its stroke lands, so a stale one names no empty region.
    let code = IGNORE_CODE
    if (!s.ignore) {
      code = names.indexOf(s.region)
      if (code < 0) code = names.push(s.region) - 1
    }
    const { arbor, node } = placed
    if (s.scope === 'upTo') paintUpTo(arbor, skeleton.positions, node, code, label)
    else fillScope(arbor, node, s.scope, code, label)
  }
  return { label, names, stale, refused }
}

/** Whether a stroke placed at `node` would paint `soma`: asked of the pre-order, before painting. */
function covers(
  placed: { arbor: Arbor; node: number },
  scope: RegionScope,
  soma: number,
): boolean {
  const { tin, tout } = placed.arbor
  const at = tin[soma]!
  if (at < 0) return false
  const below = (v: number) => tin[v]! <= at && at < tout[v]!
  // `upTo` paints the path from its root, so the soma whenever it is on that path.
  if (scope === 'upTo') return tin[placed.node]! >= at && tin[placed.node]! < tout[soma]!
  return scope === 'distal' ? below(placed.node) : !below(placed.node)
}

/**
 * `upTo`: the path from the root out to `node`, and every branch leaving that path that ends no
 * farther from the root than `node` is — the twigs a skeletoniser leaves inside a cell body, which
 * die before the neurite the click was on gets anywhere. Distances are straight-line, from the root.
 */
function paintUpTo(
  arbor: Arbor,
  positions: Float32Array,
  node: number,
  code: number,
  label: Int32Array,
): void {
  const reach = distanceFrom(positions, arbor.root)(node)
  const onPath = new Uint8Array(label.length)
  for (let v = node; v >= 0; v = arbor.parent[v]!) onPath[v] = 1
  const farthest = farthestBelow(arbor, positions)
  // Pre-order, so a branch's root is decided before its nodes: taken whole or not at all.
  const taken = new Uint8Array(label.length)
  for (const v of arbor.order) {
    const p = arbor.parent[v]!
    if (onPath[v] || (p >= 0 && (taken[p] || (onPath[p] && farthest[v]! <= reach)))) {
      if (!onPath[v]) taken[v] = 1
      label[v] = code
    }
  }
}

/** Straight-line distance from node `origin`, in the skeleton's units. */
function distanceFrom(positions: Float32Array, origin: number) {
  const [x, y, z] = positionOf(positions, origin)
  return (v: number) =>
    Math.hypot(positions[v * 3]! - x, positions[v * 3 + 1]! - y, positions[v * 3 + 2]! - z)
}

/** Kept per arbour: a property of it and its root alone, asked again by every `upTo` stroke. */
const FARTHEST = new WeakMap<Arbor, Float64Array>()

/** Per reached node, the farthest any node of its subtree is from the root: children after parents. */
function farthestBelow(arbor: Arbor, positions: Float32Array): Float64Array {
  const hit = FARTHEST.get(arbor)
  if (hit) return hit
  const { order, parent } = arbor
  const from = distanceFrom(positions, arbor.root)
  const farthest = new Float64Array(parent.length)
  for (let k = order.length - 1; k >= 0; k--) {
    const v = order[k]!
    farthest[v] = Math.max(farthest[v]!, from(v))
    if (parent[v]! >= 0) farthest[parent[v]!] = Math.max(farthest[parent[v]!]!, farthest[v]!)
  }
  FARTHEST.set(arbor, farthest)
  return farthest
}

/** How far the soma reaches from its centre, in soma radii: past it nothing is soma. */
const SOMA_REACH = 3
/** A node at least this share of the soma's radius is still soma: the skeleton's own taper. */
const SOMA_TAPER = 0.5

/** A node's radius, nm, as every reader takes it: an unmeasured one (0, NaN, negative) is `fallback`. */
export function filledRadius(r: number, fallback: number): number {
  return Number.isFinite(r) && r > 0 ? r : fallback
}

/**
 * Where the soma starts, before any stroke: the nodes an idealised soma replaces when nobody has
 * painted it. An EM skeleton labels one node "soma", near the nucleus; its neighbours are soma too,
 * at nearly its radius, and skeletonisation leaves short side branches inside the cell body. Kept
 * as cable they are a second soma beside the idealised one — on MaleCNS 10075, 190 µm² of membrane
 * within 1.5 soma radii against the soma's 108 — so the soma takes, from its centre outwards:
 *
 * - **the taper**: every node connected to it through nodes at least `SOMA_TAPER` of its radius,
 *   up to `SOMA_REACH` radii out (or labelled soma, at any distance);
 * - **dead ends**: every branch leaving that region that ends without ever reaching `SOMA_REACH`
 *   radii from the centre. The cell body fibre leaves the soma and goes on, so it is never one.
 */
function somaNodes(
  skeleton: SkeletonGeometry,
  arbor: Arbor,
  label: ArrayLike<number>,
  somaRadius: number,
  defaultRadius: number,
): Uint8Array {
  const { root, order, parent } = arbor
  const reach = SOMA_REACH * somaRadius
  const from = distanceFrom(skeleton.positions, root)
  const set = new Uint8Array(parent.length)
  set[root] = 1
  for (const v of order) {
    if (v === root || !set[parent[v]!]) continue
    const radius = filledRadius(skeleton.radii[v]!, defaultRadius)
    if (label[v] === SOMA_REGION || (radius >= SOMA_TAPER * somaRadius && from(v) <= reach))
      set[v] = 1
  }
  const farthest = farthestBelow(arbor, skeleton.positions)
  for (const v of order) {
    if (!set[v] && set[parent[v]!] && farthest[v]! <= reach) set[v] = 1
  }
  return set
}

/** Whether the soma is cut off the skeleton and an idealised one put in, or the skeleton kept. */
export type SomaMode = 'replace' | 'asIs'

export interface ModelRegionOptions {
  readonly strokes: readonly RegionStroke[]
  readonly somaMode: SomaMode
  /** µm, the card's; 0 takes the labelled soma's own radius. Read only when replacing. */
  readonly somaDiameter: number
  /** nm, for a node with no radius: what the taper reads it as. */
  readonly defaultRadius: number
}

/**
 * The Compartment Model's params as `modelRegions` takes them — read here once, for the build and
 * the Regions tab alike, or the two read one card two ways.
 */
export function regionOptions(
  params: Readonly<Record<string, unknown>>,
  strokes: readonly RegionStroke[],
): ModelRegionOptions {
  // Read plainly: every caller's params are `withDefaults`', so an old graph reads the declared default.
  return {
    strokes,
    somaMode: params.somaMode as SomaMode,
    somaDiameter: Number(params.somaDiameter),
    defaultRadius: Number(params.defaultRadius),
  }
}

export interface ModelRegions {
  /** Per node, an index into `names`: the skeleton's labels, the soma's start, then the strokes. */
  readonly label: Int32Array
  /** The regions, `ignored` never among them: an ignored node is in no region, being in no model. */
  readonly names: string[]
  readonly stale: number
  readonly refused: number
  /** Per node, 1 where the idealised soma replaces it — its own node included; none kept as is. */
  readonly somaSet: Uint8Array
  /** Per node, 1 where it is left out of the model: painted `ignored`, or below a node that is. */
  readonly ignored: Uint8Array
  /** Per node, 1 where it is no cable of its own: replaced by the soma, or ignored. */
  readonly notCable: Uint8Array
  readonly replacedCount: number
  readonly ignoredCount: number
  /** µm across the idealised soma; 0 where none is made. */
  readonly somaDiameter: number
  /** µm across the labelled soma node, whatever the mode; 0 where none is labelled. */
  readonly labelledDiameter: number
  /** Whether that node had no radius, its diameter coming from Default radius. */
  readonly labelledUnmeasured: boolean
  readonly source: CellModelValue['soma']['source']
}

/** Kept per skeleton: the last answer, since the build and the Regions tab ask the same question. */
const REGIONS = new WeakMap<SkeletonGeometry, { key: string; regions: ModelRegions }>()
/** And where the soma starts, which no stroke moves: asked again on every stroke. */
const STARTS = new WeakMap<SkeletonGeometry, { key: string; label: Int32Array }>()

/**
 * The regions a model is built with and the Regions tab draws — one statement for both, or the
 * picture and the model part ways. Starting from the skeleton's own labels; when replacing the
 * soma, with the taper (`somaNodes`) painted `soma` on top; then this neuron's strokes. The soma
 * the idealised one replaces is the `soma` painted **connected to the soma node**: a soma-painted
 * patch elsewhere is soma membrane for channels and stays cable. Read-only to every caller.
 */
export function modelRegions(skeleton: SkeletonGeometry, o: ModelRegionOptions): ModelRegions {
  const strokes = o.strokes.filter((s) => s.neuron === skeleton.id)
  const key = JSON.stringify([strokes, o.somaMode, o.somaDiameter, o.defaultRadius])
  const hit = REGIONS.get(skeleton)
  if (hit?.key === key) return hit.regions
  const regions = computeRegions(skeleton, { ...o, strokes })
  REGIONS.set(skeleton, { key, regions })
  return regions
}

function computeRegions(skeleton: SkeletonGeometry, o: ModelRegionOptions): ModelRegions {
  // `splitArbor`'s default root and cache: the build's arbour, the soma node at its root.
  const arbor = splitArbor(skeleton)
  const { root, order, parent } = arbor
  const labelled = widestSomaNode(skeleton) >= 0
  const rootRadius = filledRadius(skeleton.radii[root]!, o.defaultRadius)
  const labelledDiameter = labelled ? (2 * rootRadius) / NM_PER_UM : 0
  const replacing = o.somaMode === 'replace'
  const source: ModelRegions['source'] =
    replacing && o.somaDiameter > 0 ? 'added' : labelled ? 'labelled' : 'root'
  const somaDiameter = !replacing ? 0 : source === 'added' ? o.somaDiameter : labelledDiameter

  const own = regionLabels(skeleton)
  const label = (
    somaDiameter > 0 ? somaStart(skeleton, arbor, somaDiameter, o.defaultRadius) : own.label
  ).slice()
  const painted = paintStrokes(skeleton, o.strokes, { label, names: own.names }, root)

  const { names } = painted
  const ignored = new Uint8Array(parent.length)
  const somaSet = new Uint8Array(parent.length)
  const notCable = new Uint8Array(parent.length)
  let replacedCount = 0
  let ignoredCount = 0
  if (somaDiameter > 0) {
    somaSet[root] = notCable[root] = 1
    replacedCount = 1
  }
  for (const v of order) {
    const code = label[v]!
    if (v !== root) {
      const p = parent[v]!
      if (ignored[p] || code === IGNORE_CODE) {
        ignored[v] = notCable[v] = 1
        ignoredCount++
      } else if (somaSet[p] && code === SOMA_REGION) {
        somaSet[v] = notCable[v] = 1
        replacedCount++
      }
    }
  }
  // An ignored node is in no region; every node, a fragment the walk never reached included.
  for (let v = 0; v < label.length; v++) if (label[v] === IGNORE_CODE) label[v] = 0
  return {
    label,
    names,
    stale: painted.stale,
    refused: painted.refused,
    somaSet,
    ignored,
    notCable,
    replacedCount,
    ignoredCount,
    somaDiameter,
    labelledDiameter,
    labelledUnmeasured: labelled && !(filledRadius(skeleton.radii[root]!, 0) > 0),
    source,
  }
}

/** The skeleton's labels with the taper painted `soma`: kept per skeleton and soma size. */
function somaStart(
  skeleton: SkeletonGeometry,
  arbor: Arbor,
  somaDiameter: number,
  defaultRadius: number,
): Int32Array {
  const key = `${somaDiameter} ${defaultRadius}`
  const hit = STARTS.get(skeleton)
  if (hit?.key === key) return hit.label
  const own = regionLabels(skeleton)
  const start = somaNodes(
    skeleton,
    arbor,
    own.label,
    (somaDiameter * NM_PER_UM) / 2,
    defaultRadius,
  )
  const label = own.label.slice()
  for (const v of arbor.order) if (start[v]) label[v] = SOMA_REGION
  STARTS.set(skeleton, { key, label })
  return label
}
