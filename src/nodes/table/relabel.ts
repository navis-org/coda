import { registerNode } from '../../core/registry'
import type { ParamValues } from '../../core/node'
import { ID_COLUMN_NAME } from '../../core/ids'
import { T, findColumn, isTabular, schemaOf } from '../../core/types'
import { isTableValue } from '../../core/values'
import type { RelabelSpec, UnmatchedMode } from '../lib/tableOps'
import { UNMATCHED_OPTIONS, relabelSchema, relabelTable } from '../lib/tableOps'

/**
 * The label column of the mapper's `Labels` output, and this picker's declared default.
 *
 * Not `ID_COLUMN_NAME`'s kind of constant — it is a *default*, i.e. a value somebody may
 * change, which `ids.ts` records as the reason not everything gets one. It is spelled here
 * because the node exists for that output and pointing at the wrong column of a two-column
 * table is the one mistake a default can save.
 */
const LABEL_COLUMN_DEFAULT = 'label'

/**
 * The node's params as the op's argument, read once.
 *
 * `join.ts`'s `specOf` and for its reason: `inferOutputs`, `validate` and `evaluate` need the
 * same four, and `unmatched` decides whether the column widens (invariant 3) — so a default
 * written out three times is three chances for the published schema and the produced one to
 * disagree.
 */
function specOf(ctx: {
  params: ParamValues
  column: (id: string) => string | undefined
}): RelabelSpec {
  return {
    // Through `ctx.column`, never `ctx.params` — invariant 5.
    column: ctx.column('column') ?? '',
    keyColumn: ctx.column('keyColumn') ?? '',
    valueColumn: ctx.column('valueColumn') ?? '',
    into: String(ctx.params.into).trim(),
    unmatched: String(ctx.params.unmatched) as UnmatchedMode,
  }
}

/**
 * Rewrite one column through a two-column mapping table.
 *
 * The generic half of comparative connectomics' relabelling. `Compare Connectivity` relabels
 * *internally* rather than demanding two of these upstream — that is a five-node comparison
 * against a nine-node one — but the operation ships as a node as well, because the co-clustering
 * path has to relabel the feature axis of a Partner Vectors table and would otherwise grow a
 * second, private spelling of the same thing. One operation, two callers, one implementation in
 * `nodes/lib/tableOps.ts`. See [docs/comparative.md](../../../docs/comparative.md).
 *
 * Distinct from `Join`, which brings *columns* from another table and leaves the original in
 * place, and from `Rename`, which changes a column's name rather than its values. This replaces
 * values, one lookup per row.
 *
 * `Unmatched` is the parameter worth reading the help for, and it defaults to **leaving the cell
 * empty** rather than keeping the original. Keeping it is the friendlier-looking choice and the
 * wrong default: an unmapped `LC4` sitting in a column of cross-dataset labels is indistinguishable
 * from one the mapper matched, which is precisely the confusion this whole area exists to prevent.
 */
registerNode({
  type: 'core.relabel',
  label: 'Relabel',
  category: 'transform',
  description:
    'Rewrite a column by looking its values up in a two-column mapping table. The result goes into the column named by `Into` (shown as Result), or replaces the column in place when that is empty; any other column already holding that name is suffixed `_2`.',
  guide:
    "Replaces each value in one column with its match in a mapping table, e.g. body ids with cell types. Pick the column, then the mapping's key and value columns, and leave Result empty to rewrite in place. Values the mapping does not cover become empty unless Unmatched says otherwise.",
  cost: 'cheap',
  inputs: [
    { id: 'in', label: 'Table', type: T.table() },
    { id: 'map', label: 'Mapping', type: T.table() },
  ],
  outputs: [{ id: 'out', label: 'Table', type: T.table() }],
  params: [
    {
      id: 'column',
      kind: 'column',
      label: 'Column',
      from: 'in',
      help: 'The column whose values are looked up and replaced.',
      default: '',
    },
    {
      id: 'keyColumn',
      kind: 'column',
      label: 'Key',
      from: 'map',
      help: 'The mapping column matched against the column above.',
      default: ID_COLUMN_NAME,
    },
    {
      id: 'valueColumn',
      kind: 'column',
      label: 'Value',
      from: 'map',
      help: 'The mapping column supplying the replacement.',
      default: LABEL_COLUMN_DEFAULT,
    },
    {
      id: 'unmatched',
      kind: 'enum',
      label: 'Unmatched',
      default: 'null',
      help: 'What to do with values the mapping does not cover. "keep the original value" makes unmapped values look like mapped ones.',
      options: UNMATCHED_OPTIONS,
    },
    {
      id: 'into',
      kind: 'string',
      label: 'Result',
      help: "Name for a new column. Leave empty, or use the column's own name, to rewrite it in place.",
      default: '',
    },
  ],

  /*
   * Kind straight through, `core.combineColumns`' rule: rewriting a column of a neuron table
   * leaves a neuron table. Relabelling the id column itself is somebody's deliberate act and
   * the column is still there holding whatever they put in it.
   */
  inferOutputs: (ctx) => {
    const input = ctx.inputs.in
    if (!isTabular(input)) return { out: T.table() }
    const shaped = relabelSchema(schemaOf(input), schemaOf(ctx.inputs.map), specOf(ctx))
    return { out: input.kind === 'neurons' ? T.neurons(shaped) : T.table(shaped) }
  },

  validate: (ctx) => {
    const issues: string[] = []
    const spec = specOf(ctx)
    const table = schemaOf(ctx.inputs.in)
    const map = schemaOf(ctx.inputs.map)

    if (spec.keyColumn && spec.keyColumn === spec.valueColumn) {
      issues.push(
        `\`Key\` and \`Value\` are both "${spec.keyColumn}", so every value maps to itself. Pick a different column for one of them.`,
      )
    }

    const source = findColumn(table, spec.column)
    const key = findColumn(map, spec.keyColumn)
    if (source && key && source.dtype !== key.dtype) {
      /*
       * Matching is textual (`rowKey`), so differing dtypes are not fatal — but one direction of
       * this is invariant 8's failure and it reads as a mapping with holes rather than as a bug.
       * The mapper publishes `neuronId` as `str`; a table that carries ids as `i64` carries
       * float64s, and an eighteen-digit CAVE root id stopped being itself before it got here.
       */
      const ids = spec.column === ID_COLUMN_NAME || spec.keyColumn === ID_COLUMN_NAME
      issues.push(
        `"${spec.column}" is ${source.dtype} and "${spec.keyColumn}" is ${key.dtype}, so they ` +
          `are matched as text.` +
          (ids && source.dtype === 'i64'
            ? ` A long neuron id stored as a number may already have changed into a different ` +
              `id. Load the ids as text upstream.`
            : ''),
      )
    }

    if (spec.into && spec.into !== spec.column && findColumn(table, spec.into)) {
      issues.push(
        `"${spec.into}" already exists, so the new column gets a suffix. Pick another name in ` +
          `\`Result\` to avoid it.`,
      )
    }
    return issues
  },

  evaluate: (ctx) => {
    const table = ctx.input('in')
    const map = ctx.input('map')
    if (!isTableValue(table)) throw new Error('Input is not a table')
    if (!isTableValue(map)) throw new Error('Mapping input is not a table')
    const spec = specOf(ctx)
    if (!spec.column) throw new Error('No column to relabel is selected. Pick one in `Column`.')
    if (!spec.keyColumn || !spec.valueColumn) {
      throw new Error('Pick both `Key` and `Value` from the mapping table.')
    }
    return { out: relabelTable(table, map, spec) }
  },
})
