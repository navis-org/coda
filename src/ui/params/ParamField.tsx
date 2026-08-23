/**
 * Parameter widgets.
 *
 * Every widget is driven by the node's `ParamDef` plus the live `InferContext`, so
 * dropdowns (columns, ROIs, statuses, operators) list what is genuinely available given
 * the current upstream schema. That is the whole point of edit-time schema propagation —
 * without it these would be free-text fields.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import type { InferContext, ParamDef, ParamValue } from '../../core/node'
import { availableColumns, columnsKnown } from '../../core/node'

/**
 * What a column picker says when the port carries no schema at all.
 *
 * **Unknown is not missing**, which is the distinction `columnSchemaFor` exists to draw and the
 * one both of these widgets used to flatten. A port publishes no schema before its first run —
 * a Pivot, Raw Cypher, `Table from URL` on a fresh session — and marking a perfectly good column
 * "(missing)" there says it was deleted, which sends somebody to fix a picker that is already
 * right. Reported on exactly that chain: `ID column: neuronId (missing)` above
 * `Supervoxel ID column: no column`, on a node that then ran correctly.
 */
export const UNKNOWN_COLUMNS = 'not run yet'
export const UNKNOWN_HINT =
  'The upstream columns are not known until this has run. This is what will be used.'

export interface ParamFieldProps {
  param: ParamDef
  value: ParamValue | undefined
  ctx: InferContext
  onChange: (value: ParamValue) => void
  /** Inspector shows labels in a wider column and includes help text. */
  variant?: 'node' | 'inspector'
}

export function ParamField({ param, value, ctx, onChange, variant = 'node' }: ParamFieldProps) {
  // Every caller renders the label as a plain <span> in its own grid column, so the field
  // itself would otherwise have no accessible name. Naming it here covers the node body,
  // the inspector and the overlay rail in one place.
  const label = param.label

  switch (param.kind) {
    case 'number':
    case 'int':
      return (
        <NumberField
          label={label}
          value={typeof value === 'number' ? value : param.default}
          integer={param.kind === 'int'}
          min={param.min}
          max={param.max}
          step={param.step ?? (param.kind === 'int' ? 1 : 0.1)}
          onChange={onChange}
        />
      )

    case 'string':
      return (
        <TextField
          label={label}
          value={typeof value === 'string' ? value : param.default}
          placeholder={param.placeholder}
          multiline={param.multiline === true}
          mono={
            param.multiline === true ||
            param.placeholder?.includes('regex') ||
            param.id.includes('Pattern')
          }
          onChange={onChange}
        />
      )

    case 'boolean':
      return (
        <CheckboxField
          checked={typeof value === 'boolean' ? value : param.default}
          label={label}
          showLabel={variant === 'node'}
          onChange={onChange}
        />
      )

    case 'enum': {
      const options = typeof param.options === 'function' ? param.options(ctx) : param.options
      return (
        <SelectField
          label={label}
          value={typeof value === 'string' ? value : param.default}
          options={options}
          onChange={onChange}
        />
      )
    }

    case 'column': {
      const columns = availableColumns(param, ctx.inputs, ctx.params)
      const known = columnsKnown(param, ctx.inputs, ctx.params)
      const stored = typeof value === 'string' ? value : ''
      // An optional param shows exactly what is stored, including "none"; a required one
      // shows the resolver's fallback so the widget never displays an empty selection.
      const resolved = param.optional ? stored : (ctx.column(param.id) ?? '')
      return (
        <SelectField
          label={label}
          value={resolved}
          title={known ? undefined : UNKNOWN_HINT}
          options={[
            // An optional encoding needs a way back to "off"; a required one does not.
            ...(param.optional ? [{ value: '', label: 'none' }] : []),
            /*
             * No schema yet: offer what the resolver actually answered, plainly. Without this
             * the select falls to its no-options branch and renders *disabled*, so the one
             * thing worth knowing — which column this will use — is the one thing not shown.
             */
            ...(!known && resolved ? [{ value: resolved, label: resolved }] : []),
            // Drift, and only where the schema is known enough to say so: show the name that
            // went missing rather than silently pretending they picked the fallback.
            ...(known && stored && !columns.includes(stored)
              ? [{ value: stored, label: `${stored} (missing)` }]
              : []),
            ...columns.map((c) => ({ value: c, label: c })),
          ]}
          empty={columns.length === 0 ? (known ? 'no columns' : UNKNOWN_COLUMNS) : undefined}
          onChange={onChange}
        />
      )
    }

    case 'ids': {
      const ids = Array.isArray(value) ? value : []
      return (
        <IdsField label={label} noun={param.noun ?? 'items'} ids={ids} onChange={onChange} />
      )
    }

    case 'columns': {
      const columns = availableColumns(param, ctx.inputs, ctx.params)
      const selected = Array.isArray(value) ? value : []
      return (
        <ColumnsField
          label={label}
          available={columns}
          // `resolveColumns` keeps a stored list untouched while the schema is unknown, so the
          // chips have to read as kept rather than as lost.
          known={columnsKnown(param, ctx.inputs, ctx.params)}
          selected={selected}
          onChange={onChange}
        />
      )
    }
  }
}

