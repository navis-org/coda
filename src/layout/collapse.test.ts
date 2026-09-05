/**
 * Folding a group into one box: what is drawn instead of the members, and what the layout is
 * handed instead of them.
 *
 * Everything here is arithmetic over the document, so it needs no DOM — which is the point of
 * `layout/collapse.ts` being where it is. What is pinned is the half that is silent when it is
 * wrong: a wire whose visible end is on the wrong card, a wire drawn twice because the merge key
 * did not include its port, an internal wire drawn at all, and an arrangement that moves the box
 * without moving what is inside it.
 *
 * The pointer half — grabbing the box, dragging it — is `ui/groupDrag.ts` and is not testable
 * here for `GroupLayer`'s reason: jsdom dispatches no real pointer sequences.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { addNode, emptyGraph } from '../core/graph'
import type { CodaGraph } from '../core/graph'
import { defaultParams } from '../core/node'
import { requireNodeDef } from '../core/registry'
import { MockSource } from '../data/mock/MockSource'
import { registerSource } from '../data/source'
import '../nodes'
import {
  COLLAPSED_IN,
  COLLAPSED_OUT,
  COLLAPSED_SIZE,
  NO_COLLAPSE,
  boxSize,
  collapsedNodeId,
  collapsedView,
  condense,
  expandPositions,
  isFolded,
} from './collapse'
import { GROUP_PADDING } from './groupBounds'
import { layoutPorts, resolveSize } from './elkGraph'

beforeAll(() => {
  registerSource(new MockSource({ latencyMs: 0 }))
})

/**
 * a → b → c → d, in a row, with `b` and `c` framed.
 *
 * A chain rather than a star because the interesting wires are the two that *cross* the frame,
 * and a chain has exactly one of each.
 */
function chain(): CodaGraph {
  const table = requireNodeDef('core.tableFromUrl')
  const filter = requireNodeDef('core.filterTable')
  const viewer = requireNodeDef('out.table')
  let g = emptyGraph('chain')
  const at = (id: string, def: typeof table, x: number, y = 0) =>
    addNode(g, { id, type: def.type, position: { x, y }, params: defaultParams(def) })
  g = at('a', table, 0)
  g = at('b', filter, 300)
  g = at('c', filter, 600, 100)
  g = at('d', viewer, 900)
  return {
    ...g,
    edges: [
      { id: 'ab', source: 'a', sourceHandle: 'out', target: 'b', targetHandle: 'in' },
      { id: 'bc', source: 'b', sourceHandle: 'out', target: 'c', targetHandle: 'in' },
      { id: 'cd', source: 'c', sourceHandle: 'out', target: 'd', targetHandle: 'in' },
    ],
    groups: [{ id: 'g1', nodeIds: ['b', 'c'], collapsed: true }],
  }
}

const boxId = collapsedNodeId('g1')

describe('the view a folded group presents', () => {
  it('is the shared empty answer, by identity, when nothing is folded', () => {
    const g = chain()
    expect(collapsedView({ ...g, groups: [{ id: 'g1', nodeIds: ['b', 'c'] }] })).toBe(
      NO_COLLAPSE,
    )
    expect(collapsedView({ ...g, groups: undefined })).toBe(NO_COLLAPSE)
  })

  it('hides every member and stands one box in their place', () => {
    const view = collapsedView(chain())
    expect([...view.hidden].sort()).toEqual(['b', 'c'])
    expect(view.boxes.map((b) => b.id)).toEqual([boxId])
    expect(view.boxes[0]!.members.map((m) => m.id)).toEqual(['b', 'c'])
  })

  /*
   * The box sits at the frame's own top-left corner, padding included, so folding puts a card
   * where the outline already was rather than somewhere new. Asserted against the members' raw
   * positions rather than against `groupBox`, so it cannot pass by agreeing with the same
   * arithmetic twice.
   */
  it('is placed at the corner the outline was drawn at', () => {
    const [box] = collapsedView(chain()).boxes
    expect(box!.position).toEqual({ x: 300 - GROUP_PADDING, y: 0 - GROUP_PADDING })
  })

  it('carries every member as a rectangle, for the mini-map', () => {
    const g = chain()
    const view = collapsedView(g)
    const b = g.nodes.find((n) => n.id === 'b')!
    expect(view.boxes[0]!.members).toEqual([
      { id: 'b', type: b.type, x: 300, y: 0, ...resolveSize(b) },
      {
        id: 'c',
        type: g.nodes.find((n) => n.id === 'c')!.type,
        x: 600,
        y: 100,
        ...resolveSize(g.nodes.find((n) => n.id === 'c')!),
      },
    ])
  })

  /*
   * The one caller with a better answer than the document's: while an arrange animation is
   * gliding, cards are drawn from the animation. A box read off the store would stand still and
   * jump at the end of the pass.
   */
  it('follows an animation’s positions when it is given them', () => {
    const view = collapsedView(chain(), undefined, new Map([['b', { x: 50, y: 40 }]]))
    expect(view.boxes[0]!.position).toEqual({ x: 50 - GROUP_PADDING, y: 40 - GROUP_PADDING })
  })

  it('draws no box for a frame naming nothing on the canvas', () => {
    const g = chain()
    expect(
      collapsedView({ ...g, groups: [{ id: 'g9', nodeIds: ['ghost'], collapsed: true }] }),
    ).toBe(NO_COLLAPSE)
  })
})

