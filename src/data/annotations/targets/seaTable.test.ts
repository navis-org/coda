import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetSeaTableCredentials, setToken, subscribeAuthFailure } from '../credentials'
import { forgetSeaTableRoutes } from '../seaTable'
import { SeaTableTarget } from './seaTable'
import { wallClock } from './fieldValues'

const HOST = 'https://tables.example.org'
const UUID = 'base-uuid'

/** What the stub was asked: method, path and the parsed body. */
interface Call {
  method: string
  path: string
  body?: { sql?: string; table_name?: string; updates?: Array<{ row_id: string; row: object }> }
}

const COLUMNS = [
  { name: 'root_783', type: 'text' },
  { name: 'cell_type', type: 'text' },
  {
    name: 'side',
    type: 'single-select',
    data: { options: [{ name: 'left' }, { name: 'right' }] },
  },
  { name: 'proofread', type: 'checkbox' },
  { name: 'pos_x', type: 'number' },
  { name: 'last_user', type: 'last-modifier' },
  { name: 'status', type: 'text', editable: false },
  { name: 'checked', type: 'date', data: { format: 'YYYY-MM-DD HH:mm' } },
  { name: 'born', type: 'date', data: { format: 'YYYY-MM-DD' } },
]

/**
 * A SeaTable deployment in a function: access token, metadata, SQL answered by `select`, and
 * row updates recorded. `gateway` makes the access token say `use_api_gateway`.
 */
function serve(
  select: (sql: string) => object[],
  options: { gateway?: boolean; refuseUpdate?: boolean } = {},
): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const path = url.replace(HOST, '')
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ method: init.method ?? 'GET', path, ...(body ? { body } : {}) })
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })
    if (path.endsWith('/access-token/')) {
      return json({
        access_token: 'jwt',
        dtable_uuid: UUID,
        dtable_server: `${HOST}/dtable-server/`,
        dtable_db: `${HOST}/dtable-db/`,
        ...(options.gateway ? { use_api_gateway: true } : {}),
      })
    }
    if (path.endsWith('/metadata/')) {
      return json({ metadata: { tables: [{ name: 'info', columns: COLUMNS }] } })
    }
    if (path.includes('/query/') || path.endsWith('/sql')) {
      return json({ success: true, results: select(body.sql) })
    }
    if (path.endsWith('/batch-update-rows/') || path.endsWith('/rows/')) {
      return options.refuseUpdate
        ? new Response('{"error_msg":"You do not have permission"}', { status: 403 })
        : json({ success: true })
    }
    return new Response('not stubbed', { status: 404 })
  })
  return calls
}

const target = () =>
  new SeaTableTarget({
    host: HOST,
    workspace: '5',
    base: 'main',
    table: 'info',
    idColumn: 'root_783',
  })

beforeEach(() => {
  setToken(HOST, 'account-token')
  forgetSeaTableRoutes()
})
afterEach(() => {
  vi.unstubAllGlobals()
  resetSeaTableCredentials([HOST])
})

