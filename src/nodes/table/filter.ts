import { registerNode } from '../../core/registry'
import { T, TABLE_OR_FILE_KINDS, findColumn, isTabular, schemaOf } from '../../core/types'
import { isTableFileValue, isTableValue } from '../../core/values'
import { rowPredicate } from '../../core/rowPredicate'
import type { FilterOp } from '../../core/rowPredicate'
import {
  FILTER_TABLE_DEFAULT_OP,
  filterConditionIssues,
  filterTable,
  opNeedsValue,
  operatorVocabulary,
  opsForDType,
  resolveFilterOp,
} from '../lib/tableOps'

/**
 * Row filter. Cheap, so it re-runs live as you type a threshold — this is the node the
 * hybrid evaluation model exists for.
 *
 * The operator list is dtype-aware: pick a numeric column and you get >/≥/<, pick a
 * string column and you get contains/matches. That's the payoff of schema propagation.
 *
 * **"Filter Table", not "Filter"**, since `net.filter` arrived: two nodes called Filter on one
 * canvas, one taking a table and one a network, is a palette entry you have to hover to tell
 * apart. The type id moved with the label — `core.filter` → `core.filterTable` — which broke
 * every stored graph naming it, and was the right trade only because Coda is pre-release with
 * one user. A rename after that is a load-time alias kept forever.
 */
registerNode({
  type: 'core.filterTable',
  label: 'Filter Table',
  category: 'transform',
  description: 'Keep rows matching a condition on one column.',
  guide:
    'Keeps the rows that match one condition on one column, e.g. pre ≥ 100 or type starts with ' +
    'LC. The operators on offer depend on the column type. Chain several for AND; below a Link ' +
    'Table, the condition is applied to whatever rows are later read from the file.',
  cost: 'cheap',
  // A table, or a Link Table file, whose condition rides on to its readers (`data/files/filters.ts`).
  inputs: [{ id: 'in', label: 'Table', type: T.any(), kinds: TABLE_OR_FILE_KINDS }],
  outputs: [{ id: 'out', label: 'Table', type: T.any(), kinds: TABLE_OR_FILE_KINDS }],
  params: [
    { id: 'column', kind: 'column', label: 'Column', from: 'in', default: '' },
    {
      id: 'op',
      kind: 'enum',
      label: 'Condition',
      default: FILTER_TABLE_DEFAULT_OP,
      optionsWithoutPeek: true,
      catalogueNote: operatorVocabulary(),
      options: (ctx) => {
        const schema = ctx.schema('in')
        const columnName = ctx.column('column')
        const dtype = columnName ? findColumn(schema, columnName)?.dtype : undefined
        return opsForDType(dtype)
      },
    },
    {
      id: 'value',
      kind: 'string',
      label: 'Value',
      default: '',
      visibleIf: (params) => opNeedsValue(String(params.op) as FilterOp),
    },
  ],

  // Filtering preserves the schema exactly — including neurons-ness, and a file's being a file.
  inferOutputs: (ctx) => {
    const input = ctx.inputs.in
    if (input?.kind === 'tableFile') return { out: input }
    if (!isTabular(input)) return { out: T.table() }
    return {
      out: input.kind === 'neurons' ? T.neurons(schemaOf(input)) : T.table(schemaOf(input)),
    }
  },

  validate: (ctx) => {
    const columnName = ctx.column('column')
    const col = columnName ? findColumn(ctx.schema('in'), columnName) : undefined
    // Resolved first, so a complaint is about a condition somebody *chose*. A fresh node pointed
    // at a text column used to earn one before anything had been done to it.
    const op = resolveFilterOp(ctx.params.op, col?.dtype, FILTER_TABLE_DEFAULT_OP)
    return filterConditionIssues(col?.dtype, op, String(ctx.params.value))
  },

  evaluate: (ctx) => {
    const input = ctx.input('in')
    if (!isTableFileValue(input) && !isTableValue(input))
      throw new Error('Input is not a table')
    const columnName = ctx.column('column')
    if (!columnName) throw new Error('No column is selected. Pick one in `Column`.')
    // Both kinds carry their schema, so the column and the operator are resolved once.
    const dtype = findColumn(input.schema, columnName)?.dtype
    if (!dtype)
      throw new Error(
        `Column "${columnName}" is not in the input table. Pick another in \`Column\`.`,
      )
    const op = resolveFilterOp(ctx.params.op, dtype, FILTER_TABLE_DEFAULT_OP)
    const value = String(ctx.params.value)
    if (isTableValue(input)) return { out: filterTable(input, columnName, op, value) }
    // A file is not read here (`data/files/filters.ts`). Tested once now, so a value the operator
    // cannot use is refused on this card rather than inside somebody's lookup.
    rowPredicate(dtype, op, value)
    return {
      out: { ...input, filters: [...(input.filters ?? []), { column: columnName, op, value }] },
    }
  },
})
