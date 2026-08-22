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

import { cacheSet, resetCache } from '../cache'
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
  SEATABLE_PROVIDER,
  forgetSeaTableRoutes,
  listBases,
  readMetadata,
  resetSeaTableState,
  resolveWorkspace,
  shapeRows,
} from './seaTable'
import type { SeaTableConfig, SeaTableTable } from './seaTable'
import type { CaveTableConfig } from './caveTable'
import { pivotRows, resetCaveTableState, wideRows } from './caveTable'
import {
  SHAPE_FORMAT,
  annotationProvider,
  cachedAnnotationTable,
  peekRefColumns,
} from './registry'
import { refKey } from './types'
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

  /*
   * The rename is not injective, and a base can carry both spellings. Every shaper built its
   * schema from `annotationColumn` and then seeded `data` from `schema.columns` — so the second
   * `type` overwrote the first, both targets pointed at the surviving array, every row pushed
   * into it twice and `makeTable` threw `ragged columns — "neuronId"`: a refusal naming the one
   * column that was fine, on a fetch somebody had waited twenty seconds for.
   *
   * `uniqueName`'s rule instead — the newcomer wins and the incumbent is suffixed — which is what
   * `joinedColumns`, the wide pivot and `renamedColumns` all already do.
   *
   * Note this needs **no `SHAPE_FORMAT` bump**, against the instruction below, and the reason is
   * that the rule there is "the same reply would now produce a different table". Every input
   * whose shape changed here previously *threw*, so it was never cached; every input that could
   * be cached is byte-identical. Bumping would cost a 79 MB re-download to invalidate entries
   * that are provably unchanged.
   */
  it('suffixes a collision rather than throwing about a column that is fine', () => {
    const both: SeaTableTable = {
      name: 'info',
      columns: [
        { name: 'root_id', type: 'text' },
        { name: 'cell_type', type: 'text' },
        { name: 'type', type: 'text' },
      ],
    }
    const table = shapeRows(
      [{ root_id: '1', cell_type: 'LC4', type: 'interneuron' }],
      config({ columns: 'cell_type,type' }),
      both,
    )
    expect(table.schema.columns.map((c) => c.name)).toEqual(['neuronId', 'type', 'type_2'])
    expect(table.data.type).toEqual(['LC4'])
    expect(table.data.type_2).toEqual(['interneuron'])
  })

  it('takes the id column’s name before offering it to anything else', () => {
    // A base whose own column is literally called `neuronId` collides with the one every
    // provider adds — the same failure by another route, and the reason the id is taken first.
    const clash: SeaTableTable = {
      name: 'info',
      columns: [
        { name: 'root_id', type: 'text' },
        { name: 'neuronId', type: 'text' },
      ],
    }
    const table = shapeRows(
      [{ root_id: '1', neuronId: 'legacy' }],
      config({ columns: 'neuronId' }),
      clash,
    )
    expect(table.schema.columns.map((c) => c.name)).toEqual(['neuronId', 'neuronId_2'])
    expect(table.data.neuronId).toEqual(['1'])
    expect(table.data.neuronId_2).toEqual(['legacy'])
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

  it('drops a row with no id, and keeps a neuron somebody annotated twice', () => {
    const table = shapeRows(
      [
        { root_id: '1', side: 'left' },
        { root_id: '', side: 'right' },
        { root_id: '1', side: 'right' },
      ],
      config({ columns: 'side' }),
      meta,
    )
    /*
     * Two different absences. A row with no id is not an annotation *of* a neuron and there is
     * nothing to join it to, so it goes. A neuron annotated twice is a base edited by many
     * people, which is a fact about somebody's data rather than a defect in it — and collapsing
     * it here was redundant, because every consumer that needs one row per neuron takes the
     * first itself (`dedupedIds`, `annotationIndex`, `joinAnnotations`). Hiding it meant the
     * one person who could fix it was the only one who could not see it.
     */
    expect(table.data.neuronId).toEqual(['1', '1'])
    expect(table.data.side).toEqual(['left', 'right'])
  })
})

// ---------------------------------------------------------------------------

