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
  isLatestRoots,
  l2ChunkCounts,
  peekRootCheck,
  resetRootChecks,
  rootLives,
  rootTimestamps,
  rootsAtInstant,
  startRootCheck,
  subscribeRootCheck,
  supervoxelRoots,
} from './rootIds'
import { resetCaveState } from './tables'
import { DEFAULT_CAVE_SERVER } from './deployments'
import { parseCaveJson } from './json'

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

/** The chunkedgraph the direct lookups below ask, and the options they ask with. */
const graphene = {
  server: 'https://cave.example.org',
  table: 'test_table',
  base: 'https://cave.example.org/segmentation/table/test_table',
}
/** The deployment is required so a request cannot be signed with another account's token. */
const OPTIONS = { deployment: DEFAULT_CAVE_SERVER }

/** The level-2 chunk counts SEAM's tree ranker reads as `l2c`/`l2x`. See `l2ChunkCounts`. */
describe('level-2 chunk counts', () => {
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

  /**
   * A `leaves_many` server that answers on a macrotask, recording how many were open at once.
   *
   * The delay is the whole instrument: a fake that resolves synchronously settles each batch
   * before the next is asked for, so a sequential loop and a pool of four would both show a peak
   * of one and the test would pass either way.
   */
  const servePeak = (lists: Record<string, number[]>) => {
    const calls: string[][] = []
    let open = 0
    let peak = 0
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { node_ids?: (string | number)[] }
      const nodes = (body.node_ids ?? []).map(String)
      calls.push(nodes)
      open += 1
      peak = Math.max(peak, open)
      return new Promise<Response>((resolve) =>
        setTimeout(() => {
          open -= 1
          const out: Record<string, number[]> = {}
          for (const id of nodes) if (lists[id]) out[id] = lists[id]!
          resolve({
            ok: true,
            status: 200,
            text: () => Promise.resolve(JSON.stringify(out)),
          } as Response)
        }, 0),
      )
    })
    return { calls, peak: () => peak }
  }

  const manyRoots = (n: number) => Array.from({ length: n }, (_, i) => String(1_000 + i))
  const oneChunkEach = (roots: readonly string[]) =>
    Object.fromEntries(roots.map((root) => [root, [1]]))

  /**
   * **The stage this was changed for.** A candidate pool is about 500 roots, so an open end is
   * ten of these — and `Suggest Merges` measured them at 33% of a 6.2 s end, more than the GPU.
   * Ten round trips in a row is latency the caller is standing in rather than work.
   *
   * Both ends are pinned on purpose. A peak of one is the sequential loop coming back, which is
   * the regression a later edit would make silently; a peak of ten is the politeness gone, at a
   * shared public chunkedgraph that SEAM's invariant 8 is about.
   */
  it('asks four batches at once — not one at a time, and not all of them', async () => {
    const roots = manyRoots(500)
    const server = servePeak(oneChunkEach(roots))
    const got = await l2ChunkCounts(graphene, roots, OPTIONS)
    expect(got.size).toBe(500)
    expect(server.calls).toHaveLength(10)
    expect(server.peak()).toBe(4)
  })

  /** Disjoint slices of what this call found missing, so no two batches can ask for one root. */
  it('splits the roots across the batches rather than overlapping them', async () => {
    const roots = manyRoots(120)
    const server = servePeak(oneChunkEach(roots))
    await l2ChunkCounts(graphene, roots, OPTIONS)
    expect(server.calls.flat()).toHaveLength(120)
    expect(new Set(server.calls.flat()).size).toBe(120)
  })

  /**
   * **A failed batch fails the read**, which is `src/data/concurrency.ts`' `inFlight` rather than
   * `mapWithConcurrency` and is the reason that choice is not interchangeable here. A forgiven
   * batch comes back as roots missing from the map, and `countsInPoolOrder` then refuses them as
   * a hole in the pool — a request failure reported as a fact about the data.
   */
  it('fails the whole read when a batch fails, and keeps what the others bought', async () => {
    const roots = manyRoots(100)
    const lists = oneChunkEach(roots)
    let refuseFrom: string | undefined = roots[50]
    const calls: string[][] = []
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { node_ids?: (string | number)[] }
      const nodes = (body.node_ids ?? []).map(String)
      calls.push(nodes)
      if (refuseFrom !== undefined && nodes.includes(refuseFrom)) {
        return Promise.resolve({
          ok: false,
          status: 503,
          text: () => Promise.resolve('busy'),
        } as Response)
      }
      const out: Record<string, number[]> = {}
      for (const id of nodes) if (lists[id]) out[id] = lists[id]!
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify(out)),
      } as Response)
    })
    await expect(l2ChunkCounts(graphene, roots, OPTIONS)).rejects.toThrow()
    // The batch that landed is remembered, so the retry asks only for the one that did not.
    calls.length = 0
    refuseFrom = undefined
    const got = await l2ChunkCounts(graphene, roots, OPTIONS)
    expect(got.size).toBe(100)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toHaveLength(50)
  })

  /**
   * **Two calls at once share a batch in flight** rather than both asking. The search counts
   * several ends at once, and neighbouring ends' pools are mostly the same roots.
   */
  it('asks once for a root two concurrent calls both want', async () => {
    const roots = manyRoots(80)
    const server = servePeak(oneChunkEach(roots))
    const [a, b] = await Promise.all([
      l2ChunkCounts(graphene, roots.slice(0, 60), OPTIONS),
      l2ChunkCounts(graphene, roots.slice(20), OPTIONS),
    ])
    expect(a.size).toBe(60)
    expect(b.size).toBe(60)
    const asked = server.calls.flat()
    expect(asked).toHaveLength(80)
    expect(new Set(asked).size).toBe(80)
  })

  /* A joiner of a batch that fails fails with it, and the failure leaves nothing to join. */
  it('fails a caller that joined a failed batch, and asks again afterwards', async () => {
    let refuse = true
    const calls: string[][] = []
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { node_ids?: (string | number)[] }
      const nodes = (body.node_ids ?? []).map(String)
      calls.push(nodes)
      return new Promise<Response>((resolve) =>
        setTimeout(() => {
          resolve(
            refuse
              ? ({ ok: false, status: 503, text: () => Promise.resolve('busy') } as Response)
              : ({
                  ok: true,
                  status: 200,
                  text: () => Promise.resolve(JSON.stringify({ '7001': [1, 2] })),
                } as Response),
          )
        }, 0),
      )
    })
    const first = l2ChunkCounts(graphene, ['7001'], OPTIONS)
    const joiner = l2ChunkCounts(graphene, ['7001'], OPTIONS)
    await expect(first).rejects.toThrow()
    await expect(joiner).rejects.toThrow()
    expect(calls).toHaveLength(1)
    refuse = false
    expect((await l2ChunkCounts(graphene, ['7001'], OPTIONS)).get('7001')).toBe(2)
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

