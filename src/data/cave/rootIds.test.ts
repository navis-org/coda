/**
 * Whether an annotation's root ids were still current when a materialization was frozen.
 *
 * The check exists because a CAVE root id is retired by any proofreading edit that touches its
 * segment, so an annotation base drifts out of step with a pinned materialization on its own —
 * and nothing fails when it does. What is worth pinning here is mostly what keeps it *cheap*,
 * since it is an advisory run against a shared production service: it is asked once per dataset,
 * only for ids nobody has asked about before, and never at all for a datastack with no
 * chunkedgraph.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetCache } from '../cache'
import { resetCredentials, setToken } from './credentials'
import { parseCaveTimestamp } from './datastack'
import {
  l2ChunkCounts,
  peekRootCheck,
  resetRootChecks,
  startRootCheck,
  subscribeRootCheck,
} from './rootIds'
import { resetCaveState } from './tables'
import { DEFAULT_CAVE_SERVER } from './deployments'

const DATASTACK = 'flywire_fafb_public'
const DATASET = `${DATASTACK}:783`
/** Zone-less, six fractional digits — the shape CAVE's `/metadata` actually returns. */
const STAMP = '2023-08-29T00:00:00.000000'
/** The same instant read as UTC, which is what CAVE means by it. Written out, not re-derived. */
const STAMP_EPOCH_SECONDS = 1_693_267_200

interface Call {
  url: string
  body: string
}

/** Every id but those named answers `true`. */
function installFetch(stale: string[] = [], overrides: Record<string, unknown> = {}): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const text = String(url)
    calls.push({ url: text, body: String(init?.body ?? '') })
    const answer = (value: unknown) =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify(value)),
      } as Response)

    for (const [fragment, value] of Object.entries(overrides)) {
      if (text.includes(fragment)) return answer(value)
    }
    if (text.includes('/datastack/full/')) {
      return answer({
        local_server: 'https://local.example',
        segmentation_source: 'graphene://https://cg.example/segmentation/table/flywire_public',
        viewer_resolution_x: 16,
      })
    }
    if (text.includes('/metadata')) {
      return answer([{ version: 783, valid: true, status: 'AVAILABLE', time_stamp: STAMP }])
    }
    if (text.includes('is_latest_roots')) {
      const ids = /\[(.*)\]/.exec(String(init?.body ?? ''))?.[1] ?? ''
      const list = ids ? ids.split(',') : []
      return answer({ is_latest: list.map((id) => !stale.includes(id)) })
    }
    return Promise.resolve({
      ok: false,
      status: 404,
      text: () => Promise.resolve('{}'),
    } as Response)
  })
  return calls
}

/** Resolves when a check lands, so a test does not race the fire-and-forget. */
function landed(): Promise<void> {
  return new Promise((resolve) => {
    const stop = subscribeRootCheck(() => {
      stop()
      resolve()
    })
  })
}

/**
 * Polls until a condition holds.
 *
 * Not `landed()` where a chain changes: that fires on the *clear* as well as on the answer, so
 * one notification is not the same as one result.
 */
async function until(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 1))
  if (!ok()) throw new Error('timed out waiting for a check')
}

beforeEach(() => {
  resetCache()
  /*
   * `resetCaveState`, not the two memos this file happens to use. It is the fan-out that exists
   * because suites hand-copied their own lists and the one that missed a memo got cross-test
   * bleed reading as a routing bug — and this suite was one of the hand-written copies.
   */
  resetCaveState()
  resetCredentials()
  setToken(DEFAULT_CAVE_SERVER, 'token')
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetCredentials()
})

