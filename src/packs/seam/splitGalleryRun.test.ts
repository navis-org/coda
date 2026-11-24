/**
 * The split gallery's neuron read (`readSplitNeuron`) on a chunkedgraph with no L2 cache — its
 * table not in the server's table mapping (`hasL2Cache`): the graph
 * is the chunkedgraph's and needs none, so the read goes ahead with each chunk at its grid cell's
 * centre — and never asks the cache, which would answer "does not have an L2 Cache". Fetch is
 * faked; nothing here reaches a server.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { parseGrapheneSource } from '../../data/cave/graphene'
import type { BoxableLayout } from '../../data/cave/graphLayout'
import { cellCentreNm, parseGraphLayout } from '../../data/cave/graphLayout'
import { AEDES_GRAPH_INFO, nodeId } from '../../test/chunkedgraphIds'
import { resetL2Cache } from '../../data/cave/l2'
import { readSplitNeuron } from './splitGalleryRun'

const LAYOUT: BoxableLayout = {
  ...parseGraphLayout(AEDES_GRAPH_INFO)!,
  chunkSize: [256, 256, 128],
  voxelOffset: [0, 0, 0],
}
const GRAPHENE = parseGrapheneSource(
  'graphene://https://cave.example.org/segmentation/table/t',
)!
const A = String(nodeId(2, [1, 2, 3], 1))
const B = String(nodeId(2, [2, 2, 3], 1))

afterEach(() => {
  vi.unstubAllGlobals()
  resetL2Cache()
})

function stubFetch(): string[] {
  const asked: string[] = []
  vi.stubGlobal('fetch', (url: string) => {
    asked.push(url)
    const body = url.includes('/lvl2_graph') ? JSON.stringify({ edge_graph: [[A, B]] }) : '{}'
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(body),
    } as Response)
  })
  return asked
}

describe('readSplitNeuron without an L2 cache', () => {
  it('places each chunk at its cell’s centre, says so, and never asks the cache', async () => {
    const asked = stubFetch()
    const neuron = await readSplitNeuron(GRAPHENE, LAYOUT, '1', {
      deployment: 'https://global.example.org',
      token: 'test-token',
    })
    expect(neuron.placed).toBe('cells')
    expect(neuron.links).toEqual([[A, B]])
    expect(neuron.cells.get(A)).toEqual([1, 2, 3])
    // Cell 1 along x spans voxels 256–511 at 16 nm: its centre is 384 voxels, 6,144 nm.
    expect(neuron.positions.get(A)).toEqual(cellCentreNm(LAYOUT, [1, 2, 3]))
    expect(neuron.positions.get(A)![0]).toBe(6144)
    // The table mapping is asked (it lists no table here); the cache's attributes are not.
    expect(asked.some((url) => url.includes('/l2cache/api/v1/table_mapping'))).toBe(true)
    expect(asked.some((url) => url.includes('/attributes'))).toBe(false)
  })
})
