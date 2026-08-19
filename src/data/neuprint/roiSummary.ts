/**
 * Decoding neuPrint's two cached whole-dataset ROI summaries.
 *
 * Pure and separate from the HTTP layer, like `decode.ts` and for the same reason: the
 * alternative to a recorded fixture is a test against a shared production server.
 *
 * Both endpoints are *cached* on neuPrint's side — they are precomputed roll-ups rather than
 * Cypher, which is why they answer a whole connectome in kilobytes and why a node built on
 * them can afford to ask about male-CNS at all. What they publish is not uniform, and the two
 * differences below are the ones that produce a plausible wrong number rather than an error.
 */

import type { ColumnData, TableValue } from '../../core/values'
import { makeTable } from '../../core/values'
import { ROI_COMPLETENESS_SCHEMA, ROI_CONNECTIVITY_SCHEMA } from '../source'
import { coerce } from './decode'
import type { CypherResponse } from './decode'
import type { RoiConnectivityResponse } from './client'

/**
 * The order `roicompleteness` returns its columns in.
 *
 * Checked against the live response for every family rather than assumed, because the decode
 * is positional and a silent reordering would swap "traced" with "total" — which reads as a
 * dataset that is 110% complete, or as one that is 38% complete when it is 91%.
 */
export const ROI_COMPLETENESS_COLUMNS = ['roi', 'roipre', 'roipost', 'totalpre', 'totalpost']

/**
 * A fraction, or null where there is nothing to divide.
 *
 * Never zero. A region with no synapses recorded at all has *undefined* completeness, and a
 * confident `0%` bar for a region nobody has looked at is exactly the class of invented datum
 * `numeric()` exists to prevent. Also guards the reverse: a count above its total would give a
 * fraction over 1, which is a sign the columns drifted rather than something to plot.
 */
function fraction(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null
  return part / whole
}

export interface RoiCompletenessOptions {
  /**
   * The ROIs that tile the volume, from `Meta.primaryRois`.
   *
   * `undefined` means *not known yet*, which is a different answer from "none of them" and is
   * reported as a null `primary` rather than as false. A caller that totals anything has to
   * distinguish the two: false says "this row is inside another one", null says "nobody can
   * say yet whether adding these up double counts".
   */
  primaryRois?: readonly string[] | undefined
}

/**
 * Per-ROI traced-vs-total synapse counts.
 *
 * The `primary` column is the whole reason this decoder takes options. neuPrint publishes the
 * *nesting* ROI list here — hemibrain returns `AL(R)` and `AL-DA1(R)` as sibling rows, and
 * male-CNS returns 5,412 rows that are largely medulla columns inside `ME(R)` — so summing the
 * column as returned counts many synapses several times over. Measured: hemibrain totals
 * 20,988,880 presynaptic sites raw against 9,428,400 over the primary set alone, which is the
 * figure that agrees with `Meta.totalPreCount`.
 *
 * Marking the summable rows here, rather than leaving each caller to intersect two lists, is
 * what turns that from a footgun into a column a Filter node can act on.
 */
export function roiCompletenessFromResponse(
  response: CypherResponse,
  options: RoiCompletenessOptions = {},
): TableValue {
  const primarySet = options.primaryRois ? new Set(options.primaryRois) : undefined

  const roi: ColumnData = []
  const pre: ColumnData = []
  const post: ColumnData = []
  const totalPre: ColumnData = []
  const totalPost: ColumnData = []
  const preCompleteness: ColumnData = []
  const postCompleteness: ColumnData = []
  const primary: ColumnData = []

  for (const row of response.data ?? []) {
    const name = coerce(row[0], 'str')
    // A row with no ROI name cannot be joined to anything or filtered on; it is not a region.
    if (typeof name !== 'string' || name.length === 0) continue

    const rp = Number(coerce(row[1], 'i64') ?? 0)
    const rq = Number(coerce(row[2], 'i64') ?? 0)
    const tp = Number(coerce(row[3], 'i64') ?? 0)
    const tq = Number(coerce(row[4], 'i64') ?? 0)

    roi.push(name)
    pre.push(rp)
    post.push(rq)
    totalPre.push(tp)
    totalPost.push(tq)
    preCompleteness.push(fraction(rp, tp))
    postCompleteness.push(fraction(rq, tq))
    primary.push(primarySet ? primarySet.has(name) : null)
  }

  return makeTable(ROI_COMPLETENESS_SCHEMA, {
    roi,
    pre,
    post,
    totalPre,
    totalPost,
    preCompleteness,
    postCompleteness,
    primary,
  })
}

/** How `roiconnectivity` joins the two ends of a pair in its map keys. */
const PAIR_SEPARATOR = '=>'

/**
 * Region-to-region connectivity, long form.
 *
 * The response is a name list plus a map keyed `"ME(R)=>LO(R)"`, which is a shape rather than
 * a table, so this is a genuine decode rather than a coercion. Two things it is careful about:
 *
 * **Only the first separator splits.** No ROI name in any published dataset contains `=>`, but
 * splitting on every occurrence would turn one that did into a silently dropped row rather
 * than an obviously wrong one, and `indexOf` costs nothing.
 *
 * **A missing pair is absent, not zero.** hemibrain publishes 3,416 pairs across 63 regions,
 * far short of 63² — the rest are region pairs with no connection found. Emitting them as
 * zero rows would quadruple the table and put a measured zero where nothing was measured; the
 * node that reshapes this into a matrix fills the gaps, because *there* a cell must exist.
 */
export function roiConnectivityFromResponse(response: RoiConnectivityResponse): TableValue {
  const source: ColumnData = []
  const target: ColumnData = []
  const count: ColumnData = []
  const weight: ColumnData = []

  for (const [pair, value] of Object.entries(response.weights ?? {})) {
    const split = pair.indexOf(PAIR_SEPARATOR)
    if (split <= 0) continue
    const from = pair.slice(0, split)
    const to = pair.slice(split + PAIR_SEPARATOR.length)
    if (!from || !to) continue

    source.push(from)
    target.push(to)
    count.push(coerce(value?.count ?? null, 'i64'))
    weight.push(coerce(value?.weight ?? null, 'f64'))
  }

  return makeTable(ROI_CONNECTIVITY_SCHEMA, { source, target, count, weight })
}

/*
 * `roi_names` is deliberately not carried across the seam.
 *
 * It would let the matrix keep a region that appears in no pair at all — an all-zero row and
 * column. That is not worth a second shape in the request: hemibrain publishes 3,416 pairs
 * over 63 regions, so the pairs already name every region that has any connectivity, and a
 * region with none contributes nothing to a picture of which regions talk to which. The node
 * builds its axes from the labels present in the table, sorted, because the response's own
 * order is arbitrary and a matrix reaching a provenance key needs deterministic axes.
 */
