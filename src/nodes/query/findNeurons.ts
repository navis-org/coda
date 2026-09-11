import { warnOverThreshold } from '../../core/limits'
import { registerNode } from '../../core/registry'
import { neuronSetRequest } from '../lib/datasetParam'
import { T } from '../../core/types'
import { emptyTable, isTableValue } from '../../core/values'
import { resolveRows } from '../../data/filterRows'
import { asksNothing, noFiltersReason } from '../lib/findNeuronsRows'
import { FILTERS_PARAM_ID, rowGrammarNote, rowsFromParams } from '../lib/filterRowParams'
import {
  ANY_OPTION,
  datasetInfoFromType,
  requireDataset,
  schemasForDataset,
  schemasFromType,
  sourceLabel,
  sourceSupports,
} from '../lib/datasetParam'

/**
 * How a plan writes this node’s query.
 *
 * `filters` is an `ids` param — a `string[]` whose entries are JSON — and nothing about that kind
 * says so, which until the four legacy scalars were deleted did not matter: a model could set
 * `typePattern` and this was merely the tidy path. It is the only path now, so the catalogue has
 * to carry the grammar (`ParamBase.catalogueNote`).
 *
 * The grammar half is `rowGrammarNote`’s, generated from `ALL_ROW_OPS` and `arityOf` so that a
 * plan can never be told about an operator that has gone. What is written out here is the pair of
 * sentences that are about *this* node rather than about the grammar — where a field comes from,
 * and what an empty list means. `Split Neurons` supplies its own two, which differ on both counts.
 */
function filtersNote(): string {
  return rowGrammarNote({
    fields: [
      '`f` is a column of the *dataset\u2019s* neuron schema — read it off the `carries:` line on the',
      'Dataset wire; a field the dataset does not publish is reported on the card.',
    ],
    empty: [
      'An empty list is not "everything": with no filters this node returns **no neurons**. If the',
      'user wants a whole dataset, say so in your reply rather than inventing a row.',
    ],
  })
}

/**
 * Past this many matches, what came back is a population rather than a selection.
 *
 * Deliberately **not** `MAX_NEURONS`, which is the same 10,000 and is the default *and* maximum
 * of every geometry node's `Warn above`. Two thresholds that happen to share a value and answer
 * different questions — `docs/limits.md` records that tying one to the other is exactly what a
 * shared constant does, and this one is about the *table*: every id here lands in the provenance
 * key of everything downstream, and the next morphology node along is at its own ceiling before
 * it starts.
 *
 * Not a `Warn above` control either, and the principled reason rather than the mechanical one:
 * the six that carry that control are stating a cost *before* paying it, so raising the number is
 * a decision somebody can make. This fires after the fetch, when there is nothing left to raise —
 * an admission about the answer, not a rail in front of a wait. (`warnAboveParam` also spells its
 * control `limit`, which this node spends on a real `LIMIT`; that is a fact about the factory, and
 * `WarnAboveOptions` would take an `id` if the control were ever wanted.)
 *
 * The message is `warnOverThreshold`'s all the same. Firing after the fact is not grounds for a
 * hand-written one: `matchTypes` and `networkMetrics` both warn about a result already computed
 * and keep the house phrasing, whose closing clause — that there *will* be a result — is the half
 * `core/limits.ts` records as load-bearing.
 */
const FOUND_NEURONS_WARN = 10_000

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
 * **A node that asks nothing returns nothing**, and that is a decision made *here* rather than at
 * the seam — `asksNothing` in `nodes/lib/findNeuronsRows.ts` states it and says why an empty
 * `FindNeuronsRequest.rows` goes on meaning the opposite one layer down. What it replaced was
 * "no rows means everything in this dataset", which was honest and uniform across backends and
 * cost a fresh card on hemibrain all 176,422 neurons, untraced fragments included, fired at a
 * shared production Neo4j the first time anybody pressed Run. Two things it is not: it is not the
 * old `Traced` default coming back — that was a *filter nobody chose*, which silently emptied the
 * result on a dataset without statuses, where this narrows nothing and empties the result out
 * loud — and it is not a refusal, because there is no wait to interrupt and nothing to raise. The
 * empty table carries the dataset's own neuron schema, so every column picker downstream survives
 * it.
 *
 * **The five boxes are gone, not deprecated.** `typePattern`, `instancePattern`, `status` and
 * `minSize` were declared here long after they stopped being the query, folded into rows by
 * `findNeuronsRows.ts` so that fifty tests and every saved file kept working. Those tests say it
 * in rows now, which is the migration a load-time one could never have performed — and the
 * remainder, an alpha-era `.coda.json`, arrives holding four keys no definition declares.
 * `normalizeParams` reads only declared params, so such a node is simply an unfiltered one: under
 * the rule above it returns nothing and says so, rather than quietly querying a connectome. That
 * ordering is why the empty rule went in first. `roi` is the one that stayed, because a region
 * still cannot be a column.
 *
 * Expensive: it hits the backend, so it goes stale on edit and waits for Run rather than firing a
 * query on every keystroke in a value field.
 */

