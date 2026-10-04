/**
 * An Annotate card's session: what it has written, and what Undo would write back.
 *
 * Outside the component because the card and its full-size overlay are two mounts of one body, and
 * an undo made in one must be the undo offered in the other. Per workflow and node
 * (`scopedKey`), since one file opened twice has the same node ids in both. Never in the document:
 * a write to a backend is not an edit to the graph — it has no ⌘Z, dirties nothing and is not in a
 * share link — so its history lives exactly as long as the tab.
 */

import { useSyncExternalStore } from 'react'

import { channel } from '../../data/channel'

import type { FieldValue, TargetChange } from '../../data/annotations/targets/types'

export interface LogEntry {
  at: Date
  /** The target written to (`AnnotationTarget.key`), as `UndoBatch.target` names it. */
  target: string
  /** Its label, for the CSV: a tab can point at another table by the time the log is saved. */
  label: string
  id: string
  key: string
  field: string
  before: FieldValue
  after: FieldValue
  /** `held`: the cell had moved since it was read, and nothing was written. */
  outcome: 'written' | 'undone' | 'held' | 'failed'
  message?: string
}

/** A batch Undo can write back, and the target (`AnnotationTarget.key`) it was written to. */
export interface UndoBatch {
  target: string
  changes: readonly TargetChange[]
}

export interface AnnotateSession {
  log: readonly LogEntry[]
  /**
   * Batches written, newest last. Each names its target, because the card's settings may point
   * somewhere else by the time Undo is pressed, and a row key means nothing in another table.
   */
  undo: readonly UndoBatch[]
}

const EMPTY: AnnotateSession = { log: [], undo: [] }

const sessions = new Map<string, AnnotateSession>()
const changed = channel()

function update(key: string, next: AnnotateSession): void {
  sessions.set(key, next)
  changed.notify()
}

export function useAnnotateSession(key: string): AnnotateSession {
  return useSyncExternalStore(changed.subscribe, () => sessions.get(key) ?? EMPTY)
}

/** Log what a write did, and — for a batch that landed and was not itself an undo — keep it to undo. */
export function recordWrite(
  key: string,
  entries: readonly LogEntry[],
  undoable?: UndoBatch,
): void {
  const session = sessions.get(key) ?? EMPTY
  update(key, {
    log: [...session.log, ...entries],
    undo: undoable?.changes.length ? [...session.undo, undoable] : session.undo,
  })
}

/** Whether Undo has anything for `target`: a batch written to it, whatever was written since elsewhere. */
export function canUndo(undo: readonly UndoBatch[], target: string): boolean {
  return undo.some((batch) => batch.target === target)
}

/**
 * Take the newest batch written to `target` off the stack. Per target, because a card's tabs share
 * one history and each tab's Undo undoes its own table's last change; and only to that target, the
 * rule the batch's `target` exists for — a row key means nothing in another table.
 */
export function takeUndo(key: string, target: string): UndoBatch | undefined {
  const session = sessions.get(key)
  if (!session) return undefined
  let at = session.undo.length - 1
  while (at >= 0 && session.undo[at]!.target !== target) at--
  if (at < 0) return undefined
  update(key, { ...session, undo: session.undo.filter((_, i) => i !== at) })
  return session.undo[at]
}

/**
 * The cells this session has changed in `target` and not taken back, as `field\u0000field…` per row
 * key: a written edit counts one, an undone one takes it away, so a cell edited twice and undone
 * once is still edited. Text rather than a set so a memoised row compares it by value.
 */
export function editedCells(
  log: readonly LogEntry[],
  target: string,
): ReadonlyMap<string, string> {
  const count = new Map<string, Map<string, number>>()
  for (const entry of log) {
    if (entry.target !== target) continue
    const step = entry.outcome === 'written' ? 1 : entry.outcome === 'undone' ? -1 : 0
    if (step === 0) continue
    const row = count.get(entry.key) ?? new Map<string, number>()
    row.set(entry.field, (row.get(entry.field) ?? 0) + step)
    count.set(entry.key, row)
  }
  const out = new Map<string, string>()
  for (const [key, row] of count) {
    const fields = [...row].filter(([, n]) => n > 0).map(([field]) => field)
    if (fields.length) out.set(key, fields.join('\u0000'))
  }
  return out
}

/** Test seam. */
export function resetAnnotateSessions(): void {
  sessions.clear()
  changed.notify()
}
