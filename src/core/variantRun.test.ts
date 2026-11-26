/**
 * `EvalContext.rerunInput`: a node running the chain above one of its inputs for another neuron.
 *
 * Two halves, tested apart because they fail apart. `variantGraph` is graph surgery — which wire
 * is "the neuron", and what it refuses — and every way of getting it wrong still produces a
 * graph that runs. The scheduler half is that the re-run happens on a `Scheduler` of its own:
 * the failure there is a card on the canvas quietly holding another neuron's result.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { addEdge, addNode, emptyGraph } from './graph'
import type { CodaGraph, GraphNode } from './graph'
import { errorMessage } from './errors'
import { inferGraph } from './inference'
import type { NeuronSwap } from './node'
import { registerNode } from './registry'
import { sourcelessScheduler as scheduler } from '../test/scheduler'
import { T, column, tableSchema } from './types'
import type { TableValue, Value } from './values'
import { makeTable } from './values'
import { variantGraph } from './variantRun'

/** Every `evaluate`, as `node:ids`, in the order it ran — across both schedulers. */
let ran: string[] = []
/** What the caller's re-run handed back, or the sentence it threw. */
let answer: { ids?: string[]; warnings?: string[]; error?: string; notes?: string[] } = {}
/** Whether the caller's context offered `rerunInput` at all. */
let offered: boolean | undefined
/** Resolved by a test that wants the inner chain held open. */
let gate: Promise<void> | undefined
let sawAbort = false

const idsOf = (value: Value | undefined): string[] =>
  value && 'data' in value ? ((value as TableValue).data['id'] ?? []).map(String) : []

const table = (ids: readonly string[], kind: 'table' | 'neurons' = 'table'): TableValue =>
  makeTable(tableSchema(column('id', 'str')), { id: [...ids] }, kind)

