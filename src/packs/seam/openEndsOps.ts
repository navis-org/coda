/**
 * The bookkeeping that lets a neuron's open ends arrive while it is still being scanned.
 *
 * Model E scores a surface a window at a time, and `e_tip` is the best 0.5 µm cell within
 * `E_TIP_UM` of a tip. A node could wait for the whole neuron and publish once — 63 s on a
 * 3.7 M-face Aedes neuron, measured — but it does not have to, and the reason is a property of
 * the geometry rather than a guess:
 *
 * **A window's points lie inside its own crop**, so a cell within `E_TIP_UM` of a tip can only
 * come from a centre within `windowRadius + E_TIP_UM` of it. Count those centres per tip, scan
 * the tiling page by page, and a tip whose count reaches zero is **finished** — its `e_tip` can
 * never change again, however much of the neuron is left. So rows go out as they are settled,
 * in roughly the order the scan sweeps the arbour, and the answer is the same one a whole-neuron
 * scan gives. `probe:seam-e-cells` checks that equality on real tips.
 *
 * Headless and pure, `nblastOps.ts`' arrangement: the scanning and the model are the node's, and
 * what is here is the part a test can see — which is the part that is easy to get silently wrong.
 * A tip released one page early reads as a slightly low score, never as an error.
 */

import { NM_PER_UM } from '../../data/units'
import type { CellValue, TableValue } from '../../core/values'
import { TIP_FIELDS, published, tableOf } from './suggestionTables'
import type { TipKind } from './tips'

/** `calib_tips.E_TIP_UM`: how far from a tip a Model E cell may be and still be its `e_tip`. */
export const E_TIP_UM = 1.0

/**
 * How far past its own radius a window's points can lie, in micrometres.
 *
 * **A crop keeps faces by centroid** (`canonical.crop_faces`) and then keeps all three of their
 * vertices, so a sampled point can sit outside the radius by as much as a face reaches beyond its
 * own centre. Measured on a 3.7 M-face Aedes mesh: 55 nm median, 128 nm at the 99th percentile,
 * 455 nm worst. Half a micrometre is past all of it, and buying the margin costs a handful of
 * extra centres per tip against a scan measured in seconds a window.
 *
 * Without it the bound below is short by a face, and the failure is the quiet one this file is
 * written against: a tip settles one page before a centre that could still have raised its
 * `e_tip`, and keeps a slightly low score nobody will revisit.
 */
export const CROP_SLOP_UM = 0.5

/**
 * How far a window centre may be from a tip and still reach it, given the window's radius.
 *
 * The whole of the streaming argument, in one line. Anything further away crops a sphere whose
 * points — including the ones its faces reach past the radius with — are all more than the tip
 * will read from it.
 */
export function reachNm(windowRadiusUm: number, tipReachUm = E_TIP_UM): number {
  return (windowRadiusUm + tipReachUm + CROP_SLOP_UM) * NM_PER_UM
}

/**
 * Which centres each tip is waiting on, and the order to build them in — one pass, one predicate.
 *
 * The three questions the sweep asks are the same question: *how many* centres a tip waits on,
 * *which* to build first, and *when* a page has finished one. Asked separately they were three
 * walks over the same (tip × centre) distances with the reach test written out three times, and
 * the three had to stay identical for a tip to settle at the right moment. A tip released one
 * page early carries a lower score for ever and never reads as an error, so they are asked once
 * and answered from the same rows.
 *
 * `rows[t]` is tip `t`'s centres, `order` is the sweep: each tip's own centres in turn, each
 * centre once, and **only** the centres some tip is waiting on — a window further than `within`
 * from every tip cannot hold a cell any tip will read, so building it is work whose answer is
 * never asked for.
 */
export interface TipSweep {
  /** Per tip, the centres within reach of it. */
  readonly rows: readonly Int32Array[]
  /** The centres to build, in the order that settles tips soonest. */
  readonly order: Int32Array
}

export function planSweep(
  tipsNm: Float32Array,
  centresNm: Float32Array,
  within: number,
): TipSweep {
  const tips = Math.floor(tipsNm.length / 3)
  const centres = Math.floor(centresNm.length / 3)
  const limitSq = within * within
  const rows: Int32Array[] = []
  const taken = new Uint8Array(centres)
  const order: number[] = []
  for (let t = 0; t < tips; t++) {
    const x = tipsNm[t * 3]!
    const y = tipsNm[t * 3 + 1]!
    const z = tipsNm[t * 3 + 2]!
    const mine: number[] = []
    for (let c = 0; c < centres; c++) {
      const dx = centresNm[c * 3]! - x
      const dy = centresNm[c * 3 + 1]! - y
      const dz = centresNm[c * 3 + 2]! - z
      if (dx * dx + dy * dy + dz * dz > limitSq) continue
      mine.push(c)
      if (!taken[c]) {
        taken[c] = 1
        order.push(c)
      }
    }
    rows.push(Int32Array.from(mine))
  }
  return { rows, order: Int32Array.from(order) }
}

/**
 * How many centres each tip is still waiting on, to be counted down by `settledBy`.
 *
 * A separate array from `TipSweep.rows` because it is the mutable half: the plan is what the
 * geometry says and does not change, this is how far through it the run has got.
 */
export function pendingOf(sweep: TipSweep): Int32Array {
  return Int32Array.from(sweep.rows, (row) => row.length)
}

