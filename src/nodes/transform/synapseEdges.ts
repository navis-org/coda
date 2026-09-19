/**
 * A synapse cloud counted into an edge list.
 *
 * The node that closes the chain `Points in Volumes` opened. That node gave a synapse the
 * region it is in; this one turns a cloud of them back into connectivity — so
 * `Synapses Between ▸ Points in Volumes ▸ Synapses to Edges` answers "how are these neurons
 * wired *inside LO(R)*", which neuPrint answers only as whole-connection `roiInfo` and CAVE and
 * CATMAID cannot answer at all.
 *
 * `nodes/lib/synapseEdges.ts` carries the flip, which is the rule with a control on this card;
 * `docs/nodes-morphology.md` carries the rest — why this is a node rather than a `core.groupBy`, the column
 * order, the `cheap` reasoning and why there is no `Min weight`.
 */

import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { isPointsValue } from '../../core/values'
import {
  GROUP_PARAM,
  ORIENTATION_PARAM,
  POLARITY_PARAM,
  SOURCE_PARAM,
  SOURCE_TYPE_PARAM,
  TARGET_PARAM,
  TARGET_TYPE_PARAM,
  droppedGroupColumns,
  edgePlanRefusal,
  readPlan,
  synapseEdgesSchema,
  synapseEdgesTable,
} from '../lib/synapseEdges'

