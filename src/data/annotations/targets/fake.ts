/**
 * An annotation target in memory — what tests write to, so nothing that writes ever needs a server.
 *
 * Built on `checkedWrite` like the real ones, so the stale-value and refusal rules a test exercises
 * here are the ones Clio and SeaTable apply. `edit` changes a record behind the card's back, which
 * is how a test makes a conflict; `sent` is every batch that reached the "backend".
 */

import type {
  AnnotationTarget,
  FieldValue,
  TargetChange,
  TargetField,
  TargetRead,
  TargetRecord,
  TargetWriteResult,
} from './types'
import type { RowUpdates } from './checkedWrite'
import { checkedWrite, readOf } from './checkedWrite'

/** The named fields of a record, null where it holds nothing. */
function pick(values: Readonly<Record<string, FieldValue>>, names: readonly string[]) {
  return Object.fromEntries(names.map((n) => [n, values[n] ?? null]))
}

export class MemoryTarget implements AnnotationTarget {
  readonly key: string
  readonly label: string
  /** Every batch that reached the "backend", as rows. */
  readonly sent: RowUpdates[] = []
  private readonly fieldList: TargetField[]
  private readonly records: TargetRecord[]
  private readonly batch: number
  /** Set to refuse a batch, as a backend would: return the reason, or undefined to accept it. */
  refuse: ((rows: RowUpdates) => string | undefined) | undefined
  /** Clio's way, where `blanks` is set: an id held nowhere is an empty record, keyed by itself. */
  readonly blank?: (id: string, fields: readonly string[]) => TargetRecord

  constructor(
    fields: TargetField[],
    records: TargetRecord[],
    options: { key?: string; label?: string; batch?: number; blanks?: boolean } = {},
  ) {
    if (options.blanks) this.blank = (id, fields) => ({ key: id, id, values: pick({}, fields) })
    this.fieldList = fields
    this.records = records.map((r) => ({ ...r, values: { ...r.values } }))
    this.key = options.key ?? 'memory'
    this.label = options.label ?? 'Memory'
    this.batch = options.batch ?? 1_000
  }

  async fields(): Promise<TargetField[]> {
    return this.fieldList
  }

  async read(ids: readonly string[], fields: readonly string[]): Promise<TargetRead> {
    return readOf(
      ids,
      this.records.map((r) => ({ ...r, values: pick(r.values, fields) })),
    )
  }

  async write(changes: readonly TargetChange[]): Promise<TargetWriteResult> {
    return checkedWrite(changes, this.fieldList, {
      batch: this.batch,
      reread: async (keys, names) =>
        new Map(
          keys.flatMap((key) => {
            const record = this.records.find((r) => r.key === key)
            if (record) return [[key, pick(record.values, names)] as const]
            // Held nowhere: empty where blanks are offered, gone where they are not.
            return this.blank ? [[key, pick({}, names)] as const] : []
          }),
        ),
      send: async (rows) => {
        const reason = this.refuse?.(rows)
        if (reason) throw new Error(reason)
        this.sent.push(rows)
        for (const [key, row] of rows) {
          if (!this.records.some((r) => r.key === key)) this.add([{ key, id: key, values: {} }])
          for (const [field, value] of Object.entries(row)) this.edit(key, field, value)
        }
      },
    })
  }

  /** Add records, for a test that learns its ids only once a graph has run. */
  add(records: readonly TargetRecord[]): void {
    this.records.push(...records.map((r) => ({ ...r, values: { ...r.values } })))
  }

  /** Change a record directly, as somebody else would. */
  edit(key: string, field: string, value: FieldValue): void {
    const record = this.records.find((r) => r.key === key)
    if (record) (record.values as Record<string, FieldValue>)[field] = value
  }

  /** A record's current value, for assertions. */
  value(key: string, field: string): FieldValue | undefined {
    return this.records.find((r) => r.key === key)?.values[field]
  }
}
