/**
 * A table's rows as a point cloud: the two halves of `Table to Points`, side by side.
 *
 * Invariant 3's pair — `tablePointsSchema` says what the attribute table will hold and
 * `tablePointsValue` builds it, from the same list of carried columns, with an agreement test
 * beside them. Headless, so the rules below are testable without a card:
 *
 * - **A row whose coordinates are not three numbers is dropped, and counted.** A table is not
 *   geometry: a blank cell, a `null` from a join that missed, a string where a number was
 *   expected — all of them are ordinary in a table and none of them is a position. Dropping is
 *   the only honest answer (there is no coordinate to invent), and the count is what stops it
 *   being silent.
 * - **The carried columns keep their own names and dtypes**, including the id column where one
 *   was carried: `PointsValue.attributes` is an ordinary table and everything downstream reads
 *   it with column pickers. A column picked twice is carried once.
 * - **The coordinate columns themselves are not carried by default.** They are the geometry now,
 *   and a `x`/`y`/`z` column sitting beside the positions is two spellings of one fact that a
 *   later transform would move apart. Pick them under `Carry` to keep them anyway.
 */

import type { CellValue, PointsValue, TableValue } from '../../core/values'
import { distinctStrings } from '../../core/collections'
import { boundsOf, makeTable } from '../../core/values'
import type { TableSchema } from '../../core/types'
import type { VoxelScale } from '../../data/units'
import { scaleRefusal } from '../../data/units'
import { column, columnNames, pickColumns, tableSchema } from '../../core/types'

/** Which columns hold the coordinates, as the card resolved them. */
export interface PointColumns {
  readonly x: string | undefined
  readonly y: string | undefined
  readonly z: string | undefined
}

/**
 * The attribute table's schema: the carried columns, in the order they were picked.
 *
 * Takes the upstream schema so the carried columns keep their own dtypes — a carried `neuronId`
 * stays `str`, which is what keeps invariant 8 true through this node. Columns the upstream does
 * not have are dropped rather than invented, which is `pickColumns`' own rule.
 */
export function tablePointsSchema(
  attributes: TableSchema | undefined,
  carry: readonly string[],
): TableSchema {
  // `distinctStrings`, so a column picked twice is carried once.
  const picked = pickColumns(attributes, distinctStrings(carry))?.columns ?? []
  // Minted only where the carried set has no `row` of its own. Folding one in would promise the
  // minted `i64` for values that came from the table — a dtype that column does not have.
  const minted = picked.some((existing) => existing.name === SOURCE_ROW_COLUMN)
    ? []
    : [column(SOURCE_ROW_COLUMN, 'i64')]
  return tableSchema(...picked, ...minted)
}

/**
 * The row each point came from.
 *
 * Kept because it is useful rather than because anything depends on it: a point whose source row
 * is known can be joined back to the table it came from, and the rows dropped for having no
 * position are the numbers missing from it. A cloud that carries nothing still has a length
 * because `tablePointsValue` tells `makeTable` what it is — this column is not load-bearing for
 * that, which is why a table with a `row` column of its own simply keeps its own.
 */
export const SOURCE_ROW_COLUMN = 'row'

export interface TablePointsResult {
  readonly points: PointsValue
  /** Rows whose coordinates were not three finite numbers, and so could not be a position. */
  readonly dropped: number
}

/**
 * The axes, named once. Three pickers, three emitted arguments, one refusal — all off this list.
 */
export const POINT_AXES = ['x', 'y', 'z'] as const

export type PointAxis = (typeof POINT_AXES)[number]

/**
 * What is wrong with the coordinate pickers, or undefined where nothing is.
 *
 * One function rather than a "which are missing" and a "say so" pair: every caller asked both in
 * the same breath. The card's `validate`, the notebook emitter and the R emitter all have to say
 * it, and three spellings of one refusal is how a fix lands in two of them.
 */
export function axesRefusal(columns: PointColumns): string | undefined {
  const missing = POINT_AXES.filter((axis) => !columns[axis])
  if (missing.length === 0) return undefined
  const named = missing.map((axis) => `\`${axis.toUpperCase()}\``).join(', ')
  return (
    `Name the coordinate column${missing.length === 1 ? '' : 's'} ${named}. ` +
    'A table has no geometry until three of its columns are read as one.'
  )
}