/**
 * Label 0 is a segmentation's background, never a supervoxel. It is answered as root 0 without
 * being sent, so every caller can test the root alone — and the answer must still line up with the
 * ids asked, since a root shifted by one position is a different neuron's.
 */
describe('the root of label 0', () => {
  it('is 0, without asking, and the rest keep their places', async () => {
    const sent: bigint[][] = []
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      const ids = new BigUint64Array(init!.body as ArrayBuffer)
      sent.push([...ids])
      // Every supervoxel's root is itself plus a thousand.
      return new Response(BigUint64Array.from(ids, (id) => id + 1000n).buffer, { status: 200 })
    })
    const got = await rootsAtInstant(
      graphene,
      1_700_000_000_000,
      BigUint64Array.from([0n, 5n, 0n, 7n]),
      OPTIONS,
    )
    expect(sent).toEqual([[5n, 7n]])
    expect([...got]).toEqual([0n, 1005n, 0n, 1007n])
  })

  /**
   * A view's buffer is the whole allocation it was cut from. Ids handed over as a view of a larger
   * array must go as exactly those ids, or every id after the view goes too (`cavePostBinary`).
   */
  it('sends only the ids asked, even when they are a view of a larger array', async () => {
    const sent: bigint[][] = []
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      // Read the bytes fetch would send: a view's own range, whatever it is a view of.
      const body = init!.body as ArrayBufferView
      const ids = new BigUint64Array(body.buffer, body.byteOffset, body.byteLength / 8)
      sent.push([...ids])
      return new Response(BigUint64Array.from(ids, (id) => id + 1000n).buffer, { status: 200 })
    })
    const whole = BigUint64Array.from([5n, 6n, 7n, 8n])
    const got = await rootsAtInstant(graphene, 1_700_000_000_000, whole.subarray(1, 3), OPTIONS)
    expect(sent).toEqual([[6n, 7n]])
    expect([...got]).toEqual([1006n, 1007n])
  })

  /** A short reply filled with zeros would read as "no object" for every id past its end. */
  it('refuses a reply that does not answer every id', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response(BigUint64Array.from([1005n]).buffer, { status: 200 }),
    )
    await expect(
      rootsAtInstant(graphene, 1_700_000_000_000, BigUint64Array.from([5n, 7n]), OPTIONS),
    ).rejects.toThrow(/answered 1 roots for 2 supervoxels/)
  })

  it('asks nothing at all for a box of background', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const got = await rootsAtInstant(
      graphene,
      1_700_000_000_000,
      BigUint64Array.from([0n]),
      OPTIONS,
    )
    expect(fetch).not.toHaveBeenCalled()
    expect([...got]).toEqual([0n])
  })
})

