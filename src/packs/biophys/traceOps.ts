/**
 * Combine Traces' arithmetic: several tables of traces put on one time axis, side by side.
 *
 * **Linear interpolation onto one grid, never extrapolation.** A recording at 10 kHz and a
 * simulation sampled every 0.1 ms rarely share a sample time, so every input is interpolated onto
 * the grid; a grid time outside an input's own range is empty for that input, since a trace before
 * it began or after it ended is not a measurement. A missing sample is a gap: the two times either
 * side of it interpolate across it only if both have a value.
 *
 * **The grid** is the first input's own times, or the finest input's step, or a step given, the
 * last two spanning every input. **A shift per input** moves its times before anything else, so a
 * recorded step at 1 s lines up with a simulated one at 10 ms.
 *
 * **A long input is spread**: given a sweep column, each sweep becomes a column of its own
 * (`Vm_prime 3`; a lone sweep keeps the bare name). That is what makes the output's columns depend
 * on the data — which sweeps there are — so the node observes its own schema then
 * (`observesOutputSchema`), as Pivot does.
 *
 * Names are decided once, by `combinedColumns`, for the schema and the table alike (invariant 3):
 * a column keeps its own name unless it would clash, and then takes its input's label in front.
 *
 * **Each input is read once** (`prepareTraces`): its rows grouped by sweep and put in time order —
 * no sort at all for a table already in order, which Load Recording's and Simulate's are — and that
 * order serves every column. The grid is then walked beside each trace rather than searched.
 */

import { quantileSorted } from '../../core/stats'
import type { ColumnSchema, TableSchema } from '../../core/types'
import { column, tableSchema, uniqueName } from '../../core/types'
import type { CellValue, TableValue } from '../../core/values'
import { getColumn, makeTable } from '../../core/values'
import { TIME_COLUMN } from './simulateOps'

/** One input as the naming sees it. */
export interface TraceInputSpec {
  /** What its columns are prefixed with on a clash, or always when `named`. */
  readonly label: string
  /** Whether the label was given, so every column carries it. */
  readonly named: boolean
  readonly columns: readonly ColumnSchema[]
  /** The sweeps it is spread into, in order; undefined for a wide input. */
  readonly sweeps?: readonly CellValue[] | undefined
}

/** One output column and where it comes from. */
interface CombinedColumn {
  readonly name: string
  readonly unit?: string | undefined
  readonly input: number
  readonly column: string
  /** The sweep it holds, for a spread input. */
  readonly sweep?: CellValue | undefined
}

/**
 * Every output column, input by input, column by column, sweep by sweep. A column two inputs both
 * have, or one named `t`, takes each such input's label in front: `recorded: Vm_prime`.
 */
export function combinedColumns(inputs: readonly TraceInputSpec[]): CombinedColumn[] {
  const raw = inputs.flatMap((spec, input) =>
    spec.columns.flatMap((c) =>
      (spec.sweeps ?? [undefined]).map((sweep) => ({
        // A lone sweep needs no number: there is nothing to tell it apart from.
        bare:
          sweep === undefined || (spec.sweeps?.length ?? 0) < 2
            ? c.name
            : `${c.name} ${String(sweep)}`,
        unit: c.unit,
        input,
        column: c.name,
        sweep,
      })),
    ),
  )
  // A clash is on the column's own name, before any sweep: a simulated `soma` beside a recorded
  // `soma 1` and `soma 2` is the same measurement, and the name has to say which is which.
  const counts = new Map<string, Set<number>>()
  for (const r of raw) counts.set(r.column, (counts.get(r.column) ?? new Set()).add(r.input))
  const taken = new Set([TIME_COLUMN])
  return raw.map((r) => {
    const spec = inputs[r.input]!
    const clash = (counts.get(r.column)?.size ?? 0) > 1 || r.bare === TIME_COLUMN
    const name = uniqueName(
      taken,
      spec.named || clash ? `${spec.label}: ${r.bare}` : r.bare,
      (n) => ` (${n})`,
    )
    return { name, unit: r.unit, input: r.input, column: r.column, sweep: r.sweep }
  })
}

