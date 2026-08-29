/**
 * Compare Connectivity — the same connection, counted in two or more connectomes.
 *
 * The node around [edgeComparison.ts](../lib/edgeComparison.ts), which holds the algorithm and
 * its reasoning. What lives here is what the algorithm deliberately does not know: which wires,
 * which columns, what the datasets are called, and what the answer looks like as two tables. See
 * [comparative.md](../../../docs/comparative.md) for the decisions.
 *
 * **It relabels internally** (decision 8). The obvious composition — a `Relabel` per dataset
 * feeding a shared aggregation — is a nine-node comparison against this five-node one, and the
 * relabelling is not a step anybody wants to inspect. What it must *not* be is a second, private
 * spelling of relabelling: `labelsByNeuron` resolves ids through `idText` and takes the first of
 * a repeated key, which is `relabelTable`'s rule, so the node and the `Relabel` beside it cannot
 * come to disagree about what a mapping means.
 *
 * **`cheap`, and that is a real decision** (invariant 6). Every fetch is upstream — this reads
 * two tables per dataset that are already in hand — so re-running it per keystroke costs a pass
 * over an edge list and nothing on anybody's server. That is what makes re-asking the question
 * with a different `Min weight` free, which is most of the point.
 *
 * **Two sockets per dataset.** The alternative was one input taking a `Stack Tables` of
 * pre-labelled edges with a source column, which needs no variadic ports at all and is more
 * Coda-native; it was declined because it forces exactly the per-dataset `Relabel` decision 8
 * folds in. Worth re-reading now that `Relabel` exists and works — the reason for the rejection
 * has weakened, though the node count has not changed.
 */

import { registerNode } from '../../core/registry'
import { T, uniqueName } from '../../core/types'
import { isTableValue } from '../../core/values'
import type { CompareInput } from '../lib/edgeComparison'
import {
  COUNTS_SCHEMA,
  compareConnectivity as compareEdgeTables,
  compareParamsFrom,
  comparisonSchema,
} from '../lib/edgeComparison'
import { ID_COLUMN_NAME } from '../../core/ids'
import { portIdAt } from '../../core/ports'
import { repeatParamId, repeatParams } from '../lib/repeatParams'

/**
 * How many connectomes one comparison may span.
 *
 * `MAX_DATASETS` in `matchTypes.ts`, and deliberately the same number: a comparison is read off
 * a mapping, so a fifth dataset here would be a fifth column of a table the mapper cannot
 * produce. Raising one without the other is how the two come to disagree about what is possible.
 */
const MAX_DATASETS = 4

/**
 * The arity, declared once and handed to both the param list and `repeatParams`.
 *
 * `registerNode` reads the group's range off this object; so does the picker loop. A bare
 * `MAX_DATASETS` in the second place is the copy `registry.ts` removed from `PortGroupDef`.
 */
const datasetCountParam = {
  id: 'datasetCount',
  kind: 'int',
  label: 'Datasets',
  help: 'How many connectomes to compare. Each adds an Edges and a Labels socket.',
  default: 2,
  min: 2,
  max: MAX_DATASETS,
} as const

/** `A`, `B`, `C`, `D` — short, because these become column-name suffixes. */
function defaultName(index: number): string {
  return String.fromCharCode(64 + index)
}

/**
 * The per-dataset controls: what to call it, and which three columns of its edge list to read.
 *
 * `repeatParams` supplies the id suffix, the port suffix and the `visibleIf`. The port id is one
 * call — `slot.port('edges')` — for the reason that module records: `from` and a second spelling
 * of the same port are how a picker comes to read dataset 2's schema while resolving against
 * dataset 3, which shows as an empty column list rather than as a bug.
 *
 * The defaults are `Connectivity`'s own output columns, since that is what will be wired here
 * nine times out of ten. `weight` is optional and empty means one per row, which is what an
 * unweighted edge list means — so a picker that resolves to nothing is a decision here rather
 * than a refusal.
 */
