/**
 * Points in Volumes — the op, the schema/value agreement, and the ray.
 *
 * Both halves in one file because the pair invariant 3 asks for is the interesting assertion
 * here: `volumeColumnSchema` promises a column and `labelPointsByVolume` has to produce it,
 * under the fold rule as well as the plain one. The containment test is in the same file rather
 * than beside `meshInside.ts` because three-mesh-bvh needs no GL context — `meshPicking.test.ts`
 * established that — so the real ray can be run here and the op need not be checked against a
 * fake it could agree with while disagreeing with the shipped one.
 *
 * What is worth pinning is what a plausible implementation gets wrong:
 *
 *  - the two ports **partition** the cloud, points *and* attribute rows together;
 *  - a cloud that already carries the column has it **written over in place**, not appended;
 *  - a point in two volumes takes the **first on the wire** and is *counted*;
 *  - the BVH build leaves `MeshGeometry.indices` exactly as it found it, which is the one
 *    failure here that changes somebody else's value and draws identically;
 *  - a frame mismatch is a sentence rather than an empty `Inside` port.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import type { MeshesValue, PointsValue } from '../../core/values'
import { makeTable } from '../../core/values'
import { cube } from './__fixtures__/cube'
import { buildInsideTests, volumeBoxes } from './meshInside'
import {
  checkPointFrame,
  countRays,
  labelPointsByVolume,
  volumeColumnSchema,
} from './pointsInMeshes'

/**
 * Three cubes: `a` and `b` overlap between x 0.5 and 1, `c` is on its own.
 *
 * The overlap is the whole reason this fixture is not a tiling set. A dataset's primary regions
 * do not overlap, so a fixture built from them agrees with an implementation that stops at the
 * first hit and with one that does not, and says nothing about either.
 */
function volumes(): MeshesValue {
  const items = [cube('a', [0, 0, 0]), cube('b', [1.5, 0, 0]), cube('c', [10, 0, 0])]
  return {
    kind: 'meshes',
    items,
    attributes: makeTable(tableSchema(column('roi', 'str'), column('primary', 'bool')), {
      roi: ['a', 'b', 'c'],
      primary: [true, true, true],
    }),
    bounds: { min: [-1, -1, -1], max: [11, 1, 1] },
    units: 'nm',
    space: 'FLYWIRE',
  }
}

const CLOUD_SCHEMA = tableSchema(column('neuronId', 'str'), column('polarity', 'str'))

/** Four synapses: one in `a`, one in the overlap, one in `c`, one nowhere near anything. */
function cloud(): PointsValue {
  return {
    kind: 'points',
    positions: new Float32Array([0, 0, 0, 0.75, 0, 0, 10, 0, 0, -50, 0, 0]),
    attributes: makeTable(CLOUD_SCHEMA, {
      neuronId: ['1', '2', '3', '4'],
      polarity: ['pre', 'pre', 'post', 'post'],
    }),
    bounds: { min: [-50, 0, 0], max: [10, 0, 0] },
    units: 'nm',
    space: 'FLYWIRE',
  }
}

async function label(points: PointsValue, name = 'roi') {
  // One `volumes()`, not two: built twice, the trees are made from one `items` array while the
  // ids are read off another, and the module's tree cache misses on every test.
  const v = volumes()
  const tests = await buildInsideTests(v.items)
  return await labelPointsByVolume(points, v, { name, containing: tests.containing })
}

const cells = (v: PointsValue, name: string) => v.attributes.data[name]

