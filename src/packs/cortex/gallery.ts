/**
 * Cortex Gallery: a dataset's cells drawn side by side against cortical depth.
 *
 * Explore Dataset's shape, for cortex: it takes a Dataset, loads the dataset's whole cell index
 * once and filters it in the card, draws each cell's skeleton through the dataset's cortical frame
 * (`frames.ts`) with the layers behind them, and hands on the cells somebody picks.
 *
 * **Node `expensive`, widget live — Explore's split, for Explore's reason.** The filters, the
 * sample and the seed only decide what the *wall* shows, so they are `presentational` and change
 * nothing downstream; only the picked cells (`selection`) reach the outputs, and so the provenance
 * key. Browsing re-runs nothing.
 *
 * The card body is `ui/cortex/GalleryBody.tsx`, registered in `ui/nodes/nodeBodies.ts` — a pack's
 * card body lives in the base, `src/packs/**` being imported by the headless MCP build.
 */

import { ID_COLUMN_NAME } from '../../core/ids'
import type { ParamValues } from '../../core/node'
import { packNode } from '../../core/registry'
import type { CodaType, TableSchema } from '../../core/types'
import { columnNames, datasetRef, T } from '../../core/types'
import type { SkeletonsValue } from '../../core/values'
import { EMPTY_BOUNDS, emptyTable } from '../../core/values'
import {
  datasetRequest,
  requireDataset,
  schemasForDataset,
  schemasFromType,
} from '../../nodes/lib/datasetParam'
import { carriedGeometry, carriedSchema } from '../../nodes/lib/carryParams'
import { idColumn, rowsWithIds } from '../../nodes/lib/tableOps'
import {
  cellsSchema,
  cellsTable,
  PROOFREAD_OPTIONS,
  readColumnWidths,
  WALL_ORDERS,
} from './cells'
import {
  cellTypeAnnotations,
  cellTypeRefs,
  cellTypeSourceParam,
  cellTypesSchema,
} from './cellTypes'
import { frameIssue, frameOf } from './frames'

/**
 * The cells' columns before the frame adds depth and layer: the Dataset's, with the chosen
 * typing tables joined on — what `Group by` and `Second stripe` offer, and what `Selected` carries.
 */
function galleryNeurons(dataset: CodaType | undefined, params: ParamValues): TableSchema {
  // Narrowed rather than defaulted: a picker's schema is asked with the params as stored.
  const choice = typeof params.cellTypes === 'string' ? params.cellTypes : ''
  const identity = datasetRef(dataset)
  return cellTypesSchema(
    schemasFromType(dataset).neurons,
    cellTypeRefs(frameOf(identity), identity ?? {}, choice),
  )
}

