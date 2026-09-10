/**
 * Reference edges — a port that names a node rather than consuming its output.
 *
 * They exist for one wiring: `Dataset → CAVE table → Dataset`, a datastack's own annotation table
 * handed back to that datastack as its labels. Two edges between one pair in opposite directions,
 * which at *node* granularity is a cycle — both cards went dark with no result and nothing naming
 * the cause — even though nothing circular is computed. At *port* granularity the graph is
 * acyclic, and a reference is how that is expressed.
 *
 * This file is the bound on a change to `topoSort`, which is the most load-bearing function in
 * the app and whose failures are silent: a node quietly loses its schema, or a stale result
 * quietly survives an edit. So the ordinary cases are asserted here beside the new one — a real
 * cycle is still a cycle, two wires between one pair are still not, and a reference still does
 * not exempt the *other* edges of the pair.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import {
  addEdge,
  addNode,
  emptyGraph,
  referencesFirst,
  topoSort,
  wouldCreateCycle,
} from './graph'
import type { CodaGraph, GraphNode } from './graph'
import { checkConnection, inferGraph } from './inference'
import { registerNode } from './registry'
import { Scheduler } from './scheduler'
import { T } from './types'
import type { Value } from './values'

/** What the reader saw on its reference port, once per run. An array, so nothing narrows it. */
const captured: Array<Value | undefined> = []
let ran: string[] = []

beforeAll(() => {
  // A stand-in for a dataset: an identity from its params, plus a schema from its input — the
  // shape that makes a reference sound. Registered once; `registerNode` refuses a duplicate.
  registerNode({
    type: 'test.ref.dataset',
    label: 'dataset',
    category: 'dataset',
    cost: 'cheap',
    inputs: [{ id: 'annotations', label: 'Annotations', type: T.table(), required: false }],
    outputs: [{ id: 'dataset', label: 'Dataset', type: T.dataset() }],
    inferOutputs: (ctx) => ({
      // The identity comes from params alone; only the schema comes from the input.
      dataset: T.dataset('mock', String(ctx.params.id ?? ''), ctx.schema('annotations')),
    }),
    evaluate: (ctx) => {
      ran.push('dataset')
      return {
        dataset: {
          kind: 'dataset',
          sourceId: 'mock',
          datasetId: String(ctx.params.id ?? ''),
          label: 'ds',
        },
      }
    },
  })
  /*
   * The same stand-in with a reason of its own, for the case that matters most: a dataset node
   * that *knows* why it cannot name a dataset. On CAVE that sentence is
   * `DataSource.whyDatasetMissing`, and getting it onto the card that actually failed is the
   * whole point of composing the refusal in the scheduler.
   */
  registerNode({
    type: 'test.ref.dataset.refused',
    label: 'dataset',
    category: 'dataset',
    cost: 'cheap',
    inputs: [{ id: 'annotations', label: 'Annotations', type: T.table(), required: false }],
    outputs: [{ id: 'dataset', label: 'Dataset', type: T.dataset() }],
    inferOutputs: () => ({ dataset: T.dataset('mock', '') }),
    validate: () => ['stack:7 is not listed — the server said 503'],
    evaluate: () => {
      throw new Error('never runs in these tests')
    },
  })
  // The same reader at the cost both CAVE readers actually declare, for the auto pass: a refusal
  // that fired before the deferral would paint an error on every keystroke.
  registerNode({
    type: 'test.ref.reader.expensive',
    label: 'reader',
    category: 'utility',
    cost: 'expensive',
    inputs: [
      { id: 'dataset', label: 'Dataset', type: T.dataset(), required: false, reference: true },
    ],
    outputs: [{ id: 'out', label: 'Out', type: T.table() }],
    inferOutputs: () => ({ out: T.table() }),
    evaluate: () => {
      ran.push('expensive reader')
      return { out: { kind: 'table', schema: { columns: [] }, data: {}, length: 0 } }
    },
  })
  registerNode({
    type: 'test.ref.reader',
    label: 'reader',
    category: 'utility',
    cost: 'cheap',
    inputs: [
      { id: 'dataset', label: 'Dataset', type: T.dataset(), required: false, reference: true },
      { id: 'in', label: 'In', type: T.table(), required: false },
    ],
    outputs: [{ id: 'out', label: 'Out', type: T.table() }],
    inferOutputs: () => ({ out: T.table() }),
    evaluate: (ctx) => {
      ran.push('reader')
      captured.push(ctx.input('dataset'))
      return { out: { kind: 'table', schema: { columns: [] }, data: {}, length: 0 } }
    },
  })
})

