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
 * ## Legacy params are shown as rows, and converted on first edit
 *
 * A saved graph carries `typePattern`/`status`/`minSize` rather than `filters`, and
 * `rowsFromParams` folds them in — so they appear here as ordinary rows immediately. Editing
 * anything writes the whole set to `filters` and clears whichever of the four carried a value,
 * which is a conversion somebody performed rather than one that happened to their file on load.
 * Until then the node runs off the legacy params exactly as it did before. What "cleared" means
 * per param is `LEGACY_DEFAULTS`, beside the code that reads them — those values are in the
 * provenance key, so the two halves cannot be allowed to disagree.
 */

import { useMemo, useState } from 'react'

import type { ParamValue } from '../../core/node'
import type { FilterRow } from '../../data/filterRows'
import { arityOf, encodeRows, resolveRows, rowOpsForDType } from '../../data/filterRows'
import { resolveColumn } from '../../data/terms'
import { schemasFromType } from '../../nodes/lib/datasetParam'
import { LEGACY_DEFAULTS, rowsFromParams } from '../../nodes/lib/findNeuronsRows'
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

export function FindNeuronsBody({ node, ctx, compact, setParam }: NodeBodyProps) {
  /*
   * The rows the node is actually asking for — legacy params folded in, exactly as `evaluate`
   * and both emitters read them. Drawing `filters` alone would show an empty card for every
   * graph saved before this node had rows.
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

  /*
   * Writing the rows is also what converts a legacy node: the four old params are cleared in the
   * same edit that stores the equivalent rows, so the two can never both contribute. Clearing
   * them is safe precisely because `stored` already contains what they meant.
   */
  const commit = (next: readonly FilterRow[]) => {
    setDraft([...next])
    setParam('filters', encodeRows(next) as unknown as ParamValue)
    /*
     * Only the legacy params that actually carry something. Every `setParam` is a separate store
     * commit — a full `inferGraph` over the whole canvas, a `refreshStates` pass and its own undo
     * entry — so clearing all four unconditionally cost five of those per click, three of them
     * writing a value that was already there.
     */
    for (const [id, cleared] of Object.entries(LEGACY_DEFAULTS)) {
      if (node.params[id] !== cleared) setParam(id, cleared)
    }
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
          className={`list-body__foot${stored.length === 0 ? ' list-body__foot--empty' : ''}`}
        >
          {!connected ? (
            <span>Connect a dataset.</span>
          ) : (
            <>
              <span>
                {stored.length === 0
                  ? 'no filters — every neuron in the dataset'
                  : `${stored.length} filter${stored.length === 1 ? '' : 's'}, all must match`}
              </span>
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
