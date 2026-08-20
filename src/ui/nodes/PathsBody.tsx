/**
 * The one-line readout under a Paths node: how many routes, how short, how strong.
 *
 * The two numbers people actually want from a path query are the **shortest route** and the
 * **strongest one's bottleneck**, and neither is legible from a network of a few dozen nodes —
 * you would have to trace it by eye. They are derivable from the `Paths` output, so this is a
 * reading of a result the node already publishes rather than a fourth port.
 *
 * A body rather than an entry in `describeValue`, for two reasons: the footer summary is keyed
 * to the *first* output (the network, where "24 nodes · 31 links" is the right thing to say),
 * and a body can say "not run yet" in its own words instead of borrowing the state text.
 */

import { useMemo } from 'react'

import { useGraphStore } from '../../store/graphStore'
import { isTableValue } from '../../core/values'
import { PATH_ARROW } from '../../nodes/lib/pathOps'
import type { NodeBodyProps } from './nodeBodies'

interface Summary {
  count: number
  minHops: number
  bottleneck: number
  /** The strongest route, written out. Shown only when there is room for it. */
  best: string
}

export function PathsBody({ node, compact }: NodeBodyProps) {
  const paths = useGraphStore((s) => {
    // runVersion is what ties this read to scheduler ticks; `nodeOutput` returns the cached
    // value by reference, so this selector allocates nothing — invariant 7.
    void s.runVersion
    return s.nodeOutput(node.id, 'paths')
  })

  const summary: Summary | undefined = useMemo(() => {
    if (!isTableValue(paths) || paths.length === 0) return undefined
    const hops = paths.data['hops'] ?? []
    const bottleneck = paths.data['bottleneck'] ?? []
    let minHops = Infinity
    let best = 0
    for (let i = 0; i < paths.length; i++) {
      const h = Number(hops[i])
      if (Number.isFinite(h) && h < minHops) minHops = h
      const b = Number(bottleneck[i])
      if (Number.isFinite(b) && b > best) best = b
    }
    // Rows are ranked strongest-first, so the first one is the route the bottleneck belongs to.
    const first = paths.data['path']?.[0]
    return {
      count: paths.length,
      minHops: Number.isFinite(minHops) ? minHops : 0,
      bottleneck: best,
      best: first === null || first === undefined ? '' : String(first),
    }
  }, [paths])

  if (!summary) {
    return (
      <div className="paths-body paths-body--empty">
        {isTableValue(paths)
          ? 'No route found — raise Max hops or lower Min synapses.'
          : 'Not run yet.'}
      </div>
    )
  }

  return (
    <div className="paths-body">
      <div className="paths-body__stats">
        <span title="How many routes survived the N strongest ranking">
          {summary.count.toLocaleString()} route{summary.count === 1 ? '' : 's'}
        </span>
        <span title="Fewest synapses between a source and a target">
          min {summary.minHops} hop{summary.minHops === 1 ? '' : 's'}
        </span>
        <span title="The weakest link on the strongest route — what actually limits it">
          {summary.bottleneck.toLocaleString()} syn bottleneck
        </span>
      </div>
      {!compact && summary.best && (
        <div className="paths-body__best" title={`Strongest route${PATH_ARROW}by bottleneck`}>
          {summary.best}
        </div>
      )}
    </div>
  )
}
