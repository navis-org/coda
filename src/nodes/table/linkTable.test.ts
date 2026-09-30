/**
 * Link Table and Read Rows, run end to end on files pyarrow wrote (`data/files/__fixtures__`).
 *
 * The seam worth pinning is the one between the two nodes and everything below them: that the
 * file node's type carries the columns every picker needs before any row is read, that Read Rows
 * delivers exactly the schema it promised (invariant 3), and that the two ways a file reaches a
 * reader — a file held by this tab, and a URL read by Range request — answer the same rows.
 */

import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CodaGraph } from '../../core/graph'
import { addEdge, addNode, emptyGraph } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import type { Scheduler } from '../../core/scheduler'
import { attributeSchema, schemaOf } from '../../core/types'
import { isTableFileValue, isTableValue } from '../../core/values'
import {
  holdLocalFile,
  peekTableFile,
  resetTableFiles,
  restoreLocalFile,
} from '../../data/files/registry'
import { sourcelessScheduler } from '../../test/scheduler'
import { node } from '../../test/graph'
import '../index'

const BASE = 720575940600000000n
const FIXTURES = 'src/data/files/__fixtures__/'

function localFile(name: string): { fileId: string; fileName: string } {
  const file = new File([readFileSync(FIXTURES + name)], name)
  return { fileId: holdLocalFile(file), fileName: name }
}

/** `f` opening the file, `r` reading rows out of it with `params`. */
function graph(file: Record<string, unknown>, params: Record<string, unknown> = {}): CodaGraph {
  let g = addNode(emptyGraph('file'), node('f', 'core.linkTable', file))
  g = addNode(g, node('r', 'core.readRows', params))
  return addEdge(g, { source: 'f', sourceHandle: 'file', target: 'r', targetHandle: 'file' })
}

async function run(g: CodaGraph): Promise<Scheduler> {
  const scheduler = sourcelessScheduler()
  await scheduler.run(g, { mode: 'full' })
  return scheduler
}

function issues(g: CodaGraph, id: string): string[] {
  return inferGraph(g).nodes[id]?.issues.map((issue) => issue.message) ?? []
}

beforeEach(() => resetTableFiles())

describe('Link Table', () => {
  it('asks for a file, and names the one this browser does not have', async () => {
    expect(issues(graph({}), 'f')).toContain(
      'Choose a Parquet or Feather file, or paste a URL to one.',
    )
    const forgotten = graph({ fileId: 'file-gone', fileName: 'synapses.parquet' })
    // Silent while remembered handles are looked through — a moment later it may be found.
    expect(issues(forgotten, 'f')).toEqual([])
    await restoreLocalFile('file-gone')
    expect(issues(forgotten, 'f')[0]).toMatch(/file handle for "synapses.parquet" was dropped/)
  })

  it('stops telling a Feather file to be indexed once it is', async () => {
    const g = graph({ ...localFile('synapses.feather'), indexColumns: ['pre_pt_root_id'] })
    await run(g)
    expect(issues(g, 'f')).not.toContainEqual(
      expect.stringMatching(/Feather keeps no statistics/),
    )
  })

  it('types its output from the footer, ids as text, once it has been read', async () => {
    const g = graph(localFile('synapses.parquet'))
    const scheduler = await run(g)
    const value = scheduler.output('f', 'file')
    expect(isTableFileValue(value) && value.rows).toBe(12)
    // What every picker below reads, before a row has been.
    const type = inferGraph(g).nodes['f']?.outputs.file
    expect(attributeSchema(type)?.columns.map((c) => [c.name, c.dtype])).toEqual([
      ['pre_pt_root_id', 'str'],
      ['post_pt_root_id', 'str'],
      ['size', 'i64'],
      ['score', 'f64'],
      ['region', 'str'],
      ['hash', 'str'],
    ])
  })

  it('reads exactly the chosen columns as text when detection is off', async () => {
    const g = graph({
      ...localFile('synapses.parquet'),
      autoText: false,
      textColumns: ['size'],
    })
    await run(g)
    const types = attributeSchema(inferGraph(g).nodes['f']?.outputs.file)?.columns.map(
      (c) => c.dtype,
    )
    expect(types).toEqual(['i64', 'i64', 'str', 'f64', 'str', 'i64'])
  })

  it('warns that a Feather lookup reads the whole file', async () => {
    const g = graph(localFile('synapses.feather'))
    await run(g)
    expect(issues(g, 'f')).toContainEqual(expect.stringMatching(/Feather keeps no statistics/))
  })
})

