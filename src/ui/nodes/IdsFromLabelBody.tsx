/**
 * The readout under an IDs from Label node: how many neurons, and which labels found none.
 *
 * A body rather than a run-time warning, and that is the whole design of the feature. There is
 * no channel from `evaluate` to the node's ⚠ badge — `validate` runs at edit time with types and
 * no values — so a warning would have meant a new one, carried on the run state *and* on the
 * cache entry, or it would vanish the moment a result was restored rather than recomputed. The
 * miss is derivable from what the node already publishes, so it is derived: correct after a
 * reload, correct from cache, and correct without anything new to keep in step.
 *
 * The cost is that it says nothing until the node has run, which is why the positive half is
 * shown too. "1,204 neurons · 18/20 labels" is worth reading on a good run; a line that appears
 * only when something is wrong is a line nobody learns to look at.
 */

import { useMemo } from 'react'

import { getNodeDef } from '../../core/registry'
import { isTableValue } from '../../core/values'
import { collectLabels, unmatchedLabels } from '../../nodes/lib/labelLookup'
import { useGraphStore } from '../../store/graphStore'
import { formatNumber } from '../format'
import { ParamField } from '../params/ParamField'
import type { NodeBodyProps } from './nodeBodies'

/** Past this many, the missing labels are summarised rather than listed. */
const MAX_LISTED = 6

export function IdsFromLabelBody({ node, ctx, compact, setParam }: NodeBodyProps) {
  const def = getNodeDef(node.type)

  const neurons = useGraphStore((s) => {
    // `runVersion` is what ties this read to scheduler ticks; `nodeOutput` returns the cached
    // value by reference, so the selector allocates nothing — invariant 7.
    void s.runVersion
    return s.nodeOutput(node.id, 'neurons')
  })
  const inputs = useGraphStore((s) => {
    void s.runVersion
    return s.nodeInputs(node.id)['labels']
  })

  const field = ctx.column('field')
  const column = ctx.column('column')

  const summary = useMemo(() => {
    if (!isTableValue(neurons)) return undefined
    const labels = collectLabels({
      typed: node.params.labels,
      table: isTableValue(inputs) ? inputs : undefined,
      column,
    })
    const missing = unmatchedLabels(labels, neurons, field, {
      regex: node.params.match === 'regex',
      ignoreCase: Boolean(node.params.ignoreCase),
    })
    return { count: neurons.length, asked: labels.length, missing }
  }, [
    neurons,
    inputs,
    column,
    field,
    node.params.labels,
    node.params.match,
    node.params.ignoreCase,
  ])

  // The generic card renders every non-advanced param; a body replaces that whole area, so it
  // renders the same set rather than a chosen one — a control that exists only in the inspector
  // because a body forgot it is indistinguishable from one that was never added.
  const fields = (def?.params ?? []).filter(
    (p) => !p.advanced && (!p.visibleIf || p.visibleIf(node.params)),
  )

  return (
    <div className="list-body nodrag">
      <div className="list-body__fields">
        {fields.map((param) => (
          <label key={param.id} className="list-body__field">
            <span className="param__label" title={param.help ?? param.label}>
              {param.label}
            </span>
            <ParamField
              param={param}
              value={node.params[param.id]}
              ctx={ctx}
              onChange={(value) => setParam(param.id, value)}
            />
          </label>
        ))}
      </div>

      {!summary ? (
        <div className="list-body__foot list-body__foot--empty">Not run yet.</div>
      ) : summary.asked === 0 ? (
        <div className="list-body__foot list-body__foot--empty">
          No labels yet — type some, or wire a table.
        </div>
      ) : (
        <div className="list-body__foot">
          <span title="Neurons carrying one of the labels">
            {formatNumber(summary.count)} neuron{summary.count === 1 ? '' : 's'}
          </span>
          <span title="Labels that matched at least one neuron, of the labels asked for">
            {formatNumber(summary.asked - summary.missing.length)}/{formatNumber(summary.asked)}{' '}
            label{summary.asked === 1 ? '' : 's'}
          </span>
          {summary.missing.length > 0 && (
            <span
              className="list-body__missing"
              title={`No neuron carries: ${summary.missing.join(', ')}`}
            >
              ⚠ no match:{' '}
              {compact && summary.missing.length > MAX_LISTED
                ? `${summary.missing.slice(0, MAX_LISTED).join(', ')} +${summary.missing.length - MAX_LISTED}`
                : summary.missing.join(', ')}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
