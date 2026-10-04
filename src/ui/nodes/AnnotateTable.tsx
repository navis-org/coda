/**
 * An Annotate tab's table and the controls around it: the field chooser, the rows with their
 * editable cells, and the bulk-fill bar that sets one field across the rows ticked.
 *
 * Rows are memoised and their callbacks stable (`useTargetTable`), so a write redraws the rows it
 * touched rather than a table the overlay draws whole. A column's suggestions are one `datalist`,
 * named for this table alone.
 */

import { memo, useId, useMemo, useState } from 'react'

import {
  dateShape,
  fieldText,
  sameValue,
  textEditable,
  valueFromText,
} from '../../data/annotations/targets/fieldValues'
import type {
  FieldValue,
  TargetField,
  TargetRecord,
} from '../../data/annotations/targets/types'
import { FilterInput, NoMatch, matching } from '../explore/fieldPopover'
import { plural } from '../format'
import type { CellMark, Marks, OnCommit, OnInvalid, OnSelect } from './useTargetTable'

const readOnlyNote = (field: TargetField) =>
  field.readOnly ? `Read-only: ${field.readOnly}` : undefined

/** Field names in the order a person looks for them: case ignored, `group2` before `group10`. */
const BY_NAME = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** What a text box for this field shows while empty: a date's shape, or nothing. */
const placeholderOf = (field: TargetField) =>
  field.kind === 'date' ? dateShape(field.withTime) : undefined

