/**
 * Each neuron's soma, from the nucleus table (`somaPositions`).
 *
 * The read itself is `queryTableChecked`'s; what is pinned here is what this module makes of the
 * rows — a merge and an absence left without a soma — and that a materialization is asked about
 * an id once for the session, concurrent callers included.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { queryTableChecked } from './api'
import { DEFAULT_CAVE_SERVER } from './deployments'
import { resetNuclei, somataFor } from './nuclei'

vi.mock('./api', () => ({ queryTableChecked: vi.fn() }))
const query = vi.mocked(queryTableChecked)

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
