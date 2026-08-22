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
import { cacheSet, resetCache } from '../../data/cache'
import { resetCredentials, setToken } from '../../data/cave/credentials'
import { resetDatastackRecords } from '../../data/cave/datastack'
import { resetRootChecks } from '../../data/cave/rootIds'
import { requireNodeDef } from '../../core/registry'
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
function installFetch(): Call[] {
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
      return json({ is_latest: list.map((id) => id !== OLD) })
    }
    if (text.includes('roots_binary')) {
      // Raw uint64 out, as `roots_binary` answers — one root per supervoxel sent.
      const sent = new BigUint64Array(init?.body as ArrayBuffer)
      const out = BigUint64Array.from(sent, () => BigInt(NEW))
      return Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(out.buffer),
      } as unknown as Response)
    }
    return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('{}') } as Response)
  })
  return calls
}

function annotations(): TableValue {
  return makeTable(
    tableSchema(column('neuronId', 'str'), column('supervoxel_id', 'str'), column('type', 'str')),
    { neuronId: [OLD, KEPT], supervoxel_id: [SV, '80000000000000002'], type: ['LC4', 'LC6'] },
    'neurons',
  )
}

function run(table: TableValue, params: Record<string, unknown> = {}) {
  const def = requireNodeDef('cave.updateRootIds')
  return def.evaluate({
    params: {
      idColumn: 'neuronId',
      supervoxelColumn: 'supervoxel_id',
      version: '',
      ...params,
    },
    refresh: false,
    input: (portId) =>
      portId === 'in'
        ? table
        : { kind: 'dataset', sourceId: 'cave', datasetId: DATASET, label: DATASET },
    inputKey: () => undefined,
    column: (id) => String((params[id] ?? { idColumn: 'neuronId', supervoxelColumn: 'supervoxel_id' }[id as 'idColumn']) ?? ''),
    columns: () => [],
    resolveSource: () => {
      throw new Error('no source')
    },
    signal: new AbortController().signal,
    progress: () => undefined,
    reportFetched: () => undefined,
  })
}

beforeEach(() => {
  resetCache()
  resetRootChecks()
  resetDatastackRecords()
  resetCredentials()
  setToken('token')
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
