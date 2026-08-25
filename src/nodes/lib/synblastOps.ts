/**
 * A synapse cloud in, the shape syNBLAST wants out.
 *
 * Headless and pure, `nblastOps.ts`'s arrangement and for its reason: vitest has no Pyodide
 * and jsdom has no `Worker`, so everything decidable without them is decided here, where a
 * test can see it. What is left on the other side of the seam is one call.
 *
 * ## The one structural difference from NBLAST
 *
 * NBLAST's input is a `SkeletonsValue`, which is already a *list of neurons* — one item, one
 * attribute row, one label. A `PointsValue` is not: it is one flat cloud of synapses with one
 * attribute row **per point**, and which neuron each point belongs to is a column. So the
 * first thing here is a group-by, and everything else follows from it:
 *
 * - **The neuron order is first appearance**, not sorted. The Synapses node returns its rows
 *   in whatever order the backend answered, which for both neuPrint and CAVE is neuron by
 *   neuron; sorting would reorder a matrix against the table it came from for no gain, and
 *   first-appearance is stable under a Filter upstream in a way a sort is not.
 * - **A neuron with no synapses has no group**, rather than an empty one — a point cloud
 *   cannot contain a neuron it has no points for. That is the opposite of the rule
 *   `dotpropSetFrom` follows, and the difference is real: there the item list *is* the
 *   neuron list and dropping one desynchronises the labels, whereas here the group list is
 *   built from the points and the labels are built from the same groups.
 * - **A null `neuronId` is its own group and is labelled as such.** Dropping those points
 *   would quietly change what a matrix is a comparison of; they are almost always a source
 *   that publishes orphan synapses, and one row called `(no id)` says so.
 */

import type { Warner } from '../../core/limits'
import { warnOverThreshold } from '../../core/limits'
import { idText } from '../../core/ids'
import type { PointsValue, TableValue } from '../../core/values'
import { getColumn, isPointsValue } from '../../core/values'
import type { Value } from '../../core/values'
import type { SynapseSet } from '../../pyodide/nblast'
import { NM_PER_UM, checkNblastSize, checkNblastSpaces, checkNblastUnits } from './nblastOps'

/** What a point with no `neuronId` is grouped under, and called. */
export const UNIDENTIFIED = '(no id)'

/**
 * Which connector type each polarity maps onto.
 *
 * fastcore wants a number, because `by_type` is an equality test inside a Rust kernel. Two
 * values are enough for every source Coda has: neuPrint and CAVE both publish `pre` / `post`
 * and nothing else. Anything unrecognised joins `pre` at 0 rather than opening a third group
 * of its own — a lone synapse in a group by itself matches nothing on the other side, which
 * is a zero contribution dressed up as a comparison.
 */
const POLARITY_TYPE: Record<string, number> = { pre: 0, post: 1 }

/** One neuron's points, and what to call it. */
export interface SynapseGroup {
  /** The `neuronId` cell as text, or `UNIDENTIFIED`. Invariant 8: an id is compared as text. */
  id: string
  /** Row indices into the point cloud, in the order they appeared. */
  rows: number[]
}

/**
 * The point cloud as one group per neuron, in first-appearance order.
 *
 * A `Map` keyed by the id **as text**, which is invariant 8 doing real work rather than
 * ceremony: a CAVE root id is eighteen digits, and `CellValue` is a float64, so two distinct
 * neurons whose ids differ in the last two digits are the same key once either has been
 * through a number. That is a matrix row silently comparing two neurons at once.
 */
export function groupSynapses(points: PointsValue): SynapseGroup[] {
  const ids = points.attributes.data['neuronId']
  const groups = new Map<string, SynapseGroup>()

  for (let row = 0; row < points.attributes.length; row++) {
    /*
     * Through `idText` rather than a `String(cell)` of its own, which is the whole of what
     * invariant 8 asks: it is the single definition of cell → id, and hand-rolling it here
     * diverged in two ways that both produce a *wrong matrix* rather than an error. It trims,
     * so a `str` column carrying `"7205…"` and `" 7205…"` is one neuron there and two rows
     * here. And it answers `null` for a number past `Number.MAX_SAFE_INTEGER`, where
     * `String(cell)` prints a confident wrong id as a row label — the digits are already gone
     * by then, so there is nothing to recover.
     */
    const id = idText(ids?.[row]) ?? UNIDENTIFIED
    const existing = groups.get(id)
    if (existing) existing.rows.push(row)
    else groups.set(id, { id, rows: [row] })
  }
  return [...groups.values()]
}

/**
 * Lay a set of synapse groups out flat, in micrometres.
 *
 * `dotpropSetFrom`'s shape with the tree swapped for a connector type. The micrometre
 * conversion is the same one and is not a preference — the FCWB matrix syNBLAST scores
 * through is the one NBLAST scores through, so nanometres score every pair as strangers,
 * uniformly, with nothing anywhere to say why. See `NM_PER_UM`.
 */
export function synapseSetFrom(
  points: PointsValue,
  groups: readonly SynapseGroup[],
  polarityColumn: string | undefined,
): SynapseSet {
  let total = 0
  for (const group of groups) total += group.rows.length

  const out = new Float32Array(total * 3)
  const types = new Int32Array(total)
  const offsets = new Int32Array(groups.length + 1)
  const polarity = polarityColumn ? getColumn(points.attributes, polarityColumn) : undefined

  let at = 0
  for (let g = 0; g < groups.length; g++) {
    for (const row of groups[g]!.rows) {
      out[at * 3] = points.positions[row * 3]! / NM_PER_UM
      out[at * 3 + 1] = points.positions[row * 3 + 1]! / NM_PER_UM
      out[at * 3 + 2] = points.positions[row * 3 + 2]! / NM_PER_UM
      types[at] = polarity ? (POLARITY_TYPE[String(polarity[row] ?? '')] ?? 0) : 0
      at++
    }
    offsets[g + 1] = at
  }
  return { points: out, types, offsets }
}

