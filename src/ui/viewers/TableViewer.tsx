import { useEffect, useMemo, useRef, useState } from 'react'

import { isNumericDType } from '../../core/types'
import type { TableValue } from '../../core/values'
import { selectRows } from '../../core/values'
import type { FilterClause } from '../../nodes/lib/tableFilter'
import {
  clauseFor,
  filterHint,
  filterRowIndices,
  withClause,
} from '../../nodes/lib/tableFilter'
import { sortedRowIndices } from '../../nodes/lib/tableOps'
import { exportBaseName as makeBaseName, tableToCsvParts } from '../export'
import { formatCell } from '../format'
import { FilterIcon } from '../Icons'
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
  /**
   * The node's committed filters, and the way back.
   *
   * Both present or both absent: this component is the viewer for *every* table value in the
   * app, and only `out.table` has a port for the result — so a Filter node's own preview must
   * not grow a control that writes a param it does not have. `ValuePreview` supplies the pair
   * for that one type and nothing else.
   */
  filters?: readonly FilterClause[]
  onFiltersChange?: (clauses: FilterClause[]) => void
  /** Whether the filter row starts open. Forced open below whenever a filter is set. */
  showFilters?: boolean
  onShowFiltersChange?: (show: boolean) => void
}

interface SortState {
  column: string
  descending: boolean
}

const PAGE_SIZES = [25, 50, 100, 500]

/**
 * How long after the last keystroke the filter reaches the graph.
 *
 * Explore's number, for Explore's reason: the drawn table follows every keystroke, and the
 * *param* follows the pause. Committing per keystroke would put a re-run of everything
 * downstream between two letters of a cell type.
 */
const COMMIT_DELAY_MS = 140

/** One shared empty list, so "not filtering" has a stable identity. See `committed`. */
const NO_FILTERS: readonly FilterClause[] = []

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
 *
 * **Filtering is the opposite, and the caption has to carry both.** A filter feeds `out.table`'s
 * `Filtered` port, so it is data rather than a view — which is why one of the two controls in
 * this header says `sorted view only` and the other says `312 of 4,109 rows`. Getting a reader
 * to the wrong conclusion about which is which is the whole risk of putting them side by side.
 *
 * The filter field lives *inside* its `<th>`, under the column name, rather than in a second
 * row. `.data-table th` is `position: sticky; top: 0`, so a second sticky row would need the
 * first one's height as its offset — and that height varies with whether a column declares a
 * unit, which nothing here can measure. One sticky element that grows is not a compromise;
 * it is the only version that cannot drift.
 *
 * **Draft now, commit in a moment.** Typing filters this component's own view immediately and
 * reaches the param `COMMIT_DELAY_MS` after the last keystroke. Explore's split, for Explore's
 * reason: the param is in the provenance key, so a commit per keystroke is a re-run of
 * everything downstream between two letters of a cell type.
 */
