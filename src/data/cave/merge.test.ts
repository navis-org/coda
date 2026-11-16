/**
 * The merge handler's distance rule, on ids built by the server's own formula. Its one use is
 * predicting the server's three-chunk refusal before anything is sent.
 */

import { describe, expect, it } from 'vitest'

import { AEDES_GRAPH_INFO, nodeId } from '../../test/chunkedgraphIds'
import { parseGraphLayout } from './graphLayout'
import { mergeChunkDistance } from './merge'

const layout = parseGraphLayout(AEDES_GRAPH_INFO)!

describe('the merge handler’s distance', () => {
  it('is the chunk distance between two supervoxels', () => {
    expect(mergeChunkDistance(layout, nodeId(1, [1, 1, 1], 1), nodeId(1, [1, 4, 1], 2))).toBe(3)
  })

  /**
   * Two layer-2 ids have a chunk distance, on layer 2's grid, but they are not supervoxels — and a
   * supervoxel out of the graph's own watershed that does not decode as layer 1 means the layout
   * and the volume disagree, which is a fault to name, not a merge "too far".
   */
  it('refuses an id that is not a supervoxel', () => {
    expect(() =>
      mergeChunkDistance(layout, nodeId(2, [1, 1, 1], 1), nodeId(2, [1, 1, 1], 2)),
    ).toThrow(/not a supervoxel/)
  })
})
