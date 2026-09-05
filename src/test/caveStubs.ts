/**
 * One CAVE fetch stub, for the suites that need the discovery endpoints.
 *
 * `precomputedStubs.ts`' header states the case and it had already started happening here: the
 * routes were written out in three files, and the copies had begun to differ in ways that
 * mattered — one answered a single number to both count endpoints, so a test *about* the two
 * counts disagreeing could not have seen them agree wrongly.
 *
 * Deliberately **not** folded into `data/cave/cave.test.ts`'s own `installFetch`, which stays
 * where it is: that one serves the neuron index, the annotation pivot, meshes and the L2 chunk
 * graph, and matching on those paths is half of what that suite asserts. This is the discovery
 * subset, which is all anything outside `src/data/cave` needs.
 *
 * Every fixture it serves is a real trimmed reply from `flywire_fafb_public` v783.
 *
 * `installRouteFetch` beside it is the *bare* version of the same matcher — routes in, replies
 * out, with a status apiece — for a suite whose subject is a request that has no fixture and
 * whose interesting cases are refusals. It exists because the auth endpoints arrived with two
 * more hand-rolled copies of this matcher, and copies of it drifting is the whole reason this
 * file does.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { vi } from 'vitest'

const FIXTURES = join(__dirname, '..', 'data', 'cave', '__fixtures__')
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8')

export interface CaveStubOptions {
  /**
   * Extra routes, matched on a URL substring before anything below. First match wins.
   *
   * Every value is answered `200`, which is the point: a *refusal* is a different thing to
   * express and belongs in a stub layered over this one, so that a test about an error path says
   * so at its own call site rather than through a flag here.
   */
  overrides?: Record<string, string>
  /**
   * The two row counts, which are two different endpoints and — this being the whole reason the
   * card shows both — two different numbers. `[annotation service, materialization engine]`.
   *
   * Defaults to the real figures for `proofread_neurons` at v783.
   */
  counts?: readonly [number, number]
}

/**
 * Every URL the stub was asked for, in order, with any JSON body that was posted.
 *
 * The body is typed as a record rather than `unknown` because every CAVE POST body is a JSON
 * object, and a suite asserting *which* request was built — a `select_columns` list against a
 * `select_column_map`, a filtered count against an unfiltered one — has to index it.
 */
export interface CaveCall {
  url: string
  body?: Record<string, unknown>
}

export function installCaveFetch(options: CaveStubOptions = {}): CaveCall[] {
  const [live, frozen] = options.counts ?? [139540, 127978]
  const calls: CaveCall[] = []

  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const text = String(url)
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined
    calls.push({ url: text, ...(body ? { body } : {}) })
    const answer = (payload: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(payload),
      } as Response)

    for (const [fragment, payload] of Object.entries(options.overrides ?? {})) {
      if (text.includes(fragment)) return answer(payload)
    }
    /*
     * The listing, matched with `endsWith` so it cannot swallow `datastack/full/` below — the
     * two paths differ by one character and one of them is a prefix of nothing.
     */
    if (text.endsWith('/info/api/v2/datastacks')) return answer(fixture('datastacks.json'))
    if (text.includes('/info/api/v2/datastack/full/'))
      return answer(fixture('datastack-flywire.json'))
    /*
     * `endsWith`, not `includes` — a *view query* is `/version/783/views/valid_connection_v2/query`,
     * so `includes('/views')` would answer the listing fixture to a query and the query fixture
     * would never be reached. The tables listing is matched on its **v2** path deliberately: that
     * it lives there inside the v3 API is one of the things these suites assert.
     */
    if (text.endsWith('/materialize/api/v2/datastack/flywire_fafb_public/version/783/tables'))
      return answer(fixture('tables.json'))
    if (text.endsWith('/materialize/api/v3/datastack/flywire_fafb_public/version/783/views'))
      return answer(fixture('views.json'))
    if (text.endsWith('/table/nuclei_v1/metadata'))
      return answer(fixture('table-metadata-nuclei.json'))
    // A second table, for the counts: `proofread_neurons` is the one whose two counts genuinely
    // disagree, and only its metadata's existence matters.
    if (text.endsWith('/table/proofread_neurons/metadata'))
      return answer('{"table_name":"proofread_neurons","schema_type":"proofreading_status"}')
    // The two counts, kept apart. Answering one number to both is how a test stops being able to
    // see the confusion it exists to catch.
    if (text.includes('/annotation/api/v2/aligned_volume/')) return answer(String(live))
    if (text.endsWith('/count')) return answer(String(frozen))
    if (text.includes('/query')) return answer(fixture('table-sample-nuclei.txt'))

    return Promise.resolve({
      ok: false,
      status: 404,
      text: () => Promise.resolve('{"message":"unexpected request"}'),
    } as Response)
  })
  return calls
}