describe('a SeaTable table as an annotation target', () => {
  it('says which columns can be edited, and why the rest cannot', async () => {
    serve(() => [])
    const fields = await target().fields()
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]))
    expect(byName.root_783).toMatchObject({ readOnly: 'the id column' })
    expect(byName.side).toEqual({ name: 'side', kind: 'choice', options: ['left', 'right'] })
    expect(byName.last_user).toMatchObject({ readOnly: 'a last-modifier column' })
    expect(byName.status).toMatchObject({ readOnly: 'locked in the base' })
  })

  it('reads a selection with one query, naming only the columns asked for and a LIMIT', async () => {
    // Without a LIMIT dtable-db stops at 100 rows and says nothing.
    const calls = serve(() => [
      { _id: 'a', root_783: '720575940621522189', cell_type: 'LC4', proofread: null },
      { _id: 'b', root_783: '720575940621522189', cell_type: 'LC4a', proofread: true },
    ])
    const read = await target().read(
      ['720575940621522189', '720575940628857210'],
      ['cell_type', 'proofread'],
    )
    const sql = calls.find((c) => c.path.includes('/query/'))!.body!.sql!
    expect(sql).toBe(
      'SELECT `_id`, `root_783`, `cell_type`, `proofread` FROM `info` ' +
        "WHERE `root_783` IN ('720575940621522189', '720575940628857210') LIMIT 10000",
    )
    // Both rows of the repeated id, each with its own key; an unticked checkbox reads as false.
    expect(read.records).toEqual([
      { key: 'a', id: '720575940621522189', values: { cell_type: 'LC4', proofread: false } },
      { key: 'b', id: '720575940621522189', values: { cell_type: 'LC4a', proofread: true } },
    ])
    expect(read.missing).toEqual(['720575940628857210'])
  })

  it('refuses an id that is not plainly an id rather than splicing it into SQL', async () => {
    serve(() => [])
    await expect(target().read(["1' OR '1'='1"], ['cell_type'])).rejects.toThrow(
      /cannot be looked up/,
    )
    await expect(target().read(['flywire:1'], ['cell_type'])).rejects.toThrow(
      /without a dataset prefix/,
    )
  })

  it('refuses a lookup that reached the row limit rather than calling it complete', async () => {
    serve(() => Array.from({ length: 10_000 }, (_, i) => ({ _id: `k${i}`, root_783: '1' })))
    await expect(target().read(['1'], ['cell_type'])).rejects.toThrow(/More than 10,000 rows/)
  })

  it('writes one update per row with its fields merged, after checking each cell still holds what was shown', async () => {
    const calls = serve((sql) =>
      sql.includes('`_id` IN')
        ? [
            { _id: 'a', cell_type: 'LC4', side: 'left' },
            { _id: 'b', cell_type: 'LC6', side: 'left' },
          ]
        : [],
    )
    const result = await target().write([
      { key: 'a', field: 'cell_type', value: 'LC4a', before: 'LC4' },
      { key: 'a', field: 'side', value: 'right', before: 'left' },
      // Somebody changed b since the card read it.
      { key: 'b', field: 'cell_type', value: 'LC4a', before: 'LC4' },
    ])
    expect(result.written.map((c) => `${c.key}.${c.field}`)).toEqual(['a.cell_type', 'a.side'])
    expect(result.conflicts).toEqual([
      { change: expect.objectContaining({ key: 'b' }), now: 'LC6' },
    ])
    const update = calls.find((c) => c.method === 'PUT')!
    expect(update.path).toBe(`/dtable-server/api/v1/dtables/${UUID}/batch-update-rows/`)
    expect(update.body).toEqual({
      table_name: 'info',
      updates: [{ row_id: 'a', row: { cell_type: 'LC4a', side: 'right' } }],
    })
  })

  it('takes both halves through the API gateway on a deployment that says so', async () => {
    const calls = serve(
      (sql) => (sql.includes('`_id` IN') ? [{ _id: 'a', cell_type: 'x' }] : []),
      {
        gateway: true,
      },
    )
    await target().write([{ key: 'a', field: 'cell_type', value: 'y', before: 'x' }])
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(
      expect.arrayContaining([
        `POST /api-gateway/api/v2/dtables/${UUID}/sql`,
        `PUT /api-gateway/api/v2/dtables/${UUID}/rows/`,
      ]),
    )
  })

  it('mints the base token once for a session of reads and writes', async () => {
    const calls = serve(() => [])
    const t = target()
    await t.fields()
    await t.read(['1'], ['cell_type'])
    await t.read(['2'], ['cell_type'])
    expect(calls.filter((c) => c.path.endsWith('/access-token/'))).toHaveLength(1)
  })

  it('fails a write the base refuses without asking for a new token', async () => {
    // A 403 on a write is usually a base the account may read and not write: this batch's
    // failure, not a token for the Connections panel to ask for again.
    serve((sql) => (sql.includes('`_id` IN') ? [{ _id: 'a', cell_type: 'x' }] : []), {
      refuseUpdate: true,
    })
    const heard: string[] = []
    const stop = subscribeAuthFailure(({ message }) => heard.push(message))
    const result = await target().write([
      { key: 'a', field: 'cell_type', value: 'y', before: 'x' },
    ])
    stop()
    expect(result.failed).toEqual([
      {
        change: expect.objectContaining({ key: 'a' }),
        message: expect.stringMatching(/read this base but not to write to it/),
      },
    ])
    expect(heard).toEqual([])
  })

  it('lets one caller cancel without failing another waiting on the same base', async () => {
    serve(() => [])
    const t = target()
    const cancelled = new AbortController()
    const first = t.fields(cancelled.signal)
    const second = t.fields()
    cancelled.abort()
    await expect(first).rejects.toThrow()
    expect((await second).length).toBe(COLUMNS.length)
  })

  it('reads a date as the wall clock a write takes, so writing it back changes nothing', async () => {
    // SQL answers ISO with the server's offset; written back, ISO keeps the day and drops the
    // time (measured on a scratch table). `2022-04-26 22:12` round-trips exactly.
    serve(() => [
      {
        _id: 'a',
        root_783: '1',
        checked: '2022-04-26T22:12:00+01:00',
        born: '2022-04-26T00:00:00Z',
      },
    ])
    const t = target()
    const fields = Object.fromEntries((await t.fields()).map((f) => [f.name, f]))
    expect(fields.checked).toMatchObject({ kind: 'date', withTime: true })
    expect(fields.born!.withTime).toBeUndefined()
    const read = await t.read(['1'], ['checked', 'born'])
    expect(read.records[0]!.values).toEqual({ checked: '2022-04-26 22:12', born: '2022-04-26' })
  })

  it('keeps the wall clock and drops the offset', () => {
    expect(wallClock('2022-04-26T22:12:00+01:00', true)).toBe('2022-04-26 22:12')
    expect(wallClock('2024-02-03T14:30:00Z', false)).toBe('2024-02-03')
  })
})
