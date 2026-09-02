/**
 * The Input IDs node.
 *
 * The parse lives in `idList.ts` and is covered there, so this is about the node's own shape —
 * and nearly all of that follows from the Dataset input being **optional**:
 *
 *  - unwired it must reach no source at all, which is what makes "paste ids, draw skeletons" a
 *    two-node graph rather than a query;
 *  - wired it must ask for exactly those ids, and the seam has to carry them as numbers, since
 *    the obvious reuse (`LabelMatch`) compiles to string literals and silently matches nothing;
 *  - the advertised schema has to be the one `evaluate` actually returns in *both* cases, or a
 *    downstream picker fills with columns that never arrive;
 *  - and an empty list must never become an unbounded `MATCH (n:Neuron)`.
 *
 * The status filter's *absence* is asserted too. Every other query node here defaults to
 * `Traced`, and inheriting that would drop a neuron somebody named by id and then report it as
 * missing from the dataset.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { defaultParams } from '../../core/node'
import type { EvalContext, ParamValues } from '../../core/node'
import { inputPorts, outputPorts } from '../../core/ports'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { columnNames, schemaOf, column, tableSchema } from '../../core/types'
import type { TableValue, Value } from '../../core/values'
import { isTableValue, tableFromRows } from '../../core/values'
import { MockSource } from '../../data/mock/MockSource'
import type { DataSource, FindNeuronsRequest } from '../../data/source'

import '../index'

const DATASET = 'optic-lobe-mini'

let source: DataSource
let findNeurons: ReturnType<typeof vi.fn>

beforeEach(() => {
  const mock = new MockSource({ latencyMs: 0 })
  // Spied rather than replaced: the assertions are about *what is asked for*, and answering
  // from a stub would stop proving that a real source honours it.
  findNeurons = vi.fn((req: FindNeuronsRequest) =>
    MockSource.prototype.findNeurons.call(mock, req),
  )
  source = Object.assign(Object.create(Object.getPrototypeOf(mock) as object), mock, {
    findNeurons,
  }) as DataSource
})

function makeScheduler(): Scheduler {
  return new Scheduler({
    resolveSource: (id) => {
      if (id !== 'mock') throw new Error(`unexpected source ${id}`)
      return source
    },
  })
}

function node(id: string, type: string, params: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    params: { ...defaultParams(requireNodeDef(type)), ...params } as GraphNode['params'],
  }
}

/** ids → sort, with a Dataset wired only when asked for. */
function pipeline(params: Record<string, unknown> = {}, withDataset = false): CodaGraph {
  let g = emptyGraph('input-ids-test')
  g = addNode(g, node('ids', 'neuron.inputIds', params))
  g = addNode(g, node('sort', 'core.sort', { column: 'neuronId' }))
  g = addEdge(g, { source: 'ids', sourceHandle: 'neurons', target: 'sort', targetHandle: 'in' })
  if (withDataset) {
    g = addNode(g, node('ds', 'neuron.dataset', { dataset: DATASET }))
    g = addEdge(g, {
      source: 'ds',
      sourceHandle: 'dataset',
      target: 'ids',
      targetHandle: 'dataset',
    })
  }
  return g
}

/** Some real ids from the mock connectome, so the lookup has something to find. */
async function realIds(count: number): Promise<string[]> {
  const table = await new MockSource({ latencyMs: 0 }).findNeurons({ datasetId: DATASET })
  return (table.data['neuronId'] ?? []).slice(0, count).map(String)
}