/** The output's schema, from the columns `combinedColumns` decided. */
function schemaOf(columns: readonly CombinedColumn[]): TableSchema {
  return tableSchema(
    column(TIME_COLUMN, 'f64', 'ms'),
    ...columns.map((c) => column(c.name, 'f64', c.unit)),
  )
}

export function combinedSchema(inputs: readonly TraceInputSpec[]): TableSchema {
  return schemaOf(combinedColumns(inputs))
}

/** How the shared time axis is chosen. */
export type TraceGrid =
  | { readonly kind: 'first' }
  | { readonly kind: 'finest' }
  | { readonly kind: 'step'; readonly step: number }

/** One input as the table needs it: the table, which columns are which, and its shift. */
export interface TraceInput {
  readonly label: string
  readonly named: boolean
  readonly table: TableValue
  readonly time: string
  readonly sweep?: string | undefined
  readonly columns: readonly ColumnSchema[]
  /** Added to every time, ms. */
  readonly shift: number
}

/** One sweep of an input (or the whole of a wide one): its rows in time order, and their times. */
interface Group {
  readonly rows: readonly number[]
  /** Shifted, ascending. */
  readonly t: Float64Array
}

/** An input read once: its spec, and its rows grouped by sweep in time order. */
interface PreparedTraces {
  readonly input: TraceInput
  readonly spec: TraceInputSpec
  readonly groups: ReadonlyMap<CellValue | undefined, Group>
  /**
   * Samples at a time their trace already has. A long table not spread into its sweeps is the
   * usual cause — every sweep's samples in one trace, interpolated across one another into a
   * plausible zig-zag — so the node says it rather than drawing that.
   */
  readonly repeated: number
}

export function prepareTraces(input: TraceInput): PreparedTraces {
  const times = getColumn(input.table, input.time)
  const sweeps = input.sweep ? getColumn(input.table, input.sweep) : undefined
  const rows = new Map<CellValue | undefined, number[]>()
  for (let i = 0; i < input.table.length; i++) {
    const t = times[i]
    if (typeof t !== 'number' || !Number.isFinite(t)) continue
    const key = sweeps ? sweeps[i]! : undefined
    if (sweeps && key === null) continue
    let list = rows.get(key)
    if (!list) rows.set(key, (list = []))
    list.push(i)
  }
  const groups = new Map<CellValue | undefined, Group>()
  let repeated = 0
  for (const [key, list] of rows) {
    const at = (i: number) => times[i] as number
    // One pass for both: in order, and how many times repeat; a list out of order is sorted and
    // its repeats counted then.
    let ordered = true
    let repeats = 0
    for (let k = 1; k < list.length && ordered; k++) {
      ordered = at(list[k]!) >= at(list[k - 1]!)
      if (at(list[k]!) === at(list[k - 1]!)) repeats++
    }
    if (!ordered) {
      list.sort((a, b) => at(a) - at(b))
      repeats = 0
      for (let k = 1; k < list.length; k++) if (at(list[k]!) === at(list[k - 1]!)) repeats++
    }
    repeated += repeats
    groups.set(key, { rows: list, t: Float64Array.from(list, (i) => at(i) + input.shift) })
  }
  return {
    input,
    spec: {
      label: input.label,
      named: input.named,
      columns: input.columns,
      // Distinct sweeps in first-seen order: the recording's own.
      sweeps: sweeps
        ? [...groups.keys()].filter((k): k is CellValue => k !== undefined)
        : undefined,
    },
    groups,
    repeated,
  }
}

/**
 * The shared time axis, planned: its length first, so the crash floor is asked before a fixed step
 * far finer than the data allocates anything, and the times only when they are wanted.
 */