/**
 * **A box's lookup goes out in pieces, four at a time**, because the server's time is per id and
 * one 7,200-id request measured 741 ms against 335 for the same ids as four (2026-11-18). The
 * pieces answer out of order, so what is pinned beside the peak is that every root lands on its
 * own supervoxel: a piece written at the wrong offset is a box of other neurons' roots.
 */
/** A `roots_binary` server whose later pieces answer first, recording the peak in flight. */
const servePieces = () => {
  const sent: bigint[][] = []
  let open = 0
  let peak = 0
  vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
    const body = init!.body as ArrayBufferView
    const ids = [...new BigUint64Array(body.buffer, body.byteOffset, body.byteLength / 8)]
    sent.push(ids)
    open += 1
    peak = Math.max(peak, open)
    return new Promise<Response>((resolve) =>
      setTimeout(
        () => {
          open -= 1
          resolve(
            new Response(BigUint64Array.from(ids, (id) => id + 1_000_000n).buffer, {
              status: 200,
            }),
          )
        },
        // The first piece last: an answer written where it arrived would be caught.
        10 - Math.min(sent.length, 9),
      ),
    )
  })
  return { sent, peak: () => peak }
}

describe('a large lookup', () => {
  it('asks in four pieces at once, each root in its own place', async () => {
    const server = servePieces()
    const ids = BigUint64Array.from({ length: 8_000 }, (_, i) => BigInt(i + 1))
    const got = await rootsAtInstant(graphene, 1_700_000_000_000, ids, OPTIONS)
    expect(server.sent).toHaveLength(4)
    expect(server.peak()).toBe(4)
    expect(new Set(server.sent.flat()).size).toBe(8_000)
    expect(got.every((root, i) => root === ids[i]! + 1_000_000n)).toBe(true)
  })

  /** A request costs ~145 ms however small, so a few hundred ids are not worth four of them. */
  it('keeps a small lookup to one request', async () => {
    const server = servePieces()
    await rootsAtInstant(
      graphene,
      1_700_000_000_000,
      BigUint64Array.from({ length: 1_500 }, (_, i) => BigInt(i + 1)),
      OPTIONS,
    )
    expect(server.sent).toHaveLength(1)
  })
})

/**
 * **The chunkedgraph closes its HTTP/2 connections now and then** (`GOAWAY`, code 0), and every
 * request open on one fails at once. These reads are `POST`s, which no browser retries, so one
 * close used to fail a whole run: they are asked again once, and only for a failure that got no
 * answer — an HTTP error is the server's answer.
 */