function node(id: string, type: string, params: Record<string, unknown> = {}): GraphNode {
  return { id, type, position: { x: 0, y: 0 }, params: params as GraphNode['params'] }
}

/** The round trip: dataset names the reader, reader feeds the dataset's annotations. */
function roundTrip(): CodaGraph {
  let g = emptyGraph('ref')
  g = addNode(g, node('ds', 'test.ref.dataset', { id: 'stack:7' }))
  g = addNode(g, node('rd', 'test.ref.reader'))
  g = addEdge(g, {
    source: 'ds',
    sourceHandle: 'dataset',
    target: 'rd',
    targetHandle: 'dataset',
  })
  return addEdge(g, {
    source: 'rd',
    sourceHandle: 'out',
    target: 'ds',
    targetHandle: 'annotations',
  })
}

describe('what a reference changes', () => {
  it('lets a node take a dataset it also feeds', () => {
    const sorted = topoSort(roundTrip())
    expect(sorted.cyclic).toEqual([])
    // The reader first: the dataset genuinely waits on its labels, the reference waits on nothing.
    expect(sorted.order.indexOf('rd')).toBeLessThan(sorted.order.indexOf('ds'))
  })

  it('lets the editor draw that wire, which is a separate walk', () => {
    /*
     * `checkConnection` had its *own* reachability walk over `graph.edges`, a second statement of
     * a question `wouldCreateCycle` already answered. They had to be found together: one knew
     * about references and the other refused every wire the change existed to allow.
     */
    const g = roundTrip()
    const inf = inferGraph(g)
    expect(
      checkConnection(
        g,
        inf,
        { nodeId: 'ds', portId: 'dataset' },
        { nodeId: 'rd', portId: 'dataset' },
      ).ok,
    ).toBe(true)
    // And the wire being *drawn* is what matters, not only the ones already there.
    expect(wouldCreateCycle(g, 'ds', 'rd', 'dataset')).toBe(false)
  })

  it('resolves to the identity, without the schema it is about to supply', () => {
    const inf = inferGraph(roundTrip())
    const type = inf.nodes['rd']?.inputs['dataset']
    expect(type?.kind).toBe('dataset')
    expect(type && 'datasetId' in type ? type.datasetId : undefined).toBe('stack:7')
    // Inferred with no inputs of its own, so it cannot recurse — and cannot report a schema that
    // depends on this very node.
    expect(type && 'schema' in type ? type.schema : undefined).toBeUndefined()
  })

  it('hands evaluate an identity with no data behind it, without waiting', async () => {
    ran = []
    captured.length = 0
    const sched = new Scheduler({
      resolveSource: () => {
        throw new Error('no source')
      },
    })
    await sched.run(roundTrip(), { mode: 'full' })

    // Both ran, and the reader ran *first* — it did not wait on the node it references.
    expect(ran).toEqual(['reader', 'dataset'])
    const seen = captured[0]
    expect(seen?.kind).toBe('dataset')
    expect(seen && 'datasetId' in seen ? seen.datasetId : undefined).toBe('stack:7')
    // No annotations: there are none to have, and this node is the one about to supply them.
    expect(seen && 'annotations' in seen ? seen.annotations : undefined).toBeUndefined()
  })

  it('re-keys the reader when the dataset’s identity changes', async () => {
    const sched = new Scheduler({
      resolveSource: () => {
        throw new Error('no source')
      },
    })
    const g = roundTrip()
    await sched.run(g, { mode: 'full' })
    ran = []
    // Same graph again: nothing to do.
    await sched.run(g, { mode: 'full' })
    expect(ran).toEqual([])

    // A different datastack is a different question, so the reader runs again — the reference
    // contributes its resolved *type* to the provenance key, which is what makes this true.
    const moved = {
      ...g,
      nodes: g.nodes.map((n) => (n.id === 'ds' ? { ...n, params: { id: 'stack:9' } } : n)),
    }
    ran = []
    await sched.run(moved, { mode: 'full' })
    expect(ran).toContain('reader')
  })
})

