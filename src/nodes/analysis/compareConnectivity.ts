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
import type { InferContext, ParamDef } from '../../core/node'
import { changedParams } from '../../core/node'
import { T, findColumn, uniqueName } from '../../core/types'
import { isTableValue } from '../../core/values'
import type { CompareInput } from '../lib/edgeComparison'
import {
  COUNTS_SCHEMA,
  compareConnectivity as compareEdgeTables,
  compareParamsFrom,
  comparisonSchema,
} from '../lib/edgeComparison'
import { MAPPER_LABELS_SCHEMA } from '../lib/typeMapping'
import { ID_COLUMN_NAME } from '../../core/ids'
import { portIdAt } from '../../core/ports'
import { repeatGroups, repeatParamId, repeatParams } from '../lib/repeatParams'

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

/**
 * `A`, `B`, `C`, `D` — short, because these become column-name suffixes.
 *
 * Exported for `resolveDatasetNames`' reason one function down: these names *are* the output's
 * column names, so anything that has to say `weight_A` before this node has run has to read them
 * from here. The Workflow Wizard's cross-dataset arm is that caller — it writes the `name{n}`
 * params and points a Scatter Plot at two of the columns they produce, and a second spelling of
 * this rule would aim that viewer at a column the node does not emit.
 */
export function compareDatasetName(index: number): string {
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
      default: compareDatasetName(slot.index),
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
  const count = Math.max(2, Math.min(MAX_DATASETS, Number(ctx.params.datasetCount)))
  const taken = new Set<string>()
  return Array.from({ length: count }, (_, i) => {
    const index = i + 1
    const typed = String(ctx.params[repeatParamId('name', index)] ?? '').trim()
    return uniqueName(taken, typed || compareDatasetName(index))
  })
}

/**
 * What to say about a Labels port wired to something that is not a labels table.
 *
 * The wire cannot be refused and should not be: `isAssignable` ignores schema, so `Table{?}`
 * fits `Table{?}`, and a hand-built `{neuronId, label}` table is a perfectly good thing to
 * wire here — `producedBy` on the port states the pairing without constraining it.
 *
 * So this is the only thing that notices, and it has to exist, because **nothing else does**.
 * `idColumn` and `labelColumn` are required pickers sitting on their declared defaults, so
 * `resolveColumn`'s rule 3 substitutes the first compatible column of whatever arrived: wire a
 * neuron table here and `neuronId` matches by luck while `label` silently becomes `type` or
 * `instance`. The comparison then runs, and every row of it is a claim about a label space
 * nobody built. Measured: asked for a three-dataset comparison, a model wired each dataset's
 * own Connectivity neurons into these ports on five runs out of five.
 *
 * **Only where the schema is known**, per the codebase's oldest column rule — a schema without
 * `label` in it is very often a schema that has not arrived — and only while both pickers are
 * still at their declared defaults, since a name somebody *chose* is a decision and this is not
 * the place to argue with it.
 */
function labelsShapeIssue(ctx: InferContext, portId: string, index: number): string[] {
  const schema = ctx.schema(portId)
  // Rule one, and the oldest column rule in the codebase: a schema without `label` in it is
  // very often a schema that has not *arrived*.
  if (!schema) return []
  /*
   * Rule two: a name somebody chose is a decision, and this is not the place to argue with it.
   * Through `changedParams`, which owns that comparison — `defaultParams` writes each declared
   * default at creation, so "untouched" is the value *equal* to the default rather than an
   * absent one, and a hand-rolled `!==` also gets a list-valued param wrong.
   */
  if (changedParams(LABEL_PICKERS, ctx.params).length > 0) return []
  const missing = MAPPER_LABELS_SCHEMA.columns
    .map((c) => c.name)
    .filter((name) => !findColumn(schema, name))
  if (missing.length === 0) return []
  return [
    `Dataset ${index}: the Labels table has no ${missing.map((n) => `"${n}"`).join(' or ')} ` +
      `column, so it is not a Match Cell Types labels table — the comparison would be made ` +
      `against whichever columns happen to come first.`,
  ]
}

