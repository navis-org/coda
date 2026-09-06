/**
 * The Find Neurons card: one row per filter, and a button that adds another.
 *
 * Modelled closely on `RenameBody`, which is the other node whose configuration is a list
 * somebody grows — and the two share the rule that matters most. **A blank row is component
 * state, never a param.** `encodeRows` drops an incomplete row, so pressing Add cannot write
 * one; otherwise adding a row would mark the node stale and invalidate everything downstream
 * for a control nobody has filled in yet.
 *
 * ## The field list is the dataset's, and that is the whole point
 *
 * Options come from `schemasFromType(ctx.inputs.dataset).neurons` — the *discovered* neuron
 * schema, so hemibrain offers `cellBodyFiber`, manc offers `hemilineage`, a FlyWire datastack
 * offers `super_class` and `cell_sub_class`, and CATMAID offers `annotations` and `cableLength`.
 * A field the dataset does not publish cannot be picked, which is what makes the whole class of
 * silently-wrong answers this node used to give unreachable rather than merely caught.
 *
 * The operator list follows the chosen field's dtype, so picking `size` gives `≥` and picking
 * `type` gives `contains` and `is one of`. Same idea as `core.filterTable`'s operator dropdown, and
 * deliberately the same words.
 *
 * ## Unknown is not missing, decided in one place
 *
 * A dataset listing has not always landed, and `schemasFromType` answers that with
 * `CANONICAL_SCHEMAS` rather than with `undefined` — so "is this field in the schema?" is not the
 * question that tells you whether a stored field is really gone. The card asks `resolveRows`
 * instead, which is what `validate` and the foot line already read, so the `(missing)` marker,
 * the badge and the count are one analysis rather than three that agree today.
 *
 * ## The foot line says which of two things an empty card means
 *
 * A node with no filters returns **no neurons**, so the line has to say that rather than "every
 * neuron in the dataset" — and it reads `asksNothing` to decide, not `stored.length`. The two
 * disagree on exactly one card: `In ROI` set with no rows, which queries perfectly well and which
 * a row count would report as empty. One function decides it here and in `evaluate`, which is the
 * rule the `(missing)` marker above already follows.
 *
 * There is deliberately **no `validate` issue** for it. An unconfigured node is not a broken one,
 * and marking every freshly-dropped card with a warning badge is how a badge stops meaning
 * anything; the run-time `ctx.warn` is what explains the empty table to somebody who pressed Run.
 *
 * ## There is nothing to convert any more
 *
 * This card used to draw the four legacy params as rows and write them back as real ones in the
 * first edit that touched anything — a conversion somebody performed rather than one that
 * happened to their file on load. The params are gone, so `stored` is simply `filters`, and the
 * `commit` below writes one param instead of up to five. What that removed is worth naming,
 * because it was the subtle half: every `setParam` is its own store commit — a full `inferGraph`
 * over the canvas, a `refreshStates` pass and an undo entry — so the conversion had to clear only
 * the legacy params that actually carried something, or a single click cost five of them.
 */

import { useMemo, useState } from 'react'

import type { ParamValue } from '../../core/node'
import type { FilterRow } from '../../data/filterRows'
import { arityOf, encodeRows, resolveRows, rowOpsForDType } from '../../data/filterRows'
import { resolveColumn } from '../../data/terms'
import { schemasFromType } from '../../nodes/lib/datasetParam'
import { askShape, rowsFromParams } from '../../nodes/lib/findNeuronsRows'
import { parseTypedLabels } from '../../nodes/lib/labelLookup'
import { SelectField, TextField } from '../params/ParamField'
import type { NodeBodyProps } from './nodeBodies'

const BLANK: FilterRow = { field: '', op: 'is', values: [] }

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

/**
 * The foot line, one entry per `askShape` answer.
 *
 * A table rather than a chain of ternaries in the JSX, so adding a fourth kind of question is a
 * compile error here rather than a card that silently keeps saying one of the old three.
 */
const FOOT_LABEL: Record<ReturnType<typeof askShape>, (rows: number) => string> = {
  nothing: () => 'no filters — no neurons',
  regionOnly: () => 'region only — every neuron innervating it',
  rows: (n) => `${n} filter${n === 1 ? '' : 's'}, all must match`,
}