/**
 * The three specced datastacks on their three real deployments, with one of them refusing.
 *
 * The state a fresh CAVE account is ordinarily in — its listing is filtered `ignore_tos=True`, so
 * it names datastacks whose terms nobody has accepted — and the shape of the bug that produced
 * `quiet`: a refusal about a datastack nobody asked for, opening the Connections dialog on every
 * Run of a graph that worked.
 *
 * Here rather than in either suite because it arrived in two: a data-layer copy and a jsdom one,
 * already differing in *which* request they refused. That is the drift this module's header
 * exists to stop. `installCaveFetch` genuinely cannot express it — its `overrides` are 200-only
 * and it answers one datastack record for every `datastack/full/`, where the whole point here is
 * three deployments of which one says no.
 */
export interface RefusingCaveOptions {
  /** URL substring that refuses. Defaults to the datastack MICrONS gates behind its terms. */
  refuse?: string
  status?: number
  /** The refusal body. Defaults to `middle_auth`'s `missing_tos`, which is the interesting one. */
  body?: string
}

/** Where each specced datastack is actually served from — three deployments, not one. */
export const DATASTACK_SERVERS: Readonly<Record<string, string>> = {
  flywire_fafb_public: 'https://prod.flywire-daf.com',
  brain_and_nerve_cord_public: 'https://cave.fanc-fly.com',
  minnie65_public: 'https://minnie.microns-daf.com',
}

/** The terms-of-service form `missing_tos` names, which is the whole point of reading the body. */
export const TOS_FORM_URL = 'https://global.daf-apis.com/sticky_auth/api/v1/tos/3/accept'

export const MISSING_TOS_BODY = JSON.stringify({
  error: 'missing_tos',
  message: 'Need to accept Terms of Service to access resource.',
  data: {
    tos_id: 3,
    tos_name: 'MICrONS Data Use',
    tos_form_url: TOS_FORM_URL,
    auth_dataset: 'minnie65_public',
  },
})

/** Every URL asked for, in order — the `installRouteFetch` contract. */
export function installRefusingCaveFetch(options: RefusingCaveOptions = {}): string[] {
  const {
    refuse = '/datastack/full/minnie65_public',
    status = 403,
    body = MISSING_TOS_BODY,
  } = options
  const asked: string[] = []
  vi.stubGlobal('fetch', (url: string) => {
    const text = String(url)
    asked.push(text)
    const answer = (payload: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(payload),
      } as Response)
    if (text.includes(refuse))
      return Promise.resolve({
        ok: false,
        status,
        text: () => Promise.resolve(body),
      } as Response)
    if (text.endsWith('/info/api/v2/datastacks'))
      return answer(JSON.stringify(Object.keys(DATASTACK_SERVERS)))
    const full = /\/datastack\/full\/(.+)$/.exec(text)
    if (full) return answer(JSON.stringify({ local_server: DATASTACK_SERVERS[full[1]!] }))
    const meta = /\/datastack\/([^/]+)\/metadata$/.exec(text)
    if (meta) return answer(materializations(meta[1]!, [783]))
    return Promise.resolve({
      ok: false,
      status: 404,
      text: () => Promise.resolve('{"message":"not stubbed"}'),
    } as Response)
  })
  return asked
}

/**
 * A version listing in the shape `versions.json` has.
 *
 * `expires_on` is not decoration: `usableVersions` filters on it, so a record without one stops
 * exercising the branch that keeps an expired materialization out of every dropdown.
 */
export function materializations(datastack: string, versions: readonly number[]): string {
  return JSON.stringify(
    versions.map((version, i) => ({
      version,
      valid: true,
      datastack,
      status: 'AVAILABLE',
      time_stamp: `202${4 + i}-01-0${i + 1}T00:00:00.000000`,
      expires_on: '2121-11-10T07:10:01.417779',
    })),
  )
}

/** One route: what to answer, and with what status. A body alone means 200. */
export interface StubRoute {
  status?: number
  body: string
}

/**
 * Answer a fixed set of URL substrings, and 404 everything else.
 *
 * The status lives **on the route** rather than in an option beside it, for the reason
 * `CaveStubOptions.overrides` gives for refusing to hold one at all: a test about an error path
 * should say which request fails, at its own call site, rather than flipping a flag whose name
 * has to be read somewhere else to find out what it does.
 *
 * Returns the URLs asked for, in order — the assertion "and nothing else was fetched" is
 * otherwise unavailable, and it is the whole of some cases.
 */
export function installRouteFetch(routes: Record<string, StubRoute>): string[] {
  const seen: string[] = []
  vi.stubGlobal('fetch', (url: string) => {
    const text = String(url)
    seen.push(text)
    for (const [fragment, route] of Object.entries(routes)) {
      if (!text.includes(fragment)) continue
      const status = route.status ?? 200
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(route.body),
      } as Response)
    }
    return Promise.resolve({
      ok: false,
      status: 404,
      text: () => Promise.resolve('{"message":"unexpected request"}'),
    } as Response)
  })
  return seen
}
