/**
 * ZapBench to Neurons: the fish2 neurons matched to a set of ZapBench cells.
 *
 * The other half of the way back from activity to anatomy. `ZapBench Traces` draws cells, a
 * Heatmap selection or a pasted list names some of them, and this looks up the EM neurons carrying
 * those cells' `zapbenchId` — so `Selected Rows → ZapBench to Neurons → Skeletons` wires with
 * nothing to set, the picker defaulting to the `label` column a selection carries.
 *
 * Six decisions.
 *
 * **A row label is read as its members** (`cellIdsOf`), so a quarter-scale row `1+2+3+4` looks up
 * four cells. That is how a selection stays exact without this node knowing the scale that drew it.
 *
 * **No population filter** — `datasetRequest`, not `neuronSetRequest`. A cell id names a body
 * already; `Input IDs`' reason applies: narrowing a named set to Traced deletes rows, and here would
 * report them as *cells with no EM neuron*, which is a false claim about the release.
 *
 * **An integer lookup.** neuPrint stores `zapbenchId` as an integer, and `IN ['5']` against it
 * matches nothing with no error. The Cypher compiler spells the values as numbers because the
 * discovered schema says the column is `i64`; nothing here has to ask for it.
 *
 * **A body id is refused, not searched for.** The likeliest wrong wire is a Heatmap fed by
 * `Neurons to ZapBench Traces`, whose rows are neuron ids: out of range by four orders of magnitude, so the
 * message says that is what they look like and names `Selected to Neurons`.
 *
 * **Rows follow the cells' order.** The source answers in its own; a selection has one.
 *
 * **Unmatched cells are counted, never an error.** 62,178 of the release's 71,721 cells carry a
 * match, so a quarter-scale selection routinely names cells with none. Saying how many is what
 * tells that apart from a lookup that half failed.
 */

import { packNode } from '../../core/registry'
import { T, findColumn } from '../../core/types'
import { getColumn, isTableValue, selectRows, tableFromRows } from '../../core/values'
import type { TableValue } from '../../core/values'
import {
  datasetRequest,
  requireDataset,
  schemasForDataset,
  schemasFromType,
} from '../../nodes/lib/datasetParam'
import { FRONTIER_BATCH } from '../../nodes/lib/influenceOps'
import { LABEL_COLUMN_NAME, concatBatches } from '../../nodes/lib/tableOps'
import {
  CELL_IDS_PARAM,
  ZAPBENCH_ID_COLUMN,
  cellIdsOf,
  cellsOutsideRelease,
  outsideRelease,
  readCellList,
} from './cells'

