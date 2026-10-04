/**
 * Clio's request shapes against a stub — the only place Clio writes are exercised, since there is
 * no test store to write to and the live one is production. The read shapes were taken from the
 * live store on 2026-10-03.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  resetClioCredentials,
  setClioToken,
  subscribeClioAuthFailure,
  unwrapClioToken,
} from '../clioCredentials'
import { ClioTarget, clioDatasets, parseRecords, resetClioListings, writeBody } from './clio'

const STORE = 'https://clio.example.org'

/** What the dataset's DVID server answers for its schema: CNS's is 200, the male CNS's 403. */
let schemaStatus = 200

interface Call {
  method: string
  path: string
  body?: string
  auth?: string
}

/** A Clio store: the datasets listing, the field list, `query` by `answer`, and writes recorded. */
function serve(answer: (body: string) => string, status = 200, writeStatus = 200): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const path = url.replace(STORE, '')
    const headers = (init.headers ?? {}) as Record<string, string>
    calls.push({
      method: init.method ?? 'GET',
      path,
      ...(typeof init.body === 'string' ? { body: init.body } : {}),
      ...(headers.Authorization ? { auth: headers.Authorization } : {}),
    })
    if (status !== 200) return new Response('{"detail":"no"}', { status })
    if (path === '/v2/datasets') {
      return new Response(
        JSON.stringify({
          CNS: {
            dvid: 'https://dvid.example.org',
            bodyAnnotationSchema: {
              collection: {
                bodyid: { title: 'bodyid' },
                type: { editElement: { type: 'input' } },
                fru_dsx: { editElement: { type: 'input', options: ['fru_high', 'dsx_low'] } },
              },
            },
          },
        }),
      )
    }
    if (
      url === 'https://dvid.example.org/api/node/:master/segmentation_annotations/json_schema'
    ) {
      return schemaStatus === 200
        ? new Response(
            JSON.stringify({
              required: ['bodyid'],
              properties: {
                bodyid: { type: 'integer' },
                group: { type: ['integer', 'null'] },
                type: { type: ['string', 'null'] },
                position: { oneOf: [{ type: 'array' }, { type: 'null' }] },
              },
            }),
          )
        : new Response('<html>403</html>', { status: schemaStatus })
    }
    if (path.endsWith('/neurons/fields?app=coda')) {
      return new Response(
        JSON.stringify([
          'bodyid',
          'type',
          'fru_dsx',
          'type_user',
          'type_time',
          'checked_time',
          'group',
          'position',
        ]),
      )
    }
    if (path.endsWith('/neurons/query?app=coda'))
      return new Response(answer(init.body as string))
    if (path.endsWith('/neurons?app=coda')) {
      return new Response(writeStatus === 200 ? 'null' : '{"detail":"forbidden"}', {
        status: writeStatus,
      })
    }
    return new Response('not stubbed', { status: 404 })
  })
  return calls
}

const target = () => new ClioTarget({ dataset: 'CNS', store: STORE })

beforeEach(() => {
  setClioToken('{"token": "abc"}')
  schemaStatus = 200
})
afterEach(() => {
  vi.unstubAllGlobals()
  resetClioCredentials()
  resetClioListings()
})

describe('a pasted Clio token', () => {
  it('is taken bare, from the JSON document Clio hands out, or with its scheme', () => {
    expect(unwrapClioToken('{"token": "abc"}')).toBe('abc')
    expect(unwrapClioToken('  "abc" ')).toBe('abc')
    expect(unwrapClioToken('Bearer abc')).toBe('abc')
  })
})

