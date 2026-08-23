import { registerNode } from '../../core/registry'
import { ID_COLUMN_NAME } from '../../core/ids'
import { T, attributeSchema, findColumn } from '../../core/types'
import { isTableValue } from '../../core/values'
import { decodeRenames } from '../lib/renames'
import { renamePlan, renameTable } from '../lib/tableOps'

/**
 * Rename one or more columns.
 *
 * **The general form of the two import nodes' `ID column`**, and that is the case it exists
 * for: somebody else's table names its id `root_id` and its cell typing `cell_type`, and Coda
 * addresses exactly those two by literal name (`ID_COLUMN_NAME`, `TYPE_COLUMN_NAME`) — so a
 * table arriving under other spellings meets a Neurons socket, a `typesOf` lookup or a Profile
 * roll-up and quietly answers nothing. Upload Table and Table from URL fix it at the point of
 * import; nothing could fix it for a table that was *fetched* or *joined*, which is what this
 * is. Renaming onto `neuronId` promotes to Neurons and renaming it away demotes — see
 * `renamePlan`, which is where that and everything else about a rename is worked out once.
 *
 * ## Why the rows are a list rather than a pair of params
 *
 * A `columns` picker plus a matching list of new names would need no widget and would be wrong
 * in the way that is hardest to see: the two lists are positional, so deleting the second of
 * three columns silently shifts every name after it onto the wrong column. A row that carries
 * both halves cannot come apart. It is stored the way `out.table` stores its filter clauses —
 * an opaque `string[]` of JSON pairs, legible in a `.coda.json` — and the card draws it as rows
 * with an `+ Add` beneath them (`RenameBody`).
 *
 * ## What it refuses to do, which is nothing
 *
 * Every failure here is a *warning*: a source column an upstream edit removed, a blank target,
 * two rows aiming at one name. None of them is a reason for `evaluate` to throw — invariant 5's
 * corollary — because this node passes a whole table through and a half-typed row would block
 * every node downstream over a control. A rename naming a column the table lacks does nothing;
 * two rows naming one target suffix the second, which is `renamedColumns`' collision rule and
 * the only alternative to a table whose schema claims two columns its data has one of.
 */
export const renameNode = registerNode({
  type: 'core.rename',
  label: 'Rename Columns',
  category: 'transform',
  description: 'Give one or more columns a different name.',
  guide:
    'Give one or more columns a different name, leaving their values, dtypes and units alone. Mostly for making somebody else’s table speak Coda’s vocabulary: the id column has to be called neuronId before a table can meet a Neurons socket, and the cell typing has to be called type before connectivity rows, Explore chips and Profile roll-ups can read it — which is why renaming a column onto neuronId promotes the table to Neurons, and renaming neuronId away demotes it. Nothing here refuses: a row naming a column the table does not have renames nothing and says so, and two rows aiming at one name suffix the second rather than dropping a column.',
  cost: 'cheap',
  inputs: [{ id: 'in', label: 'Table', type: T.table() }],
  outputs: [{ id: 'out', label: 'Table', type: T.table() }],
  params: [
    {
      /*
       * Not `internal` — that is for machinery a widget keeps, a nonce or a pager, and this is
       * the whole of what the node does. Not presentational either: it changes every column
       * name leaving the port, so it belongs in the provenance key.
       */
      id: 'renames',
      kind: 'ids',
      label: 'Renames',
      help: 'One row per column being renamed, set on the card. Stored as [from, to] pairs.',
      noun: 'renames',
      default: [],
    },
  ],

  inferOutputs: (ctx) => {
    const plan = renamePlan(
      attributeSchema(ctx.inputs.in),
      decodeRenames(ctx.params.renames),
      ctx.inputs.in?.kind === 'neurons',
    )
    if (!plan.schema) return { out: T.table() }
    // The kind is as much a promise as the columns are, and it comes off the same plan the
    // value half reads — a table typed `neurons` whose value arrives as a plain table breaks
    // every downstream `idColumn()` guarantee only after a run.
    return { out: plan.neurons ? T.neurons(plan.schema) : T.table(plan.schema) }
  },

  validate: (ctx) => {
    const schema = attributeSchema(ctx.inputs.in)
    const renames = decodeRenames(ctx.params.renames)
    const wasNeurons = ctx.inputs.in?.kind === 'neurons'
    const plan = renamePlan(schema, renames, wasNeurons)
    const issues: string[] = []

    const unnamed = renames.filter((r) => r.from && !r.to).map((r) => r.from)
    if (unnamed.length > 0) issues.push(`No new name for: ${unnamed.join(', ')}`)

    // Empty while the schema is unknown, which is `renamePlan`'s rule rather than a guard
    // repeated here: a port publishing no schema is not a port whose table lacks these columns.
    if (plan.missing.length > 0) issues.push(`Missing column(s): ${plan.missing.join(', ')}`)

    /*
     * Two rows aiming at one name. `renamedColumns` suffixes the second rather than emitting a
     * table whose schema claims two columns of one name — the mapping is not injective and a
     * widget lets somebody express that in two keystrokes — but a suffix nobody asked for is
     * exactly the quiet substitution this codebase reports rather than performs.
     */
    const seen = new Set<string>()
    const clashes = new Set<string>()
    for (const to of plan.applied.values()) {
      if (seen.has(to)) clashes.add(to)
      seen.add(to)
    }
    if (clashes.size > 0) {
      issues.push(`Renamed to the same name: ${[...clashes].join(', ')} — the later one is suffixed`)
    }

    // The demotion, said out loud. It is correct — the column is gone — but a Neurons table
    // silently becoming a plain one is a socket that stops accepting a wire two nodes later.
    if (wasNeurons && !plan.neurons && findColumn(schema, ID_COLUMN_NAME)) {
      issues.push(`Renaming "${ID_COLUMN_NAME}" away — the result is no longer a Neurons table`)
    }

    return issues
  },

  evaluate: (ctx) => {
    const table = ctx.input('in')
    if (!isTableValue(table)) throw new Error('Input is not a table')
    // An empty list passes the table through untouched, which keeps a freshly-added node inert
    // rather than emitting something nobody configured.
    return { out: renameTable(table, decodeRenames(ctx.params.renames)) }
  },
})