describe('a dropped connection', () => {
  const answering = (ids: BigUint64Array) =>
    new Response(BigUint64Array.from(ids, (id) => id + 1000n).buffer, { status: 200 })
  const idsOf = (init?: RequestInit) => {
    const body = init!.body as ArrayBufferView
    return new BigUint64Array(body.buffer, body.byteOffset, body.byteLength / 8)
  }

  it('is asked again once, and answers', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      calls += 1
      if (calls === 1) throw new TypeError('fetch failed')
      return answering(idsOf(init))
    })
    const got = await rootsAtInstant(
      graphene,
      1_700_000_000_000,
      BigUint64Array.from([5n]),
      OPTIONS,
    )
    expect([...got]).toEqual([1005n])
    expect(calls).toBe(2)
  })

  it('does not ask again for an answer it got but could not read', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls += 1
      return new Response(new Uint8Array(5).buffer, { status: 200 })
    })
    await expect(
      rootsAtInstant(graphene, 1_700_000_000_000, BigUint64Array.from([5n]), OPTIONS),
    ).rejects.toThrow(/not whole uint64s/)
    expect(calls).toBe(1)
  })

  it('fails if it drops again, and an HTTP error is never asked again', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls += 1
      throw new TypeError('fetch failed')
    })
    await expect(
      rootsAtInstant(graphene, 1_700_000_000_000, BigUint64Array.from([5n]), OPTIONS),
    ).rejects.toThrow()
    expect(calls).toBe(2)
    calls = 0
    vi.stubGlobal('fetch', async () => {
      calls += 1
      return new Response('busy', { status: 503 })
    })
    await expect(
      rootsAtInstant(graphene, 1_700_000_000_000, BigUint64Array.from([5n]), OPTIONS),
    ).rejects.toThrow()
    expect(calls).toBe(1)
  })
})

/**
 * **One budget per server, shared by every call** — the user's sixteen. Four lookup streams a
 * call is a cap per call; five calls at once would be twenty without it.
 */
describe('the budget at one chunkedgraph', () => {
  it('keeps every call together to sixteen requests in flight', async () => {
    const server = servePieces()
    const call = (k: number) =>
      rootsAtInstant(
        graphene,
        1_700_000_000_000,
        BigUint64Array.from({ length: 8_000 }, (_, i) => BigInt(k * 100_000 + i + 1)),
        OPTIONS,
      )
    await Promise.all([0, 1, 2, 3, 4].map(call))
    expect(server.peak()).toBe(16)
  })
})

/**
 * After our own write, a client clock behind the server's would ask about a moment before it and
 * see the old roots — so `'server'` sends no timestamp, and the server answers at its own now.
 */
describe("the server's now", () => {
  const urls = (reply: () => Response) => {
    const asked: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      asked.push(url)
      return reply()
    })
    return asked
  }

  it('asks roots_binary with no timestamp, and a chosen moment with one', async () => {
    const asked = urls(() => new Response(BigUint64Array.from([9n]).buffer, { status: 200 }))
    await rootsAtInstant(graphene, 'server', BigUint64Array.from([5n]), OPTIONS)
    await rootsAtInstant(graphene, 1_700_000_000_000, BigUint64Array.from([5n]), OPTIONS)
    expect(asked).toEqual([
      'https://cave.example.org/segmentation/api/v1/table/test_table/roots_binary',
      'https://cave.example.org/segmentation/api/v1/table/test_table/roots_binary?timestamp=1700000000',
    ])
  })

  it('asks is_latest_roots with no timestamp, the ids as integers', async () => {
    const sent: string[] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      sent.push(url, String(init?.body))
      return new Response('{"is_latest":[true,false]}', { status: 200 })
    })
    const got = await isLatestRoots(graphene, ['720575940621039145', '7'], 'server', OPTIONS)
    expect(got).toEqual([true, false])
    expect(sent).toEqual([
      'https://cave.example.org/segmentation/api/v1/table/test_table/is_latest_roots',
      '{"node_ids":[720575940621039145,7]}',
    ])
  })

  /** An empty list passes `every(Boolean)`; a short one leaves the rest `undefined`. */
  it.each([
    ['no list', '{}'],
    ['a short list', '{"is_latest":[true]}'],
    ['a list of something else', '{"is_latest":[1,0]}'],
  ])('refuses an answer with %s', async (_, body) => {
    vi.stubGlobal('fetch', async () => new Response(body, { status: 200 }))
    await expect(isLatestRoots(graphene, ['1', '2'], 'server', OPTIONS)).rejects.toThrow(
      /one true\/false for each of the 2 roots/,
    )
  })

  /** A merge's two ends, as text: past 2⁵³ both ways, where a number would name another object. */
  it('reads two supervoxels’ roots as text, at the server’s now', async () => {
    const asked: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      asked.push(url)
      return new Response(BigUint64Array.from([720575940621039145n, 2n ** 64n - 1n]).buffer, {
        status: 200,
      })
    })
    const roots = await supervoxelRoots(
      graphene,
      ['73747834149376537', '73747834149376538'],
      'server',
      OPTIONS,
    )
    expect(roots).toEqual(['720575940621039145', '18446744073709551615'])
    expect(asked).toEqual([
      'https://cave.example.org/segmentation/api/v1/table/test_table/roots_binary',
    ])
  })

  it('asks when roots were made, the ids as integers, and answers in ms', async () => {
    const sent: string[] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      sent.push(url, String(init?.body))
      return new Response('{"timestamp":[1700000000.123456]}', { status: 200 })
    })
    const made = await rootTimestamps(graphene, ['720575940621039145'], OPTIONS)
    expect(made[0]).toBeCloseTo(1_700_000_000_123.456, 3)
    expect(sent).toEqual([
      'https://cave.example.org/segmentation/api/v1/table/test_table/root_timestamps',
      '{"node_ids":[720575940621039145]}',
    ])
  })

  it.each([
    ['no list', '{}'],
    ['a short list', '{"timestamp":[]}'],
    ['a list of something else', '{"timestamp":["soon"]}'],
  ])('refuses a root-timestamps answer with %s', async (_, body) => {
    vi.stubGlobal('fetch', async () => new Response(body, { status: 200 }))
    await expect(rootTimestamps(graphene, ['1'], OPTIONS)).rejects.toThrow(
      /one time for each of the 1 roots/,
    )
  })
})

