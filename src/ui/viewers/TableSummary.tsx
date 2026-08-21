/**
 * A table as text: one line per column, carrying its name, its type and the first row's value.
 *
 * For a surface with no room to draw a table — the inspector, which is 320 × 300, the smallest
 * a viewer is drawn on. A 60-column annotation table there was a horizontally scrolling grid
 * showing about three columns, so reading it meant scrolling sideways through a keyhole; the
 * whole thing is legible here at a glance, turned ninety degrees.
 *
 * **It is a schema readout with an example, not a sample of the data.** One row of sixty columns
 * tells you what the table *is* — which columns arrived, what type each is, what a value looks
 * like — and that is what somebody selecting a node in the middle of a pipeline wants to know.
 * Reading the table itself is the Table node's job, and the full-size overlay's.
 *
 * Deliberately no `<table>`: no intrinsic-width pass over every cell, no sticky header per
 * column, no horizontal scroll container. Ordinary block layout in a narrow column, which is
 * what a narrow column is for.
 */

import type { TableValue } from '../../core/values'
import { formatCell } from '../format'

/**
 * How much of a value is shown.
 *
 * A neuron id is eighteen characters and has to survive whole — a truncated id is not an id, and
 * this is the column somebody is most often checking. Free text runs longer and is cut, with the
 * full value on the element's `title`.
 */
const MAX_VALUE = 28

function preview(table: TableValue, name: string): string {
  if (table.length === 0) return ''
  return formatCell(table.data[name]?.[0] ?? null, name)
}

export interface TableSummaryProps {
  table: TableValue
}

export function TableSummary({ table }: TableSummaryProps) {
  return (
    <div className="table-summary">
      {table.schema.columns.map((col) => {
        const value = preview(table, col.name)
        return (
          <div key={col.name} className="table-summary__row">
            <span className="table-summary__name" title={col.name}>
              {col.name}
            </span>
            <span className="table-summary__type">
              {col.dtype}
              {col.unit ? ` · ${col.unit}` : ''}
            </span>
            <span className="table-summary__value" title={value}>
              {/* Empty rather than a dash for an empty table: there is no first row to be absent
                  from, and a dash would read as a null in one. */}
              {value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE - 1)}…` : value}
            </span>
          </div>
        )
      })}
      {table.schema.columns.length === 0 && <div className="viewer__empty">No columns</div>}
    </div>
  )
}
