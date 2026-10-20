/**
 * Line Chart: numeric columns against one numeric X, a line each — voltage traces against time, a
 * measure along a path, anything where the order along X is the point.
 *
 * **A tap**: the table passes through by identity and every param is presentational, so nothing
 * here can make a result stale. The rules are `nodes/lib/lineChart.ts` (which Y columns) and
 * `ui/viewers/lineSeries.ts` (lines, joining, decimation); the record is `docs/viewers.md`.
 */

import { registerNode } from '../../core/registry'
import { NUMERIC_DTYPES, T } from '../../core/types'
import { isTableValue } from '../../core/values'
import { PALETTE_OPTIONS } from '../lib/encodingParams'
import { tapPorts } from '../lib/tapPorts'

registerNode({
  type: 'out.lineChart',
  label: 'Line Chart',
  category: 'visualisation',
  description:
    'Plot numeric columns against one numeric X as lines: one per Y column, per series value, or both. Voltage traces, time courses, profiles.',
  guide:
    'Draws one line per Y column against a numeric X, or one per value of a Series column for a long table — or both. With no Y picked it draws every numeric column, so a table of traces such as Simulate Model’s needs no setting; Y2 puts columns in other units, such as a current, dashed on a second axis. Long lines keep every spike.',
  cost: 'cheap',
  defaultSize: { width: 560, height: 380 },

  paramGroups: [
    { id: 'axes', label: 'Axes' },
    { id: 'lines', label: 'Lines' },
  ],

  inputs: [{ id: 'in', label: 'Table', type: T.table() }],
  outputs: [{ id: 'out', label: 'Table', type: T.table() }],

  params: [
    // ---- Axes ------------------------------------------------------------
    {
      id: 'x',
      kind: 'column',
      label: 'X',
      from: 'in',
      dtypes: NUMERIC_DTYPES,
      default: '',
      presentational: true,
      group: 'axes',
      help: 'The axis the lines run along, e.g. time `t` on a table of traces.',
    },
    {
      id: 'ys',
      kind: 'columns',
      label: 'Y',
      from: 'in',
      dtypes: NUMERIC_DTYPES,
      default: [],
      optional: true,
      emptyLabel: 'every numeric column',
      presentational: true,
      group: 'axes',
      help: 'The columns drawn as lines. Empty draws every numeric column except X and Series.',
    },
    {
      id: 'y2s',
      kind: 'columns',
      label: 'Y2',
      from: 'in',
      dtypes: NUMERIC_DTYPES,
      default: [],
      optional: true,
      emptyLabel: 'none',
      presentational: true,
      group: 'axes',
      help: 'Columns drawn dashed against a second Y axis on the right, for a quantity in other units, such as an injected current beside voltage traces. With Y empty, these come off the left axis and every other numeric column stays.',
    },
    {
      id: 'xLog',
      kind: 'boolean',
      // Inspector and the expanded card only: a setting changed once, not a control to keep in view.
      advanced: true,
      label: 'Log X',
      default: false,
      presentational: true,
      group: 'axes',
      help: 'A log scale for X. Values at or below zero are dropped; the caption counts them.',
    },
    {
      id: 'yLog',
      kind: 'boolean',
      advanced: true,
      label: 'Log Y',
      default: false,
      presentational: true,
      group: 'axes',
      help: 'A log scale for Y. Values at or below zero are dropped; the caption counts them.',
    },
    {
      id: 'y2Log',
      kind: 'boolean',
      advanced: true,
      label: 'Log Y2',
      default: false,
      presentational: true,
      group: 'axes',
      visibleIf: (p) => Array.isArray(p.y2s) && p.y2s.length > 0,
      help: 'A log scale for the second Y axis. Values at or below zero are dropped; the caption counts them.',
    },

    // ---- Lines -----------------------------------------------------------
    {
      id: 'series',
      kind: 'column',
      label: 'Series',
      from: 'in',
      default: '',
      /*
       * `optional`, or `resolveColumn`'s rule 3 hands an unset required picker the first
       * compatible column and a wide table splits into one line per row value of `t`.
       */
      optional: true,
      presentational: true,
      group: 'lines',
      help: 'For a long table: one line per value of this column, e.g. `site`. With several Y columns as well, one per pair.',
    },
    {
      id: 'order',
      kind: 'enum',
      label: 'Join',
      default: 'x',
      options: [
        { value: 'x', label: 'in X order' },
        { value: 'rows', label: 'in row order' },
      ],
      presentational: true,
      group: 'lines',
      help: '"in X order" sorts each line along X first. "in row order" keeps the rows as they come, for a path that doubles back, such as a phase plot.',
    },
    {
      id: 'palette',
      kind: 'enum',
      label: 'Palette',
      default: 'coda',
      options: [...PALETTE_OPTIONS],
      presentational: true,
      group: 'lines',
      help: 'The colours the lines cycle through; the number is how many before they repeat. Okabe–Ito is colour-blind safe.',
    },
  ],

  inferOutputs: (ctx) => tapPorts(ctx.inputs.in, ['out']),

  /** The table on, whatever is or is not drawn — a viewer never blocks what is downstream. */
  evaluate: (ctx) => {
    const table = ctx.input('in')
    if (!isTableValue(table)) throw new Error('Input is not a table')
    return { out: table }
  },
})