describe('a Clio dataset as an annotation target', () => {
  it('reads which fields are editable off the schema, with its options as suggestions, and leaves out Clio’s own stamps', async () => {
    const calls = serve(() => '[]')
    const fields = await target().fields()
    expect(fields).toEqual([
      { name: 'bodyid', kind: 'number', integer: true, readOnly: 'the id' },
      { name: 'type', kind: 'text' },
      { name: 'fru_dsx', kind: 'text', suggestions: ['fru_high', 'dsx_low'] },
      // Ends in `_time` with no `checked` beside it: a field of its own, not a stamp.
      { name: 'checked_time', kind: 'text' },
      // Typed by the DVID schema: a nullable integer, and a position nobody edits as text.
      { name: 'group', kind: 'number', integer: true },
      { name: 'position', kind: 'text', readOnly: 'a position, not edited here' },
    ])
    expect(calls[0]!.auth).toBe('Bearer abc')
    // The schema is DVID's, not Clio's: it is not sent the Clio token.
    expect(calls.find((c) => c.path.includes('json_schema'))!.auth).toBeUndefined()
  })

  it('asks the store for its datasets once, for every field read and the card’s list', async () => {
    const calls = serve(() => '[]')
    await target().fields()
    await new ClioTarget({ dataset: 'CNS', store: STORE }).fields()
    expect(await clioDatasets(STORE)).toEqual(['CNS'])
    expect(calls.filter((c) => c.path === '/v2/datasets')).toHaveLength(1)
  })

  it('leaves every field text where the dataset publishes no schema', async () => {
    // The male CNS's DVID answers 403 and MANC's 404, measured 2026-10-03.
    schemaStatus = 403
    serve(() => '[]')
    const fields = await target().fields()
    expect(fields.find((f) => f.name === 'group')).toEqual({ name: 'group', kind: 'text' })
  })

  it('refuses a fraction for a whole-number field before sending anything', async () => {
    const calls = serve(() => '[{"bodyid":10035,"group":1}]')
    const result = await target().write([
      { key: '10035', field: 'group', value: 1.5, before: 1 },
    ])
    expect(result.failed[0]!.message).toBe('not a whole number')
    expect(calls.some((c) => c.path.endsWith('/neurons?app=coda'))).toBe(false)
  })

  it('asks for bodies by id spelled from their text, and keeps an id too long for a double', async () => {
    // 18 digits: as a JSON number this parses to a different neuron.
    const big = '720575940621522189'
    const calls = serve(() => `[{"bodyid":${big},"type":"LC4"},{"bodyid":10035,"type":null}]`)
    const read = await target().read([big, '10035', 'flywire:1', '99'], ['type'])
    expect(calls.find((c) => c.method === 'POST')!.body).toBe(`{"bodyid":[${big},10035,99]}`)
    expect(read.records).toEqual([
      { key: big, id: big, values: { type: 'LC4' } },
      { key: '10035', id: '10035', values: { type: null } },
    ])
    // Not digits, so never sent; and 99, which Clio holds nothing for.
    expect(read.missing).toEqual(['flywire:1', '99'])
  })

  it('offers an empty record for a body nobody has annotated, and writes to one', async () => {
    expect(target().blank('99', ['type'])).toEqual({
      key: '99',
      id: '99',
      values: { type: null },
    })
    expect(target().blank('flywire:1', ['type'])).toBeUndefined()
    // Clio answers nothing for body 99 — empty, not gone, so the write goes.
    const calls = serve(() => '[]')
    const result = await target().write([
      { key: '99', field: 'type', value: 'LC4', before: null },
    ])
    expect(result.failed).toEqual([])
    expect(result.written).toHaveLength(1)
    expect(calls.find((c) => c.path.endsWith('/neurons?app=coda'))!.body).toBe(
      '[{"bodyid":99,"type":"LC4"}]',
    )
  })

  it('writes each body once with its fields, to the URL clio-py actually sends', async () => {
    const calls = serve(() => '[{"bodyid":10035,"type":"LC4","fru_dsx":null}]')
    const result = await target().write([
      { key: '10035', field: 'type', value: 'LC4a', before: 'LC4' },
      { key: '10035', field: 'fru_dsx', value: 'fru_high', before: null },
    ])
    expect(result.written).toHaveLength(2)
    const write = calls.find((c) => c.path === '/v2/json-annotations/CNS/neurons?app=coda')!
    expect(write).toMatchObject({
      method: 'POST',
      body: '[{"bodyid":10035,"type":"LC4a","fru_dsx":"fru_high"}]',
    })
  })

  it('holds a change whose field moved since it was read, and sends nothing for it', async () => {
    const calls = serve(() => '[{"bodyid":10035,"type":"LC6"}]')
    const result = await target().write([
      { key: '10035', field: 'type', value: 'LC4a', before: 'LC4' },
    ])
    expect(result.conflicts).toEqual([
      { change: expect.objectContaining({ key: '10035' }), now: 'LC6' },
    ])
    expect(calls.some((c) => c.path.endsWith('/neurons?app=coda'))).toBe(false)
  })

  it('sends a rejected token to the Connections panel', async () => {
    serve(() => '[]', 401)
    const heard: string[] = []
    const stop = subscribeClioAuthFailure((m) => heard.push(m))
    await expect(target().fields()).rejects.toThrow(/refused the token \(401\)/)
    stop()
    expect(heard).toHaveLength(1)
  })
})

describe('a write Clio refuses', () => {
  it('fails that batch without asking for a new token', async () => {
    // A 403 on a write is a dataset this account may read and not annotate.
    serve(() => '[{"bodyid":10035,"type":"LC4"}]', 200, 403)
    const heard: string[] = []
    const stop = subscribeClioAuthFailure((m) => heard.push(m))
    const result = await target().write([
      { key: '10035', field: 'type', value: 'LC4a', before: 'LC4' },
    ])
    stop()
    expect(result.failed[0]!.message).toMatch(/read this dataset but not to annotate it/)
    expect(heard).toEqual([])
  })
})

describe('the body-id spelling', () => {
  it('turns every bodyid in a reply to text before parsing', () => {
    expect(parseRecords('[{"bodyid": 720575940621522189, "x": 1}]')).toEqual([
      { bodyid: '720575940621522189', x: 1 },
    ])
  })

  it('leaves an id-shaped string inside a free-text field alone', () => {
    // A one-line regex splices quotes into the string and the whole reply stops parsing.
    expect(parseRecords('[{"bodyid": 10035, "notes": "see \\"bodyid\\":123"}]')).toEqual([
      { bodyid: 10035, notes: 'see "bodyid":123' },
    ])
  })

  it('refuses to write a key that is not a body id', () => {
    expect(() => writeBody(new Map([['flywire:1', { type: 'x' }]]))).toThrow(/Not a body id/)
  })
})
