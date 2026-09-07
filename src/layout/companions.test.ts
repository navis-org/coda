/**
 * That a Description card is laid out with its dataset rather than after it.
 *
 * Two halves, and the second is the one that could regress silently. The **pairing rules** are
 * arithmetic and fail loudly. The **reservation** does not: withholding a node from ELK and
 * putting it back afterwards produces a perfectly plausible arrangement whether or not the host's
 * box was grown to cover it, and the only symptom of getting that wrong is a card drawn on top of
 * whatever ELK placed in the gap. So the end-to-end case below runs the real algorithm and asserts
 * that no two cards overlap *at their real sizes* — through `place.ts`' own `overlaps`, so a test
 * claiming "nothing overlaps" cannot come to mean something different from what `dodge` enforces
 * at runtime. It fails with 1 collision if `pinCompanions` stops growing the host.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import type { CodaGraph, GraphEdge, GraphNode } from '../core/graph'
import { addEdge, addNode, emptyGraph } from '../core/graph'
import { defaultParams } from '../core/node'
import { getNodeDef, requireNodeDef } from '../core/registry'
import { MockSource } from '../data/mock/MockSource'
import { registerSource } from '../data/source'
import '../nodes'

import type { LayoutNode, MeasuredSizes, NodeSize } from './elkGraph'
import { arrangeScope, resolveSize } from './elkGraph'
import { companionView, expandCompanions, pinCompanions } from './companions'
import { runLayout } from './engine'
import { DEFAULT_LAYOUT_OPTIONS } from './options'
import type { XY } from './place'
import { overlaps } from './place'

beforeAll(() => {
  registerSource(new MockSource({ latencyMs: 0 }))
})

const HOST = 'dataset.hemibrain'
const COMPANION = 'dataset.description'

/** What the definition actually asks for, so a changed offset moves the tests rather than break. */
const SPEC = getNodeDef(HOST)?.companion

function node(id: string, type: string, x = 0, y = 0): GraphNode {
  return { id, type, position: { x, y }, params: defaultParams(requireNodeDef(type)) }
}

function link(
  source: string,
  sourceHandle: string,
  target: string,
  targetHandle: string,
): GraphEdge {
  return { id: `${source}>${target}`, source, sourceHandle, target, targetHandle }
}

/** A dataset and its Description, wired exactly the way `addNodeWithCompanion` wires them. */
function pair(): { nodes: LayoutNode[]; edges: GraphEdge[] } {
  return {
    nodes: [node('ds', HOST), node('desc', COMPANION)],
    edges: [link('ds', 'dataset', 'desc', 'dataset')],
  }
}

function sized(entries: Record<string, NodeSize>): MeasuredSizes {
  return new Map(Object.entries(entries))
}

describe('the companion spec this is all about', () => {
  it('is declared on the dataset node, below it, at a non-negative offset', () => {
    /*
     * Every expectation below is written against these, so a spec that moved would otherwise make
     * the suite assert the old placement while the app draws the new one. The non-negative check
     * is the one that is a *rule* rather than a reading: `companionView` declines to pin a spec
     * placing its companion above or left of its host, so a node pack writing one would get
     * silently no pinning and nothing to say why. See the module note.
     */
    expect(SPEC?.type).toBe(COMPANION)
    expect(SPEC?.from).toBe('dataset')
    expect(SPEC?.to).toBe('dataset')
    expect(SPEC!.offset.x).toBeGreaterThanOrEqual(0)
    expect(SPEC!.offset.y).toBeGreaterThan(0)
  })
})

