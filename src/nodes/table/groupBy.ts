import { registerNode } from '../../core/registry'
import { NUMERIC_DTYPES, T } from '../../core/types'
import { isTableValue } from '../../core/values'
import type { AggFn } from '../lib/tableOps'
import { AGG_OPTIONS, groupBySchema, groupByTable } from '../lib/tableOps'

/**
 * Group rows and aggregate. The output schema is *computed*, which is the hardest case
 * for schema propagation and therefore the one most worth getting right: change the
 * aggregation from sum to mean and every downstream column picker updates, before
 * anything re-runs.
 *
 * Always emits `n` (rows per group) alongside the aggregate — you almost always want to
 * know whether a mean came from 2 rows or 200.
 *
 * ## One aggregation, several value columns
 *
 * `Of columns` is a `columns` picker, so one node can produce `sum_pre` beside `sum_post`.
 * What it deliberately does *not* offer is a different aggregation per column: that needs a
 * list of `(column, aggregation)` rows — `core.rename`'s shape — and a stored list of pairs is
 * a different param, a different card and a different cell in both exporters. The narrow
 * version covers the case that actually recurs, which is several columns of the same *kind* of
 * quantity, and it stays one enum in the provenance key.
 *
 * Nothing about the value list is positional, which is what keeps it safe as a bare
 * `columns` param where `core.rename`'s rows could not be: each name carries its own output
 * name through `aggColumnName`, so removing the second of three columns removes exactly
 * `<agg>_<that column>` and leaves the others where they were.
 *
 * ## The picker no longer picks for you
 *
 * `Of column` was a `column` param on its declared default `''`, which resolves to "the first
 * compatible column" — so a freshly-created Group By already had a value column chosen. A
 * `columns` param has no such rule (`resolveColumns` returns the stored list or nothing), so a
 * new node now starts with the picker empty and `validate` says so. That matches `Group by`
 * beside it, which has always started empty and always warned; the node was never usable
 * without configuring that one either.
 *
 * The same change is why a graph saved by an earlier build loses its value column: it stored
 * `value` as the bare string `"weight"`, and `resolveColumns` reads a non-array as nothing.
 * Taken deliberately rather than absorbed — teaching the generic resolver a second spelling for
 * one param's history is invariant 8's shim — and it is loud: the picker is visibly empty and
 * the node carries `"sum" needs at least one value column` until it is re-picked.
 */
export const groupByNode = registerNode({
  type: 'core.groupBy',
  label: 'Group By',
  category: 'transform',
  description:
    'Collapse rows into groups and aggregate one or more value columns. The result carries the ' +
    'group columns, a row count named `n`, and one aggregate per value column renamed ' +
    '`<agg>_<column>` — so summing `weight` gives `sum_weight`, not `weight`.',
  guide:
    'Collapse rows into groups and aggregate — synapses per cell type, mean size per class. Pick several value columns and you get one aggregate each, sum_pre beside sum_post; the aggregation itself is one choice for all of them. The output schema is computed rather than copied, so switching sum to mean renames every aggregate and downstream pickers follow before anything re-runs. n rides along.',
  cost: 'cheap',
  inputs: [{ id: 'in', label: 'Table', type: T.table() }],
  outputs: [{ id: 'out', label: 'Table', type: T.table() }],
  params: [
    { id: 'by', kind: 'columns', label: 'Group by', from: 'in', default: [] },
    {
      id: 'agg',
      kind: 'enum',
      label: 'Aggregate',
      default: 'sum',
      options: AGG_OPTIONS,
    },
    {
      id: 'value',
      kind: 'columns',
      label: 'Of columns',
      from: 'in',
      /*
       * Numeric for every aggregation but `join`, which takes text — a rule rather than a list,
       * which is what keeps this one *stored* param. It was briefly two, made exclusive by
       * `visibleIf`, and the split leaked immediately: the emitters were corrected to say "needs
       * a value column" while `validate` here still said "numeric".
       */
      dtypes: (params) => (params.agg === 'join' ? undefined : NUMERIC_DTYPES),
      help: 'One aggregate per column, named `<agg>_<column>`. For "join text": distinct values, joined with "; " in the order they first appear. Absences are skipped and a repeat is folded away — this cell is meant to be read.',
      default: [],
      visibleIf: (params) => params.agg !== 'count',
    },
  ],

  inferOutputs: (ctx) => {
    const agg = String(ctx.params.agg ?? 'sum') as AggFn
    const by = ctx.columns('by')
    const schema = groupBySchema(ctx.schema('in'), by, ctx.columns('value'), agg)
    return { out: schema ? T.table(schema) : T.table() }
  },

  validate: (ctx) => {
    if (ctx.columns('by').length === 0 && ctx.inputs.in) {
      return ['Pick at least one column to group by']
    }
    const agg = String(ctx.params.agg ?? 'sum') as AggFn
    if (agg !== 'count' && ctx.columns('value').length === 0) {
      return [`"${agg}" needs at least one value column`]
    }
    return []
  },

  evaluate: (ctx) => {
    const table = ctx.input('in')
    if (!isTableValue(table)) throw new Error('Input is not a table')
    const agg = String(ctx.params.agg ?? 'sum') as AggFn
    const by = ctx.columns('by')
    if (by.length === 0) throw new Error('No group-by columns selected')
    return { out: groupByTable(table, by, ctx.columns('value'), agg) }
  },
})