export const neuronsNode = packNode({
  type: 'zapbench:neurons',
  // Built in until it moved into this pack; files saved before then name it so.
  formerTypes: ['zapbench.neurons'],
  label: 'ZapBench to Neurons',
  category: 'query',
  cardWidth: 300,
  description:
    'The fish2 neurons matched to ZapBench cells — from a Heatmap selection or a list.',
  guide:
    'Looks up the fish2 neurons whose zapbenchId matches a set of ZapBench cells, for Skeletons or Meshes. Wire a Heatmap’s Selected Rows into Cells — a downsampled row’s label is read as every cell it averages — or type cell ids. About one cell in eight has no EM neuron; those are counted, not errors. Wire it to a fish2 Dataset.',
  cost: 'expensive',

  inputs: [
    { id: 'dataset', label: 'Dataset', type: T.dataset() },
    // Optional: a typed list is a complete question on its own, `IDs from Label`'s reason.
    { id: 'cells', label: 'Cells', type: T.table(), required: false },
  ],
  outputs: [{ id: 'neurons', label: 'Neurons', type: T.neurons() }],

  params: [
    {
      id: 'column',
      kind: 'column',
      label: 'Cell column',
      from: 'cells',
      default: LABEL_COLUMN_NAME,
      /*
       * Text for a row label, an integer for a zapbenchId column. `excludeIds` takes `neuronId` out
       * of the list, and `optional` means rule 3 never substitutes a first compatible column for a
       * missing `label`. A neuron id chosen by hand under another name is the range refusal's job.
       */
      dtypes: ['str', 'i64'],
      excludeIds: true,
      optional: true,
      help: 'Which column of the wired table holds the cells: the label column of a Heatmap selection, or a zapbenchId column.',
    },
    { ...CELL_IDS_PARAM, help: `${CELL_IDS_PARAM.help} Combined with the wired column.` },
  ],

  inferOutputs: (ctx) => ({
    neurons: T.neurons(schemasFromType(ctx.inputs.dataset).neurons),
  }),

  // Only the typed half can be checked before a Run; the wired column is a value.
  validate: (ctx) => [...readCellList(ctx.params.ids).issues],

  evaluate: async (ctx) => {
    const dataset = requireDataset(ctx.input('dataset'))
    const source = ctx.resolveSource(dataset.sourceId)
    const schema = schemasForDataset(source, dataset).neurons

    const wired = ctx.input('cells')
    if (wired !== undefined && !isTableValue(wired))
      throw new Error('Cells input is not a table')

    const typed = readCellList(ctx.params.ids)
    if (typed.issues.length > 0) throw new Error(typed.issues.join(' '))
    const ids = [...typed.cells]
    const typedCount = ids.length

    let unparsed = 0
    const columnName = ctx.column('column')
    if (wired && columnName) {
      for (const cell of getColumn(wired, columnName)) {
        const members = cellIdsOf(cell)
        if (members) ids.push(...members)
        else unparsed += 1
      }
    }

    // The typed cells passed `readCellList`'s range check already; only the wired ones remain.
    const outside = outsideRelease(ids.slice(typedCount))
    if (outside.length > 0) throw new Error(cellsOutsideRelease(outside))
    if (unparsed > 0 && ids.length === 0) {
      throw new Error(
        `"${columnName}" holds no ZapBench cell ids. Pick the column that does — a ` +
          `ZapBench Traces selection label, or a zapbenchId.`,
      )
    }

    const cells = [...new Set(ids)]
    // Nothing named is an answer rather than an error; an empty table of the dataset's schema, so
    // pickers downstream populate before anything is selected.
    if (cells.length === 0) {
      ctx.progress(1, 'no cells')
      return { neurons: tableFromRows(schema, [], 'neurons') }
    }
    if (unparsed > 0) {
      ctx.warn(
        `${unparsed.toLocaleString()} rows of "${columnName}" hold something that is not ` +
          `cell ids and are left out.`,
      )
    }

    const tables: TableValue[] = []
    // Batched and serial for Influence's reason: an `IN` list per query, at a shared server.
    for (let at = 0; at < cells.length; at += FRONTIER_BATCH) {
      ctx.progress(at / cells.length, `${cells.length.toLocaleString()} cells`)
      const found = await source.findNeurons({
        ...datasetRequest(dataset),
        labels: {
          field: ZAPBENCH_ID_COLUMN,
          values: cells.slice(at, at + FRONTIER_BATCH).map(String),
        },
        signal: ctx.signal,
      })
      if (!isTableValue(found)) throw new Error('Source returned a non-table result')
      tables.push(found)
    }
    const found = concatBatches(tables)
    if (!findColumn(found.schema, ZAPBENCH_ID_COLUMN)) {
      throw new Error(
        `${dataset.datasetId} publishes no ${ZAPBENCH_ID_COLUMN}, so none of its neurons can ` +
          `be matched to a ZapBench cell. ZapBench is matched to fish2.`,
      )
    }

    const position = new Map(cells.map((id, index) => [id, index]))
    const matched = getColumn(found, ZAPBENCH_ID_COLUMN)
    const ranks = Array.from({ length: found.length }, (_, row) => {
      const [id] = cellIdsOf(matched[row] ?? null) ?? []
      return (id !== undefined ? position.get(id) : undefined) ?? Infinity
    })
    const order = ranks.map((_, row) => row).sort((a, b) => ranks[a]! - ranks[b]! || a - b)
    const hits = new Set(ranks.filter(Number.isFinite)).size

    const missing = cells.length - hits
    if (missing > 0) {
      ctx.warn(
        `${missing.toLocaleString()} of ${cells.length.toLocaleString()} cells have no EM ` +
          `neuron on ${dataset.datasetId}; ${hits.toLocaleString()} do.`,
      )
    }
    ctx.progress(1, `${found.length.toLocaleString()} neurons`)
    return { neurons: selectRows(found, order) }
  },
})