describe('companionView', () => {
  it('pairs a card wired the way its host’s definition declares', () => {
    const { nodes, edges } = pair()
    expect(companionView(nodes, edges)).toEqual([
      { host: 'ds', companion: 'desc', offset: { ...SPEC!.offset }, box: expect.anything() },
    ])
  })

  it('reserves a box covering both cards, anchored at the host’s corner', () => {
    const { nodes, edges } = pair()
    const measured = sized({
      ds: { width: 248, height: 247 },
      desc: { width: 248, height: 125 },
    })
    expect(companionView(nodes, edges, measured)[0]!.box).toEqual({
      width: Math.max(248, SPEC!.offset.x + 248),
      height: SPEC!.offset.y + 125,
    })
  })

  it('keeps the host’s own size where the companion fits inside it', () => {
    const { nodes, edges } = pair()
    // A host taller than the offset plus the companion — the box must not shrink to the pair.
    const measured = sized({
      ds: { width: 900, height: SPEC!.offset.y + 400 },
      desc: { width: 248, height: 125 },
    })
    expect(companionView(nodes, edges, measured)[0]!.box).toEqual({
      width: 900,
      height: SPEC!.offset.y + 400,
    })
  })

  it('ignores a card of the right type on the wrong port', () => {
    const nodes = [node('ds', HOST), node('desc', COMPANION)]
    // `dataset.description` declares one input; a wire to a port it does not have is what a
    // hand-edited file can carry, and is not the companion relationship.
    expect(companionView(nodes, [link('ds', 'dataset', 'desc', 'somethingElse')])).toEqual([])
  })

  it('ignores a card of the wrong type on the right port', () => {
    const nodes = [node('ds', HOST), node('other', 'out.table')]
    expect(companionView(nodes, [link('ds', 'dataset', 'other', 'in')])).toEqual([])
  })

  it('leaves a companion carrying any other wire in the layout', () => {
    /*
     * The rule that stops this deleting a dependency. A Description has no outputs, so this
     * cannot happen today — but a companion type that grew one would have its edge silently
     * dropped from the layout, and the arrangement would satisfy a constraint set missing a wire
     * that is drawn on the canvas.
     */
    const nodes = [node('ds', HOST), node('desc', COMPANION), node('table', 'out.table')]
    const edges = [link('ds', 'dataset', 'desc', 'dataset'), link('desc', 'out', 'table', 'in')]
    expect(companionView(nodes, edges)).toEqual([])
  })

  it('pins only the first of two companions on one host', () => {
    const nodes = [node('ds', HOST), node('a', COMPANION), node('b', COMPANION)]
    const edges = [link('ds', 'dataset', 'a', 'dataset'), link('ds', 'dataset', 'b', 'dataset')]
    // The second would be drawn on top of the first at the same offset, which is worse than
    // wherever ELK would have put it.
    expect(companionView(nodes, edges).map((p) => p.companion)).toEqual(['a'])
  })

  it('pins a card fed by two hosts under neither', () => {
    /*
     * Settled by the same rule that keeps a companion's other wires visible, rather than by a
     * tie-break: pinning it under the first dataset would take the second wire out of the layout
     * while looking like a placement decision.
     */
    const nodes = [node('ds', HOST), node('ds2', HOST), node('desc', COMPANION)]
    const edges = [
      link('ds', 'dataset', 'desc', 'dataset'),
      link('ds2', 'dataset', 'desc', 'dataset'),
    ]
    expect(companionView(nodes, edges)).toEqual([])
  })
})

describe('pinCompanions', () => {
  it('takes the companion and its one wire out, and grows the host to hold it', () => {
    const { nodes, edges } = pair()
    const measured = sized({
      ds: { width: 248, height: 247 },
      desc: { width: 248, height: 125 },
    })
    const out = pinCompanions(nodes, edges, companionView(nodes, edges, measured), measured)
    expect(out.nodes.map((n) => n.id)).toEqual(['ds'])
    expect(out.edges).toEqual([])
    // Asserted on `sizes` rather than on the pair it came from, because `sizes` is what reaches
    // ELK — the box is an intermediate and could stop being read without this noticing.
    expect(out.sizes.get('ds')).toEqual({ width: 248, height: SPEC!.offset.y + 125 })
    expect(out.sizes.has('desc')).toBe(false)
  })

  it('hands back every node at its own size when nothing was pinned', () => {
    const nodes = [node('find', 'neuron.findNeurons'), node('table', 'out.table')]
    const edges = [link('find', 'neurons', 'table', 'in')]
    const measured = sized({ find: { width: 360, height: 185 } })
    const out = pinCompanions(nodes, edges, companionView(nodes, edges), measured)
    expect(out.nodes).toEqual(nodes)
    expect(out.edges).toEqual(edges)
    expect(out.sizes.get('find')).toEqual({ width: 360, height: 185 })
  })

  it('does not write into the map it was handed', () => {
    /*
     * `measured` is what `structureKey` is computed from. Grown in place, the key would follow
     * the pinning rather than the cards, so every arrange would change it and auto mode would
     * re-arrange its own arrangement — a loop, not a wasted pass.
     */
    const { nodes, edges } = pair()
    const measured = sized({
      ds: { width: 248, height: 247 },
      desc: { width: 248, height: 125 },
    })
    pinCompanions(nodes, edges, companionView(nodes, edges, measured), measured)
    expect(measured.get('ds')).toEqual({ width: 248, height: 247 })
  })
})

