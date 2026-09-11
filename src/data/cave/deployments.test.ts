// @vitest-environment jsdom

/**
 * CAVE deployments: one token per global server, and every request carrying its own.
 *
 * `cave.test.ts` runs everything against the default deployment, which is what every shipped
 * datastack is on. This is the half that only exists once there is a second — H01's
 * `global.brain-wire-test.org`, measured live to refuse a `global.daf-apis.com` token with a 401 —
 * so the properties worth pinning are all about two deployments *not* leaking into each other.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { getSource } from '../source'
import { caveGet } from './client'
import {
  getSession,
  getToken,
  listCredentials,
  resetCredentials,
  setToken,
  subscribeAuthFailure,
} from './credentials'
import { peekDatastacks, resetDatastackRecords } from './datastack'
import {
  DEFAULT_CAVE_SERVER,
  caveServerLabel,
  caveServerOfSource,
  caveSourceId,
  normaliseCaveServer,
  parseCaveServer,
} from './deployments'
import { caveSourceFor, publishedCaveSourceId } from './registry'
import { clearStorage, installStorageStub } from '../../test/jsdomStubs'

const H01 = 'https://global.brain-wire-test.org'

beforeAll(() => installStorageStub())

beforeEach(() => {
  clearStorage()
  resetCredentials()
  resetDatastackRecords()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A fetch answering every URL with `body`, recording the bearer token each request carried. */
function recordAuth(body: unknown = []): Array<{ url: string; token: string | undefined }> {
  const seen: Array<{ url: string; token: string | undefined }> = []
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get('Authorization') ?? undefined
    seen.push({ url: String(url), token: auth?.replace(/^Bearer\s+/, '') })
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(body)),
    } as Response)
  })
  return seen
}

describe('naming a deployment', () => {
  it('reduces every spelling of a global server to its origin, and nothing to the default', () => {
    expect(normaliseCaveServer('global.brain-wire-test.org')).toBe(H01)
    expect(normaliseCaveServer('https://global.brain-wire-test.org/')).toBe(H01)
    expect(normaliseCaveServer('https://global.brain-wire-test.org/info/api/v2')).toBe(H01)
    expect(normaliseCaveServer('')).toBe(DEFAULT_CAVE_SERVER)
    expect(normaliseCaveServer(undefined)).toBe(DEFAULT_CAVE_SERVER)
  })

  /*
   * The strict half, for a field naming a *new* deployment: a typo there must not become the
   * default, or the panel stores that deployment's token as FlyWire's.
   */
  it('names no deployment for empty or unparseable text, where the lenient form means the default', () => {
    expect(parseCaveServer('global.brain-wire-test.org/')).toBe(H01)
    expect(parseCaveServer('')).toBeUndefined()
    expect(parseCaveServer('global brain-wire-test.org')).toBeUndefined()
    expect(normaliseCaveServer('global brain-wire-test.org')).toBe(DEFAULT_CAVE_SERVER)
  })

  /*
   * The default keeps the bare `cave` id, which is what every saved graph and every family
   * declaration carries — so adding deployments re-keys nothing that existed before them.
   */
  it('keeps the bare source id for the default and round-trips any other', () => {
    expect(caveSourceId(DEFAULT_CAVE_SERVER)).toBe('cave')
    expect(caveSourceId(undefined)).toBe('cave')
    expect(caveSourceId('global.brain-wire-test.org/')).toBe(`cave:${H01}`)
    expect(caveServerOfSource('cave')).toBe(DEFAULT_CAVE_SERVER)
    expect(caveServerOfSource(caveSourceId(H01))).toBe(H01)
    // Not a CAVE source at all, which is a different answer from "the default one".
    expect(caveServerOfSource('neuprint')).toBeUndefined()
    expect(caveServerOfSource('catmaid:https://example.org')).toBeUndefined()
    expect(caveServerLabel(H01)).toBe('global.brain-wire-test.org')
  })
})

describe('a token per deployment', () => {
  it('holds two tokens side by side, and forgetting one keeps the other', () => {
    setToken(DEFAULT_CAVE_SERVER, 'fafb-token', { email: 'a@example.org', at: 1 })
    setToken('global.brain-wire-test.org', 'h01-token')

    expect(getToken(DEFAULT_CAVE_SERVER)).toBe('fafb-token')
    expect(getToken(H01)).toBe('h01-token')
    // A session belongs to the row it was signed in for, not to the store.
    expect(getSession(DEFAULT_CAVE_SERVER)?.email).toBe('a@example.org')
    expect(getSession(H01)).toBeUndefined()

    setToken(H01, '')
    expect(getToken(H01)).toBeUndefined()
    expect(getToken(DEFAULT_CAVE_SERVER)).toBe('fafb-token')
    expect(listCredentials().map((c) => c.server)).toEqual([DEFAULT_CAVE_SERVER])
  })

  it('keeps a row in place when it is replaced, so the panel does not reorder', () => {
    setToken(DEFAULT_CAVE_SERVER, 'one')
    setToken(H01, 'two')
    setToken(DEFAULT_CAVE_SERVER, 'one-again')
    expect(listCredentials().map((c) => c.server)).toEqual([DEFAULT_CAVE_SERVER, H01])
  })

  /*
   * The single-token layout, carried across once. The token goes to the server it was stored
   * beside, and the old keys go — a second reader of them is how a Forget would come back.
   */
  it('migrates the single-token layout to a row for the server it was stored beside', () => {
    // What a page built before deployments left behind; the first read after it is a reload.
    localStorage.setItem('coda.cave.token', 'Bearer legacy-token ')
    localStorage.setItem('coda.cave.server', 'https://global.brain-wire-test.org/')
    localStorage.setItem('coda.cave.session', JSON.stringify({ email: 'b@example.org', at: 5 }))

    expect(listCredentials()).toEqual([
      { server: H01, token: 'legacy-token', session: { email: 'b@example.org', at: 5 } },
    ])
    expect(getToken(DEFAULT_CAVE_SERVER)).toBeUndefined()
    expect(localStorage.getItem('coda.cave.token')).toBeNull()
    expect(localStorage.getItem('coda.cave.server')).toBeNull()
    expect(localStorage.getItem('coda.cave.session')).toBeNull()
  })

  it('migrates a token stored with no server to the default deployment', () => {
    localStorage.setItem('coda.cave.token', 'legacy-token')
    expect(getToken(DEFAULT_CAVE_SERVER)).toBe('legacy-token')
  })
})

