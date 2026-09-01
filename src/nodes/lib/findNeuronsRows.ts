/**
 * Find Neurons' rows, as they are read off the node's params.
 *
 * One function, because four surfaces have to agree about what a saved node is asking: the
 * node's `validate`, its `evaluate`, the card that draws the rows, and both export emitters. A
 * second reading of the same params is how a notebook comes to filter differently from the
 * canvas it was exported from — and neither would be wrong on its own.
 *
 * ## The legacy half, and why it is not a migration
 *
 * Find Neurons used to carry five named params — `typePattern`, `instancePattern`, `status`,
 * `minSize`, `roi` — and four of them are rows now. Every saved graph still holds them, and so do
 * the starter graphs in `examples/starters.ts`, the export golden in `export/fixture.ts`, and
 * some fifty tests that build a node by writing `{ typePattern: 'LC.*' }` directly.
 *
 * A load-time migration would have caught the first of those and none of the rest: `addNode` and
 * `defaultParams` never go through `deserializeGraph`. So the legacy params stay **declared**,
 * and are folded into rows here instead. Two consequences worth stating:
 *
 *  - They must **not** be hidden behind `visibleIf`. `normalizeParams` drops a hidden param from
 *    the provenance key (invariant 4), so a `typePattern` that still reached `evaluate` while
 *    being invisible would let a stale result survive an edit to it. They are `advanced`, which
 *    hides them from the card without touching the key.
 *  - A node created today has empty legacy params and contributes no rows from them, which is
 *    what makes "a new Find Neurons filters nothing" true while every saved graph keeps the
 *    `status: Traced` it was built with.
 *
 * The card materialises legacy params into real rows the first time somebody edits the filters,
 * so a node converts by being used rather than by being loaded.
 */

import type { ParamValue, ParamValues } from '../../core/node'
import type { FilterRow } from '../../data/filterRows'
import { decodeRows } from '../../data/filterRows'

/**
 * The legacy params and what clearing one means, in one place.
 *
 * Both halves together, deliberately: the read side is `legacyRows` below and the write side is
 * the card's conversion, and having "which params" here while "what cleared means for each"
 * lived as a literal in the UI is one decision in two modules. These values are the definition's
 * declared defaults, and they have to stay that way — the params are in the provenance key
 * (invariant 4), so a converted node that cleared `minSize` to `''` rather than `0` would carry
 * a different cache key from an identical node that had never been converted.
 */
export const LEGACY_DEFAULTS = {
  typePattern: '',
  instancePattern: '',
  status: '',
  minSize: 0,
} as const satisfies Record<string, ParamValue>

/**
 * Rows implied by the five params Find Neurons used to have.
 *
 * Each maps to exactly the clause the old request field compiled to, so a saved graph returns
 * the same neurons it did before: `typePattern` was `n.type =~ …`, which is a whole-string match
 * (`matches`, anchored); `status` was `n.status IN [one]`, which is `is`; `minSize` was
 * `n.size >= …`, which is `ge`.
 *
 * Empty contributes nothing, which is what makes an unset legacy param and an absent one the
 * same thing — and they are not distinguishable, since `defaultParams` writes every default into
 * every node.
 */
export function legacyRows(params: ParamValues): FilterRow[] {
  const rows: FilterRow[] = []
  const text = (id: string) => String(params[id] ?? '')

  const typePattern = text('typePattern')
  if (typePattern) rows.push({ field: 'type', op: 'matches', values: [typePattern] })

  const instancePattern = text('instancePattern')
  if (instancePattern)
    rows.push({ field: 'instance', op: 'matches', values: [instancePattern] })

  const status = text('status')
  if (status) rows.push({ field: 'status', op: 'is', values: [status] })

  const minSize = Number(params.minSize ?? 0)
  if (Number.isFinite(minSize) && minSize > 0) {
    rows.push({ field: 'size', op: 'ge', values: [String(Math.floor(minSize))] })
  }

  return rows
}

/**
 * Every row this node is asking for: the legacy params first, then the stored ones.
 *
 * Legacy first so a converted card lists `type`, `instance`, `status`, `size` in the order the
 * five boxes had, and anything since appended after. Order is otherwise immaterial — rows are
 * ANDed — but it is what somebody reads, and it travels into the provenance key, so it needs to
 * be decided once rather than per caller.
 */
export function rowsFromParams(params: ParamValues): FilterRow[] {
  return [...legacyRows(params), ...decodeRows(params.filters)]
}
