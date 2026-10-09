/**
 * The write every target makes, in one place: refuse what does not fit, read the records again,
 * hold what has moved, send the rest a batch of rows at a time.
 *
 * A target supplies only the two halves that are its own — how to read records by key, and how to
 * send a batch of rows — so the stale-value rule, the refusal rule and the merging of one row's
 * changes into one update cannot come to differ between Clio and SeaTable. `readOf`, the read's
 * counterpart, is here for the same reason. What a field holds is `fieldValues.ts`.
 */

import { errorMessage } from '../../../core/errors'
import { refusal, sameValue } from './fieldValues'
import type {
  FieldValue,
  TargetChange,
  TargetField,
  TargetRead,
  TargetRecord,
  TargetWriteResult,
} from './types'

/** One row's changes, merged: what a backend takes as one update. */
export type RowUpdates = ReadonlyMap<string, Readonly<Record<string, FieldValue>>>

interface WriteHalves {
  /** The records' current values for the named fields, by key; a key absent is a row gone. */
  reread(
    keys: readonly string[],
    fields: readonly string[],
    signal?: AbortSignal,
  ): Promise<Map<string, Readonly<Record<string, FieldValue>>>>
  /**
   * Send rows that passed both checks, at most `batch` of them per call, each with all its
   * changes: two updates to one row in one request keep only the last (seaserpent's `BundleEdits`
   * found that), and a row split across two requests could half-land.
   */
  send(rows: RowUpdates, signal?: AbortSignal): Promise<void>
  /** Rows per request: 1,000 on SeaTable, 50 bodies on Clio (clio-py's `chunksize`). */
  batch: number
}

/**
 * A read's answer from the records a backend returned, in any order: every record of each id, in
 * the order the ids were asked, and the ids nothing answered. One statement for every target, so
 * "every record, never one of them" cannot come to differ between them.
 */
export function readOf(ids: readonly string[], records: Iterable<TargetRecord>): TargetRead {
  const byId = new Map<string, TargetRecord[]>()
  for (const record of records) {
    const list = byId.get(record.id)
    if (list) list.push(record)
    else byId.set(record.id, [record])
  }
  const unique = [...new Set(ids)]
  return {
    records: unique.flatMap((id) => byId.get(id) ?? []),
    missing: unique.filter((id) => !byId.has(id)),
  }
}

export async function checkedWrite(
  changes: readonly TargetChange[],
  fields: readonly TargetField[],
  halves: WriteHalves,
  signal?: AbortSignal,
): Promise<TargetWriteResult> {
  const result: TargetWriteResult = { written: [], conflicts: [], failed: [] }
  const byName = new Map(fields.map((f) => [f.name, f]))
  const fit: TargetChange[] = []
  for (const change of changes) {
    const reason = refusal(byName.get(change.field), change.value)
    if (reason) result.failed.push({ change, message: reason })
    else fit.push(change)
  }
  if (fit.length === 0) return result

  const keys = [...new Set(fit.map((c) => c.key))]
  const names = [...new Set(fit.map((c) => c.field))]
  const current = await halves.reread(keys, names, signal)
  // Grouped by row as they pass, so a row's changes travel together.
  const byRow = new Map<string, TargetChange[]>()
  for (const change of fit) {
    const record = current.get(change.key)
    if (!record) {
      result.failed.push({ change, message: 'the record is no longer there' })
      continue
    }
    const now = record[change.field] ?? null
    // An unchecked change is held against nothing: what is there is its `before`, for an undo.
    const effective = change.unchecked ? { ...change, before: now } : change
    if (!sameValue(now, effective.before)) result.conflicts.push({ change, now })
    // Already what was asked for: nothing to send, and nothing for the backend to stamp as an
    // edit by this user.
    else if (sameValue(now, effective.value)) result.written.push(effective)
    else {
      const list = byRow.get(change.key)
      if (list) list.push(effective)
      else byRow.set(change.key, [effective])
    }
  }

  const rows = [...byRow]
  for (let at = 0; at < rows.length; at += halves.batch) {
    const chunk = rows.slice(at, at + halves.batch)
    const sent = chunk.flatMap(([, list]) => list)
    try {
      await halves.send(
        new Map(
          chunk.map(([key, list]) => [
            key,
            Object.fromEntries(list.map((c) => [c.field, c.value])),
          ]),
        ),
        signal,
      )
      result.written.push(...sent)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      const message = errorMessage(error)
      for (const change of sent) result.failed.push({ change, message })
    }
  }
  return result
}
