import { numericId } from '../../core/ids'
import { datasetRequest } from '../lib/datasetParam'
import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { isDatasetValue, isTableValue, tableFromRows } from '../../core/values'
import { schemasForDataset, schemasFromType } from '../lib/datasetParam'
import { collectIds, parseIdList } from '../lib/idList'
import { ID_ONLY_SCHEMA } from '../lib/tableOps'

/**
 * A list of neuron ids, typed or pasted, as a table.
 *
 * The plainest entry point there is: somebody has ids from a paper, a spreadsheet or a
 * colleague and wants them in the graph. `IDs from Label` is the sibling that resolves a
 * *named* set; this takes the ids themselves.
 *
 * ## The Dataset input is optional, and that is the whole design
 *
 * Unwired, the node emits the ids as a one-column `Neurons` table and touches no network. That
 * is already enough for most of what a list of ids is *for*: `Connectivity`, `Skeletons`,
 * `Meshes`, `Synapses` and `ROI Counts` all reach their ids through `idColumn(table, 'neuronId')`
 * and read nothing else off the row.
 *
 * Wired, it fetches the full neuron rows, which buys two things the id column cannot: the
 * columns every downstream picker and viewer wants (`type`, `status`, `size`), and the ability
 * to say **which ids the dataset has never heard of** — which is how a mistyped id is caught,
 * and is otherwise uncatchable.
 *
 * **`expensive` either way, because `cost` is a static property of the definition.** A node that
 * can issue a query must not be `cheap`: the ids are a text field, and `cheap` would fire a
 * query per keystroke at a shared production Neo4j (invariant 6). So the unwired case pays a Run
 * press it does not strictly need — the right direction to err, and cheaper than the only
 * alternative, which is two nodes doing one thing.
 *
 * ## No status filter, unlike every other query node here
 *
 * `Find Neurons` and `IDs from Label` both default to `Traced`, so one label does not return two
 * different counts in two nodes. Here that would be a quiet lie. An explicit list of ids is an
 * explicit set: dropping one for its status would remove a neuron somebody named *and* then
 * report it as missing from the dataset. Filtering belongs downstream, where it is visible.
 */
