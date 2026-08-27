/**
 * The dashed outline around what a `For Each` re-runs.
 *
 * A loop's region is derived from the wires — everything reachable from the loop node that is
 * not past a `Collect` — which makes it invisible in exactly the way that matters: you cannot
 * tell by looking whether the Download you just added is inside the loop or after it, and the
 * two do completely different things. So it is drawn.
 *
 * ## Everything `GroupLayer` had to be careful about, this one sidesteps
 *
 * That layer's header records three hazards of drawing into `ViewportPortal`: the portal is the
 * viewport's last child so a frame paints over every card; the viewport is `pointer-events:
 * none` and anything grabbable has to switch it back on; and panning is d3-zoom's native
 * listener, which `stopPropagation` cannot reach. Only the first applies here — `z-index: -1`
 * puts the frame under the cards and the wires — because **this frame takes no pointer at all**.
 * It is a fact about the graph rather than a handle on it: the membership comes from the wires,
 * so there is nothing to drag and nothing to rename, and `pointer-events: none` on the whole
 * layer means panning, box-select and clicking a card inside it are untouched.
 *
 * ## Dashed, and labelled with the count
 *
 * Dashed rather than solid because a group frame is already solid, and the two are genuinely
 * different kinds of thing — one is a decision somebody made about layout, the other is a
 * consequence of how the wires run. The label says how many passes, from the same edit-time
 * count the card shows, because "runs 412 times" beside the box is the thing that makes an
 * accidentally-enclosed node obvious.
 */

import { ViewportPortal } from '@xyflow/react'
import { useMemo } from 'react'

import type { MeasuredSizes } from '../layout/elkGraph'
import { loopBoxes } from '../layout/groupBounds'
import { isIterableValue } from '../nodes/lib/iterables'
import { loopPlanOf } from '../nodes/flow/plan'
import { useGraphStore } from '../store/graphStore'
import { formatNumber } from './format'

export interface LoopLayerProps {
  /** What React Flow last measured for each card. Without it every box fits the fallback size. */
  measured: MeasuredSizes
}

export function LoopLayer({ measured }: LoopLayerProps) {
  const graph = useGraphStore((s) => s.graph)
  // Subscribes to scheduler ticks so the caption follows a run — the count is read off the wire,
  // which is empty until something has produced it.
  const runVersion = useGraphStore((s) => s.runVersion)
  // The resolved input types, so the caption resolves `groupBy` exactly as the node will.
  const inference = useGraphStore((s) => s.inference)

  const boxes = useMemo(() => loopBoxes(graph, measured), [graph, measured])

  /*
   * Keyed on the *value* rather than on `runVersion`, which is the difference between recomputing
   * this once and recomputing it several hundred times per loop. `runVersion` bumps on every
   * scheduler tick; `nodeInputs` hands the value back by reference, so a memo over it recomputes
   * only when the collection genuinely changes — and nothing upstream of a loop's begin node
   * re-runs while the loop is going, so the caption cannot move during one anyway.
   */
  const values = useMemo(() => {
    void runVersion
    const { nodeInputs } = useGraphStore.getState()
    return boxes.map((box) => nodeInputs(box.id)['in'])
  }, [boxes, runVersion])

  const captions = useMemo(() => {
    const nodes = new Map(graph.nodes.map((n) => [n.id, n]))
    return boxes.map((box, i) => {
      const node = nodes.get(box.id)
      const inner = box.region.size - 1
      const nodesSaid = `${formatNumber(inner)} node${inner === 1 ? '' : 's'}`
      if (!node) return ''
      /*
       * The same plan the card makes and the node will make — see `nodes/flow/plan.ts`. This was
       * a third copy that read `node.params.groupBy` raw where the other two resolved it, so a
       * picker on its declared default made the frame say `0` beside a card saying `412`.
       */
      const total = loopPlanOf(node, values[i], inference.nodes[box.id]?.inputs).count
      // Before a run there is no collection to count, and saying "0 passes" would be a claim
      // about the data rather than about the graph. The node count is knowable either way.
      return isIterableValue(values[i])
        ? `for each · ${formatNumber(total)} × ${nodesSaid}`
        : `for each · ${nodesSaid}`
    })
  }, [boxes, graph, values, inference])

  if (boxes.length === 0) return null

  return (
    <ViewportPortal>
      <div className="loop-layer">
        {boxes.map((box, i) => (
          <div
            key={box.id}
            className="loop-frame"
            style={{
              transform: `translate(${box.x}px, ${box.y}px)`,
              width: box.width,
              height: box.height,
            }}
          >
            {/*
              The caption sits *inside* the top edge rather than above it, so a loop frame at the
              top of a group cannot push its label through the group's own title.
            */}
            <span className="loop-frame__label">{captions[i]}</span>
          </div>
        ))}
      </div>
    </ViewportPortal>
  )
}
