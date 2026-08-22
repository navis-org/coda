/**
 * Dropping an unconnected node onto a wire.
 *
 * Every decision is here; the geometry that finds the wire is in `ui/spliceHit.ts` and cannot be
 * tested — jsdom performs no layout, so a path has no length and no points.
 *
 * Three things carry the risk, and none is visible from the signature. **Only an isolated node
 * splices**, because a drag across a busy canvas passes over many wires and a node already wired
 * is one somebody is rearranging. **The downstream link is judged with the upstream one already
 * applied**, or the obvious case is refused. And **the old link goes before the new ones**, or
 * `addEdge`'s eviction drops the wrong one.
 */

import { describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph } from './graph'
import type { CodaGraph, GraphNode } from './graph'
import { inferGraph } from './inference'
import { T } from './types'
import { defaultParams } from './node'
import { registerNode, requireNodeDef } from './registry'
import { spliceCandidate, spliceGraph } from './splice'
import '../nodes'

/*
 * A dataset in, a dataset out — what a "pin the materialization" node would be. Nothing in the
 * registry has that shape today, which is exactly why the reference guard needs one built: with
 * no such node the refusal it is asserting happens for an unrelated reason (a Dataset does not
 * fit a table port) and the test passes whether or not the guard exists.
 */
registerNode({
  type: 'test.splice.passthrough',
  label: 'passthrough',
  category: 'transform',
  cost: 'cheap',
  inputs: [{ id: 'in', label: 'In', type: T.dataset() }],
  outputs: [{ id: 'out', label: 'Out', type: T.dataset() }],
  inferOutputs: (ctx) => ({ out: ctx.inputs.in ?? T.dataset() }),
  evaluate: (ctx) => ({ out: ctx.input('in')! }),
})

function node(id: string, type: string, params: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    params: { ...defaultParams(requireNodeDef(type)), ...params } as GraphNode['params'],
  }
}

/** `Find Neurons → Skeletons`, plus whatever loose node the test is dropping on it. */
function chain(loose: string): { graph: CodaGraph; edgeId: string } {
  let g = emptyGraph('splice-test')
  g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
  g = addNode(g, node('find', 'neuron.findNeurons', { typePattern: 'LC.*' }))
  g = addNode(g, node('skel', 'neuron.skeletons'))
  g = addNode(g, node('loose', loose))
  g = addEdge(g, { source: 'ds', sourceHandle: 'dataset', target: 'find', targetHandle: 'dataset' })
  // Skeletons needs the dataset too, or the graph carries an unrelated error and the
  // inference-clean assertion below would be about the fixture rather than about the splice.
  g = addEdge(g, { source: 'ds', sourceHandle: 'dataset', target: 'skel', targetHandle: 'dataset' })
  g = addEdge(g, {
    source: 'find',
    sourceHandle: 'neurons',
    target: 'skel',
    targetHandle: 'neurons',
  })
  return { graph: g, edgeId: g.edges[g.edges.length - 1]!.id }
}

const candidate = (g: CodaGraph, edgeId: string, nodeId = 'loose') =>
  spliceCandidate(g, inferGraph(g), nodeId, g.edges.find((e) => e.id === edgeId)!)

