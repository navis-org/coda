/**
 * Skeleton to Points: a skeleton's cable as a point cloud, one row per piece of it.
 *
 * **What a row stands for is the whole design.** Anything downstream that *counts rows* — Laminar
 * Profile, Group By's `n`, a histogram — is otherwise counting how finely each neurite happened to
 * be traced, and node density varies tenfold within one neuron. So the default cuts every
 * unbranched run into equal pieces no longer than `Spacing` and puts one point at each piece's
 * midpoint, and every point carries a `cable` column saying exactly how much it stands for.
 *
 * Two properties follow and both are deliberate:
 *
 * - **Summing `cable` is exact** — it adds back up to the skeleton's cable length, per neuron, per
 *   layer, per region — because a piece never straddles a branch point and its length is its own,
 *   not a nominal `Spacing`.
 * - **Counting rows is exact only to within one per run.** A run is cut into `ceil(L / Spacing)`
 *   pieces so that no point stands for more than `Spacing`; a twig shorter than that still gets
 *   one. At 1 µm on a traced arbour that is noise, at 20 µm a twiggy arbour's tips are counted
 *   heavier than its trunk. The `cable` column is the answer to that, not a finer rule here: a
 *   placement that drops short twigs to keep counts even makes the sum wrong instead.
 *
 * `nodes` keeps the skeleton's own nodes and weights each by `samplesOf`'s half-edge weights, the
 * Distance node's, so `cable` still sums to the cable.
 *
 * **`manual` is points somebody placed**, in the expanded view, and the one placement that samples
 * nothing: its `cable` is **null**, because a number there would enter a sum that the other
 * placements make exact. Each is stored as a position in the skeleton's frame, per neuron — never a
 * node index, which a re-fetch may renumber — and placed again on whatever skeleton arrives, onto
 * the nearest point of its cable (`projectSynapses`, as a synapse is placed). One further than
 * `SNAP_NM` is **stale**: counted and kept, never moved to whatever is nearest
 * (`splitCorrections.ts`' rule). Its other columns are read at that point as `resample` reads its
 * midpoints: the radius and root distance interpolated along the edge, the label and order the
 * edge's child's. A point can be named in the editor, and `manual` alone adds that `name` column
 * (null where unnamed): a label for Simulate's traces, or — as a Compartment Model's Presynaptic
 * column — a partner, every point of one name firing together.
 *
 * **Compartments are the source's, never inferred** (`SkeletonGeometry.compartments`). A point on
 * an edge takes the label of the edge's child node, SWC's convention for which segment a code
 * describes. A skeleton the source did not label gives nulls, and the node counts them.
 *
 * **Sized before it is built.** The count is exact and cheap once a skeleton's run lengths are
 * known, so the output columns are allocated once and every point is written into them in place.
 * The per-node walks (tree, Strahler, root distance) are built per skeleton while it is written and
 * dropped, so at most one skeleton's worth is alive beside the result.
 *
 * Schema and value halves sit side by side (invariant 3), and `skeletonPoints.test.ts` holds them
 * against each other.
 */

import { ID_COLUMN_NAME, idText } from '../../core/ids'
import type { Slicer } from '../../core/slice'
import { sliced } from '../../core/slice'
import type { ColumnSchema, TableSchema } from '../../core/types'
import { column, pickColumns, tableSchema } from '../../core/types'
import type {
  CellValue,
  SkeletonGeometry,
  SkeletonsValue,
  PointsValue,
} from '../../core/values'
import { boundsOf, compartmentName, makeTable } from '../../core/values'
import { samplesOf } from './geometryDistance'
import { NM_PER_UM } from '../../data/units'
import { foldColumns } from './tableOps'
import type { SkeletonTree } from './topologyOps'
import { parentDistances, rootDistances, skeletonTree, strahlerOrders } from './topologyOps'
import type { SynapseProjection } from './arborOps'
import { pointOnEdge, projectSynapses } from './arborOps'
import { SNAP_NM, isPoint } from './anchors'
import { hasRadii } from './skeletonRadii'

export type Placement = 'resample' | 'nodes' | 'manual'

/** The param holding `manual`'s points, one JSON record each. */
export const MANUAL_PARAM = 'points'