describe('a request names its deployment', () => {
  it("signs each request with its own deployment's token, whatever host it goes to", async () => {
    setToken(DEFAULT_CAVE_SERVER, 'fafb-token')
    setToken(H01, 'h01-token')
    const seen = recordAuth({})

    /*
     * The local server is on a host nobody typed — `local.brain-wire-test.org` — which is why the
     * token is chosen by the deployment a request names and never matched to one by its host.
     */
    await caveGet('https://local.brain-wire-test.org/materialize/api/v3/x', { deployment: H01 })
    await caveGet('https://prod.flywire-daf.com/materialize/api/v3/x', {
      deployment: DEFAULT_CAVE_SERVER,
    })

    expect(seen.map((s) => s.token)).toEqual(['h01-token', 'fafb-token'])
  })

  it('refuses a deployment with no token of its own, naming that deployment', async () => {
    setToken(DEFAULT_CAVE_SERVER, 'fafb-token')
    const seen = recordAuth({})
    const raised: string[] = []
    const stop = subscribeAuthFailure((m) => raised.push(m))

    await expect(
      caveGet('https://local.brain-wire-test.org/x', { deployment: H01 }),
    ).rejects.toThrow(/No CAVE token for global\.brain-wire-test\.org/)
    // Refused before the network: the default's token is never offered to another deployment.
    expect(seen).toEqual([])
    expect(raised[0]).toMatch(/Connections/)
    stop()
  })
})

describe('the datastack listing, per deployment', () => {
  it('gates each peek on its own deployment having a token', async () => {
    setToken(DEFAULT_CAVE_SERVER, 'fafb-token')
    const seen = recordAuth(['flywire_fafb_public'])

    expect(peekDatastacks(H01)).toBeUndefined()
    expect(peekDatastacks(DEFAULT_CAVE_SERVER)).toBeUndefined()
    await vi.waitFor(() => expect(peekDatastacks(DEFAULT_CAVE_SERVER)).toBeDefined())

    // One request, to the default only: H01 has no token, so its peek asks nothing.
    expect(seen.map((s) => new URL(s.url).origin)).toEqual([DEFAULT_CAVE_SERVER])
    expect(peekDatastacks(H01)).toBeUndefined()
  })

  it("does not answer one deployment's peek with another's listing", async () => {
    setToken(DEFAULT_CAVE_SERVER, 'fafb-token')
    setToken(H01, 'h01-token')
    recordAuth(['flywire_fafb_public'])
    peekDatastacks(DEFAULT_CAVE_SERVER)
    await vi.waitFor(() => expect(peekDatastacks(DEFAULT_CAVE_SERVER)).toBeDefined())

    recordAuth(['h01_c3_flat'])
    expect(peekDatastacks(H01)).toBeUndefined()
    await vi.waitFor(() => expect(peekDatastacks(H01)).toEqual(['h01_c3_flat']))
    expect(peekDatastacks(DEFAULT_CAVE_SERVER)).toEqual(['flywire_fafb_public'])
  })
})

describe('a source per deployment', () => {
  it('registers one source per deployment, and hands back the same one when asked again', () => {
    const h01 = caveSourceFor('global.brain-wire-test.org')
    expect(h01.id).toBe(`cave:${H01}`)
    expect(h01.label).toBe('CAVE (global.brain-wire-test.org)')
    expect(caveSourceFor(`${H01}/`)).toBe(h01)
    expect(getSource(h01.id)).toBe(h01)
  })

  /*
   * The default is `registerBuiltinSources`' to register. A node registering it from inference put
   * an unlisted `cave` source under the exporter, which runs with none registered on purpose, and
   * Find Neurons then dropped its filter from the notebook for a field the empty schema lacked.
   */
  it("publishes the default's id without registering it, and registers any other", () => {
    expect(publishedCaveSourceId(DEFAULT_CAVE_SERVER)).toBe('cave')
    expect(getSource('cave')).toBeUndefined()

    const id = publishedCaveSourceId('https://global.brain-wire-test.org')
    expect(id).toBe(`cave:${H01}`)
    expect(getSource(id)).toBeDefined()
  })
})