/**
 * A reference whose node cannot say which dataset it names.
 *
 * The FlyWire starter's annotation chain is what found this. `datasetIdentity` hands a reference
 * reader `undefined` both when nothing is wired *and* when the wire's dataset node has resolved no
 * id — so the reader refused in the only words it has, which are about the wiring:
 * `Wire a CAVE Dataset, so the ids can be looked up somewhere` on a card with a Dataset wired to
 * it, beside `Name a datastack and a table, or wire a Dataset` on the next one. Both nodes are
 * *upstream* of the dataset node in a chain — that is the whole point of a reference — so the run
 * stopped there and the dataset node's own diagnosis, which was accurate and named a materialize
 * service answering 503, was never reached.
 *
 * The two states are only distinguishable in the scheduler, which can see both the wire and the
 * unresolved type, so that is where the sentence is written and this is where it is pinned.
 */
describe('a reference that resolves to nothing', () => {
  function unresolved(dsType = 'test.ref.dataset'): CodaGraph {
    // No `id` param, so the type carries no `datasetId` and the identity does not resolve — which
    // is what a CAVE dataset node looks like before its materialization listing has arrived.
    let g = emptyGraph('unresolved')
    g = addNode(g, node('ds', dsType, {}))
    g = addNode(g, node('rd', 'test.ref.reader'))
    return addEdge(g, {
      source: 'ds',
      sourceHandle: 'dataset',
      target: 'rd',
      targetHandle: 'dataset',
    })
  }

  function scheduler(): Scheduler {
    return new Scheduler({
      resolveSource: () => {
        throw new Error('no source')
      },
    })
  }

  it('refuses the reader by naming the node it references, never its own wiring', async () => {
    ran = []
    const sched = scheduler()
    const summary = await sched.run(unresolved(), { mode: 'full' })

    // `evaluate` is not reached, which is the half that matters: whatever the node says when its
    // reference port is unwired would be a sentence about a wire that is right there.
    expect(ran).not.toContain('reader')
    expect(summary.failed).toContain('rd')
    const info = sched.info('rd')
    expect(info.state).toBe('error')
    expect(info.error).toContain('Input "Dataset" is wired to dataset')
    expect(info.error).toContain('has not resolved a dataset')
  })

  it('carries the referenced node’s own reason, which is the diagnosis nobody could reach', async () => {
    const sched = scheduler()
    await sched.run(unresolved('test.ref.dataset.refused'), { mode: 'full' })
    // The sentence the dataset node's `validate` produced — on CAVE this is
    // `DataSource.whyDatasetMissing`, i.e. the reason the listing dropped this datastack.
    expect(sched.info('rd').error).toContain('the server said 503')
  })

  it('says what to do when there is no reason, because a cold listing is not an error', async () => {
    const sched = scheduler()
    await sched.run(unresolved(), { mode: 'full' })
    expect(sched.info('rd').error).toContain('Run again')
  })

  it('still defers an expensive reader on an auto pass rather than reddening it', async () => {
    /*
     * This refusal replaces one the node used to throw from `evaluate`, and an auto pass never
     * reached `evaluate` on an `expensive` node — both readers this exists for are expensive. So
     * the check sits *after* the deferral: otherwise a cold listing paints two error cards on
     * every keystroke, which is a report about the app rather than about the graph.
     */
    let g = emptyGraph('auto')
    g = addNode(g, node('ds', 'test.ref.dataset', {}))
    g = addNode(g, node('rd', 'test.ref.reader.expensive'))
    g = addEdge(g, {
      source: 'ds',
      sourceHandle: 'dataset',
      target: 'rd',
      targetHandle: 'dataset',
    })
    const sched = scheduler()
    const summary = await sched.run(g, { mode: 'auto' })
    expect(summary.failed).not.toContain('rd')
    expect(summary.deferred).toContain('rd')
    expect(sched.info('rd').state).toBe('stale')
    // And a full run still says why.
    await sched.run(g, { mode: 'full' })
    expect(sched.info('rd').error).toContain('has not resolved a dataset')
  })

  it('leaves an unwired reference alone, which is an ordinary state', async () => {
    /*
     * The other side of the same line: with nothing on the port there is no wire to be wrong
     * about, so the node runs and answers in its own words — `annotation.caveTable` reads its
     * `datastack` field in exactly this case, and refusing here would break it.
     */
    ran = []
    captured.length = 0
    let g = emptyGraph('unwired')
    g = addNode(g, node('rd', 'test.ref.reader'))
    const summary = await scheduler().run(g, { mode: 'full' })
    expect(summary.failed).toEqual([])
    expect(ran).toEqual(['reader'])
    expect(captured[0]).toBeUndefined()
  })
})