const perDatasetParams = repeatParams({
  count: datasetCountParam,
  build: (slot) => [
    {
      id: slot.id('name'),
      kind: 'string',
      label: `Name ${slot.index}`,
      help: 'What this dataset is called in the output’s column names — weight_A, present_A. Keep it short.',
      default: defaultName(slot.index),
    },
    {
      id: slot.id('pre'),
      kind: 'column',
      label: `Pre ${slot.index}`,
      fromPort: 'edges',
      help: 'The presynaptic neuron id.',
      default: 'preId',
    },
    {
      id: slot.id('post'),
      kind: 'column',
      label: `Post ${slot.index}`,
      fromPort: 'edges',
      help: 'The postsynaptic neuron id.',
      default: 'postId',
    },
    {
      id: slot.id('weight'),
      kind: 'column',
      label: `Weight ${slot.index}`,
      fromPort: 'edges',
      help: 'Synapse count. Leave empty to count each row as one, which is what an unweighted edge list means.',
      default: 'weight',
      optional: true,
    },
  ],
})

/**
 * The dataset names, deduplicated, in port order.
 *
 * One function behind `inferOutputs`, `validate` and `evaluate` — `join.ts`'s `specOf` idiom, and
 * here it is load-bearing twice over. These names *are* the output schema (invariant 3), so a
 * second derivation would publish columns the run does not produce. And two datasets sharing a
 * name would collapse two `weight_` columns onto one key in `makeTable`, which is a table with a
 * column silently missing rather than an error — hence `uniqueName`, the codebase's one
 * collision rule.
 *
 * Exported for the emitters, `relabelTarget`'s reason one node over: these names are the output's
 * column names, and an exporter that re-derived the fallback-and-deduplicate rule would write a
 * notebook naming a column the canvas does not have.
 */
export function resolveDatasetNames(ctx: {
  params: Readonly<Record<string, unknown>>
}): string[] {
  const count = Math.max(2, Math.min(MAX_DATASETS, Number(ctx.params.datasetCount ?? 2)))
  const taken = new Set<string>()
  return Array.from({ length: count }, (_, i) => {
    const index = i + 1
    const typed = String(ctx.params[repeatParamId('name', index)] ?? '').trim()
    return uniqueName(taken, typed || defaultName(index))
  })
}

