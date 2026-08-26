/**
 * The precomputed skeleton reader.
 *
 * The format is small enough that the parse is not where the risk is. The risk is the three
 * things the bytes do not say: that the edge list is a *graph* where `SkeletonGeometry` wants a
 * rooted tree in visit order, that `radius` is a convention sitting behind however many other
 * attributes a source declares, and that coordinates are in whatever the `info` says. Each of
 * those fails silently — a neuron drawn in the wrong place, a consumer looping forever, or a
 * skeleton eight times away from the mesh it should wrap.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { RestoreFetch } from '../../test/precomputedStubs'
import { serveBytes as serveRaw } from '../../test/precomputedStubs'
import { resetTransport } from './transport'
import type { SkeletonSource } from './skeletons'
import { cableLength } from '../../core/values'
import { fetchSkeletons, openSkeletonSource, parseSkeleton } from './skeletons'

let restore: RestoreFetch = () => {}

/**
 * Build one segment's blob.
 *
 * `attributes` are appended as contiguous per-attribute arrays, which is the layout rule the
 * radius reader has to step through.
 */
function blob(
  positions: readonly number[][],
  edges: ReadonlyArray<readonly [number, number]>,
  attributes: readonly Float32Array[] = [],
): ArrayBuffer {
  const extra = attributes.reduce((n, a) => n + a.length * 4, 0)
  const bytes = new ArrayBuffer(8 + positions.length * 12 + edges.length * 8 + extra)
  const view = new DataView(bytes)
  view.setUint32(0, positions.length, true)
  view.setUint32(4, edges.length, true)
  positions.forEach((p, i) => {
    view.setFloat32(8 + i * 12, p[0]!, true)
    view.setFloat32(8 + i * 12 + 4, p[1]!, true)
    view.setFloat32(8 + i * 12 + 8, p[2]!, true)
  })
  const edgesAt = 8 + positions.length * 12
  edges.forEach(([a, b], i) => {
    view.setUint32(edgesAt + i * 8, a, true)
    view.setUint32(edgesAt + i * 8 + 4, b, true)
  })
  let at = edgesAt + edges.length * 8
  for (const attribute of attributes) {
    for (const value of attribute) {
      view.setFloat32(at, value, true)
      at += 4
    }
  }
  return bytes
}

const PLAIN: SkeletonSource = { base: 'https://b/sk', vertexAttributes: [] }

/** `serveBytes`, remembering the restore so each case can replace the stub freely. */
function serveBytes(objects: Readonly<Record<string, ArrayBuffer>>): { urls: string[] } {
  const served = serveRaw(objects)
  restore = served.restore
  return served
}

beforeEach(() => resetTransport())
afterEach(() => restore())

