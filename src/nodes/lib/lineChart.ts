/**
 * The Line Chart's one rule that both the canvas and the notebook exporters need: which columns
 * are drawn when none is picked. Here, headless, rather than beside the viewer's geometry, so the
 * export plan resolves it against the schema it has and writes a literal list — one statement of
 * the rule rather than one per language.
 */

import type { TableSchema } from '../../core/types'
import { NUMERIC_DTYPES } from '../../core/types'

/** The Y columns drawn: the picked ones, or with none picked every numeric column but X and the series. */
export function yColumnsOf(
  schema: TableSchema,
  picked: readonly string[],
  x: string,
  series: string | undefined,
): string[] {
  if (picked.length > 0) return [...picked]
  const numeric = new Set<string>(NUMERIC_DTYPES)
  return schema.columns
    .filter((c) => numeric.has(c.dtype) && c.name !== x && c.name !== series)
    .map((c) => c.name)
}