// ---------------------------------------------------------------------------

interface NumberFieldProps {
  label: string
  value: number
  integer: boolean
  min?: number
  max?: number
  step: number
  onChange: (value: number) => void
}

/**
 * Number entry with drag-to-scrub, as in Blender: press and drag horizontally to change
 * the value, click without dragging to type. Scrubbing is what makes a threshold feel
 * explorable, and it pairs with cheap-node auto-evaluation to give live feedback.
 */
function NumberField({ label, value, integer, min, max, step, onChange }: NumberFieldProps) {
  const [text, setText] = useState(String(value))
  const [editing, setEditing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const drag = useRef<{ startX: number; startValue: number; moved: boolean } | null>(null)

  // Keep the display in sync with external changes (undo, load) unless mid-edit.
  useEffect(() => {
    if (!editing) setText(String(value))
  }, [value, editing])

  const clamp = useCallback(
    (next: number) => {
      let out = integer ? Math.round(next) : next
      if (min !== undefined) out = Math.max(min, out)
      if (max !== undefined) out = Math.min(max, out)
      // Avoid 0.30000000000000004 in the field.
      return integer ? out : Math.round(out * 1e6) / 1e6
    },
    [integer, min, max],
  )

  const commit = useCallback(
    (raw: string) => {
      const parsed = Number(raw)
      if (Number.isFinite(parsed)) onChange(clamp(parsed))
      else setText(String(value))
    },
    [clamp, onChange, value],
  )

  const onPointerDown = (event: React.PointerEvent<HTMLInputElement>) => {
    if (editing) return
    drag.current = { startX: event.clientX, startValue: value, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLInputElement>) => {
    const state = drag.current
    if (!state) return
    const dx = event.clientX - state.startX
    if (Math.abs(dx) < 3) return
    state.moved = true
    // Fine control with shift, coarse with a bare drag.
    const scale = event.shiftKey ? 0.25 : 1
    const next = clamp(state.startValue + dx * step * scale)
    setText(String(next))
    onChange(next)
  }

  const onPointerUp = (event: React.PointerEvent<HTMLInputElement>) => {
    const state = drag.current
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (state && !state.moved) {
      setEditing(true)
      inputRef.current?.select()
    }
  }

  return (
    <div className="number-field nodrag">
      <input
        ref={inputRef}
        className="field"
        type="text"
        aria-label={label}
        inputMode="decimal"
        value={text}
        readOnly={!editing}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          setEditing(false)
          commit(text)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur()
          } else if (e.key === 'Escape') {
            setText(String(value))
            setEditing(false)
            e.currentTarget.blur()
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            const delta = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1)
            const next = clamp(value + delta)
            setText(String(next))
            onChange(next)
          }
        }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------

export interface TextFieldProps {
  label: string
  value: string
  placeholder?: string
  mono?: boolean
  /** Render a textarea. Enter then inserts a newline instead of committing. */
  multiline?: boolean
  onChange: (value: string) => void
}

/**
 * Local state while typing, committed on blur/Enter — but also on a debounce, so a cheap
 * downstream node updates as you type without every keystroke becoming an undo step
 * (the store coalesces those by param id).
 */
export function TextField({ label, value, placeholder, mono, multiline, onChange }: TextFieldProps) {
  const [text, setText] = useState(value)
  const [focused, setFocused] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (!focused) setText(value)
  }, [value, focused])

  useEffect(() => () => clearTimeout(timer.current), [])

  const commitLater = (next: string) => {
    setText(next)
    clearTimeout(timer.current)
    // Multiline fields hold queries, which are expensive to run and half-written most of
    // the time. Those commit on blur only; a debounce would fire a query mid-sentence.
    if (!multiline) timer.current = setTimeout(() => onChange(next), 220)
  }

  const shared = {
    'aria-label': label,
    value: text,
    placeholder,
    spellCheck: false,
    onFocus: () => setFocused(true),
    onChange: (e: { target: { value: string } }) => commitLater(e.target.value),
    onBlur: (e: { target: { value: string } }) => {
      setFocused(false)
      clearTimeout(timer.current)
      onChange(e.target.value)
    },
  }

  if (multiline) {
    return (
      <textarea
        {...shared}
        className={`field field--area nodrag${mono ? ' field--mono' : ''}`}
        rows={6}
        onKeyDown={(e) => {
          // Enter is a newline here; ⌘/Ctrl+Enter is "done", matching every query editor.
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.blur()
          if (e.key === 'Escape') {
            setText(value)
            e.currentTarget.blur()
          }
          e.stopPropagation()
        }}
      />
    )
  }

  return (
    <input
      {...shared}
      className={`field nodrag${mono ? ' field--mono' : ''}`}
      type="text"
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          setText(value)
          e.currentTarget.blur()
        }
      }}
    />
  )
}

