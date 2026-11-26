/**
 * The fence the live merge test runs behind. A write it lets through goes to a real server, so
 * what is pinned is every near miss of the sandbox: production on the same host, the sandbox's
 * other write routes, and URL spellings that resolve somewhere else.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  FENCE_REFUSED,
  SANDBOX,
  fenceWrites,
  isChunkedgraphEdit,
  sandboxRefusal,
} from './sandboxWrites'

const ON = (table: string, route: string, host: string = SANDBOX.server) =>
  `${host}/segmentation/api/v1/table/${table}/${route}`

describe('isChunkedgraphEdit', () => {
  it.each([
    'https://cave.fanc-fly.com/segmentation/api/v1/table/mar2021_test/merge?int64_as_str=1',
    'https://cave.fanc-fly.com/segmentation/api/v1/table/wclee_aedes_brain/merge_admin',
    'https://cave.fanc-fly.com/segmentation/api/v1/table/mar2021_test/split',
    'https://cave.fanc-fly.com/segmentation/api/v1/table/mar2021_test/undo',
    'https://cave.fanc-fly.com/segmentation/api/v1/table/mar2021_test/redo',
    'https://prodv1.flywire-daf.com/segmentation/api/v1/table/fly_v31/rollback_user',
    // The server decodes the path, and a trailing slash names the same route.
    'https://cave.fanc-fly.com/segmentation/api/v1/table/mar2021_test/%6Derge',
    'https://cave.fanc-fly.com/segmentation/api/v1/table/mar2021_test/merge/',
  ])('knows %s for a write', (url) => {
    expect(isChunkedgraphEdit(url)).toBe(true)
  })

  it.each([
    'https://cave.fanc-fly.com/segmentation/api/v1/table/mar2021_test/roots_binary?timestamp=1',
    'https://cave.fanc-fly.com/segmentation/api/v1/table/mar2021_test/is_latest_roots',
    'https://cave.fanc-fly.com/segmentation/api/v1/table/mar2021_test/supervoxel_lookup',
    'https://cave.fanc-fly.com/materialize/api/v3/datastack/x/query?merge=1',
    'https://storage.googleapis.com/bucket/merge',
  ])('lets the read %s through', (url) => {
    expect(isChunkedgraphEdit(url)).toBe(false)
  })
})

describe('sandboxRefusal', () => {
  it.each([
    ON(SANDBOX.table, 'merge?int64_as_str=1&priority=True'),
    ON(SANDBOX.table, 'undo?int64_as_str=1'),
    ON(SANDBOX.table, 'roots_binary'),
    ON(SANDBOX.table, 'is_latest_roots'),
    ON(SANDBOX.table, 'node/leaves_many?stop_layer=2'),
  ])('lets a POST to %s through', (url) => {
    expect(sandboxRefusal(url, 'POST')).toBeUndefined()
  })

  it.each([
    ['production Aedes, on the same host', ON('wclee_aedes_brain', 'merge')],
    ['a read of production, posted', ON('wclee_aedes_brain', 'roots_binary')],
    ['a sandbox route the test never sends', ON(SANDBOX.table, 'graph/find_path')],
    ['the admin merge', ON(SANDBOX.table, 'merge_admin')],
    ['redo', ON(SANDBOX.table, 'redo')],
    ['a rollback', ON(SANDBOX.table, 'rollback_user')],
    ['a trailing slash', ON(SANDBOX.table, 'merge/')],
    ['a route nobody listed', ON(SANDBOX.table, 'some_new_write')],
    [
      'another CAVE service',
      'https://cave.fanc-fly.com/annotation/api/v2/aligned_volume/x/table',
    ],
    ['plain http', ON(SANDBOX.table, 'merge', 'http://cave.fanc-fly.com')],
    ['another host', ON(SANDBOX.table, 'merge', 'https://prodv1.flywire-daf.com')],
    [
      'a `..` that resolves to production',
      ON(`${SANDBOX.table}/../wclee_aedes_brain`, 'merge'),
    ],
    ['an encoded slash', ON(`${SANDBOX.table}%2F..%2Fwclee_aedes_brain`, 'merge')],
    ['a table that only starts like the sandbox', ON(`${SANDBOX.table}_2`, 'merge')],
  ])('refuses a POST to %s', (_, url) => {
    expect(sandboxRefusal(url, 'POST')).toBeDefined()
  })

  it('lets a GET through, unless it is to a write route', () => {
    expect(sandboxRefusal(ON('wclee_aedes_brain', 'info'), 'GET')).toBeUndefined()
    expect(sandboxRefusal('https://storage.googleapis.com/b/info')).toBeUndefined()
    expect(sandboxRefusal(ON(SANDBOX.table, 'merge'), 'GET')).toBeDefined()
  })
})

describe('fenceWrites', () => {
  afterEach(() => vi.unstubAllGlobals())

  /** Over a stub, so nothing here is sent anywhere. */
  function fenced(limits: Parameters<typeof fenceWrites>[0]) {
    const sent: string[] = []
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      sent.push(typeof input === 'object' && 'url' in input ? input.url : String(input))
      return Promise.resolve(new Response('{}'))
    })
    return { sent, written: fenceWrites(limits) }
  }
  const post = (route: string) => fetch(ON(SANDBOX.table, route), { method: 'POST' })

  it('refuses before sending, says so in words a caller can find, and lets the rest through', async () => {
    const { sent, written } = fenced({ merge: 1, undo: 1 })
    expect(() => fetch(ON('wclee_aedes_brain', 'merge'), { method: 'POST' })).toThrow(
      FENCE_REFUSED,
    )
    // The method read off a Request too, not only off `init`.
    expect(() =>
      fetch(new Request(ON('wclee_aedes_brain', 'roots_binary'), { method: 'POST' })),
    ).toThrow(FENCE_REFUSED)
    await post('roots_binary')
    await fetch('https://storage.googleapis.com/b/info')
    expect(sent).toEqual([
      ON(SANDBOX.table, 'roots_binary'),
      'https://storage.googleapis.com/b/info',
    ])
    expect(written()).toBe(0)
  })

  it('lets one merge and one undo through, in that order, and nothing more', async () => {
    const { sent, written } = fenced({ merge: 1, undo: 1 })
    await post('merge')
    expect(() => post('merge')).toThrow(/1 merge\(s\) sent, of 1 allowed/)
    await post('undo')
    expect(() => post('undo')).toThrow(/1 undo\(s\) sent, of 1 allowed/)
    expect(sent).toHaveLength(2)
    expect(written()).toBe(2)
  })

  it('refuses an undo with no merge before it', () => {
    fenced({ merge: 1, undo: 1 })
    expect(() => post('undo')).toThrow(/an undo needs a merge or a split before it/)
  })

  it('lets one split through only where it says whether it is a min-cut, then its undo', async () => {
    const { sent, written } = fenced({ split: 1, undo: 1 })
    expect(() => post('merge')).toThrow(/0 merge\(s\) sent, of 0 allowed/)
    expect(() => post('split')).toThrow(/whether it is a min-cut/)
    expect(() => post('split?mincut=yes')).toThrow(/whether it is a min-cut/)
    await post('graph/split_preview?int64_as_str=1')
    await post('split?int64_as_str=1&mincut=false&priority=True')
    expect(() => post('split?mincut=false')).toThrow(/1 split\(s\) sent, of 1 allowed/)
    await post('undo')
    expect(sent).toHaveLength(3)
    expect(written()).toBe(2)
  })

  it('lets the level-2 cache read through on the sandbox table only', async () => {
    const { sent } = fenced({})
    const l2 = (table: string) =>
      `${SANDBOX.server}/l2cache/api/v1/table/${table}/attributes?attribute_names=rep_coord_nm`
    await fetch(l2(SANDBOX.table), { method: 'POST' })
    expect(() => fetch(l2('wclee_aedes_brain'), { method: 'POST' })).toThrow(FENCE_REFUSED)
    expect(sent).toHaveLength(1)
  })

  /** The finder's fence: reads only. */
  it('refuses every write when none is declared', () => {
    fenced({})
    expect(() => post('merge')).toThrow(/0 merge\(s\) sent, of 0 allowed/)
    expect(() => post('split?mincut=false')).toThrow(/0 split\(s\) sent, of 0 allowed/)
  })

  /** The merge probes' fences hold them to merges: a split is a write they never declared. */
  it('refuses a split under a merge test’s fence', () => {
    fenced({ merge: 1, undo: 1 })
    expect(() => post('split?mincut=false')).toThrow(/0 split\(s\) sent, of 0 allowed/)
  })
})
