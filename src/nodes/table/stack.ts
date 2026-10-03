import { registerNode } from '../../core/registry'
import { T, isTabular, schemaOf } from '../../core/types'
import { isTableValue } from '../../core/values'
import {
  STACK_PORT_LABEL,
  describeConflict,
  isKnownSchema,
  stackColumns,
  stackSchema,
  stackTables,
} from '../lib/tableOps'
import {
  readStackOptions,
  stackCountParam,
  stackLabelParams,
  stackSourceColumn,
} from '../lib/stackParams'

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
 * **A dtype clash is refused, not reconciled.** `neuronId` as a number above and text below is two
 * different columns wearing one name. Widening both to text would keep the values and remove the
 * column from every numeric picker downstream; coercing text to a number loses values outright.
 * Neither is a decision this node has the grounds to make, so it names the column and stops.
 * `i64` and `f64` are the exception and merge silently: those are the same kind of thing.
 *
 * **Rows keep input order and duplicates are kept** — `UNION ALL`, not `UNION`. Which of two
 * identical rows to keep is a real question with its own answer, and it belongs in the node that
 * asks it.
 *
 * **As many inputs as you ask for**, one socket each, added with the `Inputs` spinner. It used to
 * be a fixed pair chained for more, which worked and cost the source column its meaning: each
 * card labelled *its own* two inputs, so a three-table stack named the third and called the first
 * two by whatever the inner stack's label had been. One card labels every input once.
 *
 * The old pair's port ids (`top`, `bottom`) are carried by `PortGroupDef.formerIds`, so a saved
 * graph keeps its wires; the label params keep their ids for the same reason. See
 * `nodes/lib/stackParams.ts`.
 */
registerNode({
  type: 'core.stack',
  label: 'Stack Tables',
  category: 'transform',
  description: 'Append the rows of two or more tables, keeping every column any of them has.',
  guide:
    'Combines two or more tables by appending their rows, e.g. the results of the same query ' +
    'on two datasets. Every column of every input is kept, and an optional Source column ' +
    'records which input each row came from. To add columns instead, use Join.',
  cost: 'cheap',
  inputs: [
    {
      repeat: stackCountParam.id,
      ports: [{ id: 'in', label: STACK_PORT_LABEL, type: T.table() }],
      // What indices 1 and 2 were called when this node had a fixed pair.
      formerIds: ['top', 'bottom'],
    },
  ],
  outputs: [{ id: 'out', label: 'Table', type: T.table() }],
  params: [
    stackCountParam,
    {
      id: 'sourceColumn',
      kind: 'string',
      label: 'Source column',
      placeholder: 'none',
      help: 'Adds a column naming which input each row came from. Empty adds none.',
      default: '',
    },
    ...stackLabelParams(['Top', 'Bottom']),
  ],

  /**
   * Unknown until *every* input is known, and that is not laziness.
   *
   * The result's column set depends on all of them, so publishing an answer while one is still
   * missing would advertise a table without the columns that input contributes — and a picker
   * downstream would be configured against a shape that never arrives.
   *
   * A dtype clash still publishes the union, using the reading the earlier inputs agreed on.
   * Nothing is ever built from it, because `evaluate` refuses on the same list; what it buys is
   * that the other columns stay pickable while somebody fixes the one that clashes.
   */
  inferOutputs: (ctx) => {
    const ports = ctx.inputPorts()
    // The source column alone, not `readStackOptions`: a label never reaches a *schema*, and
    // this runs on every graph mutation — see that function on what the labels array costs here.
    const schema = stackSchema(
      ports.map((port) => ctx.schema(port.id)),
      { sourceColumn: stackSourceColumn(ctx.params) },
    )
    if (!schema) return { out: T.table() }
    // Neurons only when every input is — a `neurons` kind is a claim about the ids, and a plain
    // table never made it. `stackTables` decides the same way on the values.
    const all = ports.every((port) => ctx.inputs[port.id]?.kind === 'neurons')
    return { out: all ? T.neurons(schema) : T.table(schema) }
  },

  /**
   * Both refusals are reported here as well as thrown, because both are fixable upstream and a
   * badge names the problem before a Run does.
   */
  validate: (ctx) => {
    const issues: string[] = []
    const ports = ctx.inputPorts()
    const types = ports.map((port) => ctx.inputs[port.id])
    const schemas = types.map(schemaOf)

    const source = stackSourceColumn(ctx.params)
    if (source) {
      // Checked against each schema that is *known*: an unknown one is not a schema without the
      // column in it, and warning there would fire on every graph downstream of a Pivot.
      const clashes = schemas.some(
        (schema) => schema && schema.columns.some((c) => c.name === source),
      )
      if (clashes)
        issues.push(
          `\`Source column\` is "${source}", which already exists in one of the inputs. Pick another name.`,
        )
    }

    /*
     * The conflict scan needs every schema, so one unconnected socket stands the whole check
     * down rather than reporting a clash between the inputs that happen to have arrived — which
     * would name a pair that is not the pair the run will refuse on.
     */
    if (types.every(isTabular) && schemas.every(isKnownSchema)) {
      for (const clash of stackColumns(schemas).conflicts) issues.push(describeConflict(clash))
    }
    return issues
  },

  evaluate: (ctx) => {
    const ports = ctx.inputPorts()
    const tables = ports.map((port) => {
      const value = ctx.input(port.id)
      if (!isTableValue(value)) throw new Error(`${port.label} is not a table`)
      return value
    })
    return { out: stackTables(tables, readStackOptions(ctx.params, ports.length)) }
  },
})