beforeAll(() => {
  registerNode({
    type: 'test.var.neurons',
    label: 'Pick',
    category: 'query',
    cost: 'cheap',
    outputs: [{ id: 'neurons', label: 'Neurons', type: T.neurons() }],
    params: [{ id: 'ids', kind: 'string', label: 'IDs', default: '' }],
    inferOutputs: () => ({ neurons: T.neurons() }),
    evaluate: (ctx) => {
      ran.push(`pick:${String(ctx.params.ids)}`)
      return { neurons: table(String(ctx.params.ids).split(',').filter(Boolean), 'neurons') }
    },
  })
  // One step of a chain: a table about the neurons it was given.
  registerNode({
    type: 'test.var.step',
    label: 'Step',
    category: 'analysis',
    cost: 'expensive',
    inputs: [
      { id: 'in', label: 'In', type: T.any(), anyKind: true },
      { id: 'dataset', label: 'Dataset', type: T.dataset(), required: false },
    ],
    outputs: [{ id: 'out', label: 'Out', type: T.table() }],
    // Said in the trace where set: a re-run's `settings` lay it over the copy's steps.
    params: [{ id: 'mark', kind: 'string', label: 'Mark', default: '' }],
    inferOutputs: () => ({ out: T.table() }),
    evaluate: async (ctx) => {
      const ids = idsOf(ctx.input('in'))
      const mark = String(ctx.params.mark)
      ran.push(`step:${ids.join(',')}${mark ? `@${mark}` : ''}`)
      ctx.progress(0.1, 'working')
      if (ids.includes('bad')) throw new Error('no such neuron')
      if (ids.includes('loud')) ctx.warn('this one was slow')
      if (ids.includes('held') && gate) {
        ctx.progress(0.5, 'waiting')
        await Promise.race([
          gate,
          new Promise<void>((done) =>
            ctx.signal.addEventListener('abort', () => {
              sawAbort = true
              done()
            }),
          ),
        ])
      }
      return { out: table(ids) }
    },
  })
  registerNode({
    type: 'test.var.dataset',
    label: 'Dataset',
    category: 'dataset',
    cost: 'cheap',
    inputs: [
      {
        id: 'annotations',
        label: 'Annotations',
        type: T.any(),
        anyKind: true,
        required: false,
      },
    ],
    outputs: [{ id: 'dataset', label: 'Dataset', type: T.dataset() }],
    inferOutputs: () => ({ dataset: T.dataset('mock', 'stack:1') }),
    evaluate: () => {
      ran.push('dataset')
      return {
        dataset: { kind: 'dataset', sourceId: 'mock', datasetId: 'stack:1', label: 'ds' },
      }
    },
  })
  // A source with a neuron table and a second, ordinary table beside it.
  registerNode({
    type: 'test.var.twoOutputs',
    label: 'Two',
    category: 'query',
    cost: 'cheap',
    outputs: [
      { id: 'neurons', label: 'Neurons', type: T.neurons() },
      { id: 'table', label: 'Table', type: T.table() },
    ],
    params: [{ id: 'ids', kind: 'string', label: 'IDs', default: '' }],
    inferOutputs: () => ({ neurons: T.neurons(), table: T.table() }),
    evaluate: (ctx) => ({
      neurons: table([String(ctx.params.ids)], 'neurons'),
      table: table([String(ctx.params.ids)]),
    }),
  })
  // A step that also *names* a node by reference — which carries nothing that was computed.
  registerNode({
    type: 'test.var.named',
    label: 'Named',
    category: 'analysis',
    cost: 'expensive',
    inputs: [
      { id: 'in', label: 'In', type: T.any(), anyKind: true },
      { id: 'names', label: 'Names', type: T.dataset(), required: false, reference: true },
    ],
    outputs: [{ id: 'out', label: 'Out', type: T.table() }],
    inferOutputs: () => ({ out: T.table() }),
    evaluate: (ctx) => ({ out: table(idsOf(ctx.input('in'))) }),
  })
  // A dataset that cannot run without its labels: fine on the canvas, stranded in a copy that
  // keeps it only to be named.
  registerNode({
    type: 'test.var.needyDataset',
    label: 'Needy',
    category: 'dataset',
    cost: 'cheap',
    inputs: [{ id: 'annotations', label: 'Annotations', type: T.any(), anyKind: true }],
    outputs: [{ id: 'dataset', label: 'Dataset', type: T.dataset() }],
    inferOutputs: () => ({ dataset: T.dataset('mock', 'stack:2') }),
    evaluate: () => ({
      dataset: { kind: 'dataset', sourceId: 'mock', datasetId: 'stack:2', label: 'ds' },
    }),
  })
  registerNode({
    type: 'test.var.fold',
    label: 'Fold',
    category: 'utility',
    cost: 'cheap',
    loop: 'end',
    inputs: [{ id: 'in', label: 'In', type: T.any(), anyKind: true }],
    outputs: [{ id: 'out', label: 'Out', type: T.table() }],
    inferOutputs: () => ({ out: T.table() }),
    evaluate: (ctx) => ({ out: table(idsOf(ctx.input('in'))) }),
  })
  // The node that asks: its own input's ids, then the same chain for the neuron in `ask`.
  registerNode({
    type: 'test.var.caller',
    label: 'Caller',
    category: 'analysis',
    cost: 'expensive',
    rerunsInputs: true,
    inputs: [{ id: 'tips', label: 'Tips', type: T.table() }],
    outputs: [{ id: 'out', label: 'Out', type: T.table() }],
    params: [
      { id: 'ask', kind: 'string', label: 'Ask', default: '' },
      // Which node to put in: the default is a source, as a caller would pass.
      { id: 'swap', kind: 'string', label: 'Swap', default: 'test.var.neurons' },
      // Laid over the copy's steps where set (`RerunSettings`).
      { id: 'mark', kind: 'string', label: 'Mark', default: '' },
    ],
    inferOutputs: () => ({ out: T.table() }),
    evaluate: async (ctx) => {
      const mine = idsOf(ctx.input('tips'))
      ran.push(`caller:${mine.join(',')}`)
      offered = ctx.rerunInput !== undefined
      answer = {}
      const ask = String(ctx.params.ask)
      if (ask && ctx.rerunInput) {
        const notes: string[] = []
        try {
          const got = await ctx.rerunInput(
            'tips',
            String(ctx.params.swap) === 'test.var.neurons'
              ? { type: 'test.var.neurons', params: { ids: ask }, output: 'neurons' }
              : { type: String(ctx.params.swap), params: {}, output: 'out' },
            {
              report: (note) => notes.push(note),
              ...(ctx.params.mark
                ? { settings: { 'test.var.step': { mark: String(ctx.params.mark) } } }
                : {}),
            },
          )
          answer = { ids: idsOf(got.value), warnings: got.warnings, notes }
        } catch (error) {
          answer = { error: errorMessage(error), notes }
        }
      }
      return { out: table(mine) }
    },
  })
  registerNode({
    type: 'test.var.plain',
    label: 'Plain',
    category: 'analysis',
    cost: 'expensive',
    inputs: [{ id: 'tips', label: 'Tips', type: T.table() }],
    outputs: [{ id: 'out', label: 'Out', type: T.table() }],
    inferOutputs: () => ({ out: T.table() }),
    evaluate: (ctx) => {
      offered = ctx.rerunInput !== undefined
      return { out: table([]) }
    },
  })
})