describe('what can be spliced', () => {
  it('takes a node whose output only becomes compatible once its input is wired', () => {
    /*
     * The case the whole design turns on. `core.filter` isolated publishes `T.table()`, and a
     * Skeletons input wants `T.neurons()` — so judging both links against the *current*
     * inference refuses a Filter dropped on `Find Neurons → Skeletons`, which is about the most
     * obvious thing anybody would try. Applying the upstream link first is what makes the filter
     * publish `neurons`, which is what it will actually publish.
     */
    const { graph, edgeId } = chain('core.filter')
    expect(candidate(graph, edgeId)).toEqual({ inPort: 'in', outPort: 'out' })
  })

  it('refuses a node that genuinely does not fit', () => {
    // A Dataset node has no input a neuron table could land on.
    const { graph, edgeId } = chain('neuron.dataset')
    expect(candidate(graph, edgeId)).toBeUndefined()
  })

  it('refuses a node that is already wired to something', () => {
    /*
     * Not tidiness. A drag across a busy canvas passes over many wires, so a drop that landed on
     * one would silently rewire a graph nobody asked to rewire — where a node with no links has
     * nothing to lose and is nearly always one just added.
     */
    const { graph, edgeId } = chain('core.filter')
    const wired = addEdge(addNode(graph, node('sink', 'out.table')), {
      source: 'loose',
      sourceHandle: 'out',
      target: 'sink',
      targetHandle: 'in',
    })
    // The same graph and the same edge, with one link added — so the only thing that changed is
    // the thing under test. (Calling `chain` twice would mint fresh edge ids and this would pass
    // by looking the edge up in a graph that never had it.)
    expect(candidate(graph, edgeId)).toBeTruthy()
    expect(candidate(wired, edgeId)).toBeUndefined()
  })

  it('refuses a reference wire, which carries nothing to pass through', () => {
    /*
     * A reference names a node rather than carrying its output, so there is nothing to insert
     * into it — and `wouldCreateCycle` answers `false` for one by design, so the cycle half of
     * the check waves it through. What is left standing between the gesture and a graph whose
     * middle node is fed by a port delivering no value is only *type* compatibility, and that is
     * an accident of the current registry rather than a rule: no node today both takes a Dataset
     * and returns one.
     *
     * So the case is built rather than found. `test.splice.passthrough` is what a "pin the
     * materialization" node would look like, and without the guard this splice is offered.
     */
    let g = emptyGraph('ref-splice')
    g = addNode(g, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
    g = addNode(g, node('cave', 'annotation.caveTable', { datastack: 'x:1', table: 't' }))
    g = addNode(g, node('loose', 'test.splice.passthrough'))
    g = addEdge(g, {
      source: 'ds',
      sourceHandle: 'dataset',
      target: 'cave',
      targetHandle: 'dataset',
    })
    const refEdge = g.edges[g.edges.length - 1]!
    expect(spliceCandidate(g, inferGraph(g), 'loose', refEdge)).toBeUndefined()

    // And the same node on an ordinary Dataset wire still splices, so the refusal above is
    // about the reference rather than about this node.
    let ok = emptyGraph('ok-splice')
    ok = addNode(ok, node('ds', 'neuron.dataset', { dataset: 'optic-lobe-mini' }))
    ok = addNode(ok, node('find', 'neuron.findNeurons'))
    ok = addNode(ok, node('loose', 'test.splice.passthrough'))
    ok = addEdge(ok, {
      source: 'ds',
      sourceHandle: 'dataset',
      target: 'find',
      targetHandle: 'dataset',
    })
    expect(spliceCandidate(ok, inferGraph(ok), 'loose', ok.edges[0]!)).toEqual({
      inPort: 'in',
      outPort: 'out',
    })
  })

  it('refuses a text note, which has no ports at all', () => {
    const { graph, edgeId } = chain('note.text')
    expect(candidate(graph, edgeId)).toBeUndefined()
  })
})

describe('the rewire', () => {
  it('replaces one link with two through the node', () => {
    const { graph, edgeId } = chain('core.filter')
    const ports = candidate(graph, edgeId)!
    const after = spliceGraph(graph, 'loose', graph.edges.find((e) => e.id === edgeId)!, ports)

    expect(after.edges.some((e) => e.id === edgeId)).toBe(false)
    const links = after.edges.map((e) => `${e.source}:${e.sourceHandle}→${e.target}:${e.targetHandle}`)
    expect(links).toContain('find:neurons→loose:in')
    expect(links).toContain('loose:out→skel:neurons')
    // The two dataset links are untouched, and nothing else was added.
    expect(after.edges).toHaveLength(4)
  })

  it('leaves exactly one link into the port it took over', () => {
    /*
     * Not an ordering test, though it was written as one: `addEdge` evicts by `(target, port)`
     * and the downstream link targets exactly the port the old one did, so removing first and
     * removing last produce the same graph. Confirmed by mutation, and the explicit removal
     * stays because relying on that coincidence would hold only while both links land on one
     * input.
     *
     * What is worth pinning is the outcome: a version that dropped the removal *and* aimed the
     * new link elsewhere would leave both, and the node would hang off the source with the
     * original wire still running past it — a graph that looks almost right.
     */
    const { graph, edgeId } = chain('core.filter')
    const edge = graph.edges.find((e) => e.id === edgeId)!
    const after = spliceGraph(graph, 'loose', edge, { inPort: 'in', outPort: 'out' })
    const inbound = after.edges.filter((e) => e.target === 'skel' && e.targetHandle === 'neurons')
    expect(inbound).toHaveLength(1)
    expect(inbound[0]?.source).toBe('loose')
  })

  it('leaves the graph inference-clean, with the type carried through', () => {
    const { graph, edgeId } = chain('core.filter')
    const edge = graph.edges.find((e) => e.id === edgeId)!
    const after = spliceGraph(graph, 'loose', edge, candidate(graph, edgeId)!)
    const inferred = inferGraph(after)
    expect(inferred.nodes['loose']?.outputs['out']?.kind).toBe('neurons')
    expect(
      Object.values(inferred.nodes).flatMap((n) => n.issues.filter((i) => i.severity === 'error')),
    ).toEqual([])
  })
})