describe('the partition', () => {
  it('splits the cloud on whether anything encloses the point', async () => {
    const { inside, outside } = await label(cloud())
    expect(cells(inside, 'neuronId')).toEqual(['1', '2', '3'])
    expect(cells(outside, 'neuronId')).toEqual(['4'])
  })

  /*
   * Positions and attribute rows are addressed by one index list, which is the contract that
   * makes a `PointsValue` mean anything. A half that sliced one and kept the other whole draws
   * a perfectly ordinary scene with every dot wearing somebody else's polarity.
   */
  it('takes each point’s coordinate and its row together', async () => {
    const { inside, outside } = await label(cloud())
    expect([...inside.positions]).toEqual([0, 0, 0, 0.75, 0, 0, 10, 0, 0])
    expect([...outside.positions]).toEqual([-50, 0, 0])
    expect(cells(inside, 'polarity')).toEqual(['pre', 'pre', 'post'])
  })

  it('loses nothing and duplicates nothing', async () => {
    const { inside, outside } = await label(cloud())
    expect(inside.attributes.length + outside.attributes.length).toBe(4)
    expect(
      [...(cells(inside, 'neuronId') ?? []), ...(cells(outside, 'neuronId') ?? [])].sort(),
    ).toEqual(['1', '2', '3', '4'])
  })

  /*
   * Bounds are a roll-up over the subset, not over the input — `sliceElements`' rule, and for
   * its reason: a half claiming the whole cloud's box frames a 3D viewer on empty space around
   * it, which reads as a broken renderer rather than as a selection. `units` and `space` are
   * facts about where the coordinates came from and taking points out does not move them.
   */
  it('recomputes the bounds and carries the frame', async () => {
    const { inside, outside } = await label(cloud())
    expect(inside.bounds.min[0]).toBe(0)
    expect(outside.bounds.min[0]).toBe(-50)
    expect(inside.units).toBe('nm')
    expect(inside.space).toBe('FLYWIRE')
  })
})

describe('the column', () => {
  it('names each point’s volume, and nulls the ones inside none', async () => {
    const { inside, outside } = await label(cloud())
    expect(cells(inside, 'roi')).toEqual(['a', 'a', 'c'])
    expect(cells(outside, 'roi')).toEqual([null])
  })

  /*
   * The half a reader cannot predict, and the reason the node's `description` has to say it:
   * `foldNodeColumns`' rule. A second `roi` beside the first gives every picker downstream two
   * answers and the second is the stale one — and the surviving one keeps its **slot**, since
   * the table viewer, the CSV and GraphML key ids are all `schema.columns` in order.
   */
  it('writes over a same-named column in place rather than beside it', async () => {
    const stale = tableSchema(column('roi', 'str'), column('neuronId', 'str'))
    const points: PointsValue = {
      ...cloud(),
      attributes: makeTable(stale, {
        roi: ['stale', 'stale', 'stale', 'stale'],
        neuronId: ['1', '2', '3', '4'],
      }),
    }
    const { inside } = await label(points)
    expect(inside.attributes.schema.columns.map((c) => c.name)).toEqual(['roi', 'neuronId'])
    expect(cells(inside, 'roi')).toEqual(['a', 'a', 'c'])
  })

  it('is renamed by the param, and then the old one survives untouched', async () => {
    const { inside } = await label(cloud(), 'region')
    expect(inside.attributes.schema.columns.map((c) => c.name)).toEqual([
      'neuronId',
      'polarity',
      'region',
    ])
    expect(cells(inside, 'region')).toEqual(['a', 'a', 'c'])
  })

  /*
   * Invariant 3. The promise `inferOutputs` makes at edit time and the table built after a Run
   * have to be the same shape, or a downstream picker fills with a column that never arrives.
   */
  it('agrees with the schema the node promises, under both rules', async () => {
    for (const [name, schema] of [
      ['roi', CLOUD_SCHEMA],
      ['region', CLOUD_SCHEMA],
      ['roi', tableSchema(column('roi', 'str'), column('neuronId', 'str'))],
    ] as const) {
      const points: PointsValue = {
        ...cloud(),
        attributes: makeTable(
          schema,
          Object.fromEntries(
            schema.columns.map((c) => [c.name, ['1', '2', '3', '4'] as unknown[]]),
          ) as Record<string, (string | null)[]>,
        ),
      }
      const promised = volumeColumnSchema(schema, name)
      const { inside, outside } = await label(points, name)
      expect(inside.attributes.schema).toEqual(promised)
      // `Outside` carries it too, holding null — two ports of one type is what lets a Stack put
      // the halves back together, and what makes `inferOutputs` one answer rather than two.
      expect(outside.attributes.schema).toEqual(promised)
    }
  })
})

describe('overlap', () => {
  it('names a point in two volumes for the first on the wire, and counts it', async () => {
    const { inside, ambiguous } = await label(cloud())
    expect(cells(inside, 'roi')?.[1]).toBe('a')
    expect(ambiguous).toBe(1)
  })

  /*
   * Mutation check in test form: an implementation that stopped at the first hit would still
   * pass every assertion above, because the *answer* is the same. The count is the only thing
   * that can tell the two apart, which is why it is returned rather than derived.
   */
  it('counts only the points that really are in more than one', async () => {
    const { ambiguous } = await label({
      ...cloud(),
      positions: new Float32Array([0, 0, 0, 0, 0, 0, 10, 0, 0, -50, 0, 0]),
    })
    expect(ambiguous).toBe(0)
  })
})

