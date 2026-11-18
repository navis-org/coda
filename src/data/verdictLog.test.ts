// @vitest-environment jsdom
/**
 * The verdict log against a fake of the server (`transform_service`'s `/verdicts`), with the
 * chunkedgraph lookup that answers its challenge stood in for. No request reaches the real server:
 * `fetch` is stubbed per test, and the write guard under every test file refuses it otherwise.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearStorage, installStorageStub } from '../test/jsdomStubs'
import { rootsForSupervoxels } from './cave/rootIds'
import type { VerdictFields, VerdictTarget } from './verdictLog'
import { VERDICT_SERVER } from './verdictServer'
import {
  MAX_QUEUE_CHARS,
  CHALLENGE_REST_MS,
  COLLECTED_FOR_MS,
  collectedDatastacks,
  enqueueVerdict,
  flushVerdicts,
  readSharing,
  resetVerdictLog,
  subscribeVerdictLog,
  verdictLogState,
  writeSharing,
} from './verdictLog'

vi.mock('./cave/rootIds', () => ({ rootsForSupervoxels: vi.fn() }))
const roots = vi.mocked(rootsForSupervoxels)

const AEDES: VerdictTarget = {
  deployment: 'global.daf-apis.com',
  datastack: 'wclee_aedes_brain',
}
const OTHER: VerdictTarget = { deployment: 'global.daf-apis.com', datastack: 'other_stack' }
const SV = '73958101765887743'
const ROOT = '648518347592065216'

/** A record as the SEAM pack would describe one; opaque to the log. */
const INPUT: VerdictFields = {
  source: 'set:rv4-ad75ed161bb6',
  neuron: '648518347669157986',
  piece: '648518347669157986',
  end_uid: 17,
  kind: 'tip',
  x: 1000,
  y: 2000,
  z: 3000,
  candidate: '648518347600000002',
  rank: 1,
  q: 0.41,
  r: 0.93,
  p_tip: 0.8,
  conf: 0.51,
  shown: true,
  organelle: false,
  verdict: 'accept',
  searched_at: null,
  coda: 'abc1234',
}

interface Post {
  readonly url: string
  readonly auth: string | undefined
  readonly body: Record<string, unknown>
}

/**
 * The server, as far as the log talks to it. `answer` decides each post to `/verdicts`; the
 * challenge and session routes behave as the real ones do for a right answer.
 */
function fakeServer(
  answer: (post: Post, n: number) => { status: number; body?: unknown } = () => ({
    status: 200,
    body: { received: 1, new: 1 },
  }),
  options: { challengeStatus?: number; datastacks?: readonly string[] } = {},
) {
  const posts: Post[] = []
  let challenges = 0
  let sessions = 0
  let lists = 0
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status })
    if (url.startsWith(`${VERDICT_SERVER}/datastacks`)) {
      lists += 1
      return reply(200, {
        collecting: true,
        datastacks: options.datastacks ?? ['wclee_aedes_brain', 'other_stack'],
      })
    }
    if (url.startsWith(`${VERDICT_SERVER}/challenge`)) {
      challenges += 1
      if (options.challengeStatus) {
        return reply(options.challengeStatus, {
          detail: 'Verdicts are not collected for that.',
        })
      }
      return reply(200, {
        challenge: `token-${challenges}`,
        supervoxel: SV,
        at: '2026-11-18T11:53:28Z',
        datastack: 'wclee_aedes_brain',
      })
    }
    if (url === `${VERDICT_SERVER}/session`) {
      sessions += 1
      const sent = JSON.parse(String(init?.body)) as { root: string }
      if (sent.root !== ROOT) return reply(403, { detail: 'That is not the root.' })
      return reply(200, { session: `session-${sessions}`, expires: '2999-01-01T00:00:00Z' })
    }
    if (url === VERDICT_SERVER) {
      const headers = (init?.headers ?? {}) as Record<string, string>
      const post = {
        url,
        auth: headers['Authorization'],
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      }
      posts.push(post)
      const { status, body } = answer(post, posts.length)
      return reply(status, body ?? {})
    }
    throw new Error(`The fake server has no route for ${url}`)
  })
  return {
    posts,
    records: (n: number) => posts[n]!.body['records'] as Record<string, unknown>[],
    challenges: () => challenges,
    lists: () => lists,
    sessions: () => sessions,
  }
}

const share = (over: Partial<{ name: string; email: string }> = {}) =>
  writeSharing({ on: true, name: '', email: '', ...over })

beforeAll(() => installStorageStub())