describe('parsing one segment', () => {
  it('reads a chain into a tree whose parents precede their children', () => {
    // The contract `SkeletonGeometry.parents` states, and the one the SWC writer walks on.
    const skeleton = parseSkeleton(
      blob(
        [
          [0, 0, 0],
          [1, 0, 0],
          [2, 0, 0],
          [3, 0, 0],
        ],
        // Deliberately in the order a real file uses: child first, and not sorted.
        [
          [1, 0],
          [3, 2],
          [2, 1],
        ],
      ),
      PLAIN,
    )!
    expect([...skeleton.parents]).toEqual([-1, 0, 1, 2])
    for (let i = 0; i < skeleton.parents.length; i++) {
      expect(skeleton.parents[i]!).toBeLessThan(i)
    }
  })

  it('breaks a cycle rather than emitting one', () => {
    // A cycle surviving into `parents` makes every consumer that walks to a root loop forever.
    // Nothing in the format forbids one; the edge list is an undirected graph.
    const skeleton = parseSkeleton(
      blob(
        [
          [0, 0, 0],
          [1, 0, 0],
          [2, 0, 0],
        ],
        [
          [0, 1],
          [1, 2],
          [2, 0],
        ],
      ),
      PLAIN,
    )!
    expect([...skeleton.parents].filter((p) => p === -1)).toHaveLength(1)
    for (let i = 0; i < skeleton.parents.length; i++) {
      let steps = 0
      for (let at = skeleton.parents[i]!; at !== -1; at = skeleton.parents[at]!) {
        if (++steps > skeleton.parents.length) throw new Error('parents form a cycle')
      }
    }
  })

  it('gives each disconnected component its own root', () => {
    // Two arbours in one file is a real thing, and joining them would draw a branch straight
    // through the middle of the brain.
    const skeleton = parseSkeleton(
      blob(
        [
          [0, 0, 0],
          [1, 0, 0],
          [500, 0, 0],
          [501, 0, 0],
        ],
        [
          [0, 1],
          [2, 3],
        ],
      ),
      PLAIN,
    )!
    expect([...skeleton.parents].filter((p) => p === -1)).toHaveLength(2)
  })

  it('keeps an isolated vertex rather than dropping it', () => {
    const skeleton = parseSkeleton(blob([[1, 2, 3]], []), PLAIN)!
    expect(skeleton.positions.length).toBe(3)
    expect([...skeleton.parents]).toEqual([-1])
  })

  it('skips an edge naming a vertex that is not there', () => {
    // Somebody else's bytes. One bad edge is not a reason to lose a neuron.
    const skeleton = parseSkeleton(
      blob(
        [
          [0, 0, 0],
          [1, 0, 0],
        ],
        [
          [0, 1],
          [0, 99],
        ],
      ),
      PLAIN,
    )!
    expect([...skeleton.parents]).toEqual([-1, 0])
  })

  it('applies the full affine, not just its diagonal', () => {
    // The mesh reader uses only the diagonal because it runs per vertex over millions of them and
    // every mesh source in reach is a pure scale. A skeleton is hundreds of points, so the full
    // matrix costs nothing — and a rotated source read through a diagonal is a neuron in the
    // wrong place with nothing failing.
    const source: SkeletonSource = {
      ...PLAIN,
      // Row-major 3×4: swap x and y, scale z by 8, translate x by 100.
      transform: [0, 1, 0, 100, 1, 0, 0, 0, 0, 0, 8, 0],
    }
    const skeleton = parseSkeleton(blob([[2, 3, 4]], []), source)!
    expect([...skeleton.positions]).toEqual([103, 2, 32])
  })

  it('reads a radius that sits behind another attribute', () => {
    // Attributes are contiguous per-attribute arrays in declared order, so reaching `radius`
    // means stepping over whatever precedes it — a lookup by name would read the wrong bytes.
    const source: SkeletonSource = {
      ...PLAIN,
      vertexAttributes: [
        { id: 'confidence', data_type: 'float32', num_components: 1 },
        { id: 'radius', data_type: 'float32', num_components: 1 },
      ],
    }
    const skeleton = parseSkeleton(
      blob(
        [
          [0, 0, 0],
          [1, 0, 0],
        ],
        [[0, 1]],
        [new Float32Array([0.1, 0.2]), new Float32Array([11, 22])],
      ),
      source,
    )!
    expect([...skeleton.radii]).toEqual([11, 22])
  })

  it('answers zero radii when the source declares none', () => {
    // male-CNS publishes `{"@type": "neuroglancer_skeletons"}` and nothing else. Zero rather than
    // a guess — the same answer `cave/l2.ts` gives a chunk with no distance transform.
    const skeleton = parseSkeleton(blob([[0, 0, 0]], []), PLAIN)!
    expect([...skeleton.radii]).toEqual([0])
  })

  it('declines a radius in a width it has no scale for', () => {
    // A `uint8` radius is in some quantised unit this cannot recover, and a plausible number in
    // the wrong units is worse than an honest zero.
    const source: SkeletonSource = {
      ...PLAIN,
      vertexAttributes: [{ id: 'radius', data_type: 'uint8', num_components: 1 }],
    }
    expect([...parseSkeleton(blob([[0, 0, 0]], []), source)!.radii]).toEqual([0])
  })

  it('answers undefined for a truncated or empty blob rather than throwing', () => {
    expect(parseSkeleton(new ArrayBuffer(4), PLAIN)).toBeUndefined()
    expect(parseSkeleton(blob([], []), PLAIN)).toBeUndefined()
    // A header promising more than the file holds.
    const short = new ArrayBuffer(8 + 12)
    new DataView(short).setUint32(0, 5, true)
    expect(parseSkeleton(short, PLAIN)).toBeUndefined()
  })
})