export function FindNeuronsBody({ node, ctx, compact, setParam }: NodeBodyProps) {
  /*
   * The rows the node is actually asking for, read exactly as `evaluate` and both emitters read
   * them. Through `rowsFromParams` rather than `decodeRows(node.params.filters)` for that reason
   * alone — six readers of one param is six chances for one of them to grow a condition.
   */
  const stored = useMemo(() => rowsFromParams(node.params), [node.params])

  /*
   * What is on screen, which is not the same list as what is stored.
   *
   * A row being filled in has a field and no value yet, and `encodeRows` will not store that —
   * so the card has to hold it, or picking a field would make the row somebody is typing into
   * disappear. Same for clearing a value on a stored row: the row stays, unstored, rather than
   * vanishing under the cursor.
   *
   * `undefined` until the first edit, and **derived from the store until then** — deliberately,
   * rather than seeded in `useState`. A card mounts before the graph it belongs to has loaded,
   * so a seeded blank-row count is computed against an empty node and then never revisited:
   * a saved graph with three filters draws four rows, the last one blank, for ever.
   */
  const [draft, setDraft] = useState<FilterRow[] | undefined>(undefined)
  // One blank on an unconfigured node, because a card whose whole content is "+ Add filter" says
  // less about what this node does than a card showing the shape of one filter.
  const rows = draft ?? (stored.length === 0 ? [BLANK] : stored)

  const connected = Boolean(ctx.inputs.dataset)
  /*
   * Memoised because three things below key off it, and `withAnnotations` mints a fresh schema
   * per call where a dataset has an annotation chain — so without this every render misses all
   * three memos and re-runs `resolveRows`, `new RegExp` and all.
   */
  const schema = useMemo(
    () => schemasFromType(ctx.inputs.dataset).neurons,
    [ctx.inputs.dataset],
  )
  const fields = useMemo(() => schema?.columns.map((c) => c.name) ?? [], [schema])

  /** One param, one store commit — see the header for what this used to have to do besides. */
  const commit = (next: readonly FilterRow[]) => {
    setDraft([...next])
    setParam('filters', encodeRows(next) as unknown as ParamValue)
  }

  /** Edit a row on screen. It reaches the param only once it is complete enough to store. */
  const edit = (index: number, patch: Partial<FilterRow>) => {
    commit(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }

  const remove = (index: number) => {
    commit(rows.filter((_, i) => i !== index))
  }

  /*
   * The same analysis `validate` reads, rather than a second expression answering the same
   * question — the badge and this line would otherwise be free to disagree about how many rows
   * are broken, with each pinned only against its own implementation.
   */
  const problems = useMemo(() => resolveRows(schema, stored).problems, [schema, stored])
  const broken = useMemo(() => new Set(problems.map((p) => p.field)), [problems])

  /*
   * What kind of question this node is asking, named by the same function `evaluate` reads rather
   * than reconstructed from `stored.length` — those two disagree exactly where `In ROI` is set
   * and no row is, a card the foot line would otherwise tell "no neurons" while the node queried
   * perfectly well. `stored` is handed over so the rows are decoded once for both.
   */
  const shape = useMemo(() => askShape(node.params, stored), [node.params, stored])

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
                options={[
                  // The placeholder is what keeps this out of `SelectField`'s no-options branch,
                  // which renders *disabled* — the state a dataset whose listing has not landed
                  // is in. It doubles as the way back to unset.
                  { value: '', label: 'field…' },
                  /*
                   * A stored field the list does not offer stays selectable either way, and is
                   * labelled `(missing)` only when `resolveRows` actually reported it — the same
                   * analysis the badge and the foot line read.
                   *
                   * Asking `fields.includes` instead was a second implementation of that
                   * question, and a wrong one: `schemasFromType` never returns undefined, it
                   * falls back to `CANONICAL_SCHEMAS`, so an unresolved dataset marked every
                   * dataset-specific field `(missing)` against a seven-column stand-in. Unknown
                   * is not missing, and only one place here gets to decide which it is.
                   */
                  ...(row.field && !fields.includes(row.field)
                    ? [
                        {
                          value: row.field,
                          label: broken.has(row.field) ? `${row.field} (missing)` : row.field,
                        },
                      ]
                    : []),
                  ...fields.map((f) => ({ value: f, label: f })),
                ]}
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

      {!compact ? null : (
        <div
          className={`list-body__foot${shape === 'nothing' ? ' list-body__foot--empty' : ''}`}
        >
          {!connected ? (
            <span>Connect a dataset.</span>
          ) : (
            <>
              <span>{FOOT_LABEL[shape](stored.length)}</span>
              {problems.length > 0 && (
                <span
                  className="list-body__missing"
                  title={problems.map((p) => p.message).join('\n')}
                >
                  ⚠ {problems.length} not in this dataset
                </span>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
