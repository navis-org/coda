/**
 * The Rename Columns card: one row per remapping, and a button that adds another.
 *
 * The only node here whose configuration is a *list somebody grows*, which is why it needs a
 * body at all — the generic param band draws one widget per declared param, and the number of
 * renames is not known when the definition is written. It is stored the way `out.table` stores
 * its filter clauses, as an opaque `string[]` of JSON pairs (`renames.ts`), and this is the one
 * place that writes them.
 *
 * **The column picker follows `ParamField`'s three-state rule rather than reimplementing it**,
 * and shares its widgets to do so: unknown is not missing. A port publishes no schema before
 * its first run — `Table from URL` keeps one per URL in a session-scoped map, so a fresh
 * session has none — and that is precisely the node this one sits behind, so drawing `(missing)`
 * or a disabled select there would be wrong on the commonest chain it has.
 *
 * **A blank row is component state, never a param.** `encodeRenames` drops an entry with both
 * halves empty, so pressing Add cannot write one — and that is the right way round: a row that
 * renames nothing has no business in the provenance key, where it would mark the node stale and
 * everything downstream with it for a control that has not been used yet. What the store holds
 * is what the run will do.
 */

import { useMemo, useState } from 'react'

import { attributeSchema } from '../../core/types'
import type { ParamValue } from '../../core/node'
import type { Rename } from '../../nodes/lib/renames'
import { decodeRenames, encodeRenames } from '../../nodes/lib/renames'
import { renamePlan } from '../../nodes/lib/tableOps'
import { SelectField, TextField, UNKNOWN_HINT } from '../params/ParamField'
import type { NodeBodyProps } from './nodeBodies'

const BLANK: Rename = { from: '', to: '' }

export function RenameBody({ node, ctx, setParam }: NodeBodyProps) {
  const stored = useMemo(() => decodeRenames(node.params.renames), [node.params.renames])

  /*
   * Trailing rows that exist on screen and nowhere else. One to begin with on an unconfigured
   * node, because a card whose whole content is an `+ Add` button says less about what this node
   * does than a card showing the shape of one rename.
   *
   * `undefined` until the first interaction, and **derived from the store until then** —
   * deliberately, rather than seeded in `useState`. A card mounts before the graph it belongs to
   * has loaded, so a seeded count is computed against whatever node was there a moment ago and
   * then never revisited: load a graph whose Rename has no rows into a session that had one with
   * three, and the card draws **nothing at all**. `FindNeuronsBody` records the same trap on the
   * same kind of list, and `EditTableBody` is the third.
   */
  const [added, setAdded] = useState<number | undefined>(undefined)
  const blanks = added ?? (stored.length === 0 ? 1 : 0)
  const rows = [...stored, ...Array.from({ length: blanks }, () => BLANK)]

  const connected = Boolean(ctx.inputs.in)
  const schema = attributeSchema(ctx.inputs.in)
  const known = schema !== undefined
  const columns = useMemo(() => schema?.columns.map((c) => c.name) ?? [], [schema])

  const commit = (next: readonly Rename[]) =>
    setParam('renames', encodeRenames(next) as unknown as ParamValue)

  /** A blank row becomes a stored one the moment either half of it is filled in. */
  const edit = (index: number, patch: Partial<Rename>) => {
    if (index < stored.length) {
      commit(stored.map((r, i) => (i === index ? { ...r, ...patch } : r)))
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
   * The same analysis the node's `validate` reads, rather than a second expression answering
   * the same question — the badge and this line would otherwise be free to disagree about how
   * many renames are broken, with each pinned only against its own implementation.
   */
  const plan = useMemo(() => renamePlan(schema, stored), [schema, stored])

  return (
    <div className="list-body nodrag">
      <div className="rename-body__rows">
        {rows.map((row, i) => (
          // Keyed by position, which is what the list is: rows carry no identity of their own,
          // and a key built from the names would remount the field somebody is typing into.
          <div className="rename-body__row" key={i}>
            <SelectField
              label={`Column ${i + 1}`}
              value={row.from}
              /*
               * The full value on hover, because a 130px select truncates. `cellBodyFiber
               * (missing)` clips to `cellBodyFiber (missi` — measured in a browser — and a
               * marker cut mid-word is worse than none. The badge and the foot line both name
               * the column too, so nothing rests on this; it is the closest of the three.
               */
              title={known ? row.from || undefined : UNKNOWN_HINT}
              options={[
                /*
                 * The placeholder is what keeps this picker out of `SelectField`'s no-options
                 * branch, which renders *disabled* — the failure `columnField.test.tsx` records,
                 * reached here by the commonest chain this node has, since `Table from URL`
                 * publishes no schema on a fresh session. It doubles as the way back to unset,
                 * so a row can be cleared without being removed. A stored value outside the list
                 * is surfaced by `SelectField` itself, so unknown needs no branch of its own.
                 */
                { value: '', label: 'column…' },
                // Drift, and only where the schema is known enough to say so: unknown is not
                // missing, and labelling a perfectly good column that way sends somebody to fix
                // a row that is already right.
                ...(known && row.from && !columns.includes(row.from)
                  ? [{ value: row.from, label: `${row.from} (missing)` }]
                  : []),
                ...columns.map((c) => ({ value: c, label: c })),
              ]}
              onChange={(from) => edit(i, { from })}
            />
            <span className="rename-body__arrow" aria-hidden="true">
              →
            </span>
            <TextField
              label={`New name ${i + 1}`}
              value={row.to}
              placeholder="new name"
              onChange={(to) => edit(i, { to })}
            />
            <button
              type="button"
              className="rename-body__remove"
              aria-label={`Remove rename ${i + 1}`}
              title="Remove this rename"
              onClick={() => remove(i)}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <button
        type="button"
        className="rename-body__add"
        onClick={() => setAdded(blanks + 1)}
        title="Add another rename"
      >
        + Add
      </button>

      <div
        className={`list-body__foot${plan.applied.size === 0 ? ' list-body__foot--empty' : ''}`}
      >
        {!connected ? (
          <span>Connect a table.</span>
        ) : !known ? (
          // Not run yet against nothing to rename: the sibling cards' split, and the reason it
          // matters is that one sends somebody to press Run and the other to fill in a row.
          <span>Columns are not known until this has run.</span>
        ) : (
          <>
            <span>
              {plan.applied.size === 0 ? 'nothing renamed' : `${plan.applied.size} renamed`}
              {plan.applied.size === 0 && stored.length === 0
                ? ' — passing the table through'
                : ''}
            </span>
            {plan.missing.length > 0 && (
              <span className="list-body__missing" title={plan.missing.join(', ')}>
                ⚠ {plan.missing.length} not in the table
              </span>
            )}
          </>
        )}
      </div>
    </div>
  )
}