describe('the wires a folded group is left with', () => {
  it('re-ends a crossing wire on the box, one socket a side', () => {
    const view = collapsedView(chain())
    const into = view.edges.find((e) => e.target === boxId)!
    const out = view.edges.find((e) => e.source === boxId)!
    expect([into.source, into.sourceHandle, into.targetHandle]).toEqual([
      'a',
      'out',
      COLLAPSED_IN,
    ])
    expect([out.target, out.targetHandle, out.sourceHandle]).toEqual(['d', 'in', COLLAPSED_OUT])
    expect(into.origins).toEqual([{ nodeId: 'a', portId: 'out' }])
  })

  /*
   * Withheld is derived from the two ends rather than carried as a set of edge ids — one answer
   * to "is this wire folded away", which `isFolded` is.
   */
  it('draws nothing for a wire with both ends inside one box', () => {
    const g = chain()
    const view = collapsedView(g)
    expect(g.edges.filter((e) => isFolded(view, e)).map((e) => e.id)).toEqual([
      'ab',
      'bc',
      'cd',
    ])
    // The internal wire is the one with no stand-in: two crossings, two merged edges.
    expect(view.edges.length).toBe(2)
    expect(view.edges.every((e) => e.source === boxId || e.target === boxId)).toBe(true)
  })

  /*
   * The reason merging exists at all: two cards inside one box, each wired from the same socket
   * outside it, are one line on screen — and keeping both real edges would stack N hit targets
   * under it, any of which deletes a wire into a card nobody can see.
   */
  it('merges wires that share both visible ends, and keeps the ones that do not', () => {
    const g = chain()
    const view = collapsedView({
      ...g,
      edges: [
        ...g.edges,
        { id: 'ac', source: 'a', sourceHandle: 'out', target: 'c', targetHandle: 'in' },
      ],
    })
    const into = view.edges.filter((e) => e.target === boxId)
    expect(into.length).toBe(1)
    expect(into[0]!.origins.map((o) => o.nodeId)).toEqual(['a', 'a'])
    expect(view.edges.length).toBe(2)
  })

  it('keeps a wire between two different boxes', () => {
    const g = chain()
    const view = collapsedView({
      ...g,
      groups: [
        { id: 'g1', nodeIds: ['b'], collapsed: true },
        { id: 'g2', nodeIds: ['c'], collapsed: true },
      ],
    })
    const between = view.edges.find((e) => e.source === collapsedNodeId('g1'))!
    expect([between.source, between.target]).toEqual([
      collapsedNodeId('g1'),
      collapsedNodeId('g2'),
    ])
  })
})