describe('expandCompanions', () => {
  it('puts the companion at its host’s position plus the declared offset', () => {
    const { nodes, edges } = pair()
    const placed = expandCompanions(
      new Map([['ds', { x: 500, y: 200 }]]),
      companionView(nodes, edges),
    )
    expect(placed.get('desc')).toEqual({ x: 500 + SPEC!.offset.x, y: 200 + SPEC!.offset.y })
  })

  it('snaps rather than preserving where the card was', () => {
    /*
     * The deliberate inversion of `expandPositions`' rule. A folded group's members keep the
     * arrangement their author left, because folding is a way of telling the layout to leave that
     * part alone; a companion is placed by its host's definition, so an arrange puts it back
     * there whatever the document said.
     */
    const nodes = [node('ds', HOST), node('desc', COMPANION, 9999, -4000)]
    const edges = [link('ds', 'dataset', 'desc', 'dataset')]
    const placed = expandCompanions(
      new Map([['ds', { x: 0, y: 0 }]]),
      companionView(nodes, edges),
    )
    expect(placed.get('desc')).toEqual({ ...SPEC!.offset })
  })

  it('leaves a companion alone when its host was not placed', () => {
    const { nodes, edges } = pair()
    expect(expandCompanions(new Map(), companionView(nodes, edges)).has('desc')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Against ELK itself
// ---------------------------------------------------------------------------

/** Two datasets, each with a Description, meeting at a comparison — the wizard's cross shape. */
function comparison(): CodaGraph {
  let graph = emptyGraph('comparison')
  for (const [ds, desc, find] of [
    ['ds', 'desc', 'find'],
    ['ds2', 'desc2', 'find2'],
  ]) {
    graph = addNode(graph, node(ds!, HOST))
    graph = addNode(graph, node(desc!, COMPANION))
    graph = addNode(graph, node(find!, 'neuron.findNeurons'))
    graph = addEdge(graph, {
      source: ds!,
      sourceHandle: 'dataset',
      target: desc!,
      targetHandle: 'dataset',
    })
    graph = addEdge(graph, {
      source: ds!,
      sourceHandle: 'dataset',
      target: find!,
      targetHandle: 'dataset',
    })
  }
  graph = addNode(graph, node('table', 'out.table'))
  for (const find of ['find', 'find2']) {
    graph = addEdge(graph, {
      source: find,
      sourceHandle: 'neurons',
      target: 'table',
      targetHandle: 'in',
    })
  }
  return graph
}

/** The sizes a browser really reports for these cards, so the reservation is checked at scale. */
const REAL_SIZES: MeasuredSizes = new Map([
  ['ds', { width: 248, height: 291 }],
  ['ds2', { width: 248, height: 291 }],
  ['desc', { width: 248, height: 125 }],
  ['desc2', { width: 248, height: 125 }],
  ['find', { width: 360, height: 185 }],
  ['find2', { width: 360, height: 185 }],
  ['table', { width: 232, height: 177 }],
])

describe('a real arrange', () => {
  const graph = comparison()
  let placed: ReadonlyMap<string, XY>

  // One ELK run behind the three assertions: same fixture, same options, same answer.
  beforeAll(async () => {
    const scope = arrangeScope(graph, [])
    const pairs = companionView(scope.nodes, scope.edges, REAL_SIZES)
    const { nodes, edges, sizes } = pinCompanions(scope.nodes, scope.edges, pairs, REAL_SIZES)
    const { positions } = await runLayout(nodes, edges, DEFAULT_LAYOUT_OPTIONS, sizes)
    placed = expandCompanions(positions, pairs)
  })

  it('puts every Description directly under the dataset it is wired to', () => {
    for (const [ds, desc] of [
      ['ds', 'desc'],
      ['ds2', 'desc2'],
    ]) {
      const host = placed.get(ds!)!
      expect(placed.get(desc!)).toEqual({
        x: host.x + SPEC!.offset.x,
        y: host.y + SPEC!.offset.y,
      })
    }
  })

  it('reserves the space, so nothing is drawn under a Description', () => {
    const rects = graph.nodes.map((n) => ({
      id: n.id,
      ...placed.get(n.id)!,
      ...resolveSize(n, REAL_SIZES),
    }))
    const clashes: string[] = []
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        if (overlaps(rects[i]!, rects[j]!)) clashes.push(`${rects[i]!.id} × ${rects[j]!.id}`)
      }
    }
    expect(clashes).toEqual([])
  })

  it('does not spend a layer on the Description', () => {
    /*
     * The point of the whole thing. Left as an ordinary node it lands in the layer *after* its
     * dataset, competing with `find` for the column and adding a row to it — measured in a
     * browser at x = −540 beside `find` with its dataset at x = −884.
     */
    const columns = new Set([...placed.values()].map((p) => Math.round(p.x)))
    // Dataset, Find Neurons, Table. A Description in the flow makes it four.
    expect(columns.size).toBe(3)
    expect(Math.round(placed.get('desc')!.x)).toBe(Math.round(placed.get('ds')!.x))
  })
})