describe('what it finds', () => {
  it('names the ids that were not current, and counts them', async () => {
    installFetch(['720575940628857211'])
    const wait = landed()
    startRootCheck(
      DATASET,
      'chain',
      ['720575940628857210', '720575940628857211', '720575940628857212'],
      { deployment: DEFAULT_CAVE_SERVER },
    )
    await wait

    const check = peekRootCheck(DEFAULT_CAVE_SERVER, DATASET)
    expect(check?.checked).toBe(3)
    expect(check?.stale).toBe(1)
    expect(check?.examples).toEqual(['720575940628857211'])
  })

  it('sends the ids as unquoted integers', async () => {
    /*
     * Invariant 8 at this seam. `node_ids` is a list of integers on the wire, and an eighteen-digit
     * root id through `JSON.stringify` of a `number` is a *different neuron* — while quoting them
     * is a type `is_latest_roots` was never promised to accept. So the digits are spliced as text,
     * the answer `idList` gives for Cypher and `pyLongIntList` for the notebook.
     */
    const calls = installFetch()
    const wait = landed()
    startRootCheck(DATASET, 'chain', ['720575940628857210'], {
      deployment: DEFAULT_CAVE_SERVER,
    })
    await wait

    const post = calls.find((c) => c.url.includes('is_latest_roots'))!
    expect(post.body).toBe('{"node_ids":[720575940628857210]}')
    expect(post.body).not.toContain('"720575940628857210"')
    /*
     * The materialization's own instant, in epoch seconds, which is what the answer is about —
     * and written out rather than re-derived. This assertion used to read
     * `Date.parse(STAMP) / 1000`, i.e. the same expression the code used, so it agreed with any
     * answer that expression gave: on a machine in `Europe/London` in August that is an hour
     * early, and in `America/Los_Angeles` seven hours. See `parseCaveTimestamp`.
     */
    expect(post.url).toContain(`timestamp=${STAMP_EPOCH_SECONDS}`)
  })
})

/**
 * CAVE writes an instant with no zone on it and means UTC; `Date.parse` reads that as *local*.
 *
 * Worth its own case because the damage is invisible from either end: the instant goes into the
 * chunkedgraph query **and** into the permanent cache key beside it, so a skewed one asks about a
 * moment the materialization was never frozen at and then keeps the answer forever. That
 * caveclient means UTC is not inferred — it parses the same field with
 * `strptime(...).replace(tzinfo=timezone.utc)`.
 */
describe('the instant a materialization was frozen', () => {
  it('reads a zone-less stamp as UTC, not as local time', () => {
    expect(parseCaveTimestamp(STAMP)).toBe(STAMP_EPOCH_SECONDS * 1000)
    // The three spellings of one instant must agree. A naive stamp read as local time agrees
    // with the other two only on a machine that happens to be running in UTC.
    expect(parseCaveTimestamp(`${STAMP}Z`)).toBe(STAMP_EPOCH_SECONDS * 1000)
    expect(parseCaveTimestamp('2023-08-29T02:00:00.000000+02:00')).toBe(
      STAMP_EPOCH_SECONDS * 1000,
    )
  })

  it('keeps an offset the deployment does send, rather than shifting it twice', () => {
    // Appending `Z` unconditionally would make `+02:00` parse as UTC and lose two hours.
    expect(parseCaveTimestamp('2023-08-29T00:00:00+00:00')).toBe(STAMP_EPOCH_SECONDS * 1000)
    expect(parseCaveTimestamp('2023-08-29T00:00:00+0000')).toBe(STAMP_EPOCH_SECONDS * 1000)
  })

  it('answers undefined for a stamp it cannot read, rather than NaN', () => {
    // `NaN` would reach the query string as `timestamp=NaN` and the cache key as `|NaN`.
    expect(parseCaveTimestamp('not a date')).toBeUndefined()
  })
})

