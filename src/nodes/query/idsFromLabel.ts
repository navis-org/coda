import { registerNode } from '../../core/registry'
import { datasetRequest } from '../lib/datasetParam'
import { T } from '../../core/types'
import { isTableValue, tableFromRows } from '../../core/values'
import {
  ANY_OPTION,
  datasetInfoFromType,
  requireDataset,
  schemasForDataset,
  schemasFromType,
} from '../lib/datasetParam'
import { collectLabels, labelMatch, parseTypedLabels } from '../lib/labelLookup'

/**
 * Labels in, neuron ids out — the inverse of everything else in this menu.
 *
 * `Find Neurons` narrows a population with a pattern; this resolves a *named set*. The two
 * overlap for one label against one field (neuPrint's `=~` anchors, so `LC4|LC6` in a Type
 * field already returns those two types), and the overlap is not what this exists for. It
 * exists because the labels usually come from somewhere: the `type` column of a Connectivity
 * result, a `groupBy` roll-up, a list pasted out of a paper. Those cannot be typed into a
 * regex field by hand, and turning them into one would be a node in itself.
 *
 * Three decisions that the code alone will not explain:
 *
 * **Any neuron column, not just type.** The field picker reads the dataset's *discovered*
 * neuron schema, so `class`, `superclass` and `hemilineage` are lookups too. That is why this
 * goes through `LabelMatch` at the source seam rather than through `typePattern`: the seam had
 * two hardcoded fields, and adding a third and a fourth would have been the same edit again.
 *
 * **No `limit`.** Every other query node has one, and here it would be a quiet lie — the card
 * reports which labels matched nothing by reading the result back, so a truncated result would
 * report labels as missing that are in the dataset. A lookup of a named set has a size that
 * the question already fixes; capping it answers a different one.
 *
 * **Empty is empty.** No labels typed and nothing wired returns an empty table rather than the
 * whole dataset, which is what an empty `typePattern` means one node over. The inversion is the
 * point: a pattern that narrows nothing is everything, a lookup of nothing is nothing — and an
 * unconfigured node that fires an unbounded `MATCH (n:Neuron)` at a shared production Neo4j is
 * a hazard, not a default.
 */
export const idsFromLabelNode = registerNode({
  type: 'neuron.idsFromLabel',
  label: 'IDs from Label',
  category: 'query',
  description: 'Resolve cell type or other labels back to the neurons carrying them.',
  guide:
    'Resolve labels to neurons carrying them — the inverse of Find Neurons. Default to exact match because labels usually come from text people copied (a type column, a groupBy roll-up, a paper), and turning SMP001(a) into a regex would lose the literal parentheses.',
  cost: 'expensive',
  inputs: [
    { id: 'dataset', label: 'Dataset', type: T.dataset() },
    // Optional: the typed list alone is a complete question, and a node that could not be used
    // until something was wired to it would be useless as the entry point it often is.
    { id: 'labels', label: 'Labels', type: T.table(), required: false },
  ],
  outputs: [{ id: 'neurons', label: 'Neurons', type: T.neurons() }],
  params: [
    {
      id: 'field',
      kind: 'column',
      label: 'Field',
      from: 'dataset',
      // A Dataset socket carries a source id, not a schema, so the picker is handed the lookup
      // — same idiom as Explore's Tags, and the same reason: `src/core` cannot import the
      // data-source registry. Restricted to text columns because a label is text; a numeric
      // column would offer `size` and `pre` as things to look neurons up by.
      schemaFrom: (inputs) => schemasFromType(inputs.dataset).neurons,
      dtypes: ['str'],
      help: 'Which neuron property the labels name. Defaults to the type.',
      default: '',
    },
    {
      id: 'labels',
      kind: 'string',
      label: 'Labels',
      multiline: true,
      placeholder: 'LC4, LC6\nLPLC2',
      help: 'Labels to look up, separated by commas or newlines. Combined with the wired column.',
      default: '',
    },
    {
      id: 'column',
      kind: 'column',
      label: 'Label column',
      from: 'labels',
      dtypes: ['str'],
      help: 'Which column of the wired table holds the labels.',
      default: '',
      // Nothing has to be wired here, so a table arriving with no text column is not an issue
      // worth a badge — it is a picker nobody has touched on an input nobody has to use.
      optional: true,
    },
    {
      id: 'match',
      kind: 'enum',
      label: 'Match',
      default: 'exact',
      options: [
        { value: 'exact', label: 'exact label' },
        { value: 'regex', label: 'regular expression' },
      ],
      help: 'Exact treats a label literally, so parentheses and dashes in a name are safe. Regex matches the whole name, like Find Neurons.',
    },
    {
      id: 'ignoreCase',
      kind: 'boolean',
      label: 'Ignore case',
      default: false,
      advanced: true,
    },
    {
      id: 'status',
      kind: 'enum',
      label: 'Status',
      // Traced, as Find Neurons has always defaulted: the same label in the two nodes should
      // not return two different counts. Set it to Any to include untraced fragments.
      default: 'Traced',
      advanced: true,
      options: (ctx) => {
        const info = datasetInfoFromType(ctx.inputs.dataset)
        const statuses = info?.statuses ?? ['Traced']
        return [ANY_OPTION, ...statuses.map((s) => ({ value: s, label: s }))]
      },
    },
  ],

  inferOutputs: (ctx) => ({
    neurons: T.neurons(schemasFromType(ctx.inputs.dataset).neurons),
  }),

  validate: (ctx) => {
    const issues: string[] = []
    if (ctx.params.match === 'regex') {
      // Only the typed half can be checked at edit time; the wired column is a value. Reported
      // per pattern rather than as "one of these is bad", since a list can be long.
      for (const pattern of parseTypedLabels(ctx.params.labels)) {
        try {
          new RegExp(pattern)
        } catch (err) {
          issues.push(`Invalid pattern /${pattern}/: ${(err as Error).message}`)
        }
      }
    }
    return issues
  },

  evaluate: async (ctx) => {
    const dataset = requireDataset(ctx.input('dataset'))
    const source = ctx.resolveSource(dataset.sourceId)
    const schema = schemasForDataset(source, dataset).neurons

    const wired = ctx.input('labels')
    if (wired !== undefined && !isTableValue(wired))
      throw new Error('Labels input is not a table')

    const field = ctx.column('field')
    const labels = collectLabels({
      typed: ctx.params.labels,
      table: wired,
      column: ctx.column('column'),
    })

    const match = labelMatch(field, labels, {
      regex: ctx.params.match === 'regex',
      ignoreCase: Boolean(ctx.params.ignoreCase),
    })

    /*
     * Nothing to look up is an answer, not an error: a freshly added node has neither a typed
     * label nor a wire, and a red card blocking everything downstream reads as broken rather
     * than as unconfigured. The card says which it is. An empty table of the right *schema*,
     * so downstream column pickers populate before anyone types anything.
     */
    if (!match) {
      ctx.progress(1, 'no labels')
      return { neurons: tableFromRows(schema, []) }
    }

    const status = String(ctx.params.status ?? '')
    ctx.progress(0.1, `${labels.length} label${labels.length === 1 ? '' : 's'}`)

    const neurons = await source.findNeurons({
      ...datasetRequest(dataset),
      labels: match,
      statuses: status ? [status] : undefined,
      signal: ctx.signal,
    })

    if (!isTableValue(neurons)) throw new Error('Source returned a non-table result')
    return { neurons }
  },
})