describe('neuron.inputIds — without a dataset', () => {
  it('emits the typed ids and asks nobody anything', async () => {
    const scheduler = makeScheduler()
    await scheduler.run(pipeline({ ids: '1234, 5678\n9012' }), { mode: 'full' })

    const out = scheduler.output('ids', 'neurons')
    if (!isTableValue(out)) throw new Error('expected a table')
    expect(out.kind).toBe('neurons')
    expect(columnNames(out.schema)).toEqual(['neuronId'])
    // Numbers, because this branch builds the table itself and `ID_ONLY_SCHEMA` says `i64`.
    expect(out.data['neuronId']).toEqual([1234, 5678, 9012])
    // The whole point of the optional input: no dataset, no query, ids that need not exist.
    expect(findNeurons).not.toHaveBeenCalled()
  })

  it('advertises the one column it will actually produce', () => {
    // Advertising `type` here would fill a picker downstream with a column nothing ever
    // delivers — invariant 3's failure, arrived at through the wiring rather than an op.
    const out = inferGraph(pipeline()).nodes['ids']?.outputs['neurons']
    expect(out?.kind).toBe('neurons')
    expect(columnNames(schemaOf(out))).toEqual(['neuronId'])
  })

  it('is a Neurons table, so it reaches the nodes a list of ids is for', () => {
    // Connectivity, Skeletons, Meshes, Synapses and ROI Counts all read `neuronId` and nothing
    // else off the row, which is why the id column alone is a complete input for them.
    let g = pipeline({ ids: '1234' })
    g = addNode(g, node('skel', 'neuron.skeletons'))
    g = addNode(g, node('ds', 'neuron.dataset', { dataset: DATASET }))
    g = addEdge(g, {
      source: 'ds',
      sourceHandle: 'dataset',
      target: 'skel',
      targetHandle: 'dataset',
    })
    g = addEdge(g, {
      source: 'ids',
      sourceHandle: 'neurons',
      target: 'skel',
      targetHandle: 'neurons',
    })
    const issues = inferGraph(g).nodes['skel']?.issues ?? []
    expect(issues.filter((i) => i.severity === 'error')).toEqual([])
  })

  it('is empty rather than everything when nothing is typed', async () => {
    const scheduler = makeScheduler()
    await scheduler.run(pipeline({ ids: '' }), { mode: 'full' })
    const out = scheduler.output('ids', 'neurons')
    if (!isTableValue(out)) throw new Error('expected a table')
    expect(out.length).toBe(0)
    // An empty table of the *right shape*, so a picker downstream works before anything is typed.
    expect(columnNames(out.schema)).toEqual(['neuronId'])
  })
})

describe('neuron.inputIds — with a dataset', () => {
  it('asks for exactly those ids, as exact decimal text', async () => {
    const ids = await realIds(2)
    const scheduler = makeScheduler()
    await scheduler.run(pipeline({ ids: ids.join(', ') }, true), { mode: 'full' })

    expect(findNeurons).toHaveBeenCalledTimes(1)
    const req = findNeurons.mock.calls[0]![0] as FindNeuronsRequest
    /*
     * Text, not numbers — a `NeuronId` crosses the seam as digits so an id of any width
     * survives it. Note what this does *not* license: the id still reaches Cypher unquoted,
     * because `idList` splices the digits in as an integer literal. `n.bodyId IN ['123']` is
     * false in Neo4j, and that is an empty result with no error anywhere to explain it.
     */
    expect(req.neuronIds).toEqual(ids)
    expect(req.neuronIds?.every((v) => typeof v === 'string')).toBe(true)
  })

  it('does not filter by status, unlike every other query node here', async () => {
    // Inheriting the usual `Traced` default would drop a neuron somebody named by id — and
    // then report that id as missing from the dataset, which is worse than dropping it. Now
    // that a status is an ordinary filter row, "no status filter" means "no rows at all".
    const ids = await realIds(2)
    const scheduler = makeScheduler()
    await scheduler.run(pipeline({ ids: ids.join(' ') }, true), { mode: 'full' })
    const req = findNeurons.mock.calls[0]![0] as FindNeuronsRequest
    expect(req.rows ?? []).toEqual([])
  })

  it('returns the full neuron rows, not just the ids back', async () => {
    const ids = await realIds(3)
    const scheduler = makeScheduler()
    await scheduler.run(pipeline({ ids: ids.join(', ') }, true), { mode: 'full' })

    const out = scheduler.output('ids', 'neurons')
    if (!isTableValue(out)) throw new Error('expected a table')
    expect(out.length).toBe(3)
    expect(columnNames(out.schema)).toContain('type')
    expect(columnNames(out.schema)).toContain('status')
    // Compared as text on both sides: `realIds` is exact decimal text, and the result's own
    // `neuronId` is whatever dtype the source publishes.
    expect(new Set((out.data['neuronId'] ?? []).map(String))).toEqual(new Set(ids))
  })

  it('advertises the dataset’s schema the moment one is wired', () => {
    const names = columnNames(
      schemaOf(inferGraph(pipeline({}, true)).nodes['ids']?.outputs['neurons']),
    )
    expect(names).toContain('neuronId')
    expect(names).toContain('type')
  })

  it('never turns an empty list into a query for everything', async () => {
    // The inversion `IDs from Label` documents: a pattern narrowing nothing is everything, a
    // lookup of nothing is nothing. An unconfigured node must not fire `MATCH (n:Neuron)`.
    const scheduler = makeScheduler()
    await scheduler.run(pipeline({ ids: '' }, true), { mode: 'full' })
    expect(findNeurons).not.toHaveBeenCalled()

    const out = scheduler.output('ids', 'neurons')
    if (!isTableValue(out)) throw new Error('expected a table')
    expect(out.length).toBe(0)
    // Still the dataset's schema, because that is what was advertised.
    expect(columnNames(out.schema)).toContain('type')
  })

  it('quietly returns fewer rows for an id the dataset does not have', async () => {
    // Not an error: asking about a neuron that is not there is a real question with a real
    // answer. The card is what reports the miss, by reading the result back.
    const ids = await realIds(1)
    const scheduler = makeScheduler()
    await scheduler.run(pipeline({ ids: `${ids[0]}, 99999999` }, true), { mode: 'full' })
    expect(scheduler.info('ids').state).toBe('ok')
    const out = scheduler.output('ids', 'neurons')
    if (!isTableValue(out)) throw new Error('expected a table')
    expect(out.length).toBe(1)
  })
})

