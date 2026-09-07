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

/**
 * Declare `coda_ids` and emit the call, wherever an emitter *mints* a Coda id column.
 *
 * The twin of the Python exporter's `codaIds`, and it exists for that one's reason: the frames
 * that arrive from neuprintr go through `coda_neurons`, but the ones the document builds itself
 * — an edge list, a label column read as ids — were typed by hand and each picked its own
 * answer. A Coda id column is `character` on every source, and R punishes a disagreement harder
 * than pandas does: `bind_rows` on `<double>` against `<character>` errors outright.
 */
export function codaIds(ctx: EmitContext, frame: string, ...columns: string[]): string {
  ctx.helper('coda_ids')
  return `${frame} <- coda_ids(${frame}, ${columns.map(rStr).join(', ')})`
}

/**
 * A viewer's `ids` selection param, as **exact decimal text**.
 *
 * It answered `number[]` — `raw.map(Number)` — which is the same seam the Python exporter's
 * `selectionIds` was fixed at and which nobody had looked at here. Two things were wrong with
 * it, and the second only became wrong later. A stored id is a string of digits, so
 * `Number('720575940628857210')` is `…216`, a different neuron, written into a document with
 * nothing to say so — R makes that worse than Python does, since `c(7.2e17)` prints back in
 * scientific notation. And the id column every one of these is compared against is `character`
 * now on every source (invariant 8), so `filter(neuronId %in% c(1001))` matches nothing at all:
 * R compares a double against a character by coercing the *double*, and `"1001"` is not what
 * `as.character(1001)` gives for anything wide.
 *
 * `rVector` over these gives `c("1001", …)`, which is exact at any width and matches the column.
 */
export function selectionIds(ctx: EmitContext, paramId = 'selection'): string[] {
  const raw = ctx.params[paramId]
  return Array.isArray(raw) ? raw.map((id) => String(id)) : []
}

/**
 * A viewer's `selection` param read as **observation indices**, which is not a set of ids.
 *
 * `out.dendrogram` is the one node whose selection names *leaves* rather than neurons, and it has
 * now been a trap in both languages — see the Python twin. Here it was `selectionIds` answering
 * `number[]`, so `selection.map((i) => i + 1)` was arithmetic; the moment ids became text that
 * became JavaScript string concatenation, which type-checks and emitted `picked_ <- c(01, 21)`
 * for leaves 0 and 2: valid R, selecting the wrong leaf, and caught only by reading a golden diff.
 *
 * The type is the fix. `number[]` cannot be handed to `rVector`-of-ids and arithmetic on it means
 * arithmetic.
 */
export function selectionIndices(ctx: EmitContext, paramId = 'selection'): number[] {
  const raw = ctx.params[paramId]
  return Array.isArray(raw) ? raw.map(Number).filter(Number.isInteger) : []
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
