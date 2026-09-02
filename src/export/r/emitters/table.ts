/**
 * The table transforms, in dplyr.
 *
 * Same standard as the pandas emitters: where Coda's semantics differ from the library's
 * default, the chunk says so in code rather than in a comment. The three that cost a row count
 * if missed are the same three, and each is marked where it is handled.
 */

import type { CellValue } from '../../../core/values'
import type { DType } from '../../../core/types'
import { isNumericDType } from '../../../core/types'
import { decodeSetters, disabledEditNote, editPlan } from '../../../nodes/lib/tableEdits'
import { usesRegex } from '../../../nodes/lib/tableFilter'
import { filterPredicates } from './tableFilters'
import type { AggFn } from '../../../nodes/lib/tableOps'
import {
  aggColumnName,
  combineLayout,
  relabelTarget,
  renameMapping,
} from '../../../nodes/lib/tableOps'
import { unpivotPlan } from '../../../nodes/lib/tableOps'
import { readUnpivotSpec } from '../../../nodes/table/unpivot'
import { decodeRenames } from '../../../nodes/lib/renames'
import { rCol, rStr, rValue, rVector } from '../r'
import { STACK_LABELS } from '../../../nodes/transform/stackNeurons'
import { qualifyTarget } from '../../../nodes/table/qualifyIds'
import { registerEmitter } from '../registry'
import type { EmitContext } from '../types'

/** The short local name this file uses forty times over. The rule itself is `rCol`. */
const col = rCol

/**
 * Coda's comparison operators as R's.
 *
 * Shared with `tableFilters.ts`, whose `FieldTerm['op']` overlaps `FilterOp` on exactly these
 * six names — two copies is how the Filter node and the Table's header cells come to render
 * the same comparison differently in one document.
 */
export const R_COMPARISON: Record<string, string> = {
  eq: '==',
  ne: '!=',
  gt: '>',
  ge: '>=',
  lt: '<',
  le: '<=',
}

