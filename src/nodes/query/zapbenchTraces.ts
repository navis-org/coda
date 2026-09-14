/**
 * ZapBench Traces: the whole population's activity, which a selection of cells is made from.
 *
 * `Neurons to ZapBench Traces` starts from neurons and asks for their traces. This starts from the recording
 * and is the way back: draw every cell, select a band of rows on a Heatmap, and hand the selection
 * to `ZapBench to Neurons`. So its rows are **cells**, not neurons — about 13% of which have no EM
 * neuron at all — and its row labels are cell ids.
 *
 * ## Two ways to name the cells
 *
 * `Every cell` reads the whole population over a window, at a scale. `Cells I list` reads the ids
 * typed, at full resolution, through the selective reader `Neurons to ZapBench Traces` uses. Scale is offered
 * only for the first: a listed cell is cheap at full scale by the transposed route, and at a reduced
 * scale it would come back averaged with neighbours nobody listed.
 *
 * ## What a row is at a reduced scale
 *
 * The mean of 2 or 4 cells adjacent in activity order over 2 or 4 timesteps — measured, and
 * recorded in `data/zapbench/recording.ts`. The label names every member (`40211+40212`), which is
 * `nodes/lib/zapbenchCells.ts`' grammar, so a selection keeps its identity without the next node
 * knowing the scale. Rows are in **activity order** because that is the only order in which 72,000
 * rows of calcium activity look like anything; a listed set keeps the order it was typed in,
 * because somebody chose it — the Heatmap's Order tab re-sorts either.
 *
 * ## The size is a param decision, so it is said before a Run
 *
 * Every cell at full scale over the whole recording is a 4.2 GB matrix and at half scale 1.1 GB,
 * both past `CRASH_FLOOR_BYTES`, the one thing allowed to refuse. So the default is **quarter scale
 * over the whole recording** — about 144 MB read and 269 MB held — and `validate` computes the
 * shape from the params and puts the refusal on the card: nothing about it depends on data, so
 * nothing about it should wait for a Run.
 */

import { crashFloorIssue } from '../../core/limits'
import { registerNode } from '../../core/registry'
import { T } from '../../core/types'
import { makeMatrix } from '../../core/values'
import {
  DEFAULT_SCALE,
  RECORDING_SCALES,
  fetchRecording,
  levelWindow,
  noDownsampledCopy,
  readScale,
  recordingRows,
} from '../../data/zapbench/recording'
import type { RecordingScale } from '../../data/zapbench/recording'
import type { TraceWindow } from '../../data/zapbench/traces'
import {
  TRACE_PRODUCTS,
  WHOLE_RECORDING_ID,
  conditionWindow,
  fetchTraces,
  hasSortedCopy,
  readProduct,
  traceColumnOf,
  windowLength,
} from '../../data/zapbench/traces'
import {
  CELL_IDS_PARAM,
  CONDITION_OPTIONS,
  cellLabel,
  noSuchCondition,
  readCellList,
  recordingCostWarning,
  stepLabels,
  traceCostWarning,
  traceValueLabel,
} from '../lib/zapbenchCells'

const SCALE_OPTIONS = RECORDING_SCALES.map(({ scale, label }) => ({
  value: String(scale),
  label,
}))

/**
 * The refusal for a matrix of every cell no tab can hold, or nothing. Its shape is a function of
 * `Scale` and `Condition` alone, so the card says it and a Run refuses it in the same words.
 */
function wholeShapeIssue(window: TraceWindow, scale: RecordingScale): string | undefined {
  const rows = recordingRows(scale)
  const steps = windowLength(levelWindow(window, scale))
  return crashFloorIssue(
    `A ${rows.toLocaleString()} × ${steps.toLocaleString()} matrix of every cell`,
    rows * steps * 8,
    'Narrow Condition or reduce Scale.',
  )
}

/** The same refusal for a list, whose size is the params' too: the ids typed and the window. */
function listShapeIssue(cells: number, window: TraceWindow): string | undefined {
  const steps = windowLength(window)
  return crashFloorIssue(
    `A ${cells.toLocaleString()} × ${steps.toLocaleString()} matrix of listed cells`,
    cells * steps * 8,
    'List fewer cells or narrow Condition.',
  )
}

