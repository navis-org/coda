/**
 * The arrange a canvas runs, headless, and what it leaves drawn.
 *
 * The same `condenseForArrange` / ELK / `expandArranged` sequence `useArrange` calls, with every
 * position written back — shared because two suites ran it by hand, each with its own all-pairs
 * overlap loop.
 */

import type { CodaGraph } from '../core/graph'
import { collapsedView } from '../layout/collapse'
import { condenseForArrange, expandArranged } from '../layout/companions'
import type { MeasuredSizes } from '../layout/elkGraph'
import { arrangeScope, resolveSize } from '../layout/elkGraph'
import { runLayout } from '../layout/engine'
import { DEFAULT_LAYOUT_OPTIONS } from '../layout/options'
import type { Rect } from '../layout/place'
import { overlaps } from '../layout/place'

export type NamedRect = Rect & { id: string }

export interface Arranged {
  graph: CodaGraph
  /** What is drawn: every card not folded away, at its size, and every folded box. */
  rects: NamedRect[]
  /** Every pair of those that overlaps, as `a × b` — through `place.ts`' own `overlaps`. */
  overlapping: string[]
}

/** Every overlapping pair among these rectangles, named. */
export function overlappingPairs(rects: readonly NamedRect[]): string[] {
  const pairs: string[] = []
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (overlaps(rects[i]!, rects[j]!)) pairs.push(`${rects[i]!.id} × ${rects[j]!.id}`)
    }
  }
  return pairs
}

export async function arrangeHeadless(
  graph: CodaGraph,
  measured?: MeasuredSizes,
): Promise<Arranged> {
  const input = condenseForArrange(graph, arrangeScope(graph, []), measured)
  const { positions } = await runLayout(
    input.nodes,
    input.edges,
    DEFAULT_LAYOUT_OPTIONS,
    input.sizes,
  )
  const final = expandArranged(positions, input)
  const arranged = {
    ...graph,
    nodes: graph.nodes.map((n) => {
      const at = final.get(n.id)
      return at ? { ...n, position: at } : n
    }),
  }
  const view = collapsedView(arranged)
  const rects: NamedRect[] = [
    ...arranged.nodes
      .filter((n) => !view.hidden.has(n.id))
      .map((n) => ({ id: n.id, ...n.position, ...resolveSize(n, measured) })),
    ...view.boxes.map((box) => ({ id: box.id, ...box.position, ...box.size })),
  ]
  return { graph: arranged, rects, overlapping: overlappingPairs(rects) }
}
