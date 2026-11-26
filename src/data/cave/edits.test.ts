/**
 * The chunkedgraph writer, against a stubbed `fetch` only — never a server
 * (`docs/seam-merge-plan.md`, phase 2; `src/test/writeGuard.ts` fails a test that forgets).
 *
 * What is pinned is what the server and the batch above depend on: the request Spelunker sends,
 * byte for byte; which failures leave the graph as it was (`refused`) and which may not
 * (`unknown`); and that a merge is sent once per confirmation and never without one.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { resetCredentials, subscribeAuthFailure } from './credentials'
import type { ConfirmedMerge, ConfirmedSplit, DoneEdit, WriteOptions } from './edits'
import {
  confirmMerge,
  confirmSplit,
  mergeSupervoxels,
  splitSupervoxels,
  undoEdit,
} from './edits'
import { parseGrapheneSource } from './graphene'
import type { MergeEnd } from './merge'

/** The sandbox: the one table a live write may go to. Nothing here reaches it. */
const SANDBOX = parseGrapheneSource(
  'graphene://https://cave.fanc-fly.com/segmentation/table/mar2021_test',
)!
const AS: WriteOptions = { deployment: 'https://global.daf-apis.com', token: 'test-token' }

/** Two supervoxels past 2⁵³, where a JavaScript number would name a different one. */
const NEURON: MergeEnd = { supervoxel: '73747834149376537', positionNm: [8, 24, 22.5] }
const CANDIDATE: MergeEnd = {
  supervoxel: '18446744073709551615',
  positionNm: [25.8, 43, 517.5],
}

interface Sent {
  readonly url: string
  readonly init: RequestInit
}

/** Answer the requests in turn with `bodies` (the last repeating), keeping what was sent. */
function serve(status: number, ...bodies: string[]): Sent[] {
  const sent: Sent[] = []
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    sent.push({ url, init })
    const body = bodies[Math.min(sent.length, bodies.length) - 1]
    return Promise.resolve(new Response(body, { status }))
  })
  return sent
}

const DONE = '{"operation_id":"4217","new_root_ids":["648518346349539437"]}'

/** What a merge of the two sends: an id that went through a number would differ in its last digits. */
const BODY = '[["73747834149376537",8,24,22.5],["18446744073709551615",25.8,43,517.5]]'

/** One fresh confirmation of the pair, sent as `AS`. */
const mergeOnce = (options: WriteOptions = AS) =>
  mergeSupervoxels(confirmMerge(SANDBOX, NEURON, CANDIDATE), options)

afterEach(() => {
  vi.unstubAllGlobals()
  resetCredentials()
})