describe('Read Rows', () => {
  it('reads matching rows, with the schema it promised', async () => {
    const id = String(BASE + 1n)
    const g = graph(localFile('synapses.parquet'), {
      columns: ['pre_pt_root_id', 'size'],
      matchColumn: 'pre_pt_root_id',
      ids: id,
    })
    const scheduler = await run(g)
    const out = scheduler.output('r', 'out')
    expect(isTableValue(out) ? out.data : undefined).toEqual({
      pre_pt_root_id: [id, id, id],
      size: [13, 14, 15],
    })
    // Invariant 3: the picker order, the file's types — the same schema inference published.
    expect(isTableValue(out) && out.schema).toEqual(
      schemaOf(inferGraph(g).nodes['r']?.outputs.out),
    )
  })

  it('reads nothing for a match column with no ids, and says so', async () => {
    const g = graph(localFile('synapses.parquet'), { matchColumn: 'pre_pt_root_id' })
    expect(issues(g, 'r')).toEqual([expect.stringMatching(/With none, nothing is read/)])
    const out = (await run(g)).output('r', 'out')
    expect(isTableValue(out) && out.length).toBe(0)
  })

  it('asks for the IDs table’s column rather than reading as if none were wired', async () => {
    // `r` hands `s` a table whose columns do not include the default `neuronId`.
    let g = graph(localFile('synapses.parquet'), {
      columns: ['size', 'pre_pt_root_id'],
      matchColumn: 'pre_pt_root_id',
      ids: String(BASE + 1n),
    })
    g = addNode(g, node('s', 'core.readRows', { matchColumn: 'post_pt_root_id' }))
    g = addEdge(g, { source: 'f', sourceHandle: 'file', target: 's', targetHandle: 'file' })
    g = addEdge(g, { source: 'r', sourceHandle: 'out', target: 's', targetHandle: 'ids' })
    const scheduler = await run(g)
    const ask =
      'Pick the IDs table’s column holding the ids under ID column — "pre_pt_root_id" looks like it.'
    expect(issues(g, 's')).toContain(ask)
    expect(scheduler.info('s').error).toBe(`The IDs table has no column "neuronId". ${ask}`)
  })

  it('says when it stopped at the row cap', async () => {
    const scheduler = await run(graph(localFile('synapses.parquet'), { limit: 5 }))
    expect(scheduler.warning('r')).toMatch(/row cap of 5/)
  })
})

describe('a URL', () => {
  const URL = 'https://data.example.org/synapses.parquet'
  let ranges = 0
  let caches: (RequestCache | undefined)[] = []

  /** A server holding one file that answers HEAD and Range — or, with `ignoreRange`, sends it all. */
  function serve(bytes: Uint8Array, ignoreRange = false) {
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit = {}) => {
      caches.push(init.cache)
      if (init.method === 'HEAD') {
        return new Response(null, { headers: { 'content-length': String(bytes.byteLength) } })
      }
      const range = new Headers(init.headers).get('Range')
      const match = range && !ignoreRange ? /bytes=(\d+)-(\d+)/.exec(range) : null
      if (!match) return new Response(bytes.slice(), { status: 200 })
      ranges++
      const slice = bytes.slice(Number(match[1]), Number(match[2]) + 1)
      return new Response(slice, { status: 206 })
    })
  }

  beforeEach(() => {
    ranges = 0
    caches = []
  })
  afterEach(() => vi.unstubAllGlobals())

  it('answers the same rows by Range request as from a local file', async () => {
    serve(new Uint8Array(readFileSync(FIXTURES + 'synapses.parquet')))
    const id = String(BASE)
    const scheduler = await run(
      graph({ url: URL }, { columns: ['size'], matchColumn: 'pre_pt_root_id', ids: id }),
    )
    const out = scheduler.output('r', 'out')
    expect(isTableValue(out) ? out.data.size : undefined).toEqual([10, 11, 12])
    expect(ranges).toBeGreaterThan(0)
  })

  it('reads ranges past the HTTP cache, which would take them one at a time', async () => {
    serve(new Uint8Array(readFileSync(FIXTURES + 'synapses.parquet')))
    await run(graph({ url: URL }, { columns: ['size'] }))
    expect(caches.filter((mode) => mode === 'no-store').length).toBeGreaterThan(0)
  })

  it('says a file rewritten on the server has changed, rather than misreading it', async () => {
    serve(new Uint8Array(readFileSync(FIXTURES + 'synapses.parquet')))
    const g = graph({ url: URL }, { columns: ['size'] })
    expect((await run(g)).info('r').error).toBeUndefined()
    // Rewritten at another size: read at the old offsets, this was "not a Parquet or Feather file".
    // The Link Table still holds the footer it read, so the next run's read is refused by it.
    serve(new Uint8Array(readFileSync(FIXTURES + 'synapses.feather')))
    expect((await run(g)).info('r').error).toMatch(/has changed since it was opened/)
  })

  it('reads a URL’s footer when peeked, so a reloaded graph’s pickers fill without a Run', async () => {
    serve(new Uint8Array(readFileSync(FIXTURES + 'synapses.parquet')))
    const ref = { kind: 'url', url: URL } as const
    expect(peekTableFile(ref)).toBeUndefined()
    await vi.waitFor(() => expect(peekTableFile(ref)?.summary?.rows).toBe(12))
  })

  it('refuses a server that ignores Range rather than downloading the whole file', async () => {
    // Past the tail a file is opened with, so the first read asks for part of it: a file that
    // small is read whole on purpose, and a server ignoring Range answers it correctly.
    const fixture = readFileSync(FIXTURES + 'synapses.parquet')
    const padded = new Uint8Array((1 << 17) + fixture.byteLength)
    padded.set(fixture, 1 << 17)
    serve(padded, true)
    const scheduler = await run(graph({ url: URL }))
    expect(scheduler.info('f').error).toMatch(/does not answer range requests/)
  })
})
