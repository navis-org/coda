/**
 * The readout under an Input IDs node: how many neurons, and which of the ids were not found.
 *
 * Same shape and same reasoning as `IdsFromLabelBody`, which is why they share a stylesheet
 * block rather than each having one. The report is **derived from the run**, not reported by it:
 * there is no channel from `evaluate` to the node's badge that survives a result being restored
 * from cache rather than recomputed, so a warning raised at run time would vanish while its
 * result stayed on screen. Deriving it instead is correct after a reload, correct from cache,
 * and has nothing new to keep in step.
 *
 * The one thing it says that its sibling does not: **a miss is only meaningful with a Dataset
 * wired.** Unwired, the node hands back exactly the ids it was given, so every id "matches" by
 * construction and a `0 missing` line would be a fact about nothing.
 */

import { useMemo } from 'react'

import { getNodeDef } from '../../core/registry'
import { isTableValue } from '../../core/values'
import { collectIds, unmatchedIds } from '../../nodes/lib/idList'
import { useGraphStore } from '../../store/graphStore'
import { formatNumber } from '../format'
import { ParamField } from '../params/ParamField'
import type { NodeBodyProps } from './nodeBodies'

/** Past this many, the missing ids are counted rather than listed. */
const MAX_LISTED = 6

/**
 * One shape rather than a union of two, with the refused case supplying zeros.
 *
 * A union would be tidier and does not narrow: `error: string` is not a literal type, so TS
 * does not treat it as a discriminant and every read below needs a cast. Explicit zeros cost
 * nothing and cannot be rendered anyway — the JSX tests `error` before it counts anything.
 */
interface Summary {
  error?: string
  /** IDs collected from the field and the wired column, after dedupe. */
  asked: number
  /** Rows in the result, or undefined before the node has run. */
  rows: number | undefined
  /** Requested IDs the dataset did not return. Always empty with no Dataset wired. */
  missing: string[]
  /** Rows of the wired column that were not usable IDs. */
  dropped: number
}

export function InputIdsBody({ node, ctx, compact, setParam }: NodeBodyProps) {
  const def = getNodeDef(node.type)

  const neurons = useGraphStore((s) => {
    // `runVersion` ties this read to scheduler ticks; `nodeOutput` returns the cached value by
    // reference, so the selector allocates nothing — invariant 7.
    void s.runVersion
    return s.nodeOutput(node.id, 'neurons')
  })
  const wired = useGraphStore((s) => {
    void s.runVersion
    return s.nodeInputs(node.id)['ids']
  })

  const column = ctx.column('column')
  // Whether a Dataset is *connected*, which is what decides whether "not found" means anything.
  const hasDataset = Boolean(ctx.inputs.dataset)

  const summary: Summary = useMemo(() => {
    const collected = collectIds({
      typed: node.params.ids,
      table: isTableValue(wired) ? wired : undefined,
      column,
    })
    if (collected.error) {
      return { error: collected.error, asked: 0, rows: undefined, missing: [], dropped: 0 }
    }
    const asked = collected.ids.length
    const rows = isTableValue(neurons) ? neurons.length : undefined
    const missing = hasDataset
      ? unmatchedIds(collected.ids, isTableValue(neurons) ? neurons : undefined)
      : []
    return { asked, rows, missing, dropped: collected.dropped }
  }, [neurons, wired, column, node.params.ids, hasDataset])

  // The generic card renders every non-advanced param; a body replaces that area outright, so it
  // renders the same set rather than a chosen few — a control a body forgets is reachable only
  // from the inspector, which on screen is indistinguishable from one that was never added.
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

      {summary.error ? (
        /*
         * The same sentence the node's badge carries, because both come from `parseIdList`.
         * Shown here as well rather than left to the badge: the text that caused it is two
         * inches above, so this is where somebody is actually looking.
         */
        <div className="list-body__foot list-body__missing" title={summary.error}>
          ⚠ {summary.error}
        </div>
      ) : summary.asked === 0 ? (
        <div className="list-body__foot list-body__foot--empty">
          No IDs yet — type or paste some.
        </div>
      ) : (
        <div className="list-body__foot">
          <span title="IDs collected from the field and the wired column">
            {formatNumber(summary.asked)} ID{summary.asked === 1 ? '' : 's'}
          </span>
          {summary.rows !== undefined && (
            <span title="Rows in the result">{formatNumber(summary.rows)} neurons</span>
          )}
          {summary.dropped > 0 && (
            <span title="Rows of the wired column that were not usable IDs">
              {formatNumber(summary.dropped)} skipped
            </span>
          )}
          {summary.missing.length > 0 && (
            <span
              className="list-body__missing"
              title={`Not in this dataset: ${summary.missing.join(', ')}`}
            >
              ⚠ not found:{' '}
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
