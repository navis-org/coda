import { afterEach, describe, expect, it, vi } from 'vitest'

import { NotFoundError, fetchText } from './fetchText'

afterEach(() => vi.unstubAllGlobals())

/** A fetch that never answers, rejecting with its signal's reason when that signal aborts. */
function hangingFetch() {
  return vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason)),
      ),
  )
}

describe('fetchText', () => {
  it('sends a POST body when asked, and still omits credentials', async () => {
    const fetch = vi.fn(async () => new Response('ok'))
    vi.stubGlobal('fetch', fetch)
    await fetchText('https://x.test/q', {
      init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    })
    expect(fetch).toHaveBeenCalledWith(
      'https://x.test/q',
      expect.objectContaining({ method: 'POST', body: '{}', credentials: 'omit' }),
    )
  })

  it('keeps a cancellation a cancellation, not an unreachable host', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    const controller = new AbortController()
    const read = fetchText('https://x.test/a', { signal: controller.signal })
    controller.abort()
    await expect(read).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('reports a 404 as a NotFoundError, as before', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 })),
    )
    await expect(fetchText('https://x.test/gone')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('reports a dead host as unreachable or refused, with the caller’s hint, as before', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    await expect(fetchText('https://x.test/dead', { hint: 'Hint.' })).rejects.toThrow(
      /may refuse cross-origin reads\. The browser does not say which\. Hint\./,
    )
  })
})
