/**
 * What iterating a collection amounts to: how many passes, and what to call each one.
 *
 * **One statement, three callers**, and it is one because the three had already drifted. The node
 * answers `loopPlan` from an `EvalContext`; the card has to say "412 neurons" before anything has
 * run, and cannot build one; the canvas frame has to caption the same number. Each wrote the rule
 * out — `grouping ? groupKeys(…).length : elementCount(…)`, clamped by `limit` — and the third
 * copy read `params.groupBy` raw where the other two resolved it through the column machinery
 * (invariant 5). So a picker sitting on its declared default made the card say `412 groups` and
 * the frame around it say `0`, about the same node, at the same moment.
 *
 * Headless, in `src/nodes`, so the two UI surfaces can call it without either of them owning it.
 */

import type { GraphNode } from '../../core/graph'
import type { LoopPlan, ParamValues } from '../../core/node'
import { findParam, resolveColumn } from '../../core/node'
import { getNodeDef } from '../../core/registry'
import type { CodaType } from '../../core/types'
import type { Value } from '../../core/values'
import type { IterableValue } from '../lib/iterables'
import {
  elementCount,
  elementIdentity,
  elementsFrom,
  emptyElement,
  groupKeys,
  groupOf,
  isIterableValue,
} from '../lib/iterables'

/** No passes, and nothing to name — what an unwired or uniterable input amounts to. */
const NOTHING: LoopPlan = { count: 0, label: () => '', size: () => 0 }

/** Whether the node is dividing by element or by a column's values. */
export function isGroupMode(params: ParamValues): boolean {
  return String(params.mode ?? 'element') === 'group'
}

/**
 * How many elements one pass carries. At least 1; `1` is one-at-a-time.
 *
 * Group mode ignores it: a group is already however many elements share a value, and batching
 * groups on top of that is a second division of the same collection with nothing to distinguish
 * the two on screen.
 */
export function batchSize(params: ParamValues): number {
  if (isGroupMode(params)) return 1
  return Math.max(1, Math.floor(Number(params.batch ?? 1)))
}

/**
 * The division itself — how many elements there are to iterate, after `First N`.
 *
 * One function behind both halves below, because the count and the slice have to agree exactly:
 * a plan promising 21 passes over a collection the slicer runs out of at 20 leaves a pass
 * emitting nothing, named after an element that is not there. `tableOps`' schema/value pairing
 * for the same reason.
 */
function extent(params: ParamValues, value: Value | undefined, column: string | undefined) {
  if (!isIterableValue(value)) return undefined
  const limit = Math.max(0, Math.floor(Number(params.limit ?? 0)))
  const cap = (n: number) => (limit > 0 ? Math.min(limit, n) : n)

  if (isGroupMode(params)) {
    if (!column) return undefined
    // The key *is* the name here, which is the whole point of grouping — a pass labelled `LC4`
    // beats one labelled `element 12` in a progress line and in a filename alike.
    const keys = groupKeys(value, column).slice(0, cap(groupKeys(value, column).length))
    return { value, keys, column, elements: keys.length, batch: 1 }
  }
  // `First N` counts *elements*, not passes: "try it on the first ten" means ten neurons
  // whatever the batch size, which is what somebody setting both of them means.
  return { value, elements: cap(elementCount(value)), batch: batchSize(params) }
}

/**
 * The plan, from a resolved column rather than a raw param.
 *
 * `column` is what `ctx.column('groupBy')` answers — resolved, so an unset picker means its
 * declared default rather than "no column". Passing the raw param here is the drift this module
 * exists to stop, which is why it is a separate argument instead of being read off `params`.
 */
export function loopPlanFor(
  params: ParamValues,
  value: Value | undefined,
  column: string | undefined,
): LoopPlan {
  const at = extent(params, value, column)
  if (!at) return NOTHING

  if (at.keys) {
    const keys = at.keys
    return {
      count: keys.length,
      label: (i) => keys[i] ?? '',
      size: (i) => (keys[i] === undefined ? 0 : elementCount(groupOf(at.value, at.column!, keys[i]!))),
    }
  }

  const size = (i: number) => Math.max(0, Math.min(at.batch, at.elements - i * at.batch))
  return {
    count: Math.ceil(at.elements / at.batch),
    /*
     * `elementIdentity`, not `elementLabel` — see the note there. A loop over six neurons of one
     * cell type would otherwise name every pass `LC11`, which makes a progress line that never
     * changes and six files told apart only by their ordinal. The id is what differs.
     *
     * A batch is named by its first element and how many follow, because there is no one name
     * for twenty neurons and `1047553521 +19` is what somebody watching a progress bar can use.
     */
    label: (i) => {
      const first = elementIdentity(at.value, i * at.batch)
      const n = size(i)
      return n > 1 ? `${first} +${n - 1}` : first
    },
    size,
  }
}

/**
 * What pass `index` actually carries.
 *
 * The value half of `loopPlanFor`, deliberately beside it: `evaluate` and the plan divide the
 * same collection, and two spellings of that arithmetic is how a pass comes to emit a different
 * element from the one its progress line and its filename name — with nothing anywhere to say so.
 */
export function loopSliceFor(
  params: ParamValues,
  value: Value | undefined,
  column: string | undefined,
  index: number,
): IterableValue | undefined {
  const at = extent(params, value, column)
  if (!at) return undefined
  if (at.keys) {
    const key = at.keys[index]
    return key === undefined ? emptyElement(at.value) : groupOf(at.value, at.column!, key)
  }
  const start = index * at.batch
  // Past the end yields the empty collection rather than the nearest run, on `Select One`'s
  // rule: an upstream change that shrank the collection removed these elements, it did not
  // move them, and answering with whoever now occupies the position is a silent wrong answer.
  if (start >= at.elements) return emptyElement(at.value)
  return elementsFrom(at.value, start, Math.min(at.batch, at.elements - start))
}

/**
 * The same plan for a node the UI is drawing, resolving the column the way `evaluate` will.
 *
 * The extra hop exists so a card and a frame cannot resolve a picker differently from the node
 * they describe: `resolveColumn` is the one resolution invariant 5 names, and this is where the
 * two surfaces reach it without an `InferContext` between them.
 */
export function loopPlanOf(
  node: GraphNode,
  value: Value | undefined,
  inputTypes: Readonly<Record<string, CodaType | undefined>> = {},
): LoopPlan {
  return loopPlanFor(node.params, value, columnOf(node, inputTypes))
}

/** How `groupBy` resolves for a node the UI is drawing — one spelling, two surfaces. */
export function columnOf(
  node: GraphNode,
  inputTypes: Readonly<Record<string, CodaType | undefined>> = {},
): string | undefined {
  const def = getNodeDef(node.type)
  const param = def ? findParam(def, 'groupBy') : undefined
  return param?.kind === 'column'
    ? resolveColumn(param, node.params, inputTypes as Record<string, never>)
    : undefined
}
