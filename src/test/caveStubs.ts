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
      Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(payload) } as Response)

    for (const [fragment, payload] of Object.entries(options.overrides ?? {})) {
      if (text.includes(fragment)) return answer(payload)
    }
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
