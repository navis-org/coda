/**
 * Laminar Profile: a depth column drawn down the cortex, against the layers.
 *
 * A Histogram of depth, turned to run the way the cortex does, with the dataset's layers behind
 * the bars and a count per layer beside them. Fed by Cortical Depth, it is a synapse input or
 * output profile — split by `partnerType`, which layers each partner type's synapses land in; fed
 * by the gallery's `Selected` (`soma_depth`), it is where a set of cells sits.
 *
 * **A Histogram could not do it**, and not for want of a flag: a histogram's value axis is its x
 * axis (`HistogramViewer`'s header argues why), and a laminar profile is read top to bottom
 * because that is where the pia is. Nor does a histogram know where the layers are — the frame is
 * a fact about the *dataset*, which a table does not carry, hence the second port. Unwired, the
 * profile draws with no layers and says so.
 *
 * **The depth column is in the key and the rest is not** — the Histogram's split, for its reason:
 * a stored selection holds depth ranges (`chartSelection.ts`), so what the column is decides which
 * rows `Selected` catches, while bin width, scale and split only redraw.
 *
 * The card is `ui/cortex/LaminarProfileViewer.tsx`, dispatched from `ValuePreview`'s table — a
 * pack's drawing lives in the base, `src/packs/**` being imported by the headless MCP build.
 */

import { packNode } from '../../core/registry'
import { NUMERIC_DTYPES, T, datasetRef } from '../../core/types'
import { isTableValue } from '../../core/values'
import { tapPorts } from '../../nodes/lib/tapPorts'
import { frameIssue } from './frames'
import { rowsInProfileMarks } from './profileSelection'
import { PARTNER_TYPE_COLUMN, POINT_DEPTH_COLUMN } from './pointDepth'

export const laminarProfileNode = packNode({
  type: 'cortex:laminarProfile',
  label: 'Laminar Profile',
  category: 'visualisation',
  description:
    'A depth column drawn down the cortex against the layers, split by a column, with a count per layer.',
  guide:
    'Bins a depth column and draws it running down the cortex, with the dataset’s layers behind it and a count per layer beside them. Split by partner type on a Cortical Depth synapse table, it is the laminar input or output profile. Click a bar or a layer’s count to send those rows on as Selected.',
  cost: 'cheap',
  defaultSize: { width: 460, height: 520 },
  inputs: [
    { id: 'in', label: 'Table', type: T.table() },
    // Only for the frame's layers: identity, read off the type. Optional — the bars need none.
    { id: 'dataset', label: 'Dataset', type: T.dataset(), required: false },
  ],
  outputs: [
    { id: 'out', label: 'Table', type: T.table() },
    { id: 'selected', label: 'Selected', type: T.table() },
  ],
  params: [
    {
      id: 'depth',
      kind: 'column',
      label: 'Depth',
      from: 'in',
      dtypes: NUMERIC_DTYPES,
      default: POINT_DEPTH_COLUMN,
      // Not presentational: it decides which rows a selected range catches.
      help: 'The depth column, in µm below the pia. Also what a selected bar means, so changing it re-runs anything downstream of Selected.',
    },
    {
      id: 'series',
      kind: 'column',
      label: 'Split by',
      from: 'in',
      default: PARTNER_TYPE_COLUMN,
      // Empty is a decision on an optional picker, and a table without `partnerType` draws one
      // series rather than being handed some other column (rule 3).
      optional: true,
      excludeIds: true,
      presentational: true,
      help: 'A column splitting each bar into stacked series — partner type on a synapse cloud. Empty draws one series.',
    },
    {
      // Presentational: a click in a panel stores the facet column in the selection itself
      // (`profileSelection.ts`), so what `Selected` carries does not read this. No `excludeIds` —
      // one panel per neuron is the principal use.
      id: 'facet',
      kind: 'column',
      label: 'Facet by',
      from: 'in',
      default: '',
      optional: true,
      presentational: true,
      help: 'A column giving each of its values a panel of its own — `type`, or `neuronId` for one panel per neuron — on one depth axis and one scale, the largest first.',
    },
    {
      id: 'facetMax',
      kind: 'int',
      label: 'Panels',
      default: 12,
      min: 1,
      max: 48,
      presentational: true,
      visibleIf: (params) => typeof params.facet === 'string' && params.facet !== '',
      help: 'The most panels drawn, largest first. The caption says how many more there were.',
    },
    {
      id: 'binUm',
      kind: 'int',
      label: 'Bin (µm)',
      default: 20,
      min: 5,
      max: 200,
      presentational: true,
      help: 'How deep each bar is. Bars start at multiples of it below the pia.',
    },
    {
      id: 'normalize',
      kind: 'enum',
      label: 'Scale',
      default: 'count',
      options: [
        { value: 'count', label: 'row count' },
        { value: 'percent', label: 'percent of rows' },
      ],
      presentational: true,
      help: 'Percent makes two profiles of different sizes comparable.',
    },
    {
      id: 'selection',
      kind: 'ids',
      label: 'Selected',
      // Ranges rather than bins: a layer's count selects one too.
      noun: 'ranges',
      default: [],
      help: 'Set by clicking bars or a layer’s count. Holds the depth ranges they covered, so a selection survives a change of bin width. Feeds Selected.',
    },
  ],

  inferOutputs: (ctx) => tapPorts(ctx.inputs.in, ['out', 'selected']),

  validate: (ctx) => {
    const issues: string[] = []
    const noFrame = frameIssue(datasetRef(ctx.inputs.dataset))
    if (noFrame) issues.push(noFrame)
    const series = ctx.column('series')
    const depth = ctx.column('depth')
    if (series && series === depth) issues.push('Split-by and Depth are the same column')
    if (depth && ctx.column('facet') === depth)
      issues.push('Facet-by and Depth are the same column')
    return issues
  },

  // Passes the table on whatever is drawable — invariant 5's corollary, the Histogram's rule.
  evaluate: (ctx) => {
    const table = ctx.input('in')
    if (!isTableValue(table)) throw new Error('Input is not a table')
    return {
      out: table,
      selected: rowsInProfileMarks(table, ctx.column('depth'), ctx.params.selection),
    }
  },
})
