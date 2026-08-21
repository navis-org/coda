/**
 * Table from URL.
 *
 * The parse is `data/csv.ts` and the shaping is the upload node's pair, both covered elsewhere,
 * so what is left here is everything that follows from this being a *fetch*:
 *
 *  - it must not fire on the cheap pass, because the URL is a text field (invariant 6);
 *  - a file at a URL can change under a fixed set of params, which is the hidden mutable state
 *    invariant 4 requires a nonce for — so `refresh` has to actually force a re-fetch, and
 *    everything else has to actually reuse the cache;
 *  - the shape is the server's, so it reaches downstream pickers only by observation;
 *  - and every refusal has to say something a person can act on, which for the cross-origin
 *    case means admitting that the browser did not tell us either.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { addEdge, addNode, emptyGraph, setNodeParam } from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { availableColumns, defaultParams } from '../../core/node'
import { requireNodeDef } from '../../core/registry'
import { Scheduler } from '../../core/scheduler'
import { columnNames, schemaOf } from '../../core/types'
import { isTableValue } from '../../core/values'
import { MAX_UPLOAD_BYTES } from '../../data/uploads'
import '../index'
import { resetFetchedSchemas } from './fromUrl'

const URL_ = 'https://example.org/annotations.csv'
const CSV = 'root_id,cellType,cluster\n101,LC4,3\n102,LC6,1\n'

/** A Response good enough for what `evaluate` touches, and no more. */
function ok(body: string, headers: Record<string, string> = {}): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    text: () => Promise.resolve(body),
  } as unknown as Response
}

let fetchMock: ReturnType<typeof vi.fn>

function serve(...responses: Array<Response | Error>) {
  fetchMock = vi.fn(() => {
    const next = responses.length > 1 ? responses.shift()! : responses[0]!
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
  })
  vi.stubGlobal('fetch', fetchMock)
}