describe('opening a skeleton source', () => {
  it('refuses a directory that is not one', async () => {
    // Reading a mesh directory as skeletons would report a neuron with four points in the wrong
    // place. A typeless `info` is a legacy *mesh* directory by convention, so it is refused here
    // even though `openMeshSource` accepts exactly that shape.
    const info = (body: unknown) => {
      const bytes = new TextEncoder().encode(JSON.stringify(body))
      return bytes.buffer.slice(0) as ArrayBuffer
    }
    serveBytes({
      'https://b/mesh/info': info({ '@type': 'neuroglancer_legacy_mesh' }),
      'https://b/none/info': info({ scales: [] }),
      'https://b/sk/info': info({ '@type': 'neuroglancer_skeletons' }),
    })
    await expect(openSkeletonSource('https://b/mesh')).rejects.toThrow(/not a skeleton source/)
    await expect(openSkeletonSource('https://b/none')).rejects.toThrow(/no @type/)
    expect((await openSkeletonSource('https://b/sk')).vertexAttributes).toEqual([])
  })
})

describe('fetching a set', () => {
  it('keeps the order asked for and reports what was missing', async () => {
    // A segment with no skeleton is an answer — not every segment is reconstructed — and one 404
    // must not fail a batch of five hundred.
    serveBytes({
      'https://b/sk/1': blob([[0, 0, 0]], []),
      'https://b/sk/3': blob([[9, 9, 9]], []),
    })
    const result = await fetchSkeletons(PLAIN, ['3', '2', '1'])
    expect(result.skeletons.map((s) => s.id)).toEqual(['3', '1'])
    expect(result.missing).toEqual(['2'])
  })

  it('asks for one object per segment, by id', async () => {
    const served = serveBytes({ 'https://b/sk/42': blob([[0, 0, 0]], []) })
    await fetchSkeletons(PLAIN, ['42'])
    expect(served.urls).toEqual(['https://b/sk/42'])
  })
})

/**
 * `cableLength` is `core/values`', shared with every other backend and memoised on the
 * geometry's identity. Exercised here because this is the reader that fills the column with it,
 * and because a forest is the shape most likely to be measured wrongly.
 */
describe('cable length', () => {
  it('sums the edges of a tree, in the units the positions are in', () => {
    const skeleton = parseSkeleton(
      blob(
        [
          [0, 0, 0],
          [3, 4, 0],
          [3, 4, 12],
        ],
        [
          [0, 1],
          [1, 2],
        ],
      ),
      PLAIN,
    )!
    expect(cableLength({ id: 'x', ...skeleton })).toBeCloseTo(17, 6)
  })

  it('does not measure the gap between two components', () => {
    // A root contributes nothing, which is what makes a forest's total the sum of its trees'
    // rather than a number with a fabricated join across the brain in it.
    const skeleton = parseSkeleton(
      blob(
        [
          [0, 0, 0],
          [10, 0, 0],
          [90000, 0, 0],
          [90005, 0, 0],
        ],
        [
          [0, 1],
          [2, 3],
        ],
      ),
      PLAIN,
    )!
    expect(cableLength({ id: 'x', ...skeleton })).toBeCloseTo(15, 6)
  })
})
