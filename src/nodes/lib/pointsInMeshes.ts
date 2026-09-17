/**
 * Asking a point cloud which mesh each of its points is in.
 *
 * `Points in Volumes`' op, both halves of it — invariant 3's pair, in a sibling module rather
 * than in `tableOps.ts` because the vocabulary is geometry's: what varies here is a surface and
 * a coordinate, and the only table in sight is the one a `PointsValue` carries alongside.
 * `meshInside.ts` is the other half of the split and owns the ray; nothing below knows what a
 * BVH is.
 *
 * ## Why this node exists at all
 *
 * A synapse cloud carries no region. neuPrint's `Synapse` nodes are matched by body and
 * polarity (`synapsesCypher`), CAVE's synapse tables carry coordinates and root ids, and
 * CATMAID's connectors carry neither — so "which of these synapses are in `LO(R)`" had no route
 * on the canvas at all. `ROI Counts` answers the *count* per region and hands back no
 * locations, which is the one question adjacent to this one and not the same question: it
 * cannot colour a scene, cannot feed a downstream filter, and stops existing the moment the
 * volume is a neuron's mesh rather than a neuropil.
 *
 * ## The column and the ports are one pass, and both are kept
 *
 * Every point gets `roi` — the id of the volume enclosing it, or null — and the two ports are
 * that column read as a predicate. Neither alone does the job: the ports are what a scene wants
 * (`Split Neurons`' gesture, on points), the column is what `Group By` wants, and a wire
 * carries a collection of volumes rather than one, so a bare pair of ports would throw away
 * *which* region a point landed in. One pass computes both; the second port is an index list.
 *
 * **`Outside` carries the column too, holding null in every row.** Two ports of one type is
 * what lets a `Stack Neurons` put the halves back together, and what makes `inferOutputs` one
 * answer rather than two — and an all-null column on the half defined by having no value is not
 * information lost, it is the definition written down.
 *
 * ## Overlap is counted, not assumed away
 *
 * A dataset's primary set tiles, so a point is in one region and the first hit is the only hit.
 * Nothing guarantees that: the published list nests (230 regions on hemibrain against 63 that
 * tile), and a wire can carry neuron meshes, which overlap wherever two arbours interdigitate.
 * So every box candidate is tested rather than stopping at the first, **the first in item order
 * wins**, and the number of points that were in more than one is said out loud. Stopping early
 * would be faster by the overlap rate and would make the difference between "these synapses are
 * in LO(R)" and "these synapses are in LO(R) and also in three other things" invisible — which
 * is the one failure here that produces a perfectly ordinary-looking table.
 *
 * ## Frames
 *
 * `checkSameFrame` is the check this node cannot do without, and it is `checkStackable`'s
 * argument arriving at a different node: two template spaces are hundreds of micrometres apart,
 * so a cloud in `FLYWIRE` against shells in `JRCFIB2022M` puts every point outside every volume
 * and returns an empty `Inside` port — a result, not an error, and one that reads as a dataset
 * with no synapses in it. Units the same way, a factor of eight between raw and calibrated
 * hemibrain coordinates. It is not `checkStackable` itself because that function refuses a
 * *kind* mismatch, which is the whole arrangement here.
 */

import { isIdentifierColumn } from '../../core/ids'
import { describeDuration, warnOverThreshold } from '../../core/limits'
import type { Warner } from '../../core/limits'
import { sliced } from '../../core/slice'
import type { ColumnData, MeshesValue, PointsValue } from '../../core/values'
import { makeTable } from '../../core/values'
import type { TableSchema } from '../../core/types'
import { column, findColumn, tableSchema } from '../../core/types'
import { selectPoints } from './iterables'
import { foldColumns } from './tableOps'
import { frameClash, frameClashMessage } from './transformOps'

/** The param id this module, the node and both emitters spell. */
export const VOLUME_COLUMN_PARAM = 'column'

/**
 * What the minted column is called unless somebody renames it.
 *
 * `roi` because that is what `neuron.connectivity` already mints for the same concept and what
 * every neuPrint-shaped table downstream expects to filter on. It is a *param* rather than a
 * constant because the wire does not have to carry neuropils: a set of neuron meshes on the
 * `Volumes` socket is an ordinary use of this node, and a column called `roi` naming a body id
 * is a lie that survives into a CSV.
 */