describe('neuron.inputIds — the wired IDs table', () => {
  /** ids(typed) ← a Find Neurons result on the same graph. */
  async function unioned(typed: string): Promise<number[]> {
    let g = emptyGraph('union')
    g = addNode(g, node('ds', 'neuron.dataset', { dataset: DATASET }))
    g = addNode(
      g,
      node('find', 'neuron.findNeurons', {
        rows: [{ field: 'type', op: 'matches', values: ['LC4'] }],
        status: 'Traced',
      }),
    )
    g = addNode(g, node('ids', 'neuron.inputIds', { ids: typed }))
    g = addEdge(g, {
      source: 'ds',
      sourceHandle: 'dataset',
      target: 'find',
      targetHandle: 'dataset',
    })
    g = addEdge(g, {
      source: 'find',
      sourceHandle: 'neurons',
      target: 'ids',
      targetHandle: 'ids',
    })

    const scheduler = makeScheduler()
    await scheduler.run(g, { mode: 'full' })
    const out = scheduler.output('ids', 'neurons')
    if (!isTableValue(out)) throw new Error('expected a table')
    return (out.data['neuronId'] ?? []).map(Number)
  }

  it('unions the wired column with the typed list, typed first', async () => {
    const fromWire = await unioned('')
    expect(fromWire.length).toBeGreaterThan(0)

    const both = await unioned('1234')
    expect(both[0]).toBe(1234)
    expect(both.slice(1)).toEqual(fromWire)
  })

  it('does not let a wire silence the text field', async () => {
    // The failure this guards is invisible: the result is a valid neuron table either way, so
    // a node that dropped the typed half the moment a wire arrived would look correct.
    expect(await unioned('1234')).toContain(1234)
  })
})

