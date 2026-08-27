/**
 * The box a group frame draws.
 *
 * Small arithmetic, and worth pinning for one reason: it is derived from *measurements*, and the
 * measurement path is the one this directory has already been bitten by. Auto-layout shipped
 * once with every card silently taking the 232×120 fallback, which read as a layout bug rather
 * than as a measurement one — a frame that fits none of the cards inside it would read the same
 * way, so the fallback is asserted here rather than assumed.
 */

import { describe, expect, it } from 'vitest'

import type { CodaGraph, GraphNode } from '../core/graph'
import { emptyGraph } from '../core/graph'
import { defaultParams } from '../core/node'
import { requireNodeDef } from '../core/registry'
import '../nodes'
import { FALLBACK_NODE_SIZE } from './elkGraph'
import { GROUP_PADDING, groupBoxes } from './groupBounds'

function node(id: string, x: number, y: number): GraphNode {
  const def = requireNodeDef('core.tableFromUrl')
  return { id, type: def.type, position: { x, y }, params: defaultParams(def) }
}

function graphWith(nodes: GraphNode[], nodeIds: string[]): CodaGraph {
  return {
    ...emptyGraph('groups'),
    nodes,
    groups: [{ id: 'g1', nodeIds }],
  }
}

describe('a group box', () => {
  it('wraps every member with the padding on all four sides', () => {
    const graph = graphWith([node('a', 0, 0), node('b', 400, 200)], ['a', 'b'])
    const measured = new Map([
      ['a', { width: 200, height: 100 }],
      ['b', { width: 300, height: 150 }],
    ])
    const [box] = groupBoxes(graph, measured)
    expect(box).toEqual({
      id: 'g1',
      x: -GROUP_PADDING,
      y: -GROUP_PADDING,
      // Right edge is b's far side (400 + 300); bottom is b's (200 + 150).
      width: 700 + GROUP_PADDING * 2,
      height: 350 + GROUP_PADDING * 2,
    })
  })

  /*
   * The measurement, not the declared size, and the difference is what the frame is judged by:
   * a card's height comes from its param rows, its ports and whether it is collapsed, none of
   * which the document records.
   */
  it('follows what the canvas measured rather than the fallback', () => {
    const graph = graphWith([node('a', 0, 0)], ['a'])
    const fallback = groupBoxes(graph)[0]
    const measured = groupBoxes(graph, new Map([['a', { width: 520, height: 400 }]]))[0]
    expect(fallback?.width).toBe(FALLBACK_NODE_SIZE.width + GROUP_PADDING * 2)
    expect(measured?.width).toBe(520 + GROUP_PADDING * 2)
    expect(measured?.height).toBe(400 + GROUP_PADDING * 2)
  })

  /* A card mounted but not laid out reports 0×0; taking that literally frames a point. */
  it('ignores a zero measurement, as the layout does', () => {
    const graph = graphWith([node('a', 0, 0)], ['a'])
    const box = groupBoxes(graph, new Map([['a', { width: 0, height: 0 }]]))[0]
    expect(box?.width).toBe(FALLBACK_NODE_SIZE.width + GROUP_PADDING * 2)
  })

  it('draws nothing for a frame whose members are all gone', () => {
    const graph = graphWith([node('a', 0, 0)], ['ghost'])
    expect(groupBoxes(graph)).toEqual([])
  })

  it('draws nothing at all for a graph with no frames', () => {
    expect(groupBoxes(emptyGraph('none'))).toEqual([])
  })
})
