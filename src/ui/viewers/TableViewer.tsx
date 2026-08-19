import { useEffect, useMemo, useState } from 'react'

import { isNumericDType } from '../../core/types'
import type { TableValue } from '../../core/values'
import { sortedRowIndices } from '../../nodes/lib/tableOps'
import { exportBaseName as makeBaseName, tableToCsvParts } from '../export'
import { formatCell } from '../format'
import type { ExportSource } from './ViewerActions'
import { ViewerActions } from './ViewerActions'

export interface TableViewerProps {
  table: TableValue
  /** Rows per page. The value itself always passes through the graph intact. */
  pageSize?: number
  compact?: boolean
  /** Filename stem for CSV export. */
  baseName?: string
  onExpand?: () => void
  onError?: (message: string) => void
}

interface SortState {
  column: string
  descending: boolean
}

const PAGE_SIZES = [25, 50, 100, 500]

/**
 * Tabular viewer with paging and view-local sorting.
 *
 * Numeric columns are right-aligned with tabular figures so digits line up — the one place
 * `tabular-nums` is correct (columns that must align vertically). Units declared in the
 * schema ride along in the header rather than being repeated in every cell.
 *
 * Sorting here reorders *the view only*; nothing downstream sees it. That distinction is
 * called out in the footer, because a viewer sort looks exactly like a Sort node's effect
 * and silently diverging from the data would be a genuine correctness trap.
 */
export function TableViewer({
  table,
  pageSize = 100,
  compact = false,
  baseName,
  onExpand,
  onError,
}: TableViewerProps) {
  const [page, setPage] = useState(0)
  const [size, setSize] = useState(pageSize)
  const [sort, setSort] = useState<SortState | undefined>(undefined)

  // Follow the node's page-size param when it changes, but let the local selector win
  // afterwards; and never leave the user stranded on a page that no longer exists.
  useEffect(() => setSize(pageSize), [pageSize])
  useEffect(() => setPage(0), [table, size, sort])

  const order = useMemo(() => {
    if (!sort) return undefined
    try {
      return sortedRowIndices(table, sort.column, sort.descending)
    } catch {
      // Column vanished after an upstream change; fall back to natural order.
      return undefined
    }
  }, [table, sort])

  const pageCount = Math.max(1, Math.ceil(table.length / size))
  const clampedPage = Math.min(page, pageCount - 1)
  const start = clampedPage * size
  const end = Math.min(table.length, start + size)

  const rows = useMemo(() => {
    const indices: number[] = []
    for (let i = start; i < end; i++) indices.push(order ? (order[i] ?? i) : i)
    return indices
  }, [start, end, order])

  const exportSource: ExportSource = useMemo(
    () => ({ csv: () => tableToCsvParts(table) }),
    [table],
  )

  if (table.schema.columns.length === 0) {
    return (
      <div className="viewer">
        <div className="viewer__empty">Table has no columns</div>
      </div>
    )
  }

  const toggleSort = (columnName: string) => {
    setSort((current) => {
      // Cycle ascending → descending → unsorted, so there is always a way back to the
      // order the graph actually produced.
      if (!current || current.column !== columnName) return { column: columnName, descending: false }
      if (!current.descending) return { column: columnName, descending: true }
      return undefined
    })
  }

  return (
    <div className="viewer">
      <div className="viewer__scroll nowheel">
        <table className="data-table">
          <thead>
            <tr>
              {table.schema.columns.map((col) => {
                const active = sort?.column === col.name
                return (
                  <th
                    key={col.name}
                    onClick={() => toggleSort(col.name)}
                    aria-sort={active ? (sort!.descending ? 'descending' : 'ascending') : 'none'}
                    title={`${col.name} · ${col.dtype} — click to sort this view`}
                    data-sorted={active || undefined}
                  >
                    {col.name}
                    {col.unit && !compact && <small>{col.unit}</small>}
                    <span className="data-table__sort" aria-hidden="true">
                      {active ? (sort!.descending ? '▾' : '▴') : ''}
                    </span>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((rowIndex) => (
              <tr key={rowIndex}>
                {table.schema.columns.map((col) => {
                  const cell = table.data[col.name]?.[rowIndex] ?? null
                  return (
                    <td
                      key={col.name}
                      data-numeric={isNumericDType(col.dtype) || undefined}
                      data-null={cell === null || undefined}
                      title={cell === null ? 'null' : String(cell)}
                    >
                      {formatCell(cell)}
                    </td>
                  )
                })}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={table.schema.columns.length} data-null="true">
                  no rows
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="viewer__caption">
        <div className="pager">
          <button
            type="button"
            className="pager__btn nodrag"
            title="First page"
            aria-label="First page"
            disabled={clampedPage === 0}
            onClick={() => setPage(0)}
          >
            ⏮
          </button>
          <button
            type="button"
            className="pager__btn nodrag"
            title="Previous page"
            aria-label="Previous page"
            disabled={clampedPage === 0}
            onClick={() => setPage(clampedPage - 1)}
          >
            ‹
          </button>
          <span className="pager__label">
            {table.length === 0
              ? '0 rows'
              : `${(start + 1).toLocaleString()}–${end.toLocaleString()} of ${table.length.toLocaleString()}`}
          </span>
          <button
            type="button"
            className="pager__btn nodrag"
            title="Next page"
            aria-label="Next page"
            disabled={clampedPage >= pageCount - 1}
            onClick={() => setPage(clampedPage + 1)}
          >
            ›
          </button>
          <button
            type="button"
            className="pager__btn nodrag"
            title="Last page"
            aria-label="Last page"
            disabled={clampedPage >= pageCount - 1}
            onClick={() => setPage(pageCount - 1)}
          >
            ⏭
          </button>

          {!compact && (
            <select
              className="pager__size nodrag"
              value={size}
              title="Rows per page"
              aria-label="Rows per page"
              onChange={(e) => setSize(Number(e.target.value))}
            >
              {PAGE_SIZES.map((option) => (
                <option key={option} value={option}>
                  {option} / page
                </option>
              ))}
            </select>
          )}
        </div>

        {sort && !compact && (
          <span className="viewer__note" title="Downstream nodes still receive the original order">
            sorted view only
          </span>
        )}

        <ViewerActions
          baseName={baseName ?? makeBaseName(undefined, 'table')}
          source={exportSource}
          compact={compact}
          onExpand={onExpand}
          onError={onError}
        />
      </div>
    </div>
  )
}