/** The sentence for a scale that is not three positive numbers — `scaleRefusal`'s, for this field. */
export const TABLE_POINTS_SCALE_REFUSAL = scaleRefusal('Nanometres per unit')

/**
 * A cell as a coordinate, or `NaN` where it is not one.
 *
 * **The test is on the cell, not on the number it would become.** `Number(null)` and
 * `Number('')` are both 0, so a rule written over the number puts every blank row at the origin
 * — a cluster of points nobody placed, in a cloud that otherwise looks right. Text is read
 * because a CSV read column by column arrives as text, and a position is no less a position for
 * it.
 */
function coordinate(cell: CellValue | undefined): number {
  if (typeof cell === 'number') return cell
  if (typeof cell === 'string' && cell.trim() !== '') return Number(cell)
  return Number.NaN
}

/**
 * The rows that have a position, as points.
 *
 * `scale` takes the columns' numbers to nanometres, which is the one thing a table cannot say
 * about itself. The card is where it is said.
 */
export function tablePointsValue(
  table: TableValue,
  columns: PointColumns,
  carry: readonly string[],
  scale: VoxelScale | undefined,
): TablePointsResult {
  const schema = tablePointsSchema(table.schema, carry)
  /*
   * Which names were *asked for*, which is how the schema decided whether to mint — so the two
   * halves agree (invariant 3). Asking the table instead ("has it a column of this name?") is a
   * different question with a different answer: a table carrying its own `row` column that
   * nobody picked got those values written into the minted `i64` slot, so the cloud said `row`
   * was the source row and held something else entirely.
   */
  const carried = new Set(distinctStrings(carry))
  const xs = columns.x === undefined ? undefined : table.data[columns.x]
  const ys = columns.y === undefined ? undefined : table.data[columns.y]
  const zs = columns.z === undefined ? undefined : table.data[columns.z]

  // Hoisted: a picked column the table has not got means no row has a position, and walking a
  // million of them to establish that is a walk for an answer already known.
  const rows = xs && ys && zs ? table.length : 0
  // Written at a cursor rather than pushed onto an array and copied: a million rows is three
  // million doubles of scratch before the `Float32Array` it is copied into.
  const buffer = new Float32Array(rows * 3)
  const kept: number[] = []
  const [sx, sy, sz] = scale ?? [1, 1, 1]

  for (let row = 0; row < rows; row++) {
    const x = coordinate(xs![row])
    const y = coordinate(ys![row])
    const z = coordinate(zs![row])
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
    const at = kept.length * 3
    buffer[at] = x * sx
    buffer[at + 1] = y * sy
    buffer[at + 2] = z * sz
    kept.push(row)
  }

  const positions =
    kept.length * 3 === buffer.length ? buffer : buffer.slice(0, kept.length * 3)
  const data: Record<string, CellValue[]> = {}
  const whole = kept.length === table.length
  for (const name of columnNames(schema)) {
    const source = carried.has(name) ? table.data[name] : undefined
    if (!source) {
      // Not asked for, so it is the minted one: the row each point came from.
      data[name] = [...kept]
    } else if (whole) {
      /*
       * **Handed over by reference**, `selectTable`'s licence: columns are immutable by
       * contract, and where no row was dropped a carried column *is* the input's. Copying twenty
       * of them on a million-row table is 160 MB of fresh slots holding what the input holds.
       */
      data[name] = source as CellValue[]
    } else {
      /*
       * `selectRows`' gather — a preallocated array and an indexed loop. Measured at 54 ms
       * against 154 ms for `kept.map(...)` on a million rows and twenty columns, and this is the
       * *ordinary* branch: one blank coordinate anywhere in the table takes it.
       */
      const out: CellValue[] = new Array(kept.length)
      for (let i = 0; i < kept.length; i++) out[i] = source[kept[i]!] ?? null
      data[name] = out
    }
  }

  return {
    dropped: table.length - kept.length,
    points: {
      kind: 'points',
      positions,
      // The length is **stated**: a cloud carrying nothing has no column to derive it from.
      attributes: makeTable(schema, data, 'table', kept.length),
      bounds: boundsOf([positions]),
      // Always nanometres: the scale was applied above, so nothing downstream has to ask.
      units: 'nm',
    },
  }
}
