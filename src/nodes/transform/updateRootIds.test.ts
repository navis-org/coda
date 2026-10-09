/**
 * Update root IDs — bringing an annotation table forward to a materialization.
 *
 * Three things carry this and none is visible from the signature. **Only stale rows are looked
 * up**, so an unedited base costs one staleness pass and no supervoxel lookup at all — this is an
 * advisory repair against a shared production chunkedgraph, and the cost control *is* the
 * feature. **A row without a supervoxel is left alone**, because the supervoxel is the only stable
 * handle and there is nothing to recover from without one. And **the id column keeps its
 * storage**, since a CAVE id is text and an eighteen-digit id that became a number would be a
 * different neuron (invariant 8).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { column, tableSchema } from '../../core/types'
import type { TableValue } from '../../core/values'
import { makeTable } from '../../core/values'
import { cacheGet, cacheSet, resetCache } from '../../data/cache'
import { resetCredentials, setToken } from '../../data/cave/credentials'
import { resetDatastackRecords } from '../../data/cave/datastack'
import { resetRootChecks } from '../../data/cave/rootIds'
import { addEdge, addNode, emptyGraph } from '../../core/graph'
import type { CodaGraph, GraphNode } from '../../core/graph'
import { inferGraph } from '../../core/inference'
import { defaultParams, findParam, resolveColumn, visibleParams } from '../../core/node'
import type { ColumnParam, EnumParam } from '../../core/node'
import { T } from '../../core/types'
import { requireNodeDef } from '../../core/registry'
import { DEFAULT_CAVE_SERVER } from '../../data/cave/deployments'
import '../index'

const DATASET = 'flywire_fafb_public:783'
const STAMP = '2023-08-29T00:00:00.000000'
const OLD = '720575940628857210'
const KEPT = '720575940626838909'
const NEW = '720575940600000001'
const SV = '80000000000000001'

interface Call {
  url: string
}

/** `OLD` has moved on; `KEPT` has not. The supervoxel resolves to `NEW`. */
/**
 * `stale`/`fresh` are parameters because one case needs ids narrow enough to survive a double:
 * `idText` refuses a number too wide to be exact, so an eighteen-digit id in a *numeric* column
 * is correctly skipped — which is the right behaviour and the wrong fixture for a test about
 * which dtype the replacement takes.
 */
function installFetch(stale: string = OLD, fresh: string = NEW): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const text = String(url)
    calls.push({ url: text })
    const json = (value: unknown) =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify(value)),
      } as Response)

    if (text.includes('/datastack/full/')) {
      return json({
        local_server: 'https://local.example',
        segmentation_source: 'graphene://https://cg.example/segmentation/table/flywire_public',
      })
    }
    if (text.includes('/metadata')) {
      return json([{ version: 783, valid: true, status: 'AVAILABLE', time_stamp: STAMP }])
    }
    if (text.includes('is_latest_roots')) {
      const ids = /\[(.*)\]/.exec(String(init?.body ?? ''))?.[1] ?? ''
      const list = ids ? ids.split(',') : []
      return json({ is_latest: list.map((id) => id !== stale) })
    }
    if (text.includes('roots_binary')) {
      // Raw uint64 out, as `roots_binary` answers — one root per supervoxel sent, and `0` for a
      // supervoxel the graph does not know, which is how CAVE says so.
      const sent = new BigUint64Array(init?.body as ArrayBuffer)
      const out = BigUint64Array.from(sent, (sv) => (sv === 0n ? 0n : BigInt(fresh)))
      return Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(out.buffer),
      } as unknown as Response)
    }
    return Promise.resolve({
      ok: false,
      status: 404,
      text: () => Promise.resolve('{}'),
    } as Response)
  })
  return calls
}

/** The timestamp each of the two chunkedgraph calls was asked at, in call order. */
function stampsOf(calls: Call[]): (string | null)[] {
  return calls
    .filter((c) => c.url.includes('is_latest_roots') || c.url.includes('roots_binary'))
    .map((c) => new URL(c.url).searchParams.get('timestamp'))
}

