/**
 * Fit Model's Apply button, and the card's foot control that is that button beside the line saying
 * how the fit ended (`describeValue` of the fitted model). Nothing before a fit has run.
 */

import type { NodeFooterProps } from '../nodes/nodeBodies'
import { useApplyFit } from './useApplyFit'

/** Apply to Compartment Model, wherever it is drawn; "Applied" once the card holds the fit. */
export function ApplyFitButton({
  nodeId,
  className,
  label,
}: {
  nodeId: string
  className: string
  label: string
}) {
  const fit = useApplyFit(nodeId)
  if (!fit) return null
  return (
    <button
      type="button"
      className={`${className} nodrag`}
      title={fit.title}
      disabled={!fit.apply}
      onClick={(event) => {
        // On a card, a click is also a selection; the button is not one.
        event.stopPropagation()
        fit.apply?.()
      }}
    >
      {fit.applied ? 'Applied' : label}
    </button>
  )
}

export function FitFooter({ node }: NodeFooterProps) {
  return (
    <ApplyFitButton
      nodeId={node.id}
      className="coda-node__cache coda-node__cache--action"
      label="Apply"
    />
  )
}
