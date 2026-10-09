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

import { packNode } from '../../core/registry'
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
  caveTableSuggestions,
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

export const caveTablesNode = packNode({
  type: 'cave.tables',
  label: 'List CAVE tables',
  category: 'dataset',
  description:
    'Lists every annotation table and view a CAVE datastack publishes, as a table with `table` and `kind` columns.',
  guide:
    'Lists the tables and views of a CAVE datastack by name, with a kind column saying which is ' +
    'which. Use it to find the names to give CAVE table or CAVE table info. Views are often the ' +
    'useful ones: FlyWire’s connectivity, for example, is only in the valid_connection_v2 view.',
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
      help: 'Also list views: saved server-side queries, usually joins or roll-ups. Off lists only the annotation tables.',
      default: true,
    },
  ],

  inferOutputs: () => ({ out: T.table(LISTING_SCHEMA) }),

  validate: (ctx) => caveDatastackIssues(ctx.inputs.dataset, ctx.params),

  evaluate: async (ctx) => {
    const where = caveTargetOfValue(ctx.input('dataset'), ctx.params)
    if (!where)
      throw new Error(
        'Name a datastack, e.g. flywire_fafb_public:783, or wire a CAVE Dataset into `Dataset`.',
      )
    const entries = await tableListFor(
      where.datastack,
      where.version,
      { deployment: where.deployment, signal: ctx.signal },
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

export const caveTableInfoNode = packNode({
  type: 'cave.tableInfo',
  label: 'CAVE table info',
  category: 'dataset',
  // Wide enough for the two counts and their labels to share one line, since the whole point of
  // showing both is that they can be compared at a glance.
  cardWidth: 300,
  description:
    'Describes one CAVE table or view: its description, its row counts, and its columns as a table with `column`, `type` and `example`.',
  guide:
    'Shows what one table of a CAVE datastack holds: its schema, the description its publisher ' +
    'wrote, two row counts (the card explains the difference) and the columns a query returns, ' +
    'sampled from one row, so pt arrives as pt_position_x/y/z, pt_supervoxel_id and pt_root_id. ' +
    'Views work too, but an aggregating view is slow to sample and the node warns first.',
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
      help: 'A table or view in this datastack. With a CAVE token, the list shows its tables and views (marked t and v); any name can be typed.',
      default: '',
      // This node samples either kind, and warns before a view.
      suggestions: caveTableSuggestions,
    },
  ],

  inferOutputs: () => ({ columns: T.table(COLUMNS_SCHEMA) }),

  validate: (ctx) => {
    const issues = caveDatastackIssues(ctx.inputs.dataset, ctx.params)
    if (issues.length > 0) return issues
    const name = String(ctx.params.table).trim()
    if (!name) return ['Set `Table` to the name of a table or view.']
    /*
     * Checked against the listing only once it has landed. `peekTableList` answers `undefined`
     * for "not yet" and that is not a problem to report — a card that said "no such table" for
     * the second between a graph loading and its listing arriving would be accusing every saved
     * graph of being broken. Same contract as `peekMaterializations`.
     */
    const where = caveTargetOfType(ctx.inputs.dataset, ctx.params)
    const entries = where
      ? peekTableList(where.deployment, where.datastack, where.version)
      : undefined
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
    if (!where)
      throw new Error(
        'Name a datastack, e.g. flywire_fafb_public:783, or wire a CAVE Dataset into `Dataset`.',
      )
    const name = String(ctx.params.table).trim()
    if (!name) throw new Error('Set `Table` to the name of a table or view.')
    const options = { deployment: where.deployment, signal: ctx.signal }

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
        `${name} is a view. CAVE builds a view's whole result before applying row ` +
          `limits, so this can be very slow.`,
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
        `${name} returned no rows, so there are no columns to read. CAVE only reports a ` +
          `table's columns alongside its rows.`,
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
