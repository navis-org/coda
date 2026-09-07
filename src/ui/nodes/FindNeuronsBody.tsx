/**
 * The Find Neurons card: what this node means by a row, over the shared row editor.
 *
 * The rows themselves — the three controls, the blank-row rule, the `(missing)` marker, the
 * `resolveRows` analysis and the foot line's markup — are `FilterRowsEditor`, shared with
 * `Split Neurons`. What is left here is everything that is about *this* node, and it is the half
 * that has been got wrong before.
 *
 * ## The field list is the dataset's, and that is the whole point
 *
 * Options come from `schemasFromType(ctx.inputs.dataset).neurons` — the *discovered* neuron
 * schema, so hemibrain offers `cellBodyFiber`, manc offers `hemilineage`, a FlyWire datastack
 * offers `super_class` and `cell_sub_class`, and CATMAID offers `annotations` and `cableLength`.
 * A field the dataset does not publish cannot be picked, which is what makes the whole class of
 * silently-wrong answers this node used to give unreachable rather than merely caught.
 *
 * ## The foot line says which of two things an empty card means
 *
 * A node with no filters returns **no neurons**, so the line has to say that rather than "every
 * neuron in the dataset" — and it reads `askShape` to decide, not `stored.length`. The two
 * disagree on exactly one card: `In ROI` set with no rows, which queries perfectly well and which
 * a row count would report as empty. One function decides it here and in `evaluate`, which is the
 * rule the `(missing)` marker already follows.
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
 * commit writes one param instead of up to five. What that removed is worth naming, because it
 * was the subtle half: every `setParam` is its own store commit — a full `inferGraph` over the
 * canvas, a `refreshStates` pass and an undo entry — so the conversion had to clear only the
 * legacy params that actually carried something, or a single click cost five of them.
 */

import { useMemo } from 'react'

import { schemasFromType } from '../../nodes/lib/datasetParam'
import { rowsFromParams } from '../../nodes/lib/filterRowParams'
import { askShape } from '../../nodes/lib/findNeuronsRows'
import type { FilterRowsFootState } from './FilterRowsEditor'
import { FilterRowsEditor, FilterRowsFoot, rowCountLabel } from './FilterRowsEditor'
import type { NodeBodyProps } from './nodeBodies'

/**
 * The foot line, one entry per `askShape` answer.
 *
 * A table rather than a chain of ternaries in the JSX, so adding a fourth kind of question is a
 * compile error here rather than a card that silently keeps saying one of the old three. The
 * tint travels with the words — one value, since they are one decision.
 */
const FOOT_STATE: Record<ReturnType<typeof askShape>, (rows: number) => FilterRowsFootState> = {
  nothing: () => ({ label: 'no filters — no neurons', empty: true }),
  regionOnly: () => ({ label: 'region only — every neuron innervating it', empty: false }),
  // The one line both cards say identically, so both read it from one place.
  rows: (n) => ({ label: rowCountLabel(n), empty: false }),
}

export function FindNeuronsBody({ node, ctx, compact, setParam }: NodeBodyProps) {
  /*
   * The rows the node is actually asking for, read exactly as `evaluate` and both emitters read
   * them. Through `rowsFromParams` rather than `decodeRows(node.params.filters)` for that reason
   * alone — six readers of one param is six chances for one of them to grow a condition.
   */
  const stored = useMemo(() => rowsFromParams(node.params), [node.params])

  /*
   * Memoised because the editor's own memos key off it, and `withAnnotations` mints a fresh
   * schema per call where a dataset has an annotation chain — so without this every render misses
   * them all and re-runs `resolveRows`, `new RegExp` and all.
   */
  const connected = Boolean(ctx.inputs.dataset)
  const schema = useMemo(
    () => schemasFromType(ctx.inputs.dataset).neurons,
    [ctx.inputs.dataset],
  )

  /*
   * What kind of question this node is asking, named by the same function `evaluate` reads rather
   * than reconstructed from `stored.length` — those two disagree exactly where `In ROI` is set
   * and no row is, a card the foot line would otherwise tell "no neurons" while the node queried
   * perfectly well. `stored` is handed over so the rows are decoded once for both.
   */
  const shape = useMemo(() => askShape(node.params, stored), [node.params, stored])

  return (
    <FilterRowsEditor
      schema={schema}
      stored={stored}
      setParam={setParam}
      foot={(problems) => (
        <FilterRowsFoot
          compact={compact}
          state={
            connected
              ? FOOT_STATE[shape](stored.length)
              : { label: 'Connect a dataset.', empty: false }
          }
          problems={connected ? problems : []}
          missing="not in this dataset"
        />
      )}
    />
  )
}
