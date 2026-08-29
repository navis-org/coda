import { registerNode } from '../../core/registry'
import { neuronSetRequest } from '../lib/datasetParam'
import { T } from '../../core/types'
import { isTableValue } from '../../core/values'
import { resolveRows } from '../../data/filterRows'
import { rowsFromParams } from '../lib/findNeuronsRows'
import {
  ANY_OPTION,
  datasetInfoFromType,
  requireDataset,
  schemasFromType,
  sourceLabel,
  sourceSupports,
} from '../lib/datasetParam'

/**
 * Find neurons matching a set of filters. The workhorse entry query.
 *
 * A filter is a row — `{field, operator, value}` — and the field comes from the dataset's **own**
 * neuron schema. That is the whole design, and it replaced five fixed boxes that were neuPrint's
 * fields spelled as a card: `Type`, `Instance`, `Status`, `Min size`, `In ROI`. Three of the four
 * backends paid for that arrangement, and each in a way that returned a wrong count rather than
 * an error — a **Min size** box on a datastack publishing no size, a `Status` default of `Traced`
 * filtering on a column CAVE does not have, an **In ROI** dropdown of eighty CATMAID neuropils
 * that narrowed nothing at all. Rows make the whole class unreachable: hemibrain offers
 * `cellBodyFiber`, FlyWire offers `super_class`, CATMAID offers `annotations` and `cableLength`,
 * and none of them can be asked for a field it does not publish. See `data/filterRows.ts`.
 *
 * **`In ROI` is the one control that is still not a row**, because a region is not a column: in
 * neuPrint a neuron carries one boolean property per ROI it innervates, so the name appears in no
 * schema and a schema-driven dropdown cannot offer it. It is gated on `roiFilter` — whether the
 * source can *answer* it — rather than on `DatasetInfo.rois` being non-empty, which is precisely
 * the pair that came apart on CATMAID.
 *
 * **A new node filters nothing.** No rows, no status, no limit: an honest "everything in this
 * dataset", uniform across backends. The old `Traced` default was a filter nobody chose, and on a
 * dataset without statuses it silently emptied the result — but note the cost of the other
 * direction, which is that a fresh node on hemibrain now asks for all 176,422 neurons including
 * untraced fragments. Saved graphs are unaffected: `defaultParams` wrote `Traced` into every node
 * that has one, and `rowsFromParams` still reads it.
 *
 * Expensive: it hits the backend, so it goes stale on edit and waits for Run rather than firing a
 * query on every keystroke in a value field.
 */