/** Freeze `Date` at `now` for every test in the enclosing describe. */
function clockAt(now: number): void {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)
  })
  afterEach(() => {
    vi.useRealTimers()
  })
}

function annotations(): TableValue {
  return makeTable(
    tableSchema(
      column('neuronId', 'str'),
      column('supervoxel_id', 'str'),
      column('type', 'str'),
    ),
    { neuronId: [OLD, KEPT], supervoxel_id: [SV, '80000000000000002'], type: ['LC4', 'LC6'] },
    'neurons',
  )
}

/** What a test listens for on the context; everything else is inert. */
interface Listeners {
  reportFetched?: (at: number) => void
  warn?: (message: string) => void
}

function run(
  table: TableValue,
  params: Record<string, unknown> = {},
  { reportFetched = () => undefined, warn = () => undefined }: Listeners = {},
) {
  const def = requireNodeDef('cave.updateRootIds')
  return def.evaluate({
    params: {
      idColumn: 'neuronId',
      supervoxelColumn: 'supervoxel_id',
      updateTo: 'materialization',
      version: '',
      ...params,
    },
    refresh: false,
    input: (portId) =>
      portId === 'in'
        ? table
        : { kind: 'dataset', sourceId: 'cave', datasetId: DATASET, label: DATASET },
    inputKey: () => undefined,
    column: (id) =>
      String(
        params[id] ??
          { idColumn: 'neuronId', supervoxelColumn: 'supervoxel_id' }[id as 'idColumn'] ??
          '',
      ),
    columns: () => [],
    inputPorts: () => [],
    outputPorts: () => [],
    resolveSource: () => {
      throw new Error('no source')
    },
    signal: new AbortController().signal,
    progress: () => undefined,
    reportFetched,
    warn,
    publish: () => undefined,
  })
}

beforeEach(() => {
  resetCache()
  resetRootChecks()
  resetDatastackRecords()
  resetCredentials()
  setToken(DEFAULT_CAVE_SERVER, 'token')
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetCredentials()
})