function dtypeOf(ctx: EmitContext, portId: string, name: string | undefined) {
  return name ? ctx.schema(portId)?.columns.find((c) => c.name === name)?.dtype : undefined
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

/**
 * A Coda filter operator as a `dplyr::filter` predicate on a bare column name.
 *
 * `pyFilterMask`'s twin, in every respect including the return shape — see its docstring for why
 * the notes and the failure reason are carried in the value rather than through an out-param and
 * a re-derivation. This side is where that bit: `net.filter` passed `[]` and dropped the
 * POSIX-ERE caveat its Python twin prints, so one node's two exporters disagreed about whether a
 * regex needed a warning.
 */
export type FilterPredicate =
  | { predicate: string; notes: readonly string[] }
  | { predicate?: undefined; reason: string }

export function rFilterPredicate(
  name: string,
  op: string,
  raw: string,
  numeric: boolean,
): FilterPredicate {
  const c = col(name)
  const ok = (predicate: string, notes: readonly string[] = []): FilterPredicate => ({
    predicate,
    notes,
  })
  switch (op) {
    case 'isEmpty':
      return ok(`is.na(${c}) | ${c} == ""`)
    case 'notEmpty':
      return ok(`!is.na(${c}) & ${c} != ""`)
    case 'isTrue':
      return ok(`${c} %in% TRUE`)
    case 'isFalse':
      return ok(`${c} %in% FALSE`)
    case 'contains':
      return ok(`grepl(${rStr(raw)}, ${c}, fixed = TRUE)`)
    case 'notContains':
      return ok(`!grepl(${rStr(raw)}, ${c}, fixed = TRUE)`)
    case 'startsWith':
      return ok(`startsWith(as.character(${c}), ${rStr(raw)})`)
    case 'endsWith':
      return ok(`endsWith(as.character(${c}), ${rStr(raw)})`)
    case 'matches':
      return ok(`grepl(${rStr(raw)}, ${c})`, [
        'Coda matches this regex with JavaScript semantics; R uses POSIX ERE by default. ' +
          'They agree on ordinary patterns — add perl = TRUE for lookaround.',
      ])
    default: {
      const operator = R_COMPARISON[op]
      if (!operator) return { reason: `Unknown filter operator "${op}".` }
      if (numeric) {
        const target = Number(raw)
        if (!Number.isFinite(target)) return { reason: `"${raw}" is not a number.` }
        return ok(`${c} ${operator} ${rValue(target)}`)
      }
      // Coda reads a null cell as the empty string, so `!= x` keeps the unlabelled rows. R's NA
      // propagates through the comparison and `filter` drops it, which silently shrinks the
      // result — `coalesce` is what reproduces Coda.
      return ok(`coalesce(as.character(${c}), "") ${operator} ${rStr(raw)}`)
    }
  }
}

registerEmitter('core.filterTable', (ctx) => {
  const src = ctx.wired('in')
  const name = ctx.column('column')
  if (!name) return ctx.todo('No column is chosen on this Filter Table.')

  ctx.library('dplyr')
  const out = ctx.output('out')
  const op = String(ctx.params.op ?? 'ge')
  const raw = String(ctx.params.value ?? '')
  const numeric = isNumericDType(dtypeOf(ctx, 'in', name) ?? 'str')

  const built = rFilterPredicate(name, op, raw, numeric)
  if (built.predicate === undefined) return ctx.todo(built.reason)

  const lines = built.notes.flatMap((note) => ctx.note(note))
  lines.push(`${out} <- ${src} |> filter(${built.predicate})`)
  return lines
})

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

registerEmitter('core.sort', (ctx) => {
  const src = ctx.wired('in')
  const name = ctx.column('column')
  if (!name) return ctx.todo('No column is chosen on this Sort.')

  ctx.library('dplyr')
  const out = ctx.output('out')
  const descending = ctx.params.descending === true
  const limit = Number(ctx.params.limit ?? 0)
  const lines: string[] = []

  if (!isNumericDType(dtypeOf(ctx, 'in', name) ?? 'str')) {
    lines.push(
      ...ctx.note(
        'Coda sorts text with numeric-aware collation, so "item2" comes before "item10". ' +
          "R uses the session's locale collation, which orders that pair the other way.",
      ),
    )
  }

  // `arrange` already puts NA last in both directions, which is Coda's rule: a null is
  // absence, not an extreme, so it does not migrate to the top when the sort is reversed.
  lines.push(`${out} <- ${src} |> arrange(${descending ? `desc(${col(name)})` : col(name)})`)
  if (limit > 0) lines.push(`${out} <- ${out} |> head(${limit})`)
  return lines
})

// ---------------------------------------------------------------------------
// Select / Select One
// ---------------------------------------------------------------------------

registerEmitter('core.select', (ctx) => {
  const src = ctx.wired('in')
  ctx.library('dplyr')
  const names = ctx.columns('columns')
  const out = ctx.output('out')
  if (names.length === 0) {
    return [
      ...ctx.note('No columns picked, which Coda reads as "keep them all".'),
      `${out} <- ${src}`,
    ]
  }
  // `all_of` so a missing column is an error rather than a silently narrower table.
  return [`${out} <- ${src} |> select(all_of(${rVector(names)}))`]
})

registerEmitter('core.selectOne', (ctx) => {
  const src = ctx.wired('in')
  ctx.library('dplyr')
  const index = Number(ctx.params.selected ?? ctx.params.index ?? 0)
  // R is 1-based, and this is exactly the sort of off-by-one that produces a valid answer
  // about the wrong row.
  return [`${ctx.output('item')} <- ${src} |> slice(${index + 1})`]
})

// ---------------------------------------------------------------------------
// Deduplicate
// ---------------------------------------------------------------------------

registerEmitter('core.dedupe', (ctx) => {
  const src = ctx.wired('in')
  const out = ctx.output('out')
  const names = ctx.columns('columns')
  const keep = String(ctx.params.keep ?? 'first')

  /*
   * Base R's `duplicated()` rather than `dplyr::distinct()`, which is the house verb everywhere
   * else in this file. Three reasons, and they only apply to this node:
   *
   *  - `distinct()` keeps the **first** row of a set and has no argument for the other two.
   *    `duplicated(..., fromLast = TRUE)` is exactly Coda's `last`, and OR-ing the two directions
   *    is exactly `none` — one idiom covering all three, against a `group_by`/`slice`/`arrange`
   *    contortion for the second.
   *  - It **preserves row order**, where grouping reorders rows into group order. A dedupe that
   *    also reordered would be two operations wearing one name, and the difference is invisible
   *    until something downstream depends on the order.
   *  - It needs no library at all, so this chunk is honest about depending on nothing.
   */
  const subject = names.length > 0 ? `${src}[${rVector(names)}]` : src
  if (keep === 'none') {
    // Both directions: a row is dropped when anything before *or* after it matches, which leaves
    // only the rows that were already unique.
    return [
      `${out} <- ${src}[!(duplicated(${subject}) | duplicated(${subject}, fromLast = TRUE)), ]`,
    ]
  }
  const fromLast = keep === 'last' ? ', fromLast = TRUE' : ''
  return [`${out} <- ${src}[!duplicated(${subject}${fromLast}), ]`]
})

// ---------------------------------------------------------------------------
// Combine Columns
// ---------------------------------------------------------------------------

registerEmitter('core.combineColumns', (ctx) => {
  const src = ctx.wired('in')
  const out = ctx.output('out')
  const columns = ctx.columns('columns')
  const into = String(ctx.params.into ?? '').trim()
  const sourceColumn = String(ctx.params.sourceColumn ?? '').trim()
  if (!into || columns.length === 0) {
    // Not configured, and the node passes its input through in exactly that case.
    return [`${out} <- ${src}`]
  }

  ctx.helper('coda_combine')

  /*
   * A column already holding the result's name is renamed rather than overwritten — the node's
   * own rule, and the opposite of what `df[[name]] <- ...` does. Taken from `combineLayout`, the
   * same function the node's own halves use, rather than reconstructed by diffing
   * `combineSchema`'s output positionally; an unknown input schema predicts nothing and the
   * assignment lands as base R would have it.
   */
  const inNames = ctx.schema('in')?.columns.map((c) => c.name) ?? []
  const layout = combineLayout(inNames, { columns, into, sourceColumn })
  const renamed = inNames.flatMap((name, i) =>
    layout.renamed[i] === name ? [] : [[name, layout.renamed[i]!] as const],
  )

  const lines = [`${out} <- ${src}`]
  for (const [from, to] of renamed) {
    lines.push(`names(${out})[names(${out}) == ${rStr(from)}] <- ${rStr(to)}`)
  }
  lines.push(`${out}[[${rStr(into)}]] <- coda_combine(${src}, ${rVector(columns)})`)
  if (sourceColumn) {
    const name = layout.sourceName ?? sourceColumn
    lines.push(
      `${out}[[${rStr(name)}]] <- coda_combine(${src}, ${rVector(columns)}, source = TRUE)`,
    )
  }
  return lines
})

// ---------------------------------------------------------------------------
// Relabel
// ---------------------------------------------------------------------------

/**
 * One column rewritten through a mapping table. `coda_relabel` carries every rule — see the
 * helper for which of them base R gets wrong, and `emitters/table.ts` in Python for the same
 * call one language over.
 *
 * The target name is `relabelTarget`'s, not the helper's fallback: `df[[name]] <- ...`
 * overwrites a column of that name where Coda suffixes.
 */
registerEmitter('core.relabel', (ctx) => {
  const src = ctx.wired('in')
  const map = ctx.wired('map')
  const column = ctx.column('column')
  const keyColumn = ctx.column('keyColumn')
  const valueColumn = ctx.column('valueColumn')
  if (!column || !keyColumn || !valueColumn) {
    return ctx.todo('This Relabel has no column chosen on one side.')
  }

  ctx.helper('coda_relabel')
  const out = ctx.output('out')
  const unmatched = String(ctx.params.unmatched ?? 'null')
  const target = relabelTarget(ctx.schema('in'), column, String(ctx.params.into ?? ''))
  return [
    `${out} <- coda_relabel(${src}, ${rStr(column)}, ${map}, ${rStr(keyColumn)}, ` +
      `${rStr(valueColumn)}, into = ${rStr(target)}, unmatched = ${rStr(unmatched)})`,
  ]
})

// ---------------------------------------------------------------------------
// Group By
// ---------------------------------------------------------------------------

/** `coda_join` is generated: `paste(collapse=)` alone keeps NAs and empty strings. */
const AGG_FUNCS: Record<AggFn, string> = {
  sum: 'sum',
  mean: 'mean',
  min: 'min',
  max: 'max',
  count: 'n',
  countDistinct: 'n_distinct',
  join: 'coda_join',
}

registerEmitter('core.groupBy', (ctx) => {
  const src = ctx.wired('in')
  const by = ctx.columns('by')
  if (by.length === 0) return ctx.todo('No group-by columns are chosen.')

  ctx.library('dplyr')
  const out = ctx.output('out')
  const agg = String(ctx.params.agg ?? 'sum') as AggFn
  const values = agg === 'count' ? [] : ctx.columns('value')
  if (agg !== 'count' && values.length === 0) {
    return ctx.todo(`"${agg}" needs at least one value column.`)
  }
  if (agg === 'join') ctx.helper('coda_join')

  // `n` rides along with every aggregation, exactly as the node emits it, and one summary per
  // value column beside it. Written out rather than reached through `across()`: the names Coda
  // publishes are `<agg>_<column>`, which is `.names = "{.fn}_{.col}"` only as long as the
  // function is passed under exactly that name — a spelling `across` would silently vary.
  const aggs = ['n = n()']
  for (const value of values) {
    aggs.push(`${col(aggColumnName(agg, value))} = ${AGG_FUNCS[agg]}(${col(value)})`)
  }

  return [
    // `.groups = "drop"` because a silently grouped result changes what every later verb does.
    `${out} <- ${src} |>`,
    `  group_by(${by.map(col).join(', ')}) |>`,
    `  summarise(${aggs.join(', ')}, .groups = "drop")`,
  ]
})

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------

/**
 * `rename(any_of(...))` rather than `rename(new = old)`, and that is not a style choice: bare
 * `rename` **errors** on a column the frame does not carry, where Coda's rule is that such a
 * row renames nothing. `any_of` is the tidyselect form that renames what is there and passes
 * over what is not, which is the same tolerance `df.rename(columns=...)` has in pandas.
 *
 * The named vector reads backwards from Coda's rows on purpose — tidyselect spells it
 * `new = "old"`, where `renameMapping` answers `[from, to]`. Note also that the mapping is
 * resolved against the incoming schema first, so a collision comes out as the suffix Coda
 * applies rather than as `rename`'s "Names must be unique" error.
 */
registerEmitter('core.rename', (ctx) => {
  const src = ctx.wired('in')
  const pairs = renameMapping(ctx.schema('in'), decodeRenames(ctx.params.renames))
  ctx.library('dplyr')
  const out = ctx.output('out')

  // An unconfigured Rename is a pass-through on the canvas, so it is one here.
  if (pairs.length === 0) return [`${out} <- ${src}`]

  /*
   * Joined rather than one entry per line, which is what `select(all_of(...))` above already
   * does — and here it is load-bearing as well as consistent. Python takes a trailing comma in
   * a dict and R does **not** take one in `c()`: `c(a = 1,)` is `argument 2 is empty`, a parse
   * error in a document knitr aborts on rather than a stylistic wart. Verified against R 4.4,
   * since the same shape one file over is perfectly legal. `join` cannot produce one at all,
   * where a per-line index test is a hand-rolled separator somebody has to check is not off by
   * one.
   */
  const entries = pairs.map(([from, to]) => `${col(to)} = ${rStr(from)}`)
  return [`${out} <- ${src} |>`, `  rename(any_of(c(${entries.join(', ')})))`]
})

// ---------------------------------------------------------------------------
// Join / Stack
// ---------------------------------------------------------------------------

registerEmitter('core.join', (ctx) => {
  const left = ctx.wired('left')
  const right = ctx.wired('right')
  const leftKey = ctx.column('leftKey')
  const rightKey = ctx.column('rightKey')
  if (!leftKey || !rightKey) return ctx.todo('This Join has no key column on one side.')

  ctx.library('dplyr')
  const out = ctx.output('out')
  const how = String(ctx.params.how ?? 'left')
  const suffix = String(ctx.params.suffix ?? '_r')
  const verb =
    { left: 'left_join', inner: 'inner_join', outer: 'full_join', right: 'right_join' }[how] ??
    'left_join'

  /*
   * Which side is deduplicated flips with the direction, and getting it wrong costs a row count
   * rather than an error. `left`/`inner`/`outer` match *into* the right, so the right is the
   * side a duplicated key would multiply; `right` is the mirror, and thinning the right there
   * would drop rows a right join is defined to keep.
   */
  const distinct = (frame: string, key: string) =>
    `${frame} |> distinct(${col(key)}, .keep_all = TRUE)`

  return [
    ...ctx.note(
      'Coda keeps the first matching row from the other table, so a duplicated key annotates ' +
        'rather than multiplies. `distinct` is what reproduces that — without it the join ' +
        'returns every matching pair.',
    ),
    /*
     * The one place R is the closer of the two languages, so it is worth saying which way
     * round that is: `join_by(a == b)` publishes a *single* key column, coalesced from both
     * sides, which is exactly what `joinTables` does and what the pandas cell has to rebuild
     * by hand.
     */
    ...(how === 'right'
      ? ctx.note(
          'Row **order** differs here, and only here. Coda emits one row per right-table row ' +
            "in the right table's order; dplyr 1.2 puts the matched rows in the left table's " +
            'order and the unmatched right rows after them. Measured against both rather than ' +
            'surmised — the rows themselves are identical — so add an `arrange()` only if ' +
            'something downstream depends on the order.',
        )
      : []),
    `${out} <- ${how === 'right' ? distinct(left, leftKey) : left} |>`,
    `  ${verb}(`,
    `    ${how === 'right' ? right : distinct(right, rightKey)},`,
    `    by = join_by(${col(leftKey)} == ${col(rightKey)}),`,
    `    suffix = c("", ${rStr(suffix)})`,
    `  )`,
  ]
})

/**
 * Two data frames end to end: `core.stack`'s whole body, and the points branch of
 * `neuron.stack`.
 *
 * Shared rather than copied, because the copy had drifted three ways — `rbind` for
 * `bind_rows`, which errors outright on frames whose columns differ where the node null-fills;
 * a bare column name where `col()` quotes one that needs it; and no `ctx.library('dplyr')` at
 * all. Each of the three is invisible until somebody runs the document.
 */
function stackFrames(
  ctx: EmitContext,
  top: string,
  bottom: string,
  labels: { source: string; top: string; bottom: string },
): string[] {
  ctx.library('dplyr')
  const out = ctx.output('out')
  // `bind_rows` unions the columns and fills the gaps with NA, which is what the node does —
  // a column only one side carries is not recorded for the other's rows.
  if (!labels.source) return [`${out} <- bind_rows(${top}, ${bottom})`]
  return [
    `${out} <- bind_rows(`,
    `  ${top} |> mutate(${col(labels.source)} = ${rStr(labels.top)}),`,
    `  ${bottom} |> mutate(${col(labels.source)} = ${rStr(labels.bottom)})`,
    `)`,
  ]
}

registerEmitter('core.stack', (ctx) =>
  stackFrames(ctx, ctx.wired('top'), ctx.wired('bottom'), {
    source: String(ctx.params.sourceColumn ?? ''),
    top: String(ctx.params.topLabel ?? 'Top'),
    bottom: String(ctx.params.bottomLabel ?? 'Bottom'),
  }),
)

// ---------------------------------------------------------------------------
// Sample
// ---------------------------------------------------------------------------

registerEmitter('core.sample', (ctx) => {
  const src = ctx.wired('in')
  ctx.library('dplyr')
  const out = ctx.output('out')
  const mode = String(ctx.params.mode ?? 'head')
  const count = Number(ctx.params.count ?? 0)
  const step = Math.max(1, Number(ctx.params.step ?? 1))
  const seed = Number(ctx.params.seed ?? 0)

  switch (mode) {
    case 'head':
      return [`${out} <- ${src} |> head(${count})`]
    case 'tail':
      return [`${out} <- ${src} |> tail(${count})`]
    case 'stride':
      return [`${out} <- ${src} |> slice(seq(1, n(), by = ${step}))`]
    case 'random':
      // Not `slice_sample(...)` with `set.seed`: R's Mersenne Twister is a different generator,
      // so the same seed draws different rows and the document silently disagrees with the
      // canvas. The helper is Coda's own generator.
      ctx.helper('coda_sample_rows')
      return [`${out} <- ${src} |> slice(coda_sample_rows(nrow(${src}), ${count}, ${seed}))`]
    default:
      return ctx.todo(`Unknown sample mode "${mode}".`)
  }
})

// ---------------------------------------------------------------------------
// Pivot / Normalize
// ---------------------------------------------------------------------------

registerEmitter('core.pivot', (ctx) => {
  const src = ctx.wired('in')
  const rows = ctx.column('rows')
  const cols = ctx.column('columns')
  if (!rows || !cols) return ctx.todo('This Pivot needs both a Rows and a Columns field.')

  ctx.library('dplyr')
  ctx.library('tidyr')
  const agg = String(ctx.params.agg ?? 'sum') as AggFn
  const value = ctx.column('value')
  const matrix = ctx.output('matrix')
  const table = ctx.output('table')

  return [
    // `values_fill = 0`: an absent pair reads as 0 in both of Coda's outputs, rather than as
    // a null the table half invented.
    `${table} <- ${src} |>`,
    `  pivot_wider(`,
    `    id_cols = ${col(rows)},`,
    `    names_from = ${col(cols)},`,
    ...(value ? [`    values_from = ${col(value)},`] : []),
    `    values_fn = ${AGG_FUNCS[agg] === 'n' ? 'length' : AGG_FUNCS[agg]},`,
    `    values_fill = 0`,
    `  )`,
    ``,
    `# The matrix half of the same pivot: row labels moved into rownames.`,
    `${matrix} <- as.matrix(${table}[, -1])`,
    `rownames(${matrix}) <- ${table}[[1]]`,
  ]
})

registerEmitter('core.unpivot', (ctx) => {
  const src = ctx.wired('in')
  const out = ctx.output('out')
  const spec = readUnpivotSpec(ctx)
  const plan = unpivotPlan(ctx.schema('in'), spec)
  const melted = plan?.melted ?? [...new Set(spec.columns)]
  const nameCol = plan?.nameName ?? spec.nameInto.trim()
  const valueCol = plan?.valueName ?? spec.valueInto.trim()
  if (melted.length === 0 || !nameCol || !valueCol) {
    // Not configured, and the node passes its input through in exactly that case.
    return [`${out} <- ${src}`]
  }

  ctx.library('dplyr')
  ctx.library('tidyr')

  /*
   * `pivot_longer` keeps every column it was not given, which is what an unset Keep means here
   * too — so only an explicit Keep needs saying, as a `select` in front of the fold.
   */
  const kept = plan?.kept ?? [...new Set(spec.keep)]
  const selection =
    spec.keep.length > 0 ? [`  select(all_of(${rVector([...kept, ...melted])})) |>`] : []

  /*
   * The widening the node's own `combinedDType` does, said in code because `pivot_longer`
   * refuses instead: folding a count together with a label is "Can't combine <double> and
   * <character>", where Coda has already decided the honest common type is text.
   */
  const folded = melted.map((n) => ctx.schema('in')?.columns.find((c) => c.name === n)?.dtype)
  const transform =
    plan?.dtype === 'str' && folded.some((d) => d && d !== 'str')
      ? [`    values_transform = list(${rStr(valueCol)} = as.character),`]
      : []

  const lines = [
    // tidyr folds row by row, which is Coda's order exactly — unlike `pandas.melt`.
    `${out} <- ${src} |>`,
    ...selection,
    `  pivot_longer(`,
    `    cols = all_of(${rVector(melted)}),`,
    `    names_to = ${rStr(nameCol)},`,
    ...transform,
    `    values_to = ${rStr(valueCol)}`,
    `  )`,
  ]

  if (spec.dropEmpty) {
    // `values_drop_na` alone would leave the blanks: Coda counts null and the empty string as
    // one absence. A zero is neither, and stays.
    lines.push(
      `${out} <- ${out} |>`,
      `  filter(!is.na(${col(valueCol)}), ${col(valueCol)} != ${rStr('')})`,
    )
  }
  return lines
})

registerEmitter('core.normalize', (ctx) => {
  const src = ctx.wired('in')
  const out = ctx.output('out')
  const mode = String(ctx.params.mode ?? 'none')

  switch (mode) {
    case 'none':
      return [`${out} <- ${src}`]
    case 'row':
      // An all-zero row normalises to zeros in Coda, where dividing by zero gives NaN here.
      return [`${out} <- ${src} / rowSums(${src})`, `${out}[!is.finite(${out})] <- 0`]
    case 'column':
      return [`${out} <- t(t(${src}) / colSums(${src}))`, `${out}[!is.finite(${out})] <- 0`]
    case 'max':
      return [`${out} <- ${src} / max(${src}, na.rm = TRUE)`, `${out}[!is.finite(${out})] <- 0`]
    case 'log':
      return [`${out} <- log10(1 + ${src})`]
    default:
      return ctx.todo(`Unknown normalize mode "${mode}".`)
  }
})

// ---------------------------------------------------------------------------
// Importers
// ---------------------------------------------------------------------------

function shapingLines(ctx: EmitContext, out: string): string[] {
  const lines: string[] = []
  const idColumn = String(ctx.params.idColumn ?? '')
  const textColumns = ctx.columns('textColumns')

  if (idColumn) {
    ctx.library('dplyr')
    lines.push(`${out} <- ${out} |> rename(neuronId = ${col(idColumn)})`)
  }
  if (textColumns.length > 0) {
    ctx.library('dplyr')
    lines.push(
      `${out} <- ${out} |> mutate(across(all_of(${rVector(textColumns)}), as.character))`,
    )
  }
  return lines
}

registerEmitter('core.uploadTable', (ctx) => {
  ctx.library('readr')
  const out = ctx.output('out')
  const fileName = String(ctx.params.fileName ?? '')
  return [
    ...ctx.note(
      fileName
        ? `Coda stores an uploaded table in the browser, not in the graph, so the rows are not ` +
            `in this document. Point this at your copy of "${fileName}".`
        : 'This Upload Table node has no file. Point the path below at your CSV.',
    ),
    `${out} <- read_csv(${rStr(fileName || 'your-table.csv')}, show_col_types = FALSE)`,
    ...shapingLines(ctx, out),
  ]
})

registerEmitter('core.tableFromUrl', (ctx) => {
  ctx.library('readr')
  const out = ctx.output('out')
  const url = String(ctx.params.url ?? '').trim()
  if (!url) return ctx.todo('This Table from URL node has no URL.')
  return [`${out} <- read_csv(${rStr(url)}, show_col_types = FALSE)`, ...shapingLines(ctx, out)]
})

/**
 * Stack Neurons, as a `nat` neuronlist.
 *
 * `c()` on two neuronlists concatenates them *and* merges the attached data frames, which is
 * the same pairing this node has to keep — the geometry and its attribute table move together
 * or every neuron after the join wears somebody else\u2019s name.
 *
 * The source column is assigned through the neuronlist\u2019s own `[, 'col'] <-`, which writes
 * to that attached frame. That is what `plot3d(..., soma = )` and the nat colour helpers read,
 * so the co-visualisation gesture survives here as it does in Python.
 *
 * **Points take the `rbind` branch**, being a data frame on this side rather than a neuron
 * object — read off `inputType` rather than guessed, since the two emit unrelated cells.
 */
registerEmitter('neuron.stack', (ctx) => {
  const top = ctx.wired('top')
  const bottom = ctx.wired('bottom')
  const out = ctx.output('out')
  const sourceColumn = String(ctx.params.sourceColumn ?? '').trim()
  const topLabel = String(ctx.params.topLabel ?? STACK_LABELS.top)
  const bottomLabel = String(ctx.params.bottomLabel ?? STACK_LABELS.bottom)

  if (ctx.inputType('top')?.kind === 'points') {
    return stackFrames(ctx, top, bottom, {
      source: sourceColumn,
      top: topLabel,
      bottom: bottomLabel,
    })
  }

  ctx.library('nat')
  if (!sourceColumn) return [`${out} <- c(${top}, ${bottom})`]

  return [
    ...ctx.note(
      'c() merges the neuronlists and their attached data frames together, which is the ' +
        'pairing Coda keeps between the geometry and its attribute table.',
    ),
    `${top}[, ${rStr(sourceColumn)}] <- ${rStr(topLabel)}`,
    `${bottom}[, ${rStr(sourceColumn)}] <- ${rStr(bottomLabel)}`,
    `${out} <- c(${top}, ${bottom})`,
  ]
})

// ---------------------------------------------------------------------------
// Qualify Ids
// ---------------------------------------------------------------------------

/** Tag an id column with its dataset, or strip it. Every rule is in `coda_qualify_ids`. */
registerEmitter('core.qualifyIds', (ctx) => {
  const src = ctx.wired('in')
  const name = ctx.column('column')
  if (!name) return ctx.todo('This Qualify Ids has no id column chosen.')

  ctx.helper('coda_qualify_ids')
  const direction = String(ctx.params.direction ?? 'add')
  // Through the node's own rule, not the typed name: it suffixes a name the table already
  // has where both languages would overwrite. `relabelTarget`'s reason, one node over.
  const into = qualifyTarget(ctx.schema('in'), String(ctx.params.into ?? ''))
  const args = [
    src,
    rStr(name),
    `direction = ${rStr(direction)}`,
    ...(direction === 'add' ? [`prefix = ${rStr(String(ctx.params.prefix ?? '').trim())}`] : []),
    ...(direction === 'remove' && into ? [`into = ${rStr(into)}`] : []),
  ]
  return [`${ctx.output('out')} <- coda_qualify_ids(${args.join(', ')})`]
})

// ---------------------------------------------------------------------------
// Edit Table
// ---------------------------------------------------------------------------

/** R's typed `NA`, so an added column and a cleared cell carry the dtype the port publishes. */
const R_NA: Record<DType, string> = {
  i64: 'NA_integer_',
  f64: 'NA_real_',
  str: 'NA_character_',
  bool: 'NA',
}

/** The cast that puts a widened column into the dtype Coda widened it to. */
const R_CAST: Record<DType, string> = {
  i64: 'as.integer',
  f64: 'as.numeric',
  str: 'as.character',
  bool: 'as.logical',
}

/**
 * One edited cell as an R literal.
 *
 * `rValue` for everything but the null, which is the only arm that differs: `rValue` answers
 * `NULL`, and assigning that into a vector *removes* the element rather than emptying it. A
 * typed `NA` is what an absent cell is in R. Quoting and number formatting stay in `r.ts`.
 */
function rCell(cell: CellValue, dtype: DType): string {
  return cell === null ? R_NA[dtype] : rValue(cell)
}

/**
 * The dplyr half of `.loc[rows, column] = value`. The counterpart of the pandas emitter, and a
 * **copy** rather than a shared module for `tableFilters.ts`’ stated reason.
 *
 * Three things about R make this more than a transcription, and each would produce a wrong
 * dtype rather than an error:
 *
 *  - **`replace()` rather than `if_else()`.** `dplyr::if_else` requires both arms to have the
 *    same type and errors when they do not, which is precisely the case this node exists for —
 *    writing text into a numeric column. `replace(x, i, value)` is `x[i] <- value`, which
 *    coerces the vector exactly as Coda widens the column.
 *  - **`"name" := …`,** because a Coda column can be called anything an uploaded CSV’s header
 *    can be, including something that is not a syntactic R identifier. dplyr re-exports rlang’s
 *    `:=`, so this needs no library beyond the one already loaded.
 *  - **A typed `NA` for an added column.** Bare `NA` is *logical*, so `mutate(group = NA)` gives
 *    a logical column that the first `replace` then coerces — a dtype that depends on whether
 *    any row matched, which is the kind of difference that surfaces two joins later.
 *
 * A rule whose filter Coda could not resolve is skipped here too: same rule and same direction,
 * since a term dropped rather than refused widens what gets overwritten.
 */
registerEmitter('core.editTable', (ctx) => {
  const src = ctx.wired('in')
  const out = ctx.output('out')
  const plan = editPlan(ctx.schema('in'), decodeSetters(ctx.params.edits))

  // An unconfigured Edit Table is a pass-through on the canvas, so it is one here.
  if (plan.noop) return [`${out} <- ${src}`]

  ctx.library('dplyr')

  /*
   * One `mutate` per step, each already indented, so the assembly below only has to decide
   * where the pipe goes. A comment rides with its step rather than being a step of its own —
   * a `|>` has to land on the last *code* line of a stage, and a trailing comment would take it.
   */
  const steps: Array<{ comment?: string; lines: string[] }> = []

  for (const entry of plan.widened) {
    steps.push({ lines: [`  mutate(${rStr(entry.column)} := ${R_CAST[entry.to]}(${col(entry.column)}))`] })
  }
  for (const entry of plan.added) {
    steps.push({ lines: [`  mutate(${rStr(entry.column)} := ${R_NA[entry.dtype]})`] })
  }
  for (const target of plan.active) {
    // Against the *output* schema, which is what Coda matches against too: a column widened to
    // text compares as text on both sides, and a column an earlier rule added exists on both.
    const predicates = filterPredicates(target.terms, plan.schema)
    const value = rCell(target.cell, target.dtype)
    const comment = target.setter.where.trim() ? `where ${target.setter.where.trim()}` : undefined
    if (predicates.length === 0) {
      steps.push({ comment, lines: [`  mutate(${rStr(target.column)} := ${value})`] })
      continue
    }
    /*
     * `.data[[…]]` inside `mutate` as well as inside `filter` — the predicates come from the
     * shared compiler and the pronoun is valid in both, which is what lets one column reference
     * serve the mask and the vector being written.
     *
     * The `&` sits at the *end* of each line rather than the start of the next. Inside the
     * parentheses either parses, but a reader commenting one clause out gets a syntax error
     * from the leading form and a working document from this one.
     */
    steps.push({
      comment,
      lines: [
        `  mutate(${rStr(target.column)} := replace(`,
        `    .data[[${rStr(target.column)}]],`,
        ...predicates.map((predicate, i) => `    ${predicate}${i < predicates.length - 1 ? ' &' : ','}`),
        `    ${value}`,
        `  ))`,
      ],
    })
  }

  const lines = [`${out} <- ${src} |>`]
  steps.forEach((step, i) => {
    if (step.comment) lines.push(`  # ${step.comment}`)
    const body = [...step.lines]
    if (i < steps.length - 1) body[body.length - 1] = `${body[body.length - 1]} |>`
    lines.push(...body)
  })

  /*
   * The regex flavour note, which the R Table viewer's chunk also attaches. `grepl(perl = TRUE)`
   * is the closer of R's two engines to JavaScript's, not the same one — and leaving it off here
   * while `out.table` carries it would say the difference applies to a filter and not to an edit.
   */
  if (usesRegex(plan.active.flatMap((target) => target.terms))) {
    lines.push(
      ...ctx.note(
        'Coda matches these regexes with JavaScript semantics and R uses PCRE via ' +
          '`grepl(perl = TRUE)`. They agree on everything these rules use; named groups and ' +
          'lookbehind differ.',
      ),
    )
  }
  for (const target of plan.targets) {
    if (target.problems.length > 0) lines.push(...ctx.note(disabledEditNote(target)))
  }
  return lines
})
