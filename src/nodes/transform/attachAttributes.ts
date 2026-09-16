/**
 * Attach Attributes: a table's columns joined onto geometry, after the fetch.
 *
 * The general form of the `Carry fields` param, and the node that makes a computed table
 * reachable from a scene. A collection's attribute table is built by its source from
 * `SourceSchemas.morphology` — seven columns on neuPrint, three plus the annotation chain's on
 * CAVE, two on a precomputed bucket — and everything a *graph* computes lives in tables that
 * had nowhere to go: a `Cut Tree` cluster, a `Reduce Matrix` row of statistics, a `Group By`
 * total, an uploaded CSV. Colouring a scene by any of them was unwireable.
 *
 * `Neurons to ZapBench Traces → Reduce Matrix → Attach Attributes → 3D View`, coloured by `zap_mean`, is
 * the chain this was written for. `Skeletons ▸ Carry fields` could not do it: its port is
 * `T.neurons()` and a matrix reduction is a `table`.
 *
 * ## Why not simply widen `Carry fields`' port
 *
 * Because the fetch is the wrong place for a table the graph computes. Half of what somebody
 * wants to attach is *downstream* of the geometry — NBLAST scores, a clustering of the
 * skeletons, a metric measured off them — and a port on the fetch node would be a cycle. That
 * node is also `expensive`, so "try colouring by this instead" would re-run a fetch where this
 * re-joins a table already in memory.
 *
 * Both stay, and `carryParams.ts`' header is where that division is argued rather than here.
 *
 * ## The join is `carryParams.ts`', which is the whole implementation
 *
 * Every rule comes with it and is argued there: the left join keeps the geometry's own items and
 * their order, a duplicate key annotates rather than multiplying, an unmatched item carries
 * null, a carried column wins its name *and keeps the old one's slot* (`foldNodeColumns`), and
 * the two key columns are never carried. The only thing this node adds is that the right-hand
 * key is a picker rather than always `neuronId`.
 *
 * ## Three decisions that are this node's own
 *
 * **The geometry side of the key is fixed.** It is always the collection's `neuronId`, which
 * `SkeletonsValue.attributes` requires every collection to carry. A picker there would buy the
 * per-group join — attach a table of one row per cell type, matched `type` to `type` — and cost
 * a third control plus a second way to build a join that matches nothing.
 *
 * It is not "a param away" either, which an earlier draft of this claimed: `carryParams.ts`
 * hardcodes the *left* key (only `joinTables` under it takes both), and both exporters are
 * structurally identity-keyed — Python keys its `set_neuron_attributes` dict on `neuron.id`,
 * R indexes by `names(nl)`. A left key other than `neuronId` has no representation in navis or
 * nat at all, so it would need the frame mechanism in both languages on top of the engine
 * change. Worth knowing before promising it.
 *
 * **Empty means every column**, `core.select`'s own rule, which is the *opposite* of the
 * `Carry fields` param's empty. The two differ because what empty costs differs: there it is the
 * identity of an opt-in extra on a node that was working before the param existed, and here it
 * is the whole purpose of the card — a node that does nothing until a picker is filled reads as
 * broken. `unpivot.ts`' two pickers with deliberately opposite defaults is the precedent for
 * that being a decision rather than an inconsistency.
 *
 * **Points are accepted**, where `Split Neurons` refuses them. Its reason does not reach here: a
 * points row is a *connector*, so partitioning a cloud divides synapses rather than neurons —
 * but annotating one is exactly right, every connector taking its neuron's value, and a synapse
 * cloud coloured by the presynaptic neuron's cell type or activity is a thing people want. The
 * join already annotates rather than multiplying, which is what makes the many-rows-per-key
 * shape safe.
 */

import { ID_COLUMN_NAME } from '../../core/ids'
import { GEOMETRY_KINDS, T } from '../../core/types'
import type { TableSchema } from '../../core/types'
import { columnNames } from '../../core/types'
import { registerNode } from '../../core/registry'
import { isTableValue } from '../../core/values'
import { carriedGeometry, carriedSchema } from '../lib/carryParams'
import type { GeometryValue } from '../lib/transformOps'
import {
  geometryTypeOf,
  isGeometryKind,
  isGeometryValue,
  schemaOfGeometry,
} from '../lib/transformOps'

const MATCH_PARAM = 'matchOn'
const COLUMNS_PARAM = 'columns'

/**
 * The two params, resolved once — infer, evaluate and both emitters.
 *
 * **Empty means every column**, this node's rule and the opposite of the `Carry fields` param's
 * empty; the header argues why. The engine drops the two key columns from whatever it is handed
 * (`carryable`), so this hands over the table's own list unfiltered.
 *
 * The schema is an argument rather than read off the context, because the two halves have
 * different access to it and that difference is the honest one: `inferOutputs` has the port's
 * *inferred* schema, where `evaluate` has the table itself. A raw Cypher result whose columns
 * are unknown until it has run therefore promises nothing at edit time and carries everything at
 * run time, which is what `observesOutputSchema` exists to close and what this node does not
 * need it for — every other table on the canvas publishes its schema.
 */
export function readAttach(
  /*
   * Structural rather than `InferContext | EvalContext`, so an `EmitContext` fits it too: all
   * three resolve a column param the same way (invariant 5) and all three need this answer.
   */
  ctx: { column(paramId: string): string | undefined; columns(paramId: string): string[] },
  schema: TableSchema | undefined,
): { key: string; columns: readonly string[] } {
  const chosen = ctx.columns(COLUMNS_PARAM)
  return {
    // Reachable only on a table whose schema is known and has no columns at all, since
    // `resolveColumn` answers the stored name otherwise.
    key: ctx.column(MATCH_PARAM) ?? ID_COLUMN_NAME,
    columns: chosen.length > 0 ? chosen : columnNames(schema),
  }
}

