/**
 * Filter Network — a subgraph around a selection, rather than a smaller drawing of the whole.
 *
 * The Network Viewer already trims what it draws (`minWeight`, top-N, hide isolated), and that
 * answers "what is worth looking at in this graph". This answers the other question: **what is
 * near this**. Those are not the same operation and the difference is the point — the viewer's
 * knobs rank globally and would discard the very node you asked about if it happened to be
 * small, while this starts from it.
 *
 * Built for `Match Cell Types`' `Network` port, where the whole label graph is thousands of
 * nodes and the useful unit is one connected component — that being what the algorithm actually
 * decides on, so "why did these two correspond?" and "why did those two not?" are both questions
 * about a component. It takes any network, though, and works the same on a connectivity graph.
 *
 * **Two ways to name the seeds and they union**, `collectLabels`' shape and its reasoning: a
 * filter row is what you reach for while looking at the picture, a wired table is what you have
 * when the selection came from somewhere else, and a node that ignored one the moment the other
 * arrived would look broken in the way that takes longest to notice.
 *
 * `cheap`, so the hop count re-runs live as you drag it — invariant 6's other direction. Nothing
 * here fetches; it is one walk over an edge table already in hand.
 */

import { registerNode } from '../../core/registry'
import { T, findColumn, isNumericDType } from '../../core/types'
import type { InferContext } from '../../core/node'
import type { DType } from '../../core/types'
import { getColumn, isNetworkValue, isTableValue } from '../../core/values'
import { collectLabels } from '../lib/labelLookup'
import type { FilterOp } from '../lib/tableOps'
import { filterTable, opNeedsValue, opsForDType } from '../lib/tableOps'
import {
  EXPANSION_OPTIONS,
  WALK_OPTIONS,
  expandSelection,
  induceSubnetwork,
} from '../lib/networkOps'
import type { NetworkExpansion, WalkDirection } from '../lib/networkOps'

/**
 * The dtype of the chosen node column, or undefined where nothing is chosen or nothing is wired.
 *
 * Through `ctx.attributes`, which is `attributeSchema(inputs[port], part)` on the context — the
 * accessor that exists for a port carrying a schema that is not `schemaOf`'s. Three readers
 * (the operator list, `validate`, and nothing else once `inferOutputs` asks the context
 * directly), so it is worth the name.
 */
function chosenDType(ctx: InferContext): DType | undefined {
  const name = ctx.column('column')
  return name ? findColumn(ctx.attributes('in', 'nodes'), name)?.dtype : undefined
}