registerNode({
  type: 'zapbench.traces',
  label: 'ZapBench Traces',
  category: 'query',
  cardWidth: 300,
  description:
    'Activity for every ZapBench cell, or for cells you list — the overview to select cells from.',
  guide:
    'Reads the ZapBench recording starting from its cells: every cell at a reduced Scale, or listed cell ids at full resolution, as a matrix for the Heatmap. Shift-drag rows on the expanded Heatmap and wire Selected Rows into ZapBench to Neurons. Rows are in activity order, and a row’s label lists the cells it averages. Quarter scale over the whole recording reads about 144 MB.',
  cost: 'expensive',

  inputs: [],
  outputs: [{ id: 'traces', label: 'Matrix', type: T.matrix() }],

  params: [
    {
      id: 'cells',
      kind: 'enum',
      label: 'Cells',
      default: 'all',
      options: [
        { value: 'all', label: 'Every cell' },
        { value: 'list', label: 'Cells I list' },
      ],
      help: 'Every cell reads the whole population, in activity order. Cells I list reads the ids you type, in that order, at full resolution.',
    },
    { ...CELL_IDS_PARAM, visibleIf: (params) => params.cells === 'list' },
    {
      id: 'scale',
      kind: 'enum',
      label: 'Scale',
      default: String(DEFAULT_SCALE),
      options: SCALE_OPTIONS,
      visibleIf: (params) => params.cells !== 'list',
      help: 'Averages neighbouring cells and timesteps into one value, using the release’s own downsampled copies. Each row label lists the cells it averages. Full scale over the whole recording is too large for a browser tab; pick a condition for it.',
    },
    {
      id: 'condition',
      kind: 'enum',
      label: 'Condition',
      default: WHOLE_RECORDING_ID,
      options: CONDITION_OPTIONS,
      help: 'Which stimulus block to read, trimmed one timestep at each end as zapbench’s get_condition_bounds trims it. Beside Scale, the only thing that makes a read smaller.',
    },
    {
      id: 'product',
      kind: 'enum',
      label: 'Values',
      default: 'traces',
      advanced: true,
      options: [...TRACE_PRODUCTS],
      help: 'Which released array to read. Only Activity has downsampled copies.',
    },
  ],

  inferOutputs: () => ({ traces: T.matrix() }),

  validate: (ctx) => {
    const issues: string[] = []
    const condition = String(ctx.params.condition)
    const window = conditionWindow(condition)
    if (!window) issues.push(noSuchCondition(condition))
    if (ctx.params.cells === 'list') {
      const list = readCellList(ctx.params.ids)
      const tooLarge = window ? listShapeIssue(list.cells.length, window) : undefined
      return [...issues, ...list.issues, ...(tooLarge ? [tooLarge] : [])]
    }

    const scale = readScale(ctx.params.scale)
    const product = readProduct(ctx.params.product)
    if (scale !== 1 && !hasSortedCopy(product)) {
      issues.push(noDownsampledCopy(product))
    } else if (window) {
      const tooLarge = wholeShapeIssue(window, scale)
      if (tooLarge) issues.push(tooLarge)
    }
    return issues
  },

  evaluate: async (ctx) => {
    const conditionName = String(ctx.params.condition)
    const window = conditionWindow(conditionName)
    if (!window) throw new Error(noSuchCondition(conditionName))
    const product = readProduct(ctx.params.product)

    if (ctx.params.cells === 'list') {
      const { ids, cells, issues } = readCellList(ctx.params.ids)
      if (issues.length > 0) throw new Error(issues.join(' '))
      if (cells.length < ids.length) {
        ctx.warn(
          `${(ids.length - cells.length).toLocaleString()} repeated cell ids are read once.`,
        )
      }
      const colLabels = stepLabels(window)
      const unit = traceValueLabel(product, conditionName)
      // Nothing listed is an answer rather than an error, `IDs from Label`'s rule: a fresh card is
      // unconfigured, not broken.
      if (cells.length === 0) {
        ctx.progress(1, 'no cells')
        return { traces: makeMatrix([], colLabels, new Float64Array(0), unit) }
      }
      const tooLarge = listShapeIssue(cells.length, window)
      if (tooLarge) throw new Error(tooLarge)
      const result = await fetchTraces({
        product,
        columns: cells.map((id) => traceColumnOf(id)!),
        window,
        signal: ctx.signal,
        onProgress: ctx.progress,
        onCost: (cost) => {
          const warning = traceCostWarning(cells.length, cost)
          if (warning) ctx.warn(warning)
        },
        refresh: ctx.refresh,
      })
      return {
        traces: makeMatrix(
          cells.map((id) => cellLabel([id])),
          colLabels,
          Float64Array.from(result.values),
          unit,
        ),
      }
    }

    const scale = readScale(ctx.params.scale)
    const tooLarge = wholeShapeIssue(window, scale)
    if (tooLarge) throw new Error(tooLarge)

    const result = await fetchRecording({
      product,
      scale,
      window,
      signal: ctx.signal,
      onProgress: ctx.progress,
      onCost: (cost) => {
        const warning = recordingCostWarning(cost)
        if (warning) ctx.warn(warning)
      },
      refresh: ctx.refresh,
    })
    if (result.order === 'cell') {
      ctx.warn(
        'The activity sorting could not be checked against this release, so rows are in ' +
          'cell-id order rather than activity order. Every label is still its own cell.',
      )
    }

    const labels = new Array<string>(result.rows)
    for (let row = 0; row < result.rows; row++) {
      // Slots past the release's last cell are 0 and only ever at the end of the last row, so
      // trimming the tail is the whole of it — no per-row copy and filter.
      let end = (row + 1) * scale
      while (end > row * scale + 1 && result.cells[end - 1] === 0) end -= 1
      labels[row] = cellLabel(result.cells.subarray(row * scale, end))
    }
    return {
      traces: makeMatrix(
        labels,
        result.stepStarts.map(String),
        result.values,
        traceValueLabel(product, conditionName, scale),
      ),
    }
  },
})
