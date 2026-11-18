/**
 * Each neuron's soma, from the nucleus table (`somaPositions`).
 *
 * The read itself is `queryTableChecked`'s; what is pinned here is what this module makes of the
 * rows — a merge and an absence left without a soma — and that a materialization is asked about
 * an id once for the session, concurrent callers included.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { queryTableChecked, queryTableLive } from './api'
import { DEFAULT_CAVE_SERVER } from './deployments'
import type { GrapheneSource } from './graphene'
import { resetNuclei, somataFor, somataLive } from './nuclei'
import { rootLives } from './rootIds'

vi.mock('./api', () => ({ queryTableChecked: vi.fn(), queryTableLive: vi.fn() }))
vi.mock('./rootIds', () => ({ rootLives: vi.fn() }))
const query = vi.mocked(queryTableChecked)
const live = vi.mocked(queryTableLive)
const lives = vi.mocked(rootLives)

const row = (root: string, id: string, x: number) => ({
  id,
  pt_root_id: root,
  pt_position_x: x,
  pt_position_y: 2,
  pt_position_z: 3,
})

const ask = (ids: string[]) =>
  somataFor('https://local.example', 'minnie65_public', 1822, 'nucleus_detection_v0', ids, {
    deployment: DEFAULT_CAVE_SERVER,
  })

beforeEach(() => {
  resetNuclei()
  query.mockReset()
  live.mockReset()
  lives.mockReset()
})

describe('a neuron’s nucleus', () => {
  it('answers a position in nanometres, and leaves a merge and an absence out', async () => {
    query.mockResolvedValueOnce([row('1', 'n1', 100), row('2', 'n2', 5), row('2', 'n3', 6)])
    const somata = await ask(['1', '2', '3'])
    expect(somata.get('1')).toEqual([100, 2, 3])
    // Two nuclei under one root: which would be the neuron's? Neither.
    expect(somata.has('2')).toBe(false)
    expect(somata.has('3')).toBe(false)
  })

  it('asks a materialization only about ids nobody has asked about this session', async () => {
    query.mockResolvedValueOnce([row('1', 'n1', 1)])
    await ask(['1', '2'])
    query.mockResolvedValueOnce([])
    await ask(['1', '2', '3'])
    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[1]![3].filters).toEqual({ in: { pt_root_id: ['3'] } })
  })

  it('lets a call made while another is in flight wait for it, not repeat it', async () => {
    query.mockResolvedValueOnce([row('1', 'n1', 1)])
    const [a, b] = await Promise.all([ask(['1']), ask(['1'])])
    expect(query).toHaveBeenCalledTimes(1)
    expect(b.get('1')).toEqual(a.get('1'))
  })
})

describe('a neuron’s nucleus at its own moment', () => {
  const graphene: GrapheneSource = {
    server: 'https://cave.example.org',
    table: 'test_table',
    base: 'https://cave.example.org/segmentation/table/test_table',
  }
  const NOW = 1_794_903_754_257
  const REPLACED_AT = 1_794_901_069_071

  /**
   * '1' and '2' current — stamped 3 ms apart, as a server answering each root on its own might —
   * '3' and '5' replaced by one merge, '4' never made.
   */
  beforeEach(() => {
    lives.mockImplementation(async (_g, roots) => {
      const all = new Map([
        ['1', { made: 1, last: NOW, current: true }],
        ['2', { made: 1, last: NOW + 3, current: true }],
        ['3', { made: 1, last: REPLACED_AT, current: false }],
        ['5', { made: 1, last: REPLACED_AT, current: false }],
      ])
      return {
        lives: new Map([...all].filter(([id]) => roots.includes(id))),
        unknown: roots.filter((id) => !all.has(id)),
      }
    })
  })
  const askLive = (ids: string[]) =>
    somataLive('https://local.example', graphene, 'wclee_aedes_brain', 'nuclei_v1_aedes', ids, {
      deployment: DEFAULT_CAVE_SERVER,
    })

  it('reads the current roots together and each merge’s replaced roots together', async () => {
    live.mockImplementation(async (_s, _d, at) =>
      at === NOW ? [row('1', 'n1', 10), row('2', 'n2', 20)] : [row('3', 'n3', 30)],
    )
    const { somata, replaced, unknown } = await askLive(['1', '2', '3', '5', '4'])
    // The current roots at the earlier of their moments, which both were current at — not one
    // query each for a server stamping them 3 ms apart.
    expect(live.mock.calls.map(([, , at, q]) => [at, q.idsIn])).toEqual([
      [NOW, { pt_root_id: ['1', '2'] }],
      [REPLACED_AT, { pt_root_id: ['3', '5'] }],
    ])
    expect(live.mock.calls[0]![3]).toMatchObject({ resolution: [1, 1, 1] })
    expect([...somata.keys()]).toEqual(['1', '2', '3'])
    expect(replaced).toEqual(
      new Map([
        ['3', REPLACED_AT],
        ['5', REPLACED_AT],
      ]),
    )
    // Never made: not read for, and said.
    expect(unknown).toEqual(['4'])
  })

  it('remembers a soma, and asks whether the root moved on every call', async () => {
    live.mockResolvedValue([row('1', 'n1', 10)])
    await askLive(['1'])
    const { somata } = await askLive(['1'])
    expect(live).toHaveBeenCalledTimes(1)
    expect(lives).toHaveBeenCalledTimes(2)
    expect(somata.get('1')).toEqual([10, 2, 3])
  })

  it('keeps what it read live apart from what a materialization said', async () => {
    query.mockResolvedValueOnce([])
    await somataFor(
      'https://local.example',
      'wclee_aedes_brain',
      564,
      'nuclei_v1_aedes',
      ['1'],
      {
        deployment: DEFAULT_CAVE_SERVER,
      },
    )
    live.mockResolvedValueOnce([row('1', 'n1', 10)])
    // "No row at 564" is not "no row": the root was made after it.
    expect((await askLive(['1'])).somata.get('1')).toEqual([10, 2, 3])
  })

  it('asks the live table again about a root it had no row for', async () => {
    live.mockResolvedValue([])
    await askLive(['1'])
    live.mockResolvedValue([row('1', 'n1', 10)])
    // A nucleus annotated since the first run: a frozen table cannot gain one, the live one can.
    expect((await askLive(['1'])).somata.get('1')).toEqual([10, 2, 3])
    expect(live).toHaveBeenCalledTimes(2)
  })

  it('reads a current root made after the shared moment at its own', async () => {
    lives.mockResolvedValue({
      lives: new Map([
        ['1', { made: 1, last: NOW, current: true }],
        ['6', { made: NOW + 10, last: NOW + 20, current: true }],
      ]),
      unknown: [],
    })
    live.mockResolvedValue([])
    await askLive(['1', '6'])
    expect(live.mock.calls.map(([, , at, q]) => [at, q.idsIn])).toEqual([
      [NOW, { pt_root_id: ['1'] }],
      [NOW + 20, { pt_root_id: ['6'] }],
    ])
  })
})