describe('what a reference must not change', () => {
  it('leaves a real cycle a cycle', () => {
    let g = emptyGraph('cyclic')
    g = addNode(g, node('a', 'test.ref.reader'))
    g = addNode(g, node('b', 'test.ref.reader'))
    // Both edges land on ordinary ports, so the loop is real.
    g = addEdge(g, { source: 'a', sourceHandle: 'out', target: 'b', targetHandle: 'in' })
    g = addEdge(g, { source: 'b', sourceHandle: 'out', target: 'a', targetHandle: 'in' })
    expect(topoSort(g).cyclic.sort()).toEqual(['a', 'b'])
    expect(wouldCreateCycle(g, 'a', 'b', 'in')).toBe(true)
  })

  it('notices a reference port registered after the type memo was built', () => {
    /*
     * `typesWithReferenceInputs` memoises, so the graph walks can ask "could this graph hold a
     * reference at all?" without touching an edge. A memo that outlived a registration would
     * answer about a registry that no longer exists — and the failure is the exact thing
     * references were built to remove: the round trip reads as a cycle again, both cards go dark,
     * and nothing names the cause.
     *
     * Warm it first, deliberately: registering before anything has asked proves nothing.
     */
    topoSort(emptyGraph('warm'))

    registerNode({
      type: 'test.ref.late',
      label: 'late',
      category: 'utility',
      cost: 'cheap',
      inputs: [
        {
          id: 'dataset',
          label: 'Dataset',
          type: T.dataset(),
          required: false,
          reference: true,
        },
        { id: 'in', label: 'In', type: T.table(), required: false },
      ],
      outputs: [{ id: 'out', label: 'Out', type: T.table() }],
      inferOutputs: () => ({ out: T.table() }),
      evaluate: () => ({
        out: { kind: 'table', schema: { columns: [] }, data: {}, length: 0 },
      }),
    })

    let g = emptyGraph('late')
    g = addNode(g, node('ds', 'test.ref.dataset', { id: 'stack:1' }))
    g = addNode(g, node('late', 'test.ref.late'))
    g = addEdge(g, {
      source: 'ds',
      sourceHandle: 'dataset',
      target: 'late',
      targetHandle: 'dataset',
    })
    g = addEdge(g, {
      source: 'late',
      sourceHandle: 'out',
      target: 'ds',
      targetHandle: 'annotations',
    })
    expect(topoSort(g).cyclic).toEqual([])
  })

  it('leaves two wires between one pair not a cycle', () => {
    /*
     * `topoSort`'s own recorded bug: the indegree was counted over `graph.edges` while the
     * decrement came from the deduplicating `neighbourIndex`, so a target joined twice never
     * reached zero. Filtering references anywhere but inside that one index would bring it back
     * wearing a reference's clothes.
     */
    let g = emptyGraph('twice')
    g = addNode(g, node('ds', 'test.ref.dataset', { id: 'x' }))
    g = addNode(g, node('a', 'test.ref.reader'))
    g = addNode(g, node('b', 'test.ref.reader'))
    g = addEdge(g, { source: 'a', sourceHandle: 'out', target: 'b', targetHandle: 'in' })
    g = addEdge(g, {
      source: 'ds',
      sourceHandle: 'dataset',
      target: 'b',
      targetHandle: 'dataset',
    })
    g = addEdge(g, { source: 'a', sourceHandle: 'out', target: 'b', targetHandle: 'in' })
    expect(topoSort(g).cyclic).toEqual([])
    expect(topoSort(g).order).toHaveLength(3)
  })

  it('does not exempt the other edges of the same pair', () => {
    // The reference is excluded; the ordinary wire beside it still orders the pair.
    const sorted = topoSort(roundTrip())
    expect(sorted.order.indexOf('rd')).toBeLessThan(sorted.order.indexOf('ds'))
  })
})

