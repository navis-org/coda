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
import { resetDatastackRecords } from './datastack'
import { peekRootCheck, resetRootChecks, startRootCheck, subscribeRootCheck } from './rootIds'

const DATASTACK = 'flywire_fafb_public'
const DATASET = `${DATASTACK}:783`
const STAMP = '2023-08-29T00:00:00.000000'

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
    return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('{}') } as Response)
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

beforeEach(() => {
  resetCache()
  resetRootChecks()
  resetDatastackRecords()
  resetCredentials()
  setToken('token')
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetCredentials()
})

describe('what it finds', () => {
  it('names the ids that were not current, and counts them', async () => {
    installFetch(['720575940628857211'])
    const wait = landed()
    startRootCheck(DATASET, ['720575940628857210', '720575940628857211', '720575940628857212'])
    await wait

    const check = peekRootCheck(DATASET)
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
    startRootCheck(DATASET, ['720575940628857210'])
    await wait

    const post = calls.find((c) => c.url.includes('is_latest_roots'))!
    expect(post.body).toBe('{"node_ids":[720575940628857210]}')
    expect(post.body).not.toContain('"720575940628857210"')
    // The materialization's own instant, in epoch seconds, which is what the answer is about.
    expect(post.url).toContain(`timestamp=${Date.parse(STAMP) / 1000}`)
  })
})

describe('what keeps it cheap', () => {
  it('asks once per dataset, however many times a run reports the same ids', async () => {
    const calls = installFetch()
    const wait = landed()
    startRootCheck(DATASET, ['720575940628857210'])
    await wait
    startRootCheck(DATASET, ['720575940628857210'])
    startRootCheck(DATASET, ['720575940628857210'])

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
    startRootCheck(DATASET, ['720575940628857210', '720575940628857211'])
    await wait

    resetRootChecks()
    wait = landed()
    startRootCheck(DATASET, ['720575940628857210', '720575940628857211', '720575940628857299'])
    await wait

    const posts = calls.filter((c) => c.url.includes('is_latest_roots'))
    expect(posts).toHaveLength(2)
    // Only the newcomer in the second call.
    expect(posts[1]!.body).toBe('{"node_ids":[720575940628857299]}')
    expect(peekRootCheck(DATASET)?.checked).toBe(3)
  })

  it('deduplicates, because an annotation base repeats a root id', async () => {
    // Measured at 1,089 neurons on FlyTable's `main.info`, one of them 104 times over.
    const calls = installFetch()
    const wait = landed()
    startRootCheck(DATASET, ['720575940628857210', '720575940628857210', '720575940628857210'])
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
    startRootCheck(DATASET, ['720575940628857210'])
    await new Promise((r) => setTimeout(r, 50))
    expect(calls.filter((c) => c.url.includes('is_latest_roots'))).toHaveLength(0)
    expect(peekRootCheck(DATASET)).toBeUndefined()
  })
})
