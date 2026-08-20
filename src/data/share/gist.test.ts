// @vitest-environment jsdom

/**
 * Writing and reading a workflow gist.
 *
 * `fetch` is stubbed rather than recorded, unlike `neuprint.test.ts`'s fixtures: what matters
 * here is the *request* — which method, which body, and what is deliberately left out of a
 * PATCH — and a recorded response says nothing about any of that. The two response shapes that
 * are real (`truncated`, and a multi-file gist) are the ones asserted against.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installStorageStub, clearStorage } from '../../test/jsdomStubs'
import {
  resetGithubCredentials,
  setGithubToken,
  subscribeGithubAuthFailure,
} from './credentials'
import { createGist, githubLogin, readGist, updateGist } from './gist'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

let calls: Call[]

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function stubFetch(handler: (call: Call) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v
    }
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }
    calls.push(call)
    return Promise.resolve(handler(call))
  })
}

const OPTIONS = {
  json: '{"nodes":[]}',
  name: 'LC4 sweep',
  filename: 'lc4-sweep.coda.json',
  secret: false,
  appVersion: '0.1.0',
}

beforeEach(() => {
  installStorageStub()
  clearStorage()
  resetGithubCredentials()
  calls = []
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetGithubCredentials()
})

describe('creating', () => {
  it('refuses without a token rather than sending an anonymous POST', async () => {
    // GitHub removed anonymous gists in 2018, so an unauthenticated POST is a 401 with a
    // message about authentication — useless next to one naming the field that fixes it.
    stubFetch(() => reply(401, { message: 'Requires authentication' }))
    await expect(createGist(OPTIONS)).rejects.toThrow(/Connections ▸ Sharing/)
    expect(calls).toHaveLength(0)
  })

  it('POSTs one file, pinning the API version and marking visibility', async () => {
    setGithubToken('ghp_test')
    stubFetch(() => reply(201, { id: 'abc123', owner: { login: 'schlegelp' } }))

    expect(await createGist({ ...OPTIONS, secret: true })).toEqual({
      id: 'abc123',
      owner: 'schlegelp',
    })
    const [call] = calls
    expect(call?.method).toBe('POST')
    expect(call?.url).toBe('https://api.github.com/gists')
    expect(call?.headers['authorization']).toBe('Bearer ghp_test')
    expect(call?.headers['x-github-api-version']).toBe('2022-11-28')
    expect(call?.body).toEqual({
      description: 'LC4 sweep — a Coda workflow (coda 0.1.0)',
      public: false,
      files: { 'lc4-sweep.coda.json': { content: '{"nodes":[]}' } },
    })
  })

  it('sends public: true for a listed gist', async () => {
    setGithubToken('ghp_test')
    stubFetch(() => reply(201, { id: 'abc123' }))
    await createGist(OPTIONS)
    expect((calls[0]?.body as { public: boolean }).public).toBe(true)
  })
})

describe('updating', () => {
  /**
   * A gist's visibility is fixed at creation and PATCHing it is a 422 — on an update that was
   * otherwise perfectly good, which reads as the whole feature being broken.
   */
  it('PATCHes without `public`, because a gist cannot change visibility', async () => {
    setGithubToken('ghp_test')
    stubFetch(() => reply(200, { id: 'abc123', owner: { login: 'schlegelp' } }))

    await updateGist('abc123', { ...OPTIONS, secret: true })
    expect(calls[0]?.method).toBe('PATCH')
    expect(calls[0]?.url).toBe('https://api.github.com/gists/abc123')
    expect(calls[0]?.body).not.toHaveProperty('public')
  })
})