describe('which chain it is about', () => {
  /*
   * The report used to be keyed on the dataset alone and taken once per session, which made it
   * answer to whatever was wired first rather than to what is on the canvas. Both directions were
   * reported: dropping an `Update root IDs` in left the warning up, and pulling one out never
   * raised it. The chain's provenance key is what distinguishes the two wirings.
   */
  const STALE = '720575940628857211'
  const REPAIRED = '720575940628857299'

  it('drops the warning when a repair changes the ids', async () => {
    installFetch([STALE])
    startRootCheck(DATASET, 'raw', [STALE], { deployment: DEFAULT_CAVE_SERVER })
    await until(() => peekRootCheck(DEFAULT_CAVE_SERVER, DATASET)?.stale === 1)

    // `Update root IDs` between the base and the dataset: one dataset, a different chain.
    startRootCheck(DATASET, 'repaired', [REPAIRED], { deployment: DEFAULT_CAVE_SERVER })
    await until(() => peekRootCheck(DEFAULT_CAVE_SERVER, DATASET)?.checked === 1)
    expect(peekRootCheck(DEFAULT_CAVE_SERVER, DATASET)?.stale).toBe(0)
  })

  it('raises it when the repair is taken back out', async () => {
    installFetch([STALE])
    startRootCheck(DATASET, 'repaired', [REPAIRED], { deployment: DEFAULT_CAVE_SERVER })
    await until(() => peekRootCheck(DEFAULT_CAVE_SERVER, DATASET)?.checked === 1)
    expect(peekRootCheck(DEFAULT_CAVE_SERVER, DATASET)?.stale).toBe(0)

    startRootCheck(DATASET, 'raw', [STALE], { deployment: DEFAULT_CAVE_SERVER })
    await until(() => peekRootCheck(DEFAULT_CAVE_SERVER, DATASET)?.stale === 1)
  })

  it('forgets it when the annotations are unplugged', async () => {
    // Nothing wired is a real answer, not a reason to keep the last one: the warning would
    // otherwise name ids the graph no longer holds.
    installFetch([STALE])
    startRootCheck(DATASET, 'raw', [STALE], { deployment: DEFAULT_CAVE_SERVER })
    await until(() => peekRootCheck(DEFAULT_CAVE_SERVER, DATASET)?.stale === 1)

    startRootCheck(DATASET, undefined, [], { deployment: DEFAULT_CAVE_SERVER })
    expect(peekRootCheck(DEFAULT_CAVE_SERVER, DATASET)).toBeUndefined()
  })

  it('asks again after a failure, rather than going quiet for the session', async () => {
    // A dropped connection is not an answer. The claim on the entry is released so the next run
    // asks — unlike a settled "nothing to say", where no chunkedgraph means never.
    installFetch([STALE])
    const inner = globalThis.fetch as typeof fetch
    let firstAsk = true
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      if (String(url).includes('is_latest_roots') && firstAsk) {
        firstAsk = false
        return Promise.resolve({
          ok: false,
          status: 500,
          text: () => Promise.resolve('{}'),
        } as Response)
      }
      return inner(url as never, init)
    })

    startRootCheck(DATASET, 'raw', [STALE], { deployment: DEFAULT_CAVE_SERVER })
    await until(() => firstAsk === false)
    await new Promise((r) => setTimeout(r, 20))
    expect(peekRootCheck(DEFAULT_CAVE_SERVER, DATASET)).toBeUndefined()

    startRootCheck(DATASET, 'raw', [STALE], { deployment: DEFAULT_CAVE_SERVER })
    await until(() => peekRootCheck(DEFAULT_CAVE_SERVER, DATASET)?.stale === 1)
  })

  it('lets the newest chain own the answer, whichever lands first', async () => {
    /*
     * The same warning-that-will-not-go-away, arrived at by a race. A check for the chain
     * somebody has already replaced must not overwrite the one that replaced it — and it can
     * easily land second, since the repaired ids are the ones the permanent cache already knows.
     */
    const calls = installFetch([STALE])
    const inner = globalThis.fetch as typeof fetch
    const held: Array<() => void> = []
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const answer = inner(url as never, init)
      if (!String(url).includes('is_latest_roots')) return answer
      return new Promise((resolve) => held.push(() => resolve(answer)))
    })

    startRootCheck(DATASET, 'raw', [STALE], { deployment: DEFAULT_CAVE_SERVER })
    await until(() => held.length === 1)
    startRootCheck(DATASET, 'repaired', [REPAIRED], { deployment: DEFAULT_CAVE_SERVER })
    await until(() => held.length === 2)

    held[1]!()
    await until(() => peekRootCheck(DEFAULT_CAVE_SERVER, DATASET)?.checked === 1)
    expect(peekRootCheck(DEFAULT_CAVE_SERVER, DATASET)?.stale).toBe(0)

    // The chain nobody is on any more, arriving late.
    held[0]!()
    await new Promise((r) => setTimeout(r, 20))
    expect(peekRootCheck(DEFAULT_CAVE_SERVER, DATASET)?.stale).toBe(0)
    expect(calls.filter((c) => c.url.includes('is_latest_roots'))).toHaveLength(2)
  })

  it('announces a drop, since nothing else re-runs validate', async () => {
    // A run does not re-infer, so a warning nobody announces the removal of stays on the card
    // until the next unrelated edit — which is what made this look like it had not worked.
    installFetch([STALE])
    startRootCheck(DATASET, 'raw', [STALE], { deployment: DEFAULT_CAVE_SERVER })
    await until(() => peekRootCheck(DEFAULT_CAVE_SERVER, DATASET)?.stale === 1)

    const wait = landed()
    startRootCheck(DATASET, undefined, [], { deployment: DEFAULT_CAVE_SERVER })
    await wait
  })
})

