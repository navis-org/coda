/**
 * Annotation sources, against recorded responses.
 *
 * The fixtures are real replies from FlyTable — the LMB's SeaTable deployment — trimmed but not
 * edited. What matters most here is what the *shape* of a response implies rather than its
 * contents: SeaTable's rows arrive as records with a column per key and its ids arrive as
 * **strings**, which is the whole reason a CAVE root id and a FlyTable row can be joined at all.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetCache } from '../cache'
import { joinAnnotations } from '../../nodes/lib/annotationOps'
import { makeTable } from '../../core/values'
import { column, tableSchema } from '../../core/types'
import {
  SEATABLE_HOSTS,
  resetSeaTableCredentials,
  setToken,
  subscribeAuthFailure,
} from './credentials'
import {
  forgetSeaTableRoutes,
  listBases,
  readMetadata,
  resetSeaTableState,
  shapeRows,
} from './seaTable'
import type { SeaTableConfig, SeaTableTable } from './seaTable'
import { resetCaveTableState } from './caveTable'
import { annotationProvider, peekRefColumns } from './registry'
import './index'

const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', name), 'utf8')
const HOST = SEATABLE_HOSTS.flytable

interface Captured {
  url: string
}

function installFetch(overrides: Record<string, string> = {}): Captured[] {
  const captured: Captured[] = []
  vi.stubGlobal('fetch', (url: string) => {
    captured.push({ url: String(url) })
    const answer = (text: string) =>
      Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(text) } as Response)
    for (const [fragment, text] of Object.entries(overrides)) {
      if (String(url).includes(fragment)) return answer(text)
    }
    if (String(url).includes('/api/v2.1/workspaces/')) return answer(fixture('workspaces.json'))
    if (String(url).includes('/access-token/')) return answer(fixture('access-token.json'))
    if (String(url).includes('/metadata/')) return answer(fixture('base-metadata.json'))
    if (String(url).includes('/rows/')) return answer(fixture('rows.json'))
    return Promise.resolve({
      ok: false,
      status: 404,
      text: () => Promise.resolve('{"error_msg":"unexpected request"}'),
    } as Response)
  })
  return captured
}

beforeEach(() => {
  resetSeaTableCredentials()
  resetCache()
  // Both providers memoise discovery at module level, so it outlives a test file otherwise —
  // and a peek that has already resolved cannot demonstrate what an unresolved one answers.
  resetSeaTableState()
  resetCaveTableState()
  // Which route reached a host is module state too, and it is deliberately sticky in production.
  forgetSeaTableRoutes()
  setToken(HOST, 'account-token')
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetSeaTableCredentials()
})

// ---------------------------------------------------------------------------

describe('reading a SeaTable deployment', () => {
  it('flattens workspaces into a list of bases, dropping the pseudo-workspaces', async () => {
    installFetch()
    const bases = await listBases(HOST)

    // `starred` and `shared` carry no id, and their bases appear again under a real workspace —
    // a ref pointing at one could not mint a token.
    expect(bases.map((b) => b.name)).toEqual(['main', 'hemibrain', 'aedes'])
    expect(bases[0]).toEqual({ workspaceId: '5', workspaceName: 'Flywire', name: 'main' })
  })

  it('authenticates with Token rather than Bearer', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      seen.push(String(new Headers(init?.headers).get('Authorization')))
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(fixture('workspaces.json')),
      } as Response)
    })
    await listBases(HOST)
    // A Bearer JWT answers 403 `invalid token`, which names the credential rather than the
    // scheme and sends you looking in the wrong place.
    expect(seen[0]).toBe('Token account-token')
  })

  it('mints a per-base token, then reads that base from the server it names', async () => {
    const captured = installFetch()
    await readMetadata(HOST, '5', 'main')

    expect(captured.map((c) => c.url)).toEqual([
      `${HOST}/api/v2.1/workspace/5/dtable/main/access-token/`,
      // The `dtable_server` from the access token, not the host — they differ on a deployment
      // that puts its dtable server somewhere else.
      `${HOST}/dtable-server/api/v1/dtables/0de674a1-b620-4c64-bf7d-1cbe372b6ed1/metadata/`,
    ])
  })

  it('reports a missing token on the channel rather than as a bare error', async () => {
    installFetch()
    resetSeaTableCredentials()
    const seen: string[] = []
    const stop = subscribeAuthFailure((m) => seen.push(m))

    await expect(listBases(HOST)).rejects.toThrow(/No token for/)
    expect(seen[0]).toMatch(/Add one in Connections/)
    stop()
  })

  it('says a base token is the wrong kind, because the server will not', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: false,
        status: 403,
        text: () => Promise.resolve('{"error_msg":"Permission denied."}'),
      } as Response),
    )
    // `Permission denied` is what a *base* API token gets from the account listing, and taken at
    // face value it reads as an expired credential. Four probes went that way.
    await expect(listBases(HOST)).rejects.toThrow(/it may be a \*base\* API token/)
  })
})

// ---------------------------------------------------------------------------

describe('shaping SeaTable rows', () => {
  const meta: SeaTableTable = {
    name: 'info',
    columns: [
      { name: 'root_id', type: 'text' },
      { name: 'side', type: 'single-select' },
      { name: 'cell_type', type: 'text' },
      { name: 'size', type: 'number' },
      { name: 'checked', type: 'checkbox' },
      { name: 'tags', type: 'multiple-select' },
    ],
  }
  const config = (over: Partial<SeaTableConfig> = {}): SeaTableConfig => ({
    host: HOST,
    workspace: '5',
    base: 'main',
    table: 'info',
    idColumn: 'root_id',
    columns: '',
    ...over,
  })

  it('keeps a wide id exactly, because SeaTable stores it as text', () => {
    const table = shapeRows(
      [{ root_id: '720575940621522189', side: 'right' }],
      config({ columns: 'side' }),
      meta,
    )
    // The half of invariant 8 that was free, and the reason CAVE and SeaTable can be joined at
    // all: no number is ever formed, so nothing rounds.
    expect(table.data.neuronId).toEqual(['720575940621522189'])
  })

  it('renames the id column to neuronId whatever the base calls it', () => {
    const table = shapeRows([{ root_id: '1', side: 'left' }], config({ columns: 'side' }), meta)
    expect(table.schema.columns.map((c) => c.name)).toEqual(['neuronId', 'side'])
  })

  it('keeps every column but the id when none are named', () => {
    const table = shapeRows([{ root_id: '1' }], config(), meta)
    expect(table.schema.columns.map((c) => c.name)).toEqual([
      'neuronId',
      'side',
      // `cell_type`, renamed — see below.
      'type',
      'size',
      'checked',
      'tags',
    ])
  })

  /*
   * `neuronId` and `type` are the two columns nodes address *by name*, and a chain is the second
   * route into the neuron table. Only the first was being renamed, which is the same rule
   * half-applied — and the half that was missing fails in silence: `typesOf` reads
   * `index.data.type` literally, so a chain publishing `cell_type` leaves `neuronType` and
   * `partnerType` null on every connectivity row while the schema still declares them.
   */
  it('renames cell_type onto Coda’s word, as the id column already was', () => {
    const table = shapeRows(
      [{ root_id: '1', cell_type: 'LC4' }],
      config({ columns: 'cell_type' }),
      meta,
    )
    expect(table.schema.columns.map((c) => c.name)).toEqual(['neuronId', 'type'])
    expect(table.data.type).toEqual(['LC4'])
  })

  it('leaves every other column under the name the base gave it', () => {
    // A passthrough is only ever named by a column picker — neuPrint's `PROPERTY_NAMES` makes
    // the same call for `cellBodyFiber`.
    const table = shapeRows([{ root_id: '1', side: 'left' }], config({ columns: 'side' }), meta)
    expect(table.schema.columns.map((c) => c.name)).toEqual(['neuronId', 'side'])
  })

  it('narrows a cell to what its column can hold, rather than stringifying it into noise', () => {
    const table = shapeRows(
      [{ root_id: '1', size: '42', checked: true, tags: ['a', 'b'], side: null }],
      config(),
      meta,
    )
    expect(table.data.size).toEqual([42])
    expect(table.data.checked).toEqual([true])
    // An array is a link or a multi-select; joined rather than dropped, because those values are
    // what somebody would filter on.
    expect(table.data.tags).toEqual(['a, b'])
    expect(table.data.side).toEqual([null])
  })

  it('drops a row with no id, and keeps one row per neuron', () => {
    const table = shapeRows(
      [
        { root_id: '1', side: 'left' },
        { root_id: '', side: 'right' },
        { root_id: '1', side: 'right' },
      ],
      config({ columns: 'side' }),
      meta,
    )
    // A base edited by many people carries duplicates; a repeat would put that neuron in the
    // index twice, and everything downstream that sums a weight would double it.
    expect(table.data.neuronId).toEqual(['1'])
    expect(table.data.side).toEqual(['left'])
  })
})