/** A choice field's options, with an empty first entry — the cells' select and the fill bar's. */
function ChoiceSelect({
  field,
  value,
  label,
  onChange,
}: {
  field: TargetField
  value: string
  label: string
  onChange: (value: string) => void
}) {
  return (
    <select
      className="annotate__input"
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="" />
      {(field.options ?? []).map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  )
}

/**
 * The target's fields as a filterable checklist, alphabetically. A field the stored choice names and
 * the target no longer has is listed as missing rather than dropped from view, so it can be unticked.
 */
export function FieldChooser({
  fields,
  chosen,
  onChange,
}: {
  fields: readonly TargetField[]
  chosen: readonly string[]
  onChange: (next: string[]) => void
}) {
  const [filter, setFilter] = useState('')
  const on = new Set(chosen)
  const known = new Set(fields.map((f) => f.name))
  const all = [
    ...fields.map((f) => ({ name: f.name, note: readOnlyNote(f), missing: false })),
    ...chosen
      .filter((name) => !known.has(name))
      .map((name) => ({ name, note: 'Not a field of this table any more', missing: true })),
  ].sort((a, b) => BY_NAME.compare(a.name, b.name))
  const listed = matching(all, filter, (f) => f.name)
  return (
    <div className="annotate__chooser">
      <FilterInput value={filter} onChange={setFilter} />
      {listed.length === 0 ? (
        <NoMatch filter={filter} />
      ) : (
        <ul>
          {listed.map((f) => (
            <li key={f.name}>
              <label title={f.note}>
                <input
                  type="checkbox"
                  checked={on.has(f.name)}
                  onChange={(e) =>
                    onChange(
                      e.target.checked
                        ? [...chosen, f.name]
                        : chosen.filter((name) => name !== f.name),
                    )
                  }
                />
                <span className={f.note ? 'annotate__readonly' : undefined}>
                  {f.name}
                  {f.missing && ' (missing)'}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * One field set to one value across the rows ticked — BigClust's gesture, "these forty are LC4a".
 * The value is read as a cell edit is (`valueFromText`), so a fill the field cannot hold is said
 * here and nothing is sent; an empty value clears.
 */
export function FillBar({
  columns,
  count,
  onFill,
}: {
  /** The shown fields that can be edited. */
  columns: readonly TargetField[]
  /** How many rows are ticked. */
  count: number
  onFill: (field: TargetField, value: FieldValue) => void
}) {
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const field = columns.find((c) => c.name === name) ?? columns[0]
  if (!field || count === 0) return null
  const parsed = valueFromText(field, text)
  const fill = () => {
    if ('value' in parsed) onFill(field, parsed.value)
  }
  return (
    <div className="annotate__fill">
      <span>Set</span>
      <select
        className="annotate__input"
        aria-label="Field to set"
        value={field.name}
        onChange={(e) => setName(e.target.value)}
      >
        {columns.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name}
          </option>
        ))}
      </select>
      <span>to</span>
      {field.kind === 'choice' ? (
        <ChoiceSelect field={field} value={text} label="Value" onChange={setText} />
      ) : (
        <input
          className="annotate__input"
          aria-label="Value"
          value={text}
          placeholder={placeholderOf(field) ?? 'empty clears'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') fill()
          }}
        />
      )}
      <button
        type="button"
        disabled={'error' in parsed}
        title={'error' in parsed ? parsed.error : undefined}
        onClick={fill}
      >
        {'value' in parsed && parsed.value === null ? 'Clear' : 'Set'} on {plural(count, 'row')}
      </button>
    </div>
  )
}

export const AnnotateTable = memo(function AnnotateTable({
  columns,
  records,
  marks,
  edited,
  locked,
  selected,
  onSelect,
  onCommit,
  onInvalid,
}: {
  columns: readonly TargetField[]
  records: readonly TargetRecord[]
  marks: Marks
  /** The cells this session changed and has not undone, by record key (`editedCells`). */
  edited: ReadonlyMap<string, string>
  locked: boolean
  /** The rows ticked for a bulk fill, by record key. */
  selected: ReadonlySet<string>
  onSelect: OnSelect
  onCommit: OnCommit
  onInvalid: OnInvalid
}) {
  // One suggestion list per column, shared by its cells, named for this table alone — a second
  // card with a field of the same name must not offer this card's suggestions.
  const tableId = useId()
  const lists = useMemo(
    () => columns.map((c, i) => (c.suggestions?.length ? `${tableId}-${i}` : undefined)),
    [columns, tableId],
  )
  // Built once per column set, so a mark changing does not rebuild every suggestion.
  const suggestions = useMemo(
    () =>
      columns.map((c, i) =>
        lists[i] ? (
          <datalist key={c.name} id={lists[i]}>
            {c.suggestions!.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        ) : null,
      ),
    [columns, lists],
  )
  if (columns.length === 0 || records.length === 0) return null
  // A repeated id is shown on each of its rows, numbered, so two rows for one neuron read as that.
  const counts = new Map<string, number>()
  for (const r of records) counts.set(r.id, (counts.get(r.id) ?? 0) + 1)
  const seen = new Map<string, number>()
  const all = records.every((r) => selected.has(r.key))
  return (
    <div className="annotate__scroll">
      {suggestions}
      <table className="annotate__table">
        <thead>
          <tr>
            <th className="annotate__pick">
              {!locked && (
                <input
                  type="checkbox"
                  aria-label="Tick every row"
                  checked={all}
                  onChange={(e) =>
                    onSelect(
                      records.map((r) => r.key),
                      e.target.checked,
                    )
                  }
                />
              )}
            </th>
            <th>id</th>
            {columns.map((c) => (
              <th key={c.name} title={readOnlyNote(c)}>
                {c.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {records.map((record) => {
            const n = (seen.get(record.id) ?? 0) + 1
            seen.set(record.id, n)
            return (
              <Row
                key={record.key}
                record={record}
                columns={columns}
                lists={lists}
                marks={marks.get(record.key)}
                edited={edited.get(record.key)}
                locked={locked}
                picked={selected.has(record.key)}
                n={n}
                of={counts.get(record.id) ?? 1}
                onSelect={onSelect}
                onCommit={onCommit}
                onInvalid={onInvalid}
              />
            )
          })}
        </tbody>
      </table>
    </div>
  )
})

/** One record's row. Memoised: a write redraws the rows whose record or marks it changed. */
const Row = memo(function Row({
  record,
  columns,
  lists,
  marks,
  edited,
  locked,
  picked,
  n,
  of,
  onSelect,
  onCommit,
  onInvalid,
}: {
  record: TargetRecord
  columns: readonly TargetField[]
  lists: readonly (string | undefined)[]
  marks: ReadonlyMap<string, CellMark> | undefined
  /** This row's edited fields, `\u0000`-joined: text, so the memo compares it by value. */
  edited: string | undefined
  locked: boolean
  picked: boolean
  /** Which of this id's rows this is, and how many it has. */
  n: number
  of: number
  onSelect: OnSelect
  onCommit: OnCommit
  onInvalid: OnInvalid
}) {
  const editedFields = edited?.split('\u0000') ?? []
  return (
    <tr className={picked ? 'annotate__row--picked' : undefined}>
      <td className="annotate__pick">
        {!locked && (
          <input
            type="checkbox"
            aria-label={`Tick ${record.id}`}
            checked={picked}
            onChange={(e) => onSelect([record.key], e.target.checked)}
          />
        )}
      </td>
      <th scope="row" title={of > 1 ? `Row ${n} of ${of} for this id` : undefined}>
        {record.id}
        {of > 1 && <sup>{n}</sup>}
      </th>
      {columns.map((field, i) => {
        const mark = marks?.get(field.name)
        const changed = editedFields.includes(field.name)
        return (
          <td
            key={field.name}
            className={`annotate__cell${mark ? ` annotate__cell--${mark.state}` : ''}${changed ? ' annotate__cell--edited' : ''}`}
            title={mark?.note ?? (changed ? 'Edited in this session' : readOnlyNote(field))}
          >
            <CellControl
              field={field}
              value={record.values[field.name] ?? null}
              locked={locked}
              list={lists[i]}
              onCommit={(next) => onCommit(record, field, next)}
              onInvalid={(message) => onInvalid(record, field, message)}
            />
          </td>
        )
      })}
    </tr>
  )
})

/** A cell's control, chosen by its field's kind: plain text where it cannot be edited. */
function CellControl({
  field,
  value,
  locked,
  list,
  onCommit,
  onInvalid,
}: {
  field: TargetField
  value: FieldValue
  locked: boolean
  list: string | undefined
  onCommit: (value: FieldValue) => void
  onInvalid: (message: string | undefined) => void
}) {
  if (field.readOnly || locked) return fieldText(value)
  if (field.kind === 'bool') {
    return (
      <input
        type="checkbox"
        checked={value === true}
        aria-label={field.name}
        onChange={(e) => onCommit(e.target.checked)}
      />
    )
  }
  if (field.kind === 'choice') {
    return (
      <ChoiceSelect
        field={field}
        value={typeof value === 'string' ? value : ''}
        label={field.name}
        onChange={(next) => onCommit(next === '' ? null : next)}
      />
    )
  }
  if (!textEditable(field, value)) {
    // An entry holding a comma would be split in two by an edit as text.
    return (
      <span title="An entry holds a comma, so this list is not edited here">
        {fieldText(value)}
      </span>
    )
  }
  return (
    <TextControl
      field={field}
      value={value}
      list={list}
      onCommit={onCommit}
      onInvalid={onInvalid}
    />
  )
}

/**
 * A cell edited as text: its draft, committed on leaving or Enter and abandoned on Escape. Text the
 * field cannot hold is kept on screen and marked with why, rather than snapping back.
 */
function TextControl({
  field,
  value,
  list,
  onCommit,
  onInvalid,
}: {
  field: TargetField
  value: FieldValue
  list: string | undefined
  onCommit: (value: FieldValue) => void
  onInvalid: (message: string | undefined) => void
}) {
  const [draft, setDraft] = useState<string | undefined>(undefined)
  const finish = () => {
    if (draft === undefined) return
    const next = valueFromText(field, draft)
    if ('error' in next) return onInvalid(next.error)
    setDraft(undefined)
    onInvalid(undefined)
    // `sameValue`, the write's own rule: retyping a list in another order is no edit.
    if (!sameValue(next.value, value)) onCommit(next.value)
  }
  return (
    <input
      className="annotate__input"
      aria-label={field.name}
      value={draft ?? fieldText(value)}
      list={list}
      placeholder={placeholderOf(field)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={finish}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          setDraft(undefined)
          onInvalid(undefined)
        }
      }}
    />
  )
}