function node(id: string, type: string, params: Record<string, unknown> = {}): GraphNode {
  return { id, type, position: { x: 0, y: 0 }, params: params as GraphNode['params'] }
}

const wire = (g: CodaGraph, from: string, out: string, to: string, into: string): CodaGraph =>
  addEdge(g, { source: from, sourceHandle: out, target: to, targetHandle: into })

/** pick(seed) → a → b → caller.tips, the shape of the on-demand chain. */
function chain(ask = '', seed = 'seed'): CodaGraph {
  let g = emptyGraph('variant')
  g = addNode(g, node('pick', 'test.var.neurons', { ids: seed }))
  g = addNode(g, node('a', 'test.var.step'))
  g = addNode(g, node('b', 'test.var.step'))
  g = addNode(g, node('call', 'test.var.caller', { ask }))
  g = wire(g, 'pick', 'neurons', 'a', 'in')
  g = wire(g, 'a', 'out', 'b', 'in')
  return wire(g, 'b', 'out', 'call', 'tips')
}

const SWAP: NeuronSwap = {
  type: 'test.var.neurons',
  params: { ids: 'other' },
  output: 'neurons',
}

const swapOn = (g: CodaGraph, nodeId = 'call', portId = 'tips') =>
  variantGraph(g, inferGraph(g), nodeId, portId, SWAP)

