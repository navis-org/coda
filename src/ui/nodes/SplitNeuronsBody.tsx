/**
 * The Split Neurons card: the shared row editor, over the attribute table the wire carries.
 *
 * The rows, the `resolveRows` analysis and the foot line's markup are all `FilterRowsEditor`'s —
 * this is the second caller it was extracted for. What is left here is exactly what this node
 * differs on:
 *
 *  - **the fields are the collection's attributes**, `ctx.attributes('in')` rather than
 *    `ctx.schema('in')`, because a skeleton or mesh collection carries its table beside the
 *    geometry rather than being one. That is the same schema `validate` and `evaluate` read;
 *  - **an empty card means "nothing matches"** rather than "no neurons", and the foot has to say
 *    which port ends up empty — the one thing somebody cannot see from the outputs of an unrun
 *    card;
 * A wrong kind — a neuron table, a synapse cloud — is deliberately **not** drawn here.
 * `wrongKindReason` is what `validate` returns, and `inferGraph` turns every `validate` string
 * into an issue the card already renders under the body, so saying it in the foot as well prints
 * one refusal twice. Find Neurons draws the same line: the foot summarises what the card is
 * asking, the issue states what is wrong with it.
 *
 * The row count is `stored.length`, not `askShape`'s three-way answer: this node has no second
 * kind of question to ask — no region, no limit — so a count says everything there is.
 */

import { useMemo } from 'react'

import { rowsFromParams } from '../../nodes/lib/filterRowParams'
import { matchesNothing } from '../../nodes/lib/splitRows'
import { FilterRowsEditor, FilterRowsFoot, rowCountLabel } from './FilterRowsEditor'
import type { NodeBodyProps } from './nodeBodies'

export function SplitNeuronsBody({ node, ctx, compact, setParam }: NodeBodyProps) {
  /* Read exactly as `evaluate` and both emitters read them — one decode, one meaning. */
  const stored = useMemo(() => rowsFromParams(node.params), [node.params])

  /*
   * A property read, not a computation: `ctx.attributes` is `attributeSchema(inputs[port])`.
   * Find Neurons memoises its own because `withAnnotations` mints a fresh schema per call; there
   * is nothing here to memoise, and a `useMemo` keyed on `ctx` would miss on every graph
   * mutation anyway.
   */
  const connected = Boolean(ctx.inputs.in)
  const schema = ctx.attributes('in')
  const nothing = matchesNothing(stored)

  return (
    <FilterRowsEditor
      schema={schema}
      stored={stored}
      setParam={setParam}
      foot={(problems) => (
        <FilterRowsFoot
          compact={compact}
          /* `matchesNothing` is the predicate `evaluate` and the emitter read, not a second
             reading of the same rows. */
          state={
            !connected
              ? { label: 'Connect skeletons or meshes.', empty: false }
              : nothing
                ? { label: 'no filters — nothing matches', empty: true }
                : { label: rowCountLabel(stored.length), empty: false }
          }
          problems={connected ? problems : []}
          missing="not on these neurons"
        />
      )}
    />
  )
}