describe('writing the nodes out, which wants the opposite order', () => {
  it('puts a referenced node ahead of its reader', () => {
    /*
     * `topoSort` leaves references out of the order, which is right for *running* — the reader
     * waits on nothing — and backwards for *writing out*, where the reader emits a line naming
     * the referenced node and that node's own line has to exist first.
     *
     * Both exporters walk in this order. Without it the reader is classified as blocked by a node
     * that was translated perfectly well, and emits a TODO that is false and cascades to
     * everything downstream of it.
     */
    let g = emptyGraph('one-way')
    g = addNode(g, node('rd', 'test.ref.reader'))
    g = addNode(g, node('ds', 'test.ref.dataset', { id: 'stack:7' }))
    g = addEdge(g, {
      source: 'ds',
      sourceHandle: 'dataset',
      target: 'rd',
      targetHandle: 'dataset',
    })
    // Nothing orders these two, so the sort is free to put the reader first; the hoist is what
    // makes the dataset's line exist by the time the reader names it.
    const order = referencesFirst(topoSort(g).order, g)
    expect(order.indexOf('ds')).toBeLessThan(order.indexOf('rd'))
  })

  it('leaves a referenced node that consumes its reader where it is', () => {
    /*
     * The wiring references exist for, and the one case the hoist must decline: the dataset takes
     * the reader's output as its annotations, so writing it first would classify it `blocked` by
     * its own labels and cascade a false TODO to everything downstream — the very failure the
     * hoist was added to prevent, arrived at from the other side.
     *
     * A reader left ahead of its reference is not stranded: the walk does not treat an unbound
     * reference port as blocking, and an emitter falls back to the referenced node's *type*,
     * which is all a reference ever promised.
     */
    const g = roundTrip()
    const order = referencesFirst(topoSort(g).order, g)
    expect(order.indexOf('rd')).toBeLessThan(order.indexOf('ds'))
    // The running order is the same, and stays that way.
    expect(topoSort(g).order.indexOf('rd')).toBeLessThan(topoSort(g).order.indexOf('ds'))
  })

  it('leaves a graph with no references exactly as it was', () => {
    let g = emptyGraph('plain')
    g = addNode(g, node('a', 'test.ref.reader'))
    g = addNode(g, node('b', 'test.ref.reader'))
    g = addEdge(g, { source: 'a', sourceHandle: 'out', target: 'b', targetHandle: 'in' })
    const sorted = topoSort(g).order
    expect(referencesFirst(sorted, g)).toEqual(sorted)
  })

  it('keeps the relative order of the nodes it moves', () => {
    // Two datasets referenced by one reader: hoisted together, in the order they were sorted in.
    let g = emptyGraph('two')
    g = addNode(g, node('d1', 'test.ref.dataset', { id: 'a' }))
    g = addNode(g, node('mid', 'test.ref.reader'))
    g = addNode(g, node('d2', 'test.ref.dataset', { id: 'b' }))
    g = addNode(g, node('rd', 'test.ref.reader'))
    g = addEdge(g, {
      source: 'd1',
      sourceHandle: 'dataset',
      target: 'rd',
      targetHandle: 'dataset',
    })
    g = addEdge(g, {
      source: 'd2',
      sourceHandle: 'dataset',
      target: 'mid',
      targetHandle: 'dataset',
    })
    const sorted = topoSort(g).order
    const order = referencesFirst(sorted, g)
    expect(order.slice(0, 2)).toEqual(sorted.filter((id) => id === 'd1' || id === 'd2'))
    expect(order).toHaveLength(sorted.length)
  })
})