registerNode({
  type: 'neuron.attachAttributes',
  label: 'Attach Attributes',
  category: 'transform',
  description:
    'Join a table’s columns onto skeletons, meshes or points. A carried column replaces a same-named one and keeps its place, rather than being suffixed.',
  guide:
    'Joins a table onto the attributes that skeletons, meshes or points carry, matched on a column you pick, so what a graph computes (a Cut Tree cluster, a Reduce Matrix statistic, an uploaded CSV) can colour or split a scene. With no columns picked it carries every column; an item the table does not mention keeps its geometry and carries nulls.',
  cost: 'cheap',

  /*
   * `any` with `kinds`, like `neuron.stack` and `core.selectOne`: "skeletons, meshes or points"
   * is not something `CodaType` can say, so the set is declared and `validate` answers for the
   * one case a kind set cannot — an upstream socket that has not resolved yet.
   */
  inputs: [
    { id: 'in', label: 'Geometry', type: T.any(), kinds: GEOMETRY_KINDS },
    { id: 'table', label: 'Table', type: T.table() },
  ],
  outputs: [{ id: 'out', label: 'Geometry', type: T.any(), kinds: GEOMETRY_KINDS }],

  params: [
    {
      id: MATCH_PARAM,
      kind: 'column',
      label: 'Match table on',
      from: 'table',
      /*
       * The geometry side is always `neuronId`, so this names the column of the *table* holding
       * the same ids. `resolveColumn`'s rule 3 is the trap and `validate` below is the answer:
       * on a table with no `neuronId` — a Reduce Matrix keys on `label` — a required picker
       * sitting on its declared default resolves to the **first compatible column**, which may
       * be a column of numbers and would match nothing while looking configured.
       */
      default: ID_COLUMN_NAME,
      help: 'The table column holding neuron ids, matched against the ids the geometry carries. A Reduce Matrix, Cut Tree or Embedding keys on “label”.',
    },
    {
      id: COLUMNS_PARAM,
      kind: 'columns',
      label: 'Columns',
      from: 'table',
      // As `carryParam`: the geometry's id is the join key, so a column named like an id cannot
      // be written over it. Rename it upstream if a scene needs one under another name.
      excludeIds: true,
      // Empty is every column, so a picker nobody has touched is the useful state rather than an
      // unconfigured one — which is exactly what `optional` means here.
      optional: true,
      default: [],
      help: 'Columns to attach. Empty attaches every column of the table except the matched one. A column replaces one of the same name on the geometry, keeping its position.',
    },
  ],

  /*
   * The input's kind with a widened attribute schema, which is what fills the 3D viewer's
   * "colour by" picker before anything has run. `geometryTypeOf` answers `any` for a kind this
   * node refuses, so an unresolved socket promises nothing rather than promising skeletons.
   */
  inferOutputs: (ctx) => {
    const schema = ctx.schema('table')
    const { key, columns } = readAttach(ctx, schema)
    return {
      out: geometryTypeOf(
        ctx.inputs.in?.kind,
        carriedSchema(schemaOfGeometry(ctx.inputs.in), schema, columns, key),
      ),
    }
  },

  /*
   * One refusal and no second. `isGeometryKind` rather than a membership test on
   * `GEOMETRY_KINDS`, because it admits `any` — an upstream passthrough publishes its declared
   * `T.any()` (Mirror, Transform, every `resolvedSocket` caller), and refusing that would put
   * "not any" on a card wired to a perfectly good skeleton.
   *
   * Deliberately **nothing about the key picker**: `validateColumnParams` runs for every node on
   * every mutation and already says `Column "neuronId" is gone — using "label"` for exactly the
   * rule-3 substitution this node's one trap is. A line of its own would be the same fact twice,
   * which is `out.scatter`'s and `out.barChart`'s recorded rule — and `zapbench.neuronTraces`, which
   * this file once claimed as precedent for writing it, in fact declines it for that reason and
   * adds only what the framework cannot say.
   */
  validate: (ctx) => {
    const kind = ctx.inputs.in?.kind
    if (kind && !isGeometryKind(kind)) {
      return [
        `Attach Attributes takes skeletons, meshes or points, not ${kind}. For a table, Join ` +
          `matches two tables on a column.`,
      ]
    }
    /*
     * A **warning**, never a refusal, and it is the whole reason this node has a `validate`.
     * `resolveColumn` substitutes the first compatible column for a required picker whose
     * declared default the schema lacks, so a table keyed on `label` silently matches on
     * whatever comes first — a real answer, plausibly shaped, and empty. It cannot be an error
     * because a column of ids under another name is perfectly legitimate, and nothing at edit
     * time tells that apart from the substitution. `zapbench.neuronTraces` carries the same line for
     * the same rule.
     */
    return []
  },

  evaluate: (ctx) => {
    const value = ctx.input('in')
    if (!isGeometryValue(value)) throw new Error('Input is not skeletons, meshes or points')
    const table = ctx.input('table')
    if (!isTableValue(table)) throw new Error('Second input is not a table')
    const { key, columns } = readAttach(ctx, table.schema)
    /*
     * The type argument is explicit because the value is a *union* of three collections: left to
     * infer, `V` widens to the constraint (`{ attributes: TableValue }`) and the return stops
     * being assignable to a `Value`. `transformOps.ts` meets the same seam and casts there.
     */
    return { out: carriedGeometry<GeometryValue>(value, table, columns, key) }
  },
})
