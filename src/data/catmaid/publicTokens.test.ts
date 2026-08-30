// @vitest-environment jsdom

/**
 * Virtual Fly Brain's published CATMAID tokens: the snapshot, the refresh, and precedence.
 *
 * What is tested is what would fail **silently**. A token sent to the wrong host, a user's own
 * credential displaced by the anonymous one, a refresh that a cache header turns into a no-op,
 * and a rotated token that takes an instance from "works anonymously" to "fails everywhere" are
 * all things a green suite and a working app would agree about right up until the day they
 * mattered. The live half — that these tokens are accepted by those servers — is
 * `live.test.ts`'s, because it needs the servers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearStorage, installStorageStub } from '../../test/jsdomStubs'
import { catmaidGet, catmaidPost, forgetCatmaidRoutes } from './client'
import { DEFAULT_CATMAID_SERVER, L1_CATMAID_SERVER, resetCredentials, setInstances } from './credentials'
import {
  MANIFEST_URL,
  publicTokenFor,
  publicTokenHosts,
  resetPublicTokens,
  startPublicTokenRefresh,
} from './publicTokens'

const FAFB_MANIFEST_HOST = 'https://fafb.catmaid.virtualflybrain.org'

let calls: { url: string; method: string; headers: Record<string, string>; init?: RequestInit }[] = []

/** `route` answers with a body, or a `Response` when a test needs a specific status. */
function stubFetch(route: (url: string) => unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const url = String(input)
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
        headers[key.toLowerCase()] = value
      }
      calls.push({ url, method: init?.method ?? 'GET', headers, ...(init ? { init } : {}) })
      const body = route(url)
      if (body instanceof Response) return Promise.resolve(body)
      if (body === undefined) {
        return Promise.resolve(new Response('{"detail":"not stubbed"}', { status: 404 }))
      }
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
    }),
  )
}

const manifest = (instances: unknown[]): unknown => ({ schema_version: 1, instances })

/**
 * The CATMAID requests only.
 *
 * `client.ts` starts the manifest refresh from the same line that finds a published token, so
 * the stub sees it too — and an index into `calls` would otherwise be reading the refresh.
 */
const wire = (): typeof calls => calls.filter((call) => call.url !== MANIFEST_URL)

beforeEach(() => {
  installStorageStub()
  clearStorage()
  calls = []
  resetCredentials()
  resetPublicTokens()
  forgetCatmaidRoutes()
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetPublicTokens()
  clearStorage()
})

describe('the committed snapshot', () => {
  it('covers every instance Virtual Fly Brain publishes', () => {
    // Eight instances in `catmaid.json` (2026-08-29), plus the FAFB alias below.
    expect(publicTokenHosts()).toHaveLength(9)
    expect(publicTokenFor(FAFB_MANIFEST_HOST)).toMatch(/^[a-f0-9]{40}$/)
    expect(publicTokenFor(L1_CATMAID_SERVER)).toMatch(/^[a-f0-9]{40}$/)
  })

  /*
   * The alias is the whole reason `ALIASES` exists. `DEFAULT_CATMAID_SERVER` cannot move to the
   * manifest's spelling — `catmaidSourceId` hands out the bare `catmaid` id for that exact
   * string, so changing it re-keys every saved graph — and without the alias the *default*
   * instance would be the one instance with no token.
   */
  it('answers the default server, which the manifest spells differently', () => {
    expect(DEFAULT_CATMAID_SERVER).not.toContain(FAFB_MANIFEST_HOST.replace('https://', ''))
    expect(publicTokenFor(DEFAULT_CATMAID_SERVER)).toBe(publicTokenFor(FAFB_MANIFEST_HOST))
  })

  it('does not answer for a host nobody published', () => {
    expect(publicTokenFor('https://catmaid.example.org')).toBeUndefined()
    // A near-miss, because a token going to the wrong server is the failure worth naming.
    expect(publicTokenFor('https://virtualflybrain.org.evil.com')).toBeUndefined()
    expect(publicTokenFor('https://notl1em.catmaid.virtualflybrain.org')).toBeUndefined()
  })

  it('ignores scheme, port and path, because a token belongs to a host', () => {
    expect(publicTokenFor('l1em.catmaid.virtualflybrain.org/1/skeletons/')).toBe(
      publicTokenFor(L1_CATMAID_SERVER),
    )
  })
})

