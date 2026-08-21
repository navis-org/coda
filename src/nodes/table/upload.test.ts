/**
 * The Upload Table node.
 *
 * The node itself is thin — one IndexedDB read and two column transforms — so what is worth
 * pinning is everything around it, all of which follows from the rows living outside the graph:
 *
 *  - **The schema reaches inference through a peek.** `inferOutputs` may not await, so a cold
 *    graph publishes `T.table()` and fills in when the read lands. Both halves are asserted,
 *    because the second one arriving is what makes every column picker downstream work.
 *  - **The ID column is a rename, not a tag.** Nodes address columns by name, so a file whose
 *    author wrote `root_id` cannot reach Profile or Skeletons until it is called `neuronId`.
 *  - **Missing rows are an instruction, not a crash.** This is what a graph opened on another
 *    machine does, and the message has to name the file rather than the content hash.
 *  - **The content address is the provenance.** Re-picking the same file must re-run nothing;
 *    a different file must invalidate. There is no `refresh` nonce holding that up.
 */

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { addEdge, addNode, emptyGraph, setNodeParam } from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { defaultParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { column, columnNames, schemaOf, tableSchema } from '../../core/types'
import type { TableValue } from '../../core/values'
import { isTableValue, tableFromRows } from '../../core/values'
import { putUpload, resetUploads, uploadPeekSettled } from '../../data/uploads'
import '../index'

const ANNOTATIONS = tableSchema(
  column('root_id', 'i64'),
  column('cellType', 'str'),
  column('cluster', 'i64'),
)

function annotations(): TableValue {
  return tableFromRows(ANNOTATIONS, [
    { root_id: 101, cellType: 'LC4', cluster: 3 },
    { root_id: 102, cellType: 'LC6', cluster: 1 },
    { root_id: 103, cellType: 'LC4', cluster: 3 },
  ])
}

function makeScheduler(): Scheduler {
  return new Scheduler({
    resolveSource: (id) => {
      throw new Error(`the upload node must not reach a source (asked for ${id})`)
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

/** upload → sort, so there is something downstream to observe being invalidated. */
function pipeline(params: Record<string, unknown> = {}): CodaGraph {
  let g = emptyGraph('upload-test')
  g = addNode(g, node('up', 'core.uploadTable', params))
  g = addNode(g, node('sort', 'core.sort', { column: 'cellType' }))
  g = addEdge(g, { source: 'up', sourceHandle: 'out', target: 'sort', targetHandle: 'in' })
  return g
}

async function stored(name = 'annotations.csv'): Promise<string> {
  return putUpload(name, annotations(), 128)
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  resetUploads()
})

describe('core.uploadTable — inference', () => {
  it('publishes a bare table before the peek can answer, rather than nothing', async () => {
    const id = await stored()
    // The cold path a reload takes: a reference in the graph and an empty session mirror.
    resetUploads()
    const out = inferGraph(pipeline({ dataId: id })).nodes['up']?.outputs['out']
    // A typed socket with no columns still connects; publishing nothing would refuse the wire.
    expect(out?.kind).toBe('table')
    expect(schemaOf(out)).toBeUndefined()
  })

  it('advertises the file’s columns once the peek has landed', async () => {
    const id = await stored()
    const out = inferGraph(pipeline({ dataId: id })).nodes['up']?.outputs['out']
    expect(columnNames(schemaOf(out))).toEqual(['root_id', 'cellType', 'cluster'])
  })

  it('renames the ID column and calls the result Neurons', async () => {
    const id = await stored()
    const out = inferGraph(pipeline({ dataId: id, idColumn: 'root_id' })).nodes['up']?.outputs[
      'out'
    ]
    // Both halves matter: the name is what Profile and Skeletons look for, and the kind is
    // what lets the wire reach a Neurons socket at all.
    expect(out?.kind).toBe('neurons')
    expect(columnNames(schemaOf(out))).toEqual(['neuronId', 'cellType', 'cluster'])
  })

  it('stays a plain table with no ID column chosen', async () => {
    const id = await stored()
    const out = inferGraph(pipeline({ dataId: id })).nodes['up']?.outputs['out']
    expect(out?.kind).toBe('table')
  })

  it('reaches the schema downstream, which is the point of the peek', async () => {
    const id = await stored()
    const sorted = inferGraph(pipeline({ dataId: id, idColumn: 'root_id' })).nodes['sort']
    expect(columnNames(schemaOf(sorted?.outputs['out']))).toContain('neuronId')
  })

  it('offers only identifier-shaped columns as the ID column', async () => {
    const id = await stored()
    const def = requireNodeDef('core.uploadTable')
    const param = def.params?.find((p) => p.id === 'idColumn')
    if (param?.kind !== 'enum' || typeof param.options !== 'function') {
      throw new Error('idColumn is not a dynamic enum')
    }
    const ctx = { params: { dataId: id } } as never
    const values = param.options(ctx).map((o) => o.value)
    // '' is "none (plain table)". A float is a measurement and a bool is a flag; neither can
    // be a neuron id, and offering them invites a Neurons table whose ids are neither.
    expect(values).toEqual(['', 'root_id', 'cellType', 'cluster'])
  })
})

describe('core.uploadTable — validation', () => {
  const issues = (g: CodaGraph) =>
    (inferGraph(g).nodes['up']?.issues ?? []).map((i) => i.message)

  it('asks for a file when there is none', () => {
    expect(issues(pipeline()).join(' ')).toContain('No file chosen')
  })

  it('says nothing at all while the peek has not settled', async () => {
    // Otherwise "not stored in this browser" lands on every card for the first frames of
    // every single load, which is how a real message stops being read.
    const id = await stored()
    resetUploads()
    expect(issues(pipeline({ dataId: id }))).toEqual([])
  })

  it('names the file once the peek has settled on nothing', async () => {
    const id = await stored()
    // A different browser: the reference survives in the graph, the rows do not.
    globalThis.indexedDB = new IDBFactory()
    resetUploads()
    const g = pipeline({ dataId: id, fileName: 'annotations.csv' })
    inferGraph(g)
    await vi.waitFor(() => expect(uploadPeekSettled(id)).toBe(true))
    expect(issues(g).join(' ')).toContain('annotations.csv')
  })

  it('reports an ID column the file does not have', async () => {
    const id = await stored()
    expect(issues(pipeline({ dataId: id, idColumn: 'neuronId' })).join(' ')).toContain('neuronId')
  })
})

describe('core.uploadTable — evaluate', () => {
  it('emits the stored rows, renamed', async () => {
    const id = await stored()
    const scheduler = makeScheduler()
    await scheduler.run(pipeline({ dataId: id, idColumn: 'root_id' }), { mode: 'full' })

    const out = scheduler.output('up', 'out')
    if (!isTableValue(out)) throw new Error('expected a table')
    expect(out.kind).toBe('neurons')
    expect(out.length).toBe(3)
    expect(out.data['neuronId']).toEqual([101, 102, 103])
    expect(out.data['cellType']).toEqual(['LC4', 'LC6', 'LC4'])
  })

  it('reads a chosen column as text without touching the rest', async () => {
    const id = await stored()
    const scheduler = makeScheduler()
    await scheduler.run(pipeline({ dataId: id, textColumns: ['cluster'] }), { mode: 'full' })

    const out = scheduler.output('up', 'out')
    if (!isTableValue(out)) throw new Error('expected a table')
    expect(out.schema.columns.map((c) => `${c.name}:${c.dtype}`)).toEqual([
      'root_id:i64',
      'cellType:str',
      'cluster:str',
    ])
    // A cluster id is a label, not a quantity — this is what keeps it out of the numeric
    // pickers where it could drive a size encoding or be averaged.
    expect(out.data['cluster']).toEqual(['3', '1', '3'])
  })

  it('blames the file, not the hash, when the rows are not in this browser', async () => {
    const id = await stored()
    resetUploads()
    globalThis.indexedDB = new IDBFactory()

    const scheduler = makeScheduler()
    const graph = pipeline({ dataId: id, fileName: 'annotations.csv' })
    await scheduler.run(graph, { mode: 'full' })

    const info = scheduler.info('up')
    expect(info.state).toBe('error')
    // The message is what somebody opening a shared graph reads, so it names the file and
    // says what to do. The content hash is not something anyone can act on.
    expect(info.error).toContain('annotations.csv')
    expect(info.error).toMatch(/pick the file again/i)
    expect(info.error).not.toContain(id)
    // Downstream is blocked rather than running on nothing.
    expect(scheduler.info('sort').state).toBe('blocked')
  })

  it('refuses an ID column the file does not have, listing what it does', async () => {
    const id = await stored()
    const scheduler = makeScheduler()
    await scheduler.run(pipeline({ dataId: id, idColumn: 'neuronId' }), { mode: 'full' })
    const error = scheduler.info('up').error ?? ''
    expect(error).toContain('neuronId')
    expect(error).toContain('root_id')
  })
})

describe('core.uploadTable — provenance', () => {
  it('re-picking the same file re-runs nothing', async () => {
    // The content address doing its job: two imports of one file produce the same params, so
    // the key is unchanged and nothing downstream is disturbed.
    const first = await stored('annotations.csv')
    const scheduler = makeScheduler()
    const graph = pipeline({ dataId: first, fileName: 'annotations.csv' })
    await scheduler.run(graph, { mode: 'full' })

    const again = await putUpload('annotations-copy.csv', annotations(), 128)
    expect(again).toBe(first)
    scheduler.refreshStates(setNodeParam(graph, 'up', 'dataId', again))
    expect(scheduler.info('up').state).toBe('ok')
  })

  it('a different file invalidates the node and everything after it', async () => {
    const id = await stored()
    const scheduler = makeScheduler()
    const graph = pipeline({ dataId: id })
    await scheduler.run(graph, { mode: 'full' })
    expect(scheduler.info('sort').state).toBe('ok')

    const other = await putUpload(
      'other.csv',
      tableFromRows(ANNOTATIONS, [{ root_id: 999, cellType: 'DNp01', cluster: 2 }]),
      64,
    )
    const changed = setNodeParam(graph, 'up', 'dataId', other)
    scheduler.refreshStates(changed)
    expect(scheduler.info('up').state).toBe('stale')

    await scheduler.run(changed, { mode: 'full' })
    const out = scheduler.output('up', 'out')
    if (!isTableValue(out)) throw new Error('expected a table')
    expect(out.data['root_id']).toEqual([999])
  })

  it('the filename is a label, not provenance', async () => {
    // It exists so the card and the error can name something actionable. Two people importing
    // the same file under different names must not get two different cache entries.
    const id = await stored()
    const scheduler = makeScheduler()
    const graph = pipeline({ dataId: id, fileName: 'annotations.csv' })
    await scheduler.run(graph, { mode: 'full' })

    const renamed = setNodeParam(graph, 'up', 'fileName', 'something-else.csv')
    scheduler.refreshStates(renamed)
    expect(scheduler.info('up').state).toBe('ok')
    expect((await scheduler.run(renamed, { mode: 'full' })).executed).toEqual([])
  })

  it('changing what a column means does re-run it', async () => {
    const id = await stored()
    const scheduler = makeScheduler()
    const graph = pipeline({ dataId: id })
    await scheduler.run(graph, { mode: 'full' })

    const text = setNodeParam(graph, 'up', 'textColumns', ['cluster'])
    scheduler.refreshStates(text)
    expect(scheduler.info('up').state).toBe('stale')
  })
})
