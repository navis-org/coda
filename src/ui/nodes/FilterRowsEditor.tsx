/**
 * A list of filter rows, growable: one row per filter and a button that adds another.
 *
 * The body of both cards that carry a `filters` param — Find Neurons, whose fields come from a
 * dataset's own neuron schema, and Split Neurons, whose fields come off the incoming wire. It was
 * `FindNeuronsBody` whole until the second node arrived; what is here is everything that is about
 * *drawing a row*, and what stayed behind is everything each node means by a row.
 *
 * The rule that survives the extraction is the one that matters most, and it is why this owns
 * `draft` rather than taking rows as a controlled prop. **A blank row is component state, never a
 * param.** `encodeRows` drops an incomplete row, so pressing Add cannot write one — otherwise
 * adding a row would mark the node stale and invalidate everything downstream for a control
 * nobody has filled in yet. And a row being filled in has a field and no value yet, so the card
 * has to hold it or picking a field would make the row somebody is typing into disappear. Same
 * for clearing a value on a stored row: the row stays, unstored, rather than vanishing under the
 * cursor. `RenameBody` draws the same line and says so.
 *
 * `draft` is `undefined` until the first edit and **derived from the store until then** —
 * deliberately, rather than seeded in `useState`. A card mounts before the graph it belongs to
 * has loaded, so a seeded blank-row count is computed against an empty node and then never
 * revisited: a saved graph with three filters draws four rows, the last one blank, for ever.
 *
 * ## Unknown is not missing, and one call decides it
 *
 * A schema has not always arrived, and neither node answers that with `undefined` — Find Neurons
 * falls back to `CANONICAL_SCHEMAS`, a split node's wire may be unwired — so "is this field in
 * the schema?" is not the question that tells you whether a stored field is really gone.
 * `resolveRows` is, and it is asked **here, once**: the `(missing)` marker, the row tint and
 * whatever the caller's foot line says are one analysis rather than three that agree today. The
 * first shape of this took `fields` and `broken` as props, which put that same derivation in both
 * cards and left the signature unable to enforce the property this paragraph claims — and a
 * `fields` list that disagreed with `schema` would degrade in silence, `rowOpsForDType(undefined)`
 * offering `contains` for a numeric column. So `foot` is handed the problems instead.
 */

import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import type { ParamValue } from '../../core/node'
import type { TableSchema } from '../../core/types'
import { columnNames } from '../../core/types'
import type { FilterRow, RowProblem } from '../../data/filterRows'
import { arityOf, resolveRows, rowOpsForDType } from '../../data/filterRows'
import { resolveColumn } from '../../data/terms'
import { FILTERS_PARAM_ID, rowsParamValue } from '../../nodes/lib/filterRowParams'
import { parseTypedLabels } from '../../nodes/lib/labelLookup'
import { plural } from '../format'
import { SelectField, TextField } from '../params/ParamField'

const BLANK: FilterRow = { field: '', op: 'is', values: [] }

/**
 * The placeholder option, and it is load-bearing twice: it keeps the picker out of
 * `SelectField`'s no-options branch, which renders *disabled* — the state a schema that has not
 * landed is in — and it is the way back to unset.
 */
const UNSET_FIELD = { value: '', label: 'field…' }

export interface FilterRowsEditorProps {
  /** The schema whose columns a row may name. Undefined where nothing is wired yet. */
  schema: TableSchema | undefined
  /** The rows the node is storing, decoded through the node's own `rowsFromParams`. */
  stored: readonly FilterRow[]
  /**
   * The card's own `setParam`. The editor writes `filters` itself, because encoding the rows is
   * the same act for every caller — two cards spelling `encodeRows(next) as unknown as
   * ParamValue` was the write half of a codec whose read half is centralised in
   * `filterRowParams.ts`, which is the asymmetry that file exists to prevent.
   */
  setParam: (paramId: string, value: ParamValue) => void
  /**
   * The card's foot line, given the problems this editor already found. Drawn below the Add
   * button; a caller that wants none returns null, and both return null outside `compact`.
   */
  foot?: (problems: readonly RowProblem[]) => ReactNode
}

