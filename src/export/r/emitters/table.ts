/**
 * The table transforms, in dplyr.
 *
 * Same standard as the pandas emitters: where Coda's semantics differ from the library's
 * default, the chunk says so in code rather than in a comment. The three that cost a row count
 * if missed are the same three, and each is marked where it is handled.
 */

import { isNumericDType } from '../../../core/types'
import type { AggFn } from '../../../nodes/lib/tableOps'
import { aggColumnName, aggValueParam, combineSchema } from '../../../nodes/lib/tableOps'
import { rCol, rStr, rValue, rVector } from '../r'
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

registerEmitter('core.filter', (ctx) => {
  const src = ctx.wired('in')
  const name = ctx.column('column')
  if (!name) return ctx.todo('No column is chosen on this Filter.')

  ctx.library('dplyr')
  const out = ctx.output('out')
  const op = String(ctx.params.op ?? 'ge')
  const raw = String(ctx.params.value ?? '')
  const numeric = isNumericDType(dtypeOf(ctx, 'in', name) ?? 'str')
  const c = col(name)
  const lines: string[] = []
  let predicate: string

  switch (op) {
    case 'isEmpty':
      predicate = `is.na(${c}) | ${c} == ""`
      break
    case 'notEmpty':
      predicate = `!is.na(${c}) & ${c} != ""`
      break
    case 'isTrue':
      predicate = `${c} %in% TRUE`
      break
    case 'isFalse':
      predicate = `${c} %in% FALSE`
      break
    case 'contains':
      predicate = `grepl(${rStr(raw)}, ${c}, fixed = TRUE)`
      break
    case 'notContains':
      predicate = `!grepl(${rStr(raw)}, ${c}, fixed = TRUE)`
      break
    case 'startsWith':
      predicate = `startsWith(as.character(${c}), ${rStr(raw)})`
      break
    case 'endsWith':
      predicate = `endsWith(as.character(${c}), ${rStr(raw)})`
      break
    case 'matches':
      predicate = `grepl(${rStr(raw)}, ${c})`
      lines.push(
        ...ctx.note(
          'Coda matches this regex with JavaScript semantics; R uses POSIX ERE by default. ' +
            'They agree on ordinary patterns — add perl = TRUE for lookaround.',
        ),
      )
      break
    default: {
      const cmp = R_COMPARISON
      const operator = cmp[op]
      if (!operator) return ctx.todo(`Unknown filter operator "${op}".`)
      if (numeric) {
        const target = Number(raw)
        if (!Number.isFinite(target)) return ctx.todo(`"${raw}" is not a number.`)
        predicate = `${c} ${operator} ${rValue(target)}`
      } else {
        // Coda reads a null cell as the empty string, so `!= x` keeps the unlabelled rows.
        // R's NA propagates through the comparison and `filter` drops it, which silently
        // shrinks the result — `coalesce` is what reproduces Coda.
        predicate = `coalesce(as.character(${c}), "") ${operator} ${rStr(raw)}`
      }
    }
  }

  lines.push(`${out} <- ${src} |> filter(${predicate})`)
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
   * own rule, and the opposite of what `df[[name]] <- ...` does. Read back off `combineSchema`
   * so the suffix cannot disagree with the canvas; an unknown input schema predicts nothing and
   * the assignment lands as base R would have it.
   */
  const schema = ctx.schema('in')
  const inNames = schema?.columns.map((c) => c.name) ?? []
  const shaped = combineSchema(schema, { columns, into, sourceColumn })
  const renamed: Array<[string, string]> = []
  shaped?.columns.slice(0, inNames.length).forEach((c, i) => {
    if (c.name !== inNames[i]) renamed.push([inNames[i]!, c.name])
  })

  const lines = [`${out} <- ${src}`]
  for (const [from, to] of renamed) {
    lines.push(`names(${out})[names(${out}) == ${rStr(from)}] <- ${rStr(to)}`)
  }
  lines.push(`${out}[[${rStr(into)}]] <- coda_combine(${src}, ${rVector(columns)})`)
  if (sourceColumn) {
    ctx.helper('coda_combine_source')
    const name = shaped?.columns[shaped.columns.length - 1]?.name ?? sourceColumn
    lines.push(`${out}[[${rStr(name)}]] <- coda_combine_source(${src}, ${rVector(columns)})`)
  }
  return lines
})

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
  const value = agg === 'count' ? undefined : ctx.column(aggValueParam(agg))
  if (agg !== 'count' && !value) return ctx.todo(`"${agg}" needs a value column.`)
  if (agg === 'join') ctx.helper('coda_join')

  // `n` rides along with every aggregation, exactly as the node emits it.
  const aggs = ['n = n()']
  if (agg !== 'count') {
    aggs.push(`${col(aggColumnName(agg, value))} = ${AGG_FUNCS[agg]}(${col(value!)})`)
  }

  return [
    // `.groups = "drop"` because a silently grouped result changes what every later verb does.
    `${out} <- ${src} |>`,
    `  group_by(${by.map(col).join(', ')}) |>`,
    `  summarise(${aggs.join(', ')}, .groups = "drop")`,
  ]
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
    { left: 'left_join', inner: 'inner_join', full: 'full_join', right: 'right_join' }[how] ??
    'left_join'

  return [
    ...ctx.note(
      'Coda keeps the first matching row from the right table, so a duplicated key annotates ' +
        'rather than multiplies. `distinct` is what reproduces that — without it the join ' +
        'returns every matching pair.',
    ),
    `${out} <- ${left} |>`,
    `  ${verb}(`,
    `    ${right} |> distinct(${col(rightKey)}, .keep_all = TRUE),`,
    `    by = join_by(${col(leftKey)} == ${col(rightKey)}),`,
    `    suffix = c("", ${rStr(suffix)})`,
    `  )`,
  ]
})

registerEmitter('core.stack', (ctx) => {
  const top = ctx.wired('top')
  const bottom = ctx.wired('bottom')
  ctx.library('dplyr')
  const out = ctx.output('out')
  const sourceColumn = String(ctx.params.sourceColumn ?? '')

  // `bind_rows` unions the columns and fills the gaps with NA, which is what the node does —
  // a column only one side carries is not recorded for the other's rows.
  if (!sourceColumn) return [`${out} <- bind_rows(${top}, ${bottom})`]

  const topLabel = String(ctx.params.topLabel ?? 'Top')
  const bottomLabel = String(ctx.params.bottomLabel ?? 'Bottom')
  return [
    `${out} <- bind_rows(`,
    `  ${top} |> mutate(${col(sourceColumn)} = ${rStr(topLabel)}),`,
    `  ${bottom} |> mutate(${col(sourceColumn)} = ${rStr(bottomLabel)})`,
    `)`,
  ]
})

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