export const DEFAULT_VOLUME_COLUMN = 'roi'

/**
 * The column name as the params hold it — the node's, and both emitters'.
 *
 * Here rather than on the node so the constants above and the reader that turns them into an
 * answer sit together, which is `matrixReduce`'s arrangement (`readReduceOptions` and
 * `reduceColumnName` both in `nodes/lib`, both emitters importing from there) and the reason
 * `filterRowParams.ts` exists: an exporter must read a param by the same rule the node does,
 * and `src/export` reaching into a node file to get it is how the two come to differ.
 *
 * No `?? ''` beside the read: every context is built through `withDefaults`, so a param nothing
 * stored already reads as its declared default and a fallback there is the second copy
 * invariant 4 names. The `||` **is** load-bearing and is a different case — this is free text a
 * user can clear, and a stored empty string is present rather than absent, so nothing refills
 * it. `annotation/index.ts` spells it the same way.
 */
export function volumeColumnName(params: Record<string, unknown>): string {
  return String(params[VOLUME_COLUMN_PARAM]).trim() || DEFAULT_VOLUME_COLUMN
}

/**
 * What replacing a column of this name costs, if anything — the node's one guard about it.
 *
 * `volumeColumnSchema` writes over a same-named column **in place** (`foldNodeColumns`' rule, and
 * the argument for it is there: two `roi` columns give every picker downstream two answers and
 * the second is the stale one). So the hazard is not the *name*, it is the **incumbent**, and the
 * first version of this guard asked the wrong one of the two — `isIdentifierColumn(name)` alone,
 * which refuses `neuronId` on a cloud that has no such column and says nothing at all when
 * somebody types `confidence` over a real one.
 *
 * Two answers, which is `docs/limits.md`' tiering rather than taste:
 *
 * - **Refuse** an id column. `neuronId` here replaces every synapse's body id with a region name,
 *   leaving a table that still has all its columns, still joins, and joins wrongly — invariant 8,
 *   and there is no useful answer on the other side of it.
 * - **Warn** for anything else. A guard rail warns; it does not refuse. Replacing `confidence` is
 *   a thing somebody may well mean, and the result is a perfectly good table — it just must not
 *   happen in silence, which is `relabelTarget`'s rule stated for the overwrite case
 *   ("overwriting a column somebody did not name in this node is not a thing to do quietly").
 *
 * One function two layers render, `kindClashMessage`'s rule: `validate` marks the card and
 * `evaluate` throws or warns from the same sentence, because written out at both layers this
 * drifted immediately and a reader meeting both cannot tell they are one complaint.
 */
export interface ColumnClash {
  message: string
  /** Whether there is a useful answer on the other side. */
  severity: 'error' | 'warning'
}

export function columnClash(
  schema: TableSchema | undefined,
  name: string,
): ColumnClash | undefined {
  if (!schema || !findColumn(schema, name)) return undefined
  return isIdentifierColumn(name)
    ? {
        severity: 'error',
        message:
          `Column "${name}" holds ids and a same-named column is written over in place — so ` +
          'this would replace them with region names and leave every join downstream matching ' +
          'nothing. Pick another name.',
      }
    : {
        severity: 'warning',
        message:
          `These points already carry a column called "${name}", and it is written over in ` +
          'place rather than added beside. Rename this one if you meant to keep both.',
      }
}