describe('the repair', () => {
  it('repoints a stale row and leaves a current one alone', async () => {
    installFetch()
    const out = (await run(annotations())).out as TableValue
    expect(out.data.neuronId).toEqual([NEW, KEPT])
    // Everything else is untouched, including the row order and the other columns.
    expect(out.data.type).toEqual(['LC4', 'LC6'])
    expect(out.kind).toBe('neurons')
    expect(out.schema.columns.map((c) => c.name)).toEqual(['neuronId', 'supervoxel_id', 'type'])
  })

  /*
   * The replacement keeps the column's **declared** storage, read off the schema rather than off
   * row zero. `typeof ids[0] === 'number'` decides the whole column from one value, so a table
   * whose first row has no id — an annotation base with a blank leading row, which is ordinary —
   * wrote strings into an `i64` column: schema and values disagreeing (invariant 3), left that
   * way by the node whose whole job is repair, and silent until something downstream sorted or
   * compared them.
   */
  it('keeps the id column’s declared storage, whatever the first row happens to hold', async () => {
    // Narrow ids, so `idText` does not correctly refuse them for being inexact as doubles — this
    // is about which dtype the replacement takes, not about invariant 8.
    installFetch('527536', '527999')
    const numeric = makeTable(
      tableSchema(
        column('neuronId', 'i64'),
        column('supervoxel_id', 'str'),
        column('type', 'str'),
      ),
      {
        // A null first row is what made row zero the wrong place to ask.
        neuronId: [null, 527536, 812345],
        supervoxel_id: [null, SV, '80000000000000002'],
        type: ['?', 'LC4', 'LC6'],
      },
      'neurons',
    )
    const out = (await run(numeric)).out as TableValue
    expect(out.data.neuronId).toEqual([null, 527999, 812345])
    // Numbers, not the strings `roots_binary` answers in — the schema still says `i64`.
    expect(out.data.neuronId?.map((c) => typeof c)).toEqual(['object', 'number', 'number'])
  })

  it('sends the supervoxels as raw uint64, and only the ones that moved', async () => {
    /*
     * `roots_binary` takes `np.array(ids, dtype=np.uint64).tobytes()` — which for once makes
     * invariant 8 easy, since a `BigUint64Array` holds an eighteen-digit id exactly. And only the
     * stale row's supervoxel is asked about: the other would be a request for an answer already
     * on the table.
     */
    let body: ArrayBuffer | undefined
    installFetch()
    const original = globalThis.fetch as typeof fetch
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      if (String(url).includes('roots_binary')) body = init?.body as ArrayBuffer
      return original(url as never, init as never)
    })
    await run(annotations())

    expect(body).toBeDefined()
    const sent = new BigUint64Array(body!)
    expect([...sent].map(String)).toEqual([SV])
  })

  it('asks nothing of the chunkedgraph when every id is already current', async () => {
    // The cost control, and the common case: an unedited base pays one staleness pass and no
    // supervoxel lookup at all.
    const calls = installFetch()
    const current = makeTable(
      tableSchema(column('neuronId', 'str'), column('supervoxel_id', 'str')),
      { neuronId: [KEPT], supervoxel_id: ['80000000000000002'] },
      'neurons',
    )
    const out = (await run(current)).out as TableValue
    expect(out).toBe(current)
    expect(calls.filter((c) => c.url.includes('roots_binary'))).toHaveLength(0)
  })

  it('does not rewrite a current row whose supervoxel is already in the cache', async () => {
    /*
     * The guard in the rewrite loop looks redundant, because only stale rows are ever *asked*
     * about — and it stops being redundant the moment the cache is warm. The supervoxel map is
     * cached permanently and shared across runs and datasets, so a later run can easily hold a
     * root for a row that did not move. Without the guard that row is rewritten to whatever the
     * cache says, silently, on a table nobody thought was being changed.
     */
    installFetch()
    await cacheSet(
      `cave-sv-roots:https://cg.example|flywire_public|${Date.parse(STAMP)}`,
      { sv: ['80000000000000002'], root: ['720575940699999999'] },
      'v1',
    )
    const out = (await run(annotations())).out as TableValue
    expect(out.data.neuronId).toEqual([NEW, KEPT])
  })

  /*
   * A row that cannot be traced is kept as it was, which is right and was silent: the card went
   * green on a run that repaired nine stale rows in ten, exactly as on one that repaired them all.
   */
  it('counts the stale rows it could not repair, by reason', async () => {
    installFetch()
    const said: string[] = []
    const mixed = makeTable(
      tableSchema(column('neuronId', 'str'), column('supervoxel_id', 'str')),
      // Two stale rows with no supervoxel, one with a supervoxel CAVE answers 0 for, one repaired,
      // and a current row with no supervoxel — which needs nothing and must not be counted.
      { neuronId: [OLD, OLD, OLD, OLD, KEPT], supervoxel_id: [null, null, '0', SV, null] },
      'neurons',
    )
    const out = (await run(mixed, {}, { warn: (m) => said.push(m) })).out as TableValue
    expect(out.data.neuronId).toEqual([OLD, OLD, OLD, NEW, KEPT])
    expect(said).toEqual([
      '3 rows have an out-of-date ID that could not be updated: 2 without a supervoxel ID and ' +
        '1 whose supervoxel CAVE does not know. They are left as they were.',
    ])
  })

  it('says nothing when every stale row was repaired', async () => {
    installFetch()
    const said: string[] = []
    await run(annotations(), {}, { warn: (m) => said.push(m) })
    expect(said).toEqual([])
  })

  it('reads the materialization listing once per repair, not once per lookup', async () => {
    // A frozen instant never changes, and the listing's memo holds only the request in flight —
    // so each lookup awaiting it was a fresh `/metadata` round trip, two per repair.
    const calls = installFetch()
    await run(annotations())
    expect(calls.filter((c) => c.url.includes('/metadata'))).toHaveLength(1)
  })

  it('leaves a row with no supervoxel exactly as it was', async () => {
    // Nothing to recover from: the supervoxel is the only stable handle, so the honest answer is
    // to leave the stale id rather than to null it or drop the row.
    installFetch()
    const partial = makeTable(
      tableSchema(column('neuronId', 'str'), column('supervoxel_id', 'str')),
      { neuronId: [OLD], supervoxel_id: [null] },
      'neurons',
    )
    const out = (await run(partial)).out as TableValue
    expect(out.data.neuronId).toEqual([OLD])
  })
})

