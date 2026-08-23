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

import type { JoinHow } from '../../../nodes/lib/tableOps'
import {
  aggColumnName,
  combineLayout,
  keepsUnmatchedRight,
  renameMapping,
} from '../../../nodes/lib/tableOps'
import { decodeRenames } from '../../../nodes/lib/renames'
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
    return [`${out} = ${src}`]
  }

  ctx.require('pandas')
  ctx.helper('coda_combine')

  /*
   * A column already holding the result's name is renamed rather than overwritten, which is the
   * node's own rule and pandas' opposite — `df['type'] = ...` replaces silently. Taken from
   * `combineLayout`, the same function the node's own halves use, rather than reconstructed by
   * diffing `combineSchema`'s output positionally — which bound this to two array-order facts
   * ("the result is appended last", "the source column is last") that nothing stated. Where the
   * input schema is unknown (downstream of a Pivot, say) there is nothing to predict and the
   * assignment simply lands as pandas would have it.
   */
  const inNames = ctx.schema('in')?.columns.map((c) => c.name) ?? []
  const layout = combineLayout(inNames, { columns, into, sourceColumn })
  const renames = inNames.flatMap((name, i) =>
    layout.renamed[i] === name ? [] : [`${pyStr(name)}: ${pyStr(layout.renamed[i]!)}`],
  )

  const lines = [
    renames.length > 0
      ? `${out} = ${src}.rename(columns={${renames.join(', ')}})`
      : `${out} = ${src}.copy()`,
    `${out}[${pyStr(into)}] = coda_combine(${src}, ${pyList(columns)})`,
  ]
  if (sourceColumn) {
    const name = layout.sourceName ?? sourceColumn
    lines.push(`${out}[${pyStr(name)}] = coda_combine(${src}, ${pyList(columns)}, source=True)`)
  }
  return lines
})

// ---------------------------------------------------------------------------
// Group By
// ---------------------------------------------------------------------------