/**
 * Where testing points against volumes is worth a sentence.
 *
 * Counted in **rays**, which is what it actually costs: a point is tested against the volumes
 * whose bounding box contains it and against no others, so the number is neither the point
 * count nor points × volumes but the sum of box candidates over the cloud.
 *
 * `pnpm probe:points-in-volumes`, and the shape of the measurement is the reason the threshold
 * is where it is. **A ray barely moves with the surface** — 1.5 µs at 20k triangles a volume
 * against 1.9 µs at a million, a tree descent being logarithmic — so the cost scales with the
 * cloud and not with the meshes, and the threshold can be a ray count at all. Seven and a half
 * million of them is about **fourteen seconds**, which is the first point at which somebody
 * waits and has no fetch to blame it on; an ordinary hundred-thousand-synapse cloud against a
 * primary set is two or three hundred thousand rays, well under half a second, and says nothing.
 *
 * **These numbers were wrong once and the error is the instructive part.** The probe sampled
 * points in a box larger than the mesh — deliberately, since a cloud that only partly overlaps
 * the volumes is the realistic case — and then divided the elapsed time by the *point* count. So
 * it was timing `containing` calls, of which barely a third cast a ray at all, and published
 * 0.67 µs for something that costs about 1.8. The threshold, the rate below and three documents
 * all inherited it. The probe counts rays through `candidateCount` now.
 *
 * What is deliberately **not** thresholded is the trees: 192 ms per million triangles, paid once,
 * and held weakly against the mesh items afterwards, so a second Run pays none of it.
 */
export const RAY_WARN = 7_500_000

/**
 * The rate the threshold above and the sentence below are both derived from.
 *
 * A named constant rather than the same figure written into the arithmetic and into the prose,
 * which is `NBLAST_PAIRS_PER_SECOND`'s shape and for its reason: the two spellings drift, and
 * the one in the prose is the one a reader checks the threshold against. 530,000/s is the slow
 * end of the probe across runs (1.89 µs) rather than a middle, so an estimate is never shorter
 * than the wait — the same call `NBLAST_PAIRS_PER_SECOND` makes, and it matters here because the
 * per-ray figure moves a little between runs (1.5–1.9 µs over the four mesh sizes).
 */
const RAYS_PER_SECOND = 530_000

/** Each point's volume, and the halves that column defines. */
export interface VolumeLabelling {
  /** Points enclosed by at least one volume, carrying the volume's id. */
  inside: PointsValue
  /** Points enclosed by none, carrying a null in the same column. */
  outside: PointsValue
  /** How many points fell inside more than one volume; the first in item order named them. */
  ambiguous: number
}

/**
 * The schema half: the cloud's own columns with the volume column folded in.
 *
 * `foldColumns`' two rules, which is why it is that function and not an append — a cloud that
 * already carries a `roi` (a CAVE synapse table that was joined to one upstream, or a second
 * Points in Volumes) gets it **written over rather than beside**, since two `roi` columns give
 * every picker downstream two answers and the second is the stale one, and it **keeps its slot**,
 * since `TableViewer`, the CSV export and GraphML key ids are all `schema.columns` in order.
 *
 * `foldColumns` and not `foldNodeColumns`, which is what this called while the rule lived in the
 * network ops file: that one answers `id` plus the wanted columns when there is no schema — an
 * honest promise about a node table and meaningless for a point cloud — so this had to subtract
 * it with a ternary and six lines explaining why.
 */
export function volumeColumnSchema(schema: TableSchema | undefined, name: string): TableSchema {
  const minted = column(name, 'str')
  return schema ? foldColumns(schema, [minted]) : tableSchema(minted)
}

export interface LabelOptions {
  /** The column `volumeColumnSchema` mints. */
  name: string
  /** Which volumes enclose a point, appended in item order. `meshInside.ts` builds this. */
  containing: (x: number, y: number, z: number, out: number[]) => void
  /** Fraction done, on each slice boundary. */
  progress?: (fraction: number) => void
  /** Aborts the walk at the next boundary. */
  signal?: AbortSignal
}

/**
 * The value half: every point's volume, and the cloud split on it.
 *
 * The walk is over points rather than over volumes, which is the order the prefilter wants —
 * one box sweep per point against a handful of candidates, against one full cloud pass per
 * volume. It also makes progress monotonic in something the reader can see.
 *
 * **Sliced rather than run to completion**, which is not optional here: `evaluate` runs on the
 * main thread, so a walk that never awaits reports progress the browser never paints and cannot
 * observe the abort it checks for — the click that would set the signal cannot be dispatched
 * while the loop holds the event loop. At this node's own warning threshold that is thirteen
 * seconds of frozen tab with a dead bar and a Cancel that does nothing. `core/slice.ts` owns the
 * loop; what is left here is the body.
 */
