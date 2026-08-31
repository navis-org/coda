import { registerNode } from '../../core/registry'
import { T, isTabular, schemaOf } from '../../core/types'
import { isTableValue } from '../../core/values'
import type { KeepMode } from '../lib/tableOps'
import { KEEP_OPTIONS, dedupeTable } from '../lib/tableOps'

/**
 * Drop repeated rows, comparing on the columns you name.
 *
 * `pandas.drop_duplicates`, and it exists because an annotation base is somebody's spreadsheet:
 * measured against FlyTable's `main.info`, 58,340 rows carry 56,309 distinct root ids, 1,089
 * neurons have more than one row, and one segment appears 104 times with its `side` reading left,
 * center and center among them — a proofreading merge pulling many old annotations onto one id.
 * The providers used to collapse that silently; they no longer do, so this is the node that
 * decides what to do about it, in a place where the decision is visible.
 *
 * **`Keep` is the whole of the node.** `first` and `last` answer "one row per neuron", and which
 * one wins is decided by a Sort upstream rather than by arrival order. `none` answers a different
 * question — "only the neurons nobody disagrees about" — and is the conservative read when the
 * repeats are conflicts rather than copies.
 *
 * Distinct from `Group By`, which is the neighbouring control and collapses rows into an
 * *aggregate*. This keeps whole rows, so every column survives with the values it had; that
 * difference is what stops the two being one node with a mode.
 */
export const dedupeNode = registerNode({
  type: 'core.dedupe',
  label: 'Deduplicate',
  category: 'transform',
  description: 'Drop repeated rows, comparing on the chosen columns.',
  guide:
    'Drop rows that repeat. Name the columns to compare on, or leave empty to compare whole rows for exact duplicates. Keep decides which row survives: first, last, or none at all—only rows nobody disagrees about. Keeps whole rows unchanged; unlike Group By, nothing is aggregated.',
  cost: 'cheap',
  inputs: [{ id: 'in', label: 'Table', type: T.table() }],
  outputs: [{ id: 'out', label: 'Table', type: T.table() }],
  params: [
    {
      id: 'columns',
      kind: 'columns',
      label: 'Compare on',
      from: 'in',
      help: 'Rows repeating across these count as duplicates. Empty compares whole rows.',
      default: [],
    },
    {
      id: 'keep',
      kind: 'enum',
      label: 'Keep',
      help: 'Which row of a repeated set survives. "none" drops every row of it, leaving only rows that were already unique.',
      default: 'first',
      options: KEEP_OPTIONS,
    },
  ],

  /*
   * Schema and kind straight through, `core.filterTable`'s rule and for its reason: a subset of the
   * rows of a neuron table is still a neuron table, and every column keeps the values it had.
   */
  inferOutputs: (ctx) => {
    const input = ctx.inputs.in
    if (!isTabular(input)) return { out: T.table() }
    return {
      out: input.kind === 'neurons' ? T.neurons(schemaOf(input)) : T.table(schemaOf(input)),
    }
  },

  evaluate: (ctx) => {
    const table = ctx.input('in')
    if (!isTableValue(table)) throw new Error('Input is not a table')
    // Through `ctx.columns`, never `ctx.params` — invariant 5, and it is what makes the
    // provenance key and the comparison agree about which columns were actually resolved.
    return {
      out: dedupeTable(
        table,
        ctx.columns('columns'),
        String(ctx.params.keep ?? 'first') as KeepMode,
      ),
    }
  },
})
