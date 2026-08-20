import { registerNode } from '../../core/registry'
import { T, isTabular, schemaOf } from '../../core/types'
import { isTableValue } from '../../core/values'
import type { StackOptions } from '../lib/tableOps'
import { stackColumns, stackSchema, stackTables } from '../lib/tableOps'

/**
 * Two tables end to end — the vertical counterpart of `Join`.
 *
 * `Join` widens a table with columns from another; this lengthens one with rows from another.
 * Two connectivity results from different seeds, a hand-curated list added to a query result,
 * the same analysis run on two datasets.
 *
 * **Every column survives, and a gap is a null.** A column only one side carries is filled with
 * null for the other's rows, which is what null already means here: not recorded. The tidier
 * alternative — keep only the columns both have — silently discards data that was wired in, and
 * on two neuron tables from different datasets that can be most of the columns with nothing on
 * screen to say so. Same call `Join` makes when it suffixes a colliding name rather than
 * dropping it.
 *
 * **A dtype clash is refused, not reconciled.** `bodyId` as a number above and text below is two
 * different columns wearing one name. Widening both to text would keep the values and remove the
 * column from every numeric picker downstream; coercing text to a number loses values outright.
 * Neither is a decision this node has the grounds to make, so it names the column and stops.
 * `i64` and `f64` are the exception and merge silently: those are the same kind of thing.
 *
 * **Rows keep input order and duplicates are kept** — `UNION ALL`, not `UNION`. Which of two
 * identical rows to keep is a real question with its own answer, and it belongs in the node that
 * asks it.
 *
 * **Two inputs, chained for more.** Exactly `Join`'s shape. Note the consequence for the source
 * column: it distinguishes the two inputs of the stack that *added* it, so three tables want
 * either a distinct name per level or the labels set at each one.
 */
export const stackNode = registerNode({
  type: 'core.stack',
  label: 'Stack Tables',
  category: 'transform',
  description: 'Combine two tables vertically, keeping every column either of them has.',
  guide:
    'The vertical Join: where that one widens a table with columns, this lengthens it with rows. Two connectivity results from different seeds, a curated list added to a query result, the same analysis run on two datasets. A column only one side has is filled with null for the other’s rows rather than being dropped — but a column the two sides genuinely disagree about, a bodyId that is a number above and text below, is refused by name rather than silently reconciled.',
  cost: 'cheap',
  inputs: [
    { id: 'top', label: 'Top', type: T.table() },
    { id: 'bottom', label: 'Bottom', type: T.table() },
  ],
  outputs: [{ id: 'out', label: 'Table', type: T.table() }],
  params: [
    {
      id: 'sourceColumn',
      kind: 'string',
      label: 'Source column',
      placeholder: 'none',
      help: 'Adds a column naming which input each row came from. Empty adds none.',
      default: '',
    },
    /*
     * Only worth showing once there is a column to put them in, and `visibleIf` keeps them out
     * of the provenance key while there is not — so naming the inputs of a stack that is not
     * labelling anything cannot stale it.
     */
    {
      id: 'topLabel',
      kind: 'string',
      label: 'Top label',
      default: 'Top',
      advanced: true,
      visibleIf: (params) => String(params.sourceColumn ?? '').trim() !== '',
    },
    {
      id: 'bottomLabel',
      kind: 'string',
      label: 'Bottom label',
      default: 'Bottom',
      advanced: true,
      visibleIf: (params) => String(params.sourceColumn ?? '').trim() !== '',
    },
  ],

  /**
   * Unknown until *both* sides are known, and that is not laziness.
   *
   * The result's column set depends on both, so publishing the top's schema alone would
   * advertise a table missing every column the bottom contributes — and a picker downstream
   * would be configured against a shape that never arrives.
   *
   * A dtype clash still publishes the union, using the top's reading. Nothing is ever built from
   * it, because `evaluate` refuses on the same list; what it buys is that the other columns stay
   * pickable while somebody fixes the one that clashes.
   */
  inferOutputs: (ctx) => {
    const schema = stackSchema(ctx.schema('top'), ctx.schema('bottom'), readOptions(ctx.params))
    if (!schema) return { out: T.table() }
    // Neurons only when both inputs are — a `neurons` kind is a claim about the ids, and the
    // plain table never made it. `stackTables` decides the same way on the values.
    const both = ctx.inputs.top?.kind === 'neurons' && ctx.inputs.bottom?.kind === 'neurons'
    return { out: both ? T.neurons(schema) : T.table(schema) }
  },

  /**
   * Both refusals are reported here as well as thrown, because both are fixable upstream and a
   * badge names the problem before a Run does.
   */
  validate: (ctx) => {
    const issues: string[] = []
    const top = ctx.inputs.top
    const bottom = ctx.inputs.bottom
    const topSchema = schemaOf(top)
    const bottomSchema = schemaOf(bottom)

    const source = String(ctx.params.sourceColumn ?? '').trim()
    if (source) {
      // Checked against each schema that is *known*: an unknown one is not a schema without the
      // column in it, and warning there would fire on every graph downstream of a Pivot.
      const clashes = [topSchema, bottomSchema].some(
        (schema) => schema && schema.columns.some((c) => c.name === source),
      )
      if (clashes) issues.push(`Source column "${source}" already exists in one of the inputs`)
    }

    if (isTabular(top) && isTabular(bottom) && topSchema && bottomSchema) {
      for (const clash of stackColumns(topSchema, bottomSchema).conflicts) {
        issues.push(`"${clash.name}" is ${clash.top} above and ${clash.bottom} below`)
      }
    }
    return issues
  },

  evaluate: (ctx) => {
    const top = ctx.input('top')
    const bottom = ctx.input('bottom')
    if (!isTableValue(top)) throw new Error('Top input is not a table')
    if (!isTableValue(bottom)) throw new Error('Bottom input is not a table')
    return { out: stackTables(top, bottom, readOptions(ctx.params)) }
  },
})

/**
 * One reader for both halves, so the schema and the values cannot disagree about whether a
 * source column was asked for — the trimming in particular, which decides it.
 */
function readOptions(params: Record<string, unknown>): StackOptions {
  return {
    sourceColumn: String(params.sourceColumn ?? '').trim(),
    topLabel: String(params.topLabel ?? 'Top'),
    bottomLabel: String(params.bottomLabel ?? 'Bottom'),
  }
}