describe('what keeps it cheap', () => {
  it('asks once per chain, however many times a run reports the same ids', async () => {
    const calls = installFetch()
    const wait = landed()
    startRootCheck(DATASET, 'chain', ['720575940628857210'], {
      deployment: DEFAULT_CAVE_SERVER,
    })
    await wait
    startRootCheck(DATASET, 'chain', ['720575940628857210'], {
      deployment: DEFAULT_CAVE_SERVER,
    })
    startRootCheck(DATASET, 'chain', ['720575940628857210'], {
      deployment: DEFAULT_CAVE_SERVER,
    })

    // The ids arrive on every run of a graph; re-asking on each is the hammering this avoids.
    expect(calls.filter((c) => c.url.includes('is_latest_roots'))).toHaveLength(1)
  })

  it('asks only about ids nobody has asked about before', async () => {
    /*
     * The persistent half, and the reason a second dataset is nearly free: **whether a root was
     * current at a past instant never changes**, so an answer is good forever. Keyed on the
     * segmentation and the frozen timestamp — not on the dataset, and not on the id list — so a
     * base that gained rows costs only the rows it gained.
     */
    const calls = installFetch()
    let wait = landed()
    startRootCheck(DATASET, 'chain', ['720575940628857210', '720575940628857211'], {
      deployment: DEFAULT_CAVE_SERVER,
    })
    await wait

    resetRootChecks()
    wait = landed()
    startRootCheck(
      DATASET,
      'chain',
      ['720575940628857210', '720575940628857211', '720575940628857299'],
      { deployment: DEFAULT_CAVE_SERVER },
    )
    await wait

    const posts = calls.filter((c) => c.url.includes('is_latest_roots'))
    expect(posts).toHaveLength(2)
    // Only the newcomer in the second call.
    expect(posts[1]!.body).toBe('{"node_ids":[720575940628857299]}')
    expect(peekRootCheck(DEFAULT_CAVE_SERVER, DATASET)?.checked).toBe(3)
  })

  it('deduplicates, because an annotation base repeats a root id', async () => {
    // Measured at 1,089 neurons on FlyTable's `main.info`, one of them 104 times over.
    const calls = installFetch()
    const wait = landed()
    startRootCheck(
      DATASET,
      'chain',
      ['720575940628857210', '720575940628857210', '720575940628857210'],
      { deployment: DEFAULT_CAVE_SERVER },
    )
    await wait
    expect(calls.find((c) => c.url.includes('is_latest_roots'))!.body).toBe(
      '{"node_ids":[720575940628857210]}',
    )
  })

  it('asks nothing at all of a datastack with no chunkedgraph', async () => {
    // Root ids do not move there, so there is nothing to warn about and no reason to call.
    const calls = installFetch([], {
      '/datastack/full/': {
        local_server: 'https://local.example',
        segmentation_source: 'precomputed://gs://somewhere/seg',
      },
    })
    startRootCheck(DATASET, 'chain', ['720575940628857210'], {
      deployment: DEFAULT_CAVE_SERVER,
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(calls.filter((c) => c.url.includes('is_latest_roots'))).toHaveLength(0)
    expect(peekRootCheck(DEFAULT_CAVE_SERVER, DATASET)).toBeUndefined()
  })
})

/** The level-2 chunk counts SEAM's tree ranker reads as `l2c`/`l2x`. See `l2ChunkCounts`. */
describe('level-2 chunk counts', () => {
  const graphene = {
    server: 'https://cave.example.org',
    table: 'test_table',
    base: 'https://cave.example.org/segmentation/table/test_table',
  }
  /** The deployment is required so a request cannot be signed with another account's token. */
  const OPTIONS = { deployment: DEFAULT_CAVE_SERVER }
  /** `leaves_many` answers `{"<root>": [chunk ids]}`, and an id it does not know is absent. */
  const serve = (lists: Record<string, number[]>) => {
    const calls: { url: string; nodes: string[] }[] = []
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { node_ids?: (string | number)[] }
      calls.push({ url: String(url), nodes: (body.node_ids ?? []).map(String) })
      const out: Record<string, number[]> = {}
      for (const id of body.node_ids ?? [])
        if (lists[String(id)]) out[String(id)] = lists[String(id)]!
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify(out)),
      } as Response)
    })
    return calls
  }

  it('counts each root’s chunks, and asks the graph at level 2', async () => {
    const calls = serve({ '100': [1, 2, 3, 4], '200': [7] })
    const got = await l2ChunkCounts(graphene, ['100', '200'], OPTIONS)
    expect(got.get('100')).toBe(4)
    expect(got.get('200')).toBe(1)
    expect(new URL(calls[0]!.url).searchParams.get('stop_layer')).toBe('2')
  })

  /* Why this exists: `leavesMany`'s "Whole lists, not a sample". */
  it('does not cap a large object at the vote’s sample size', async () => {
    serve({ '100': Array.from({ length: 1234 }, (_, i) => i) })
    const got = await l2ChunkCounts(graphene, ['100'], OPTIONS)
    expect(got.get('100')).toBe(1234)
  })

  /* Why this exists: `l2ChunkCounts`' "absent, not zero". */
  it('leaves a root the graph does not know out of the answer', async () => {
    serve({ '100': [1, 2] })
    const got = await l2ChunkCounts(graphene, ['100', '999'], OPTIONS)
    expect(got.get('100')).toBe(2)
    expect(got.has('999')).toBe(false)
  })

  /* A root id names one fixed state of the graph, so a count read once is right forever. */
  it('asks the graph once for a root it has already counted', async () => {
    const calls = serve({ '100': [1, 2], '200': [3] })
    await l2ChunkCounts(graphene, ['100'], OPTIONS)
    expect(calls).toHaveLength(1)
    await l2ChunkCounts(graphene, ['100'], OPTIONS)
    expect(calls).toHaveLength(1)
    // A root it has not seen is still asked, and the batch holds only that one.
    await l2ChunkCounts(graphene, ['100', '200'], OPTIONS)
    expect(calls).toHaveLength(2)
    expect(calls[1]!.nodes).toEqual(['200'])
  })

  it('asks for a repeated root once within a single call', async () => {
    const calls = serve({ '100': [1] })
    await l2ChunkCounts(graphene, ['100', '100', '100'], OPTIONS)
    expect(calls[0]!.nodes).toEqual(['100'])
  })

  /**
   * **A count belongs to one segmentation.** A chunkedgraph id is unique within its own table,
   * not across tables, and reviewing against a production chunkedgraph while a dataset node sits
   * on the public snapshot is two tables in one session. Keyed on the bare root, the second
   * table's root is served the first table's count — a believable number, nothing to notice it.
   */
  it('does not serve one table’s count for another table’s root', async () => {
    const other = { ...graphene, table: 'other_table' }
    serve({ '100': [1, 2, 3] })
    expect((await l2ChunkCounts(graphene, ['100'], OPTIONS)).get('100')).toBe(3)
    const calls = serve({ '100': [1] })
    expect((await l2ChunkCounts(other, ['100'], OPTIONS)).get('100')).toBe(1)
    expect(calls).toHaveLength(1)
  })

  /**
   * **Absence is remembered too.** A root the graph does not list will not start appearing, so
   * re-asking is a round trip that can only answer "still absent" — and the search's premise is
   * that roots recur across neighbouring tips, which makes it one unremovable request per open
   * end. It stays out of the *answer*; it does not stay out of the memo.
   */
  it('asks once about a root the graph does not know, not once per call', async () => {
    const calls = serve({ '100': [1] })
    await l2ChunkCounts(graphene, ['100', '999'], OPTIONS)
    expect(calls).toHaveLength(1)
    const got = await l2ChunkCounts(graphene, ['999'], OPTIONS)
    expect(calls).toHaveLength(1)
    expect(got.has('999')).toBe(false)
  })
})