/**
 * A point placed by hand: on which neuron (its skeleton's id), where, in nanometres, and what it is
 * called, if anything — the `name` column, so Simulate can label a trace by it and a Compartment
 * Model can take it as Presynaptic, every point of one name then one partner.
 */
export interface ManualPoint {
  readonly neuron: string
  readonly at: readonly [number, number, number]
  readonly name?: string
}

/** JSON in an `ids` param, the split corrections' shape; an unnamed point stores no name. */
export function writeManualPoint(point: ManualPoint): string {
  const name = point.name?.trim()
  return JSON.stringify({ neuron: point.neuron, at: point.at, ...(name ? { name } : {}) })
}

/**
 * Where a point placed by hand goes: `t` of the way down the edge above `at.node` in a tree with
 * these parents (a re-rooted one is fine — an edge is the same edge either way round), the node
 * itself at a root. The write half of `ManualPoint`, beside its read half (`projectManual`).
 */
export function manualPointAt(
  positions: Float32Array,
  parents: Int32Array,
  at: { readonly node: number; readonly t: number },
): [number, number, number] {
  return pointOnEdge(positions, parents[at.node]!, at.node, at.t)
}

/** The stored points, any entry that does not read as one dropped. */
export function readManualPoints(raw: unknown): ManualPoint[] {
  if (!Array.isArray(raw)) return []
  const out: ManualPoint[] = []
  for (const entry of raw) {
    try {
      const { neuron, at, name } = JSON.parse(String(entry)) as Record<string, unknown>
      if (typeof neuron === 'string' && isPoint(at)) {
        out.push({
          neuron,
          at: [at[0], at[1], at[2]],
          ...(typeof name === 'string' && name ? { name } : {}),
        })
      }
    } catch {
      // Not JSON: skipped, as a malformed correction is.
    }
  }
  return out
}

/** A placed point: on the edge from `parent` down to `child`, `t` of the way, and its name. */
export interface OnEdge {
  readonly parent: number
  readonly child: number
  readonly t: number
  readonly name: string | null
}

/**
 * Each stored point projected onto its skeleton's cable, with `child` -1 where it no longer lands
 * — the one statement of when a point is stale, read by the node and by its editor alike.
 */
export function projectManual(
  skeleton: SkeletonGeometry,
  points: readonly ManualPoint[],
): SynapseProjection {
  const projection = projectSynapses(
    skeleton,
    points.map(({ at }) => ({ x: at[0], y: at[1], z: at[2], polarity: '' })),
  )
  projection.distance.forEach((d, i) => {
    if (d > SNAP_NM) projection.child[i] = -1
  })
  return projection
}

/** One neuron's stored points on its skeleton, the ones too far from its cable counted. */
export function placeManual(
  skeleton: SkeletonGeometry,
  points: readonly ManualPoint[],
): { placed: OnEdge[]; stale: number } {
  if (points.length === 0) return { placed: [], stale: 0 }
  const { child, parent, t } = projectManual(skeleton, points)
  const placed: OnEdge[] = []
  child.forEach((c, i) => {
    if (c < 0) return
    const name = points[i]!.name ?? null
    placed.push({ parent: parent[i]! < 0 ? c : parent[i]!, child: c, t: t[i]!, name })
  })
  return { placed, stale: points.length - placed.length }
}

/** The columns every cloud gets, after the id and whatever was carried. */
const MINTED: readonly ColumnSchema[] = [
  column('compartment', 'str'),
  column('cable', 'f64', 'µm'),
  column('radius', 'f64', 'µm'),
  column('strahler', 'i64'),
  column('rootDistance', 'f64', 'µm'),
]
/** What `manual` mints besides: each point's name, null where it has none. */
const MANUAL_MINTED: readonly ColumnSchema[] = [...MINTED, column('name', 'str')]

const mintedFor = (placement: Placement | undefined) =>
  placement === 'manual' ? MANUAL_MINTED : MINTED

/**
 * The schema half: the id, the carried columns, then the minted ones — folded by `foldColumns`,
 * so a carried column sharing a minted name is written over in its slot, Points in Volumes' rule.
 */
export function skeletonPointsSchema(
  attributes: TableSchema | undefined,
  carry: readonly string[],
  placement?: Placement,
): TableSchema {
  const carried = pickColumns(
    attributes,
    carry.filter((n) => n !== ID_COLUMN_NAME),
  )?.columns
  return foldColumns(
    tableSchema(column(ID_COLUMN_NAME, 'str'), ...(carried ?? [])),
    mintedFor(placement),
  )
}