// ---------------------------------------------------------------------------

export interface SelectFieldProps {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  empty?: string
  title?: string | undefined
  onChange: (value: string) => void
}

export function SelectField({ label, value, options, empty, title, onChange }: SelectFieldProps) {
  if (options.length === 0) {
    return (
      <select className="field nodrag" aria-label={label} title={title} disabled>
        <option>{empty ?? '—'}</option>
      </select>
    )
  }
  return (
    <select
      className="field nodrag"
      aria-label={label}
      title={title}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* A stored value outside the option list would silently render as the first
          option; surface it instead. */}
      {!options.some((o) => o.value === value) && <option value={value}>{value || '—'}</option>}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

// ---------------------------------------------------------------------------

interface CheckboxFieldProps {
  checked: boolean
  label: string
  /** The node body repeats the label beside the box; the inspector has its own column. */
  showLabel: boolean
  onChange: (value: boolean) => void
}

function CheckboxField({ checked, label, showLabel, onChange }: CheckboxFieldProps) {
  return (
    <label className="checkbox-field nodrag">
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {showLabel && <span>{label}</span>}
    </label>
  )
}

// ---------------------------------------------------------------------------

interface IdsFieldProps {
  label: string
  noun: string
  ids: string[]
  onChange: (value: string[]) => void
}

/**
 * Read-only summary of a viewer-written selection, plus a way to clear it.
 *
 * Deliberately not editable by hand: the ids come from clicking in a viewer, and a text
 * box inviting someone to type neuron ids would imply an editing path that does not exist.
 */
function IdsField({ label, noun, ids, onChange }: IdsFieldProps) {
  return (
    <div className="ids-field nodrag" aria-label={label}>
      <span className="ids-field__count">
        {ids.length === 0 ? `no ${noun}` : `${ids.length} ${noun}`}
      </span>
      {ids.length > 0 && (
        <button
          type="button"
          title={`Clear selection (${ids.join(', ')})`}
          onClick={() => onChange([])}
        >
          clear
        </button>
      )}
    </div>
  )
}

interface ColumnsFieldProps {
  label: string
  available: string[]
  /** Whether the port publishes a schema at all. Unknown is not empty — see `UNKNOWN_COLUMNS`. */
  known: boolean
  selected: string[]
  onChange: (value: string[]) => void
}

/** Ordered multi-select shown as removable chips plus an add dropdown. */
function ColumnsField({ label, available, known, selected, onChange }: ColumnsFieldProps) {
  const remaining = available.filter((c) => !selected.includes(c))
  return (
    <div className="columns-field nodrag">
      {selected.length === 0 && remaining.length > 0 && (
        <span className="chip chip--empty">none</span>
      )}
      {selected.map((name) => (
        <span key={name} className="chip" title={known ? undefined : UNKNOWN_HINT}>
          {known && !available.includes(name) ? `${name} (missing)` : name}
          <button
            type="button"
            title={`Remove ${name}`}
            onClick={() => onChange(selected.filter((c) => c !== name))}
          >
            ×
          </button>
        </span>
      ))}
      {remaining.length > 0 && (
        <select
          className="columns-field__add"
          value=""
          aria-label={`Add a column to ${label}`}
          title="Add a column"
          onChange={(e) => {
            if (e.target.value) onChange([...selected, e.target.value])
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <option value="">+</option>
          {remaining.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      )}
      {/*
        Only where there is nothing to show instead. Beside a set of chips this is noise at best
        — the selections are visible, each already marked "(missing)" if a *known* schema has
        lost it, and the absent `+` says the rest — and at worst it reads as a warning about the
        chips next to it.
      */}
      {available.length === 0 && selected.length === 0 && (
        <span className="chip chip--empty" title={known ? undefined : UNKNOWN_HINT}>
          {known ? 'no columns' : UNKNOWN_COLUMNS}
        </span>
      )}
    </div>
  )
}