describe('reading', () => {
  it('needs no token — which is what makes a shared link work for anybody', async () => {
    stubFetch(() =>
      reply(200, { files: { 'w.coda.json': { filename: 'w.coda.json', content: '{"a":1}' } } }),
    )
    expect(await readGist('abc123')).toBe('{"a":1}')
    expect(calls[0]?.headers['authorization']).toBeUndefined()
  })

  it('asks for a pinned revision when the link carries one', async () => {
    stubFetch(() => reply(200, { files: { 'w.coda.json': { content: '{}' } } }))
    await readGist('abc123', '37a0cd14')
    expect(calls[0]?.url).toBe('https://api.github.com/gists/abc123/37a0cd14')
  })

  /** People add notes to their gists. The workflow is the file that says it is one. */
  it('picks the .coda.json out of a gist that has grown other files', async () => {
    stubFetch(() =>
      reply(200, {
        files: {
          'README.md': { filename: 'README.md', content: '# notes' },
          'w.coda.json': { filename: 'w.coda.json', content: '{"graph":true}' },
        },
      }),
    )
    expect(await readGist('abc123')).toBe('{"graph":true}')
  })

  it('takes a lone file whatever it is called, so a hand-made gist still opens', async () => {
    stubFetch(() =>
      reply(200, { files: { 'workflow.json': { filename: 'workflow.json', content: '{}' } } }),
    )
    expect(await readGist('abc123')).toBe('{}')
  })

  it('names what it found when several files are there and none is a workflow', async () => {
    stubFetch(() =>
      reply(200, {
        files: {
          'a.py': { filename: 'a.py', content: '' },
          'b.md': { filename: 'b.md', content: '' },
        },
      }),
    )
    await expect(readGist('abc123')).rejects.toThrow(/a\.py, b\.md/)
  })

  /**
   * The API stops inlining content above 1 MB and hands back a `raw_url`. Ignoring the flag
   * yields a *partial* graph that parses, which is worse than one that does not.
   */
  it('follows raw_url when the API says the content was truncated', async () => {
    stubFetch((call) =>
      call.url.startsWith('https://api.github.com')
        ? reply(200, {
            files: {
              'w.coda.json': {
                filename: 'w.coda.json',
                content: '{"partial"',
                truncated: true,
                raw_url: 'https://gist.githubusercontent.com/x/raw/w.coda.json',
              },
            },
          })
        : new Response('{"whole":true}', { status: 200 }),
    )
    expect(await readGist('abc123')).toBe('{"whole":true}')
    expect(calls).toHaveLength(2)
  })
})

describe('failures', () => {
  it('sends a 401 down the auth channel as well as throwing', async () => {
    setGithubToken('ghp_bad')
    const seen: string[] = []
    const stop = subscribeGithubAuthFailure((message) => seen.push(message))
    stubFetch(() => reply(401, { message: 'Bad credentials' }))

    await expect(createGist(OPTIONS)).rejects.toThrow(/Bad credentials/)
    expect(seen).toHaveLength(1)
    stop()
  })

  /** A deleted gist and somebody else's private one are the same 404 from here. */
  it('explains a 404 as deleted-or-private rather than repeating the status', async () => {
    stubFetch(() => reply(404, { message: 'Not Found' }))
    await expect(readGist('gone')).rejects.toThrow(/deleted, or it may be private/)
  })

  it('points an anonymous rate limit at the token that raises it', async () => {
    stubFetch(() => reply(403, { message: 'API rate limit exceeded' }))
    await expect(readGist('abc123')).rejects.toThrow(/rate-limited by IP/)
  })
})

describe('the login', () => {
  it('is asked once and cached, because the share dialog asks on every open', async () => {
    setGithubToken('ghp_test')
    stubFetch(() => reply(200, { login: 'schlegelp' }))
    expect(await githubLogin()).toBe('schlegelp')
    expect(await githubLogin()).toBe('schlegelp')
    expect(calls).toHaveLength(1)
  })

  it('is dropped when the token changes — the new one may be somebody else', async () => {
    setGithubToken('ghp_one')
    stubFetch((call) => reply(200, { login: call.headers['authorization'] ?? '' }))
    expect(await githubLogin()).toBe('Bearer ghp_one')
    setGithubToken('ghp_two')
    expect(await githubLogin()).toBe('Bearer ghp_two')
  })

  /**
   * Observed live: `StrictMode` invokes the share dialog's effect twice, and the cache is
   * written only when the answer lands — so both passes miss it and a single dialog opening
   * spends two calls against a rate-limited API.
   */
  it('is one request for two callers that start together', async () => {
    setGithubToken('ghp_test')
    stubFetch(() => reply(200, { login: 'schlegelp' }))
    const [a, b] = await Promise.all([githubLogin(), githubLogin()])
    expect([a, b]).toEqual(['schlegelp', 'schlegelp'])
    expect(calls).toHaveLength(1)
  })

  it('answers undefined with no token rather than asking anonymously', async () => {
    stubFetch(() => reply(200, { login: 'nobody' }))
    expect(await githubLogin()).toBeUndefined()
    expect(calls).toHaveLength(0)
  })
})
