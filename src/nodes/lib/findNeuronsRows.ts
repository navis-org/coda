/**
 * Find Neurons' rows, as they are read off the node's params.
 *
 * One function, because four surfaces have to agree about what a saved node is asking: the
 * node's `validate`, its `evaluate`, the card that draws the rows, and both export emitters. A
 * second reading of the same params is how a notebook comes to filter differently from the
 * canvas it was exported from — and neither would be wrong on its own.
 *
 * ## What used to be here, and why deleting it was the right end
 *
 * Find Neurons carried five named params before the row model — `typePattern`, `instancePattern`,
 * `status`, `minSize`, `roi` — and four of them were folded into rows here, on the way past. That
 * fold was a **bridge, not a design**: it was chosen over a load-time migration because `addNode`
 * and `defaultParams` never go through `deserializeGraph`, so a migration would have caught saved
 * files and missed the starter graphs, the export golden, and some fifty tests that built the node
 * by writing `{ typePattern: 'LC.*' }` directly.
 *
 * Those fifty were the actual cost, and they are the reason the bridge could be removed without
 * one: every one of them has been rewritten to say what it means in rows (`test/findNeurons.ts`),
 * which is the migration the load-time version could not perform. What is left uncrossable is a
 * `.coda.json` or a share link written by an alpha build. Those arrive with four keys no
 * definition declares, `normalizeParams` reads only declared params, and the node is therefore an
 * unfiltered one — which since `asksNothing` means it returns **no neurons and says so**, rather
 * than silently querying a whole connectome. That is the failure worth having, and it is why the
 * order of the two changes mattered.
 *
 * The one param that never was a row is `roi`, and it never can be: a region is not a column. It
 * stays on the node, and `asksNothing` below is where it is read alongside the rows.
 */

import type { ParamValues } from '../../core/node'
import type { FilterRow } from '../../data/filterRows'
import { decodeRows } from '../../data/filterRows'

/**
 * Every row this node is asking for.
 *
 * A thin read of one param today, and kept as a named function rather than inlined at each call
 * site for the reason the header gives: the value of this file is that six readers cannot come to
 * disagree about what a stored node asks. `decodeRows` spread across `evaluate`, `validate`, the
 * card and two emitters is five chances for one of them to grow a condition.
 */
export function rowsFromParams(params: ParamValues): FilterRow[] {
  return decodeRows(params.filters)
}

/**
 * What kind of question this node is asking, in one word.
 *
 * **`nothing` means it answers with no neurons**, which is the opposite of what an empty `rows`
 * means at the seam — and the asymmetry is the design. `FindNeuronsRequest.rows` being empty
 * means *no narrowing*, because that is what `neuronIndex` and Explore need from the same method:
 * a source honours it and returns the dataset. The node is the layer where somebody's half-built
 * card is, and an unconfigured card is not a request for all 176,422 neurons of hemibrain. So the
 * decision sits here, one call above the seam, and nothing about the seam changes: no source
 * learns this rule, and every other caller of `findNeurons` goes on meaning what it meant.
 *
 * **`In ROI` counts.** It is not a row — a region is not a column — but it is a question, and a
 * card set to `In ROI: LO(R)` is visibly asking one. A rule that read only the rows would answer
 * that card empty, which is this node's own worst failure shape: a count that looks like an
 * answer. **`Limit` does not**: a cap is not a question about *which* neurons, "the first 100 of
 * everything" being an arbitrary sample of whatever order the backend returned, and Explore
 * Dataset is the surface for looking at a dataset without asking it anything.
 *
 * Three answers rather than the boolean this started as, because the **card has to name which
 * clause fired** — a region-only node queries and must not be labelled "no neurons". It was
 * reconstructing that from `asksNothing() === false && rows.length === 0`, which is a second
 * reading of the same params one level up, the thing this file exists to forbid. It also fails
 * silently the day a third non-row question is added: a card with no region set would read
 * "region only".
 *
 * `rows` is optional so a caller that has already decoded them does not pay for it twice — the
 * card memoises them for its own drawing, and `evaluate` needs them for the request.
 */
export function askShape(
  params: ParamValues,
  rows: readonly FilterRow[] = rowsFromParams(params),
): 'nothing' | 'regionOnly' | 'rows' {
  if (rows.length > 0) return 'rows'
  return String(params.roi ?? '') === '' ? 'nothing' : 'regionOnly'
}

/**
 * Whether this node is asking for nothing at all — in which case it answers with no neurons.
 *
 * The half of `askShape` that four surfaces read: `evaluate` returns an empty table, the card's
 * foot line says which of the two things "no filters" now means, and both exporters emit an empty
 * frame rather than a query. A second reading of this is how a notebook comes to fetch a
 * connectome the canvas did not.
 */
export function asksNothing(
  params: ParamValues,
  rows: readonly FilterRow[] = rowsFromParams(params),
): boolean {
  return askShape(params, rows) === 'nothing'
}

/**
 * Why such a node returns nothing, as one sentence four surfaces render.
 *
 * The node says it through `ctx.warn`, and both exporters write it into a NOTE above the empty
 * frame they emit — so it is `synapseUnitRefusal`'s arrangement, and for its reason: written out
 * per surface, the three copies had already drifted in the clause that carries the meaning. The
 * remedy differs per surface, so each appends its own.
 */
export function noFiltersReason(): string {
  return 'This Find Neurons has no filters, so it returns no neurons rather than the whole dataset.'
}