export const compareConnectivityNode = registerNode({
  type: 'compare.connectivity',
  label: 'Compare Connectivity',
  category: 'analysis',
  description: 'Put the same type-to-type connection side by side across two or more connectomes.',
  guide:
    'Takes each dataset’s edge list plus its labels from Match Cell Types, rewrites both ends into the shared label space and sums per type pair, so one row reads “LC4 to DNp01 is 30 synapses here and 6 there”. Read the present columns before the weights: a weight of 0 means that dataset holds both types and has no such connection — a real absence, often the finding — while an empty weight means one of the types is missing there, so nothing was asked. Weights are raw synapse counts and are not comparable between brains of different completeness; the counts output carries the neuron numbers and directional totals a normalisation needs.',
  cost: 'cheap',

  inputs: [
    {
      repeat: 'datasetCount',
      ports: [
        { id: 'edges', label: 'Edges {n}', type: T.table() },
        { id: 'labels', label: 'Labels {n}', type: T.table() },
      ],
    },
  ],
  outputs: [
    { id: 'comparison', label: 'Comparison', type: T.table() },
    { id: 'counts', label: 'Counts', type: T.table(COUNTS_SCHEMA) },
  ],

  params: [
    datasetCountParam,
    ...perDatasetParams,
    {
      id: 'minWeight',
      kind: 'int',
      label: 'Min weight',
      help: 'Drop a type pair no dataset reaches. Per row rather than per dataset on purpose: a pair that is 1 here and 40 there is the asymmetry you set a threshold hoping to see past, not the noise you meant to trim.',
      default: 0,
      min: 0,
    },
    /*
     * Shared rather than per dataset, and that is not a shortcut: every Labels table in one
     * comparison comes from the same `Match Cell Types` node, so they have the same two columns
     * by construction. Four copies of this pair would be four chances to point one of them at a
     * column the others do not have, for a case that cannot arise.
     */
    {
      id: 'idColumn',
      kind: 'column',
      label: 'Labels: neuron id',
      from: 'labels1',
      help: 'On the Labels tables: the neuron id column. Match Cell Types publishes neuronId.',
      default: ID_COLUMN_NAME,
      advanced: true,
    },
    {
      id: 'labelColumn',
      kind: 'column',
      label: 'Labels: label',
      from: 'labels1',
      help: 'On the Labels tables: the shared label column.',
      default: 'label',
      advanced: true,
    },
  ],

  /*
   * `comparison` is the one output whose schema is genuinely derived — two columns per dataset,
   * named after params — so unlike `Match Cell Types` this node does need an `inferOutputs`. It
   * is what lets a Filter downstream offer `weight_hemibrain` before anything has run.
   *
   * `counts` is long on purpose and its schema is a constant, which is the trade recorded in
   * `edgeComparison.ts`: nothing in it is read side by side, so a constant schema is worth more
   * than adjacency. It is seeded from the port's declared type and is not restated here.
   */
  inferOutputs: (ctx) => ({
    comparison: T.table(comparisonSchema(resolveDatasetNames(ctx))),
  }),

  validate: (ctx) => {
    const issues: string[] = []
    const names = resolveDatasetNames(ctx)

    names.forEach((name, i) => {
      const index = i + 1
      const typed = String(ctx.params[repeatParamId('name', index)] ?? '').trim()
      if (typed && typed !== name) {
        issues.push(
          `Dataset ${index}: another dataset is already called "${typed}", so its columns are ` +
            `named after "${name}" instead.`,
        )
      }
    })

    for (const port of ctx.inputPorts()) {
      // `group.base` is the template's own id, so this asks which port of the pair it is rather
      // than testing the resolved id's prefix — which would also match a later `edgesExtra`.
      if (port.group?.repeat !== 'datasetCount' || port.group.base !== 'edges') continue
      const index = port.group.index
      if (!ctx.inputs[port.id]) continue
      /*
       * Both ends are required and neither has a useful fallback — a comparison missing one side
       * of its edges is not a smaller answer, it is no answer. Said on the card while there is
       * still something to change, rather than at Run.
       */
      for (const role of ['pre', 'post'] as const) {
        if (!ctx.column(repeatParamId(role, index))) {
          issues.push(`Dataset ${index}: pick the ${role}synaptic id column.`)
        }
      }
      if (!ctx.inputs[portIdAt('labels', index)]) {
        issues.push(`Dataset ${index}: wire the matching Labels table from Match Cell Types.`)
      }
    }
    return issues
  },

  evaluate: (ctx) => {
    const spec = compareParamsFrom(ctx, resolveDatasetNames(ctx), repeatParamId)
    const inputs: CompareInput[] = spec.names.map((name, i) => {
      const index = i + 1
      // Through `portIdAt`, the rule `core/ports.ts` names these ports by — never a template
      // literal, which is how a suffix-rule change compiles and silently reads nothing.
      const edges = ctx.input(portIdAt('edges', index))
      const labels = ctx.input(portIdAt('labels', index))
      if (!isTableValue(edges)) throw new Error(`Edges ${index} is not a table`)
      if (!isTableValue(labels)) throw new Error(`Labels ${index} is not a table`)
      const columns = spec.columns[i]!
      if (!columns.pre || !columns.post) {
        throw new Error(`Dataset ${index}: both the pre and post id columns must be selected`)
      }
      return {
        name,
        edges,
        labels,
        columns,
        idColumn: spec.idColumn,
        labelColumn: spec.labelColumn,
      }
    })

    return compareEdgeTables(inputs, { minWeight: spec.minWeight, warn: ctx })
  },
})
