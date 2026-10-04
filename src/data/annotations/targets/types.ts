/**
 * An annotation *target*: a backend the Annotate card reads a selection's labels from and writes
 * edits back to — Clio, a SeaTable base, a test double.
 *
 * The other half of `../types.ts`' `AnnotationProvider`, and deliberately not the same interface.
 * A provider reads a whole table for a node's `evaluate`, cached by provenance; a target is driven
 * by a card, reads only the rows a selection names, and **writes**, which nothing in a graph's
 * evaluation may ever do (invariant 4: auto-run would push on every edit). So nothing here is
 * reached from a node's `evaluate`, and an edit is not a document edit.
 *
 * ## A record, not a neuron
 *
 * What a target reads is **records** keyed by the backend's own row key, each naming the neuron
 * id it belongs to. One id can have several: FlyWire's `main.info` holds one root id on up to four
 * rows (measured 2026-10-02), and a card that showed one of them as *the* value would be showing
 * an arbitrary row's opinion. So a read answers every record, a change names the record it edits,
 * and whether a fill reaches every row of an id is the card's decision rather than the target's.
 *
 * ## Writes are checked against what was read
 *
 * A change carries the value the card showed (`before`). The target reads the record again just
 * before writing and **holds** any change whose cell has moved since — returned as a conflict with
 * the value now there — so a card open for an hour cannot quietly overwrite somebody's correction
 * made in the meantime. The check costs one narrow read per write: a single SQL query on SeaTable,
 * one `query` on Clio.
 */

/** A cell as a target holds it. A list is a multiple-select. */
export type FieldValue = string | number | boolean | readonly string[] | null

/**
 * How a field is edited.
 *
 * `choice` and `choices` are a fixed vocabulary the backend **enforces** (SeaTable's selects); a
 * `text` field may still carry `suggestions` the backend merely offers (Clio's `options`). A `date`
 * is held as the wall-clock text SeaTable takes on a write — `2022-04-26 22:12` — never the ISO it
 * answers a read with, which it truncates to the day when written back.
 */
export type FieldKind = 'text' | 'number' | 'bool' | 'date' | 'choice' | 'choices'

export interface TargetField {
  name: string
  kind: FieldKind
  /** Why the card may not edit it, in words it can show; absent where it may. */
  readOnly?: string
  /** A `number` field that takes whole numbers only (a Clio `integer`). */
  integer?: boolean
  /** A `date` field that takes a time as well — `YYYY-MM-DD HH:mm` rather than `YYYY-MM-DD`. */
  withTime?: boolean
  /**
   * The allowed values of a `choice`/`choices` field, which a write outside them is refused. A
   * `choices` field with none (a Clio array) takes any list of text.
   */
  options?: readonly string[]
  /** Values a `text` field is usually given — offered, not enforced. */
  suggestions?: readonly string[]
}

export interface TargetRecord {
  /** The backend's own row key: SeaTable's `_id`, Clio's body id. */
  key: string
  /** The neuron id this record belongs to, as text (invariant 8). */
  id: string
  /** Every field asked for; null where the backend holds nothing. */
  values: Readonly<Record<string, FieldValue>>
}

export interface TargetRead {
  /** In id order where the backend allows; several per id where it holds several. */
  records: TargetRecord[]
  /** Ids asked for that no record names. */
  missing: string[]
}

export interface TargetChange {
  key: string
  field: string
  value: FieldValue
  /** What the card showed. A change whose cell no longer holds this is held, not written. */
  before: FieldValue
  /**
   * A change the card did not show — a side effect such as Clio's `instance` — so there is no
   * `before` to hold it against. The write takes whatever the cell holds as its `before` instead,
   * which is what an undo of it then writes back.
   */
  unchecked?: true
}

export interface TargetWriteResult {
  written: TargetChange[]
  /** Held because the cell had moved since it was read; `now` is what is there. */
  conflicts: Array<{ change: TargetChange; now: FieldValue }>
  /** Refused before sending (a value outside a select's options) or by the backend. */
  failed: Array<{ change: TargetChange; message: string }>
}

export interface AnnotationTarget {
  /** What this target is a fact about — backend, location, id column — for keying caches. */
  readonly key: string
  /** For the card's tab: `FlyTable · main / info`, `Clio · CNS`. */
  readonly label: string
  fields(signal?: AbortSignal): Promise<TargetField[]>
  read(
    ids: readonly string[],
    fields: readonly string[],
    signal?: AbortSignal,
  ): Promise<TargetRead>
  write(changes: readonly TargetChange[], signal?: AbortSignal): Promise<TargetWriteResult>
  /**
   * An empty record for an id the backend holds nothing for but would take a write for — a Clio
   * body nobody has annotated — or `undefined` where it would not. Absent where a missing record
   * means the row is not there (SeaTable): such a backend has nothing to offer. Whether to *show*
   * one is the card's decision (a Clio tab's `Unannotated`); `read` itself reports the id missing.
   */
  blank?(id: string, fields: readonly string[]): TargetRecord | undefined
  /**
   * Where the data behind this same target is, where that can change under it — a local file found
   * after a reload, or allowed again. A change reads the fields and records again. Absent where it
   * cannot change (a server is asked every time).
   */
  revision?(): string | undefined
}