describe('the controls a folded group carries', () => {
  /** The chain, with one of `b`'s params promoted onto the frame. */
  function withExposed(param: string) {
    const g = chain()
    return {
      ...g,
      groups: [
        { id: 'g1', nodeIds: ['b', 'c'], collapsed: true, exposed: [{ node: 'b', param }] },
      ],
    }
  }

  const paramOf = (graph: CodaGraph, id: string) =>
    requireNodeDef(graph.nodes.find((n) => n.id === id)!.type).params![0]!.id

  it('resolves a promoted param to its card and its definition', () => {
    const g = chain()
    const param = paramOf(g, 'b')
    const [box] = collapsedView(withExposed(param)).boxes
    expect(box!.exposed.map((e) => [e.node.id, e.param.id])).toEqual([['b', param]])
  })

  /*
   * The box's height is what the canvas draws *and* what ELK is told, so a row the size did not
   * account for is a row drawn over the mini-map — and a control the layout reserved no space
   * for. One call decides both.
   */
  it('grows the box by exactly the rows it will draw', () => {
    const g = chain()
    const bare = collapsedView(g).boxes[0]!
    const withOne = collapsedView(withExposed(paramOf(g, 'b'))).boxes[0]!
    expect(bare.size).toEqual(COLLAPSED_SIZE)
    expect(withOne.size).toEqual(boxSize(1))
    expect(withOne.size.height).toBeGreaterThan(bare.size.height)
    expect(withOne.size.width).toBeGreaterThan(bare.size.width)
  })

  /*
   * The third way an entry stops being drawable, and the reason this filter is here rather than
   * in `validGroups`: `visibleIf` is a function of the node's *current* params, so it answers
   * differently a keystroke later and a file is not where it can be settled. `filterTable`'s
   * `value` is switched off by an operator that needs no value.
   */
  it('drops a param the node’s own values have switched off, and puts it back', () => {
    const g = withExposed('value')
    const withValue = collapsedView(g)
    expect(withValue.boxes[0]!.exposed.map((e) => e.param.id)).toEqual(['value'])

    const noValue = collapsedView({
      ...g,
      nodes: g.nodes.map((n) =>
        n.id === 'b' ? { ...n, params: { ...n.params, op: 'isEmpty' } } : n,
      ),
    })
    expect(noValue.boxes[0]!.exposed).toEqual([])
    expect(noValue.boxes[0]!.size).toEqual(COLLAPSED_SIZE)
  })

  it('drops an entry naming a card or a param that is not there', () => {
    const g = chain()
    const view = collapsedView({
      ...g,
      groups: [
        {
          id: 'g1',
          nodeIds: ['b', 'c'],
          collapsed: true,
          exposed: [
            { node: 'ghost', param: paramOf(g, 'b') },
            { node: 'b', param: 'nosuchparam' },
          ],
        },
      ],
    })
    expect(view.boxes[0]!.exposed).toEqual([])
    expect(view.boxes[0]!.size).toEqual(COLLAPSED_SIZE)
  })
})

describe('what the layout pass is handed', () => {
  it('replaces the members with one box, keeping the graph around it', () => {
    const g = chain()
    const view = collapsedView(g)
    const { nodes, edges } = condense(g.nodes, g.edges, view)
    expect(nodes.map((n) => n.id)).toEqual(['a', boxId, 'd'])
    expect(edges.map((e) => e.id).filter((id) => id === 'bc')).toEqual([])
    expect(edges.length).toBe(2)
  })

  /*
   * ELK rejects a graph whose edge names a port its node does not declare — not a degraded
   * layout, a failed one. The pseudo card is registered nowhere, so the ordinary registry lookup
   * answers "no ports" and this is the one place that knows better.
   */
  it('gives the box the two sockets its wires arrive at', () => {
    const [box] = collapsedView(chain()).boxes
    expect(layoutPorts(box!)).toEqual({
      inputs: [{ id: COLLAPSED_IN }],
      outputs: [{ id: COLLAPSED_OUT }],
    })
  })

  it('leaves an uncollapsed graph’s nodes and edges alone', () => {
    const g = { ...chain(), groups: [] }
    const { nodes, edges } = condense(g.nodes, g.edges, collapsedView(g))
    expect(nodes.map((n) => n.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(edges.length).toBe(3)
  })

  /*
   * A box's move is its members' move. Getting this wrong is the silent failure the whole
   * condensation exists to avoid: an arrangement that places the box and leaves the cards, so
   * unfolding shows them where they were and the box somewhere else.
   */
  it('moves every member by the delta the box was given', () => {
    const g = chain()
    const view = collapsedView(g)
    const box = view.boxes[0]!
    const arranged = new Map([
      ['a', { x: 0, y: 0 }],
      [box.id, { x: box.position.x + 40, y: box.position.y - 10 }],
    ])
    expect(expandPositions(arranged, view)).toEqual(
      new Map([
        ['a', { x: 0, y: 0 }],
        ['b', { x: 340, y: -10 }],
        ['c', { x: 640, y: 90 }],
      ]),
    )
  })
})
