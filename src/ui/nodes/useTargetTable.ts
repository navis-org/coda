/**
 * One Annotate tab's table: its target's fields, the records its neurons have there, the marks on
 * cells being written, and the write itself — everything a tab needs, so a card of several tabs is
 * this hook once per tab.
 *
 * A write goes through the target's `write`, which re-reads each cell first and **holds** it if
 * somebody changed it since the card read it — the cell then shows what is there now, marked, and
 * the next edit writes over it knowingly. A tab's side effects (`withSideEffects`) are added to the
 * batch before it goes. Undo writes the previous values back the same checked way, and only to the
 * target they were written to.
 *
 * Reads are debounced and capped: a selection dragged on a scatter changes on every pointer move,
 * and above `READ_CONFIRM` neurons the tab asks before reading rather than reading what a stray
 * drag selected.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'

import { errorMessage } from '../../core/errors'
import { fieldText } from '../../data/annotations/targets/fieldValues'
import type { SideEffects } from '../../data/annotations/targets/sideEffects'
import { withSideEffects } from '../../data/annotations/targets/sideEffects'
import { readOf } from '../../data/annotations/targets/checkedWrite'
import type {
  AnnotationTarget,
  FieldValue,
  TargetChange,
  TargetField,
  TargetRead,
  TargetRecord,
  TargetWriteResult,
} from '../../data/annotations/targets/types'
import { subscribeUploadLearned } from '../../data/uploads'
import { useSettledFetch } from '../viewers/useSettledFetch'
import { useStable } from '../viewers/useStable'
import {
  canUndo,
  editedCells,
  recordWrite,
  takeUndo,
  useAnnotateSession,
} from './annotateSession'

/** No rows ticked — one Set, so clearing what is already clear is no update. */
const NONE: ReadonlySet<string> = new Set()

/** How long a selection must hold still before it is read. */
const READ_DEBOUNCE_MS = 400
/** Above this many neurons a tab asks before reading. */
const READ_CONFIRM = 2_000

export type Rows =
  | { state: 'idle' }
  | { state: 'ask'; count: number }
  | { state: 'loading' }
  /** `blank`: how many of `records` are empty rows for ids the target held nothing for. */
  | { state: 'ok'; records: TargetRecord[]; missing: string[]; blank: number }
  | { state: 'failed'; message: string }

/** A cell's write in flight, or what it ended in where that is worth saying — `note` is the tooltip. */
export interface CellMark {
  state: 'saving' | 'held' | 'failed'
  note?: string
}

/** How a write left a cell it did not land in. */
type Settled = CellMark & { state: 'held' | 'failed' }

/** Marks by record key, then field: a row's own map, so an untouched row keeps its identity. */
export type Marks = ReadonlyMap<string, ReadonlyMap<string, CellMark>>
type MarkUpdate = readonly [{ key: string; field: string }, CellMark | undefined]

/** `prev` with these marks set or cleared — `prev` itself where nothing changes. */
function withMarks(prev: Marks, updates: readonly MarkUpdate[]): Marks {
  let out: Map<string, ReadonlyMap<string, CellMark>> | undefined
  for (const [{ key, field }, next] of updates) {
    const row = (out ?? prev).get(key)
    if (!next && !row?.has(field)) continue
    const nextRow = new Map(row)
    if (next) nextRow.set(field, next)
    else nextRow.delete(field)
    out ??= new Map(prev)
    if (nextRow.size) out.set(key, nextRow)
    else out.delete(key)
  }
  return out ?? prev
}

/**
 * A read with an empty row for each missing id `blank` offers one for (`AnnotationTarget.blank`),
 * put back through `readOf` — the one statement of "every record, in the order the ids were asked"
 * — so a blank sits where its neuron does in the selection.
 */
function withBlanks(
  read: TargetRead,
  ids: readonly string[],
  target: AnnotationTarget | undefined,
  fields: readonly string[],
): TargetRead & { blank: number } {
  const blanks = read.missing.flatMap((id) => target?.blank?.(id, fields) ?? [])
  if (blanks.length === 0) return { ...read, blank: 0 }
  return { ...readOf(ids, [...read.records, ...blanks]), blank: blanks.length }
}

const failed = (message: string): Settled => ({
  state: 'failed',
  note: `Not written: ${message}`,
})