registerNode({
  type: 'neuron.synapseEdges',
  label: 'Synapses to Edges',
  category: 'transform',
  description:
    'Count a synapse point cloud into a connectivity edge list — `preId`, `postId` and a `weight` that is the number of synapses, under the same column names Connectivity emits. Needs a cloud carrying a partner column, which Synapses Between has and a plain Synapses cloud on neuPrint or CATMAID does not.',
  guide:
    'Counts a synapse cloud into an edge list: one row per connected pair, with weight the number of synapses between them. It is what turns "here is where they connect" back into "how strongly" — so a cloud narrowed by Points in Volumes gives connectivity restricted to one neuropil, which no backend answers directly. Split by takes extra columns, so splitting on the region column gives one row per pair per region in a single card. The control to read before running is Orientation: a Synapses Between cloud is already oriented, while a plain Synapses cloud says which end its neuron is in a polarity column, and counting that one without flipping merges a neuron’s inputs and outputs.',
  cost: 'cheap',
  inputs: [{ id: 'in', label: 'Points', type: T.points() }],
  outputs: [{ id: 'out', label: 'Edges', type: T.table() }],
  params: [
    /*
     * Not restricted by dtype. Invariant 8 has every source publishing an id as `str`, so a
     * `dtypes: ['str']` would be right for every cloud Coda fetches — and it would also refuse
     * CATMAID's `connectorId`, which is an `i64` on purpose and a legitimate thing to aggregate
     * against. `idText` reads both, and the restriction buys nothing rule 3 does not already do.
     */
    {
      id: SOURCE_PARAM,
      kind: 'column',
      label: 'Presynaptic',
      from: 'in',
      default: 'neuronId',
      help: 'The id column holding the upstream neuron. On a Synapses Between cloud this is neuronId whatever Location says.',
    },
    {
      id: TARGET_PARAM,
      kind: 'column',
      label: 'Postsynaptic',
      from: 'in',
      default: 'partnerId',
      help: 'The id column holding the downstream neuron. A Synapses cloud from neuPrint or CATMAID carries none — use Synapses Between.',
    },
    /*
     * In the key and not presentational: it decides which way every row is counted.
     *
     * Chosen rather than detected. The two clouds that reach this port are indistinguishable by
     * schema — both carry `neuronId`, `partnerId` and `polarity` — and by value too, since a
     * `Synapses Between` cloud with `Location: post` reads `post` in every row of the column
     * that would drive the flip. See `synapseEdges.ts`.
     */
    {
      id: ORIENTATION_PARAM,
      kind: 'enum',
      label: 'Orientation',
      default: 'fixed',
      options: [
        { value: 'fixed', label: 'columns are already oriented' },
        { value: 'polarity', label: 'read from a polarity column' },
      ],
      help: 'A Synapses Between cloud is oriented: neuronId is the source in every row, so leave this alone. A plain Synapses cloud is query-relative — its polarity column says whether the neuron is the pre or the post end — and needs the second reading, or its inputs and outputs are counted as one.',
    },
    {
      id: POLARITY_PARAM,
      kind: 'column',
      label: 'Polarity',
      from: 'in',
      default: 'polarity',
      dtypes: ['str'],
      visibleIf: (params) => params[ORIENTATION_PARAM] === 'polarity',
      help: 'Rows reading "post" are flipped, so the presynaptic column is read as the downstream end. Anything else is left as the pickers say, and counted.',
    },
    {
      id: GROUP_PARAM,
      kind: 'columns',
      label: 'Split by',
      from: 'in',
      default: [],
      help: 'Extra columns to break each pair on. Splitting on the region column Points in Volumes writes gives one row per pair per region — Connectivity’s Split by region, for the backends that have none.',
    },
    /*
     * `advanced`, because their defaults are right on every cloud Coda produces and a card
     * carrying five pickers reads as a node with five decisions in it. `optional`, because a
     * cloud with no types is an ordinary cloud: an optional picker answers *off* rather than
     * taking rule 3's first compatible column, which here would name every neuron after
     * whichever text column came first.
     */
    {
      id: SOURCE_TYPE_PARAM,
      kind: 'column',
      label: 'Presynaptic type',
      from: 'in',
      default: 'type',
      optional: true,
      advanced: true,
      help: 'Carried through as preType, and flipped with the ids. Empty leaves the column out.',
    },
    {
      id: TARGET_TYPE_PARAM,
      kind: 'column',
      label: 'Postsynaptic type',
      from: 'in',
      default: 'partnerType',
      optional: true,
      advanced: true,
      help: 'Carried through as postType, and flipped with the ids. Empty leaves the column out.',
    },
  ],

  /*
   * Available from the wire alone, which is the point: a `Build Network` or a `Group By` on the
   * region can be configured while this node is still idle.
   */
  inferOutputs: (ctx) => {
    const schema = synapseEdgesSchema(ctx.attributes('in'), readPlan(ctx))
    return { out: schema ? T.table(schema) : T.table() }
  },

  /*
   * Two things, and neither is something the framework already says — `validateColumnParams`
   * reports a picker whose column is gone on every node, so restating that here would be
   * `out.scatter`'s recorded second badge. Both sentences are owned elsewhere:
   * `edgePlanRefusal`'s and `droppedGroupColumns`'.
   */
  validate: (ctx) => {
    const plan = readPlan(ctx)
    const issues: string[] = []
    const refusal = edgePlanRefusal(plan)
    if (refusal !== undefined) issues.push(refusal)
    const dropped = droppedGroupColumns(plan)
    if (dropped.length > 0) {
      issues.push(
        `Split by ignores ${dropped.join(', ')}: already carried by this node’s own columns.`,
      )
    }
    return issues
  },

  evaluate: (ctx) => {
    const points = ctx.input('in')
    if (!isPointsValue(points)) {
      throw new Error(
        'Wire a synapse cloud — Synapses Between, or any node handing one on — to Points.',
      )
    }
    const plan = readPlan(ctx)
    const { table, dropped, unoriented } = synapseEdgesTable(points.attributes, plan)

    if (dropped > 0) {
      ctx.warn(
        `${dropped.toLocaleString()} of ${points.attributes.length.toLocaleString()} synapses ` +
          'have no id at one end and were not counted.',
      )
    }
    if (unoriented > 0) {
      ctx.warn(
        `${unoriented.toLocaleString()} synapses have a "${plan.polarity}" that reads ` +
          `neither pre nor post; those rows were counted as the pickers name them. Check ` +
          `Polarity points at the right column.`,
      )
    }
    return { out: table }
  },
})
