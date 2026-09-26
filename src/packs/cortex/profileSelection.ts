/**
 * What Laminar Profile stores when a bar or a layer's count is clicked: a depth range, and — on a
 * faceted profile — the panel it was clicked in.
 *
 * A panel's bar is "these depths **within this facet**", so a bare range would select those
 * depths in every panel. **The entry names its facet column as well as its value**, so it is
 * self-describing: `evaluate` reads the facet from the entry and never from the `Facet by` param,
 * which can therefore be presentational — regrouping the panels re-runs nothing, and a selection
 * made under one grouping keeps meaning what it meant. Spelled `lo:hi|column|label`, the range
 * being `chartSelection.ts`' `encodeRange` (no `|` in its grammar) and the column URI-encoded, so
 * only the label — the last part — may hold a `|`.
 *
 * An entry without a facet is every row's at those depths. One naming a column the table no longer
 * has selects nothing, as a label whose column is gone does (`rowsWithLabels`).
 *
 * Headless, so `evaluate` and the viewer read one codec.
 */

import type { TableValue } from '../../core/values'
import { selectRows } from '../../core/values'
import type { ValueRange } from '../../nodes/lib/chartSelection'
import {
  decodeRange,
  encodeRange,
  inRange,
  markLabel,
  numericCell,
} from '../../nodes/lib/chartSelection'

const SEPARATOR = '|'

/** A panel: the facet column and the value, as `markLabel` prints it. */
export interface FacetRef {
  column: string
  label: string
}

/** One stored entry: a depth range, within one facet's panel where `facet` is given. */
export function encodeProfileMark(range: ValueRange, facet?: FacetRef): string {
  const key = encodeRange(range)
  return facet
    ? `${key}${SEPARATOR}${encodeURIComponent(facet.column)}${SEPARATOR}${facet.label}`
    : key
}

interface ProfileMark {
  range: ValueRange
  facet?: FacetRef
}

function decodeProfileMark(text: unknown): ProfileMark | undefined {
  if (typeof text !== 'string') return undefined
  const first = text.indexOf(SEPARATOR)
  const range = decodeRange(first === -1 ? text : text.slice(0, first))
  if (!range) return undefined
  if (first === -1) return { range }
  const second = text.indexOf(SEPARATOR, first + 1)
  // A facet with no column is a spelling this build does not know: skipped, not guessed at.
  if (second === -1) return undefined
  let column: string
  try {
    column = decodeURIComponent(text.slice(first + 1, second))
  } catch {
    // A hand-edited `%` is an unreadable entry like any other: skipped, not thrown in `evaluate`.
    return undefined
  }
  return { range, facet: { column, label: text.slice(second + 1) } }
}

/**
 * The rows a stored selection names: depth in a range, and in its facet where it names one the
 * table has. `rowsInRanges`' rule, a facet test added.
 */
export function rowsInProfileMarks(
  table: TableValue,
  depthColumn: string | undefined,
  selection: unknown,
): TableValue {
  const marks = Array.isArray(selection)
    ? selection.map(decodeProfileMark).filter((m): m is ProfileMark => !!m)
    : []
  const depths = depthColumn ? table.data[depthColumn] : undefined
  const rows: number[] = []
  if (marks.length > 0 && depths) {
    const facetCells = marks.map((mark) => mark.facet && table.data[mark.facet.column])
    for (let row = 0; row < table.length; row++) {
      const depth = numericCell(depths[row])
      if (depth === undefined) continue
      const hit = marks.some(({ range, facet }, m) => {
        if (!inRange(range, depth)) return false
        if (!facet) return true
        // A facet whose column has gone selects nothing — `rowsWithLabels`' rule. Matching every
        // row at those depths instead would widen one panel's bar into the whole population.
        const cells = facetCells[m]
        return !!cells && markLabel(cells[row]) === facet.label
      })
      if (hit) rows.push(row)
    }
  }
  return selectRows(table, rows)
}
