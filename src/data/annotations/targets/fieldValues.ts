/**
 * What a field holds, how it is spelled as text, and how text becomes a value again — the rules
 * every target and the Annotate card share.
 *
 * Three halves of one contract, kept together because they must round-trip: the card draws a cell
 * as `fieldText`, reads an edit back with `valueFromText`, and the write judges the value with
 * `refusal`. A pair that disagrees writes something nobody typed — a list joined with `, ` and
 * split on `,` turns one entry holding a comma into two, which is why such a cell is not edited as
 * text at all (`textEditable`).
 */

import { listEntries } from '../../../core/node'
import type { FieldValue, TargetField } from './types'

/**
 * Whether two cells hold the same thing, for the stale-value check.
 *
 * An empty string and an absent cell are one thing: SeaTable answers a cleared text cell either
 * way depending on how it was cleared, and treating them as different would hold every write to a
 * cell somebody once emptied. A multiple-select compares as a set, its order being the backend's.
 */
export function sameValue(a: FieldValue | undefined, b: FieldValue | undefined): boolean {
  const empty = (v: FieldValue | undefined) =>
    v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)
  if (empty(a) || empty(b)) return empty(a) && empty(b)
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    const set = new Set(a.map(String))
    return b.every((v) => set.has(String(v)))
  }
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b)
  return a === b
}

/** `YYYY-MM-DD`, optionally with ` HH:mm`: what a SeaTable date column takes. */
const DATE = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/

/** The shape a date field takes, for a refusal and for the card's placeholder alike. */
export function dateShape(withTime: boolean | undefined): string {
  return withTime ? 'YYYY-MM-DD HH:mm' : 'YYYY-MM-DD'
}

/**
 * A date as SeaTable's SQL returns it — `2022-04-26T22:12:00+01:00` — as the wall-clock text a
 * write takes: `2022-04-26 22:12`, or the day alone for a field with no time. Not the ISO: written
 * back, that keeps the day and drops the time (measured on a scratch table), so an undo would
 * truncate it. The offset is the server's own and is dropped, not applied.
 */
export function wallClock(value: string, withTime: boolean): string {
  const day = value.slice(0, 10)
  const clock = /^\d{4}-\d{2}-\d{2}[T ](\d{2}:\d{2})/.exec(value)?.[1]
  return withTime && clock ? `${day} ${clock}` : day
}

/**
 * Whether text is a real date in the shape a date field takes. A real one, not just the shape:
 * SeaTable answers `2024-13-45` with `200 success` and stores an empty cell (measured on a
 * scratch table), so a typo that passed the shape would erase the value it meant to correct.
 */
export function dateRefusal(text: string, withTime: boolean | undefined): string | undefined {
  const match = DATE.exec(text)
  const shape = dateShape(withTime)
  if (!match || (!withTime && match[4] !== undefined)) return `not a date like ${shape}`
  const [, y, m, d, hh, mm] = match.map(Number)
  const day = new Date(Date.UTC(y!, m! - 1, d!))
  const real =
    day.getUTCFullYear() === y && day.getUTCMonth() === m! - 1 && day.getUTCDate() === d
  if (!real) return `${text.slice(0, 10)} is not a day in the calendar`
  if (match[4] !== undefined && (hh! > 23 || mm! > 59)) return 'not a time like HH:mm'
  return undefined
}

/** A value refused before it is sent, or undefined if it fits the field. */
export function refusal(field: TargetField | undefined, value: FieldValue): string | undefined {
  if (!field) return 'no such field'
  if (field.readOnly) return field.readOnly
  if (value === null) return undefined
  switch (field.kind) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'not a number'
      return field.integer && !Number.isInteger(value) ? 'not a whole number' : undefined
    case 'bool':
      return typeof value === 'boolean' ? undefined : 'not true or false'
    case 'date':
      return typeof value === 'string' ? dateRefusal(value, field.withTime) : 'not a date'
    case 'choice':
      return typeof value === 'string' && field.options?.includes(value)
        ? undefined
        : `"${String(value)}" is not one of ${field.name}'s options`
    case 'choices': {
      if (!Array.isArray(value)) return 'not a list'
      if (!field.options)
        return value.every((v) => typeof v === 'string') ? undefined : 'not a list of text'
      const outside = value.filter((v) => !field.options!.includes(String(v)))
      return outside.length === 0
        ? undefined
        : `${outside.map((v) => `"${String(v)}"`).join(', ')} is not among ${field.name}'s options`
    }
    case 'text':
      return typeof value === 'string' || typeof value === 'number' ? undefined : 'not text'
  }
}

/**
 * What somebody typed into a cell, as the field holds it — or why it cannot be. The third piece of
 * the rules above, beside them so the card and the write judge text the same way: a number column
 * that receives `abc` says so rather than the edit vanishing, and anything accepted here is
 * accepted by `checkedWrite`. A date may be typed with a `T` between day and time; nothing is
 * trimmed off it, so a time typed into a day-only field is refused rather than dropped.
 */
export function valueFromText(
  field: TargetField,
  text: string,
): { value: FieldValue } | { error: string } {
  const trimmed = text.trim()
  const value: FieldValue =
    trimmed === ''
      ? null
      : field.kind === 'number'
        ? Number(trimmed)
        : field.kind === 'choices'
          ? listEntries(trimmed)
          : field.kind === 'date'
            ? trimmed.replace(/^(\d{4}-\d{2}-\d{2})T/, '$1 ')
            : trimmed
  const error = refusal(field, value)
  return error ? { error } : { value }
}

/** A cell as the card draws it, and as an edit of it starts. */
export function fieldText(value: FieldValue | undefined): string {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'boolean') return value ? '✓' : ''
  return String(value)
}

/**
 * Whether a cell can be edited as text without changing what it holds: not a list with an entry
 * that itself holds a comma, which `valueFromText` would split into two.
 */
export function textEditable(field: TargetField, value: FieldValue): boolean {
  return (
    field.kind !== 'choices' || !Array.isArray(value) || !value.some((v) => v.includes(','))
  )
}

/** A value as a log records it: literal, so `false` and an empty cell stay two different things. */
export function literalText(value: FieldValue | undefined): string {
  if (value === null || value === undefined) return ''
  return Array.isArray(value) || typeof value === 'boolean'
    ? JSON.stringify(value)
    : String(value)
}

/**
 * A backend's cell, as a field holds it: a scalar kept, a list's entries as text, anything
 * structured as its JSON. One coercion for every target, so two backends cannot come to spell the
 * same cell differently.
 */
export function cellOf(value: unknown): FieldValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
  }
  return JSON.stringify(value)
}
