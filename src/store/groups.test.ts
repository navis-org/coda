/**
 * Group frames at the store and in the document.
 *
 * What is worth pinning here is not that a group can be made — it is the four ways a membership
 * list can quietly stop describing the canvas, each of which draws a frame around cards it does
 * not move, or moves cards it does not draw around:
 *
 *  1. a member deleted, by any of the four routes deletion arrives by;
 *  2. a card grouped twice, so two frames both claim it;
 *  3. a file that arrives naming nodes this build dropped as unknown types;
 *  4. a duplicate that copies half a frame.
 *
 * The drag itself is `moveNodes`, which `ui/nodes/nodeResize.test.tsx` and the canvas already
 * cover; what is asserted about it here is only that a frame moves *every* member as one undo
 * step. The pointer half needs a real browser — jsdom dispatches no pointer sequences.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { addNode, deserializeGraph, emptyGraph, serializeGraph } from '../core/graph'
import { createGroup, groupOf, groupsTouching } from '../core/groups'
import { defaultParams } from '../core/node'
import { requireNodeDef } from '../core/registry'
import { MockSource } from '../data/mock/MockSource'
import { registerSource } from '../data/source'
import '../nodes'
import { clearStorage } from '../test/jsdomStubs'
import { useGraphStore } from './graphStore'

beforeAll(() => {
  registerSource(new MockSource({ latencyMs: 0 }))
})

beforeEach(() => {
  clearStorage()
  useGraphStore.setState({ locked: false })
  useGraphStore.getState().newGraph()
  useGraphStore.getState().loadGraph(threeNodes())
})

const store = () => useGraphStore.getState()
const graph = () => useGraphStore.getState().graph
const groups = () => graph().groups ?? []

function threeNodes() {
  const table = requireNodeDef('core.tableFromUrl')
  const viewer = requireNodeDef('out.table')
  let g = emptyGraph('three')
  g = addNode(g, {
    id: 'a',
    type: table.type,
    position: { x: 0, y: 0 },
    params: defaultParams(table),
  })
  g = addNode(g, {
    id: 'b',
    type: viewer.type,
    position: { x: 300, y: 0 },
    params: defaultParams(viewer),
  })
  g = addNode(g, {
    id: 'c',
    type: viewer.type,
    position: { x: 600, y: 0 },
    params: defaultParams(viewer),
  })
  return {
    ...g,
    edges: [
      { id: 'e1', source: 'a', sourceHandle: 'table', target: 'b', targetHandle: 'table' },
    ],
  }
}

describe('grouping the selection', () => {
  it('frames exactly what was selected, in the graph’s own node order', () => {
    store().setSelection(['c', 'a'])
    const id = store().groupSelection()
    expect(id).toBeDefined()
    expect(groups()).toEqual([{ id, nodeIds: ['a', 'c'] }])
  })

  it('does nothing, and leaves no undo step, with nothing selected', () => {
    const depth = store().past.length
    expect(store().groupSelection()).toBeUndefined()
    expect(groups()).toEqual([])
    expect(store().past.length).toBe(depth)
  })

  /* A frame of one is a labelled box around a card, which is a thing people want. */
  it('takes a single card', () => {
    store().setSelection(['b'])
    expect(store().groupSelection()).toBeDefined()
    expect(groups()[0]?.nodeIds).toEqual(['b'])
  })

  /*
   * The exclusivity rule, and it is a *move* rather than a refusal — see `core/groups.ts`. Two
   * frames both claiming a card is the state that has no honest drawing: whichever one is
   * dragged, the other's box jumps.
   */
  it('moves a card out of the frame it was in rather than refusing', () => {
    store().setSelection(['a', 'b'])
    store().groupSelection()
    store().setSelection(['b', 'c'])
    store().groupSelection()

    expect(groups().length).toBe(2)
    expect(groups()[0]?.nodeIds).toEqual(['a'])
    expect(groups()[1]?.nodeIds).toEqual(['b', 'c'])
    expect(groupOf(graph(), 'b')?.id).toBe(groups()[1]?.id)
  })

  it('drops a frame the move emptied', () => {
    store().setSelection(['a'])
    const first = store().groupSelection()
    store().setSelection(['a', 'b'])
    store().groupSelection()
    expect(groups().length).toBe(1)
    expect(groups().some((g) => g.id === first)).toBe(false)
  })

  it('never re-runs anything — a frame changes nothing a node computes', () => {
    store().setSelection(['a', 'b'])
    const before = store().nodeInfo('b').state
    store().groupSelection()
    expect(store().nodeInfo('b').state).toBe(before)
  })
})

describe('ungrouping', () => {
  it('takes the frame apart and leaves every card exactly where it was', () => {
    store().setSelection(['a', 'b'])
    const id = store().groupSelection()!
    const positions = graph().nodes.map((n) => n.position)
    store().ungroup([id])
    expect(graph().groups).toBeUndefined()
    expect(graph().nodes.map((n) => n.position)).toEqual(positions)
    expect(graph().nodes.length).toBe(3)
  })

  /*
   * What "Ungroup" acts on with one card of six selected. The other reading — "take this card
   * out of its frame" — is a different operation, and is not what the word says.
   */
  it('reaches every frame the selection touches, from one member each', () => {
    store().setSelection(['a'])
    store().groupSelection()
    store().setSelection(['b', 'c'])
    store().groupSelection()

    const touched = groupsTouching(graph(), ['a', 'c'])
    expect(touched.length).toBe(2)
    store().ungroup(touched.map((g) => g.id))
    expect(graph().groups).toBeUndefined()
  })
})