/**
 * When a root was current, for a node that reads a neuron at its own moment. The fake server
 * answers as `wclee_aedes_brain` did when measured (2026-11-17): an id it never made is an empty
 * `root_timestamps` alone and a 500 among others, fails `root_timestamps?latest=true` outright,
 * and is "not latest".
 */
describe('when a root was current', () => {
  const CURRENT = '648518347585551219'
  const REPLACED = '648518347558097460'
  const NEVER = '648518347585551226'
  type Life = { made: number; last: number; latest: boolean }
  const KNOWN: Record<string, Life> = {
    [CURRENT]: { made: 1794901115.922, last: 1794903754.258, latest: true },
    [REPLACED]: { made: 1757950639.839, last: 1794901069.072, latest: false },
  }

  /**
   * `more` adds roots for one test; `short` answers an unknown id among known ones with a short
   * list instead of the 500 that names it — never seen, but the other way a server could say so.
   */
  function installServer({ more = {}, short = false } = {}): string[] {
    const known: Record<string, Life> = { ...KNOWN, ...more }
    const asked: string[] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const body = String(init?.body)
      // Bare integers, never quoted: the server reads `node_ids` as a list of integers.
      expect(body).not.toMatch(/"\d/)
      const ids = parseCaveJson<{ node_ids: string[] }>(body).node_ids
      asked.push(`${url.split('/test_table/')[1]} ${ids.join(',')}`)
      if (url.includes('is_latest_roots')) {
        return Response.json({ is_latest: ids.map((id) => known[id]?.latest ?? false) })
      }
      if (url.includes('latest=true')) {
        if (ids.some((id) => !known[id])) {
          return Response.json({ message: 'pop from an empty deque' }, { status: 500 })
        }
        return Response.json({ timestamp: ids.map((id) => known[id]!.last) })
      }
      // Alone, an unknown id is an empty list; among known ones, a 500 naming it.
      const stranger = ids.find((id) => !known[id])
      if (stranger !== undefined && ids.length > 1 && !short) {
        return Response.json({ message: stranger }, { status: 500 })
      }
      return Response.json({
        timestamp: ids.filter((id) => known[id]).map((id) => known[id]!.made),
      })
    })
    return asked
  }

  it('says when each root was made, when it was last current, and whether that is now', async () => {
    installServer()
    const { lives, unknown } = await rootLives(graphene, [CURRENT, REPLACED, CURRENT], OPTIONS)
    expect(unknown).toEqual([])
    // `last` a millisecond before what `latest=true` answers, as caveclient reads it.
    expect(lives).toEqual(
      new Map([
        [
          CURRENT,
          { made: 1794901115.922 * 1000, last: 1794903754.258 * 1000 - 1, current: true },
        ],
        [
          REPLACED,
          { made: 1757950639.839 * 1000, last: 1794901069.072 * 1000 - 1, current: false },
        ],
      ]),
    )
  })

  it('names an id the chunkedgraph never made, from its own words, and answers the rest', async () => {
    const asked = installServer()
    const { lives, unknown } = await rootLives(graphene, [CURRENT, NEVER, REPLACED], OPTIONS)
    expect(unknown).toEqual([NEVER])
    expect([...lives.keys()]).toEqual([CURRENT, REPLACED])
    // The 500 named it, so the rest are asked once more; `latest=true` never sees it, since it
    // would fail the call for every root beside it.
    expect(asked).toEqual([
      `root_timestamps ${CURRENT},${NEVER},${REPLACED}`,
      `root_timestamps ${CURRENT},${REPLACED}`,
      `root_timestamps?latest=true ${CURRENT},${REPLACED}`,
      `is_latest_roots ${CURRENT},${REPLACED}`,
    ])
  })

  it('finds one unknown id among many in one more request', async () => {
    const many = Array.from({ length: 64 }, (_, i) => String(648518347500000000n + BigInt(i)))
    const asked = installServer({
      more: Object.fromEntries(many.map((root) => [root, { made: 1, last: 2, latest: true }])),
    })
    const { lives, unknown } = await rootLives(graphene, [...many, NEVER], OPTIONS)
    expect(unknown).toEqual([NEVER])
    expect(lives.size).toBe(many.length)
    expect(asked.filter((call) => call.startsWith('root_timestamps ')).length).toBe(2)
  })

  it('halves a batch that comes back short without naming anything', async () => {
    const many = Array.from({ length: 64 }, (_, i) => String(648518347500000000n + BigInt(i)))
    const asked = installServer({
      more: Object.fromEntries(many.map((root) => [root, { made: 1, last: 2, latest: true }])),
      short: true,
    })
    const { lives, unknown } = await rootLives(graphene, [...many, NEVER], OPTIONS)
    expect(unknown).toEqual([NEVER])
    expect(lives.size).toBe(many.length)
    // Asked root by root, 65 roots would be 66 calls to find it.
    expect(asked.filter((call) => call.startsWith('root_timestamps ')).length).toBeLessThan(16)
  })

  it('asks again only what can change: whether a current root still is', async () => {
    const asked = installServer()
    await rootLives(graphene, [CURRENT, REPLACED], OPTIONS)
    asked.length = 0
    const { lives } = await rootLives(graphene, [REPLACED, CURRENT], OPTIONS)
    // When a root was made never changes, and nor does anything about a replaced one.
    expect(asked).toEqual([
      `root_timestamps?latest=true ${CURRENT}`,
      `is_latest_roots ${CURRENT}`,
    ])
    // In the order asked, though the memory answered one of them first.
    expect([...lives.keys()]).toEqual([REPLACED, CURRENT])
    expect(lives.get(REPLACED)?.current).toBe(false)
  })

  it('asks nothing for no roots', async () => {
    const asked = installServer()
    expect(await rootLives(graphene, [], OPTIONS)).toEqual({ lives: new Map(), unknown: [] })
    expect(asked).toEqual([])
  })

  it('refuses a string that is not a root id before anything is sent', async () => {
    const asked = installServer()
    for (const bad of ['-1', '0648518347585551219', '1],"x":[2']) {
      await expect(rootLives(graphene, [CURRENT, bad], OPTIONS)).rejects.toThrow(
        /not a root id/,
      )
    }
    expect(asked).toEqual([])
  })

  it('throws a 500 that names none of the ids at once, rather than splitting the batch', async () => {
    const asked: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      asked.push(url)
      return Response.json({ message: 'server overloaded' }, { status: 500 })
    })
    await expect(rootLives(graphene, [CURRENT, REPLACED], OPTIONS)).rejects.toThrow(
      /overloaded/,
    )
    expect(asked).toHaveLength(1)
  })
})