describe('where the neuron comes in', () => {
  it('swaps the nearest neuron wire and leaves the rest of the chain as it was', () => {
    const g = chain()
    const { graph, source } = swapOn(g)
    const added = graph.nodes.filter((n) => !g.nodes.includes(n))
    expect(added.map((n) => n.type)).toEqual(['test.var.neurons'])
    expect(added[0]!.params).toEqual({ ids: 'other' })
    // The one wire that carried the neuron now starts at the swap; the one below it is untouched.
    const intoA = graph.edges.find((e) => e.target === 'a' && e.targetHandle === 'in')!
    expect(intoA.source).toBe(added[0]!.id)
    expect(intoA.sourceHandle).toBe('neurons')
    expect(graph.edges.filter((e) => g.edges.includes(e))).toHaveLength(1)
    // And the value is read where the port was fed from.
    expect(source).toEqual({ nodeId: 'b', handle: 'out' })
    // The document's own graph is not written through.
    expect(g.edges.find((e) => e.target === 'a')!.source).toBe('pick')
  })

  it('lays the settings over every copied node of their type, and nothing else', () => {
    const g = chain()
    const { graph } = variantGraph(g, inferGraph(g), 'call', 'tips', SWAP, {
      'test.var.step': { mark: 'piece' },
    })
    const steps = graph.nodes.filter((n) => n.type === 'test.var.step')
    expect(steps.map((n) => n.params['mark'])).toEqual(['piece', 'piece'])
    // The swap keeps its own params, and the document's nodes are not written through.
    expect(graph.nodes.find((n) => n.type === 'test.var.neurons')!.params).toEqual({
      ids: 'other',
    })
    expect(g.nodes.find((n) => n.id === 'a')!.params['mark']).toBeUndefined()
  })

  it('refuses a setting the type has no param for, so a rename cannot quietly drop it', () => {
    const g = chain()
    expect(() =>
      variantGraph(g, inferGraph(g), 'call', 'tips', SWAP, {
        'test.var.step': { marked: 'x' },
      }),
    ).toThrow(/test.var.step has no param `marked`/)
    expect(() =>
      variantGraph(g, inferGraph(g), 'call', 'tips', SWAP, { 'test.var.gone': { mark: 'x' } }),
    ).toThrow(/test.var.gone, which is not a node type this build has/)
  })

  it('keeps only what the run will reach — not the caller, the old source, or a bystander', () => {
    // A run sorts, infers and keys the whole graph it is given, and derives every cheap node
    // below a partial. Uncut, a re-run paid for the document and re-derived its viewers.
    let g = chain()
    g = addNode(g, node('viewer', 'test.var.step'))
    g = wire(g, 'b', 'out', 'viewer', 'in')
    const { graph } = swapOn(g)
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'rerun:call:tips'])
    expect(graph.edges.map((e) => `${e.source}>${e.target}`).sort()).toEqual([
      'a>b',
      'rerun:call:tips>a',
    ])
  })

  it('keeps a dataset and what feeds it, which the chain reads but the walk does not cross', () => {
    let g = chain()
    g = addNode(g, node('labels', 'test.var.neurons', { ids: 'labelled' }))
    g = addNode(g, node('ds', 'test.var.dataset'))
    g = wire(g, 'labels', 'neurons', 'ds', 'annotations')
    g = wire(g, 'ds', 'dataset', 'a', 'dataset')
    const kept = swapOn(g).graph.nodes.map((n) => n.id)
    expect(kept).toContain('ds')
    expect(kept).toContain('labels')
  })

  it('stops at the nearest neuron wire, and does not look above it', () => {
    // pick → narrow (still neurons) → a: the wire into `a` is the neuron, `pick` is how it was chosen.
    let g = emptyGraph('nearest')
    g = addNode(g, node('pick', 'test.var.neurons', { ids: 'seed' }))
    g = addNode(g, node('narrow', 'test.var.neurons', { ids: 'seed' }))
    g = addNode(g, node('a', 'test.var.step'))
    g = addNode(g, node('call', 'test.var.caller'))
    g = wire(g, 'narrow', 'neurons', 'a', 'in')
    g = wire(g, 'a', 'out', 'call', 'tips')
    const { graph } = swapOn(g)
    expect(graph.edges.find((e) => e.target === 'a')!.source).toMatch(/^rerun:/)
  })

  it('swaps every wire the one neuron source feeds into the chain', () => {
    // A mesh branch and a skeleton branch off the same neurons, joined below.
    let g = chain()
    g = addNode(g, node('side', 'test.var.step'))
    g = wire(g, 'pick', 'neurons', 'side', 'in')
    g = wire(g, 'side', 'out', 'b', 'dataset')
    const { graph } = swapOn(g)
    const fed = graph.edges.filter((e) => e.source.startsWith('rerun:')).map((e) => e.target)
    expect(fed.sort()).toEqual(['a', 'side'])
  })

  it('feeds the port from the swap itself where the port’s own wire is the neuron', () => {
    let g = emptyGraph('direct')
    g = addNode(g, node('pick', 'test.var.neurons', { ids: 'seed' }))
    g = addNode(g, node('a', 'test.var.step'))
    g = wire(g, 'pick', 'neurons', 'a', 'in')
    const { source } = swapOn(g, 'a', 'in')
    expect(source.nodeId).toMatch(/^rerun:/)
    expect(source.handle).toBe('neurons')
  })

  it('does not take a dataset’s own labels for the neuron', () => {
    // A neuron table feeds the *dataset*, which feeds the chain. Read as "the neuron" it would be
    // a second source and a refusal — or, alone, the wrong thing swapped.
    let g = chain()
    g = addNode(g, node('labels', 'test.var.neurons', { ids: 'labelled' }))
    g = addNode(g, node('ds', 'test.var.dataset'))
    g = wire(g, 'labels', 'neurons', 'ds', 'annotations')
    g = wire(g, 'ds', 'dataset', 'a', 'dataset')
    const { graph } = swapOn(g)
    expect(graph.edges.find((e) => e.target === 'ds')!.source).toBe('labels')
    expect(
      graph.edges.find((e) => e.target === 'a' && e.targetHandle === 'in')!.source,
    ).toMatch(/^rerun:/)
  })

  it('keeps a node the chain only names on its own — which keeps the caller out of its re-run', () => {
    // A step of the chain names a node *below* the caller. Followed like an ordinary wire — as
    // `ancestors` does — that pulls the caller into the copy, and the caller re-runs its input
    // again inside the re-run, without end.
    let g = emptyGraph('named below')
    g = addNode(g, node('pick', 'test.var.neurons', { ids: 'seed' }))
    g = addNode(g, node('a', 'test.var.named'))
    g = addNode(g, node('call', 'test.var.caller'))
    g = addNode(g, node('after', 'test.var.dataset'))
    g = wire(g, 'pick', 'neurons', 'a', 'in')
    g = wire(g, 'a', 'out', 'call', 'tips')
    g = wire(g, 'call', 'out', 'after', 'annotations')
    g = wire(g, 'after', 'dataset', 'a', 'names')
    const { graph } = swapOn(g)
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(['a', 'after', 'rerun:call:tips'])
    // Named, so kept — and bare: nothing is wired into it.
    expect(graph.edges.filter((e) => e.target === 'after')).toEqual([])
  })

  it('keeps a named node with nothing wired into it, even from inside the chain', () => {
    // A reference reads params or a type, never a result — so what feeds a named node is not
    // the re-run's to run. Here it is fed by a step of the very chain that names it.
    let g = emptyGraph('named beside')
    g = addNode(g, node('pick', 'test.var.neurons', { ids: 'seed' }))
    g = addNode(g, node('a', 'test.var.named'))
    g = addNode(g, node('b', 'test.var.step'))
    g = addNode(g, node('call', 'test.var.caller'))
    g = addNode(g, node('beside', 'test.var.dataset'))
    g = wire(g, 'pick', 'neurons', 'a', 'in')
    g = wire(g, 'a', 'out', 'b', 'in')
    g = wire(g, 'b', 'out', 'call', 'tips')
    g = wire(g, 'b', 'out', 'beside', 'annotations')
    g = wire(g, 'beside', 'dataset', 'a', 'names')
    const { graph } = swapOn(g)
    expect(graph.nodes.map((n) => n.id)).toContain('beside')
    expect(graph.edges.filter((e) => e.target === 'beside')).toEqual([])
  })

  it('does not follow a reference wire, which names a node and carries nothing', () => {
    // The same neuron table, wired by reference into a step of the chain. Followed, it is a
    // second place the neuron "comes from" and the chain is refused.
    let g = emptyGraph('named')
    g = addNode(g, node('pick', 'test.var.neurons', { ids: 'seed' }))
    g = addNode(g, node('elsewhere', 'test.var.neurons', { ids: 'unrelated' }))
    g = addNode(g, node('a', 'test.var.named'))
    g = addNode(g, node('call', 'test.var.caller'))
    g = wire(g, 'pick', 'neurons', 'a', 'in')
    g = wire(g, 'elsewhere', 'neurons', 'a', 'names')
    g = wire(g, 'a', 'out', 'call', 'tips')
    const { graph } = swapOn(g)
    expect(graph.edges.find((e) => e.targetHandle === 'names')!.source).toBe('elsewhere')
    expect(
      graph.edges.find((e) => e.target === 'a' && e.targetHandle === 'in')!.source,
    ).toMatch(/^rerun:/)
  })
})

