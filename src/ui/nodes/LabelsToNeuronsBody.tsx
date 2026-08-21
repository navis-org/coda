/**
 * The readout under `Selected to Neurons` and `Clusters to Neurons`.
 *
 * One component for both, exactly as one operation serves both nodes. Same shape and same
 * reasoning as `IdsFromLabelBody` and `InputIdsBody`, which is why the three share a stylesheet
 * block rather than each having one.
 *
 * **It exists for one silent failure.** A label matches on a column somebody chose, and the
 * wrong choice — `neuronId` where the tree was labelled by `type` — produces an empty table with
 * every count in the footer correct and nothing anywhere pointing at the cause. Saying `0 of 4
 * labels matched` next to the `Match on` picker turns a dead end into a control to change.
 *
 * **Derived from the run, not reported by it**, on the standing reason: there is no channel
 * from `evaluate` to a node's badge that survives a result being restored from cache rather
 * than recomputed, so a warning raised at run time would vanish while its result stayed on
 * screen. Everything below is recomputed from the node's own inputs and output.
 */

import { useMemo } from 'react'

import { getNodeDef } from '../../core/registry'
import { isTableValue } from '../../core/values'
import { labelCoverage } from '../../nodes/lib/labelsToNeurons'
import { useGraphStore } from '../../store/graphStore'
import { formatNumber } from '../format'
import { ParamField } from '../params/ParamField'
import type { LabelMatchResult } from '../../nodes/lib/labelsToNeurons'
import type { NodeBodyProps } from './nodeBodies'

/** The op's own counts, plus the one fact only the run can supply. */
type Summary = Omit<LabelMatchResult, 'neurons'> & {
  /** Rows in the result, or undefined before the node has run. */
  rows: number | undefined
}

export function LabelsToNeuronsBody({ node, ctx, compact, setParam }: NodeBodyProps) {
  const def = getNodeDef(node.type)

  const result = useGraphStore((s) => {
    // `runVersion` ties this read to scheduler ticks; `nodeOutput` returns the cached value by
    // reference, so the selector allocates nothing — invariant 7.
    void s.runVersion
    return s.nodeOutput(node.id, 'neurons')
  })
  /*
   * Two selectors rather than one over `nodeInputs(node.id)`, which looks like the wasteful
   * shape and is the only correct one: that record is rebuilt per call, so a selector returning
   * it changes identity on every store tick and `useSyncExternalStore` loops. Invariant 7 —
   * select a value, never the container. Both siblings do the same.
   */
  const labels = useGraphStore((s) => {
    void s.runVersion
    return s.nodeInputs(node.id)['labels']
  })
  const neurons = useGraphStore((s) => {
    void s.runVersion
    return s.nodeInputs(node.id)['neurons']
  })

  const labelColumn = ctx.column('labelColumn')
  const matchColumn = ctx.column('matchColumn')

  const summary: Summary | undefined = useMemo(() => {
    if (!isTableValue(labels) || !labelColumn) return undefined
    try {
      /*
       * The counting half of the real op, never the whole of it. Sharing the function is what
       * stops the number under the card disagreeing with the rows leaving the port; taking only
       * the counting half is what stops a render rebuilding a 165,000-row join to print three
       * integers.
       */
      const run = labelCoverage({
        labels,
        labelColumn,
        neurons: isTableValue(neurons) ? neurons : undefined,
        matchColumn,
      })
      return { ...run, rows: isTableValue(result) ? result.length : undefined }
    } catch {
      // A column the input does not have. `evaluate` fails loudly naming it, and the badge
      // carries that — this line has nothing to add and should not guess.
      return undefined
    }
  }, [labels, neurons, labelColumn, matchColumn, result])

  // The generic card renders every non-advanced param; a body replaces that area outright, so
  // it renders the same set rather than a chosen few — a control a body forgets is reachable
  // only from the inspector, which on screen is indistinguishable from one never added.
  const fields = (def?.params ?? []).filter(
    (p) => !p.advanced && (!p.visibleIf || p.visibleIf(node.params)),
  )

  const missed = summary ? summary.asked - summary.matched : 0

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
        // Not wired, or not run. Said as "nothing to match yet" rather than as a zero, because
        // a count of nothing reads as a claim that nothing matched.
        <div className="list-body__foot list-body__foot--empty">
          {ctx.inputs.labels ? 'Not run yet.' : 'Connect a Selected or Clusters table.'}
        </div>
      ) : (
        <div className="list-body__foot">
          <span title="Distinct labels on the input">
            {formatNumber(summary.asked)} label{summary.asked === 1 ? '' : 's'}
          </span>
          {summary.rows !== undefined && (
            <span title="Rows in the result">{formatNumber(summary.rows)} neurons</span>
          )}
          {summary.dropped > 0 && (
            <span title="Label rows that were not usable neuron ids — wire the neuron table that was clustered">
              {formatNumber(summary.dropped)} not an ID
            </span>
          )}
          {missed > 0 && (
            <span
              className="list-body__missing"
              title={
                compact
                  ? `${missed} label(s) named no neuron. Check "Match on" — it has to be the column NBLAST used for "Label by".`
                  : undefined
              }
            >
              ⚠ {formatNumber(missed)} matched nothing
            </span>
          )}
        </div>
      )}
    </div>
  )
}
