/**
 * The Edit Table card: one row per rule — `where … set column = value` — and a button that adds
 * another.
 *
 * `RenameBody`'s shape with one more control, and it keeps that card's two decisions. **A blank
 * row is component state, never a param**: `encodeSetters` drops a row with all three parts
 * empty, so pressing Add cannot write one and cannot mark every node downstream stale for a
 * control nobody has touched. And a **half-typed row is kept** — a row with a column picked and
 * no value yet is inert, so storing it costs nothing and dropping it would delete the row from
 * under the cursor.
 *
 * ## The column is a text field with completions, not a picker
 *
 * Because naming a column the table does not have is not a mistake here — it is how you add
 * one. A `select` would make that unreachable, and a select-plus-"new column…"-text-box makes
 * one value into two controls that can disagree. So it is a `TextField` with the schema's
 * columns as a `datalist`: picking an existing column is one click, and inventing one is
 * typing.
 *
 * ## The foot line counts rows, and it costs a pass over the table
 *
 * "12 rows changed" is the only thing on this card that says whether a rule did what somebody
 * meant, and no amount of edit-time analysis can produce it — a filter that parses perfectly
 * and matches nothing is the failure mode. So the card runs `editTable` on the *input* value,
 * memoised on the table and the rules, which is exactly when `evaluate` re-runs anyway.
 */

import { useId, useMemo, useState } from 'react'

import type { ParamValue } from '../../core/node'
import { attributeSchema } from '../../core/types'
import { isTableValue } from '../../core/values'
import type { EditSetter } from '../../nodes/lib/tableEdits'
import { decodeSetters, editPlan, editTable, encodeSetters } from '../../nodes/lib/tableEdits'
import { TextField } from '../params/ParamField'
import type { NodeBodyProps } from './nodeBodies'

const BLANK: EditSetter = { where: '', column: '', value: '' }