export const filterNetworkNode = registerNode({
  type: 'net.filter',
  label: 'Filter Network',
  category: 'analysis',
  description: 'Cut out the part of a network around a selection.',
  guide:
    'Picks a set of nodes and keeps what is near them: the selection itself, everything within a number of hops, or the whole connected component it sits in. Built for reading Match Cell Types’ Network port, where the graph is thousands of nodes and the unit worth looking at is one component — that is what the matcher decides on, so a component is the answer to both “why did these correspond?” and “why did those not?”. Name the nodes with a condition on any node column, or wire a table of ids, or both; the two are unioned. Every link with both ends in the result is kept. Build Network’s degree and weight columns are recomputed against the surviving links, so a size encoding describes the picture; a column some other producer derived — the neuron counts on Match Cell Types’ label nodes — is carried through unchanged and still describes the whole graph.',
  cost: 'cheap',

  inputs: [
    { id: 'in', label: 'Network', type: T.network() },
    { id: 'seed', label: 'Seed', type: T.table(), required: false },
  ],
  outputs: [{ id: 'out', label: 'Network', type: T.network() }],

  params: [
    {
      id: 'column',
      kind: 'column',
      label: 'Column',
      // No `schemaFrom` and no `part`: `columnSchemaFor` already reads a network's node schema
      // by default, which is how every picker on `out.network` is declared.
      from: 'in',
      default: '',
      optional: true,
      help: 'A node column to select on. Leave empty to seed only from the wired table.',
    },
    {
      id: 'op',
      kind: 'enum',
      label: 'Condition',
      default: 'contains',
      // The same operator table `Filter Table` offers, resolved against the same dtype, so the
      // two nodes named Filter behave identically on the half they have in common.
      options: (ctx) => opsForDType(chosenDType(ctx)),
    },
    {
      id: 'value',
      kind: 'string',
      label: 'Value',
      default: '',
      visibleIf: (params) => opNeedsValue(String(params.op ?? 'contains') as FilterOp),
    },
    {
      id: 'seedColumn',
      kind: 'column',
      label: 'Seed ids',
      from: 'seed',
      default: 'id',
      /*
       * Optional for the reason every picker on an optional port is: empty has to keep meaning
       * "nothing from here". Required, it would fall back to the first compatible column of
       * whatever is wired, and seed the walk from a column of labels read as node ids — which
       * matches nothing and looks like the port being ignored.
       */
      optional: true,
      help: 'On the Seed table: the column holding node ids to start from.',
    },
    {
      id: 'expand',
      kind: 'enum',
      label: 'Include',
      default: 'component',
      options: [...EXPANSION_OPTIONS],
      help: 'How far past the selected nodes to reach.',
    },
    {
      id: 'hops',
      kind: 'int',
      label: 'Hops',
      default: 1,
      min: 1,
      max: 10,
      visibleIf: (params) => params.expand === 'hops',
    },
    {
      id: 'direction',
      kind: 'enum',
      label: 'Follow',
      default: 'any',
      options: [...WALK_OPTIONS],
      /*
       * Hidden for `component`, which is undirected by definition — and hidden rather than
       * ignored, so it stays out of the provenance key (invariant 4).
       *
       * It is **not** hidden on an undirected network, and cannot be: `visibleIf` is handed
       * `ParamValues` and has no way to see what is wired. `expandSelection` ignores it there
       * instead, which is the only place that knows — and is also where both emitters already
       * land, since networkx and igraph both ignore direction on an undirected graph.
       */
      visibleIf: (params) => params.expand === 'hops',
      advanced: true,
    },
  ],

  /*
   * Filtering never changes either schema — the output is a subgraph, same columns. Stated
   * rather than left to the port's declared `T.network()`, because that one carries no schemas
   * at all and a picker downstream would have nothing to offer until after a run.
   */
  inferOutputs: (ctx) => ({
    out: T.network(ctx.attributes('in', 'nodes'), ctx.attributes('in', 'edges')),
  }),

  validate: (ctx) => {
    const issues: string[] = []
    const column = ctx.column('column')
    const op = String(ctx.params.op ?? '') as FilterOp
    const dtype = chosenDType(ctx)

    if (column && dtype && op) {
      if (!opsForDType(dtype).some((o) => o.value === op)) {
        issues.push(`"${op}" does not apply to a ${dtype} column — pick another condition`)
      } else if (opNeedsValue(op)) {
        const raw = String(ctx.params.value ?? '')
        /*
         * Both halves, `Filter Table`'s verbatim. The second is not decoration: `makePredicate`
         * *throws* on a non-numeric value against a numeric column, so without it the node goes
         * red at Run with a raw error where its sibling says the same thing on the card while
         * there is still something to change.
         */
        if (raw === '') issues.push('Comparison value is empty')
        else if (isNumericDType(dtype) && !Number.isFinite(Number(raw))) {
          issues.push(`"${raw}" is not a number — this column is ${dtype}`)
        }
      }
    }
    /*
     * A wired seed table with no column chosen is the one reading of "empty" nobody intends —
     * `Match Cell Types`' Pass Through port, same shape and same message.
     */
    if (ctx.inputs.seed && !ctx.column('seedColumn')) {
      issues.push('Seed: pick the column holding the node ids to start from.')
    }
    /*
     * Said rather than refused. An empty selection is a legitimate state while somebody is
     * typing a value, and an empty *network* is a perfectly good value for everything
     * downstream — this is the card explaining a blank drawing, not a reason to stop.
     */
    if (!column && !ctx.inputs.seed) {
      issues.push('Nothing selects any nodes yet — pick a column, or wire a table of ids.')
    }
    return issues
  },

  evaluate: (ctx) => {
    const network = ctx.input('in')
    if (!isNetworkValue(network)) throw new Error('Input is not a network')

    const seeds = new Set<string>()

    // Half one: a condition on the node attributes. Through `filterTable`, which is `Filter
    // Table`'s own evaluate — the two agree on what `>=` means because it is one function.
    // `findColumn` first, and it is invariant 5's corollary rather than belt and braces:
    // `filterTable` throws on a column that is not there, and a picker pointing at a column an
    // upstream edit removed is not grounds to block everything downstream.
    const column = ctx.column('column')
    if (column && findColumn(network.nodes.schema, column)) {
      const kept = filterTable(
        network.nodes,
        column,
        String(ctx.params.op ?? 'contains') as FilterOp,
        String(ctx.params.value ?? ''),
      )
      for (const cell of getColumn(kept, 'id')) seeds.add(String(cell ?? ''))
    }

    /*
     * Half two: ids off the wired table, unioned with the first. Through `collectLabels`, which
     * owns "an optional wired table and an optional column, read as trimmed, blank-free,
     * deduplicated strings" — the trim is the half a hand-rolled loop leaves out, and a pasted
     * spreadsheet column with a trailing space then matches nothing and reads as the node
     * ignoring the port. `typed: undefined` because a seed arrives only by wire.
     */
    const seedTable = ctx.input('seed')
    for (const id of collectLabels({
      typed: undefined,
      table: isTableValue(seedTable) ? seedTable : undefined,
      column: ctx.column('seedColumn'),
    })) {
      seeds.add(id)
    }

    const kept = expandSelection(network, {
      seeds,
      expand: String(ctx.params.expand ?? 'component') as NetworkExpansion,
      hops: Number(ctx.params.hops ?? 1),
      direction: String(ctx.params.direction ?? 'any') as WalkDirection,
    })

    if (seeds.size > 0 && kept.size === 0) {
      ctx.warn(
        'Nothing selected: no node matched the condition, and no seed id is in this network. ' +
          'Ids are exact — Match Cell Types prefixes its own with "label/" and "neurons/".',
      )
    }

    return { out: induceSubnetwork(network, kept) }
  },
})
