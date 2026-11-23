import { describe, expect, it } from 'vitest'

import { nearestChunks, sideColours, supervoxelsAtVertices } from './splitColours'

const positions = new Map<string, readonly [number, number, number]>([
  ['near', [0, 0, 0]],
  ['far', [20_000, 0, 0]],
  ['above', [0, 9_000, 0]],
])
const chunks = ['near', 'far', 'above', 'unplaced']

describe('nearestChunks', () => {
  it('names each vertex’s nearest chunk point', () => {
    const vertices = new Float32Array(
      [
        [100, 0, 0], // beside `near`
        [19_000, 0, 0], // beside `far`
        [0, 8_000, 0], // nearer `above` than `near`
        [11_000, 0, 0], // between the two along x: `far` is nearer by 2 µm
      ].flat(),
    )
    expect([...nearestChunks(vertices, chunks, positions)]).toEqual([0, 1, 2, 1])
  })

  it('names nothing where no chunk has a point', () => {
    const vertices = new Float32Array([1, 2, 3])
    expect([...nearestChunks(vertices, ['unplaced'], positions)]).toEqual([-1])
  })
})

describe('sideColours', () => {
  it('colours each vertex by its chunk’s side, and neither where there is none', () => {
    const colours = { a: [1, 0, 0], b: [0, 1, 0], none: [0, 0, 1] } as const
    const sides = new Map([
      ['near', 'a' as const],
      ['far', 'b' as const],
    ])
    const out = sideColours(
      new Int32Array([0, 1, 2, -1]),
      chunks,
      { chunkSides: sides, divided: new Map() },
      colours,
    )
    expect([...out]).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1])
  })
})

describe('nearestChunks within a vertex’s own cell', () => {
  it('takes its own cell’s chunk over a nearer point in the next cell', () => {
    // Cells 10 µm wide along x. `left` is in cell 0, `right` in cell 1; the vertex at x = 9.5 µm
    // is in cell 0 but nearer `right`'s point.
    const points = new Map<string, readonly [number, number, number]>([
      ['left', [1_000, 0, 0]],
      ['right', [10_500, 0, 0]],
    ])
    const cells = {
      of: new Map<string, readonly [number, number, number]>([
        ['left', [0, 0, 0]],
        ['right', [1, 0, 0]],
      ]),
      at: (x: number): readonly [number, number, number] => [Math.floor(x / 10_000), 0, 0],
    }
    const vertices = new Float32Array([9_500, 0, 0])
    expect([...nearestChunks(vertices, ['left', 'right'], points)]).toEqual([1])
    expect([...nearestChunks(vertices, ['left', 'right'], points, cells)]).toEqual([0])
  })
})

describe('supervoxelsAtVertices', () => {
  // A 4 × 1 × 1 box of 10 nm voxels from voxel 100: labels 0, 7, 7, 9 — 7 and 9 the neuron's.
  const labels = {
    box: {
      labels: new BigUint64Array([0n, 7n, 9n]),
      index: new Uint16Array([0, 1, 1, 2]),
      size: [4, 1, 1] as const,
    },
    lo: [100, 0, 0] as const,
    resolution: [10, 10, 10] as const,
  }

  it('names the supervoxel under a vertex, or the nearest of the neuron’s beside it', () => {
    const into = new Map<number, string>()
    // In voxel 101 (label 7); in voxel 100 (no object — nearest is 101); in voxel 103 (label 9).
    const vertices = new Float32Array([1_015, 5, 5, 1_005, 5, 5, 1_035, 5, 5])
    supervoxelsAtVertices(vertices, labels, new Set(['7', '9']), into)
    expect([...into]).toEqual([
      [0, '7'],
      [1, '7'],
      [2, '9'],
    ])
  })

  it('leaves out a vertex outside the box, or with none of the neuron’s voxels near it', () => {
    const into = new Map<number, string>()
    supervoxelsAtVertices(
      new Float32Array([5_000, 5, 5, 1_015, 5, 5]),
      labels,
      new Set(['42']),
      into,
    )
    expect(into.size).toBe(0)
  })
})

describe('sideColours, placed exactly', () => {
  it('colours a vertex by its supervoxel’s side where the cut runs through its chunk', () => {
    const colours = { a: [1, 0, 0], b: [0, 1, 0], none: [0, 0, 1] } as const
    const split = {
      chunkSides: new Map([['near', 'a' as const]]),
      divided: new Map([['near', new Map([['s2', 'b' as const]])]]),
    }
    const exact = { supervoxelOf: new Map([[1, 's2']]), chunkOf: new Map([['s2', 'near']]) }
    const out = sideColours(new Int32Array([0, 0]), chunks, split, colours, exact)
    expect([...out]).toEqual([1, 0, 0, 0, 1, 0])
  })
})