export const galleryNode = packNode({
  type: 'cortex:gallery',
  label: 'Cortex Gallery',
  category: 'query',
  // A wall of neurons wants the room on the canvas, not only once somebody opens it full size.
  cardWidth: 640,
  description:
    'Neurons side by side against cortical depth, with the layers behind them and axon and dendrite apart.',
  guide:
    'Browse a cortical dataset as a wall of reconstructions, each drawn at its depth below the pia with the layers behind it and its axon and dendrite in two colours. Filter by type and proofreading, draw a sample of each type, and select cells to pass on — as a table with each soma’s depth and layer, and as skeletons.',
  cost: 'expensive',
  inputs: [{ id: 'dataset', label: 'Dataset', type: T.dataset() }],
  outputs: [
    { id: 'selected', label: 'Selected', type: T.neurons() },
    { id: 'skeletons', label: 'Skeletons', type: T.skeletons() },
  ],
  // The body carries the wall's controls, so the full-size view draws no rail of them above it.
  ownControls: true,
  params: [
    {
      id: 'selection',
      kind: 'ids',
      label: 'Selected',
      noun: 'neurons',
      help: 'Cells selected on the wall. Saved into the workflow.',
      default: [],
    },
    cellTypeSourceParam(
      'The table cell types are read from. The default combines the published typings; the others are single typings, including m-types. None reads only what the Dataset carries, such as a table wired into it. Proofreading is read either way.',
    ),
    {
      // A column rather than the literal `type`, so a dataset naming its typing otherwise — or a
      // reader wanting m-types — groups by it (invariant 5). Presentational: it only regroups the
      // wall. Optional, since a required picker would be substituted by the resolver's rule 3.
      id: 'groupBy',
      kind: 'column',
      label: 'Group by',
      from: 'dataset',
      schemaFrom: (inputs, params) => galleryNeurons(inputs.dataset, params),
      help: 'The column cells are grouped and striped by.',
      default: 'type',
      optional: true,
      presentational: true,
    },
    {
      id: 'mode',
      kind: 'enum',
      label: 'Mode',
      help: 'Line-up runs every group on one after the other; rows gives each group rows of its own; compare sets two groups side by side on one depth scale.',
      options: [
        { value: 'lineup', label: 'Line-up' },
        { value: 'rows', label: 'Rows' },
        { value: 'compare', label: 'Compare' },
      ],
      default: 'lineup',
      presentational: true,
    },
    {
      id: 'compareA',
      kind: 'string',
      label: 'Compare',
      help: 'The group on the left in compare mode. Empty takes the first.',
      default: '',
      presentational: true,
      visibleIf: (params) => params.mode === 'compare',
    },
    {
      id: 'compareB',
      kind: 'string',
      label: 'With',
      help: 'The group on the right in compare mode. Empty takes the second.',
      default: '',
      presentational: true,
      visibleIf: (params) => params.mode === 'compare',
    },
    {
      // A second band over each cell, from any column — m-type, area, layer — beside the group's.
      id: 'stripe',
      kind: 'column',
      label: 'Second stripe',
      from: 'dataset',
      schemaFrom: (inputs, params) => galleryNeurons(inputs.dataset, params),
      help: 'A second coloured band over each cell, from another column. Empty draws one.',
      default: '',
      optional: true,
      // A colour per neuron id is a colour per cell, which a band cannot say anything with.
      excludeIds: true,
      presentational: true,
    },
    {
      id: 'order',
      kind: 'enum',
      label: 'Order',
      help: 'How the groups follow one another. Within a group, shallowest first.',
      options: WALL_ORDERS,
      default: 'depth',
      presentational: true,
      // Compare draws two groups side by side, so there is no sequence of groups to order.
      visibleIf: (params) => params.mode !== 'compare',
    },
    {
      id: 'columnMode',
      kind: 'enum',
      label: 'Column width',
      help: 'Fit gives each cell a column as wide as its own arbour, never clipped, so columns vary. Even gives every cell the same width, the arbour clipped at its edges, so columns line up. The same on the card and full size.',
      options: [
        { value: 'fit', label: 'Fit each neuron' },
        { value: 'even', label: 'Even' },
      ],
      default: 'fit',
      presentational: true,
    },
    {
      // A string, as the heatmap's colour limits are: a number has no "unset", and unset here is
      // "automatic" — the median extent of the cells on the wall, in 50 µm steps.
      id: 'columnUm',
      kind: 'string',
      label: 'Width (µm)',
      placeholder: 'automatic',
      help: 'Every column this wide, in µm, centred on the soma. Empty takes the median extent of the cells on the wall.',
      default: '',
      presentational: true,
      visibleIf: (params) => params.columnMode === 'even',
    },
    {
      id: 'height',
      kind: 'enum',
      label: 'Height',
      help: 'How tall a row is drawn when the card is open full size.',
      options: [
        { value: 'short', label: 'Short' },
        { value: 'medium', label: 'Medium' },
        { value: 'tall', label: 'Tall' },
      ],
      default: 'medium',
      presentational: true,
    },
    {
      id: 'types',
      kind: 'ids',
      label: 'Types',
      noun: 'types',
      help: 'Cell types the wall shows. Empty shows every type.',
      default: [],
      presentational: true,
    },
    {
      id: 'proofread',
      kind: 'enum',
      label: 'Proofread',
      help: 'How much of a cell must have been proofread. The axon and dendrite are told apart automatically, which is only trustworthy where somebody cleaned them.',
      options: PROOFREAD_OPTIONS,
      default: 'both',
      presentational: true,
    },
    {
      id: 'perType',
      kind: 'int',
      label: 'Per type',
      help: 'How many cells of each type the wall draws. 0 draws every one.',
      default: 5,
      min: 0,
      presentational: true,
    },
    {
      id: 'seed',
      kind: 'int',
      label: 'Sample',
      help: 'Which sample of each type is drawn. Shuffle picks another.',
      default: 1,
      presentational: true,
      advanced: true,
    },
  ],
  // The cell index is `loadCachedTable`'s, kept for a month: Clear Cache reads it afresh.
  dataCache: true,

  inferOutputs: (ctx) => {
    const selected = cellsSchema(galleryNeurons(ctx.inputs.dataset, ctx.params))
    return {
      selected: T.neurons(selected),
      skeletons: T.skeletons(
        carriedSchema(
          schemasFromType(ctx.inputs.dataset).morphology,
          selected,
          columnNames(selected),
          ID_COLUMN_NAME,
        ),
      ),
    }
  },

  validate: (ctx) => {
    const issues: string[] = []
    // A width that is not one is ignored rather than refused; said, so the card is not mysterious.
    const { problem } = readColumnWidths(ctx.params)
    if (problem) issues.push(problem)
    const noFrame = frameIssue(datasetRef(ctx.inputs.dataset))
    if (noFrame) issues.push(noFrame)
    return issues
  },

  evaluate: async (ctx) => {
    const dataset = requireDataset(ctx.input('dataset'))
    const source = ctx.resolveSource(dataset.sourceId)
    const frame = frameOf(dataset)
    if (!frame) throw new Error(frameIssue(dataset))
    if (!source.neuronIndex || !source.somaPositions) {
      throw new Error(`${source.label} cannot list this dataset's cells with their somata.`)
    }

    ctx.progress(0.02, 'cell types')
    const annotations = await cellTypeAnnotations(
      dataset.annotations,
      cellTypeRefs(frame, dataset, String(ctx.params.cellTypes)),
      {
        ...(ctx.refresh ? { refresh: true } : {}),
        onFetched: ctx.reportFetched,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      },
    )
    ctx.progress(0.05, 'cells')
    const index = await source.neuronIndex({
      datasetId: dataset.datasetId,
      ...(annotations ? { annotations } : {}),
      refresh: ctx.refresh,
      onProgress: (fraction, note) => ctx.progress(0.05 + fraction * 0.5, note),
      signal: ctx.signal,
    })
    const picked = rowsWithIds(index, ctx.params.selection)
    const ids = idColumn(picked)

    /*
     * The somata and the picked cells' skeletons, together — neither reads the other. The
     * skeletons are already in the geometry cache from the wall, as a rule. None picked is an
     * empty collection rather than no output, so nothing downstream reads "not run".
     */
    ctx.progress(0.6, 'somata and skeletons')
    const [somata, fetched] = await Promise.all([
      source.somaPositions({ ...datasetRequest(dataset), neuronIds: ids, signal: ctx.signal }),
      ids.length > 0 && source.fetchSkeletons
        ? source.fetchSkeletons({
            ...datasetRequest(dataset),
            neuronIds: ids,
            signal: ctx.signal,
          })
        : ({
            kind: 'skeletons',
            items: [],
            attributes: emptyTable(schemasForDataset(source, dataset).morphology),
            bounds: EMPTY_BOUNDS,
          } satisfies SkeletonsValue),
    ])
    const selected = cellsTable(picked, somata, frame)
    /*
     * Each skeleton carries its cell's row — the typing the wall is grouped by, the proofreading
     * flags, the soma's depth and layer — so a 3D View can colour by type or layer with nothing
     * wired between. `Carry fields`' own join, and so its rules: a carried column wins its name
     * and keeps its slot, and the id is never carried.
     */
    const skeletons = carriedGeometry(
      fetched,
      selected,
      columnNames(selected.schema),
      ID_COLUMN_NAME,
    )
    return { selected, skeletons }
  },
})