/**
 * What to call each row: the picked column, falling back to the neuron id.
 *
 * A group is many rows, so the column has to be read at *one* of them — the first, which is
 * the only choice that does not depend on a sort nobody asked for. A `type` column is
 * constant within a neuron by construction, so the choice is invisible where it is used as
 * intended and predictable where it is not.
 */
export function synapseLabels(
  points: PointsValue,
  groups: readonly SynapseGroup[],
  column: string | undefined,
): string[] {
  const values = column ? getColumn(points.attributes, column) : undefined
  return groups.map((group) => {
    const cell = values?.[group.rows[0]!]
    return cell === null || cell === undefined || cell === '' ? group.id : String(cell)
  })
}

/**
 * Where a comparison starts saying how long it will be, counted in synapses rather than pairs.
 *
 * syNBLAST's cost is not NBLAST's. There are no tangent vectors to fit and no resampling, and
 * the scoring is a nearest-neighbour query per connector — so the work is proportional to the
 * *synapse* count on each side, not to the neuron count, and the two are only loosely related:
 * a hundred hemibrain neurons is anywhere between two thousand and two hundred thousand
 * synapses depending entirely on which hundred.
 *
 * Which is why the neuron-count warning `nblastSidesFrom` applies is kept as well as this one
 * rather than replaced by it: a user who wired a whole dataset in wants told that, and a user
 * who wired in twelve enormous neurons wants told this.
 */
const SYNAPSE_WARN = 500_000

export function checkSynblastSize(ctx: Warner, query: number, target: number): void {
  const total = query + target
  if (total <= SYNAPSE_WARN) return
  ctx.warn(
    `Comparing ${query.toLocaleString()} synapses against ${target.toLocaleString()} is a ` +
      `nearest-neighbour search per connector, single-threaded in the browser. Scoring ` +
      `anyway — cancel and filter the synapses down (by polarity, by weight, or to a region) ` +
      `if that is not what you meant.`,
  )
}

/**
 * Read both sides of a syNBLAST: refuse what must not reach the runtime, say what the rest
 * costs, and hand back the groups both halves are built from.
 *
 * `nblastSidesFrom`'s job and, deliberately, not a branch inside it. The four questions are
 * the same four — is this the right kind of value, is it empty, is it big, is it in
 * nanometres — but every answer is about a different thing: groups rather than items,
 * synapses rather than points, and the **Synapses** node rather than the Skeletons node in
 * the message that says where to look. A shared function with a mode flag would be one
 * function answering as two.
 */
export function synblastSidesFrom(
  ctx: Warner,
  queryValue: Value | undefined,
  targetValue: Value | undefined,
  limit: number,
): { query: PointsValue; queryGroups: SynapseGroup[]; target?: PointsValue; targetGroups?: SynapseGroup[] } {
  if (!isPointsValue(queryValue)) {
    throw new Error('Query input is not a set of points — wire a Synapses node into it.')
  }
  if (targetValue !== undefined && !isPointsValue(targetValue)) {
    throw new Error('Target input is not a set of points — wire a Synapses node into it.')
  }

  const queryGroups = groupSynapses(queryValue)
  if (queryGroups.length === 0) throw new Error('No synapses on the Query input')
  const targetGroups = targetValue ? groupSynapses(targetValue) : undefined
  if (targetGroups && targetGroups.length === 0) {
    throw new Error('The Target input has no synapses on it')
  }

  checkNblastUnits('Query', queryValue, 'synapses', 'Synapses')
  if (targetValue) {
    checkNblastUnits('Target', targetValue, 'synapses', 'Synapses')
    checkNblastSpaces(queryValue, targetValue, 'synapses')
  }

  const rows = queryGroups.length
  const cols = targetGroups?.length ?? rows
  // The matrix is the same shape and costs the same to hold, so the same allocation floor and
  // the same neuron-count sentence apply — reused rather than restated.
  checkNblastSize(ctx, rows, cols)
  // Through `warnOverThreshold` for the reason `nblastSidesFrom`'s own `saySo` is: the house
  // sentence's closing clause says there will still be a result, and these messages were
  // refusals for most of Coda's life. Two sibling nodes phrasing it two ways is how that
  // clause gets dropped from one of them.
  if (rows > limit || cols > limit) {
    warnOverThreshold(ctx, {
      count: Math.max(rows, cols),
      threshold: limit,
      unit: 'neurons',
      control: "this node's Warn above",
      cost: 'The matrix grows with the product of the two sides.',
    })
  }
  checkSynblastSize(
    ctx,
    queryValue.attributes.length,
    targetValue?.attributes.length ?? queryValue.attributes.length,
  )

  return {
    query: queryValue,
    queryGroups,
    ...(targetValue && targetGroups ? { target: targetValue, targetGroups } : {}),
  }
}

/**
 * Whether a point cloud can tell a presynapse from a postsynapse.
 *
 * `by_type` on a cloud that cannot is not wrong so much as *empty*: every connector lands in
 * group 0 and the type test passes for every pair, which is exactly `by_type=False` wearing a
 * label that says otherwise. The node hides the control rather than leaving it on and inert.
 */
export function hasPolarity(attributes: TableValue | undefined, column: string | undefined): boolean {
  return Boolean(column && attributes && column in attributes.data)
}
