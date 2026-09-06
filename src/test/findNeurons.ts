/**
 * Find Neurons params for an ordinary query, as a test wants to spell one.
 *
 * Some fifty test files configure this node, and until the legacy params were removed nearly all
 * of them did it by writing `{ typePattern: 'LC.*', status: 'Traced' }` — four scalars that the
 * node folded into filter rows on the way past. The rows are the only spelling now, and written
 * out inline each of those becomes six lines of JSON-shaped literal for what is conceptually
 * "LC-something, traced".
 *
 * So this is that fold, kept on the test side. It emits **exactly** the rows `legacyRows` used
 * to — `type` as an anchored `matches`, `status` as `is`, in that order — which is what made the
 * conversion of those fifty files auditable: a test asking `searchFor({ type: 'LC.*', status:
 * 'Traced' })` asks for the same neurons, in the same order, under the same provenance key as the
 * `{ typePattern, status }` it replaced. Only those two of the four legacy scalars are spelled
 * here, because only those two were ever written: `instancePattern` and `minSize` appear in no
 * call site, and mirroring them would keep two deleted params alive in a type nobody instantiates.
 *
 * **Deliberately not production code.** The node has one way to say a query and it is the rows;
 * a helper in `src/nodes` that assembled them from four named scalars would be the removed
 * params growing back with a different spelling, which is what invariant 8 calls a shim. What
 * justifies it here is that a test's subject is almost never the query — it is the chart, the
 * layout, the scheduler — and the query is scaffolding those files should not each re-derive.
 */

import { ID_COLUMN_NAME } from '../core/ids'
import { encodeRows } from '../data/filterRows'
import type { FilterRow } from '../data/filterRows'

export interface SearchSpec {
  /** Anchored whole-string pattern on `type`, as the old `typePattern` was. */
  type?: string
  /** Exact match on `status`. */
  status?: string
}

/** A spec as the `filters` param, ready to spread into a node's params. */
export function searchFor(spec: SearchSpec): { filters: string[] } {
  const rows: FilterRow[] = []
  if (spec.type) rows.push({ field: 'type', op: 'matches', values: [spec.type] })
  if (spec.status) rows.push({ field: 'status', op: 'is', values: [spec.status] })
  return { filters: encodeRows(rows) }
}

/**
 * A row every neuron satisfies, for a test that wants the whole dataset.
 *
 * Its own function because it is a different statement from `searchFor({})`, which asks nothing
 * and under `asksNothing` therefore returns nothing. "Everything" has to be said out loud now,
 * and a test saying it should look like it meant to.
 */
export function everyNeuron(): { filters: string[] } {
  // `ID_COLUMN_NAME`, not the literal — invariant 8's rule, and `wizard/build.ts` builds the
  // same row from the same constant.
  return { filters: encodeRows([{ field: ID_COLUMN_NAME, op: 'notEmpty', values: [] }]) }
}