describe('neuron.inputIds — refusals', () => {
  const issues = (params: Record<string, unknown>) =>
    (inferGraph(pipeline(params)).nodes['ids']?.issues ?? []).map((i) => i.message).join(' ')

  it('reports a bad token while it is being typed, not on the next Run', () => {
    // The parse is pure, so `validate` can run it at edit time. That is the whole reason it is
    // a returned message rather than a throw.
    expect(issues({ ids: '1234, LC4' })).toContain('"LC4"')
  })

  it('says the same sentence from validate and from evaluate', async () => {
    const scheduler = makeScheduler()
    await scheduler.run(pipeline({ ids: '1234, LC4' }), { mode: 'full' })
    expect(scheduler.info('ids').state).toBe('error')
    // Word for word, because both go through `parseIdList`. A badge and an error that describe
    // the same problem differently is how somebody concludes there are two problems.
    expect(scheduler.info('ids').error).toBe(issues({ ids: '1234, LC4' }))
    expect(scheduler.info('sort').state).toBe('blocked')
  })

  it('asks for an eighteen-digit id exactly, where it used to refuse', async () => {
    /*
     * The rule that inverted. This id is a FlyWire root id: `Number()` of it is a *different*
     * integer, so while ids were numbers the only honest thing to do was refuse. Carried as
     * text there is nothing to lose, and the digits reach the source untouched.
     */
    const wide = '720575940379279312'
    const scheduler = makeScheduler()
    await scheduler.run(pipeline({ ids: wide }, true), { mode: 'full' })

    expect(scheduler.info('ids').state).not.toBe('error')
    expect(findNeurons).toHaveBeenCalledTimes(1)
    const req = findNeurons.mock.calls[0]![0] as FindNeuronsRequest
    expect(req.neuronIds).toEqual([wide])
    // The thing the old refusal existed to prevent, asserted directly.
    expect(String(req.neuronIds?.[0])).not.toBe(String(Number(wide)))
  })

  it('warns rather than rounds when a wide id has no dataset to go to', () => {
    // With no Dataset the ids *are* the output, and that table's `neuronId` is an `i64` column —
    // so this is the one place the width still bites, and it says so instead of rounding.
    const issue = issues({ ids: '720575940379279312' })
    expect(issue).toContain('720575940379279312')
    expect(issue).toContain('wire a Dataset')
  })

  it('asks for ids when there are none and nothing is wired', () => {
    expect(issues({ ids: '' })).toContain('No IDs yet')
  })

  it('says nothing about an empty field once a table is wired', () => {
    // The wire is a complete answer on its own, so "No IDs yet" there would be false.
    let g = pipeline({ ids: '' })
    g = addNode(g, node('src', 'core.uploadTable'))
    g = addEdge(g, { source: 'src', sourceHandle: 'out', target: 'ids', targetHandle: 'ids' })
    const reported = (inferGraph(g).nodes['ids']?.issues ?? []).map((i) => i.message)
    expect(reported.join(' ')).not.toContain('No IDs yet')
  })
})

/*
 * The width warning, and why it needs a describe of its own.
 *
 * `validate` covers the ids somebody *typed* — asserted above, at edit time. It cannot cover the
 * ids arriving on the `ids` wire, because it runs against types and the table's contents do not
 * exist yet. So the wired half is only sayable from `evaluate`, and it went unsaid: an 18-digit
 * root id pasted into an Upload node upstream reached `Number()` and came out as a different
 * neuron with nothing anywhere to mention it — invariant 8's failure exactly.
 *
 * Driven through `evaluate` directly rather than through the scheduler, because the point is a
 * table carrying an *exact* 18-digit id, and the only honest way to hold one is a `str` column —
 * which is what an Upload of a CSV, or CAVE's `pt_root_id`, actually hands over.
 */