describe('what it refuses', () => {
  it('an input nothing is wired into', () => {
    let g = emptyGraph('unwired')
    g = addNode(g, node('call', 'test.var.caller'))
    expect(() => swapOn(g)).toThrow(/nothing is wired into it/)
  })

  it('a chain no neuron table feeds', () => {
    let g = emptyGraph('no neuron')
    g = addNode(g, node('ds', 'test.var.dataset'))
    g = addNode(g, node('a', 'test.var.step'))
    g = addNode(g, node('call', 'test.var.caller'))
    g = wire(g, 'ds', 'dataset', 'a', 'in')
    g = wire(g, 'a', 'out', 'call', 'tips')
    expect(() => swapOn(g)).toThrow(/nothing above it is wired from a neuron table/)
  })

  it('neuron tables from two places, naming both', () => {
    let g = chain()
    g = addNode(g, node('pick2', 'test.var.neurons', { ids: 'second' }))
    g = wire(g, 'pick2', 'neurons', 'b', 'dataset')
    expect(() => swapOn(g)).toThrow(/from 2 places feed it \(Pick, Pick\)/)
  })

  it('the old source still feeding the chain by another wire', () => {
    // `pick`'s neurons are swapped out, but a second wire from it joins in further down: left
    // alone, the answer is half about the new neuron and half about the old one.
    let g = chain()
    g = addNode(g, node('hits', 'test.var.step'))
    g = wire(g, 'pick', 'neurons', 'hits', 'in')
    g = { ...g, edges: g.edges.filter((e) => !(e.source === 'pick' && e.target === 'hits')) }
    g = addNode(g, node('twoOut', 'test.var.twoOutputs', { ids: 'seed' }))
    g = {
      ...g,
      edges: g.edges.map((e) => (e.source === 'pick' ? { ...e, source: 'twoOut' } : e)),
    }
    g = wire(g, 'twoOut', 'table', 'b', 'dataset')
    expect(() => swapOn(g)).toThrow(/Two also feeds it by another wire/)
  })

  it('but not a source that also feeds the labels of a dataset the chain reads', () => {
    // The same neurons go to the chain and, by another road, into a dataset's annotations. Above
    // a dataset is not about the neuron under study, so this is one wire into the chain, not two.
    let g = chain()
    g = addNode(g, node('ds', 'test.var.dataset'))
    g = wire(g, 'pick', 'neurons', 'ds', 'annotations')
    g = wire(g, 'ds', 'dataset', 'a', 'dataset')
    const { graph, chain: made } = swapOn(g)
    expect(
      graph.edges.find((e) => e.target === 'a' && e.targetHandle === 'in')!.source,
    ).toMatch(/^rerun:/)
    // The dataset still reads its labels from where it did.
    expect(graph.edges.find((e) => e.target === 'ds')!.source).toBe('pick')
    expect([...made].sort()).toEqual(['a', 'b', 'ds', 'pick', 'rerun:call:tips'])
  })

  it('a loop above a dataset the chain reads, which the walk for the neuron never crosses', () => {
    let g = chain()
    g = addNode(g, node('labels', 'test.var.neurons', { ids: 'labelled' }))
    g = addNode(g, node('fold', 'test.var.fold'))
    g = addNode(g, node('ds', 'test.var.dataset'))
    g = wire(g, 'labels', 'neurons', 'fold', 'in')
    g = wire(g, 'fold', 'out', 'ds', 'annotations')
    g = wire(g, 'ds', 'dataset', 'a', 'dataset')
    expect(() => swapOn(g)).toThrow(/Fold is part of a loop/)
  })

  it('a loop in the chain', () => {
    let g = emptyGraph('loop')
    g = addNode(g, node('pick', 'test.var.neurons', { ids: 'seed' }))
    g = addNode(g, node('fold', 'test.var.fold'))
    g = addNode(g, node('call', 'test.var.caller'))
    g = wire(g, 'pick', 'neurons', 'fold', 'in')
    g = wire(g, 'fold', 'out', 'call', 'tips')
    expect(() => swapOn(g)).toThrow(/Fold is part of a loop/)
  })
})