export async function labelPointsByVolume(
  points: PointsValue,
  volumes: MeshesValue,
  options: LabelOptions,
): Promise<VolumeLabelling> {
  const { name, containing } = options
  const total = points.attributes.length
  const labels: ColumnData = new Array<string | null>(total).fill(null)
  const positions = points.positions
  const hits: number[] = []
  let ambiguous = 0

  await sliced(total, options, (i) => {
    hits.length = 0
    containing(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!, hits)
    if (hits.length === 0) return
    if (hits.length > 1) ambiguous++
    // First in item order. `containing` appends in that order, so this is `hits[0]` and the
    // rule is stated once, at the seam that can honour it.
    labels[i] = volumes.items[hits[0]!]!.id
  })

  return { ...splitOnLabels(points, labels, name), ambiguous }
}

/**
 * The cloud with the column folded in, and the two halves that column defines.
 *
 * **Folded into the whole cloud once, and the halves are then ordinary subsets.** Written the
 * other way — an index list per half, positions copied by hand, the column spliced into each —
 * this was `selectPoints` copied out with one extra line, which is where every rule about a
 * geometry subset would have come to exist twice: bounds recomputed because a half's box is not
 * the cloud's, `units` and `space` carried because taking points out does not move them.
 * `iterables.ts` states those once and claims to.
 *
 * Its own function because the zero-volume case needs exactly this and none of the walk above.
 */
export function splitOnLabels(
  points: PointsValue,
  labels: ColumnData,
  name: string,
): Pick<VolumeLabelling, 'inside' | 'outside'> {
  const labelled: PointsValue = {
    ...points,
    attributes: makeTable(
      volumeColumnSchema(points.attributes.schema, name),
      { ...points.attributes.data, [name]: labels },
      points.attributes.kind,
    ),
  }
  return {
    inside: selectPoints(labelled, (i) => labels[i] !== null),
    outside: selectPoints(labelled, (i) => labels[i] === null),
  }
}

/**
 * The rays this run will cost, counted before any of them is cast.
 *
 * One box sweep over the cloud — three comparisons per volume per point — which is cheap enough
 * to spend on knowing, and is the only way the warning can arrive before the wait rather than
 * after it. `networkMetrics`' `TRIANGLE_WORK_WARN` is the same shape and states the argument.
 */
export function countRays(
  points: PointsValue,
  candidates: (x: number, y: number, z: number) => number,
): number {
  let rays = 0
  for (let i = 0; i < points.attributes.length; i++) {
    rays += candidates(
      points.positions[i * 3]!,
      points.positions[i * 3 + 1]!,
      points.positions[i * 3 + 2]!,
    )
  }
  return rays
}

export function warnRayCount(ctx: Warner, rays: number, volumes: number): void {
  if (rays <= RAY_WARN) return
  warnOverThreshold(ctx, {
    count: rays,
    threshold: RAY_WARN,
    unit: 'ray casts',
    control: 'the work this node is usually asked for',
    cost:
      `Each is one descent of a volume's triangle tree, so this is ` +
      `${describeDuration(rays / RAYS_PER_SECOND)}, single-threaded. That is every point ` +
      `against the ${volumes.toLocaleString()} volumes whose bounding box contains it; ` +
      `filtering the Volumes wire down to the regions you are asking about moves it most, and ` +
      `filtering the points upstream moves it proportionally.`,
  })
}

/**
 * Whether the cloud and the volumes are in the same frame — this node's two sentences.
 *
 * `frameClash` and `frameClashMessage` are `transformOps`', beside `checkStackable` whose arms
 * render through the same pair. What is supplied here is the part that is genuinely this node's:
 * what goes wrong. Tested across frames every point falls outside every volume, so the failure is
 * a **result** — an empty `Inside` port and a green card — rather than an error, which is why
 * this is a refusal and not a warning.
 */
export function checkPointFrame(
  points: PointsValue | undefined,
  volumes: MeshesValue | undefined,
): string | undefined {
  const clash = frameClash(points, volumes)
  return clash
    ? frameClashMessage(
        clash,
        { left: 'The points', right: 'the volumes' },
        {
          units:
            'Tested against each other at that scale every point falls outside every volume, ' +
            'so the result would be an empty Inside port rather than an error.',
          space:
            'Nothing would be found inside anything. Put both through Transform Neurons first.',
        },
      )
    : undefined
}
