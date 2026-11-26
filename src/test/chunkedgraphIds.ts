/**
 * Chunkedgraph node ids, built the way the server mints them — for tests of code that decodes
 * them (`src/data/cave/graphLayout.ts`) or chooses between them (`src/packs/seam/mergeAnchors.ts`).
 *
 * One builder so the tests agree with each other: pychunkedgraph v2.20.0 `graph/chunks/utils.py`
 * puts the layer in the top `layerBits`, then x, y and z at `bitsPerAxis` each, then a counter.
 * The defaults are Aedes' and the FANC sandbox's (8 and 10 at layer 1, read 2026-11-16).
 */
export function nodeId(
  layer: number,
  [x, y, z]: readonly number[],
  counter: number,
  { layerBits = 8, bitsPerAxis = 10 }: { layerBits?: number; bitsPerAxis?: number } = {},
): bigint {
  const xAt = 64 - layerBits - bitsPerAxis
  return (
    (BigInt(layer) << BigInt(64 - layerBits)) |
    (BigInt(x!) << BigInt(xAt)) |
    (BigInt(y!) << BigInt(xAt - bitsPerAxis)) |
    (BigInt(z!) << BigInt(xAt - 2 * bitsPerAxis)) |
    BigInt(counter)
  )
}

/**
 * A segmentation `info` with those widths — the fields `parseGraphLayout` reads, as Aedes
 * publishes them: the `graph` block (Aedes also publishes `bounding_box`, `chunk_size`,
 * `n_layers`) and the base scale's resolution.
 */
export const AEDES_GRAPH_INFO = {
  scales: [{ key: '16_16_45', resolution: [16, 16, 45] }],
  graph: {
    cv_mip: 0,
    n_bits_for_layer_id: 8,
    spatial_bit_masks: {
      '1': 10,
      '2': 10,
      '3': 6,
      '4': 5,
      '5': 4,
      '6': 3,
      '7': 2,
      '8': 1,
      '9': 1,
    },
  },
}
