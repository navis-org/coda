/**
 * Combine Traces: tables of traces — a recording, a simulation — on one time axis, side by side,
 * so a Line Chart draws them together.
 *
 * Not Join or Combine Columns: those match rows by key or within a row, and two traces sampled at
 * different rates share almost no time. Every input is interpolated onto one grid instead
 * (`traceOps.ts`, which holds the rules), with a shift per input to line a recorded stimulus up
 * with a simulated one. A long input — `Load Recording`'s, with a `sweep` column — is spread into a
 * column per sweep.
 *
 * `cheap`: interpolation over what is already in memory.
 */

import type { InferContext, NumberParam, ParamValues } from '../../core/node'
import { packNode } from '../../core/registry'
import { CELL_BYTES, refuseIfOverCrashFloor } from '../../core/limits'
import type { ColumnSchema, TableSchema } from '../../core/types'
import { NUMERIC_DTYPES, T, columnsOfType } from '../../core/types'
import { isTableValue } from '../../core/values'
import { repeatGroups, repeatParamId, repeatParams } from '../../nodes/lib/repeatParams'
import { formatNumber, plural } from '../../style/format'
import { TIME_COLUMN } from './simulateOps'
import type { TraceGrid, TraceInputSpec } from './traceOps'
import {
  combinedColumns,
  combinedSchema,
  combinedTable,
  planGrid,
  prepareTraces,
} from './traceOps'

const countParam = {
  id: 'inputs',
  kind: 'int',
  label: 'Inputs',
  help: 'How many tables of traces to combine. Each gets its own socket and tab.',
  default: 2,
  min: 2,
  max: 6,
} as const satisfies NumberParam

const PORT = 'in'

function gridOf(p: ParamValues): TraceGrid {
  if (p.grid === 'finest') return { kind: 'finest' }
  if (p.grid === 'step') return { kind: 'step', step: Number(p.gridStep) }
  return { kind: 'first' }
}

/** The inputs this card has, by the arity param. */
function indices(p: ParamValues): number[] {
  return Array.from({ length: Number(p[countParam.id]) }, (_, i) => i + 1)
}

/**
 * Which columns of input `i` are traces: the picked ones, or every numeric column but its time and
 * sweep. Through the context's resolution (invariant 5), so infer and evaluate agree.
 */
function traceColumns(
  ctx: Pick<InferContext, 'column' | 'columns'>,
  schema: TableSchema,
  i: number,
): { time: string | undefined; sweep: string | undefined; columns: ColumnSchema[] } {
  const time = ctx.column(repeatParamId('time', i))
  const sweep = ctx.column(repeatParamId('sweep', i))
  const picked = new Set(ctx.columns(repeatParamId('columns', i)))
  const columns = columnsOfType(schema, NUMERIC_DTYPES).filter((c) =>
    picked.size > 0 ? picked.has(c.name) : c.name !== time && c.name !== sweep,
  )
  return { time, sweep, columns }
}

function labelOf(p: ParamValues, i: number): { label: string; named: boolean } {
  const given = String(p[repeatParamId('label', i)]).trim()
  return { label: given || `${PORT}${i}`, named: given !== '' }
}