function makeScheduler(): Scheduler {
  return new Scheduler({
    resolveSource: (id) => {
      throw new Error(`this node must not reach a source (asked for ${id})`)
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

/** url → sort, so there is something downstream to observe. */
function pipeline(params: Record<string, unknown> = {}): CodaGraph {
  let g = emptyGraph('url-test')
  g = addNode(g, node('url', 'core.tableFromUrl', { url: URL_, ...params }))
  g = addNode(g, node('sort', 'core.sort', { column: 'cellType' }))
  g = addEdge(g, { source: 'url', sourceHandle: 'out', target: 'sort', targetHandle: 'in' })
  return g
}

beforeEach(() => {
  serve(ok(CSV))
  // The session mirror is module state, so without this each case inherits what the last one
  // fetched — and every "before the first run" assertion would silently be testing "after".
  resetFetchedSchemas()
})
afterEach(() => vi.unstubAllGlobals())

describe('core.tableFromUrl — fetching', () => {
  it('reads the file and emits it as a table', async () => {
    const scheduler = makeScheduler()
    await scheduler.run(pipeline(), { mode: 'full' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![0]).toBe(URL_)
    const out = scheduler.output('url', 'out')
    if (!isTableValue(out)) throw new Error('expected a table')
    expect(out.length).toBe(2)
    expect(columnNames(out.schema)).toEqual(['root_id', 'cellType', 'cluster'])
  })

  it('renames the ID column and reads a chosen column as text', async () => {
    const scheduler = makeScheduler()
    await scheduler.run(pipeline({ idColumn: 'root_id', textColumns: ['cluster'] }), {
      mode: 'full',
    })
    const out = scheduler.output('url', 'out')
    if (!isTableValue(out)) throw new Error('expected a table')
    // The same shaping pair the upload node uses, so the two nodes cannot drift on what an
    // ID column or a text column means.
    expect(out.kind).toBe('neurons')
    expect(out.data['neuronId']).toEqual([101, 102])
    expect(out.data['cluster']).toEqual(['3', '1'])
  })

  it('is expensive, so typing a URL cannot fire a request', async () => {
    // Invariant 6, in its plainest form: this param is a text field aimed at an arbitrary host.
    expect(requireNodeDef('core.tableFromUrl').cost).toBe('expensive')
    const scheduler = makeScheduler()
    const summary = await scheduler.run(pipeline(), { mode: 'auto' })
    expect(summary.executed).not.toContain('url')
    expect(summary.deferred).toContain('url')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('core.tableFromUrl — the shape is the server’s', () => {
  it('publishes no columns before it has run, and the file’s columns after', async () => {
    // Same lifetime an observed schema has: unknown until a run and unknown again after a
    // reload. A bare table still types the socket, so the wire connects meanwhile.
    const graph = pipeline()
    expect(schemaOf(inferGraph(graph).nodes['url']?.outputs['out'])).toBeUndefined()

    const scheduler = makeScheduler()
    await scheduler.run(graph, { mode: 'full' })

    // Plain `inferGraph`, with nothing fed back in: the schema is remembered per URL, so every
    // caller reads it from one place — inference, validate, `ctx.columns` and the scheduler's
    // own key resolution alike. That is what keeps `Text columns` honest.
    const after = inferGraph(graph)
    expect(columnNames(schemaOf(after.nodes['url']?.outputs['out']))).toEqual([
      'root_id',
      'cellType',
      'cluster',
    ])
    // Which is the point: a picker on the node downstream can now be filled in.
    expect(columnNames(schemaOf(after.nodes['sort']?.outputs['out']))).toContain('cellType')
  })

  it('fills both of its own pickers once something has been fetched', async () => {
    const def = requireNodeDef('core.tableFromUrl')
    const idParam = def.params?.find((p) => p.id === 'idColumn')
    const textParam = def.params?.find((p) => p.id === 'textColumns')
    if (idParam?.kind !== 'enum' || typeof idParam.options !== 'function') {
      throw new Error('idColumn is not a dynamic enum')
    }
    if (textParam?.kind !== 'columns') throw new Error('textColumns is not a columns param')

    const ctx = { params: { url: URL_ } } as never
    // Before anything is fetched neither can offer a thing, and that is honest rather than broken.
    expect(idParam.options(ctx).map((o) => o.value)).toEqual([''])
    expect(availableColumns(textParam, {}, { url: URL_ })).toEqual([])

    await makeScheduler().run(pipeline(), { mode: 'full' })

    // `cluster` is i64, so it is offered as an id; a float column would not be.
    expect(idParam.options(ctx).map((o) => o.value)).toEqual([
      '',
      'root_id',
      'cellType',
      'cluster',
    ])
    // And the Text columns picker has something to pick — the whole reason the schema lives in
    // a map every caller can read rather than in `ctx.observed`, which `schemaFrom` cannot see.
    expect(availableColumns(textParam, {}, { url: URL_ })).toEqual([
      'root_id',
      'cellType',
      'cluster',
    ])
  })

  it('keys the schema by URL, so a node pointed elsewhere claims nothing', async () => {
    await makeScheduler().run(pipeline(), { mode: 'full' })
    const elsewhere = pipeline({ url: 'https://example.org/other.csv' })
    expect(schemaOf(inferGraph(elsewhere).nodes['url']?.outputs['out'])).toBeUndefined()
  })
})

describe('core.tableFromUrl — provenance', () => {
  it('does not re-fetch for a graph that has not changed', async () => {
    const scheduler = makeScheduler()
    const graph = pipeline()
    await scheduler.run(graph, { mode: 'full' })
    await scheduler.run(graph, { mode: 'full' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('re-fetches when Refresh is bumped, which is the only thing that can', async () => {
    // Cache keys are provenance, so a file changing under a fixed URL is invisible to them.
    // This is the escape hatch invariant 4 requires, same as the Dataset node's own `refresh`.
    serve(ok(CSV), ok('root_id,cellType,cluster\n999,DNp01,7\n'))
    const scheduler = makeScheduler()
    const graph = pipeline()
    await scheduler.run(graph, { mode: 'full' })

    const bumped = setNodeParam(graph, 'url', 'refresh', 1)
    scheduler.refreshStates(bumped)
    expect(scheduler.info('url').state).toBe('stale')

    await scheduler.run(bumped, { mode: 'full' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const out = scheduler.output('url', 'out')
    if (!isTableValue(out)) throw new Error('expected a table')
    expect(out.data['root_id']).toEqual([999])
  })

  it('a new URL invalidates the node and everything after it', async () => {
    const scheduler = makeScheduler()
    const graph = pipeline()
    await scheduler.run(graph, { mode: 'full' })
    expect(scheduler.info('sort').state).toBe('ok')

    const moved = setNodeParam(graph, 'url', 'url', 'https://example.org/other.csv')
    scheduler.refreshStates(moved)
    expect(scheduler.info('url').state).toBe('stale')
  })

  it('keeps a chosen text column in the key before the first run', async () => {
    // The observed schema is empty until it has run, so a `columns` param that dropped what it
    // could not see would key the node one way before the fetch and another way after — and
    // re-fetch, at a shared host, on the run it had just finished.
    const scheduler = makeScheduler()
    const graph = pipeline({ textColumns: ['cluster'] })
    await scheduler.run(graph, { mode: 'full' })
    expect(scheduler.info('url').state).toBe('ok')

    const out = scheduler.output('url', 'out')
    if (!isTableValue(out)) throw new Error('expected a table')
    expect(out.data['cluster']).toEqual(['3', '1'])

    // And after the schema is known, it is still ok: nothing about the key moved.
    scheduler.refreshStates(graph, inferGraph(graph))
    expect(scheduler.info('url').state).toBe('ok')
    expect((await scheduler.run(graph, { mode: 'full' })).executed).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('core.tableFromUrl — validation', () => {
  const issues = (params: Record<string, unknown>) =>
    (inferGraph(pipeline(params)).nodes['url']?.issues ?? []).map((i) => i.message).join(' ')

  it('asks for a URL when there is none', () => {
    expect(issues({ url: '' })).toContain('No URL yet')
  })

  it('refuses text that is not a URL, and a scheme that cannot be fetched', () => {
    expect(issues({ url: 'annotations.csv' })).toContain('is not a URL')
    expect(issues({ url: 'file:///Users/me/annotations.csv' })).toContain('Only http and https')
    // `javascript:` is refused by the same rule rather than by a special case.
    expect(issues({ url: 'javascript:alert(1)' })).toContain('Only http and https')
  })

  it('warns about http rather than refusing it', () => {
    // A warning, not a refusal — the same call `Find Neurons` makes about `limit: 0`. Whether
    // it is actually blocked depends on how this app is served, which is not knowable here.
    const reported = inferGraph(pipeline({ url: 'http://example.org/a.csv' })).nodes['url']
      ?.issues
    expect(reported).toHaveLength(1)
    expect(reported?.[0]?.severity).toBe('warning')
  })

  it('says nothing about a perfectly good https URL', () => {
    expect(issues({})).toBe('')
  })

  it('never complains about the ID column, which it cannot yet see', () => {
    // The observed schema is empty on every load, so a check here would fire on every graph
    // that uses this node, every time. `evaluate` reports it instead, with the table in hand.
    expect(issues({ idColumn: 'nonesuch' })).toBe('')
  })
})

describe('core.tableFromUrl — refusals', () => {
  async function errorFrom(graph: CodaGraph): Promise<string> {
    const scheduler = makeScheduler()
    await scheduler.run(graph, { mode: 'full' })
    expect(scheduler.info('url').state).toBe('error')
    // Downstream is blocked rather than running on nothing.
    expect(scheduler.info('sort').state).toBe('blocked')
    return scheduler.info('url').error ?? ''
  }

  it('names both causes of an opaque fetch failure', async () => {
    // A browser reports a cross-origin refusal as a bare TypeError with no detail, so a
    // network failure and a CORS failure are indistinguishable from here. Naming only one
    // would send somebody to check their wifi over a header their server never sent.
    serve(new TypeError('Failed to fetch'))
    const message = await errorFrom(pipeline())
    expect(message).toContain('cross-origin')
    expect(message).toContain('Access-Control-Allow-Origin')
  })

  it('reports the status a server actually sent', async () => {
    serve({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: { get: () => null },
      text: () => Promise.resolve(''),
    } as unknown as Response)
    expect(await errorFrom(pipeline())).toContain('404 Not Found')
  })

  it('refuses on Content-Length before reading the body', async () => {
    // The cheap check, made while it is still cheap. Reading first is reading a gigabyte.
    serve({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {
        get: (k: string) => (k.toLowerCase() === 'content-length' ? '999999999' : null),
      },
      text: () => Promise.reject(new Error('the body must not be read')),
    } as unknown as Response)
    const message = await errorFrom(pipeline())
    expect(message).toMatch(/over the \d+ MB limit/)
    expect(message).not.toContain('must not be read')
  })

  it('still refuses an oversized body a chunked response never declared', async () => {
    // One line over, so the check refuses before the parse rather than after it.
    serve(ok('a,b\n'.repeat(MAX_UPLOAD_BYTES / 4 + 1)))
    expect(await errorFrom(pipeline())).toMatch(/over the \d+ MB limit/)
  })

  it('quotes what arrived when a 200 turns out to be an error page', async () => {
    // The common case by far: a login redirect or an S3 permission page served as 200. "No
    // rows" alone sends somebody to look at a file that is fine.
    serve(ok('<!DOCTYPE html><html><head><title>Sign in</title></head>'))
    const message = await errorFrom(pipeline())
    expect(message).toContain('no rows')
    expect(message).toContain('<!DOCTYPE html>')
  })

  it('names the columns it did get when the ID column is wrong', async () => {
    const message = await errorFrom(pipeline({ idColumn: 'neuronId' }))
    expect(message).toContain('neuronId')
    expect(message).toContain('root_id')
  })
})