/**
 * How a row's values are shown and read back.
 *
 * A multi-value operator gets one comma-separated field rather than a chip control, because the
 * values are usually pasted — a list of types out of a result, or out of a paper — and a chip
 * control makes pasting twelve of them twelve gestures. Splitting on commas is the same thing
 * `IDs from Label`'s text box does with labels.
 */
function valueText(row: FilterRow): string {
  return row.values.join(', ')
}

function readValues(row: FilterRow, text: string): string[] {
  // `parseTypedLabels` rather than a second split/trim/drop-empty — it is what `IDs from Label`'s
  // box does with labels, which is the same act, and it also handles the newlines a paste can
  // carry even though this control is one line.
  if (arityOf(row.op) === 'many') return parseTypedLabels(text)
  return text === '' ? [] : [text]
}

export function FilterRowsEditor({ schema, stored, setParam, foot }: FilterRowsEditorProps) {
  const [draft, setDraft] = useState<FilterRow[] | undefined>(undefined)
  // One blank on an unconfigured node, because a card whose whole content is "+ Add filter" says
  // less about what the node does than a card showing the shape of one filter.
  const rows = draft ?? (stored.length === 0 ? [BLANK] : stored)

  const fields = useMemo(() => columnNames(schema), [schema])
  /* One `resolveRows` for everything that reads it — see the header. */
  const problems = useMemo(() => resolveRows(schema, stored).problems, [schema, stored])
  const broken = useMemo(() => new Set(problems.map((p) => p.field)), [problems])
  /*
   * The options every row's field picker shares, built once rather than per row. A wide table is
   * what makes that worth saying: this editor's schema is a dataset's ten-column neuron table on
   * one card and whatever a Pivot or an uploaded CSV published on the other, so four rows over
   * three hundred columns is 1,200 objects per render against 300.
   */
  const columnOptions = useMemo(() => fields.map((f) => ({ value: f, label: f })), [fields])
  const fieldOptions = useMemo(() => [UNSET_FIELD, ...columnOptions], [columnOptions])
  const known = useMemo(() => new Set(fields), [fields])

  /** One param, one store commit — every `setParam` is a full inference pass and an undo entry. */
  const commit = (next: readonly FilterRow[]) => {
    setDraft([...next])
    setParam(FILTERS_PARAM_ID, rowsParamValue(next))
  }

  /** Edit a row on screen. It reaches the param only once it is complete enough to store. */
  const edit = (index: number, patch: Partial<FilterRow>) => {
    commit(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }

  const remove = (index: number) => {
    commit(rows.filter((_, i) => i !== index))
  }

  return (
    <div className="list-body nodrag">
      <div className="filter-body__rows">
        {rows.map((row, i) => {
          // `resolveColumn`, not `findColumn`: `resolveRows` matches a row's field
          // case-insensitively, and a card that answered the same question case-*sensitively*
          // would offer text operators for a numeric column the query resolves perfectly well.
          const column = row.field ? resolveColumn(schema, row.field) : undefined
          const ops = rowOpsForDType(column?.dtype)
          const arity = arityOf(row.op)
          // Keyed by position, which is what the list is: rows carry no identity of their own,
          // and a key built from the field would remount the input somebody is typing into.
          return (
            <div
              className={`filter-body__row${broken.has(row.field) ? ' filter-body__row--broken' : ''}`}
              key={i}
            >
              <SelectField
                label={`Field ${i + 1}`}
                value={row.field}
                title={row.field || undefined}
                /*
                 * A stored field the list does not offer stays selectable either way, and is
                 * labelled `(missing)` only when `resolveRows` actually reported it — the same
                 * analysis the row tint and the foot line read.
                 *
                 * Asking whether the schema has it instead was a second implementation of that
                 * question, and a wrong one: `schemasFromType` never returns undefined, it falls
                 * back to `CANONICAL_SCHEMAS`, so an unresolved dataset marked every
                 * dataset-specific field `(missing)` against a seven-column stand-in. Unknown is
                 * not missing, and only one place gets to decide which it is.
                 */
                options={
                  row.field && !known.has(row.field)
                    ? [
                        UNSET_FIELD,
                        {
                          value: row.field,
                          label: broken.has(row.field) ? `${row.field} (missing)` : row.field,
                        },
                        ...columnOptions,
                      ]
                    : fieldOptions
                }
                onChange={(field) => {
                  // The operator may not survive a change of field — `contains` means nothing on
                  // a number — so it falls back to the new dtype's first rather than staying and
                  // being reported as broken by the row somebody just fixed.
                  const dtype = resolveColumn(schema, field)?.dtype
                  const allowed = rowOpsForDType(dtype)
                  const op = allowed.some((o) => o.value === row.op)
                    ? row.op
                    : allowed[0]!.value
                  edit(i, { field, op })
                }}
              />
              <SelectField
                label={`Condition ${i + 1}`}
                value={row.op}
                options={ops.map((o) => ({ value: o.value, label: o.label }))}
                onChange={(op) => edit(i, { op: op as FilterRow['op'] })}
              />
              {arity === 'none' ? (
                <span className="filter-body__novalue" aria-hidden="true">
                  —
                </span>
              ) : (
                <TextField
                  label={`Value ${i + 1}`}
                  value={valueText(row)}
                  placeholder={arity === 'many' ? 'LC4, LC6' : 'value'}
                  onChange={(text) => edit(i, { values: readValues(row, text) })}
                />
              )}
              <button
                type="button"
                className="rename-body__remove"
                aria-label={`Remove filter ${i + 1}`}
                title="Remove this filter"
                onClick={() => remove(i)}
              >
                ✕
              </button>
            </div>
          )
        })}
      </div>

      <button
        type="button"
        className="rename-body__add"
        onClick={() => setDraft([...rows, BLANK])}
        title="Add another filter"
      >
        + Add filter
      </button>

      {foot?.(problems)}
    </div>
  )
}

/**
 * The foot line under a list of filter rows: what the card is asking, and what is wrong with it.
 *
 * Shared for the same reason the rows above it are. The two cards were carrying their own copies
 * of the `--empty` tint, the `list-body__missing` badge and its multi-line `title` — the
 * accessibility details in the part nobody looks at twice — and one of them would have drifted.
 * What each card supplies is only its **words**, and the wording genuinely differs: a dataset
 * against a collection of skeletons, "no neurons" against "nothing matches", and a field missing
 * from a dataset against one missing from an attribute table.
 *
 * **The words and the tint arrive as one value**, because they are one decision: the first shape
 * took them as independent props over the same three-way state, so each caller evaluated its
 * conditions twice and nothing stopped the tint disagreeing with the sentence — which is the
 * property this file claims for `resolveRows` one paragraph up. `missing` is a noun phrase rather
 * than a `(count) => string`, the callback having bought a freedom neither caller used.
 *
 * The `compact` gate lives here rather than at each call site: outside the card this is the
 * inspector, where the same words appear beside the param anyway.
 */
export interface FilterRowsFootState {
  /** What the card is asking — or, with nothing wired, what to connect. */
  label: string
  /** Whether this card is asking nothing, which each node decides for itself. */
  empty: boolean
}

export function FilterRowsFoot({
  compact,
  state,
  problems,
  missing,
}: {
  compact: boolean
  state: FilterRowsFootState
  problems: readonly RowProblem[]
  /** The badge's noun phrase for the unresolvable rows. The ⚠ and the count are ours. */
  missing: string
}) {
  if (!compact) return null
  return (
    <div className={`list-body__foot${state.empty ? ' list-body__foot--empty' : ''}`}>
      <span>{state.label}</span>
      {problems.length > 0 && (
        <span className="list-body__missing" title={problems.map((p) => p.message).join('\n')}>
          ⚠ {problems.length} {missing}
        </span>
      )}
    </div>
  )
}

/** What both cards say about a configured set of rows, which is the same sentence. */
export function rowCountLabel(rows: number): string {
  return `${plural(rows, 'filter')}, all must match`
}
