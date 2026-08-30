import { registerNode } from '../../core/registry'
import type { ParamValues } from '../../core/node'
import { T, isTabular, schemaOf } from '../../core/types'
import { isTableValue } from '../../core/values'
import type { UnpivotSpec } from '../lib/tableOps'
import { unpivotIssues, unpivotPlan, unpivotTable } from '../lib/tableOps'

/**
 * Wide -> long, the direction `core.pivot` does not go.
 *
 * `tidyr::pivot_longer`, `pandas.melt`, `data.table::melt`. The tables that arrive already
 * pivoted are the reason it exists: a published connectivity CSV with one column per partner
 * type, a spreadsheet with one column per timepoint, or a Pivot in this graph whose wide half
 * somebody now wants to filter and chart. Everything downstream — `Group By`, `Filter Table`,
 * a Scatter's two channels, every categorical colour — reads *one* column with a label beside
 * it, so a wide table is a dead end until it is folded.
 *
 * **It is not a Pivot with the arrows reversed, and the round trip is lossy in one direction.**
 * Pivot aggregates: several rows collapse into one cell, and the rows they came from are gone.
 * Unfolding that cell gives one row back, not the several. What does round-trip cleanly is
 * `unpivot(pivot(t))` where the pivot had one row per pair to begin with — and even then the
 * absent pairs come back as explicit zero rows, because `matrixToTable` wrote 0 where the pair
 * was missing. `Drop empty` does not remove those: 0 is a value somebody may have measured,
 * and inventing the rule that it is not is exactly the kind of quiet decision a reshape must
 * not make. Filter the zeros afterwards, where it is on the canvas.
 *
 * **Two pickers with deliberately different defaults**, argued in full at `unpivotPlan`: the
 * folded set is explicit because folding is what multiplies rows, and the kept set defaults to
 * everything left over because keeping is free.
 */

/**
 * The node's params as a spec, read once.
 *
 * `combine.ts`'s `readSpec` idiom, and its reason: `inferOutputs`, `validate` and `evaluate`
 * all need the same answer, and three transcriptions is three chances for invariant 3's two
 * halves to disagree about which columns were actually asked for.
 *
 * Exported because the two exporters are a fourth and a fifth reader — an `EmitContext` carries
 * the same `params` and the same `columns()`, so a notebook cell folds exactly the columns the
 * run folded rather than a second transcription's idea of them.
 */
export function readUnpivotSpec(ctx: {
  params: ParamValues
  columns: (id: string) => string[]
}): UnpivotSpec {
  return {
    // Through `ctx.columns`, never `ctx.params` — invariant 5, so the provenance key and the
    // columns actually read agree about which names resolved.
    columns: ctx.columns('columns'),
    keep: ctx.columns('keep'),
    nameInto: String(ctx.params.nameInto ?? ''),
    valueInto: String(ctx.params.valueInto ?? ''),
    dropEmpty: ctx.params.dropEmpty === true,
  }
}

export const unpivotNode = registerNode({
  type: 'core.unpivot',
  label: 'Unpivot',
  category: 'transform',
  description: 'Fold wide columns into one name column and one value column.',
  guide:
    'Fold a wide table into a long one: pick the columns to fold and each becomes rows, with ' +
    'the column name in one new column and the cell in another. This is the direction Pivot ' +
    'does not go, and it is what makes an already-pivoted CSV usable — Group By, Filter Table ' +
    'and every chart that colours by a category want the value in one column. The columns you ' +
    'do not fold are repeated on every row it produces, so leaving Keep empty keeps the rest ' +
    'of the table as it is. Note that it does not undo a Pivot: a pivot aggregated several ' +
    'rows into each cell, and unfolding gives one row back rather than the several.',
  cost: 'cheap',
  inputs: [{ id: 'in', label: 'Table', type: T.table() }],
  outputs: [{ id: 'out', label: 'Table', type: T.table() }],
  params: [
    {
      id: 'columns',
      kind: 'columns',
      label: 'Fold columns',
      from: 'in',
      help: 'The wide columns. Each becomes one row per input row, in the order you pick them.',
      default: [],
    },
    {
      id: 'keep',
      kind: 'columns',
      label: 'Keep',
      from: 'in',
      help: 'Repeated on every row produced. Empty keeps everything that is not folded.',
      default: [],
      optional: true,
    },
    {
      id: 'nameInto',
      kind: 'string',
      label: 'Name column',
      help: 'Holds which column each value came from.',
      default: 'name',
    },
    {
      id: 'valueInto',
      kind: 'string',
      label: 'Value column',
      help: 'Holds the cell itself. Its type is the folded columns’ shared one, or text.',
      default: 'value',
    },
    {
      id: 'dropEmpty',
      kind: 'boolean',
      label: 'Drop empty',
      help: 'Skip cells that are null or blank instead of emitting a row for them. Zero is a value and is kept.',
      default: false,
      advanced: true,
    },
  ],

  /*
   * The schema is derived, not observed: unlike Pivot's wide half, every output column is
   * named by a param or copied from the input, so `inferOutputs` can name all of them without
   * reading a row. The one thing it cannot say before a run is how *many* rows there are, and
   * a schema does not carry that.
   */
  inferOutputs: (ctx) => {
    const input = ctx.inputs.in
    if (!isTabular(input)) return { out: T.table() }
    const plan = unpivotPlan(schemaOf(input), readUnpivotSpec(ctx))
    if (!plan) return { out: input }
    return input.kind === 'neurons' && plan.neurons
      ? { out: T.neurons(plan.schema) }
      : { out: T.table(plan.schema) }
  },

  validate: (ctx) => unpivotIssues(schemaOf(ctx.inputs.in), readUnpivotSpec(ctx)),

  evaluate: (ctx) => {
    const table = ctx.input('in')
    if (!isTableValue(table)) throw new Error('Input is not a table')
    return { out: unpivotTable(table, readUnpivotSpec(ctx), ctx) }
  },
})
