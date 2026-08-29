import { registerNode } from '../../core/registry'
import { T, findColumn, isTabular, schemaOf } from '../../core/types'
import { isTableValue } from '../../core/values'
import type { FilterOp } from '../lib/tableOps'
import { filterTable, opNeedsValue, opsForDType } from '../lib/tableOps'

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
export const filterNode = registerNode({
  type: 'core.filterTable',
  label: 'Filter Table',
  category: 'transform',
  description: 'Keep rows matching a condition on one column.',
  guide:
    'Keep the rows matching one condition. The operator list follows the column’s type — pick a number and you get ≥, ≤, between; pick text and you get contains and matches — which is schema propagation doing something visible. It is cheap, so the result re-computes as you type a threshold, with nothing waiting for Run.',
  cost: 'cheap',
  inputs: [{ id: 'in', label: 'Table', type: T.table() }],
  outputs: [{ id: 'out', label: 'Table', type: T.table() }],
  params: [
    { id: 'column', kind: 'column', label: 'Column', from: 'in', default: '' },
    {
      id: 'op',
      kind: 'enum',
      label: 'Condition',
      default: 'ge',
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
      visibleIf: (params) => opNeedsValue(String(params.op ?? 'eq') as FilterOp),
    },
  ],

  // Filtering preserves the schema exactly — including neurons-ness.
  inferOutputs: (ctx) => {
    const input = ctx.inputs.in
    if (!isTabular(input)) return { out: T.table() }
    return {
      out: input.kind === 'neurons' ? T.neurons(schemaOf(input)) : T.table(schemaOf(input)),
    }
  },

  validate: (ctx) => {
    const issues: string[] = []
    const columnName = ctx.column('column')
    const col = columnName ? findColumn(ctx.schema('in'), columnName) : undefined
    const op = String(ctx.params.op ?? '') as FilterOp
    if (col && op) {
      const allowed = opsForDType(col.dtype).map((o) => o.value)
      if (!allowed.includes(op)) {
        issues.push(`"${op}" does not apply to a ${col.dtype} column — pick another condition`)
      }
    }
    if (col && op && opNeedsValue(op)) {
      const raw = String(ctx.params.value ?? '')
      if (raw === '') issues.push('Comparison value is empty')
      else if ((col.dtype === 'i64' || col.dtype === 'f64') && !Number.isFinite(Number(raw))) {
        issues.push(`"${raw}" is not a number`)
      }
    }
    return issues
  },

  evaluate: (ctx) => {
    const table = ctx.input('in')
    if (!isTableValue(table)) throw new Error('Input is not a table')
    const columnName = ctx.column('column')
    if (!columnName) throw new Error('No column selected')
    const out = filterTable(
      table,
      columnName,
      String(ctx.params.op ?? 'eq') as FilterOp,
      String(ctx.params.value ?? ''),
    )
    return { out }
  },
})
