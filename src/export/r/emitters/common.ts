/** Expressions more than one R emitter needs. */

import type { EmitContext } from '../types'
import type { PopulationFilter, TableSchema } from '../../../core/types'
import { TRACED_STATUS, populationColumns } from '../../../data/neuronFilter'
import { carryable } from '../../../nodes/lib/carryParams'
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
 * The same ids as a Cypher list literal, for a query whose id placeholder the chunk fills when it
 * runs (`CYPHER_PLACEHOLDERS`). Pasted as they are: a Coda id is the digits already.
 */
export function cypherIdList(frame: string): string {
  return `paste0("[", paste(${neuronIds(frame)}, collapse = ","), "]")`
}

/**
 * Declare `coda_ids` and emit the call, wherever an emitter *mints* a Coda id column.
 *
 * The twin of the Python exporter's `codaIds`, and it exists for that one's reason: the frames
 * that arrive from neuprintr go through `coda_neurons`, but the ones the document builds itself
 * — an edge list, a label column read as ids — were typed by hand and each picked its own
 * answer. A Coda id column is `character` on every source, and R punishes a disagreement harder
 * than pandas does: `bind_rows` on `<double>` against `<character>` errors outright.
 *
 * **When to call it** is the Python twin's rule and is written there once rather than twice.
 * Where the two exporters differ is `neuron.inputIds`: Python's unwired branch needed this
 * because `pyLongIntList` mints an integer list for `NeuronCriteria`, where `rLongVector`
 * already emits `c("1001", …)` and there is nothing to convert.
 */
export function codaIds(ctx: EmitContext, frame: string, ...columns: string[]): string {
  ctx.helper('coda_ids')
  return `${frame} <- coda_ids(${frame}, ${columns.map(rStr).join(', ')})`
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

/**
 * Columns of a frame written onto a neuronlist's own metadata frame.
 *
 * Two callers, as in the Python seam: the `Carry fields` param, which passes its list and the id
 * column, and `neuron.attachAttributes`, which passes a picked list and a picked key.
 *
 * nat's answer to the same question, and a cleaner one than navis': a `neuronlist` carries a
 * `data.frame` beside its neurons, `nl[, ]` *is* that frame, and assigning a column to it is
 * `nl[, "name"] <- values`. So there is no reserved-name problem here — the frame is a plain
 * `data.frame`, and `type` is a column like any other where navis makes it a read-only property.
 * That is the second place these two exporters diverge on this node's behalf, and it is the
 * libraries' data models rather than a gap in either cell.
 *
 * `match(leftKeys, frame[[key]])` is the join: a neuronlist is named by body id as character,
 * which is what a Coda id column is on every source, and `match` answers `NA` for a neuron the
 * table upstream does not mention — Coda's left join exactly. Checked by running it: the columns
 * land on the frame, `NA` where unmatched, and they **survive subsetting**, so a Split Neurons
 * chunk downstream can filter on a carried column.
 *
 * The column filter is **`carryable`**, imported rather than restated: this function had its own
 * weaker filter (the right key only) and so assigned over the geometry's own id whenever a table
 * carried a `neuronId` of its own under `Attach Attributes`' every-column default. Neither golden
 * can discriminate that — no fixture table has both a `neuronId` and a different key — so the
 * predicate's own unit test is the pin. See `carryParams.test.ts`.
 */
export function carryLines(
  list: string,
  frame: string,
  carry: readonly string[],
  /** The frame column holding the ids, matched against `leftKeys`. */
  keyColumn: string,
  /**
   * The ids on the left: `names(nl)` for a neuronlist, a column for a frame.
   *
   * An argument because `Attach Attributes` also takes a **synapse cloud**, which is a
   * `data.frame` here rather than a neuronlist. Everything else is identical, `df[, "x"] <- v`
   * being the same assignment for both: it overwrites a column of that name **in place** and
   * appends a new one at the end, which is Coda's `foldNodeColumns` rule without this cell
   * having to state it. Not defaulted — a caller that can leave the join's left side unsaid is
   * one that can get it wrong without writing anything down.
   */
  leftKeys: string,
): string[] {
  const taken = carry.filter((name) => carryable(name, keyColumn))
  if (taken.length === 0) return []
  /*
   * `frame[[name]]` for the key rather than `neuronIds(frame)`: that helper spells `$neuronId`,
   * which is right where the name is fixed and wrong here, where a picked column may be called
   * anything and `$` partial-matches — `[[` is exact. One spelling for both callers rather than
   * a branch on whether the key happens to be the default, which moved two lines of the `Carry
   * fields` golden from `$neuronId` to `[["neuronId"]]`. Equivalent R, and the stricter of the two.
   *
   * The `match` is hoisted into `idx_` rather than repeated per column, which is what the first
   * version emitted: under the every-column default that was one hash build over the table's
   * whole key vector *per column*, and the key vector can be 165k long.
   */
  return [
    `idx_ <- match(${leftKeys}, ${frame}[[${rStr(keyColumn)}]])`,
    ...taken.map((name) => `${list}[, ${rStr(name)}] <- ${frame}[[${rStr(name)}]][idx_]`),
  ]
}
