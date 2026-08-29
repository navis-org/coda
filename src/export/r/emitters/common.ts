/** Expressions more than one R emitter needs. */

import type { EmitContext } from '../types'
import type { PopulationFilter, TableSchema } from '../../../core/types'
import { TRACED_STATUS, populationColumns } from '../../../data/neuronFilter'
import { rStr } from '../r'

/**
 * The neuron ids a Neurons input stands for.
 *
 * `$neuronId` rather than `[["neuronId"]]`: neuprintr returns data frames with a `bodyid`
 * column, so the *column name Coda uses* is the one to write — and `coda_neurons()` is what
 * guarantees it is there. A partial-match `$` cannot resolve `neuronId` to `bodyid`, unlike the
 * `bodyId`/`bodyid` pair this used to face, but the rule is the same and this is still one
 * expression in one place rather than written out per emitter.
 */
export function neuronIds(frame: string): string {
  return `${frame}$neuronId`
}

/** A viewer's `ids` selection param, as numbers. */
export function selectionIds(ctx: EmitContext, paramId = 'selection'): number[] {
  const raw = ctx.params[paramId]
  return Array.isArray(raw) ? raw.map(Number) : []
}

/**
 * A viewer's `ids` selection param, as **text**.
 *
 * The counterpart to `selectionIds` for the charts whose selection is a set of *labels* rather
 * than of neuron ids — a pie slice, a box. `Number` would turn `"KCg-m"` into `NaN`, and would
 * turn a category that happens to look numeric into a value that no longer matches the string
 * the canvas compared against (see `nodes/lib/chartSelection.ts`).
 */
export function selectionLabels(ctx: EmitContext, paramId = 'selection'): string[] {
  const raw = ctx.params[paramId]
  return Array.isArray(raw) ? raw.map((label) => String(label)) : []
}

/**
 * The population as one dplyr predicate, or empty.
 *
 * `|` between the disjuncts, and each parenthesised in full — R's `&` binds tighter than `|`, so
 * the unbracketed form happens to group correctly and stops doing so the first time somebody
 * edits a clause. Nobody re-derives operator precedence before trusting a row count.
 *
 * `!is.na(x) & x != ""` rather than `nzchar`, which errors on `NA` in older R and returns `NA`
 * in newer — and an `NA` inside `filter()` drops the row silently, which is the right answer
 * here by luck rather than by rule.
 */
export function rPopulationPredicate(
  filters: readonly PopulationFilter[],
  schema: TableSchema | undefined,
): string {
  const parts: string[] = []
  for (const filter of filters) {
    for (const name of populationColumns(filter, schema)) {
      parts.push(
        filter === 'traced'
          ? `(${name} == ${rStr(TRACED_STATUS)})`
          : `(!is.na(${name}) & ${name} != "")`,
      )
    }
  }
  return parts.join(' | ')
}