beforeEach(() => {
  clearStorage()
  resetVerdictLog()
  roots.mockReset()
  roots.mockResolvedValue(new Map([[SV, ROOT]]))
})

afterEach(() => vi.unstubAllGlobals())

describe('what is queued', () => {
  it('queues nothing until the reader turns sharing on', () => {
    expect(readSharing().on).toBe(false)
    expect(enqueueVerdict(AEDES, INPUT)).toBe('sharing off')
    expect(verdictLogState().waiting).toBe(0)
  })

  it('queues nothing for a datastack the server has said it does not collect', async () => {
    share()
    fakeServer(undefined, { datastacks: ['other_stack'] })
    expect(enqueueVerdict(AEDES, INPUT)).toBeUndefined()
    await collectedDatastacks()
    expect(enqueueVerdict(AEDES, INPUT)).toBe('not collected')
    expect(enqueueVerdict(OTHER, INPUT)).toBeUndefined()
  })

  it('stops refusing once the server’s answer is stale, and asks it again', async () => {
    share()
    const server = fakeServer(undefined, { datastacks: ['other_stack'] })
    await collectedDatastacks()
    expect(enqueueVerdict(AEDES, INPUT)).toBe('not collected')
    vi.useFakeTimers({ now: Date.now() + COLLECTED_FOR_MS + 1, toFake: ['Date'] })
    try {
      expect(enqueueVerdict(AEDES, INPUT)).toBeUndefined()
      await collectedDatastacks()
    } finally {
      vi.useRealTimers()
    }
    expect(server.lists()).toBe(2)
  })

  it('stamps each record with its own id, the moment, and the name and email given', async () => {
    share({ name: ' A Reader ', email: 'reader@example.org' })
    const server = fakeServer()
    enqueueVerdict(AEDES, INPUT)
    enqueueVerdict(AEDES, { ...INPUT, verdict: 'cleared' })
    await flushVerdicts()
    const [first, second] = server.records(0)
    expect(first).toMatchObject({ ...INPUT, name: 'A Reader', email: 'reader@example.org' })
    expect(second!['verdict']).toBe('cleared')
    expect(first!['id']).not.toBe(second!['id'])
    expect(Date.parse(String(first!['at']))).not.toBeNaN()
  })

  it('sends a blank name and email as none', async () => {
    share()
    const server = fakeServer()
    enqueueVerdict(AEDES, INPUT)
    await flushVerdicts()
    expect(server.records(0)[0]).toMatchObject({ name: null, email: null })
  })

  it('keeps the queue within its share of storage, dropping and counting the oldest', () => {
    share()
    const one = (i: number) => ({
      target: AEDES,
      record: { ...INPUT, id: `old-${i}`, at: '2026-11-18T00:00:00Z', name: null, email: null },
    })
    const many = Math.ceil(MAX_QUEUE_CHARS / JSON.stringify(one(0)).length) + 10
    window.localStorage.setItem(
      'coda.verdictQueue',
      JSON.stringify(Array.from({ length: many }, (_, i) => one(i))),
    )
    expect(enqueueVerdict(AEDES, INPUT)).toBeUndefined()
    const text = window.localStorage.getItem('coda.verdictQueue')!
    const queue = JSON.parse(text) as { record: { id: string; verdict: string } }[]
    expect(text.length).toBeLessThanOrEqual(MAX_QUEUE_CHARS)
    expect(queue[0]!.record.id).not.toBe('old-0')
    expect(queue.at(-1)!.record.id).not.toMatch(/^old-/)
    expect(verdictLogState().dropped).toBe(many + 1 - queue.length)
    expect(verdictLogState().waiting).toBe(queue.length)
  })

  it('says so, and counts the click, where the browser’s storage refuses it', () => {
    share()
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    try {
      expect(enqueueVerdict(AEDES, INPUT)).toBe('storage full')
    } finally {
      setItem.mockRestore()
    }
    expect(verdictLogState()).toMatchObject({ waiting: 0, dropped: 1 })
    expect(verdictLogState().problem).toMatch(/storage is full/)
  })

  it('ignores an entry not in the shape this build writes, and sends the rest', async () => {
    share()
    const server = fakeServer()
    window.localStorage.setItem(
      'coda.verdictQueue',
      JSON.stringify([{ record: { id: 'no target' } }, 'nonsense', null]),
    )
    enqueueVerdict(AEDES, INPUT)
    await flushVerdicts()
    expect(server.records(0).length).toBe(1)
    expect(verdictLogState()).toMatchObject({ sent: 1, waiting: 0 })
  })
})

