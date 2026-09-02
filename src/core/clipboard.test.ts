/**
 * The clipboard fragment: what a copy takes, and what a paste is willing to read.
 *
 * The half worth pinning is the *reading*, because both of its failure shapes are silent. Text
 * that is not a graph has to leave the paste event alone — a canvas that swallowed a column of
 * neuron ids somebody meant for a field would be refusing a paste nobody aimed at it — and a
 * fragment that *is* a graph has to come through the same lenient repairs a file does, since it
 * may have been written by another build. `readFragment` is `deserializeGraph` for exactly that
 * reason, and these cases are what stops it quietly becoming a second reader.
 *
 * The placement half is here too: a fragment carries absolute positions, so pasting into a graph
 * it did not come from is the case where "where does it land" is a real question.
 */

import { describe, expect, it } from 'vitest'

import '../nodes'
import {
  FRAGMENT_MARKER,
  PASTE_OFFSET,
  fragmentFrom,
  insertFragment,
  readFragment,
} from './clipboard'
import type { CodaGraph, GraphNode } from './graph'
import { addEdge, addNode, emptyGraph, serializeGraph } from './graph'
import { createGroup } from './groups'
import { defaultParams } from './node'
import { requireNodeDef } from './registry'

function node(id: string, type: string, x = 0, y = 0): GraphNode {
  return { id, type, position: { x, y }, params: defaultParams(requireNodeDef(type)) }
}

/** dataset → findNeurons → filter → table, at four known positions. */
function chain(): CodaGraph {
  let g = emptyGraph('test')
  g = addNode(g, node('ds', 'neuron.dataset', 100, 100))
  g = addNode(g, node('find', 'neuron.findNeurons', 300, 100))
  g = addNode(g, node('filter', 'core.filterTable', 500, 100))
  g = addNode(g, node('view', 'out.table', 700, 100))
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'find',
    targetHandle: 'dataset',
  })
  g = addEdge(g, {
    source: 'find',
    sourceHandle: 'neurons',
    target: 'filter',
    targetHandle: 'in',
  })
  g = addEdge(g, { source: 'filter', sourceHandle: 'out', target: 'view', targetHandle: 'in' })
  return g
}

function read(text: string) {
  const result = readFragment(text)
  if (!result) throw new Error('expected the text to read as a fragment')
  return result
}

describe('what a copy takes', () => {
  it('carries the selected nodes and the wires between them, and no others', () => {
    const fragment = read(fragmentFrom(chain(), ['find', 'filter'])!)
    expect(fragment.graph.nodes.map((n) => n.id).sort()).toEqual(['filter', 'find'])
    // The wire into `find` and the one out of `filter` each have one end outside the selection.
    // Copying them would mean a paste silently stealing an input, which is `duplicateSelection`'s
    // rule and this follows it.
    expect(fragment.graph.edges).toHaveLength(1)
    expect(fragment.graph.edges[0]!.source).toBe('find')
  })

  it('copies a frame only when the whole of it was selected', () => {
    let g = chain()
    g = createGroup(g, ['ds', 'find'])
    expect(read(fragmentFrom(g, ['ds', 'find'])!).graph.groups ?? []).toHaveLength(1)
    // Half a frame is a claim about a set nobody selected.
    expect(read(fragmentFrom(g, ['ds', 'filter'])!).graph.groups ?? []).toHaveLength(0)
  })

  it('says nothing at all with nothing selected', () => {
    expect(fragmentFrom(chain(), [])).toBeUndefined()
  })

  it('keeps positions absolute, so the paste decides where it lands', () => {
    const fragment = read(fragmentFrom(chain(), ['find'])!)
    expect(fragment.graph.nodes[0]!.position).toEqual({ x: 300, y: 100 })
  })

  it('marks itself, without the marker being what makes it readable', () => {
    const text = fragmentFrom(chain(), ['find'])!
    expect(JSON.parse(text).coda).toBe(FRAGMENT_MARKER)
  })
})