describe('the re-run, on a scheduler of its own', () => {
  it('hands back the chain’s answer for the neuron asked about', async () => {
    ran = []
    const sched = scheduler()
    await sched.run(chain('other'), { mode: 'full' })
    expect(sched.info('call').state).toBe('ok')
    expect(offered).toBe(true)
    expect(answer.ids).toEqual(['other'])
    // The seed's chain once, the caller, then the same chain once more for the other neuron.
    expect(ran).toEqual([
      'pick:seed',
      'step:seed',
      'step:seed',
      'caller:seed',
      'pick:other',
      'step:other',
      'step:other',
    ])
  })

  it('runs the copy with the settings asked for, and the canvas without them', async () => {
    ran = []
    const sched = scheduler()
    const g = chain('other')
    const call = g.nodes.find((n) => n.id === 'call')!
    await sched.run(
      {
        ...g,
        nodes: g.nodes.map((n) =>
          n === call ? { ...n, params: { ...n.params, mark: 'piece' } } : n,
        ),
      },
      { mode: 'full' },
    )
    expect(ran).toEqual([
      'pick:seed',
      'step:seed',
      'step:seed',
      'caller:seed',
      'pick:other',
      'step:other@piece',
      'step:other@piece',
    ])
  })

  it('leaves every card’s own result and state as they were', async () => {
    const sched = scheduler()
    const g = chain('other')
    await sched.run(g, { mode: 'full' })
    // The failure this exists to prevent: the canvas holding the *other* neuron's tables.
    expect(idsOf(sched.output('a', 'out'))).toEqual(['seed'])
    expect(idsOf(sched.output('b', 'out'))).toEqual(['seed'])
    expect(idsOf(sched.output('call', 'out'))).toEqual(['seed'])
    for (const id of ['pick', 'a', 'b', 'call']) expect(sched.info(id).state).toBe('ok')
    // And nothing was left stale: a second Run over the same graph does no work.
    ran = []
    await sched.run(g, { mode: 'full' })
    expect(ran).toEqual([])
  })

  it('says which inner node is at work, as that node reports progress', async () => {
    const sched = scheduler()
    await sched.run(chain('other'), { mode: 'full' })
    expect(answer.notes).toContain('Step: working')
    // And none of it reached the canvas: the caller's own state is its own.
    expect(sched.info('a').note).toBeUndefined()
  })

  it('passes an inner node’s warning up, led by its label', async () => {
    const sched = scheduler()
    await sched.run(chain('loud'), { mode: 'full' })
    expect(answer.warnings).toEqual(['Step: this one was slow', 'Step: this one was slow'])
  })

  it('names the inner node that failed, not the one left blocked under it', async () => {
    const sched = scheduler()
    await sched.run(chain('bad'), { mode: 'full' })
    expect(answer.error).toBe('Step could not be run again: no such neuron')
    // The caller decides what a failed re-run means; here it carried on.
    expect(sched.info('call').state).toBe('ok')
  })

  it('names a node that could not start, and why', async () => {
    // A swap that needs an input nothing in the copy gives it: no `evaluate` ever throws, and the
    // node the caller asked about is merely blocked. The sentence has to be the swap's own.
    const g = chain('other')
    const needy = {
      ...g,
      nodes: g.nodes.map((n) =>
        n.id === 'call' ? { ...n, params: { ...n.params, swap: 'test.var.step' } } : n,
      ),
    }
    await scheduler().run(needy, { mode: 'full' })
    expect(answer.error).toMatch(/^Step could not be run again: .*In/)
  })

  it('does not blame a node the chain only names for the chain’s own failure', async () => {
    // `bystander` is named by a step of the chain and needs an input the copy does not give it,
    // so it fails inside the private run — first, being earlier in the graph. The chain's own
    // failure is the step that threw.
    let g = emptyGraph('bystander')
    g = addNode(g, node('bystander', 'test.var.needyDataset'))
    g = addNode(g, node('pick', 'test.var.neurons', { ids: 'seed' }))
    g = addNode(g, node('a', 'test.var.named'))
    g = addNode(g, node('b', 'test.var.step'))
    g = addNode(g, node('call', 'test.var.caller', { ask: 'bad' }))
    g = wire(g, 'pick', 'neurons', 'a', 'in')
    g = wire(g, 'a', 'out', 'b', 'in')
    g = wire(g, 'b', 'out', 'call', 'tips')
    g = wire(g, 'b', 'out', 'bystander', 'annotations')
    g = wire(g, 'bystander', 'dataset', 'a', 'names')
    answer = {}
    const sched = scheduler()
    await sched.run(g, { mode: 'full' })
    expect(sched.info('call').state).toBe('ok')
    expect(answer.error).toBe('Step could not be run again: no such neuron')
  })

  it('refuses in a sentence where the chain is not a function of a neuron', async () => {
    let g = emptyGraph('no neuron run')
    g = addNode(g, node('ds', 'test.var.dataset'))
    g = addNode(g, node('a', 'test.var.step'))
    g = addNode(g, node('call', 'test.var.caller', { ask: 'other' }))
    g = wire(g, 'ds', 'dataset', 'a', 'in')
    g = wire(g, 'a', 'out', 'call', 'tips')
    await scheduler().run(g, { mode: 'full' })
    expect(answer.error).toMatch(/cannot be run again for another neuron/)
  })

  it('is stopped by Cancel, through the caller’s own signal', async () => {
    let open = () => {}
    gate = new Promise<void>((done) => (open = done))
    sawAbort = false
    ran = []
    const sched = scheduler()
    const running = sched.run(chain('held'), { mode: 'full' })
    // Until the inner chain is parked on the gate.
    await expect.poll(() => ran.includes('step:held')).toBe(true)
    sched.cancel()
    const summary = await running
    open()
    gate = undefined
    expect(summary.cancelled).toBe(true)
    expect(sawAbort).toBe(true)
    // The second inner step never started: the private scheduler was cancelled, not left to finish.
    expect(ran.filter((line) => line === 'step:held')).toHaveLength(1)
  })
})

describe('who may ask', () => {
  it('offers nothing to a node that did not declare it', async () => {
    let g = chain()
    g = {
      ...g,
      nodes: g.nodes.map((n) => (n.id === 'call' ? { ...n, type: 'test.var.plain' } : n)),
    }
    offered = undefined
    await scheduler().run(g, { mode: 'full' })
    expect(offered).toBe(false)
  })

  it('refuses the declaration on a cheap node, at registration', () => {
    expect(() =>
      registerNode({
        type: 'test.var.cheapCaller',
        label: 'Cheap',
        category: 'analysis',
        cost: 'cheap',
        rerunsInputs: true,
        outputs: [{ id: 'out', label: 'Out', type: T.table() }],
        evaluate: () => ({ out: table([]) }),
      }),
    ).toThrow(/declares `rerunsInputs` but is not `expensive`/)
  })
})