describe('the background refresh', () => {
  it('overlays what the manifest says and persists it for the next session', async () => {
    const rotated = 'a'.repeat(40)
    stubFetch((url) =>
      url === MANIFEST_URL
        ? manifest([{ url: FAFB_MANIFEST_HOST, api_token: rotated }])
        : undefined,
    )
    await startPublicTokenRefresh()

    expect(publicTokenFor(FAFB_MANIFEST_HOST)).toBe(rotated)
    // The alias moves with it, or the default instance keeps using the token that just failed.
    expect(publicTokenFor(DEFAULT_CATMAID_SERVER)).toBe(rotated)
    // An instance the manifest did not mention keeps the snapshot's value rather than losing it.
    expect(publicTokenFor(L1_CATMAID_SERVER)).toMatch(/^[a-f0-9]{40}$/)

    // Persisted: a fresh module, no network, still the rotated value.
    resetPublicTokensInMemoryOnly()
    expect(publicTokenFor(FAFB_MANIFEST_HOST)).toBe(rotated)
  })

  /*
   * The manifest is served `cache-control: max-age=31536000, immutable`. Left to the default,
   * the refresh would run once per browser and never again — which is the failure it exists to
   * prevent, presenting as the feature working.
   */
  it('bypasses the cache, which is served immutable for a year', async () => {
    stubFetch(() => manifest([]))
    await startPublicTokenRefresh()
    const fetched = calls.find((call) => call.url === MANIFEST_URL)
    expect(fetched?.init?.cache).toBe('no-cache')
  })

  it('runs once per session however many times it is asked', async () => {
    stubFetch(() => manifest([{ url: FAFB_MANIFEST_HOST, api_token: 'b'.repeat(40) }]))
    await Promise.all([startPublicTokenRefresh(), startPublicTokenRefresh()])
    await startPublicTokenRefresh()
    expect(calls.filter((call) => call.url === MANIFEST_URL)).toHaveLength(1)
  })

  it('leaves the snapshot alone when the manifest is unreadable', async () => {
    const before = publicTokenFor(FAFB_MANIFEST_HOST)
    for (const body of [manifest([]), { instances: 'nope' }, {}, 'not json at all']) {
      resetPublicTokens()
      stubFetch(() => body)
      await startPublicTokenRefresh()
      expect(publicTokenFor(FAFB_MANIFEST_HOST)).toBe(before)
    }
  })

  it('survives the fetch throwing, because nothing waits for it', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))))
    await expect(startPublicTokenRefresh()).resolves.toBeUndefined()
    expect(publicTokenFor(FAFB_MANIFEST_HOST)).toMatch(/^[a-f0-9]{40}$/)
  })

  /*
   * A stored overlay is another origin's data that has been through `localStorage`, and what it
   * feeds is an `X-Authorization` header aimed at a host. Both halves are checked rather than
   * trusted.
   */
  it('refuses a stored overlay that is not a token', async () => {
    stubFetch(() =>
      manifest([
        { url: FAFB_MANIFEST_HOST, api_token: 'Token with spaces; drop table' },
        { url: 'https://l1em.catmaid.virtualflybrain.org', api_token: 'c'.repeat(40) },
      ]),
    )
    await startPublicTokenRefresh()
    expect(publicTokenFor(FAFB_MANIFEST_HOST)).not.toContain(' ')
    expect(publicTokenFor(L1_CATMAID_SERVER)).toBe('c'.repeat(40))
  })
})