export function planGrid(
  prepared: readonly PreparedTraces[],
  grid: TraceGrid,
): { readonly length: number; build(): Float64Array } {
  if (grid.kind === 'first') {
    const first = prepared[0] ? distinctTimes(prepared[0]) : new Float64Array()
    return { length: first.length, build: () => first }
  }
  // Loops, not `Math.min(...)`: a sweep column with a value per row is one group a row, and that
  // many call arguments overflow the stack before the crash floor can say anything.
  let step = grid.kind === 'step' ? grid.step : Infinity
  if (grid.kind === 'finest') for (const p of prepared) step = Math.min(step, medianStep(p))
  let lo = Infinity
  let hi = -Infinity
  for (const p of prepared) {
    for (const { t } of p.groups.values()) {
      if (t.length === 0) continue
      lo = Math.min(lo, t[0]!)
      hi = Math.max(hi, t[t.length - 1]!)
    }
  }
  if (!(step > 0) || !Number.isFinite(step) || !Number.isFinite(lo) || !Number.isFinite(hi)) {
    return { length: 0, build: () => new Float64Array() }
  }
  const length = Math.floor((hi - lo) / step + 1e-9) + 1
  // Held at `hi`: the tolerance that counts a span a hair short of a whole step as whole would
  // otherwise put the last time an ulp past the input that ends there, and blank its last sample.
  return {
    length,
    build: () => Float64Array.from({ length }, (_, k) => Math.min(lo + k * step, hi)),
  }
}

/** An input's times across its sweeps, once each, ascending. */
function distinctTimes(prepared: PreparedTraces): Float64Array {
  const set = new Set<number>()
  for (const g of prepared.groups.values()) for (const t of g.t) set.add(t)
  return Float64Array.from(set).sort()
}

/** An input's typical sample spacing: the median of the positive gaps within its sweeps. */
function medianStep(prepared: PreparedTraces): number {
  const gaps: number[] = []
  for (const { t } of prepared.groups.values()) {
    for (let i = 1; i < t.length; i++) if (t[i]! > t[i - 1]!) gaps.push(t[i]! - t[i - 1]!)
  }
  if (gaps.length === 0) return Infinity
  return quantileSorted(
    gaps.sort((a, b) => a - b),
    0.5,
  )
}

/**
 * A trace read at every time of an ascending grid, by walking the two together: linear between
 * neighbours, exact on a sample, null outside the trace or beside a gap (NaN in `y`).
 */
export function resample(
  t: Float64Array,
  y: Float64Array,
  grid: Float64Array,
): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(grid.length).fill(null)
  const last = t.length - 1
  if (last < 0) return out
  let k = 0
  for (let g = 0; g < grid.length; g++) {
    const x = grid[g]!
    if (x < t[0]! || x > t[last]!) continue
    while (k < last && t[k + 1]! <= x) k++
    if (t[k] === x || k === last) {
      out[g] = Number.isNaN(y[k]!) ? null : y[k]!
      continue
    }
    const a = y[k]!
    const b = y[k + 1]!
    if (Number.isNaN(a) || Number.isNaN(b)) continue
    const span = t[k + 1]! - t[k]!
    out[g] = span > 0 ? a + ((b - a) * (x - t[k]!)) / span : a
  }
  return out
}

export function combinedTable(
  prepared: readonly PreparedTraces[],
  grid: Float64Array,
  columns: readonly CombinedColumn[] = combinedColumns(prepared.map((p) => p.spec)),
): TableValue {
  const data: Record<string, CellValue[]> = { [TIME_COLUMN]: Array.from(grid) }
  for (const c of columns) {
    const { input, groups } = prepared[c.input]!
    const group = groups.get(c.sweep)
    if (!group) {
      data[c.name] = new Array<CellValue>(grid.length).fill(null)
      continue
    }
    const values = getColumn(input.table, c.column)
    const y = Float64Array.from(group.rows, (i) => {
      const v = values[i]
      return typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN
    })
    data[c.name] = resample(group.t, y, grid)
  }
  return makeTable(schemaOf(columns), data)
}