/*
 * The two pickers on the Labels tables, declared here rather than inline in `params` so that
 * `labelsShapeIssue` can read the same objects.
 *
 * Its premise is "still on its declared default", and written twice a default changed in one
 * place makes the check stand down permanently — a guard that passes while doing nothing. Both
 * defaults are `MAPPER_LABELS_SCHEMA`'s two column names, which is the pairing the check is
 * about.
 *
 * Shared across every dataset rather than declared per index, and that is not a shortcut: every
 * Labels table in one comparison comes from the same `Match Cell Types` node, so they have the
 * same two columns by construction. Four copies of this pair would be four chances to point one
 * of them at a column the others do not have, for a case that cannot arise.
 */
const LABEL_PICKERS: ParamDef[] = [
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
]

export const compareConnectivityNode = registerNode({
  type: 'compare.connectivity',
  label: 'Compare Connectivity',
  category: 'analysis',
  description:
    'Put the same type-to-type connection side by side across two or more connectomes.',
  guide:
    'Takes each dataset’s edge list plus its labels from Match Cell Types, rewrites both ends into the shared label space and sums per type pair, so one row reads “LC4 to DNp01 is 30 synapses here and 6 there”. Read the present columns before the weights: 0 is a real absence, empty means the type is missing there.',
  cost: 'cheap',

  inputs: [
    {
      repeat: 'datasetCount',
      ports: [
        { id: 'edges', label: 'Edges {n}', type: T.table() },
        /*
         * `producedBy` because nothing else says these two nodes are a pair: the port is
         * `Table{?}` at both ends, so `isAssignable` accepts any table and a model wired each
         * dataset's own neuron table here. It is a fact, not a constraint — a hand-built
         * `{neuronId, label}` table is a legitimate thing to wire, and the `validate` below is
         * what says so when the shape is wrong rather than refusing the wire.
         */
        {
          id: 'labels',
          label: 'Labels {n}',
          type: T.table(),
          producedBy: { type: 'compare.matchTypes' },
        },
      ],
    },
  ],
  outputs: [
    { id: 'comparison', label: 'Comparison', type: T.table() },
    { id: 'counts', label: 'Counts', type: T.table(COUNTS_SCHEMA) },
  ],

  /*
   * The card in tabs, because this is the node whose param band grows with its arity: four
   * settings per dataset means sixteen rows at four datasets, on a card that has to sit next to
   * the graph it is part of. One tab per dataset makes the height constant instead.
   *
   * `Settings` **first**, and that is load-bearing rather than tidy: the first tab is the one a
   * fresh card opens on, and `Datasets` — the control that brings the other tabs into existence
   * — is in it. Behind `Dataset 3` it would be a control you need in order to reach the tab
   * hiding it.
   *
   * The per-dataset ids come from `repeatGroups`; `repeatParams` puts each built param in the
   * matching tab itself, so nothing above has to name one. That pairing is the point — a param
   * naming a tab its node spells differently lands in the trailing "Other" with nothing on
   * screen to explain it.
   */
  paramGroups: [
    { id: 'shared', label: 'Settings' },
    ...repeatGroups(datasetCountParam, (index) => `Dataset ${index}`),
  ],

  params: [
    { ...datasetCountParam, group: 'shared' },
    ...perDatasetParams,
    {
      id: 'minWeight',
      group: 'shared',
      kind: 'int',
      label: 'Min weight',
      help: 'Drop a type pair no dataset reaches. Applied per row rather than per dataset, so a pair that is 1 here and 40 there survives.',
      default: 0,
      min: 0,
    },
    ...LABEL_PICKERS,
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
      const labelsPort = portIdAt('labels', index)
      if (!ctx.inputs[labelsPort]) {
        issues.push(`Dataset ${index}: wire the matching Labels table from Match Cell Types.`)
      } else {
        issues.push(...labelsShapeIssue(ctx, labelsPort, index))
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
