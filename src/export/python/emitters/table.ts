/**
 * The table transforms, in pandas.
 *
 * With one exception, noted where it sits: `Select One` steps through geometry as well as rows,
 * so its emitter branches on the input's kind and slices a navis `NeuronList` where pandas is
 * not what is being carried. It lives here because it is a transform and because a module of
 * one emitter is worse than a sentence saying why this one is not pandas.
 *
 * These are the emitters where a faithful translation is genuinely reachable, so the standard
 * here is higher than elsewhere: where Coda's semantics differ from pandas' default, the cell
 * says so in code rather than in a comment. Three of those differences cost a row count if
 * missed, and each is marked at the point it is handled:
 *
 *  - `Join` keeps the **first** matching right row, where `merge` multiplies.
 *  - `Group By` buckets nulls as a key, where `groupby` drops them.
 *  - `Sort` puts nulls last in **both** directions, where `sort_values` follows the direction.
 */

import { aggColumnName } from '../../../nodes/lib/tableOps'
import type { AggFn } from '../../../nodes/lib/tableOps'
import { findColumn, isNumericDType } from '../../../core/types'
import { pyList, pyStr, pyValue } from '../py'
import { registerEmitter } from '../registry'
import type { EmitContext } from '../types'

/** `df['col']` where the name is safe, `df[...]` otherwise — both are one idiom in pandas. */
export function col(frame: string, name: string): string {
  return `${frame}[${pyStr(name)}]`
}

/**
 * Coda's comparison operators as Python's.
 *
 * Shared with `tableFilters.ts`, whose `FieldTerm['op']` overlaps `FilterOp` on exactly these
 * six names — two copies is how the Filter node and the Table's header cells come to render
 * the same comparison differently in one notebook.
 */
export const PY_COMPARISON: Record<string, string> = {
  eq: '==',
  ne: '!=',
  gt: '>',
  ge: '>=',
  lt: '<',
  le: '<=',
}