describe('precedence and what goes over the wire', () => {
  it('sends the published token on a POST to a VFB instance, direct', async () => {
    stubFetch(() => ({}))
    await catmaidPost(L1_CATMAID_SERVER, '/1/skeleton/neuronnames', { skids: [16] })
    const post = wire().at(-1)
    // Direct, not the relay: the token is what makes a published build able to ask at all.
    expect(post?.url.startsWith('/cm/')).toBe(false)
    expect(post?.headers['x-authorization']).toBe(`Token ${publicTokenFor(L1_CATMAID_SERVER)}`)
  })

  it('never sends one to a host that is not VFB', async () => {
    stubFetch(() => ({}))
    await catmaidPost('https://catmaid.example.org', '/1/skeleton/neuronnames', { skids: [16] })
    expect(wire().at(-1)?.headers['x-authorization']).toBeUndefined()
    // And with no token, a POST still has only the relay — the pre-existing contract.
    expect(wire().at(-1)?.url.startsWith('/cm/')).toBe(true)
  })

  /*
   * The one that would be invisible: somebody with a real VFB account has more than
   * `can_browse`, and quietly substituting the anonymous token would hide their own data.
   */
  it('lets a configured token win over the published one', async () => {
    setInstances([{ server: '*.virtualflybrain.org', token: 'mine' }])
    stubFetch(() => ({}))
    await catmaidPost(L1_CATMAID_SERVER, '/1/skeleton/neuronnames', { skids: [16] })
    expect(wire().at(-1)?.headers['x-authorization']).toBe('Token mine')
  })

  /*
   * Where the refresh is started from is a privacy decision as much as a plumbing one: a reader
   * who never opens a CATMAID node should not have their browser announce itself to
   * virtualflybrain.org, and one who does is already talking to that host.
   */
  it('re-reads the manifest from a request that uses a published token, and only then', async () => {
    stubFetch(() => ({}))
    await catmaidPost('https://catmaid.example.org', '/1/skeleton/neuronnames', { skids: [16] })
    expect(calls.some((call) => call.url === MANIFEST_URL)).toBe(false)

    await catmaidPost(L1_CATMAID_SERVER, '/1/skeleton/neuronnames', { skids: [16] })
    expect(calls.filter((call) => call.url === MANIFEST_URL)).toHaveLength(1)
  })

  it('fills in a token beside a row that only carries basic auth', async () => {
    setInstances([{ server: '*.virtualflybrain.org', httpUser: 'nginx', httpPassword: 'pw' }])
    stubFetch(() => ({}))
    await catmaidPost(L1_CATMAID_SERVER, '/1/skeleton/neuronnames', { skids: [16] })
    const post = wire().at(-1)
    // Both, on their own headers: CATMAID's token and the web server's basic auth are not
    // alternatives, which is why CATMAID uses a non-standard header for its own.
    expect(post?.headers['x-authorization']).toBe(`Token ${publicTokenFor(L1_CATMAID_SERVER)}`)
    expect(post?.headers.authorization).toMatch(/^Basic /)
  })
})

describe('a rotated token', () => {
  /*
   * Without the retry this is *worse* than never having shipped a token: the request loop stops
   * at the first response it gets, so a 401 would raise where an anonymous GET would have
   * worked. The fallback restores the behaviour of the day before the token existed.
   */
  it('falls back to an anonymous GET, which needs no token anywhere', async () => {
    stubFetch((url) =>
      wire().some((call) => call.url === url)
        ? { ok: true }
        : new Response('{"detail":"Invalid token."}', { status: 401 }),
    )
    const answer = await catmaidGet<{ ok: boolean }>(L1_CATMAID_SERVER, '/projects/')
    expect(answer).toEqual({ ok: true })
    expect(wire()[0]?.headers['x-authorization']).toBeDefined()
    expect(wire()[1]?.headers['x-authorization']).toBeUndefined()
  })

  it('falls back to the relay for a POST, which is what a dev server serves', async () => {
    stubFetch((url) =>
      url.startsWith('/cm/') ? { ok: true } : new Response('{"detail":"Invalid token."}', { status: 401 }),
    )
    await catmaidPost(L1_CATMAID_SERVER, '/1/skeleton/neuronnames', { skids: [16] })
    expect(wire()[0]?.url.startsWith('/cm/')).toBe(false)
    expect(wire()[1]?.url.startsWith('/cm/')).toBe(true)
    expect(wire()[1]?.headers['x-authorization']).toBeUndefined()
  })

  it('says so, rather than blaming a relay or a credential the reader never set', async () => {
    stubFetch(() => new Response('{"detail":"Invalid token."}', { status: 401 }))
    await expect(
      catmaidPost(L1_CATMAID_SERVER, '/1/skeleton/neuronnames', { skids: [16] }),
    ).rejects.toThrow(/rotated/i)
  })

  /*
   * A token the *user* typed is never dropped: that 401 really is about their credential, and
   * retrying without it would replace a true answer with a confusing one.
   */
  it('does not drop a token the user configured', async () => {
    setInstances([{ server: '*.virtualflybrain.org', token: 'mine' }])
    stubFetch(() => new Response('{"detail":"Invalid token."}', { status: 401 }))
    await expect(catmaidGet(L1_CATMAID_SERVER, '/projects/')).rejects.toThrow(/rejected the token/i)
    expect(wire()).toHaveLength(1)
  })
})

/** Drop the in-memory map but keep the persisted overlay, which is what a reload does. */
function resetPublicTokensInMemoryOnly(): void {
  const saved = window.localStorage.getItem('coda.catmaid.publicTokens.v1')
  resetPublicTokens()
  if (saved) window.localStorage.setItem('coda.catmaid.publicTokens.v1', saved)
}