/**
 * A skeleton's unbranched runs: from a root or branch point to the next branch point or leaf,
 * `segmentStats`' definition — the start belongs to every run leaving it, since the edge leaving it
 * carries length. `nodes[starts[r] .. starts[r + 1]]` is run `r`, start included.
 */
interface Runs {
  nodes: Int32Array
  starts: Int32Array
  lengths: Float64Array
}

function runsOf(tree: SkeletonTree, distances: Float32Array): Runs {
  const nodes: number[] = []
  const starts: number[] = []
  const lengths: number[] = []
  const stack = [...tree.roots]
  while (stack.length > 0) {
    const start = stack.pop()!
    for (let cursor of tree.children[start]!) {
      starts.push(nodes.length)
      nodes.push(start)
      let length = 0
      for (;;) {
        nodes.push(cursor)
        length += distances[cursor]!
        const kids = tree.children[cursor]!
        if (kids.length !== 1) break
        cursor = kids[0]!
      }
      lengths.push(length)
      if (tree.children[cursor]!.length > 1) stack.push(cursor)
    }
  }
  starts.push(nodes.length)
  return {
    nodes: Int32Array.from(nodes),
    starts: Int32Array.from(starts),
    lengths: Float64Array.from(lengths),
  }
}

/**
 * Run lengths per skeleton, memoised on the geometry (`cableLength`'s licence) so a Spacing edit
 * on this `cheap` node recounts without a tree. Only the lengths: they are one number per run,
 * where anything per node held here would double what a skeleton costs with nothing counting it.
 */
const RUN_LENGTHS = new WeakMap<SkeletonGeometry, Float64Array>()

function runLengthsOf(skeleton: SkeletonGeometry): Float64Array {
  let held = RUN_LENGTHS.get(skeleton)
  if (!held) {
    held = runsOf(skeletonTree(skeleton), parentDistances(skeleton)).lengths
    RUN_LENGTHS.set(skeleton, held)
  }
  return held
}

/** A run's piece count. The tolerance keeps a run of exactly 2 × Spacing at two, not three. */
function piecesOf(length: number, spacingNm: number): number {
  return length > 0 ? Math.max(1, Math.ceil(length / spacingNm - 1e-9)) : 0
}

/** Exactly how many points one skeleton makes. 0 under `resample` for one with no cable. */
export function pointCount(
  skeleton: SkeletonGeometry,
  placement: Exclude<Placement, 'manual'>,
  spacingNm: number,
): number {
  if (placement === 'nodes') return skeleton.parents.length
  let count = 0
  for (const length of runLengthsOf(skeleton)) count += piecesOf(length, spacingNm)
  return count
}

/**
 * The value half: every skeleton's points, written in item order into columns allocated once.
 * `counts` is `pointCount` per item — under `manual`, each item's `placed` length — computed by the
 * caller so it can check the size first.
 */