describe('what the CAVE table provider shapes', () => {
  const config = (over: Partial<CaveTableConfig> = {}): CaveTableConfig => ({
    dataset: 'flywire_fafb_public:783',
    table: 'nuclei_v1',
    idColumn: 'pt_root_id',
    pivotOn: '',
    valueColumn: '',
    columns: '',
    ...over,
  })

  it('takes a wide table as it stands, keeping a root id the table carries twice', () => {
    const table = wideRows(
      [
        { pt_root_id: '720575940628857210', volume: 41, cell_type: 'LC4' },
        { pt_root_id: null, volume: 9, cell_type: 'x' },
        { pt_root_id: '720575940628857210', volume: 38, cell_type: 'LC4' },
      ],
      config(),
      ['volume', 'cell_type'],
    )
    // `cell_type` renamed and everything else passed through, the same two rules `shapeRows`
    // follows — and a repeat kept, because a table keyed by a *point* carries one wherever a
    // segment holds two nuclei, which is a fact about the data rather than a defect in it.
    expect(table.schema.columns.map((c) => `${c.name}:${c.dtype}`)).toEqual([
      'neuronId:str',
      'volume:i64',
      'type:str',
    ])
    expect(table.data.neuronId).toEqual(['720575940628857210', '720575940628857210'])
    expect(table.data.volume).toEqual([41, 38])
  })

  it('suffixes a collision here too, since one shaper differing is a schema nothing matches', () => {
    // Both shapers rename through `annotationColumns`, so what `peekColumns` offers a picker and
    // what a run produces cannot disagree — invariant 3 across the two halves of one provider.
    const table = wideRows(
      [{ pt_root_id: '1', cell_type: 'LC4', type: 'interneuron' }],
      config(),
      ['cell_type', 'type'],
    )
    expect(table.schema.columns.map((c) => c.name)).toEqual(['neuronId', 'type', 'type_2'])
    expect(table.data.type).toEqual(['LC4'])
    expect(table.data.type_2).toEqual(['interneuron'])
  })

  it('pivots a long table to one row per neuron, which is not the same act', () => {
    /*
     * The asymmetry worth stating: `wideRows` keeps repeats and this cannot, because many rows
     * per neuron is the *input shape* here — one row per (neuron, kind, value) is what `pivotOn`
     * exists to fold. So a Map keyed by id is the operation rather than a dedup on top of it,
     * and a later row for one kind overwrites an earlier one.
     */
    const table = pivotRows(
      [
        [
          'cell_type',
          [
            { pt_root_id: '1', label: 'LC4' },
            { pt_root_id: '2', label: 'LC6' },
          ],
        ],
        ['side', [{ pt_root_id: '1', label: 'left' }]],
      ],
      config({ pivotOn: 'classification_system', valueColumn: 'label' }),
    )
    expect(table.schema.columns.map((c) => c.name)).toEqual(['neuronId', 'type', 'side'])
    expect(table.data.neuronId).toEqual(['1', '2'])
    expect(table.data.type).toEqual(['LC4', 'LC6'])
    // Neuron 2 has no `side` row: a null rather than a dropped neuron, since the other kind
    // said something about it.
    expect(table.data.side).toEqual(['left', null])
  })

  it('suffixes two kinds that map onto one name, as the other two shapers do', () => {
    // Three shapers, one rule: a long table whose `classification_system` carries both spellings
    // is the pivot's version of the same collision.
    const table = pivotRows(
      [
        ['cell_type', [{ pt_root_id: '1', label: 'LC4' }]],
        ['type', [{ pt_root_id: '1', label: 'interneuron' }]],
      ],
      config({ pivotOn: 'classification_system', valueColumn: 'label' }),
    )
    expect(table.schema.columns.map((c) => c.name)).toEqual(['neuronId', 'type', 'type_2'])
    expect(table.data.type).toEqual(['LC4'])
    expect(table.data.type_2).toEqual(['interneuron'])
  })
})

// ---------------------------------------------------------------------------

