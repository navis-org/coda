/**
 * What to call each neuron of a geometry set on an axis.
 *
 * Was `nblastLabels` in `nblastOps.ts` and moved out when `Distance between` became its fourth caller —
 * a set of *meshes* is labelled by exactly the same rule, and nothing in it was ever about
 * NBLAST. The parameter is structural rather than `SkeletonsValue` for that reason: the two
 * things it reads are an item's draw key and the attribute row beside it, which every geometry
 * value carries.
 */

import type { TableValue } from '../../core/values'
import { getColumn } from '../../core/values'

/** Any geometry collection: index-aligned items and attribute rows. */
export interface LabelledItems {
  readonly items: readonly { readonly id: string }[]
  readonly attributes: TableValue
}

/**
 * Neuron ids unless a column was picked, and neuron ids again wherever that column is empty — a
 * neuron with no type is still a neuron, and a blank row label in a heatmap is a row nobody can
 * identify rather than a row with nothing to say.
 */
export function geometryLabels(value: LabelledItems, column: string | undefined): string[] {
  const values = column ? getColumn(value.attributes, column) : undefined
  return value.items.map((item, i) => {
    const cell = values?.[i]
    return cell === null || cell === undefined || cell === '' ? item.id : String(cell)
  })
}

/**
 * The two axis label lists a comparison node's matrix carries.
 *
 * **The far side falls back to neuron ids**, because a column picked on the Query port names a
 * column the Target may not even have, and labelling one set by another set's idea of a name is
 * wrong in a way the heatmap cannot show. An all-by-all is one set against itself, so both axes
 * are the same list — computed once rather than twice.
 *
 * Here rather than in each node: `neuron.nblast` and `neuron.distance` had these three lines and
 * this paragraph each, and `distance.ts`' copy ended with "`neuron.nblast`'s rule", which is the
 * tell.
 */
export function matrixAxisLabels(
  query: LabelledItems,
  target: LabelledItems | undefined,
  column: string | undefined,
): [string[], string[]] {
  const rows = geometryLabels(query, column)
  return target ? [rows, geometryLabels(target, undefined)] : [rows, rows]
}