describe('the challenge', () => {
  it('answers it through the reader’s own access, at the server’s moment', async () => {
    share()
    const server = fakeServer()
    enqueueVerdict(AEDES, INPUT)
    await flushVerdicts()
    expect(roots).toHaveBeenCalledWith(
      'wclee_aedes_brain',
      { now: Date.parse('2026-11-18T11:53:28Z') },
      [SV],
      expect.objectContaining({ deployment: 'global.daf-apis.com' }),
    )
    expect(server.posts[0]!.auth).toBe('Bearer session-1')
    expect(verdictLogState()).toMatchObject({ sent: 1, waiting: 0, problem: undefined })
  })

  it('keeps the session, so the next flush answers no new challenge', async () => {
    share()
    const server = fakeServer()
    enqueueVerdict(AEDES, INPUT)
    await flushVerdicts()
    enqueueVerdict(AEDES, INPUT)
    await flushVerdicts()
    expect(server.challenges()).toBe(1)
    expect(server.posts.length).toBe(2)
  })

  it('takes one session per datastack', async () => {
    share()
    const server = fakeServer()
    enqueueVerdict(AEDES, INPUT)
    enqueueVerdict(OTHER, INPUT)
    await flushVerdicts()
    expect(server.sessions()).toBe(2)
    expect(server.posts.map((post) => post.auth)).toEqual([
      'Bearer session-1',
      'Bearer session-2',
    ])
  })

  it('says so, and keeps the verdicts, where the reader cannot look the root up', async () => {
    share()
    fakeServer()
    roots.mockResolvedValue(new Map())
    enqueueVerdict(AEDES, INPUT)
    await flushVerdicts()
    expect(verdictLogState()).toMatchObject({ sent: 0, waiting: 1 })
    expect(verdictLogState().problem).toMatch(/signed in/)
  })

  it('drops what waits for a datastack the server says it does not collect', async () => {
    share()
    fakeServer(undefined, { challengeStatus: 404, datastacks: ['other_stack'] })
    enqueueVerdict(AEDES, INPUT)
    await flushVerdicts()
    expect(verdictLogState()).toMatchObject({ waiting: 0, dropped: 1 })
    expect(verdictLogState().problem).toMatch(/not collected/)
  })

  it('keeps the verdicts where a 404 is not the server saying so — a proxy, a moved route', async () => {
    share()
    fakeServer(undefined, { challengeStatus: 404 })
    enqueueVerdict(AEDES, INPUT)
    await flushVerdicts()
    expect(verdictLogState()).toMatchObject({ waiting: 1, dropped: 0 })
  })

  it('rests a minute after a failed challenge, rather than asking again on every click', async () => {
    share()
    const server = fakeServer()
    roots.mockResolvedValue(new Map())
    enqueueVerdict(AEDES, INPUT)
    await flushVerdicts()
    enqueueVerdict(AEDES, INPUT)
    await flushVerdicts()
    expect(server.challenges()).toBe(1)
    expect(verdictLogState().problem).toMatch(/signed in/)
    vi.useFakeTimers({ now: Date.now() + CHALLENGE_REST_MS + 1, toFake: ['Date'] })
    try {
      roots.mockResolvedValue(new Map([[SV, ROOT]]))
      await flushVerdicts()
    } finally {
      vi.useRealTimers()
    }
    expect(server.challenges()).toBe(2)
    expect(verdictLogState()).toMatchObject({ sent: 2, waiting: 0 })
  })

  it('keeps one datastack’s problem though another’s verdicts go through', async () => {
    share()
    fakeServer()
    roots.mockImplementation(async (datastack) =>
      datastack === AEDES.datastack ? new Map() : new Map([[SV, ROOT]]),
    )
    enqueueVerdict(AEDES, INPUT)
    enqueueVerdict(OTHER, INPUT)
    await flushVerdicts()
    expect(verdictLogState()).toMatchObject({ sent: 1, waiting: 1 })
    expect(verdictLogState().problem).toMatch(/signed in/)
  })
})

