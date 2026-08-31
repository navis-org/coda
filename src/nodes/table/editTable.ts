import type { ParamValues } from '../../core/node'
import { registerNode } from '../../core/registry'
import type { CodaType, TableSchema } from '../../core/types'
import { T, attributeSchema } from '../../core/types'
import { isTableValue } from '../../core/values'
import type { EditPlan } from '../lib/tableEdits'
import { decodeSetters, editPlan, editTable } from '../lib/tableEdits'

/**
 * Overwrite values in matching rows — pandas' `.loc[rows, column] = value` as a node.
 *
 * The node for **disagreeing with the data**. A cell type somebody has since revised, a status
 * that is wrong for the twelve neurons you have actually looked at, a grouping the dataset does
 * not carry at all: each of those used to mean exporting a CSV, editing it elsewhere and
 * importing it back, at which point the graph no longer records where the numbers came from.
 * Here the override sits *in* the graph, so re-running the analysis with it — or without it, by
 * unwiring one node — is one gesture and the difference is visible on the canvas.
 *
 * ## An edit is a rule, not a cell reference
 *
 * Each row says `where … set column = value`, and the `where` is an Explore query
 * (`type==LC4 side==left`, `pre>100`, `type~^LPLC[0-9]+$`) — the same grammar as the search box and a
 * Table viewer's column headers. Blank means every row.
 *
 * A rule rather than a coordinate because the table is *derived*: it is re-fetched, re-filtered
 * and re-joined on every run, and "row 412" stops meaning anything the first time a filter
 * upstream drops a row. A rule survives all of that, and it is also the thing worth reading
 * six months later — `where type==LC4 set type = LC4a` says what was decided, where a list of
 * edited cells says only that something was.
 *
 * ## It adds columns, and it widens them
 *
 * Naming a column the table does not have creates it, null outside the rows the rule matches —
 * which makes this the node for tagging a set with a grouping of your own, not only for fixing
 * one. Writing a value that does not fit a column's dtype widens the column to text rather than
 * dropping the edit. Both are published at edit time, so a downstream picker offers a column
 * invented thirty seconds ago without waiting for a run.
 *
 * ## Nothing here refuses, and everything errs towards editing fewer rows
 *
 * Every failure is a warning — invariant 5's corollary, since this passes a whole table through
 * and a half-typed rule would otherwise block every node downstream. But the direction it errs
 * in is the opposite of the Table viewer's: a filter that cannot be resolved **disables its
 * rule** rather than being dropped, because a dropped term widens what gets overwritten. The
 * two cases that look harmless and are not — a bare term, and a `where` naming a column that
 * does not exist — are written out in `tableEdits.ts`.
 */
/**
 * The plan for a node's current params, memoised per node.
 *
 * `inferOutputs` and `validate` both need one and both run on **every graph mutation** — which
 * includes every frame of a node drag, anywhere on the canvas. Without this that is two full
 * plans and two `JSON.parse` passes over every stored rule per frame per Edit Table node; with
 * it, one per actual edit.
 *
 * Keyed on the `edits` array itself, which is a fresh object per commit and per node, so the
 * entry dies with the params it describes and two nodes cannot share one. `editPlan` is pure,
 * which is the whole licence for caching it — the schema is compared by identity beside the key
 * because the same params against a changed upstream is a different answer.
 */
const PLANS = new WeakMap<object, { schema: TableSchema | undefined; plan: EditPlan }>()

function planFor(ctx: {
  inputs: Record<string, CodaType | undefined>
  params: ParamValues
}): EditPlan {
  const schema = attributeSchema(ctx.inputs.in)
  const raw = ctx.params.edits
  if (!Array.isArray(raw)) return editPlan(schema, decodeSetters(raw))
  const cached = PLANS.get(raw)
  if (cached && cached.schema === schema) return cached.plan
  const plan = editPlan(schema, decodeSetters(raw))
  PLANS.set(raw, { schema, plan })
  return plan
}

export const editTableNode = registerNode({
  type: 'core.editTable',
  label: 'Edit Table',
  category: 'transform',
  description: 'Overwrite values in the rows a rule matches.',
  /*
   * Short, because this node has a document: the overlay prints the guide above it under a
   * `TL;DR` label, and `help.test.ts` holds the ceiling at 400 characters. The grammar, the
   * worked examples and every rule that used to be crammed in here are in
   * `src/help/nodes/core.editTable.md`.
   */
  guide:
    'Override values in a table. Each rule names the rows to change — an Explore query like ' +
    'type==LC4 status==Traced, or blank for all of them — then the column to write and what to ' +
    'put in it; naming a column the table does not have creates it. A filter it cannot resolve ' +
    'switches its own rule off rather than editing more rows than you meant.',
  cost: 'cheap',
  inputs: [{ id: 'in', label: 'Table', type: T.table() }],
  outputs: [{ id: 'out', label: 'Table', type: T.table() }],
  params: [
    {
      /*
       * The whole of what the node does, so neither `internal` nor `presentational`: it decides
       * every value leaving the port and belongs in the provenance key.
       */
      id: 'edits',
      kind: 'ids',
      label: 'Edits',
      help:
        'One rule per row, set on the card: which rows, which column, what to write. The ' +
        'filter is Explore terms ANDed — type==LC4, status!=Traced, pre>100, type~^LC[0-9]+$ ' +
        '— and blank means every row. Bare terms are refused: write column==value.',
      noun: 'edits',
      default: [],
    },
  ],

  inferOutputs: (ctx) => {
    const plan = planFor(ctx)
    if (!plan.schema) return { out: T.table() }
    // Neurons-ness survives by construction — no column is ever dropped — so the kind comes
    // straight off the input.
    return {
      out: ctx.inputs.in?.kind === 'neurons' ? T.neurons(plan.schema) : T.table(plan.schema),
    }
  },

  validate: (ctx) => planFor(ctx).issues,

  evaluate: (ctx) => {
    const table = ctx.input('in')
    if (!isTableValue(table)) throw new Error('Input is not a table')
    /*
     * Its own plan, not `planFor`'s. That one is built against the *inferred* schema an
     * `InferContext` carries, and `evaluate` holds the real table — which is the whole point of
     * `observed` schemas elsewhere and is the one place the two can legitimately differ.
     */
    const result = editTable(table, decodeSetters(ctx.params.edits))
    /*
     * A rule that matched nothing is the failure this node has that edit time cannot see: the
     * filter parses, the column exists, and no row satisfies it — which looks exactly like an
     * edit that worked. Only `evaluate` has the values to tell the two apart.
     */
    result.plan.targets.forEach((target, i) => {
      if (target.problems.length === 0 && result.matched[i] === 0) {
        ctx.warn(`Edit ${target.index + 1} matched no rows, so "${target.column}" is unchanged`)
      }
    })
    return { out: result.table }
  },
})
