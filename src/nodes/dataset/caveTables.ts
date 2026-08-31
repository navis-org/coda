/**
 * The two CAVE discovery nodes: what is in this datastack, and what is in that table.
 *
 * They exist because of the thing `spec.ts` is a whole module about — **a CAVE datastack does not
 * describe itself.** neuPrint's graph has a `:Neuron` label with properties on it, so `Explore
 * Dataset` can show somebody what a dataset holds. A datastack is a bag of annotation tables with
 * no privileged one, and until now the only way to find out which was to know already: `CAVE
 * table` has a text field with `nuclei_v1` as its placeholder, and typing anything else got a 404
 * at Run.
 *
 * ## Where the datastack comes from
 *
 * `nodes/lib/caveParams.ts` — the reference port, the typed fallback, the wire-beats-field rule
 * and the three refusals, shared with `annotation.caveTable`, which is where they were written
 * first and where they were then copied from wording and all.
 *
 * ## Two nodes rather than one
 *
 * A listing is two requests (tables and views, issued together) and answers a question about the
 * datastack; the info is four and answers a question about one table. Folding them together would
 * mean either fetching every table's metadata to fill a listing — six extra requests on FlyWire
 * public, more elsewhere — or a node whose output shape depends on whether a field is filled in. They also cache differently:
 * a listing is shared by every node on the datastack, where the facts are per table.
 */

import { registerNode } from '../../core/registry'
import { T, column, tableSchema } from '../../core/types'
import type { DType, TableSchema } from '../../core/types'
import type { ColumnData } from '../../core/values'
import { makeTable } from '../../core/values'
import type { CaveTableEntry } from '../../data/cave/tables'
import {
  kindOf,
  peekTableList,
  tableColumnsFor,
  tableFactsFor,
  tableListFor,
} from '../../data/cave/tables'
import {
  CAVE_DATASET_INPUT,
  caveDatastackIssues,
  caveDatastackParam,
  caveTargetOfType,
  caveTargetOfValue,
} from '../lib/caveParams'

// ---------------------------------------------------------------------------
// List CAVE tables
// ---------------------------------------------------------------------------

/**
 * The listing's schema, and it does not move with the Include views toggle.
 *
 * `kind` is present whether or not views are included, which is the whole of the argument for
 * having it: a schema that gains and loses a column when a checkbox moves takes every column
 * picker and every Filter downstream with it. With views off the column reads `table` on every
 * row, which is a column saying something dull rather than a column that was not there.
 */
const LISTING_SCHEMA: TableSchema = tableSchema(column('table', 'str'), column('kind', 'str'))

export const caveTablesNode = registerNode({
  type: 'cave.tables',
  label: 'List CAVE tables',
  category: 'dataset',
  description: 'Every annotation table and view a CAVE datastack publishes.',
  guide:
    'Lists what is actually in a CAVE datastack, which is otherwise something you have to know ' +
    'before you can ask: nothing in a datastack marks one table as the neurons or another as the ' +
    'cell types, so this is where the names for CAVE table and CAVE table info come from. Tables ' +
    'and views are separate things on separate endpoints and the Kind column says which — worth ' +
    'knowing, because the view is often the useful one (FlyWire aggregates its connectivity into ' +
    'valid_connection_v2, and no table holds that). Names only, by design: a description per ' +
    'table would be a request per table, and CAVE table info is that request.',
  cost: 'expensive',

  inputs: [CAVE_DATASET_INPUT],
  outputs: [{ id: 'out', label: 'Tables', type: T.table(LISTING_SCHEMA) }],
  params: [
    caveDatastackParam(
      'Datastack and materialization, as `name:number`. Ignored when a Dataset is wired.',
    ),
    {
      id: 'includeViews',
      kind: 'boolean',
      label: 'Include views',
      help: 'Views are a separate endpoint from tables — a server-side query somebody saved, usually a join or a roll-up. Off lists only the annotation tables, which is caveclient’s `get_tables` exactly.',
      default: true,
    },
  ],

  inferOutputs: () => ({ out: T.table(LISTING_SCHEMA) }),

  validate: (ctx) => caveDatastackIssues(ctx.inputs.dataset, ctx.params),

  evaluate: async (ctx) => {
    const where = caveTargetOfValue(ctx.input('dataset'), ctx.params)
    if (!where) throw new Error('Name a datastack as `name:number`, or wire a CAVE Dataset')
    const entries = await tableListFor(
      where.datastack,
      where.version,
      { signal: ctx.signal },
      Boolean(ctx.params.includeViews),
    )
    return { out: listingTable(entries) }
  },
})

/** The schema half and the value half of the listing, side by side. Invariant 3. */
function listingTable(entries: readonly CaveTableEntry[]) {
  const data: Record<string, ColumnData> = {
    table: entries.map((e) => e.name),
    kind: entries.map((e) => e.kind),
  }
  return makeTable(LISTING_SCHEMA, data)
}

// ---------------------------------------------------------------------------
// CAVE table info
// ---------------------------------------------------------------------------

/**
 * The column listing's schema.
 *
 * `type` is a `str` holding a `DType` name — `i64`, `f64`, `str`, `bool` — rather than a prettier
 * vocabulary of its own, because those four are already what the Upload card's column listing and
 * the Table viewer's summary show. A fifth spelling of the same four things is how two surfaces
 * come to disagree about what a column is.
 *
 * It is blank where the sampled row was null, which is an admission rather than a guess; see
 * `CaveColumnSample.dtype`.
 */