describe('a frame’s title and style', () => {
  it('stores a title and clears it again rather than keeping an empty string', () => {
    store().setSelection(['a'])
    const id = store().groupSelection()!
    store().renameGroup(id, 'Sensory block')
    expect(groups()[0]?.title).toBe('Sensory block')
    store().renameGroup(id, '')
    expect('title' in (groups()[0] ?? {})).toBe(false)
  })

  it('keeps only the choices that are not the default, so a plain frame stores nothing', () => {
    store().setSelection(['a'])
    const id = store().groupSelection()!
    store().styleGroup(id, { color: 'blue', filled: true, dashed: true })
    expect(groups()[0]).toMatchObject({ color: 'blue', filled: true, dashed: true })

    store().styleGroup(id, { color: 'grey', filled: false, dashed: false })
    expect(groups()[0]).toEqual({ id, nodeIds: ['a'] })
  })
})

describe('a frame against the rest of the editor', () => {
  it('drags every member as one undo step, and undoes the whole gesture', () => {
    store().setSelection(['a', 'b'])
    store().groupSelection()
    const before = graph().nodes.map((n) => ({ ...n.position }))

    // What the canvas layer does: a frame per pointer move, then one committing call.
    store().moveNodes(
      [
        { id: 'a', position: { x: 10, y: 10 } },
        { id: 'b', position: { x: 310, y: 10 } },
      ],
      false,
    )
    store().moveNodes(
      [
        { id: 'a', position: { x: 40, y: 40 } },
        { id: 'b', position: { x: 340, y: 40 } },
      ],
      true,
    )
    expect(graph().nodes[0]?.position).toEqual({ x: 40, y: 40 })

    store().undo()
    expect(graph().nodes.map((n) => n.position)).toEqual(before)
  })

  /*
   * Pruning lives in `removeNodes`, so it covers all four routes a deletion arrives by — the
   * menu, the palette, React Flow's Delete key and an assistant plan. A membership naming a node
   * nobody can see is invisible until the frame is dragged and moves fewer cards than it drew
   * around.
   */
  it('forgets a deleted member, and goes when its last one is deleted', () => {
    store().setSelection(['a', 'b'])
    const id = store().groupSelection()!
    store().deleteNodes(['b'])
    expect(groups()).toEqual([{ id, nodeIds: ['a'] }])
    store().deleteNodes(['a'])
    expect(graph().groups).toBeUndefined()
  })

  it('copies a frame only when the whole of it was duplicated', () => {
    store().setSelection(['a', 'b'])
    store().groupSelection()

    store().setSelection(['a'])
    store().duplicateSelection()
    expect(groups().length).toBe(1)

    store().setSelection(['a', 'b'])
    store().duplicateSelection()
    expect(groups().length).toBe(2)
    const clone = groups()[1]!
    expect(clone.nodeIds).toEqual(store().selection)
    expect(clone.id).not.toBe(groups()[0]!.id)
  })
})

describe('a frame in the file', () => {
  it('round trips through save and load with its title and style', () => {
    store().setSelection(['a', 'b'])
    const id = store().groupSelection()!
    store().renameGroup(id, 'Sensory')
    store().styleGroup(id, { color: 'violet', dashed: true })

    const { graph: loaded, warnings } = deserializeGraph(serializeGraph(graph()))
    expect(warnings).toEqual([])
    expect(loaded.groups).toEqual([
      { id, nodeIds: ['a', 'b'], title: 'Sensory', color: 'violet', dashed: true },
    ])
  })

  it('leaves a graph nobody grouped anything in without the key at all', () => {
    expect(JSON.parse(serializeGraph(graph())).groups).toBeUndefined()
  })

  /*
   * A file is lenient in, like everything else `deserializeGraph` reads. The three cases here
   * are the ones that would otherwise draw a frame that lies: a member this build dropped as an
   * unknown node type, a card claimed by two frames, and a colour that is not one of ours —
   * which must never reach a stylesheet. See `GROUP_COLORS`.
   */
  it('drops what it cannot honour: dead members, double claims and unknown colours', () => {
    const file = JSON.stringify({
      version: 1,
      nodes: graph().nodes,
      edges: [],
      groups: [
        { id: 'g1', nodeIds: ['a', 'ghost'], color: 'url(https://evil.example/x)' },
        { id: 'g2', nodeIds: ['a', 'b'] },
        { id: 'g3', nodeIds: ['ghost'] },
        { id: 'g4' },
        'nonsense',
      ],
    })
    const { graph: loaded } = deserializeGraph(file)
    expect(loaded.groups).toEqual([
      { id: 'g1', nodeIds: ['a'] },
      // `a` is already claimed by g1, so g2 keeps only what is left.
      { id: 'g2', nodeIds: ['b'] },
    ])
  })
})

describe('the headless half', () => {
  it('leaves the graph untouched by identity when there is nothing to frame', () => {
    const g = graph()
    expect(createGroup(g, [])).toBe(g)
    expect(createGroup(g, ['nobody'])).toBe(g)
  })
})