registerNode({
  type: 'neuron.findNeurons',
  label: 'Find Neurons',
  category: 'query',
  // Wider than Rename's, because a filter is three controls on a line rather than two: a field,
  // an operator and a value.
  cardWidth: 360,
  description: 'Search a dataset for neurons, by any field the dataset publishes.',
  guide:
    'The workhorse query: narrow to the neurons you mean, one filter row at a time. The field list is the dataset\u2019s own \u2014 a neuPrint dataset offers status and size, a FlyWire datastack offers super_class. Rows combine with AND, and \u201cis one of\u201d takes several values, which is how you say OR. With no filters it returns no neurons: these run against a live server.',
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
      id: FILTERS_PARAM_ID,
      kind: 'ids',
      label: 'Filters',
      noun: 'filters',
      help: 'Filter rows, combined with AND. Each names a field of this dataset, an operator and a value. With none set the node returns no neurons.',
      catalogueNote: filtersNote(),
      default: [],
    },
    {
      id: 'roi',
      kind: 'enum',
      label: 'In ROI',
      help: 'Restrict to neurons with synapses in this region. A region cannot be a filter row, but it is still a filter: a node whose only setting is a region does query.',
      default: '',
      advanced: true,
      optionsWithoutPeek: true,
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
      help: 'Cap on how many matches come back. 0 caps nothing \u2014 and a limit is not a filter, so a node whose only setting is a limit still returns no neurons.',
      default: 0,
      min: 0,
      step: 10,
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
      issues.push(
        `${label} cannot filter neurons by region — clear "In ROI" to search this dataset`,
      )
    }
    return issues
  },

  evaluate: async (ctx) => {
    const dataset = requireDataset(ctx.input('dataset'))
    const source = ctx.resolveSource(dataset.sourceId)

    /*
     * Nothing asked, nothing returned — before the fetch, because the whole point is that there
     * is no fetch. `asksNothing` owns the rule, including the two params that decide it: `In ROI`
     * counts and `Limit` does not.
     *
     * The schema is `schemasForDataset`, not `CANONICAL_SCHEMAS` and not a shape minted here.
     * `inferOutputs` advertises the dataset's own neuron schema at edit time, and a node that
     * builds a different one at run time breaks invariant 3 in the direction no type check
     * catches — every column picker downstream would empty on Run and stay empty, which reads as
     * a broken dataset rather than an unconfigured card.
     *
     * It warns rather than passing the empty table off as an answer. This is the one thing here
     * that is genuinely indistinguishable from a real result: a dataset can hold no neuron
     * matching a filter, and "0 rows" looks the same either way.
     */
    const rows = rowsFromParams(ctx.params)
    if (asksNothing(ctx.params, rows)) {
      ctx.warn(
        `${noFiltersReason()} Add a filter row — or use Explore Dataset to browse without ` +
          'asking anything.',
      )
      return { neurons: emptyTable(schemasForDataset(source, dataset).neurons, 'neurons') }
    }

    ctx.progress(0.1, 'querying')
    const neurons = await source.findNeurons({
      // `neuronSetRequest`, not `datasetRequest`: this is one of the two queries the dataset's
      // own population checkboxes narrow. A `status` row written here still removes the `traced`
      // disjunct — the row is the more specific of the two statements, and `findNeuronsCypher`
      // is where that precedence is decided rather than here.
      ...neuronSetRequest(dataset),
      rows,
      roi: String(ctx.params.roi) || undefined,
      limit: Number(ctx.params.limit) || undefined,
      signal: ctx.signal,
    })

    if (!isTableValue(neurons)) throw new Error('Source returned a non-table result')
    // After the fact, because a match count is not knowable before the fetch — see
    // `FOUND_NEURONS_WARN` for why that makes this an admission rather than a guard rail.
    if (neurons.length > FOUND_NEURONS_WARN) {
      warnOverThreshold(ctx, {
        count: neurons.length,
        threshold: FOUND_NEURONS_WARN,
        unit: 'neurons matched',
        control: 'the size a selection usually has',
        cost:
          'Every one of those ids travels into the provenance key of everything downstream, and ' +
          'a morphology node below this is over its own Warn above before it starts.',
      })
    }
    return { neurons }
  },
})