export const combineTracesNode = packNode({
  type: 'biophys:combineTraces',
  label: 'Combine Traces',
  category: 'transform',
  description:
    'Put traces from several tables on one time axis, interpolating each onto it, so a recording and a simulation plot together.',
  guide:
    'Lines up tables of traces sampled at different times, such as a recording from Load ' +
    'Recording and the Traces from Simulate Model, by interpolating each onto one time grid. Shift ' +
    'an input to align its stimulus with another’s; a recording’s sweeps become a column each. ' +
    'Outside an input’s own time range its columns are empty rather than extrapolated.',
  cost: 'cheap',
  inputs: [{ repeat: countParam.id, ports: [{ id: PORT, label: 'Traces', type: T.table() }] }],
  outputs: [{ id: 'out', label: 'Traces', type: T.table() }],
  // A spread input's columns are its sweeps, which only the data knows.
  observesOutputSchema: true,
  paramGroups: [
    { id: 'grid', label: 'Grid', affectsData: true },
    ...repeatGroups(countParam, (i) => `Input ${i}`),
  ],
  params: [
    { ...countParam, group: 'grid' },
    {
      id: 'grid',
      kind: 'enum',
      label: 'Grid',
      group: 'grid',
      default: 'first',
      options: [
        { value: 'first', label: 'the first input’s times' },
        { value: 'finest', label: 'the finest input’s step' },
        { value: 'step', label: 'a fixed step' },
      ],
      help: 'The time axis every input is interpolated onto. The first input’s times keep it exact; the finest step loses nothing from the most finely sampled input; a fixed step suits a figure. The last two span every input.',
    },
    {
      id: 'gridStep',
      kind: 'number',
      label: 'Step (ms)',
      group: 'grid',
      default: 0.1,
      min: 0.0001,
      visibleIf: (p) => p.grid === 'step',
    },
    ...repeatParams({
      count: countParam,
      build: (slot) => [
        {
          id: slot.id('time'),
          kind: 'column',
          label: 'Time',
          fromPort: PORT,
          default: TIME_COLUMN,
          dtypes: NUMERIC_DTYPES,
          help: 'The column of times, in ms.',
        },
        {
          id: slot.id('sweep'),
          kind: 'column',
          label: 'Sweep',
          fromPort: PORT,
          default: 'sweep',
          optional: true,
          help: 'For a long table, such as a recording’s: the column naming each row’s sweep. Each sweep becomes a column of its own. None for a table already a column per trace.',
        },
        {
          id: slot.id('columns'),
          kind: 'columns',
          label: 'Columns',
          fromPort: PORT,
          default: [],
          dtypes: NUMERIC_DTYPES,
          optional: true,
          emptyLabel: 'every numeric column',
        },
        {
          id: slot.id('shift'),
          kind: 'number',
          label: 'Shift (ms)',
          default: 0,
          step: 1,
          help: 'Added to this input’s times, to line its stimulus up with another’s: −990 moves a step at 1000 ms to 10 ms.',
        },
        {
          id: slot.id('label'),
          kind: 'string',
          label: 'Name',
          default: '',
          placeholder: `${PORT}${slot.index}`,
          help: 'Put in front of this input’s columns, as `recorded: Vm_prime`. Empty names a column only where two inputs would give the same name.',
        },
      ],
    }),
  ],

  inferOutputs: (ctx) => {
    const specs: TraceInputSpec[] = []
    for (const i of indices(ctx.params)) {
      const schema = ctx.schema(repeatParamId(PORT, i))
      if (!schema) return { out: T.table(ctx.observed) }
      const { sweep, columns } = traceColumns(ctx, schema, i)
      // Spread into sweeps the data names: the last run's schema is the only answer.
      if (sweep) return { out: T.table(ctx.observed) }
      specs.push({ ...labelOf(ctx.params, i), columns })
    }
    return { out: T.table(combinedSchema(specs)) }
  },

  validate: (ctx) => {
    const issues: string[] = []
    for (const i of indices(ctx.params)) {
      const schema = ctx.schema(repeatParamId(PORT, i))
      if (schema && !ctx.column(repeatParamId('time', i))) {
        issues.push(`Input ${i} has no numeric column to use as time.`)
      }
    }
    if (ctx.params.grid === 'step' && !(Number(ctx.params.gridStep) > 0)) {
      issues.push('The grid step must be a positive number of ms.')
    }
    return issues
  },

  evaluate: (ctx) => {
    const prepared = indices(ctx.params).map((i) => {
      const table = ctx.input(repeatParamId(PORT, i))
      if (!isTableValue(table)) throw new Error(`Wire a table of traces into input ${i}.`)
      const { time, sweep, columns } = traceColumns(ctx, table.schema, i)
      if (!time) throw new Error(`Input ${i} has no numeric column to use as time.`)
      return prepareTraces({
        ...labelOf(ctx.params, i),
        table,
        time,
        sweep,
        columns,
        shift: Number(ctx.params[repeatParamId('shift', i)]),
      })
    })
    const grid = planGrid(prepared, gridOf(ctx.params))
    const columns = combinedColumns(prepared.map((p) => p.spec))
    const width = columns.length + 1
    refuseIfOverCrashFloor(
      `${formatNumber(grid.length)} times × ${formatNumber(width)} columns`,
      grid.length * width * CELL_BYTES,
      'Use a coarser grid step, fewer columns, or fewer sweeps.',
    )
    if (grid.length === 0) {
      ctx.warn(
        ctx.params.grid === 'first'
          ? 'Input 1, whose times make the grid, has no time to put on it.'
          : 'No input has a time to put on the grid.',
      )
    }
    prepared.forEach((p, n) => {
      const i = n + 1
      if (p.groups.size === 0) {
        ctx.warn(`Input ${i} has no row with a time, so it adds no columns.`)
      } else if (p.repeated > 0) {
        ctx.warn(
          `Input ${i} has ${plural(p.repeated, 'sample')} at a time its trace already has. ` +
            (p.input.sweep
              ? 'Each sweep should name a time once.'
              : 'It looks like a long table of sweeps: set Sweep to the column naming them, or each trace mixes every sweep.'),
        )
      }
    })
    return { out: combinedTable(prepared, grid.build(), columns) }
  },
})