describe('what a paste is willing to read', () => {
  it('refuses text that is not a graph, so the paste event stays somebody else’s', () => {
    expect(readFragment('720575940622093134\n720575940627708688')).toBeUndefined()
    expect(readFragment('')).toBeUndefined()
    expect(readFragment('{ not json')).toBeUndefined()
    // JSON, an object, and nothing to do with us.
    expect(readFragment('{"nodes": 3}')).toBeUndefined()
  })

  it('refuses a document whose every node this build dropped', () => {
    /*
     * The distinction that matters: this *is* a graph document, and `deserializeGraph` reads it
     * happily — into a graph with nothing in it. A paste of nothing must not also swallow the
     * keystroke, so "nothing survived" reads the same as "not ours" here.
     */
    const foreign = JSON.stringify({
      version: 1,
      nodes: [{ id: 'x', type: 'from.the.future', position: { x: 0, y: 0 }, params: {} }],
      edges: [],
    })
    expect(readFragment(foreign)).toBeUndefined()
  })

  it('reads a whole saved graph, not just a fragment this app wrote', () => {
    // The other half of not requiring the marker: a `.coda.json` somebody was sent pastes in.
    const file = serializeGraph(chain())
    expect(read(file).graph.nodes).toHaveLength(4)
  })

  it('repairs like a file does, rather than a second reader that forgets to', () => {
    const raw = JSON.parse(fragmentFrom(chain(), ['find', 'filter'])!)
    raw.edges[0].targetHandle = 'no-such-port'
    const fragment = read(JSON.stringify(raw))
    expect(fragment.graph.edges).toHaveLength(0)
    expect(fragment.warnings.join(' ')).toMatch(/no input "no-such-port"/)
  })
})

describe('where a paste lands', () => {
  it('re-identifies everything, so a second paste cannot collide with the first', () => {
    const g = chain()
    const fragment = read(fragmentFrom(g, ['find', 'filter'])!)
    const once = insertFragment(g, fragment.graph, { x: 0, y: 0 })
    const twice = insertFragment(once.graph, fragment.graph, { x: 0, y: 0 })
    expect(new Set(twice.graph.nodes.map((n) => n.id)).size).toBe(8)
    expect(once.nodeIds.some((id) => twice.nodeIds.includes(id))).toBe(false)
    // The wire came along, remapped onto the copies rather than left pointing at the originals.
    const pasted = new Set(once.nodeIds)
    const added = once.graph.edges.filter((e) => pasted.has(e.source))
    expect(added).toHaveLength(1)
    expect(pasted.has(added[0]!.target)).toBe(true)
  })

  it('puts the fragment’s top-left corner at the point it was given', () => {
    const g = chain()
    const fragment = read(fragmentFrom(g, ['find', 'filter'])!)
    const { graph, nodeIds } = insertFragment(g, fragment.graph, { x: 1000, y: 40 })
    const placed = nodeIds.map((id) => graph.nodes.find((n) => n.id === id)!.position)
    expect(Math.min(...placed.map((p) => p.x))).toBe(1000)
    expect(Math.min(...placed.map((p) => p.y))).toBe(40)
    // The shape is preserved: the two cards are still 200 apart.
    expect(Math.max(...placed.map((p) => p.x))).toBe(1200)
  })

  it('offsets from where it was copied when there is no point to aim at', () => {
    const g = chain()
    const fragment = read(fragmentFrom(g, ['find'])!)
    const { graph, nodeIds } = insertFragment(g, fragment.graph)
    expect(graph.nodes.find((n) => n.id === nodeIds[0])!.position).toEqual({
      x: 300 + PASTE_OFFSET,
      y: 100 + PASTE_OFFSET,
    })
  })

  it('clones a frame onto the copies rather than adding cards to the original', () => {
    let g = chain()
    g = createGroup(g, ['ds', 'find'])
    const fragment = read(fragmentFrom(g, ['ds', 'find'])!)
    const { graph, nodeIds } = insertFragment(g, fragment.graph, { x: 0, y: 400 })
    expect(graph.groups).toHaveLength(2)
    const original = graph.groups!.find((group) => group.nodeIds.includes('ds'))!
    expect(original.nodeIds).toEqual(['ds', 'find'])
    const clone = graph.groups!.find((group) => group !== original)!
    expect(clone.nodeIds.sort()).toEqual([...nodeIds].sort())
  })
})