const COLUMNS_SCHEMA: TableSchema = tableSchema(
  column('column', 'str'),
  column('type', 'str'),
  column('example', 'str'),
)

export const caveTableInfoNode = registerNode({
  type: 'cave.tableInfo',
  label: 'CAVE table info',
  category: 'dataset',
  description: 'What one CAVE table is: its description, its row counts and its columns.',
  guide:
    'Four reads about one table of a CAVE datastack, gathered onto one card: its registered ' +
    'schema and the description its publisher wrote, how many rows it holds, and the columns a ' +
    'query actually returns — sampled from one real row, so `pt` shows up as the ' +
    'pt_position_x/y/z, pt_supervoxel_id and pt_root_id a query gives you rather than as the ' +
    'bound point the schema declares. The two row counts on the card are both true and disagree ' +
    'by up to a third; the card says which is which. It also accepts a view, but a view that ' +
    'aggregates cannot be sampled quickly — CAVE builds the whole result before taking one row ' +
    'off it — so the node warns before it waits.',
  cost: 'expensive',

  inputs: [CAVE_DATASET_INPUT],
  outputs: [{ id: 'columns', label: 'Columns', type: T.table(COLUMNS_SCHEMA) }],
  params: [
    caveDatastackParam(
      'Datastack and materialization, as `name:number`. Ignored when a Dataset is wired.',
    ),
    {
      id: 'table',
      kind: 'string',
      label: 'Table',
      placeholder: 'nuclei_v1',
      help: 'A table or a view in this datastack. List CAVE tables is where the names come from.',
      default: '',
    },
  ],

  inferOutputs: () => ({ columns: T.table(COLUMNS_SCHEMA) }),

  validate: (ctx) => {
    const issues = caveDatastackIssues(ctx.inputs.dataset, ctx.params)
    if (issues.length > 0) return issues
    const name = String(ctx.params.table ?? '').trim()
    if (!name) return ['Name a table or a view']
    /*
     * Checked against the listing only once it has landed. `peekTableList` answers `undefined`
     * for "not yet" and that is not a problem to report — a card that said "no such table" for
     * the second between a graph loading and its listing arriving would be accusing every saved
     * graph of being broken. Same contract as `peekMaterializations`.
     */
    const where = caveTargetOfType(ctx.inputs.dataset, ctx.params)
    const entries = where ? peekTableList(where.datastack, where.version) : undefined
    if (entries && !kindOf(entries, name)) {
      return [
        `"${name}" is not in ${where?.datastack}:${where?.version}. ` +
          `Available: ${entries.map((e) => e.name).join(', ')}`,
      ]
    }
    return []
  },

  evaluate: async (ctx) => {
    const where = caveTargetOfValue(ctx.input('dataset'), ctx.params)
    if (!where) throw new Error('Name a datastack as `name:number`, or wire a CAVE Dataset')
    const name = String(ctx.params.table ?? '').trim()
    if (!name) throw new Error('Name a table or a view')
    const options = { signal: ctx.signal }

    /*
     * The listing first. It turns a mistyped name into a sentence naming every table in the
     * datastack rather than a 404 from an endpoint the user never asked about, and it settles
     * which kind of object this is — which decides both the warning below and which query
     * segment the sample posts to.
     */
    const entries = await tableListFor(where.datastack, where.version, options)
    const kind = kindOf(entries, name)
    if (!kind) {
      throw new Error(
        `"${name}" is not a table or view in ${where.datastack}:${where.version}. ` +
          `Available: ${entries.map((e) => e.name).join(', ')}`,
      )
    }

    /*
     * The wait before the wait. A guard rail warns and does not refuse (`docs/limits.md`), and
     * time is never a refusal — so this cannot decline to sample a view, and a view is exactly
     * where the sample can take minutes: CAVE does not push a row limit into an aggregating one.
     * Measured against v783, `proofread_neurons_view` answered a one-row query in 0.77 s while
     * `valid_connection_v2` and `nt_summary_view` had not after 45. What the message can do is
     * name that before the spinner starts, with Cancel an inch away — so it is said *before* the
     * query below is issued.
     */
    if (kind === 'view') {
      ctx.warn(
        `${name} is a view, and CAVE does not push a row limit into one: if it aggregates, the ` +
          `server builds the whole result before handing back the single row this reads its ` +
          `columns off. Two of flywire_fafb_public’s ten had not answered after 45 seconds. ` +
          `Cancel if this is one.`,
      )
    }

    /*
     * The facts are what the card draws and the sample is what the socket carries; only `kind`
     * links them, and the listing above already settled that. So the slow request — for a view,
     * the one that can run for minutes — no longer waits on a metadata read and two counts.
     */
    const [, columns] = await Promise.all([
      tableFactsFor(where.datastack, where.version, name, options),
      tableColumnsFor(where.datastack, where.version, name, kind, options),
    ])
    if (columns.length === 0) {
      ctx.warn(
        `${name} answered no rows, so there is nothing to read its columns off. ` +
          `CAVE publishes a column set only in a result, so an empty table describes itself as empty.`,
      )
    }
    return { columns: columnsTable(columns) }
  },
})

/** The schema half and the value half of the column listing, side by side. Invariant 3. */
function columnsTable(columns: readonly { name: string; dtype?: DType; example: string }[]) {
  const data: Record<string, ColumnData> = {
    column: columns.map((c) => c.name),
    type: columns.map((c) => c.dtype ?? ''),
    example: columns.map((c) => c.example),
  }
  return makeTable(COLUMNS_SCHEMA, data)
}