describe('the ray', () => {
  /*
   * `meshPicking.ts`' finding, at a second call site. `MeshBVH` reorders the index array it is
   * given **in place** unless `indirect` is set, and the array here belongs to the `MeshesValue`
   * on the wire — held by the 3D viewer, the OBJ export and everything else downstream. A
   * reordered index draws the identical surface, which is exactly why it would go unnoticed.
   */
  it('leaves the mesh’s own index array exactly as it found it', async () => {
    const items = volumes().items
    const before = items.map((item) => Uint32Array.from(item.indices))
    await buildInsideTests(items)
    items.forEach((item, i) => expect([...item.indices]).toEqual([...before[i]!]))
  })

  /*
   * Winding is whoever exported the mesh's choice, and the test reads "inside" off a face's facing.
   * Inside-out, it answered every point backwards — how the synthetic regions once found their own
   * centres outside them — so the same cube turned inside out must answer the same.
   */
  it('answers the same for a mesh wound inside out', async () => {
    const outward = cube('a', [0, 0, 0])
    // Each triangle's last two corners swapped: the same surface, every normal pointing in.
    const indices = Uint32Array.from(outward.indices)
    for (let t = 0; t < indices.length; t += 3)
      [indices[t + 1], indices[t + 2]] = [indices[t + 2]!, indices[t + 1]!]
    for (const mesh of [outward, { ...outward, id: 'a-inward', indices }]) {
      const tests = await buildInsideTests([mesh])
      const hits: number[] = []
      tests.containing(0, 0, 0, hits)
      tests.containing(0, 0, 0.9, hits)
      expect(hits, `${mesh.id}: two points inside`).toEqual([0, 0])
      hits.length = 0
      tests.containing(0, 0, 1.5, hits)
      expect(hits, `${mesh.id}: one outside`).toEqual([])
    }
  })

  it('finds a point on the far side of a wall outside', async () => {
    const tests = await buildInsideTests(volumes().items)
    const hits: number[] = []
    tests.containing(0, 0, 1.5, hits)
    expect(hits).toEqual([])
  })

  /*
   * The prefilter is what makes the cost bearable, and `countRays` is what makes it sayable: it
   * is the number the warning is raised on, counted before a single ray is cast. Four points
   * against three cubes is twelve tests without it; with it, point 2 is in two boxes, points 1
   * and 3 in one each, and point 4 in none.
   */
  it('counts only the rays the bounding boxes let through', async () => {
    expect(countRays(cloud(), volumeBoxes(volumes().items).candidateCount)).toBe(4)
  })
})

/*
 * The slicing itself — that a long walk yields, reports the items done, rejects on an abort and
 * leaves a short walk alone — is `core/slice.test.ts`', where `sliced` lives. What is this node's
 * is only that it threads the two through.
 */
describe('the walk is interruptible', () => {
  it('passes its progress and signal down to the slicer', async () => {
    const seen: number[] = []
    await labelPointsByVolume(cloud(), volumes(), {
      name: 'roi',
      containing: () => {},
      progress: (f) => seen.push(f),
    })
    expect(seen).toEqual([1])

    const controller = new AbortController()
    controller.abort()
    await expect(
      labelPointsByVolume(cloud(), volumes(), {
        name: 'roi',
        containing: () => {},
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('the frame check', () => {
  it('says nothing when both sides agree, or when either has not said', () => {
    expect(checkPointFrame(cloud(), volumes())).toBeUndefined()
    expect(checkPointFrame({ ...cloud(), space: undefined }, volumes())).toBeUndefined()
    expect(checkPointFrame(undefined, volumes())).toBeUndefined()
  })

  /*
   * The failure this exists for, and the reason it is a refusal rather than a warning: tested
   * across spaces every point is outside every volume, so the run *succeeds* and hands back an
   * empty `Inside` port — which reads as a dataset with no synapses in those regions.
   */
  it('refuses two template spaces, naming both and the remedy', () => {
    const message = checkPointFrame({ ...cloud(), space: 'JRCFIB2022M' }, volumes())
    expect(message).toContain('JRCFIB2022M')
    expect(message).toContain('FLYWIRE')
    expect(message).toContain('Transform Neurons')
  })

  it('refuses two unit systems', () => {
    expect(checkPointFrame({ ...cloud(), units: 'voxels' }, volumes())).toContain('voxels')
  })
})