export const inputIdsNode = registerNode({
  type: 'neuron.inputIds',
  label: 'Input IDs',
  category: 'query',
  description: 'A list of neuron IDs, typed or pasted, as a table.',
  guide:
    'A list of neuron IDs you already have — from a paper, a spreadsheet, a colleague. Paste them in any form; brackets and newlines are separators. Wire a Dataset to get full rows and a count of IDs it never heard of; unwired it just emits the IDs as a one-column table.',
  cost: 'expensive',
  inputs: [
    // Optional on both: a typed list alone is a complete question, and a node unusable until
    // something is wired to it is useless as the entry point this mostly is.
    { id: 'dataset', label: 'Dataset', type: T.dataset(), required: false },
    { id: 'ids', label: 'IDs', type: T.table(), required: false },
  ],
  outputs: [{ id: 'neurons', label: 'Neurons', type: T.neurons(ID_ONLY_SCHEMA) }],
  params: [
    {
      id: 'ids',
      kind: 'string',
      label: 'IDs',
      multiline: true,
      placeholder: '1234, 5678\n91011',
      help: 'Separated by spaces, commas or newlines. Brackets and quotes count as separators.',
      default: '',
    },
    {
      id: 'column',
      kind: 'column',
      label: 'ID column',
      help: 'Which column of the wired table holds the ids.',
      from: 'ids',
      default: 'neuronId',
      optional: true,
    },
  ],

  /**
   * One column with no Dataset wired, the dataset's whole neuron schema with one.
   *
   * The schema changing with the wiring is the visible cost of an optional input, and it is the
   * honest shape: with no dataset there is genuinely nothing here but the ids, and advertising a
   * `type` column that nothing will ever fill would break every picker downstream that believed
   * it. Both branches are what `evaluate` actually returns — invariant 3, by construction.
   */
  inferOutputs: (ctx) => ({
    neurons: T.neurons(
      ctx.inputs.dataset ? schemasFromType(ctx.inputs.dataset).neurons : ID_ONLY_SCHEMA,
    ),
  }),

  /**
   * The parse runs at edit time, which is the point of it being a pure function.
   *
   * A refused list is reported while it is being typed rather than on the next Run, and the
   * message is the same sentence `evaluate` throws — so the badge and the error cannot drift.
   */
  validate: (ctx) => {
    const parsed = parseIdList(ctx.params.ids)
    if (parsed.error) return [parsed.error]
    // Nothing typed and nothing wired is an *unconfigured* node, not a broken one: it returns an
    // empty table of the right schema, and this line says which of the two it is.
    if (parsed.ids.length === 0 && !ctx.inputs.ids) return ['No IDs yet — type or paste some']
    /*
     * With no Dataset the ids *are* the output, and that output's `neuronId` is an `i64` column —
     * a JS number — so an id wider than `Number.MAX_SAFE_INTEGER` cannot be held exactly and
     * would identify a different neuron downstream. Wired, nothing here rounds: the id crosses
     * the seam as text and the source publishes whatever dtype it uses.
     *
     * A warning rather than a refusal, because the fix is to wire the Dataset that was almost
     * certainly meant, and refusing would block a graph somebody is halfway through building.
     */
    if (!ctx.inputs.dataset) {
      // The dataset check comes first and the scan short-circuits: `validate` runs on every
      // graph mutation, the ids field can hold ten thousand ids, and with a Dataset wired this
      // branch cannot fire at all.
      // `id.length` *is* the digit count — `parseIdList` has stripped leading zeros and
      // refused signs — and any id of 15 digits or fewer is under the ceiling, so the common
      // case never reaches `numericId` at all.
      const tooWide = parsed.ids.find((id) => id.length >= 16 && numericId(id) === undefined)
      if (tooWide !== undefined) {
        return [
          `${tooWide} is too wide to hold in this node's own table — wire a Dataset, or it ` +
            `will be rounded to a different neuron.`,
        ]
      }
    }
    return []
  },

  evaluate: async (ctx) => {
    const wired = ctx.input('ids')
    if (wired !== undefined && !isTableValue(wired)) throw new Error('IDs input is not a table')

    const collected = collectIds({
      typed: ctx.params.ids,
      table: wired,
      column: ctx.column('column'),
    })
    if (collected.error) throw new Error(collected.error)

    const dataset = ctx.input('dataset')
    if (dataset !== undefined && !isDatasetValue(dataset)) {
      throw new Error('Dataset input is not a dataset')
    }

    /*
     * The schema `inferOutputs` promised, resolved the same way. Read before the empty check so
     * that an unconfigured node still advertises the shape it is about to have — which is what
     * lets a column picker downstream be set up before a single id has been typed.
     */
    const schema = dataset
      ? schemasForDataset(ctx.resolveSource(dataset.sourceId), dataset).neurons
      : ID_ONLY_SCHEMA

    /*
     * Empty is empty, never everything — the inversion `IDs from Label` documents, and the
     * reason `FindNeuronsRequest.neuronIds` says so at the seam as well. An unconfigured node
     * firing an unbounded `MATCH (n:Neuron)` at a shared production Neo4j is a hazard, not a
     * default. Answered here without a query at all.
     */
    if (collected.ids.length === 0) {
      ctx.progress(1, 'no ids')
      // `'neurons'` explicitly: `tableFromRows` defaults to `'table'`, and a value whose kind
      // disagrees with the port's declared type is a disagreement nothing type-checks. Every
      // op that branches on `table.kind` — `selectTable` is the one in the tree — would take
      // the wrong branch on a table this node said was neurons.
      return { neurons: tableFromRows(schema, [], 'neurons') }
    }

    // No dataset to ask: the ids *are* the answer.
    if (!dataset) {
      ctx.progress(1)
      return {
        // `Number`, because `ID_ONLY_SCHEMA` declares `neuronId` as `i64` and invariant 3 is
        // that the schema half and the value half agree. Exact for every id this branch can
        // usefully carry; `validate` warns about the ones it cannot.
        neurons: tableFromRows(
          ID_ONLY_SCHEMA,
          collected.ids.map((neuronId) => ({ neuronId: Number(neuronId) })),
          'neurons',
        ),
      }
    }

    ctx.progress(0.2, 'looking up')
    const table = await ctx.resolveSource(dataset.sourceId).findNeurons({
      ...datasetRequest(dataset),
      neuronIds: collected.ids,
      signal: ctx.signal,
    })
    ctx.progress(1)
    return { neurons: table }
  },
})