describe('the annotation table cache', () => {
  it('tracks a SHAPE_FORMAT the tests above were written against', () => {
    /*
     * The coupling, and the whole reason the constant is trustworthy. A cached table lives for a
     * month and its fingerprint carries `SHAPE_FORMAT`, so shaping that changes without it being
     * bumped is served stale to everybody who had already read the base — which is not
     * hypothetical: dropping the duplicate-id collapse took `main.info` from 56,309 rows to
     * 58,340 and every session that had read it kept reporting 56,309.
     *
     * So: **if you changed any expectation in `what a SeaTable base becomes` or `what the CAVE
     * table provider shapes`, bump `SHAPE_FORMAT` and this number with it.** Those blocks are the
     * operative definition of "shaping"; this line is what stops them drifting from the version
     * that describes them. A constant nothing checks is a comment.
     */
    expect(SHAPE_FORMAT).toBe(2)
  })

  const ref = {
    provider: 'seaTable',
    config: {
      host: 'https://h',
      base: 'main',
      table: 'info',
      idColumn: 'root_id',
      columns: '',
    },
  }
  const built = () => makeTable(tableSchema(column('neuronId', 'str')), { neuronId: ['1'] })

  it('serves a table it stored, so a base is downloaded once', async () => {
    let reads = 0
    const read = () => {
      reads += 1
      return Promise.resolve(built())
    }
    await cachedAnnotationTable(ref, {}, read)
    await cachedAnnotationTable(ref, {}, read)
    // FlyWire's `main.info` is ~79 MB and ungzipped; the whole point of the store is that the
    // twenty-second wait is once per base rather than once per Run.
    expect(reads).toBe(1)
  })

  it('re-reads a table stored by an older shaping pass, rather than serving it for a month', async () => {
    /*
     * The regression this fingerprint exists for, and it is not hypothetical — it shipped.
     * Dropping the providers' duplicate-id collapse changed `main.info` from 56,309 rows to the
     * 58,340 the base holds, and every session that had already read it kept reporting 56,309:
     * the entry is kept for a month and the fingerprint was the ref key, which says what was
     * *asked for* and nothing about how the answer was built. The fix looked like it had not
     * shipped, and `Refresh` was the only way through.
     *
     * Seeded here under exactly the old fingerprint — the bare key — because that is what is
     * sitting in real browsers, and being a *miss* is the whole claim.
     */
    const key = `annotations:${refKey(ref)}`
    await cacheSet(
      key,
      makeTable(tableSchema(column('neuronId', 'str')), { neuronId: ['stale'] }),
      key,
    )

    let reads = 0
    const table = await cachedAnnotationTable(ref, {}, () => {
      reads += 1
      return Promise.resolve(built())
    })
    expect(reads).toBe(1)
    expect(table.data.neuronId).toEqual(['1'])
  })
})

// ---------------------------------------------------------------------------