export const findNeuronsNode = registerNode({
  type: 'neuron.findNeurons',
  label: 'Find Neurons',
  category: 'query',
  description: 'Search a dataset for neurons, by any field the dataset publishes.',
  guide:
    'The workhorse query: narrow to the neurons you mean, one filter row at a time. The field list is the dataset\u2019s own \u2014 a neuPrint dataset offers status and size, a FlyWire datastack offers super_class. Rows combine with AND, and \u201cis one of\u201d takes several values, which is how you say OR. The limit defaults to 0 (everything), deliberately: these run against a live server.',
  cost: 'expensive',
  inputs: [{ id: 'dataset', label: 'Dataset', type: T.dataset() }],
  outputs: [{ id: 'neurons', label: 'Neurons', type: T.neurons() }],
  params: [
    {
      /*
       * The rows, as an opaque `string[]` the card owns — the third shape `IdsParam` describes,
       * beside `out.table`'s filter clauses and `core.rename`'s remappings, and for the same
       * reason: the number of rows is not known when the definition is written, so no generic
       * widget can draw them. Never `presentational`; this is the query.
       */
      id: 'filters',
      kind: 'ids',
      label: 'Filters',
      noun: 'filters',
      help: 'Filter rows, combined with AND. Each names a field of this dataset, an operator and a value.',
      default: [],
    },
    {
      id: 'roi',
      kind: 'enum',
      label: 'In ROI',
      help: 'Restrict to neurons with synapses in this region. Not a field: a region is a property per ROI rather than a column, so it cannot be a filter row.',
      default: '',
      advanced: true,
      options: (ctx) => {
        // Gated on whether the source can *answer* a region filter, not on whether it happens to
        // publish a region list. CATMAID publishes eighty and can answer none of them.
        if (!sourceSupports(ctx.inputs.dataset, 'roiFilter')) return [ANY_OPTION]
        const info = datasetInfoFromType(ctx.inputs.dataset)
        return [ANY_OPTION, ...(info?.rois ?? []).map((r) => ({ value: r, label: r }))]
      },
    },
    {
      id: 'limit',
      kind: 'int',
      label: 'Limit',
      help: '0 returns everything that matches.',
      default: 0,
      min: 0,
      step: 10,
      advanced: true,
    },
    /*
     * The five that were the card, kept readable so that every saved graph, starter graph, export
     * golden and test that writes `{ typePattern: 'LC.*' }` keeps working unchanged.
     *
     * `advanced` rather than `visibleIf`-hidden, and that is invariant 4 rather than taste: a
     * hidden param is dropped from the provenance key, so one that still reached `evaluate` would
     * let a stale result survive an edit to it. `findNeuronsRows.ts` folds them into rows; the
     * card converts them the first time somebody touches the filters.
     *
     * `status` now defaults to empty where it used to default to `Traced`. Existing nodes are
     * unaffected — `defaultParams` wrote the old default into each of them when it was created,
     * and it is still read.
     */
    {
      id: 'typePattern',
      kind: 'string',
      label: 'Type',
      placeholder: 'e.g. LC.* or ^KC',
      help: 'Replaced by a "type matches" filter row. Kept so older graphs keep working; clearing it is safe once the equivalent row exists.',
      default: '',
      advanced: true,
    },
    {
      id: 'instancePattern',
      kind: 'string',
      label: 'Instance',
      placeholder: 'regex',
      help: 'Replaced by an "instance matches" filter row.',
      default: '',
      advanced: true,
    },
    {
      id: 'status',
      kind: 'enum',
      label: 'Status',
      help: 'Replaced by a "status is" filter row. Empty by default now: a fresh node filters nothing.',
      default: '',
      advanced: true,
      options: (ctx) => {
        const info = datasetInfoFromType(ctx.inputs.dataset)
        return [ANY_OPTION, ...(info?.statuses ?? []).map((s) => ({ value: s, label: s }))]
      },
    },
    {
      id: 'minSize',
      kind: 'int',
      label: 'Min size',
      help: 'Replaced by a "size ≥" filter row.',
      default: 0,
      min: 0,
      step: 10_000,
      advanced: true,
    },
  ],

  inferOutputs: (ctx) => ({
    neurons: T.neurons(schemasFromType(ctx.inputs.dataset).neurons),
  }),

  /*
   * Every problem `resolveRows` can name, on the card and before anything runs.
   *
   * This node can do that where `out.table` cannot, and the difference is where the schema comes
   * from: a Dataset socket carries the dataset's neuron schema at edit time, so a row naming a
   * field this dataset does not have is knowable the moment it is wired. Which matters, because
   * the run-time alternative is a refusal against a shared production server — and the
   * alternative to *that* is dropping the row and answering a broader question, which looks
   * exactly like a correct answer.
   */
  validate: (ctx) => {
    const issues = resolveRows(
      schemasFromType(ctx.inputs.dataset).neurons,
      rowsFromParams(ctx.params),
    ).problems.map((problem) => problem.message)

    if (ctx.params.roi && !sourceSupports(ctx.inputs.dataset, 'roiFilter')) {
      const label = sourceLabel(ctx.inputs.dataset) ?? 'This source'
      issues.push(`${label} cannot filter neurons by region — clear "In ROI" to search this dataset`)
    }
    return issues
  },

  evaluate: async (ctx) => {
    const dataset = requireDataset(ctx.input('dataset'))
    const source = ctx.resolveSource(dataset.sourceId)

    ctx.progress(0.1, 'querying')
    const neurons = await source.findNeurons({
      // `neuronSetRequest`, not `datasetRequest`: this is one of the two queries the dataset's
      // own population checkboxes narrow. A `status` row written here still removes the `traced`
      // disjunct — the row is the more specific of the two statements, and `findNeuronsCypher`
      // is where that precedence is decided rather than here.
      ...neuronSetRequest(dataset),
      rows: rowsFromParams(ctx.params),
      roi: String(ctx.params.roi ?? '') || undefined,
      limit: Number(ctx.params.limit ?? 0) || undefined,
      signal: ctx.signal,
    })

    if (!isTableValue(neurons)) throw new Error('Source returned a non-table result')
    return { neurons }
  },
})