/**
 * Live — the newest root ids as of the last run, for interactive work.
 *
 * Three things a reasonable implementation gets wrong in silence. **Both calls are asked about one
 * instant**, the run's own, or an edit between them leaves a row repointed at a root already
 * retired. **Nothing is kept**: each live run is a new instant, so a permanent entry per run is a
 * store that only grows. And **the instant is reported**, which is the whole of the manual
 * update — it is what puts `cached 4m ago ⟳` on the card.
 */
describe('live', () => {
  /** A moment well after the materialization, so the two cannot be confused. */
  const NOW = Date.parse('2026-10-07T12:00:00Z')

  clockAt(NOW)

  it('asks both calls about the run’s own instant, never the materialization’s', async () => {
    const calls = installFetch()
    const out = (await run(annotations(), { updateTo: 'live' })).out as TableValue
    expect(out.data.neuronId).toEqual([NEW, KEPT])

    expect(stampsOf(calls)).toEqual([String(NOW / 1000), String(NOW / 1000)])
  })

  it('reports that instant, which is what puts the ⟳ on the card', async () => {
    installFetch()
    const reported: number[] = []
    await run(annotations(), { updateTo: 'live' }, { reportFetched: (at) => reported.push(at) })
    expect(reported).toEqual([NOW])
  })

  it('says nothing about an age when pinned to a materialization', async () => {
    // A frozen instant is not "how old" anything is; the card's foot stays as it was.
    installFetch()
    const reported: number[] = []
    await run(annotations(), {}, { reportFetched: (at) => reported.push(at) })
    expect(reported).toEqual([])
  })

  it('keeps no answer about a live instant, and reads none', async () => {
    installFetch()
    // A warm entry at this very instant must not be served: live means asking.
    await cacheSet(
      `cave-sv-roots:https://cg.example|flywire_public|${NOW}`,
      { sv: [SV], root: ['720575940699999999'] },
      'v1',
    )
    const out = (await run(annotations(), { updateTo: 'live' })).out as TableValue
    expect(out.data.neuronId).toEqual([NEW, KEPT])
    expect(
      await cacheGet(`cave-roots:https://cg.example|flywire_public|${NOW}`, {
        fingerprint: 'v1',
      }),
    ).toBeUndefined()
  })
})

/**
 * The last full hour and the last half hour — live, snapped back to the schedule an annotation base
 * refreshes its own ids on (FlyTable's is every thirty minutes).
 *
 * What a test must pin is the arithmetic, since a boundary off by one step lands on a state no
 * other table's ids describe, and nothing fails: the same plausible repair, half an hour out. So a
 * run time well inside a slot, and both calls checked against the boundary rather than the clock.
 */
