/**
 * The Paths card: the settings that decide the search, then a readout of what it found.
 *
 * The readout is the reason this is a body at all. The two numbers people actually want from a
 * path query are the **shortest route** and the **strongest one's bottleneck**, and neither is
 * legible from a network of a few dozen nodes — you would have to trace it by eye. They are
 * derivable from the `Paths` output, so this is a reading of a result the node already
 * publishes rather than a fourth port. A body rather than an entry in `describeValue`, for two
 * reasons: the footer summary is keyed to the *first* output (the network, where "24 nodes · 31
 * links" is the right thing to say), and a body can say "not run yet" in its own words instead
 * of borrowing the state text.
 *
 * The fields are here because **a body replaces the generic param band outright**. That is the
 * trap this card sat in: `Max hops`, `Min synapses`, `N strongest` and `Collapse types` are the
 * whole of what a path query is, none of them is `advanced`, and yet the only way to reach one
 * was the inspector — which on screen is indistinguishable from a node that has no settings.
 * The normalisation set is `visibleIf`-hidden rather than trimmed, so the card is five rows
 * until somebody turns Normalize on and nine after.
 * Worse here than on most cards, because the empty readout *names two of them* ("raise Max hops
 * or lower Min synapses") and there was nothing on the card to raise. So the body renders the
 * same set the band would, in declaration order, and the caption sits underneath the controls
 * it is a caption for.
 */

import { useMemo } from 'react'

import { getNodeDef } from '../../core/registry'
import { useGraphStore } from '../../store/graphStore'
import { isTableValue } from '../../core/values'
import { PATH_ARROW } from '../../nodes/lib/pathOps'
import { readNormalizeBy } from '../../nodes/lib/connectivityOps'
import { formatNumber, formatShare, plural } from '../format'
import { ParamField } from '../params/ParamField'
import type { NodeBodyProps } from './nodeBodies'

interface Summary {
  count: number
  minHops: number
  bottleneck: number
  /**
   * The best bottleneck as a fraction, where the run published one.
   *
   * A separate maximum rather than the fraction of the route `bottleneck` came from, which is
   * `pathStats`' split and its reason: under `Rank by: fraction` the strongest route in synapses
   * and the strongest as a share are routinely not the same route.
   */
  bottleneckNorm?: number
  /** The strongest route, written out. Shown only when there is room for it. */
  best: string
}

export function PathsBody({ node, ctx, compact, setParam }: NodeBodyProps) {
  const def = getNodeDef(node.type)
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
    // Present only on a normalised run — the column is the switch, exactly as it is downstream.
    const normalised = paths.data['bottleneckNorm']
    let minHops = Infinity
    let best = 0
    let bestNorm: number | undefined
    for (let i = 0; i < paths.length; i++) {
      const h = Number(hops[i])
      if (Number.isFinite(h) && h < minHops) minHops = h
      const b = Number(bottleneck[i])
      if (Number.isFinite(b) && b > best) best = b
      const cell = normalised?.[i]
      if (cell === null || cell === undefined) continue
      const n = Number(cell)
      if (Number.isFinite(n) && (bestNorm === undefined || n > bestNorm)) bestNorm = n
    }
    // Rows are ranked strongest-first, so the first one is the route the bottleneck belongs to.
    const first = paths.data['path']?.[0]
    return {
      count: paths.length,
      minHops: Number.isFinite(minHops) ? minHops : 0,
      bottleneck: best,
      ...(bestNorm === undefined ? {} : { bottleneckNorm: bestNorm }),
      best: first === null || first === undefined ? '' : String(first),
    }
  }, [paths])

  /** Which end of a connection the fractions are a share of. One reading, two renderings. */
  const sharedEnd =
    readNormalizeBy(node.params.normalizeBy) === 'presynaptic' ? 'output' : 'input'

  // The same set the generic band draws, and in the same order — a control a body forgets is
  // reachable only from the inspector, which on screen looks like one that was never added.
  const fields = (def?.params ?? []).filter(
    (p) => !p.advanced && (!p.visibleIf || p.visibleIf(node.params)),
  )

  return (
    <div className="list-body paths-body nodrag">
      <div className="list-body__fields">
        {fields.map((param) => (
          <label key={param.id} className="list-body__field">
            <span className="param__label" title={param.help ?? param.label}>
              {param.label}
            </span>
            {/*
              `inspector`, for Select One's reason: it suppresses a checkbox's own label, and
              the row already carries one. `Collapse types` is the boolean here, and a card
              saying it twice — once in the label column and once beside the box — reads as two
              settings. The generic card solves the same collision the other way, in CSS
              (`.param--wide .param__label { display: none }`), which is the wrong half to
              borrow: these fields share a label column, and the boolean would be the one row
              not lining up with the three number fields above it.
            */}
            <ParamField
              param={param}
              value={node.params[param.id]}
              ctx={ctx}
              variant="inspector"
              onChange={(value) => setParam(param.id, value)}
            />
          </label>
        ))}
      </div>

      {!summary ? (
        <div className="list-body__foot list-body__foot--empty">
          {isTableValue(paths)
            ? 'No route found — raise Max hops or lower Min synapses.'
            : 'Not run yet.'}
        </div>
      ) : (
        <>
          <div className="list-body__foot">
            <span title="How many routes survived the N strongest ranking">
              {plural(summary.count, 'route')}
            </span>
            <span title="Fewest synapses between a source and a target">
              min {plural(summary.minHops, 'hop')}
            </span>
            <span title="The weakest link on the strongest route — what actually limits it">
              {formatNumber(summary.bottleneck)} syn bottleneck
            </span>
            {summary.bottleneckNorm !== undefined && (
              /*
               * Said as its own number rather than replacing the synapse one, because the run
               * publishes both and they belong to different routes as soon as the ranking is by
               * fraction. Which end the share is *of* is the node's `Normalize by`, read through
               * the same decoder the run uses rather than compared against a raw string here.
               */
              <span
                title={`The largest share of one group's total ${sharedEnd} carried by any route's weakest step`}
              >
                {formatShare(summary.bottleneckNorm)} of {sharedEnd}
              </span>
            )}
          </div>
          {!compact && summary.best && (
            <div
              className="paths-body__best"
              title={`Strongest route${PATH_ARROW}by bottleneck`}
            >
              {summary.best}
            </div>
          )}
        </>
      )}
    </div>
  )
}