export function EditTableBody({ node, ctx, inputValues, setParam }: NodeBodyProps) {
  const stored = useMemo(() => decodeSetters(node.params.edits), [node.params.edits])

  /*
   * Trailing rows that exist on screen and nowhere else. One to begin with on an unconfigured
   * node, because a card whose whole content is an `+ Add` button says less about what this node
   * does than a card showing the shape of one rule.
   *
   * `undefined` until the first interaction, and **derived from the store until then** —
   * deliberately, rather than seeded in `useState`. A card mounts before the graph it belongs to
   * has loaded, so a seeded count is computed against whatever node was there a moment ago and
   * then never revisited: load a graph whose Edit Table has no rules into a session that had one
   * with three, and the card draws **nothing at all** — no rows, no shape, just an Add button.
   * `FindNeuronsBody` records the same trap on the same kind of list.
   */
  const [added, setAdded] = useState<number | undefined>(undefined)
  const blanks = added ?? (stored.length === 0 ? 1 : 0)
  const rows = [...stored, ...Array.from({ length: blanks }, () => BLANK)]

  const connected = Boolean(ctx.inputs.in)
  const schema = attributeSchema(ctx.inputs.in)
  const known = schema !== undefined
  /*
   * One `<datalist>` for the whole card, shared by every row's column field, and memoised on the
   * schema. Per row it would be the column list times the number of rules — a wide pivot names a
   * column per label value, so four rules over a 3,000-column table is 12,000 `<option>` elements
   * re-reconciled on every render.
   */
  const listId = useId()
  const options = useMemo(
    () => (schema?.columns ?? []).map((c) => <option key={c.name} value={c.name} />),
    [schema],
  )

  const commit = (next: readonly EditSetter[]) =>
    setParam('edits', encodeSetters(next) as unknown as ParamValue)

  /** A blank row becomes a stored one the moment any part of it is filled in. */
  const edit = (index: number, patch: Partial<EditSetter>) => {
    if (index < stored.length) {
      commit(stored.map((s, i) => (i === index ? { ...s, ...patch } : s)))
      return
    }
    // Against the *derived* count rather than a functional update on the raw state, which would
    // read `undefined` on the first edit of a freshly-loaded card.
    setAdded(Math.max(0, blanks - 1))
    commit([...stored, { ...BLANK, ...patch }])
  }

  const remove = (index: number) => {
    if (index < stored.length) commit(stored.filter((_, i) => i !== index))
    else setAdded(Math.max(0, blanks - 1))
  }

  /*
   * One analysis, and it is the same one the node's `validate` reads — the badge and this line
   * would otherwise be free to disagree about how many rules are broken, each pinned only
   * against its own implementation.
   *
   * Where a run has produced the input, the plan is *the run's*: `editTable` returns the plan it
   * used, so asking it for one and then building a second beside it would be the same pure
   * computation twice per keystroke. Before then there is no table and the schema alone answers.
   */
  const input = inputValues?.in
  const { plan, changed } = useMemo(() => {
    if (!isTableValue(input)) return { plan: editPlan(schema, stored), changed: undefined }
    const result = editTable(input, stored)
    return { plan: result.plan, changed: result.matched.reduce((sum, n) => sum + n, 0) }
  }, [input, schema, stored])

  const broken = useMemo(
    () => new Set(plan.targets.filter((t) => t.problems.length > 0).map((t) => t.index)),
    [plan],
  )

  return (
    <div className="list-body nodrag">
      <div className="rename-body__rows">
        {rows.map((row, i) => (
          // Keyed by position, which is what the list is: rows carry no identity of their own,
          // and a key built from the contents would remount the field somebody is typing into.
          <div
            className={`edit-body__row${broken.has(i) ? ' edit-body__row--broken' : ''}`}
            key={i}
          >
            <TextField
              label={`Where ${i + 1}`}
              value={row.where}
              placeholder="all rows"
              title={row.where || undefined}
              onChange={(where) => edit(i, { where })}
            />
            <span className="rename-body__arrow" aria-hidden="true">
              →
            </span>
            <TextField
              label={`Column ${i + 1}`}
              value={row.column}
              placeholder="column"
              title={row.column || undefined}
              list={listId}
              onChange={(column) => edit(i, { column })}
            />
            <span className="rename-body__arrow" aria-hidden="true">
              =
            </span>
            <TextField
              label={`Value ${i + 1}`}
              value={row.value}
              placeholder="value"
              title={row.value || undefined}
              onChange={(value) => edit(i, { value })}
            />
            <button
              type="button"
              className="rename-body__remove"
              aria-label={`Remove edit ${i + 1}`}
              title="Remove this edit"
              onClick={() => remove(i)}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <datalist id={listId}>{options}</datalist>

      <button
        type="button"
        className="rename-body__add"
        onClick={() => setAdded(blanks + 1)}
        title="Add another edit"
      >
        + Add
      </button>

      <div
        className={`list-body__foot${plan.targets.length === 0 ? ' list-body__foot--empty' : ''}`}
      >
        {!connected ? (
          <span>Connect a table.</span>
        ) : !known ? (
          // Not run yet against nothing to edit: the sibling cards' split, and it matters because
          // one sends somebody to press Run and the other to fill in a row.
          <span>Columns are not known until this has run.</span>
        ) : (
          <>
            <span>
              {plan.targets.length === 0
                ? 'nothing edited — passing the table through'
                : changed === undefined
                  ? `${plan.targets.length} rule${plan.targets.length === 1 ? '' : 's'}`
                  : `${changed} row${changed === 1 ? '' : 's'} changed`}
            </span>
            {plan.added.length > 0 && (
              <span title={plan.added.join(', ')}>+{plan.added.length} column</span>
            )}
            {broken.size > 0 && (
              <span
                className="list-body__missing"
                title={plan.targets
                  .filter((t) => t.problems.length > 0)
                  .map((t) => `Edit ${t.index + 1}: ${t.problems.join('; ')}`)
                  .join('\n')}
              >
                ⚠ {broken.size} not applied
              </span>
            )}
          </>
        )}
      </div>
    </div>
  )
}
