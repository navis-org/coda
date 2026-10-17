/**
 * The Line Chart's one rule that both the canvas and the notebook exporters need: which columns
 * are drawn when none is picked. Here, headless, rather than beside the viewer's geometry, so the
 * export plan resolves it against the schema it has and writes a literal list — one statement of
 * the rule rather than one per language.
 */

import type { TableSchema } from '../../core/types'
import { NUMERIC_DTYPES } from '../../core/types'

/**
 * The Y columns drawn: the picked ones, or with none picked every numeric column but X, the series
 * and the second axis's columns — picking a column for Y2 moves it off the left axis, the rest
 * staying, so a table of traces with its stimulus needs only Y2 set.
 */
export function yColumnsOf(
  schema: TableSchema,
  picked: readonly string[],
  x: string,
  series: string | undefined,
  y2: readonly string[] = [],
): string[] {
  if (picked.length > 0) return [...picked]
  const numeric = new Set<string>(NUMERIC_DTYPES)
  const right = new Set(y2)
  return schema.columns
    .filter(
      (c) => numeric.has(c.dtype) && c.name !== x && c.name !== series && !right.has(c.name),
    )
    .map((c) => c.name)
}

/**
 * What a second-axis line's name carries, in the key, the crosshair and both exporters' legends —
 * one spelling, the line being dashed on the canvas and the tag saying so in words.
 */
export const Y2_TAG = ' (right)'