/**
 * The cells a neuron has been scored into so far: **one representative per `cellUm` box**, the
 * best-scoring point in it.
 *
 * A pool rather than a running maximum per tip, and the difference is the whole of why this
 * exists. `reduce_max` is applied page by page, so a box can come back from two pages with two
 * different representative *points* — the best of page A at one position, the best of page B at
 * another. A tip reads "the best cell within a micrometre", measured from the representative's
 * position, so a box whose true representative lies outside the micrometre but whose page-local
 * one lies inside would count, and the tip would score **higher** than a whole-neuron scan says.
 * Never an error, never a number out of range, and not something the probe could see, since it
 * re-reduces cumulatively and so measures a pipeline the node was not running.
 *
 * Keeping the pool keyed by box and asking it only when a tip settles gives the whole-neuron
 * answer exactly: every point that can land in a box within reach of a tip comes from a centre
 * in that tip's own reach set, so by the time the tip settles its neighbourhood is final.
 *
 * `probe:seam-e-cells` gets there another way — it re-reduces the accumulated pool through
 * `reduce_max` each page — and the two agreeing is the check worth having: one is the vendored
 * reduction, the other this one, and they are asked the same question about the same neuron.
 */
export interface CellPool {
  /** `cellUm` in nanometres: the box a representative stands for. */
  readonly cellNm: number
  /** Box key to the best point in it, as `score` and its position. */
  readonly best: Map<string, { score: number; x: number; y: number; z: number }>
}

export function emptyCellPool(cellUm: number): CellPool {
  return { cellNm: cellUm * NM_PER_UM, best: new Map() }
}

/**
 * Fold one page's cells in, keeping the better representative wherever two pages name a box.
 *
 * The box is `floor(position / cellNm)`, which is `reduce_max`'s own rule — so this continues
 * the reduction rather than inventing a second one.
 */
export function addCells(pool: CellPool, cellsNm: Float32Array, scores: Float32Array): void {
  for (let c = 0; c < scores.length; c++) {
    const x = cellsNm[c * 3]!
    const y = cellsNm[c * 3 + 1]!
    const z = cellsNm[c * 3 + 2]!
    const key = `${Math.floor(x / pool.cellNm)},${Math.floor(y / pool.cellNm)},${Math.floor(z / pool.cellNm)}`
    const held = pool.best.get(key)
    const score = scores[c]!
    if (held === undefined || score > held.score) pool.best.set(key, { score, x, y, z })
  }
}

/**
 * The best cell within `reach` of a point, or `-Infinity` where none is — `calib_tips.e_at`.
 *
 * Asked once per tip, when it settles. A scan of the whole pool rather than an index: a neuron
 * is about 32,000 cells and 1,200 tips, which is a few tens of millions of distance tests over a
 * scan measured in seconds a window.
 */
export function bestWithin(
  pool: CellPool,
  x: number,
  y: number,
  z: number,
  reach: number,
): number {
  const limitSq = reach * reach
  let top = -Infinity
  for (const cell of pool.best.values()) {
    if (cell.score <= top) continue
    const dx = cell.x - x
    const dy = cell.y - y
    const dz = cell.z - z
    if (dx * dx + dy * dy + dz * dz <= limitSq) top = cell.score
  }
  return top
}

/**
 * Which tips a page of centres finishes, counting down what they were waiting on.
 *
 * Reads the plan rather than re-testing the distances, which is what keeps it in step with the
 * order the sweep was built in. `pending` is updated in place, and a tip is returned exactly
 * once — on the page that takes its count to zero — so a caller can publish on the strength of
 * it without keeping a set of its own.
 */
export function settledBy(pending: Int32Array, sweep: TipSweep, built: Int32Array): number[] {
  const page = new Set(built)
  const done: number[] = []
  for (let t = 0; t < sweep.rows.length; t++) {
    if (pending[t]! <= 0) continue
    for (const centre of sweep.rows[t]!) if (page.has(centre)) pending[t]! -= 1
    if (pending[t]! <= 0) done.push(t)
  }
  return done
}

/** One settled open end, in the units the table publishes. */
export interface OpenEnd {
  readonly neuronId: string
  /** Unique within this run, in the order tips were enumerated — the fixture's `end_uid`. */
  readonly endUid: number
  readonly kind: TipKind
  readonly x: number
  readonly y: number
  readonly z: number
  /** The best Model E cell within `E_TIP_UM`, or null where no cell reached it. */
  readonly eTip: number | null
}

/**
 * The open ends as the fixture's `Tips` table.
 *
 * **Built from `TIP_FIELDS`**, which is the same list `seam:suggestions` publishes from — so the
 * two nodes cannot drift and `seam:review` takes either without knowing which made it. Every
 * column a later stage will fill is present and **null**, not absent: a reader's column picker is
 * offered the same choices whichever node is upstream, and a null is honestly "not computed yet"
 * where a missing column would be a different table.
 *
 * `e_tip` is the one column this stage actually knows. `p_tip` needs `segclr`, which is the
 * assessors' work; `q`, `shown` and `r` follow from it.
 */
export function openEndsTable(ends: readonly OpenEnd[]): TableValue {
  const known: Record<string, CellValue[]> = {
    neuron: ends.map((end) => end.neuronId),
    end_uid: ends.map((end) => end.endUid),
    kind: ends.map((end) => end.kind),
    x_nm: ends.map((end) => end.x),
    y_nm: ends.map((end) => end.y),
    z_nm: ends.map((end) => end.z),
    e_tip: ends.map((end) => end.eTip),
  }
  const read: Record<string, CellValue[]> = {}
  for (const field of published(TIP_FIELDS)) {
    // Keyed by the file name, which is what `tableOf` reads — `ID_COLUMN_NAME` is the published
    // name of `neuron` and is not a key here.
    read[field.from] = known[field.from] ?? ends.map(() => null)
  }
  return tableOf(TIP_FIELDS, read)
}
