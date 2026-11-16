/**
 * Reading a chunkedgraph id's chunk. The ids are built by pychunkedgraph's own formula
 * (`src/test/chunkedgraphIds.ts`), so a decode that disagrees with the server's fails — which
 * matters because the only use of the answer is predicting the server's three-chunk refusal.
 */

import { describe, expect, it } from 'vitest'

import { AEDES_GRAPH_INFO, nodeId } from '../../test/chunkedgraphIds'
import { chunkDistance, chunkOf, layerOf, parseGraphLayout } from './graphLayout'

const layout = parseGraphLayout(AEDES_GRAPH_INFO)!
const graph = AEDES_GRAPH_INFO.graph

/** Two layer-1 ids, in chunks `a` and `b`. */
const apart = (a: readonly number[], b: readonly number[]) =>
  chunkDistance(layout, nodeId(1, a, 1), nodeId(1, b, 2))

describe('a chunkedgraph layout', () => {
  it('reads the graph block of a segmentation info', () => {
    expect(layout.layerBits).toBe(8)
    expect(layout.bitsPerAxis.get(1)).toBe(10)
    expect(layout.bitsPerAxis.get(9)).toBe(1)
    expect(layout.baseMip).toBe(0)
    expect(layout.baseResolutionNm).toEqual([16, 16, 45])
  })

  /** Every number changes which chunk an id decodes to, so none is guessed. */
  it('refuses an info without a whole layout', () => {
    expect(parseGraphLayout({})).toBeUndefined()
    expect(
      parseGraphLayout({
        ...AEDES_GRAPH_INFO,
        graph: { ...graph, n_bits_for_layer_id: undefined },
      }),
    ).toBeUndefined()
    expect(
      parseGraphLayout({
        ...AEDES_GRAPH_INFO,
        graph: { ...graph, spatial_bit_masks: { '2': 10 } },
      }),
    ).toBeUndefined()
    // No resolution for the base scale: a reader could not tell which bucket scale it is.
    expect(parseGraphLayout({ graph })).toBeUndefined()
    expect(
      parseGraphLayout({ graph: { ...graph, cv_mip: 1 }, scales: AEDES_GRAPH_INFO.scales }),
    ).toBeUndefined()
    // 8 + 3 × 20 > 64: the decode would shift by a negative.
    expect(
      parseGraphLayout({
        ...AEDES_GRAPH_INFO,
        graph: { ...graph, spatial_bit_masks: { '1': 20 } },
      }),
    ).toBeUndefined()
  })
})

describe('the chunk an id sits in', () => {
  it('decodes a supervoxel id by the server’s formula', () => {
    const id = nodeId(1, [37, 512, 1023], 123_456)
    expect(layerOf(layout, id)).toBe(1)
    expect(chunkOf(layout, id)).toEqual([37, 512, 1023])
  })

  /** The counter is the low bits; a large one must not leak into z. */
  it('is not moved by the counter', () => {
    expect(chunkOf(layout, nodeId(1, [1, 2, 5], 2 ** 26 - 1))).toEqual([1, 2, 5])
  })

  it('reads a higher layer with that layer’s width', () => {
    expect(chunkOf(layout, nodeId(4, [3, 2, 1], 7, { bitsPerAxis: 5 }))).toEqual([3, 2, 1])
  })

  it('is nothing for a layer the graph does not have', () => {
    expect(chunkOf(layout, nodeId(12, [0, 0, 0], 1))).toBeUndefined()
  })
})

describe('how many chunks apart two ids are', () => {
  it('is the largest per-axis difference', () => {
    expect(apart([10, 10, 10], [12, 9, 13])).toBe(3)
    expect(apart([10, 10, 10], [10, 10, 14])).toBe(4)
    expect(apart([10, 10, 10], [10, 10, 10])).toBe(0)
  })

  /** Chunk coordinates on two layers are on two grids. */
  it('is not answered across layers', () => {
    expect(
      chunkDistance(layout, nodeId(1, [1, 1, 1], 1), nodeId(2, [1, 1, 1], 1)),
    ).toBeUndefined()
  })
})