/** `join` is absent on purpose: it is a callable rather than a pandas method name. */
const AGG_FUNCS: Record<Exclude<AggFn, 'join'>, string> = {
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
  if (agg !== 'count' && !value) return ctx.todo(`"${agg}" needs a value column.`)

  // `n` rides along with every aggregation, exactly as the node emits it — you almost always
  // want to know whether a mean came from 2 rows or 200.
  const aggs = [`n=(${pyStr(value ?? by[0]!)}, 'size')`]
  if (agg === 'join') {
    // A callable, not a method name: pandas takes either in a named-aggregation tuple, and
    // Coda's rule about absences and empties is not one `', '.join` expresses.
    ctx.helper('coda_join')
    aggs.push(`${aggColumnName(agg, value)}=(${pyStr(value!)}, coda_join)`)
  } else if (agg !== 'count') {
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
// Rename
// ---------------------------------------------------------------------------

/**
 * `rename(columns=...)` tolerates a name the frame does not carry, which is Coda's rule too —
 * a row naming a column an upstream edit removed renames nothing rather than failing. What it
 * does *not* reproduce is the collision suffix, so the mapping is resolved against the incoming
 * schema first; see `renameMapping`.
 */
registerEmitter('core.rename', (ctx) => {
  const src = ctx.wired('in')
  const pairs = renameMapping(ctx.schema('in'), decodeRenames(ctx.params.renames))
  ctx.require('pandas')
  const out = ctx.output('out')

  // An unconfigured Rename is a pass-through on the canvas, so it is one here — `rename` with
  // an empty dict would work and would read as a step that was meant to do something.
  if (pairs.length === 0) return [`${out} = ${src}`]

  return [
    `${out} = ${src}.rename(`,
    `    columns={`,
    ...pairs.map(([from, to]) => `        ${pyStr(from)}: ${pyStr(to)},`),
    `    },`,
    `)`,
  ]
})

// ---------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------

/**
 * The name a Join's right key is moved to before the merge, where the two keys differ.
 *
 * Deliberately unlikely to be a real column: it exists for one line and is dropped on the next,
 * and a collision with something already in the table would be a wrong answer rather than an
 * error. pandas-only — R's `join_by(a == b)` coalesces the keys natively.
 */
const SCRATCH_KEY = '_coda_join_key'

registerEmitter('core.join', (ctx) => {
  const left = ctx.wired('left')
  const right = ctx.wired('right')

  const leftKey = ctx.column('leftKey')
  const rightKey = ctx.column('rightKey')
  if (!leftKey || !rightKey) return ctx.todo('This Join has no key column on one side.')
  /*
   * Verified against pandas 2.3 rather than assumed, because it decides whether the two lines
   * below are needed at all: with `left_on` and `right_on` naming the *same* column, `merge`
   * publishes a single key column — already coalesced under `how='outer'`/`'right'` — which is
   * exactly what Coda publishes. Naming them differently is what makes pandas keep both.
   */
  const sameKey = leftKey === rightKey

  ctx.require('pandas')
  const out = ctx.output('out')
  const how = String(ctx.params.how ?? 'left') as JoinHow
  const suffix = String(ctx.params.suffix ?? '_r')
  // The op's own predicate, not a second copy of it — see `keepsUnmatchedRight`.
  const fillsKey = keepsUnmatchedRight(how)

  /*
   * Which side is deduplicated flips with the direction, and getting it wrong costs a row
   * count rather than an error. `left`/`inner`/`outer` match *into* the right, so the right is
   * the side a duplicated key would multiply; `right` is the mirror, and dropping duplicates
   * from the right there would delete rows a right join is defined to keep.
   *
   * Where the two keys are named differently the right one is renamed to a scratch name before
   * the merge, and that is not decoration — it is what makes the drop below *knowable*.
   * Measured against pandas 2.3: a right key whose name collides with a left column comes out
   * suffixed (`postType_r`) while one that does not keeps its own name, so
   * `drop(columns=[rightKey])` would delete the **left** table's own column in the first case.
   * The scratch name cannot collide with anything, so one line is right either way and no
   * schema has to be known at export time to write it — the same scratch-key idiom the label
   * joins already use.
   */
  const moveKey = sameKey ? '' : `.rename(columns={${pyStr(rightKey)}: ${pyStr(SCRATCH_KEY)}})`
  // Deduplicated before the rename, on the column as it is actually called, so the two reads
  // in one line stay in the order somebody would do them by hand.
  const frames =
    how === 'right'
      ? [`${left}.drop_duplicates(subset=[${pyStr(leftKey)}])`, `${right}${moveKey}`]
      : [left, `${right}.drop_duplicates(subset=[${pyStr(rightKey)}])${moveKey}`]

  return [
    ...ctx.note(
      'Coda keeps the first matching row from the other table, so a duplicated key ' +
        'annotates rather than multiplies. `drop_duplicates` is what reproduces that — ' +
        'without it `merge` returns the cross product of every matching pair.',
    ),
    ...(sameKey
      ? []
      : ctx.note(
          `Coda publishes **one** key column, filled from whichever side the row came from — ` +
            `\`dplyr::full_join\`'s shape rather than pandas'. Where the two keys are named ` +
            `differently pandas keeps both, so the right one is renamed out of the way and ` +
            `dropped` +
            (fillsKey ? `, after filling ${pyStr(leftKey)} from it.` : `.`),
        )),
    `${out} = pd.merge(`,
    ...frames.map((frame) => `    ${frame},`),
    `    how=${pyStr(how)},`,
    `    left_on=${pyStr(leftKey)},`,
    `    right_on=${pyStr(sameKey ? rightKey : SCRATCH_KEY)},`,
    `    suffixes=('', ${pyStr(suffix)}),`,
    `)`,
    ...(!sameKey && fillsKey
      ? [`${out}[${pyStr(leftKey)}] = ${out}[${pyStr(leftKey)}].fillna(${out}[${pyStr(SCRATCH_KEY)}])`]
      : []),
    ...(sameKey ? [] : [`${out} = ${out}.drop(columns=[${pyStr(SCRATCH_KEY)}])`]),
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

  // Unreachable through the picker, which offers `NUMERIC_AGG_OPTIONS`; a hand-edited file is
  // the only way here, and `pivot_table` would answer a frame of zeroes rather than fail.
  if (agg === 'join')
    return ctx.todo('A pivot cannot aggregate text — a matrix cell is a number.')

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