// ---------------------------------------------------------------------------

describe('the provider seam', () => {
  it('answers unknown until a base has been read, rather than an empty schema', () => {
    installFetch()
    const provider = annotationProvider('seaTable')!
    const ref = {
      provider: 'seaTable',
      config: { ...{ host: HOST, workspace: '5', base: 'main', table: 'info' }, idColumn: 'root_id', columns: 'side' },
    }
    // Unknown is not empty — the rule `columnSchemaFor` draws, and what stops every picker
    // downstream configuring itself against a schema that is about to change.
    expect(provider.peekColumns(ref)).toBeUndefined()
  })

  it('answers a wide CAVE ref from the ref alone, with no round trip', () => {
    installFetch()
    const known = {
      provider: 'caveTable',
      config: {
        dataset: 'flywire_fafb_public:783',
        table: 'nuclei_v1',
        idColumn: 'pt_root_id',
        pivotOn: '',
        valueColumn: '',
        columns: 'volume',
      },
    }
    // A wide table's columns are the ones somebody named, so nothing has to be fetched to know
    // them — which is what lets a picker populate the moment the node is configured.
    expect(peekRefColumns(known)?.columns.map((c) => c.name)).toEqual(['neuronId', 'volume'])
  })

  it('answers unknown for a wide ref that names no columns', () => {
    installFetch()
    // Empty means "everything", which for a wide table cannot be answered without reading it.
    // Unknown rather than a guess — the rule `columnSchemaFor` draws.
    expect(
      peekRefColumns({
        provider: 'caveTable',
        config: {
          dataset: 'flywire_fafb_public:783',
          table: 'nuclei_v1',
          idColumn: 'pt_root_id',
          pivotOn: '',
          valueColumn: '',
          columns: '',
        },
      }),
    ).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------

describe('joining a chain', () => {
  const t = (ids: string[], name: string, values: Array<string | null>) =>
    makeTable(tableSchema(column('neuronId', 'str'), column(name, 'str')), {
      neuronId: ids,
      [name]: values,
    })

  it('is an outer join, so a neuron only one source knows about survives', () => {
    const joined = joinAnnotations(t(['1', '2'], 'type', ['a', 'b']), t(['2', '3'], 'side', ['L', 'R']))
    // Two bases routinely cover different populations; an inner join would silently return
    // their intersection, which on real data is a fraction of either.
    expect(joined.data.neuronId).toEqual(['1', '2', '3'])
    expect(joined.data.type).toEqual(['a', 'b', null])
    expect(joined.data.side).toEqual([null, 'L', 'R'])
  })

  it('lets the later source win a name collision, without suffixing', () => {
    const joined = joinAnnotations(t(['1'], 'type', ['old']), t(['1'], 'type', ['new']))
    // Not `type` and `type_2` like Join does: these are two answers to the same question, and a
    // picker offering both is one nobody can choose between.
    expect(joined.schema.columns.map((c) => c.name)).toEqual(['neuronId', 'type'])
    expect(joined.data.type).toEqual(['new'])
  })

  it('falls back to the earlier source where the later one has no value', () => {
    const joined = joinAnnotations(t(['1'], 'type', ['old']), t(['1'], 'type', [null]))
    expect(joined.data.type).toEqual(['old'])
  })
})

// ---------------------------------------------------------------------------
// Reaching a deployment that a browser cannot read
// ---------------------------------------------------------------------------

/**
 * FlyTable sends **no** `Access-Control-*` header, for any origin — probed live against four
 * different `Origin` values, so it is an absence rather than an allowlist, and the same API
 * answers a non-browser client perfectly with the same token. A browser therefore blocks the
 * request before it is sent and reports the opaque `TypeError` that also means "host is down".
 *
 * So the client tries direct, falls back to a same-origin relay, and remembers. `neuprint`'s
 * three rules come with it, and each would be a distinct failure if dropped.
 */
describe('routes', () => {
  /** A fetch that throws for anything not matching `reachable`, as a CORS refusal does. */
  function installRoutedFetch(reachable: (url: string) => boolean): string[] {
    const tried: string[] = []
    vi.stubGlobal('fetch', (url: string) => {
      tried.push(String(url))
      if (!reachable(String(url))) return Promise.reject(new TypeError('NetworkError'))
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(fixture('workspaces.json')),
      } as Response)
    })
    return tried
  }

  it('tries the deployment first, since the hosted service needs no relay', async () => {
    const tried = installRoutedFetch(() => true)
    await listBases(HOST)
    expect(tried).toHaveLength(1)
    expect(tried[0]).toBe(`${HOST}/api/v2.1/workspaces/`)
  })

  it('falls back to a same-origin relay when the browser refuses the read', async () => {
    const tried = installRoutedFetch((url) => url.startsWith('/st/'))
    await listBases(HOST)
    // The origin is encoded whole, so the relay needs no per-deployment rule — and the path
    // survives, which is what lets `dtable-server` calls take the same route.
    expect(tried[1]).toBe(
      `/st/${encodeURIComponent(HOST)}/api/v2.1/workspaces/`,
    )
  })

  it('remembers the relay, so a proxied session pays one failed preflight and not one per call', async () => {
    installRoutedFetch((url) => url.startsWith('/st/'))
    await listBases(HOST)
    const second = installRoutedFetch((url) => url.startsWith('/st/'))
    await listBases(HOST)
    // One attempt, not two: the direct route is no longer tried first.
    expect(second).toHaveLength(1)
    expect(second[0]?.startsWith('/st/')).toBe(true)
  })

  it('remembers only a 2xx, so a static host’s 404 does not pin an unusable route', async () => {
    // What a static deploy answers for a relay path nobody serves. It *arrives*, so it is not a
    // route failure — and remembering it would outlive the day the deployment gains CORS.
    vi.stubGlobal('fetch', (url: string) =>
      String(url).startsWith('/st/')
        ? Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') } as Response)
        : Promise.reject(new TypeError('NetworkError')),
    )
    await expect(listBases(HOST)).rejects.toThrow(/404/)

    const tried = installRoutedFetch(() => true)
    await listBases(HOST)
    expect(tried[0]).toBe(`${HOST}/api/v2.1/workspaces/`)
  })

  it('never answers a cancellation by issuing the request it was meant to stop', async () => {
    const tried: string[] = []
    vi.stubGlobal('fetch', (url: string) => {
      tried.push(String(url))
      return Promise.reject(new DOMException('aborted', 'AbortError'))
    })
    await expect(listBases(HOST)).rejects.toThrow(/aborted/)
    expect(tried).toHaveLength(1)
  })

  it('names both causes and the relay when nothing answers', async () => {
    installRoutedFetch(() => false)
    // A browser cannot tell a CORS refusal from a dead host, and the two fixes are nothing
    // alike — so saying only "network error" sends somebody to check their wifi over a header
    // their server never sent.
    await expect(listBases(HOST)).rejects.toThrow(/cross-origin|CORS/)
    await expect(listBases(HOST)).rejects.toThrow(/pnpm dev|static deploy/)
  })
})
