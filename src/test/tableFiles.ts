/**
 * What the table-file suites ask a reader for: every column, typed by the automatic rule — what a
 * Link Table publishes by default.
 */

import type { FileSummary } from '../data/files/columns'
import { fileTableSchema, textColumnsFor } from '../data/files/columns'
import type { ReadRowsRequest } from '../data/files/read'

/** A read of a file's columns (those `only` names, where given), with anything in `rest` over it. */
export function readRequest(
  summary: FileSummary,
  rest: Partial<ReadRowsRequest> = {},
  only?: readonly string[],
): ReadRowsRequest {
  const schema = fileTableSchema(summary, textColumnsFor(summary, true, []))
  return {
    fingerprint: summary.fingerprint,
    columns: summary.columns
      .map((column, i) => ({ column, dtype: schema.columns[i]!.dtype }))
      .filter(({ column }) => !only || only.includes(column.name)),
    limit: Infinity,
    ...rest,
  }
}