describe('the last full hour and the last half hour', () => {
  /** 12:47:13 UTC — inside both slots, so neither boundary can be the run time by accident. */
  const NOW = Date.parse('2026-10-07T12:47:13Z')

  clockAt(NOW)

  it.each([
    ['halfHour', '2026-10-07T12:30:00Z'],
    ['hour', '2026-10-07T12:00:00Z'],
  ])(
    '%s asks both calls about the boundary before the run, and reports it',
    async (mode, at) => {
      const calls = installFetch()
      const reported: number[] = []
      const out = (
        await run(annotations(), { updateTo: mode }, { reportFetched: (t) => reported.push(t) })
      ).out as TableValue
      expect(out.data.neuronId).toEqual([NEW, KEPT])
      const boundary = Date.parse(at)
      expect(stampsOf(calls)).toEqual([String(boundary / 1000), String(boundary / 1000)])
      // The age the card shows is the age of the ids' state, not of the run.
      expect(reported).toEqual([boundary])
    },
  )

  it('treats a run exactly on a boundary as that boundary', async () => {
    vi.setSystemTime(Date.parse('2026-10-07T12:30:00Z'))
    const calls = installFetch()
    await run(annotations(), { updateTo: 'halfHour' })
    expect(stampsOf(calls)[0]).toBe(String(Date.parse('2026-10-07T12:30:00Z') / 1000))
  })

  /*
   * The second run in one slot is the common case — an edit upstream, then Run — and it asks about
   * the same boundary as the first. Held for the session, newest only, never in IndexedDB: a
   * boundary is a new instant 48 times a day, and that store has no eviction.
   */
  it('answers a second run in the same slot without asking again, and keeps nothing', async () => {
    const calls = installFetch()
    await run(annotations(), { updateTo: 'halfHour' })
    const first = stampsOf(calls).length
    vi.setSystemTime(Date.parse('2026-10-07T12:59:59Z'))
    const out = (await run(annotations(), { updateTo: 'halfHour' })).out as TableValue
    expect(out.data.neuronId).toEqual([NEW, KEPT])
    expect(stampsOf(calls)).toHaveLength(first)

    const boundary = Date.parse('2026-10-07T12:30:00Z')
    expect(
      await cacheGet(`cave-roots:https://cg.example|flywire_public|${boundary}`, {
        fingerprint: 'v1',
      }),
    ).toBeUndefined()
  })

  it('asks again once the next boundary has passed', async () => {
    const calls = installFetch()
    await run(annotations(), { updateTo: 'halfHour' })
    vi.setSystemTime(Date.parse('2026-10-07T13:00:01Z'))
    await run(annotations(), { updateTo: 'halfHour' })
    expect(new Set(stampsOf(calls))).toEqual(
      new Set([
        String(Date.parse('2026-10-07T12:30:00Z') / 1000),
        String(Date.parse('2026-10-07T13:00:00Z') / 1000),
      ]),
    )
  })
})

/*
 * Every mode but a materialization reads no version, so a version typed earlier is hidden — which
 * is what takes it out of the provenance key (`normalizeParams` reads only visible params) — and
 * `validate` says nothing about it. Read off the dropdown rather than listed, so a mode added later
 * is covered without anybody remembering to add it here.
 */
it('ignores a materialization typed under any other mode, in the key and in validate', () => {
  const def = requireNodeDef('cave.updateRootIds')
  const modes = (findParam(def, 'updateTo') as EnumParam).options as readonly {
    value: string
  }[]
  const others = modes.map((o) => o.value).filter((m) => m !== 'materialization')
  expect(others.length).toBeGreaterThan(0)
  for (const mode of others) {
    const params = { ...defaultParams(def), updateTo: mode, version: 'nonsense' }
    expect(visibleParams(def, params as never).map((p) => p.id)).not.toContain('version')
    const g = addNode(emptyGraph('x'), {
      id: 'upd',
      type: 'cave.updateRootIds',
      position: { x: 0, y: 0 },
      params: params as GraphNode['params'],
    })
    const messages = (inferGraph(g).nodes.upd?.issues ?? []).map((i) => i.message).join(' ')
    expect(messages).not.toContain('materialization number')
  }
})

/**
 * Both pickers, on a fresh session — the state this node is *usually* first met in.
 *
 * Reported on `Table from URL → Combine Columns → Update root IDs`, which is the chain its own
 * guide describes: the first Run of a session failed with "Pick an ID column and a supervoxel ID
 * column" over two pickers the card was drawing as empty, and a second Run worked. `Table from
 * URL` remembers its schema per URL in a session-scoped map, so before its first fetch it
 * publishes none — and neither picker had been *touched*, which is precisely the case the
 * resolver got wrong.
 */