describe('mergeSupervoxels', () => {
  it('sends Spelunker’s request: both points, ids as text, positions in nanometres', async () => {
    const sent = serve(200, DONE)
    const outcome = await mergeOnce()

    expect(outcome).toEqual({
      kind: 'done',
      operationId: '4217',
      newRootIds: ['648518346349539437'],
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toBe(
      'https://cave.fanc-fly.com/segmentation/api/v1/table/mar2021_test/merge' +
        '?int64_as_str=1&priority=True',
    )
    expect(sent[0]!.init.method).toBe('POST')
    // A 307 or 308 followed would send this body again to a host nobody confirmed.
    expect(sent[0]!.init.redirect).toBe('error')
    expect(sent[0]!.init.body).toBe(BODY)
    expect(new Headers(sent[0]!.init.headers).get('Authorization')).toBe('Bearer test-token')
  })

  /** A server ignoring `int64_as_str` answers bare integers; a wide one must stay exact. */
  it('reads the new root exactly when the reply’s ids are bare integers', async () => {
    serve(200, '{"operation_id":4217,"new_root_ids":[720575940621039145]}')
    const outcome = await mergeOnce()
    expect(outcome).toEqual({
      kind: 'done',
      operationId: '4217',
      newRootIds: ['720575940621039145'],
    })
  })

  /*
   * The guard against a retry loop anywhere above: the confirmation is spent before the request,
   * so a caller that catches and tries again has to go back to the reader.
   */
  it('sends a confirmation once, and refuses the second send before any request', async () => {
    const sent = serve(500, '{"code":500,"message":"Locking failed"}')
    const merge = confirmMerge(SANDBOX, NEURON, CANDIDATE)
    expect((await mergeSupervoxels(merge, AS)).kind).toBe('unknown')
    await expect(mergeSupervoxels(merge, AS)).rejects.toThrow(/already been sent/)
    expect(sent).toHaveLength(1)
  })

  it('refuses a merge confirmMerge did not make — a copy or a cast — before any request', async () => {
    const sent = serve(200, DONE)
    const forged = { graphene: SANDBOX, neuron: NEURON, candidate: CANDIDATE } as ConfirmedMerge
    await expect(mergeSupervoxels(forged, AS)).rejects.toThrow(/not confirmed/)
    const copy = { ...confirmMerge(SANDBOX, NEURON, CANDIDATE) } as ConfirmedMerge
    await expect(mergeSupervoxels(copy, AS)).rejects.toThrow(/not confirmed/)
    expect(sent).toEqual([])
  })

  it('sends what was confirmed, whatever happens to the caller’s objects afterwards', async () => {
    const sent = serve(200, DONE)
    const position: [number, number, number] = [8, 24, 22.5]
    const neuron = { supervoxel: NEURON.supervoxel, positionNm: position }
    const merge = confirmMerge(SANDBOX, neuron, CANDIDATE)
    position[0] = 999_999
    neuron.supervoxel = '1'
    await mergeSupervoxels(merge, AS)
    expect(sent[0]!.init.body).toBe(BODY)
    expect(Object.isFrozen(merge.neuron.positionNm)).toBe(true)
  })

  /*
   * pychunkedgraph raises every `PreconditionError` before it persists the edit, and answers it
   * 400 with `{"code", "message"}`; this one is the server's own "already merged".
   */
  it('reads a 4xx as a refusal, nothing written, in the server’s own words', async () => {
    serve(
      400,
      '{"code":400,"duration":12,"message":"Supervoxels must belong to different objects."}',
    )
    const outcome = await mergeOnce()
    expect(outcome).toMatchObject({
      kind: 'refused',
      status: 400,
      message: expect.stringContaining('Supervoxels must belong to different objects.'),
    })
  })

  /** `middle_auth_client`'s body for a missing `edit` permission. */
  it('names the edit permission a 403 is about, and raises it on the auth channel', async () => {
    serve(
      403,
      JSON.stringify({
        error: 'missing_permission',
        message: 'Missing permission: edit for dataset FANC_sandbox',
        data: { required_permission: 'edit', auth_dataset: 'FANC_sandbox' },
      }),
    )
    const raised: string[] = []
    const stop = subscribeAuthFailure((message) => raised.push(message))
    const outcome = await mergeOnce()
    stop()
    expect(outcome).toMatchObject({
      kind: 'refused',
      status: 403,
      message: expect.stringContaining('not permitted to edit FANC_sandbox'),
    })
    expect(raised).toHaveLength(1)
  })

  it('refuses without a request where there is no token to send', async () => {
    const sent = serve(200, DONE)
    const outcome = await mergeOnce({ deployment: AS.deployment })
    expect(outcome).toMatchObject({ kind: 'refused', status: 401 })
    expect(sent).toEqual([])
  })

  /** The four statuses raised before anything is written: the handler's, auth's, no such table. */
  it.each([400, 401, 403, 404])('reads a %i as a refusal', async (status) => {
    serve(status, '{"code":0,"message":"no"}')
    expect((await mergeOnce()).kind).toBe('refused')
  })

  /*
   * Some 500s come after the write (a lock lost, "Could not merge"), and a proxy's 408, 409 or 429
   * can come after it passed the request on — so none of them is evidence nothing happened.
   */
  it.each([
    [500, '{"code":500,"message":"Could not merge selected supervoxel."}'],
    [502, '<html><title>502 Bad Gateway</title></html>'],
    [504, ''],
    [408, ''],
    [409, ''],
    [429, '{"message":"Too many requests"}'],
  ])('reads a %i as an outcome not known', async (status, body) => {
    serve(status, body)
    const outcome = await mergeOnce()
    expect(outcome.kind).toBe('unknown')
  })

  it('reads an unreachable host as an outcome not known', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')))
    const outcome = await mergeOnce()
    expect(outcome).toMatchObject({
      kind: 'unknown',
      message: expect.stringMatching(/Could not reach CAVE.*A redirect is not followed/),
    })
  })

  /** A success the reply does not describe: the edit probably happened, so not a refusal. */
  it.each([
    ['not JSON', 'OK'],
    ['no operation id', '{"new_root_ids":["648518346349539437"]}'],
    ['no new root', '{"operation_id":"4217","new_root_ids":[]}'],
    ['a new root that is no id', '{"operation_id":"4217","new_root_ids":[null]}'],
    ['a fractional operation id', '{"operation_id":4217.5,"new_root_ids":["1"]}'],
  ])('reads a success with %s as an outcome not known', async (_, body) => {
    serve(200, body)
    const outcome = await mergeOnce()
    expect(outcome.kind).toBe('unknown')
  })

  /** Aborting a sent merge does not stop the server; it only throws away its answer. */
  it('carries no signal, even one the caller’s options hold', async () => {
    const sent = serve(200, DONE)
    const options = { ...AS, signal: AbortSignal.abort() }
    const outcome = await mergeOnce(options)
    expect(outcome.kind).toBe('done')
    expect(sent[0]!.init.signal).toBeUndefined()
  })
})

describe('confirmMerge', () => {
  const at = (supervoxel: string): MergeEnd => ({ supervoxel, positionNm: [0, 0, 0] })

  it.each([
    ['0 (no object)', '0'],
    ['a signed id', '-5'],
    ['a fraction', '1.5'],
    ['a zero-padded id', '0073747834149376537'],
    ['an id past 64 bits', '18446744073709551616'],
    ['an empty id', ''],
  ])('refuses %s', (_, id) => {
    expect(() => confirmMerge(SANDBOX, at(id), CANDIDATE)).toThrow(/Not a chunkedgraph id/)
    expect(() => confirmMerge(SANDBOX, NEURON, at(id))).toThrow(/Not a chunkedgraph id/)
  })

  /** `JSON.stringify(NaN)` is `null`, which the server would read as a coordinate. */
  it.each([
    ['NaN', [Number.NaN, 0, 0]],
    ['Infinity', [0, Number.POSITIVE_INFINITY, 0]],
    ['two numbers', [0, 0]],
  ])('refuses a position holding %s', (_, position) => {
    const end = { supervoxel: NEURON.supervoxel, positionNm: position as never }
    expect(() => confirmMerge(SANDBOX, end, CANDIDATE)).toThrow(/Not a position/)
  })

  /** The write and the reader's token would cross the network in the clear. */
  it('refuses a chunkedgraph that is not on https', () => {
    const plain = parseGrapheneSource(
      'graphene://http://cave.fanc-fly.com/segmentation/table/mar2021_test',
    )!
    expect(() => confirmMerge(plain, NEURON, CANDIDATE)).toThrow(/Not an https chunkedgraph/)
  })

  it('refuses one supervoxel on both sides', () => {
    expect(() => confirmMerge(SANDBOX, NEURON, { ...NEURON, positionNm: [1, 1, 1] })).toThrow(
      /Both sides/,
    )
  })
})

describe('undoEdit', () => {
  it('undoes a merge it made, with caveclient’s request, on the merge’s own table', async () => {
    const sent = serve(200, DONE, '{"operation_id":"4218","new_root_ids":["1","2"]}')
    const merged = await mergeOnce()
    expect(merged.kind).toBe('done')
    const outcome = await undoEdit(merged as DoneEdit, AS)

    expect(outcome).toEqual({ kind: 'done', operationId: '4218', newRootIds: ['1', '2'] })
    expect(sent[1]!.url).toBe(
      'https://cave.fanc-fly.com/segmentation/api/v1/table/mar2021_test/undo?int64_as_str=1',
    )
    expect(sent[1]!.init.body).toBe('{"operation_id":4217}')
    expect(sent[1]!.init.redirect).toBe('error')
  })

  it('undoes a merge once, and refuses the second before any request', async () => {
    const sent = serve(200, DONE)
    const merged = (await mergeOnce()) as DoneEdit
    await undoEdit(merged, AS)
    await expect(undoEdit(merged, AS)).rejects.toThrow(/already been undone/)
    expect(sent).toHaveLength(2)
  })

  /** An operation id alone could name anybody's edit, on any table. */
  it('refuses an outcome it did not return — a copy, a literal, an undo — before any request', async () => {
    const sent = serve(200, DONE)
    const merged = (await mergeOnce()) as DoneEdit
    const literal: DoneEdit = { kind: 'done', operationId: '4217', newRootIds: ['1'] }
    await expect(undoEdit(literal, AS)).rejects.toThrow(/Only an edit this session made/)
    await expect(undoEdit({ ...merged }, AS)).rejects.toThrow(/Only an edit this session made/)
    const undone = (await undoEdit(merged, AS)) as DoneEdit
    await expect(undoEdit(undone, AS)).rejects.toThrow(/Only an edit this session made/)
    expect(sent).toHaveLength(2)
  })

  it('freezes the outcome it will accept back', async () => {
    serve(200, DONE)
    const merged = (await mergeOnce()) as DoneEdit
    expect(Object.isFrozen(merged)).toBe(true)
    expect(Object.isFrozen(merged.newRootIds)).toBe(true)
  })
})

describe('splitSupervoxels', () => {
  const OTHER: MergeEnd = { supervoxel: '73747834149376538', positionNm: [9, 25, 45] }
  const EDGE = { source: NEURON, sink: CANDIDATE }
  const SPLIT_DONE =
    '{"operation_id":"4219","new_root_ids":["648518346349539437","648518346349539438"]}'

  it('removes exactly the confirmed edge: mincut off, its two ends, ids as text', async () => {
    const sent = serve(200, SPLIT_DONE)
    const outcome = await splitSupervoxels(confirmSplit(SANDBOX, { edge: EDGE }), AS)

    expect(outcome).toEqual({
      kind: 'done',
      operationId: '4219',
      newRootIds: ['648518346349539437', '648518346349539438'],
    })
    expect(sent[0]!.url).toBe(
      'https://cave.fanc-fly.com/segmentation/api/v1/table/mar2021_test/split' +
        '?int64_as_str=1&mincut=false&priority=True',
    )
    expect(sent[0]!.init.method).toBe('POST')
    expect(sent[0]!.init.redirect).toBe('error')
    expect(sent[0]!.init.body).toBe(
      '{"sources":[["73747834149376537",8,24,22.5]],"sinks":[["18446744073709551615",25.8,43,517.5]]}',
    )
  })

  it('sends a confirmation once, and never one it did not make', async () => {
    const sent = serve(500, '{"code":500,"message":"Could not split selected segment groups."}')
    const split = confirmSplit(SANDBOX, { edge: EDGE })
    expect((await splitSupervoxels(split, AS)).kind).toBe('unknown')
    await expect(splitSupervoxels(split, AS)).rejects.toThrow(/already been sent/)
    const forged = {
      graphene: SANDBOX,
      mincut: false,
      sources: [NEURON],
      sinks: [CANDIDATE],
    } as unknown as ConfirmedSplit
    await expect(splitSupervoxels(forged, AS)).rejects.toThrow(/not confirmed/)
    expect(sent).toHaveLength(1)
  })

  it('refuses a split that could not be meant, before any request', () => {
    expect(() => confirmSplit(SANDBOX, { edge: { source: NEURON, sink: NEURON } })).toThrow(
      /itself/,
    )
    expect(() =>
      confirmSplit(SANDBOX, {
        edge: { source: { ...NEURON, supervoxel: '0' }, sink: CANDIDATE },
      }),
    ).toThrow(/Not a chunkedgraph id/)
    const http = parseGrapheneSource('graphene://http://example.org/segmentation/table/t')!
    expect(() => confirmSplit(http, { edge: EDGE })).toThrow(/https/)
  })

  it('asks the server’s own min-cut between two seed sets, with the min-cut spelled on', async () => {
    const sent = serve(200, SPLIT_DONE)
    const split = confirmSplit(SANDBOX, {
      mincut: { sources: [NEURON, OTHER], sinks: [CANDIDATE] },
    })
    expect((await splitSupervoxels(split, AS)).kind).toBe('done')
    expect(sent[0]!.url).toBe(
      'https://cave.fanc-fly.com/segmentation/api/v1/table/mar2021_test/split' +
        '?int64_as_str=1&mincut=true&priority=True',
    )
    expect(sent[0]!.init.body).toBe(
      '{"sources":[["73747834149376537",8,24,22.5],["73747834149376538",9,25,45]],' +
        '"sinks":[["18446744073709551615",25.8,43,517.5]]}',
    )
  })

  it('refuses a min-cut with an empty side, or a seed on both', () => {
    expect(() =>
      confirmSplit(SANDBOX, { mincut: { sources: [], sinks: [CANDIDATE] } }),
    ).toThrow(/seeds on both sides/)
    expect(() =>
      confirmSplit(SANDBOX, { mincut: { sources: [NEURON], sinks: [CANDIDATE, NEURON] } }),
    ).toThrow(/seeds both sides/)
  })

  it('undoes a split it made, once', async () => {
    const sent = serve(200, SPLIT_DONE, '{"operation_id":"4220","new_root_ids":["1"]}')
    const split = (await splitSupervoxels(
      confirmSplit(SANDBOX, { edge: EDGE }),
      AS,
    )) as DoneEdit
    expect((await undoEdit(split, AS)).kind).toBe('done')
    expect(sent[1]!.init.body).toBe('{"operation_id":4219}')
    await expect(undoEdit(split, AS)).rejects.toThrow(/already been undone/)
  })
})