/** Tick or untick these rows. */
export type OnSelect = (keys: readonly string[], on: boolean) => void
export type OnCommit = (record: TargetRecord, field: TargetField, value: FieldValue) => void
export type OnInvalid = (
  record: TargetRecord,
  field: TargetField,
  message: string | undefined,
) => void

export function useTargetTable({
  target,
  effects,
  ids,
  chosen,
  session,
  locked,
  blanks = false,
}: {
  target: AnnotationTarget | undefined
  effects: SideEffects
  /** The neurons routed to this target, unqualified. */
  ids: readonly string[] | undefined
  /** The fields chosen as columns, by name. */
  chosen: readonly string[]
  /** The card's session key: its log and undo stack, shared by its tabs. */
  session: string
  locked: boolean
  /** Show an id the target holds nothing for as an empty row, where it offers one (`blank`). */
  blanks?: boolean
}) {
  const { undo, log } = useAnnotateSession(session)
  // What this session changed here and has not undone, drawn on the cells.
  const targetKey = target?.key
  const edited = useMemo(
    () => (targetKey ? editedCells(log, targetKey) : new Map<string, string>()),
    [log, targetKey],
  )
  // By value: a settings edit re-parses every tab's spec and re-routes the selection, and a read
  // keyed on those arrays' identity would go to the server again for the same neurons and fields.
  const neurons = useStable(ids)
  const wanted = useStable(chosen)

  // The target's fields, once per target.
  // Where the target's data is (`AnnotationTarget.revision`) — a local file found after a reload,
  // or allowed again — announced on the uploads channel `remembered.ts` reports on. A value, not
  // the channel's revision, so a tab on a server re-renders for none of it. A change reads the
  // fields again, and the records with them, `names` emptying and refilling.
  const reach = useSyncExternalStore(subscribeUploadLearned, () => target?.revision?.())
  const fields = useSettledFetch(target && `${target.key}|${reach ?? ''}`, () =>
    target!.fields(),
  )
  const columns = useMemo(() => {
    if (fields.status !== 'ready') return []
    const byName = new Map(fields.data.map((f) => [f.name, f]))
    return wanted.flatMap((name) => byName.get(name) ?? [])
  }, [fields, wanted])

  // The records, read when the neurons, the target or the fields change.
  const [rows, setRows] = useState<Rows>({ state: 'idle' })
  const [confirmed, setConfirmed] = useState(0)
  const [nonce, setNonce] = useState(0)
  // Rows ticked for a bulk fill, by record key. A read keeps the ticks on rows it brings back, so
  // Refresh or a new column loses none; nothing to show clears them.
  const [selected, setSelected] = useState(NONE)
  const names = useMemo(() => columns.map((c) => c.name), [columns])
  useEffect(() => {
    if (!target || !neurons || neurons.length === 0 || names.length === 0) {
      setRows({ state: 'idle' })
      setSelected(NONE)
      return
    }
    if (neurons.length > READ_CONFIRM && confirmed < neurons.length) {
      setRows({ state: 'ask', count: neurons.length })
      setSelected(NONE)
      return
    }
    const abort = new AbortController()
    const timer = window.setTimeout(() => {
      setRows({ state: 'loading' })
      target.read(neurons, names, abort.signal).then(
        (answer) => {
          const read = withBlanks(answer, neurons, blanks ? target : undefined, names)
          setRows({ state: 'ok', ...read })
          const keys = new Set(read.records.map((r) => r.key))
          setSelected((prev) =>
            [...prev].every((key) => keys.has(key))
              ? prev
              : new Set([...prev].filter((key) => keys.has(key))),
          )
        },
        (error: unknown) => {
          if (!abort.signal.aborted) setRows({ state: 'failed', message: errorMessage(error) })
        },
      )
    }, READ_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      abort.abort()
    }
  }, [target, neurons, names, confirmed, nonce, blanks])

  const [marks, setMarks] = useState<Marks>(new Map())
  const records = useMemo(() => (rows.state === 'ok' ? rows.records : []), [rows])

  /** Write changes and their side effects, then mark, update and log each by what it ended in. */
  const write = async (changes: TargetChange[], undoing: boolean) => {
    if (!target || locked || changes.length === 0) return
    setMarks((prev) =>
      withMarks(
        prev,
        changes.map((c) => [c, { state: 'saving' }]),
      ),
    )
    let result: TargetWriteResult
    try {
      // An undo writes back exactly what it took, side effects already among it.
      const batch = undoing ? changes : await withSideEffects(target, changes, effects)
      result = await target.write(batch)
    } catch (error) {
      const message = errorMessage(error)
      result = {
        written: [],
        conflicts: [],
        failed: changes.map((change) => ({ change, message })),
      }
    }
    // Each change with its mark — none once written — and what its cell now holds where known.
    const settled: Array<{
      change: TargetChange
      mark?: Settled
      now?: FieldValue
      message?: string
    }> = [
      ...result.written.map((change) => ({ change, now: change.value })),
      ...result.conflicts.map(({ change, now }) => ({
        change,
        now,
        mark: {
          state: 'held' as const,
          note: `Changed by somebody else since it was read — now "${fieldText(now)}". Edit again to overwrite.`,
        },
      })),
      ...result.failed.map(({ change, message }) => ({
        change,
        message,
        mark: failed(message),
      })),
    ]
    setMarks((prev) =>
      withMarks(
        prev,
        settled.map((s) => [s.change, s.mark]),
      ),
    )
    const patched = new Map<string, Record<string, FieldValue>>()
    for (const { change, now } of settled) {
      if (now !== undefined) {
        patched.set(change.key, { ...patched.get(change.key), [change.field]: now })
      }
    }
    setRows((prev) =>
      prev.state !== 'ok'
        ? prev
        : {
            ...prev,
            records: prev.records.map((r) => {
              const p = patched.get(r.key)
              return p ? { ...r, values: { ...r.values, ...p } } : r
            }),
          },
    )
    const at = new Date()
    const idOf = new Map(records.map((r) => [r.key, r.id]))
    recordWrite(
      session,
      settled.map(({ change: c, mark, message }) => ({
        at,
        target: target.key,
        label: target.label,
        id: idOf.get(c.key) ?? c.key,
        key: c.key,
        field: c.field,
        before: c.before,
        after: c.value,
        outcome: mark?.state ?? (undoing ? 'undone' : 'written'),
        ...(message ? { message } : {}),
      })),
      undoing ? undefined : { target: target.key, changes: result.written },
    )
  }

  /*
   * The cells' two callbacks, stable for the life of the tab so a memoised row redraws only when
   * its own record or marks change. A commit calls through to whatever this render made; a mark
   * needs nothing but the state setter, which is stable already.
   */
  const writeRef = useRef(write)
  useLayoutEffect(() => {
    writeRef.current = write
  })
  const onCommit = useCallback<OnCommit>((record, field, next) => {
    const before = record.values[field.name] ?? null
    void writeRef.current([{ key: record.key, field: field.name, value: next, before }], false)
  }, [])
  const onInvalid = useCallback<OnInvalid>(
    (record, field, message) =>
      setMarks((prev) =>
        withMarks(prev, [
          [{ key: record.key, field: field.name }, message ? failed(message) : undefined],
        ]),
      ),
    [],
  )

  // Stable, so ticking a row redraws that row and a write's new records redraw none.
  const onSelect = useCallback<OnSelect>(
    (keys, on) =>
      setSelected((prev) => {
        const next = new Set(prev)
        for (const key of keys) {
          if (on) next.add(key)
          else next.delete(key)
        }
        return next
      }),
    [],
  )

  /** Set one field to one value on every row ticked, as an edit (with the tab's side effects). */
  const fill = (field: TargetField, value: FieldValue) =>
    void write(
      records
        .filter((r) => selected.has(r.key))
        .map((r) => ({
          key: r.key,
          field: field.name,
          value,
          before: r.values[field.name] ?? null,
        })),
      false,
    )

  const undoable = target !== undefined && canUndo(undo, target.key)
  const undoLast = () => {
    const batch = target && takeUndo(session, target.key)
    if (batch) {
      void write(
        batch.changes.map((c) => ({
          key: c.key,
          field: c.field,
          value: c.before,
          before: c.value,
        })),
        true,
      )
    }
  }

  return {
    fields,
    columns,
    rows,
    records,
    marks,
    edited,
    selected,
    onSelect,
    fill,
    onCommit,
    onInvalid,
    undoable,
    undoLast,
    refresh: () => setNonce((n) => n + 1),
    /** Read a selection above `READ_CONFIRM` after all. */
    confirm: () => setConfirmed(neurons?.length ?? 0),
  }
}