describe('the pickers before any schema has arrived', () => {
  const def = requireNodeDef('cave.updateRootIds')
  const resolve = (id: string, params: Record<string, unknown>, input = T.table()) =>
    resolveColumn(
      findParam(def, id) as ColumnParam,
      { ...defaultParams(def), ...params } as never,
      {
        in: input,
      },
    )

  it('resolves both on a node nobody has configured', () => {
    expect(resolve('idColumn', {})).toBe('neuronId')
    expect(resolve('supervoxelColumn', {})).toBe('supervoxel_id')
  })

  it('resolves both from a saved graph carrying the old empty supervoxel value', () => {
    // Exactly what the reported `.coda.json` holds: `idColumn` on its declared default, and
    // `supervoxelColumn` empty because the widget had been *showing* the resolver's fallback,
    // so there was never anything to change.
    expect(resolve('idColumn', { idColumn: 'neuronId', supervoxelColumn: '' })).toBe('neuronId')
    expect(resolve('supervoxelColumn', { idColumn: 'neuronId', supervoxelColumn: '' })).toBe(
      'supervoxel_id',
    )
  })

  it('answers the same once the schema lands, or the key moves under a finished run', () => {
    const landed = T.table(
      tableSchema(
        column('supervoxel_id', 'str'),
        column('neuronId', 'str'),
        column('cell_type', 'str'),
      ),
    )
    for (const id of ['idColumn', 'supervoxelColumn']) {
      expect(resolve(id, {}, landed)).toBe(resolve(id, {}))
    }
  })

  it('still lets a chosen column win, whichever way the schema is known', () => {
    const landed = T.table(tableSchema(column('sv', 'str'), column('root', 'str')))
    expect(resolve('supervoxelColumn', { supervoxelColumn: 'sv' }, landed)).toBe('sv')
    expect(resolve('supervoxelColumn', { supervoxelColumn: 'sv' })).toBe('sv')
  })
})

/**
 * The Dataset input, wired to a backend that has no chunkedgraph.
 *
 * A reference port naming a datastack accepts any Dataset at the type level, so this used to be
 * made on the canvas, run, and refuse with `Cannot read a materialization out of "male-cns:v1.0"`
 * — the colon split failing three layers from the wire that caused it. Nothing about a neuPrint or
 * CATMAID id *can* be repaired here: a body id is a property on a node and does not move.
 */
describe('a Dataset from another backend', () => {
  const issues = (g: CodaGraph, id: string) =>
    (inferGraph(g).nodes[id]?.issues ?? []).map((i) => i.message).join(' ')

  const node = (id: string, type: string, params: Record<string, unknown> = {}): GraphNode => ({
    id,
    type,
    position: { x: 0, y: 0 },
    params: { ...defaultParams(requireNodeDef(type)), ...params } as GraphNode['params'],
  })

  /** One dataset node wired to the reference port, and nothing else. */
  const wired = (dataset: GraphNode): CodaGraph => {
    let g = emptyGraph('x')
    g = addNode(g, dataset)
    g = addNode(g, node('upd', 'cave.updateRootIds'))
    return addEdge(g, {
      source: dataset.id,
      sourceHandle: 'dataset',
      target: 'upd',
      targetHandle: 'dataset',
    })
  }

  it('refuses at edit time, naming the backend rather than the grammar', () => {
    const message = issues(
      wired(node('np', 'dataset.neuprint', { dataset: 'male-cns:v1.0' })),
      'upd',
    )
    expect(message).toContain('neuPrint')
    expect(message).toContain('CAVE')
    // Not the sentence `evaluate` used to produce, which was about a colon.
    expect(message).not.toContain('Cannot read a materialization')
  })

  it('says nothing about a CAVE dataset, which is the case it must not catch', () => {
    const cave = node('ds', 'dataset.cave', {
      datastack: 'flywire_fafb_public',
      version: '783',
      neuronTable: 'neurons',
    })
    expect(issues(wired(cave), 'upd')).not.toContain('chunkedgraph')
  })

  /*
   * An unwired reference port is the ordinary state of this node while somebody builds around it,
   * and an unresolved one is invariant 2's cold session. Neither is a foreign backend, and a
   * refusal on either would put a badge on every card for the first second of a load.
   */
  it('says nothing with the port unwired', () => {
    let g = emptyGraph('x')
    g = addNode(g, node('upd', 'cave.updateRootIds'))
    expect(issues(g, 'upd')).not.toContain('chunkedgraph')
  })
})