describe('sending', () => {
  it('answers a new challenge once when the session has lapsed, and sends the same batch', async () => {
    share()
    const server = fakeServer((_, n) =>
      n === 1 ? { status: 401, body: { detail: 'The session has expired.' } } : { status: 200 },
    )
    enqueueVerdict(AEDES, INPUT)
    await flushVerdicts()
    expect(server.challenges()).toBe(2)
    expect(server.records(1)).toEqual(server.records(0))
    expect(verdictLogState()).toMatchObject({ sent: 1, waiting: 0 })
  })

  it('drops the one record the server cannot read, and sends the rest', async () => {
    share()
    const server = fakeServer((post) =>
      (post.body['records'] as unknown[]).length === 2
        ? {
            status: 422,
            body: {
              detail: [{ loc: ['body', 'records', 1, 'q'], msg: 'must be between 0 and 1' }],
            },
          }
        : { status: 200 },
    )
    enqueueVerdict(AEDES, INPUT)
    enqueueVerdict(AEDES, { ...INPUT, q: 1.5 })
    await flushVerdicts()
    expect(server.records(1)).toEqual([server.records(0)[0]])
    expect(verdictLogState()).toMatchObject({ sent: 1, dropped: 1, waiting: 0 })
  })

  it('splits a batch the server refuses whole, naming no record, before giving any up', async () => {
    share()
    const server = fakeServer((post) =>
      (post.body['records'] as unknown[]).length > 1
        ? { status: 422, body: { detail: [{ loc: ['body', 'records'], msg: 'too many' }] } }
        : { status: 200 },
    )
    enqueueVerdict(AEDES, INPUT)
    enqueueVerdict(AEDES, INPUT)
    await flushVerdicts()
    expect(server.posts.map((post) => (post.body['records'] as unknown[]).length)).toEqual([
      2, 1, 1,
    ])
    expect(verdictLogState()).toMatchObject({ sent: 2, dropped: 0, waiting: 0 })
  })

  it('keeps everything waiting while the server is busy, and says why', async () => {
    share()
    fakeServer(() => ({ status: 503, body: { detail: 'Try again shortly.' } }))
    enqueueVerdict(AEDES, INPUT)
    await flushVerdicts()
    expect(verdictLogState()).toMatchObject({
      sent: 0,
      waiting: 1,
      problem: 'Try again shortly.',
    })
  })

  it('keeps everything waiting where the server cannot be reached', async () => {
    share()
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')))
    enqueueVerdict(AEDES, INPUT)
    await flushVerdicts()
    expect(verdictLogState().waiting).toBe(1)
    expect(verdictLogState().problem).toMatch(/Could not fetch/)
  })

  it('sends what was waiting once the server is back, and clears the problem', async () => {
    share()
    fakeServer(() => ({ status: 503 }))
    enqueueVerdict(AEDES, INPUT)
    await flushVerdicts()
    const server = fakeServer()
    await flushVerdicts()
    expect(server.posts.length).toBe(1)
    expect(verdictLogState()).toMatchObject({ sent: 1, waiting: 0, problem: undefined })
  })

  it('joins a flush already running rather than posting twice', async () => {
    share()
    const server = fakeServer()
    enqueueVerdict(AEDES, INPUT)
    await Promise.all([flushVerdicts(), flushVerdicts()])
    expect(server.posts.length).toBe(1)
  })

  it('tells a subscriber when the state changes, and stops when it unsubscribes', () => {
    const heard = vi.fn()
    const stop = subscribeVerdictLog(heard)
    share()
    enqueueVerdict(AEDES, INPUT)
    expect(heard).toHaveBeenCalled()
    heard.mockClear()
    stop()
    enqueueVerdict(AEDES, INPUT)
    expect(heard).not.toHaveBeenCalled()
  })

  it('carries the sharing settings, so the card can show them', () => {
    expect(verdictLogState().sharing.on).toBe(false)
    share({ name: 'A Reader' })
    expect(verdictLogState().sharing).toEqual({ on: true, name: 'A Reader', email: '' })
  })

  it('hears another tab change the queue', () => {
    share()
    expect(verdictLogState().waiting).toBe(0)
    const other = [
      { target: AEDES, record: { ...INPUT, id: 'x', at: '', name: null, email: null } },
    ]
    window.localStorage.setItem('coda.verdictQueue', JSON.stringify(other))
    window.dispatchEvent(new StorageEvent('storage', { key: 'coda.verdictQueue' }))
    expect(verdictLogState().waiting).toBe(1)
  })

  it('hands back the same state until something changes', () => {
    const before = verdictLogState()
    expect(verdictLogState()).toBe(before)
    share()
    enqueueVerdict(AEDES, INPUT)
    expect(verdictLogState()).not.toBe(before)
  })
})

describe('what the server collects', () => {
  it('lists the datastacks the server collects for', async () => {
    fakeServer()
    expect(await collectedDatastacks()).toEqual(new Set(['wclee_aedes_brain', 'other_stack']))
  })

  it('lists none where the server is not collecting', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ collecting: false, datastacks: ['wclee_aedes_brain'] })),
    )
    expect(await collectedDatastacks()).toEqual(new Set())
  })
})