export async function skeletonPointsValue(
  skeletons: SkeletonsValue,
  counts: readonly number[],
  placement: Placement,
  spacingNm: number,
  schema: TableSchema,
  slicer: Slicer,
  /** Under `manual`: per item, its points as `placeManual` placed them. */
  manual: readonly (readonly OnEdge[])[] = [],
): Promise<PointsValue> {
  let total = 0
  for (const n of counts) total += n
  const positions = new Float32Array(total * 3)
  const data: Record<string, CellValue[]> = {}
  for (const c of schema.columns) data[c.name] = new Array<CellValue>(total)
  const compartment = data.compartment!
  const cable = data.cable!
  const radius = data.radius!
  const strahler = data.strahler!
  const rootDistance = data.rootDistance!

  const attributes = skeletons.attributes
  const ids = attributes.data[ID_COLUMN_NAME]
  const minted = new Set(mintedFor(placement).map((c) => c.name))
  const carried = schema.columns
    .map((c) => c.name)
    .filter((n) => n !== ID_COLUMN_NAME && !minted.has(n))
  const names = data.name

  let at = 0
  await sliced(skeletons.items.length, slicer, (item) => {
    const skeleton = skeletons.items[item]!
    const end = at + counts[item]!
    data[ID_COLUMN_NAME]!.fill(idText(ids?.[item]) ?? skeleton.id, at, end)
    for (const name of carried) data[name]!.fill(attributes.data[name]?.[item] ?? null, at, end)
    writeSkeleton(skeleton, at, manual[item] ?? [])
    at = end
  })

  return {
    kind: 'points',
    positions,
    attributes: makeTable(schema, data),
    bounds: boundsOf([positions]),
    ...(skeletons.units ? { units: skeletons.units } : {}),
    ...(skeletons.space ? { space: skeletons.space } : {}),
  }

  /** One point: a position and the five minted cells, distances in nm converted here once. */
  function put(
    p: number,
    x: number,
    y: number,
    z: number,
    code: number,
    cableNm: number | null,
    radiusNm: number | null,
    order: number,
    rootNm: number,
  ): void {
    positions[p * 3] = x
    positions[p * 3 + 1] = y
    positions[p * 3 + 2] = z
    compartment[p] = compartmentName(code)
    cable[p] = cableNm === null ? null : cableNm / NM_PER_UM
    radius[p] = radiusNm === null ? null : radiusNm / NM_PER_UM
    strahler[p] = order
    rootDistance[p] = rootNm / NM_PER_UM
  }

  function writeSkeleton(
    skeleton: SkeletonGeometry,
    from: number,
    placed: readonly OnEdge[],
  ): void {
    // A neuron with nothing placed on it writes nothing: no tree, Strahler or depth to work out.
    if (placement === 'manual' && placed.length === 0) return
    const { positions: xyz, radii, parents } = skeleton
    const codes = skeleton.compartments
    const tree = skeletonTree(skeleton)
    const distances = parentDistances(skeleton)
    const strahler = strahlerOrders(skeleton, tree)
    const fromRoot = rootDistances(skeleton, tree, distances)
    // All-zero radii are a source that publishes none, not a neuron of zero thickness.
    const measured = hasRadii(radii)
    let p = from

    if (placement === 'nodes') {
      const weights = samplesOf(skeleton).weights
      for (let i = 0; i < parents.length; i++, p++) {
        put(
          p,
          xyz[i * 3]!,
          xyz[i * 3 + 1]!,
          xyz[i * 3 + 2]!,
          codes?.[i] ?? 0,
          weights[i]!,
          measured ? radii[i]! : null,
          strahler[i]!,
          fromRoot[i]!,
        )
      }
      return
    }

    /** A point `t` of the way from node `a` down to `b`, read as `resample` reads a midpoint. */
    const between = (a: number, b: number, t: number, cableNm: number | null) =>
      put(
        p,
        xyz[a * 3]! + (xyz[b * 3]! - xyz[a * 3]!) * t,
        xyz[a * 3 + 1]! + (xyz[b * 3 + 1]! - xyz[a * 3 + 1]!) * t,
        xyz[a * 3 + 2]! + (xyz[b * 3 + 2]! - xyz[a * 3 + 2]!) * t,
        codes?.[b] ?? 0,
        cableNm,
        measured ? radii[a]! + (radii[b]! - radii[a]!) * t : null,
        strahler[b]!,
        // Interpolated like the radius, not `fromRoot[a] + (target - before)`: between a soma in
        // mid-fragment and the delivered root, depth falls towards the children.
        fromRoot[a]! + (fromRoot[b]! - fromRoot[a]!) * t,
      )

    if (placement === 'manual') {
      for (const { parent, child, t, name } of placed) {
        names![p] = name
        between(parent, child, t, null)
        p++
      }
      return
    }

    const runs = runsOf(tree, distances)
    for (let r = 0; r < runs.lengths.length; r++) {
      const pieces = piecesOf(runs.lengths[r]!, spacingNm)
      const piece = runs.lengths[r]! / pieces
      const last = runs.starts[r + 1]! - 1
      let edge = runs.starts[r]! + 1
      let before = 0 // run length up to the start of `edge`
      for (let j = 0; j < pieces; j++, p++) {
        const target = (j + 0.5) * piece
        while (edge < last && before + distances[runs.nodes[edge]!]! < target) {
          before += distances[runs.nodes[edge]!]!
          edge++
        }
        const a = runs.nodes[edge - 1]!
        const b = runs.nodes[edge]!
        const span = distances[b]!
        const t = span > 0 ? Math.min(1, (target - before) / span) : 0
        between(a, b, t, piece)
      }
    }
  }
}
