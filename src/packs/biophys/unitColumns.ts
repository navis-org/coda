/**
 * Columns read by their unit: a voltage or a current picked from a recording's table, and the
 * factor into the solver's units (mV, nA, ms). Fit Model Passive's recording and Simulate Model's
 * current table both read through it, so a column in pA means the same on either card.
 *
 * **A picker lists only the columns in its unit**, so a lone column in mV is what an unset picker
 * means — `resolveColumn`'s rule, reached by filtering rather than guessing. A unit set by hand
 * opens every numeric column, which is what that control is for. And an unset picker with more
 * than one column to mean is asked, never guessed: a Clampex file records the amplifier's current
 * monitor in pA beside the command, and the first column in pA is the monitor.
 */

import type { ColumnSchemaSource, EnumParam, InferContext } from '../../core/node'
import type { TableSchema } from '../../core/types'
import { findColumn, isNumericDType, schemaOf } from '../../core/types'
import { listed } from '../../core/prose'

/**
 * A unit's factor into the solver's (mV, nA, ms); undefined for one this does not know. Spelled as
 * an ABF file and Coda's own tables spell them.
 */
const SCALES = {
  voltage: { mV: 1, V: 1000, µV: 1e-3, uV: 1e-3 },
  current: { nA: 1, pA: 1e-3, fA: 1e-6, µA: 1e3, uA: 1e3, mA: 1e6, A: 1e9 },
  time: { ms: 1, s: 1000, µs: 1e-3, us: 1e-3 },
} as const satisfies Record<string, Record<string, number>>

export type Quantity = keyof typeof SCALES

export function unitScale(quantity: Quantity, unit: string | undefined): number | undefined {
  if (unit === undefined) return undefined
  const scales: Record<string, number> = SCALES[quantity]
  const key = unit.trim()
  // Own keys only: a unit spelled `constructor` is no unit, not Object's constructor.
  return Object.hasOwn(scales, key) ? scales[key] : undefined
}

/** A unit control's choice: `auto` reads the column's own unit. */
export function unitParam(
  id: string,
  label: string,
  quantity: Quantity,
  units: readonly string[],
  extra: Partial<Omit<EnumParam, 'id' | 'kind'>> = {},
): EnumParam {
  return {
    id,
    kind: 'enum',
    label,
    default: 'auto',
    advanced: true,
    options: [
      { value: 'auto', label: 'the column’s own' },
      ...units.map((u) => ({ value: u, label: u })),
    ],
    help: `The ${quantity} column’s unit. Its own, as Load Recording labels it, unless the column has none or a wrong one.`,
    ...extra,
  }
}

/**
 * The factor a picked column's values take into the solver's units, from its own unit or the one
 * set by hand (`choice`, `auto` for its own) — 1 where it has none it can use, which is said in
 * `issues`, naming the fix. A time column with no unit at all is taken as ms, which is what every
 * table here writes; it has no unit control, its unit being the table's to say.
 */
export function columnScale(
  schema: TableSchema,
  quantity: Quantity,
  name: string | undefined,
  choice: unknown,
  issues: string[],
): number {
  const own = name === undefined ? undefined : findColumn(schema, name)?.unit
  if (quantity === 'time' && own === undefined) return 1
  const unit = choice === 'auto' || choice === undefined ? own : String(choice)
  const scale = unitScale(quantity, unit)
  if (name && scale === undefined) {
    const remedy =
      quantity === 'time'
        ? 'give the table its times in ms or s.'
        : 'set its unit under the advanced controls.'
    issues.push(
      unit
        ? `${name} is in ${unit}, which is not a ${quantity} unit: ${remedy}`
        : `${name} has no unit: ${remedy}`,
    )
  }
  return scale ?? 1
}

/**
 * The columns that could be a `quantity`: those in a unit of it, or once the unit is set by hand
 * every numeric one — never one `taken` by another picker (time, sweep), which a unit set by hand
 * does not make a voltage.
 */
export function unitCandidates(
  schema: TableSchema,
  quantity: Quantity,
  unit: unknown,
  taken: readonly unknown[],
): TableSchema {
  return {
    ...schema,
    columns: schema.columns.filter(
      (c) =>
        isNumericDType(c.dtype) &&
        !taken.includes(c.name) &&
        (unit !== 'auto' || unitScale(quantity, c.unit) !== undefined),
    ),
  }
}

/** A picker's options off `port`: `unitCandidates`, the other pickers' stored names taken. */
export function columnsInUnit(
  port: string,
  quantity: Quantity,
  unitId: string,
  takenIds: readonly string[],
): ColumnSchemaSource {
  return (inputs, params) => {
    const schema = schemaOf(inputs[port])
    // The stored names: a schema source sees params, not their resolution.
    return (
      schema &&
      unitCandidates(
        schema,
        quantity,
        params[unitId],
        takenIds.map((id) => params[id]),
      )
    )
  }
}

/**
 * An unset picker with more than one column to mean, said rather than guessed: `ask` is the
 * sentence's start ("Pick the recorded voltage"), `after` anything it adds.
 */
export function unsetAmbiguity(
  ctx: Pick<InferContext, 'column' | 'params'>,
  schema: TableSchema,
  pick: {
    readonly id: string
    readonly quantity: Quantity
    readonly unitId: string
    readonly takenIds: readonly string[]
    readonly ask: string
    readonly after?: string
  },
): string | undefined {
  if (ctx.params[pick.id] !== '') return undefined
  const names = unitCandidates(
    schema,
    pick.quantity,
    ctx.params[pick.unitId],
    pick.takenIds.map((id) => ctx.column(id)),
  ).columns.map((c) => c.name)
  if (names.length < 2) return undefined
  return `${pick.ask}: ${listed(names)} could each be it.${pick.after ? ` ${pick.after}` : ''}`
}