describe('neuron.inputIds — a wide id on the wire', () => {
  const def = requireNodeDef('neuron.inputIds')

  /** A FlyWire root id: `Number()` of it is a different integer. */
  const WIDE = '720575940379279312'

  /** Ids as text, the shape every source that has wide ones publishes. */
  const idTable = (...ids: string[]): TableValue =>
    tableFromRows(
      tableSchema(column('neuronId', 'str')),
      ids.map((neuronId) => ({ neuronId })),
      'neurons',
    )

  function run(options: {
    inputs?: Record<string, Value | undefined>
    params?: Record<string, unknown>
  }): { warnings: string[]; result: Promise<Record<string, Value>> } {
    const warnings: string[] = []
    const params: ParamValues = {
      ...defaultParams(def),
      ids: '',
      column: 'neuronId',
      ...options.params,
    }
    const context = {
      params,
      refresh: false,
      input: (portId: string) => options.inputs?.[portId],
      inputKey: () => undefined,
      column: (id: string) => String(params[id] ?? '') || undefined,
      columns: (id: string) => (params[id] as string[]) ?? [],
      inputPorts: () => inputPorts(def, params),
      outputPorts: () => outputPorts(def, params),
      // The file's own `MockSource`, so the Dataset-wired case below takes the real lookup path
      // rather than a stub that cannot answer `schemasForDataset`.
      resolveSource: () => source,
      signal: new AbortController().signal,
      progress: () => {},
      warn: (message: string) => warnings.push(message),
      publish: () => {},
      reportFetched: () => {},
    } as unknown as EvalContext
    return { warnings, result: def.evaluate!(context) as Promise<Record<string, Value>> }
  }

  it('says so when a wide id arrives wired, which validate never could', async () => {
    // The regression. Before this, the only mention of a rounded id was `validate`'s, and
    // `validate` reads `ctx.params.ids` — so a wire carried one past every surface in silence.
    const { warnings, result } = run({ inputs: { ids: idTable(WIDE) } })
    await result
    expect(warnings.join(' ')).toContain(WIDE)
    expect(warnings.join(' ')).toContain('rounded')
  })

  it('names the fix, not just the problem', async () => {
    const { warnings, result } = run({ inputs: { ids: idTable(WIDE) } })
    await result
    // Wiring a Dataset is the whole remedy — the id then crosses as text and nothing rounds.
    expect(warnings.join(' ')).toContain('Wire a Dataset')
  })

  it('counts them and names one, rather than repeating itself per id', async () => {
    const { warnings, result } = run({
      inputs: { ids: idTable(WIDE, '720575940379279313', '720575940379279314') },
    })
    await result
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('3 IDs')
    expect(warnings[0]).toContain(WIDE)
  })

  it('still warns for a typed id, so a Run says it and not only the badge', async () => {
    // `validate` says this at edit time; an export or a headless run never asks `validate`, so
    // the same fact has to survive into the run's own warning channel.
    const { warnings, result } = run({ params: { ids: WIDE } })
    await result
    expect(warnings.join(' ')).toContain(WIDE)
  })

  it('is silent about ids that fit', async () => {
    const { warnings, result } = run({ inputs: { ids: idTable('1234', '5678') } })
    await result
    expect(warnings).toEqual([])
  })

  it('says nothing once a Dataset is wired, because nothing rounds there', async () => {
    // The id crosses the seam as text and the source publishes its own dtype, so the ceiling
    // this warns about does not exist on that path. Warning anyway would be a false alarm on
    // the one configuration that is entirely correct.
    const { warnings, result } = run({
      inputs: {
        ids: idTable(WIDE),
        dataset: { kind: 'dataset', sourceId: 'mock', datasetId: DATASET, label: DATASET },
      },
    })
    await result
    expect(warnings.join(' ')).not.toContain('rounded')
  })

  it('reports the wired values that were not ids at all', async () => {
    // `collectIds` counted these all along and the node dropped the count on the floor, so a
    // headless run lost them entirely — the card was the only place it was ever said.
    const { warnings, result } = run({ inputs: { ids: idTable('1234', 'LC4', 'not-an-id') } })
    await result
    expect(warnings.join(' ')).toContain('2 values')
    expect(warnings.join(' ')).toContain('skipped')
  })

  it('rounds rather than dropping, so the list stays the length it was given', async () => {
    /*
     * The deliberate half. Dropping would shorten a list whose entire point is that it is the
     * one the user handed over, and it would contradict `validate`'s "will be rounded" a
     * keystroke earlier. The warning is what makes rounding honest; it is not a licence to
     * quietly do something else instead.
     */
    const { result } = run({ inputs: { ids: idTable(WIDE, '1234') } })
    const out = (await result)['neurons']
    if (!isTableValue(out)) throw new Error('expected a table')
    expect(out.data['neuronId']).toHaveLength(2)
  })
})
