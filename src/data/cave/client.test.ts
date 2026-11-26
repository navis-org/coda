/**
 * The CAVE client's one decision about asking again (`readAgain`): a read that got no answer is
 * asked twice more, a moment apart; a status is the server's answer and final; and **a write is
 * never asked again** — a merge whose reply was lost may have happened.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { CaveError, caveGet, caveGetBytes, cavePostWrite } from './client'
import { DEFAULT_CAVE_SERVER } from './deployments'

const OPTIONS = { deployment: DEFAULT_CAVE_SERVER, token: 't' }
const URL_ = 'https://cave.example.org/segmentation/api/v1/table/t/is_latest_roots'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** A server that answers each request with the next of `answers`: a status, or no answer. */
function serve(...answers: (number | 'none')[]) {
  let asked = 0
  vi.stubGlobal('fetch', async () => {
    const answer = answers[Math.min(asked, answers.length - 1)]!
    asked += 1
    if (answer === 'none') throw new TypeError('Failed to fetch')
    return new Response(answer === 200 ? '{"ok":true}' : '{"message":"busy"}', {
      status: answer,
    })
  })
  return () => asked
}

/** Run `ask` with the waits between attempts passed at once. */
async function settled<T>(ask: () => Promise<T>): Promise<T> {
  vi.useFakeTimers()
  const answer = ask()
  // Keep the rejection from surfacing as unhandled while the timers run.
  answer.catch(() => {})
  await vi.runAllTimersAsync()
  return answer
}

describe('asking a read again', () => {
  it.each<[string, (number | 'none')[]]>([
    ['no answer', ['none', 200]],
    ['no answer, twice', ['none', 'none', 200]],
  ])('asks again after %s', async (_, answers) => {
    const asked = serve(...answers)
    expect(await settled(() => caveGet(URL_, OPTIONS))).toEqual({ ok: true })
    expect(asked()).toBe(answers.length)
  })

  it('gives up after three tries, with the last failure', async () => {
    const asked = serve('none')
    await expect(settled(() => caveGet(URL_, OPTIONS))).rejects.toMatchObject({
      noAnswer: true,
    })
    expect(asked()).toBe(3)
  })

  it('asks again for bytes, as for JSON', async () => {
    const asked = serve('none', 200)
    const bytes = await settled(() => caveGetBytes(URL_, OPTIONS))
    expect(new TextDecoder().decode(bytes)).toBe('{"ok":true}')
    expect(asked()).toBe(2)
  })

  it('asks again for a reply cut off while it was read, JSON or bytes', async () => {
    for (const ask of [() => caveGet(URL_, OPTIONS), () => caveGetBytes(URL_, OPTIONS)]) {
      let asked = 0
      vi.stubGlobal('fetch', async () => {
        asked += 1
        if (asked > 1) return new Response('{"ok":true}', { status: 200 })
        // Headers arrived, then the connection went.
        const cut = new ReadableStream({ pull: (c) => c.error(new TypeError('network error')) })
        return new Response(cut, { status: 200 })
      })
      await settled(ask)
      expect(asked).toBe(2)
    }
  })

  it('takes a missing body as an answer, not a failure to ask again', async () => {
    const asked = serve(404, 200)
    expect(await settled(() => caveGetBytes(URL_, OPTIONS))).toBeUndefined()
    expect(asked()).toBe(1)
  })

  it.each([400, 404, 429, 500, 503])('takes a %i as the answer', async (status) => {
    const asked = serve(status, 200)
    await expect(settled(() => caveGet(URL_, OPTIONS))).rejects.toBeInstanceOf(CaveError)
    expect(asked()).toBe(1)
  })

  it('stops waiting at a Cancel, and asks nothing more', async () => {
    vi.useFakeTimers()
    const asked = serve('none', 200)
    const cancel = new AbortController()
    const answer = caveGet(URL_, { ...OPTIONS, signal: cancel.signal })
    answer.catch(() => {})
    await vi.advanceTimersByTimeAsync(10)
    cancel.abort()
    await vi.runAllTimersAsync()
    await expect(answer).rejects.toMatchObject({ name: 'AbortError' })
    expect(asked()).toBe(1)
  })
})

describe('a write', () => {
  it('is never asked again after no answer', async () => {
    const asked = serve('none', 200)
    await expect(settled(() => cavePostWrite(URL_, '{}', OPTIONS))).rejects.toBeInstanceOf(
      CaveError,
    )
    expect(asked()).toBe(1)
  })
})