export function TableViewer({
  table,
  pageSize = 100,
  compact = false,
  baseName,
  onExpand,
  onError,
  filters,
  onFiltersChange,
  showFilters = false,
  onShowFiltersChange,
}: TableViewerProps) {
  const [page, setPage] = useState(0)
  const [size, setSize] = useState(pageSize)
  const [sort, setSort] = useState<SortState | undefined>(undefined)

  const filterable = !!filters && !!onFiltersChange

  /*
   * The draft is what is drawn; the param is what the graph runs. It follows the param when
   * that changes from anywhere else — an undo, the inspector's clear button — and leads it
   * while somebody is typing. Keyed on the committed value rather than on a dirty flag, so a
   * change arriving from outside cannot be swallowed by a stale draft.
   *
   * A module constant for the absent case rather than `?? []`, because the effect below resets
   * the draft whenever this changes identity — and a fresh `[]` per render would reset it on
   * every store tick, throwing away what somebody was typing. The *present* case's stability is
   * `ValuePreview`'s job and is memoised there.
   */
  const committed = filters ?? NO_FILTERS
  const [draft, setDraft] = useState<readonly FilterClause[]>(committed)
  useEffect(() => setDraft(committed), [committed])

  const commitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(commitTimer.current), [])

  const editFilter = (column: string, expression: string) => {
    const next = withClause(draft, column, expression)
    setDraft(next)
    clearTimeout(commitTimer.current)
    commitTimer.current = setTimeout(() => onFiltersChange?.(next), COMMIT_DELAY_MS)
  }

  // Follow the node's page-size param when it changes, but let the local selector win
  // afterwards; and never leave the user stranded on a page that no longer exists.
  useEffect(() => setSize(pageSize), [pageSize])
  useEffect(() => setPage(0), [table, size, sort])

  /*
   * The rows the filters keep, against the *draft* — so the table follows the keystroke while
   * the port follows the commit. Not run at all with an empty draft: `filterRowIndices` answers
   * `rows: undefined` there anyway, and skipping it keeps the ordinary unfiltered card free of
   * a resolve pass per render.
   */
  const filtered = useMemo(
    () => (filterable && draft.length > 0 ? filterRowIndices(table, draft) : undefined),
    [filterable, table, draft],
  )
  const kept = filtered?.rows

  /*
   * The sort is memoised on the sort alone, deliberately apart from the filter below it.
   * Folding the two into one memo re-ran `sortedRowIndices` on every keystroke in a filter
   * cell — a full comparator sort of the table, which on 165k rows of a string column is
   * hundreds of milliseconds of `localeCompare` per character typed.
   */
  const order = useMemo(() => {
    if (!sort) return undefined
    try {
      return sortedRowIndices(table, sort.column, sort.descending)
    } catch {
      // Column vanished after an upstream change; fall back to natural order.
      return undefined
    }
  }, [table, sort])

  /*
   * Filter, then sort, then page. The sort is applied by *narrowing* the full-table order
   * rather than by sorting the survivors, so `sortedRowIndices` stays the one comparator this
   * viewer and the Sort node share.
   */
  const visible = useMemo(() => {
    if (!order) return kept
    if (!kept) return order
    const keep = new Uint8Array(table.length)
    for (const row of kept) keep[row] = 1
    return order.filter((row) => keep[row] === 1)
  }, [table.length, order, kept])

  const total = visible ? visible.length : table.length
  const pageCount = Math.max(1, Math.ceil(total / size))
  const clampedPage = Math.min(page, pageCount - 1)
  const start = clampedPage * size
  const end = Math.min(total, start + size)

  const rows = useMemo(() => {
    const indices: number[] = []
    for (let i = start; i < end; i++) indices.push(visible ? (visible[i] ?? i) : i)
    return indices
  }, [start, end, visible])

  /*
   * Export follows what is on screen, which is the answer the CSV button has always given:
   * it exported the table it was drawing. Now that the drawing can be a subset, exporting the
   * whole input instead would make the button disagree with the rows above it.
   */
  const exportSource: ExportSource = useMemo(
    () => ({
      csv: () => tableToCsvParts(kept ? selectRows(table, kept) : table),
    }),
    [table, kept],
  )

  /*
   * The message for each column that could not be applied, so the cell can say so where the
   * node's badge cannot — `validate` sees only the committed value, and a half-typed regex is
   * never committed. Reported in place rather than through `onError`, which would put a notice
   * up on every keystroke of `~[`.
   *
   * Indexed by the column `resolveFilters` recorded, never by matching the prose: the messages
   * quote the offending *value* as well, so a table with a column named `abc` would have seen
   * itself marked broken by `Filter on "pre": "abc" is not a number`.
   */
  const problems = useMemo(() => {
    const byColumn = new Map<string, string>()
    for (const problem of filtered?.problems ?? [])
      byColumn.set(problem.column, problem.message)
    return byColumn
  }, [filtered])

  // Forced open whenever anything is set, so a filtered table always shows why it is short.
  const filterRowOpen = filterable && (showFilters || draft.length > 0)

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
      if (!current || current.column !== columnName)
        return { column: columnName, descending: false }
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
                const expression = clauseFor(draft, col.name)
                const problem = problems.get(col.name)
                return (
                  <th
                    key={col.name}
                    aria-sort={
                      active ? (sort!.descending ? 'descending' : 'ascending') : 'none'
                    }
                    data-sorted={active || undefined}
                    data-filtered={expression ? true : undefined}
                  >
                    {/* The name sorts; the field below it does not. Two targets in one cell
                        rather than two rows, because `th` is the sticky element — see the
                        component's note. */}
                    <button
                      type="button"
                      className="data-table__name nodrag"
                      onClick={() => toggleSort(col.name)}
                      title={`${col.name} · ${col.dtype} — click to sort this view`}
                    >
                      {col.name}
                      {col.unit && !compact && <small>{col.unit}</small>}
                      <span className="data-table__sort" aria-hidden="true">
                        {active ? (sort!.descending ? '▾' : '▴') : ''}
                      </span>
                    </button>
                    {filterRowOpen && (
                      <input
                        className="data-table__filter nodrag"
                        type="text"
                        value={expression}
                        placeholder={filterHint(col.dtype)}
                        aria-label={`Filter ${col.name}`}
                        title={
                          problem ??
                          `Filter ${col.name} — ${filterHint(col.dtype)}, ==exact, !=not, ~regex, ! to exclude`
                        }
                        data-invalid={problem ? true : undefined}
                        onChange={(e) => editFilter(col.name, e.target.value)}
                      />
                    )}
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
                      {formatCell(cell, col.name)}
                    </td>
                  )
                })}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={table.schema.columns.length} data-null="true">
                  {/* Said apart, because they send somebody to two different places: an empty
                      input is a question about the graph, and an empty *result* is a question
                      about what was just typed. */}
                  {table.length > 0 ? 'no rows match the filters' : 'no rows'}
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
            {total === 0
              ? '0 rows'
              : `${(start + 1).toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()}`}
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

        {filterable && (
          <button
            type="button"
            className="pager__btn pager__btn--icon nodrag"
            title={filterRowOpen ? 'Hide the filter row' : 'Filter rows by column'}
            aria-label={filterRowOpen ? 'Hide the filter row' : 'Show the filter row'}
            aria-pressed={filterRowOpen}
            // Forced open by a live filter, so the control that would hide it is disabled
            // rather than absent: a button that silently declines is worse than one that says
            // it cannot, and clearing the cells is what closes the row.
            disabled={draft.length > 0}
            onClick={() => onShowFiltersChange?.(!showFilters)}
          >
            <FilterIcon size={11} />
          </button>
        )}

        {/*
         * Two notes about two controls that look alike and are not. The filter changed the
         * data and says so in rows; the sort changed only this view and says so in words.
         */}
        {kept && kept.length < table.length && (
          <span
            className="viewer__note"
            title="The Filtered port carries these rows; the Table port still carries all of them"
          >
            {`${kept.length.toLocaleString()} of ${table.length.toLocaleString()} rows`}
          </span>
        )}

        {sort && !compact && (
          <span
            className="viewer__note"
            title="Downstream nodes still receive the original order"
          >
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