describe('the provider seam', () => {
  it('answers unknown until a base has been read, rather than an empty schema', () => {
    installFetch()
    const provider = annotationProvider('seaTable')!
    const ref = {
      provider: 'seaTable',
      config: {
        ...{ host: HOST, workspace: '5', base: 'main', table: 'info' },
        idColumn: 'root_id',
        columns: 'side',
      },
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
    const joined = joinAnnotations(
      t(['1', '2'], 'type', ['a', 'b']),
      t(['2', '3'], 'side', ['L', 'R']),
    )
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
    expect(tried[1]).toBe(`/st/${encodeURIComponent(HOST)}/api/v2.1/workspaces/`)
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
        ? Promise.resolve({
            ok: false,
            status: 404,
            text: () => Promise.resolve(''),
          } as Response)
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

// ---------------------------------------------------------------------------
// Working the workspace out
// ---------------------------------------------------------------------------

/**
 * A base is addressed by workspace **and** name, which is the API's bookkeeping rather than
 * anybody's question: a name is very nearly always unique across an account. So an empty
 * Workspace is resolved from the listing, and only genuine ambiguity is refused.
 */
describe('resolving a workspace', () => {
  const config = (over: Partial<SeaTableConfig> = {}): SeaTableConfig => ({
    host: HOST,
    workspace: '5',
    base: 'main',
    table: 'info',
    idColumn: 'root_id',
    columns: '',
    ...over,
  })

  const bases = [
    { workspaceId: '5', workspaceName: 'FlyWire', name: 'main' },
    { workspaceId: '4', workspaceName: 'Testing', name: 'dtable_test' },
    { workspaceId: '9', workspaceName: 'Other', name: 'main_v2' },
  ]

  it('finds the one workspace holding a base', () => {
    expect(resolveWorkspace(bases, 'main')).toEqual(['5'])
  })

  it('matches case-insensitively when nothing matches exactly', () => {
    // A base name is something people retype. The ambiguity rule below guards the second pass,
    // so this cannot quietly choose between two bases.
    expect(resolveWorkspace(bases, 'MAIN')).toEqual(['5'])
  })

  it('prefers an exact match over a case-folded one', () => {
    const clash = [
      { workspaceId: '1', workspaceName: 'A', name: 'Info' },
      { workspaceId: '2', workspaceName: 'B', name: 'info' },
    ]
    expect(resolveWorkspace(clash, 'info')).toEqual(['2'])
  })

  it('reports every workspace when the name is genuinely ambiguous', () => {
    const twice = [...bases, { workspaceId: '7', workspaceName: 'Copy', name: 'main' }]
    expect(resolveWorkspace(twice, 'main')).toEqual(['5', '7'])
  })

  it('names exactly the workspaces it counted, and no more', async () => {
    /*
     * The message used to re-run the matcher per base on a one-element array, where the
     * case-folded pass always succeeds — so a `MAIN` beside two `main`s was named as a third
     * workspace for an ambiguity that had just been counted as two.
     */
    installFetch({
      '/api/v2.1/workspaces/': JSON.stringify({
        workspace_list: [
          { id: 5, name: 'FlyWire', table_list: [{ name: 'main' }] },
          { id: 7, name: 'Copy', table_list: [{ name: 'main' }] },
          { id: 9, name: 'Shouty', table_list: [{ name: 'MAIN' }] },
        ],
      }),
    })
    const provider = annotationProvider(SEATABLE_PROVIDER)
    const error = await provider
      ?.fetch({ provider: SEATABLE_PROVIDER, config: config({ workspace: '' }) }, {})
      .then(() => undefined)
      .catch((e: unknown) => String((e as Error).message))
    expect(error).toContain('2 bases')
    expect(error).toContain('FlyWire (5)')
    expect(error).toContain('Copy (7)')
    expect(error).not.toContain('Shouty')
  })

  it('finds nothing for a base the account cannot see', () => {
    expect(resolveWorkspace(bases, 'nope')).toEqual([])
  })

  it('names the workspaces when it cannot choose, rather than picking one', async () => {
    installFetch({
      '/api/v2.1/workspaces/': JSON.stringify({
        workspace_list: [
          { id: 5, name: 'FlyWire', table_list: [{ name: 'main' }] },
          { id: 7, name: 'Copy', table_list: [{ name: 'main' }] },
        ],
      }),
    })
    const provider = annotationProvider(SEATABLE_PROVIDER)
    await expect(
      provider?.fetch({ provider: SEATABLE_PROVIDER, config: config({ workspace: '' }) }, {}),
    ).rejects.toThrow(/FlyWire \(5\).*Copy \(7\)|Set Workspace/s)
  })

  it('never lists at all when the ref names its workspace', async () => {
    const captured = installFetch()
    const provider = annotationProvider(SEATABLE_PROVIDER)
    await provider?.fetch(
      { provider: SEATABLE_PROVIDER, config: config({ workspace: '5' }) },
      {},
    )
    // A whole round trip, and an account whose `/workspaces/` is forbidden can still open a base
    // it has the id for.
    expect(captured.filter((c) => c.url.endsWith('/api/v2.1/workspaces/'))).toHaveLength(0)
  })

  it('warms the peek’s metadata, so inference does not re-open the base', async () => {
    /*
     * `discovery` used to be keyed on the workspace *as typed*, so a peek (`host||main`) and a
     * run (`host|5|main`) never met — and with the workspace now usually empty, that is the
     * ordinary configuration. Inference then paid its own access-token plus `/metadata/` chain
     * per base for an entry the run had already filled.
     */
    const captured = installFetch()
    const provider = annotationProvider(SEATABLE_PROVIDER)
    await provider?.fetch(
      { provider: SEATABLE_PROVIDER, config: config({ workspace: '' }) },
      {},
    )
    const before = captured.filter((c) => c.url.includes('/metadata/')).length

    // The peek, on the typed config, now answers from what the run stored.
    expect(
      peekRefColumns({ provider: SEATABLE_PROVIDER, config: config({ workspace: '' }) }),
    ).toBeTruthy()
    expect(captured.filter((c) => c.url.includes('/metadata/')).length).toBe(before)
  })

  it('caches on the resolved base, so two spellings are one download', async () => {
    const captured = installFetch()
    const provider = annotationProvider(SEATABLE_PROVIDER)
    await provider?.fetch(
      { provider: SEATABLE_PROVIDER, config: config({ workspace: '' }) },
      {},
    )
    const reads = captured.filter((c) => c.url.includes('/rows/')).length
    await provider?.fetch(
      { provider: SEATABLE_PROVIDER, config: config({ workspace: '5' }) },
      {},
    )
    /*
     * FlyWire's `main.info` is 58,340 rows over 60 columns at ~79 MB ungzipped, so keying on
     * what somebody typed rather than on what it means is a second twenty-second download and a
     * second copy in IndexedDB.
     */
    expect(captured.filter((c) => c.url.includes('/rows/')).length).toBe(reads)
  })
})
