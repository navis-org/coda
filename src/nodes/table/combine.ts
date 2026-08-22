import { registerNode } from '../../core/registry'
import { T, isTabular, schemaOf } from '../../core/types'
import { isTableValue } from '../../core/values'
import { TYPE_COLUMN_NAME } from '../../data/annotations/types'
import { combineSchema, combineTable } from '../lib/tableOps'

/**
 * Make one column out of several: the first with a value wins.
 *
 * `dplyr::coalesce`, `pandas.bfill(axis=1)`, SQL's `COALESCE`. It exists because an annotation
 * dump routinely spreads one fact across several columns: FlyWire's published annotations carry
 * `cell_type`, `hemibrain_type`, `supertype` and `cell_class`, and a neuron with no `cell_type`
 * very often has a `hemibrain_type` — so "the type" is the first of those that is filled in.
 *
 * **A node rather than a multi-select on the import nodes**, and the reasoning is the annotation
 * chain's own: the Dataset's Annotations socket takes an *ordinary table* precisely so ordinary
 * table ops can stand in it. Buried in `Type column` this would exist on two nodes and be
 * unreachable from the two provider nodes, which have exactly the same problem — a SeaTable base
 * with its type split across two columns would have no route to it at all. Here it works
 * anywhere, and the result is on the canvas where a Table beside it shows what you got.
 *
 * **Order is priority**, and the picker already expresses it: it appends in pick order and draws
 * the chips in that order, so the list reads left to right as "try this, then this".
 *
 * Distinct from `Join`, which brings columns from *another* table, and from `Group By`, which
 * collapses rows. This reads across one row and writes one cell.
 */
export const combineColumnsNode = registerNode({
  type: 'core.combineColumns',
  label: 'Combine Columns',
  category: 'transform',
  description: 'Make one column out of several — the first with a value wins.',
  guide:
    'Make one column out of several. The columns are tried in the order you pick them and the ' +
    'first one holding a value wins, so cell_type then hemibrain_type means "the hemibrain type ' +
    'where there is no cell type". Null and blank count as the same absence. Naming the result ' +
    'after one of the columns you picked backfills it in place; any other name adds a column. ' +
    'The default name is type, which is what Coda reads a cell type from — so this is how an ' +
    'annotation file whose types are spread over several columns becomes one a dataset can use.',
  cost: 'cheap',
  inputs: [{ id: 'in', label: 'Table', type: T.table() }],
  outputs: [{ id: 'out', label: 'Table', type: T.table() }],
  params: [
    {
      id: 'columns',
      kind: 'columns',
      label: 'Columns',
      from: 'in',
      help: 'Tried in the order you pick them. The first with a value wins; null and blank are both absent.',
      default: [],
    },
    {
      id: 'into',
      kind: 'string',
      label: 'Result',
      help: 'Name for the combined column. Naming one of the columns above backfills it in place.',
      default: TYPE_COLUMN_NAME,
    },
    {
      id: 'sourceColumn',
      kind: 'string',
      label: 'Source column',
      help: 'Adds a column naming which input each value came from. Empty adds none.',
      default: '',
      advanced: true,
    },
  ],

  /*
   * Kind straight through, `core.filter`'s rule: adding a column to a neuron table leaves a
   * neuron table, and the id is untouched unless somebody deliberately names it as the result —
   * in which case the column still exists and still holds ids.
   */
  inferOutputs: (ctx) => {
    const input = ctx.inputs.in
    if (!isTabular(input)) return { out: T.table() }
    const shaped = combineSchema(schemaOf(input), {
      columns: ctx.columns('columns'),
      into: String(ctx.params.into ?? '').trim(),
      sourceColumn: String(ctx.params.sourceColumn ?? '').trim(),
    })
    return { out: input.kind === 'neurons' ? T.neurons(shaped) : T.table(shaped) }
  },

  /*
   * Warnings only, never a refusal. This node passes its input through when it is not
   * configured, so a half-set-up card has no business blocking everything downstream — the same
   * call invariant 5's corollary records about the `out.*` viewers.
   */
  validate: (ctx) => {
    const columns = ctx.columns('columns')
    const into = String(ctx.params.into ?? '').trim()
    const issues: string[] = []
    if (!into) issues.push('No result name — nothing will be added')
    if (columns.length === 0)
      issues.push('No columns picked — the table passes through unchanged')
    if (into && columns.length === 1 && columns[0] === into) {
      issues.push(`"${into}" is the only column picked, so nothing is filled in`)
    }
    return issues
  },

  evaluate: (ctx) => {
    const table = ctx.input('in')
    if (!isTableValue(table)) throw new Error('Input is not a table')
    // Through `ctx.columns`, never `ctx.params` — invariant 5, so the provenance key and the
    // columns actually read agree about which names resolved.
    return {
      out: combineTable(table, {
        columns: ctx.columns('columns'),
        into: String(ctx.params.into ?? '').trim(),
        sourceColumn: String(ctx.params.sourceColumn ?? '').trim(),
      }),
    }
  },
})