function dtypeOf(ctx: EmitContext, portId: string, name: string | undefined) {
  return name ? findColumn(ctx.schema(portId), name)?.dtype : undefined
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

registerEmitter('core.filter', (ctx) => {
  const src = ctx.wired('in')
  const name = ctx.column('column')
  if (!name) return ctx.todo('No column is chosen on this Filter.')

  ctx.require('pandas')
  const out = ctx.output('out')
  const op = String(ctx.params.op ?? 'ge')
  const raw = String(ctx.params.value ?? '')
  const numeric = isNumericDType(dtypeOf(ctx, 'in', name) ?? 'str')
  const c = col(src, name)

  const lines: string[] = []
  let mask: string

  switch (op) {
    case 'isEmpty':
      mask = `${c}.isna() | (${c} == '')`
      break
    case 'notEmpty':
      mask = `${c}.notna() & (${c} != '')`
      break
    case 'isTrue':
      mask = `${c}.astype('boolean').fillna(False)`
      break
    case 'isFalse':
      mask = `~${c}.astype('boolean').fillna(True)`
      break
    case 'contains':
      mask = `${c}.fillna('').astype(str).str.contains(${pyStr(raw)}, regex=False)`
      break
    case 'notContains':
      mask = `~${c}.fillna('').astype(str).str.contains(${pyStr(raw)}, regex=False)`
      break
    case 'startsWith':
      mask = `${c}.fillna('').astype(str).str.startswith(${pyStr(raw)})`
      break
    case 'endsWith':
      mask = `${c}.fillna('').astype(str).str.endswith(${pyStr(raw)})`
      break
    case 'matches':
      mask = `${c}.fillna('').astype(str).str.contains(${pyStr(raw)}, regex=True)`
      lines.push(
        ...ctx.note(
          'Coda matches this regex with JavaScript semantics and pandas uses Python `re`. ' +
            'The two agree on ordinary patterns and differ on lookbehind and named groups.',
        ),
      )
      break
    default: {
      const cmp = PY_COMPARISON
      const operator = cmp[op]
      if (!operator) return ctx.todo(`Unknown filter operator "${op}".`)
      if (numeric) {
        const target = Number(raw)
        if (!Number.isFinite(target)) return ctx.todo(`"${raw}" is not a number.`)
        mask = `${c} ${operator} ${pyValue(target)}`
      } else {
        // A text comparison in Coda reads a null cell as the empty string, so `!= x` keeps
        // the unlabelled rows. pandas would drop them, which silently shrinks the result.
        mask = `${c}.fillna('').astype(str) ${operator} ${pyStr(raw)}`
      }
    }
  }

  lines.push(`${out} = ${src}[${mask}]`)
  return lines
})

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

registerEmitter('core.sort', (ctx) => {
  const src = ctx.wired('in')
  const name = ctx.column('column')
  if (!name) return ctx.todo('No column is chosen on this Sort.')

  ctx.require('pandas')
  const out = ctx.output('out')
  const descending = ctx.params.descending === true
  const limit = Number(ctx.params.limit ?? 0)
  const numeric = isNumericDType(dtypeOf(ctx, 'in', name) ?? 'str')

  const lines: string[] = []
  if (!numeric) {
    lines.push(
      ...ctx.note(
        'Coda sorts text with numeric-aware collation, so "item2" comes before "item10". ' +
          'pandas compares strings codepoint by codepoint, which reverses that pair.',
      ),
    )
  }

  // `na_position='last'` in both directions is Coda's rule: a null is absence, not an
  // extreme, so it does not migrate to the top when the sort is reversed.
  const args = [
    `by=${pyStr(name)}`,
    ...(descending ? ['ascending=False'] : []),
    "na_position='last'",
    "kind='stable'",
  ]
  lines.push(`${out} = ${src}.sort_values(${args.join(', ')})`)
  if (limit > 0) lines.push(`${out} = ${out}.head(${limit})`)
  return lines
})

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------

registerEmitter('core.select', (ctx) => {
  const src = ctx.wired('in')
  ctx.require('pandas')

  const names = ctx.columns('columns')
  const out = ctx.output('out')
  // Empty means every column, which is what the node's own `selectTable` does — so the
  // honest translation is a copy rather than an empty frame.
  if (names.length === 0) {
    return [
      ...ctx.note('No columns picked, which Coda reads as "keep them all".'),
      `${out} = ${src}`,
    ]
  }
  return [`${out} = ${src}[${pyList(names)}]`]
})

// ---------------------------------------------------------------------------
// Deduplicate
// ---------------------------------------------------------------------------

/** Coda's `keep` and pandas' are the same three answers; only `none` is spelled differently. */
const KEEP_ARG: Record<string, string> = { first: "'first'", last: "'last'", none: 'False' }

registerEmitter('core.dedupe', (ctx) => {
  const src = ctx.wired('in')
  ctx.require('pandas')

  const out = ctx.output('out')
  const names = ctx.columns('columns')
  const keep = KEEP_ARG[String(ctx.params.keep ?? 'first')] ?? "'first'"
  // Omitted rather than passed as an empty list: `subset=[]` compares on *no* columns, which
  // makes every row a duplicate of the first. Absent is pandas' own "compare whole rows", which
  // is what an empty picker means here.
  const subset = names.length > 0 ? `subset=${pyList(names)}, ` : ''
  return [`${out} = ${src}.drop_duplicates(${subset}keep=${keep})`]
})

// ---------------------------------------------------------------------------
// Group By
// ---------------------------------------------------------------------------

const AGG_FUNCS: Record<AggFn, string> = {
  sum: 'sum',
  mean: 'mean',
  min: 'min',
  max: 'max',
  count: 'size',
  countDistinct: 'nunique',
}

registerEmitter('core.groupBy', (ctx) => {
  const src = ctx.wired('in')
  const by = ctx.columns('by')
  if (by.length === 0) return ctx.todo('No group-by columns are chosen.')

  ctx.require('pandas')
  const out = ctx.output('out')
  const agg = String(ctx.params.agg ?? 'sum') as AggFn
  const value = agg === 'count' ? undefined : ctx.column('value')
  if (agg !== 'count' && !value) return ctx.todo(`"${agg}" needs a numeric value column.`)

  // `n` rides along with every aggregation, exactly as the node emits it — you almost always
  // want to know whether a mean came from 2 rows or 200.
  const aggs = [`n=(${pyStr(value ?? by[0]!)}, 'size')`]
  if (agg !== 'count') {
    aggs.push(`${aggColumnName(agg, value)}=(${pyStr(value!)}, ${pyStr(AGG_FUNCS[agg])})`)
  }

  return [
    // `dropna=False`: Coda buckets an unlabelled row under a null key rather than discarding
    // it, so the default would quietly drop every neuron with no type.
    `${out} = (`,
    `    ${src}.groupby(${pyList(by)}, dropna=False)`,
    `    .agg(${aggs.join(', ')})`,
    `    .reset_index()`,
    `)`,
  ]
})

// ---------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------

registerEmitter('core.join', (ctx) => {
  const left = ctx.wired('left')
  const right = ctx.wired('right')

  const leftKey = ctx.column('leftKey')
  const rightKey = ctx.column('rightKey')
  if (!leftKey || !rightKey) return ctx.todo('This Join has no key column on one side.')

  ctx.require('pandas')
  const out = ctx.output('out')
  const how = String(ctx.params.how ?? 'left')
  const suffix = String(ctx.params.suffix ?? '_r')

  return [
    ...ctx.note(
      'Coda keeps the first matching row from the right table, so a duplicated key ' +
        'annotates rather than multiplies. `drop_duplicates` is what reproduces that — ' +
        'without it `merge` returns the cross product of every matching pair.',
    ),
    `${out} = ${left}.merge(`,
    `    ${right}.drop_duplicates(subset=[${pyStr(rightKey)}]),`,
    `    how=${pyStr(how)},`,
    `    left_on=${pyStr(leftKey)},`,
    `    right_on=${pyStr(rightKey)},`,
    `    suffixes=('', ${pyStr(suffix)}),`,
    `)`,
  ]
})

// ---------------------------------------------------------------------------
// Stack
// ---------------------------------------------------------------------------

registerEmitter('core.stack', (ctx) => {
  const top = ctx.wired('top')
  const bottom = ctx.wired('bottom')

  ctx.require('pandas')
  const out = ctx.output('out')
  const sourceColumn = String(ctx.params.sourceColumn ?? '')

  if (!sourceColumn) {
    // `concat` unions the columns and fills the gaps with NaN, which is exactly what the
    // node does — a column only one side carries is not recorded for the other's rows.
    return [`${out} = pd.concat([${top}, ${bottom}], ignore_index=True)`]
  }

  const topLabel = String(ctx.params.topLabel ?? 'Top')
  const bottomLabel = String(ctx.params.bottomLabel ?? 'Bottom')
  return [
    `${out} = pd.concat(`,
    `    [`,
    `        ${top}.assign(**{${pyStr(sourceColumn)}: ${pyStr(topLabel)}}),`,
    `        ${bottom}.assign(**{${pyStr(sourceColumn)}: ${pyStr(bottomLabel)}}),`,
    `    ],`,
    `    ignore_index=True,`,
    `)`,
  ]
})

// ---------------------------------------------------------------------------
// Sample
// ---------------------------------------------------------------------------

registerEmitter('core.sample', (ctx) => {
  const src = ctx.wired('in')

  ctx.require('pandas')
  const out = ctx.output('out')
  const mode = String(ctx.params.mode ?? 'head')
  const count = Number(ctx.params.count ?? 0)
  const step = Math.max(1, Number(ctx.params.step ?? 1))
  const seed = Number(ctx.params.seed ?? 0)

  switch (mode) {
    case 'head':
      return [`${out} = ${src}.head(${count})`]
    case 'tail':
      return [`${out} = ${src}.tail(${count})`]
    case 'stride':
      return [`${out} = ${src}.iloc[::${step}]`]
    case 'random':
      // Not `df.sample(random_state=seed)`: that is a different PRNG, so the same seed draws
      // different rows and the notebook silently disagrees with the canvas. The helper is
      // Coda's own generator, which is what makes the seed mean the same thing in both.
      ctx.helper('coda_sample_rows')
      return [`${out} = ${src}.iloc[coda_sample_rows(len(${src}), ${count}, ${seed})]`]
    default:
      return ctx.todo(`Unknown sample mode "${mode}".`)
  }
})

// ---------------------------------------------------------------------------
// Pivot
// ---------------------------------------------------------------------------

registerEmitter('core.pivot', (ctx) => {
  const src = ctx.wired('in')
  const rows = ctx.column('rows')
  const cols = ctx.column('columns')
  if (!rows || !cols) return ctx.todo('This Pivot needs both a Rows and a Columns field.')

  ctx.require('pandas')
  const agg = String(ctx.params.agg ?? 'sum') as AggFn
  const value = ctx.column('value')
  const matrix = ctx.output('matrix')
  const table = ctx.output('table')

  const args = [
    `index=${pyStr(rows)}`,
    `columns=${pyStr(cols)}`,
    ...(value ? [`values=${pyStr(value)}`] : []),
    `aggfunc=${pyStr(AGG_FUNCS[agg])}`,
    'fill_value=0',
  ]

  return [
    // Coda's two outputs are one pivot in two shapes; here the wide table is the same frame
    // with its index put back as a column, which is what `matrixToTable` does.
    `${matrix} = ${src}.pivot_table(`,
    ...args.map((a) => `    ${a},`),
    `)`,
    `${table} = ${matrix}.reset_index()`,
  ]
})

// ---------------------------------------------------------------------------
// Normalize
// ---------------------------------------------------------------------------

registerEmitter('core.normalize', (ctx) => {
  const src = ctx.wired('in')

  ctx.require('pandas')
  const out = ctx.output('out')
  const mode = String(ctx.params.mode ?? 'none')

  switch (mode) {
    case 'none':
      return [`${out} = ${src}`]
    case 'row':
      // `.where(total > 0, 0)` rather than leaving NaN: an all-zero row normalises to zeros
      // in Coda, and a NaN row would blank that stripe of the heatmap instead.
      return [`${out} = ${src}.div(${src}.sum(axis=1), axis=0).fillna(0)`]
    case 'column':
      return [`${out} = ${src}.div(${src}.sum(axis=0), axis=1).fillna(0)`]
    case 'max':
      return [`${out} = (${src} / ${src}.to_numpy().max()).fillna(0)`]
    case 'log':
      ctx.require('numpy')
      return [`${out} = np.log10(1 + ${src})`]
    default:
      return ctx.todo(`Unknown normalize mode "${mode}".`)
  }
})

// ---------------------------------------------------------------------------
// Select One
// ---------------------------------------------------------------------------

registerEmitter('core.selectOne', (ctx) => {
  const src = ctx.wired('in')
  const out = ctx.output('item')

  /*
   * A *slice*, never `iloc[[i]]` or `nl[i]`. Both of those raise on an index past the end and
   * both hand back a Series / a single neuron rather than a collection of one — where Coda
   * emits an empty collection of the same kind, and emits a collection either way. `[i:i+1]`
   * is the one spelling that reproduces both, in pandas and in navis alike.
   */
  const index = Math.floor(Number(ctx.params.selected ?? 0))
  const from = Number.isFinite(index) && index > 0 ? index : 0
  // A negative index would slice from the end in Python and emit nothing in Coda. Only
  // reachable by hand-editing the file, and an empty slice is what the canvas would show.
  const empty = !Number.isFinite(index) || index < 0

  const kind = ctx.inputType('in')?.kind
  if (kind === 'skeletons' || kind === 'meshes') {
    ctx.require('navis')
    return [`${out} = ${src}[${empty ? '0:0' : `${from}:${from + 1}`}]`]
  }

  ctx.require('pandas')
  return [`${out} = ${src}.iloc[${empty ? '0:0' : `${from}:${from + 1}`}]`]
})
