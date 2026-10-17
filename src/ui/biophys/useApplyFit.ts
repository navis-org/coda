/**
 * Apply to Compartment Model: Fit Model's numbers written into the card its Model socket is wired
 * from, in one undo step — the card's foot and the expanded Fit view both press it.
 *
 * Only a Compartment Model wired straight in: through Select One or another fit, which card the
 * numbers belong to is a guess. Only a result that is current: a cached one outlives a rewire, an
 * edit and a failed re-run, and would be written into a card it was never fitted to. And only once,
 * by comparison rather than by a flag: what Apply would write already being the card's own is what
 * "applied" means, so an undo brings the button back with no bookkeeping. That is asked before
 * currency, since applying edits the fit's own input and so is what makes the fit stale; run it
 * again and it starts where it ended.
 */

import { useMemo } from 'react'

import { edgeInto, nodeLabel } from '../../core/graph'
import { withDefaults } from '../../core/node'
import { isCellModelValue } from '../../core/values'
import { appliedParams } from '../../packs/biophys/fitOps'
import { modelNode } from '../../packs/biophys/model'
import { useGraphStore } from '../../store/graphStore'

/** The button's three facts; undefined before a fit has run. `apply` absent: offered, not pressable. */
export type ApplyFit = {
  readonly title: string
  readonly applied: boolean
  readonly apply?: () => void
}

export function useApplyFit(fitNodeId: string): ApplyFit | undefined {
  const fitted = useGraphStore((s) => s.nodeOutput(fitNodeId, 'model'))
  // The card wired into Model, as the graph holds it: the same object across every edit that does
  // not touch it, so an edit elsewhere re-renders nothing here (invariant 7).
  const source = useGraphStore((s) => {
    const edge = edgeInto(s.graph, fitNodeId, 'model')
    return edge ? s.graph.nodes.find((n) => n.id === edge.source) : undefined
  })
  const current = useGraphStore((s) => s.nodeInfo(fitNodeId).state === 'ok')
  const locked = useGraphStore((s) => s.locked)
  const setParams = useGraphStore((s) => s.setParams)
  const values = useMemo(
    () => (isCellModelValue(fitted) ? appliedParams(fitted) : undefined),
    [fitted],
  )
  if (!values) return undefined
  const target = source?.type === modelNode.type ? source : undefined
  if (!target) {
    return {
      title:
        'Wire Model straight from a Compartment Model to write the fitted numbers into it.',
      applied: false,
    }
  }
  const params = withDefaults(modelNode, target.params)
  if (Object.entries(values).every(([id, v]) => params[id] === v)) {
    return {
      title:
        `${nodeLabel(target)} holds the fitted numbers. Built from them it is cut again for the ` +
        'new membrane, and a channel placed as a total per cell keeps its total, so it can differ ' +
        'a little from the fitted Model.',
      applied: true,
    }
  }
  if (!current) {
    return {
      title: 'The fit’s result is from before its last change: run it again to apply it.',
      applied: false,
    }
  }
  if (locked) return { title: 'Unlock the canvas to change a card.', applied: false }
  return {
    title: `Write the fitted Rm, Cm, Ra, E leak and area factor into ${nodeLabel(target)}, as Custom. One undo step.`,
    applied: false,
    apply: () => setParams(target.id, values),
  }
}
