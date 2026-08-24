/**
 * The arithmetic of moving geometry, and the three things that stop being true when it moves.
 *
 * The coordinates are the easy half and the one a careless test would check on its own. What
 * actually breaks is the bookkeeping: a mesh whose triangles now face inward, a bounding box
 * describing where the neurons used to be, and an attribute table whose schema no longer
 * matches what `inferOutputs` promised. None of those three throws, and two of them are
 * invisible in jsdom — so they are asserted here, in numbers, rather than left to a viewer.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import type { MeshesValue, PointsValue, SkeletonsValue } from '../../core/values'
import { makeTable } from '../../core/values'
import type { MirrorSpec } from '../../data/transforms/spaces'
import { spaceById } from '../../data/transforms/spaces'
import {
  MIRRORED_COLUMN,
  flipPositions,
  geometryPointCount,
  isGeometryKind,
  isGeometryValue,
  mirrorGeometry,
  mirroredSchema,
  mirroredTable,
  reverseWinding,
} from './transformOps'

/** A midline at 50, so `x' = 100 - x` and the arithmetic is readable in the assertions. */
const SPEC: MirrorSpec = {
  file: 'test_mirror.csv',
  landmarks: 4,
  sourceColumns: ['x_flip', 'y_flip', 'z_flip'],
  targetColumns: ['x_mirr', 'y_mirr', 'z_mirr'],
  sourceUnits: 'nm',
  targetUnits: 'nm',
  axis: 'x',
  flipAt: 100,
  origin: 'test',
}

const SCHEMA = tableSchema(column('neuronId', 'i64'), column('type', 'str'))
const attributes = makeTable(SCHEMA, { neuronId: [7], type: ['LC4'] })

function skeletons(): SkeletonsValue {
  return {
    kind: 'skeletons',
    items: [
      {
        id: '7',
        positions: new Float32Array([10, 1, 2, 30, 3, 4]),
        radii: new Float32Array([5, 6]),
        parents: new Int32Array([-1, 0]),
      },
    ],
    attributes,
    bounds: { min: [10, 1, 2], max: [30, 3, 4] },
    units: 'nm',
    space: 'FLYWIRE',
  }
}

function meshes(): MeshesValue {
  return {
    kind: 'meshes',
    items: [
      {
        id: '7',
        positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]),
        indices: new Uint32Array([0, 1, 2]),
      },
    ],
    attributes,
    bounds: { min: [0, 0, 0], max: [10, 10, 0] },
    units: 'nm',
    space: 'FLYWIRE',
  }
}

function points(): PointsValue {
  return {
    kind: 'points',
    positions: new Float32Array([10, 1, 2, 30, 3, 4]),
    attributes: makeTable(SCHEMA, { neuronId: [7, 7], type: ['LC4', 'LC4'] }),
    bounds: { min: [10, 1, 2], max: [30, 3, 4] },
    units: 'nm',
    space: 'FLYWIRE',
  }
}

describe('the reflection', () => {
  it('flips the chosen axis about the midline and leaves the others alone', () => {
    const out = flipPositions(new Float32Array([10, 1, 2, 30, 3, 4]), 'x', 100)
    expect([...out]).toEqual([90, 1, 2, 70, 3, 4])
  })

  it('flips y and z the same way', () => {
    expect([...flipPositions(new Float32Array([1, 10, 2]), 'y', 100)]).toEqual([1, 90, 2])
    expect([...flipPositions(new Float32Array([1, 2, 10]), 'z', 100)]).toEqual([1, 2, 90])
  })

  it('is its own inverse, so mirroring twice is where it started', () => {
    const once = flipPositions(new Float32Array([10, 1, 2]), 'x', 100)
    expect([...flipPositions(once, 'x', 100)]).toEqual([10, 1, 2])
  })

  it('is its own inverse only to within a float32 ULP at a real midline', () => {
    /*
     * Exact above because 100 is small. At a real one it is not, and the reason is worth
     * having written down: `flipAt - x` is computed in double and then stored on the float32
     * grid *at the midline*. FlyWire flips about 1045886, where that grid is 0.0625 nm wide —
     * far coarser than the grid a coordinate near the origin sits on — so the round trip
     * lands within half of it rather than exactly back.
     *
     * The bound below is what the doc comment on `mirrorGeometry` claims, pinned. An EM voxel
     * is 4 nm, so this is four orders of magnitude under anything anybody can see; what it
     * must not do is surprise somebody writing an equality assertion.
     */
    const spec = spaceById('FLYWIRE')!.mirror!
    /*
     * Coordinates with real mantissa bits, of the size a soma actually has. Round numbers
     * survive the round trip exactly and would make this pass for the wrong reason.
     */
    const start = new Float32Array([1604.12451171875, 30000.3125, 9000.1, 522943, 1, 2])
    const back = flipPositions(flipPositions(start, spec.axis, spec.flipAt), spec.axis, spec.flipAt)
    const worst = Math.max(...[...back].map((v, i) => Math.abs(v - start[i]!)))
    expect(worst).toBeGreaterThan(0)
    expect(worst).toBeLessThanOrEqual(0.0625)
    // And a point *on* the midline does not move at all, whatever the rounding does elsewhere.
    expect(back[3]).toBe(522943)
  })

  it('writes into a new buffer rather than through the caller’s', () => {
    /*
     * The buffer handed in belongs to the *upstream node's cached result*. In place, this
     * would move the neurons the node above is still holding: the 3D viewer an inch away
     * redraws somewhere else, and nothing connects that to the node that ran. Same class as
     * the transfer trap `linkage.ts` records.
     */
    const original = new Float32Array([10, 1, 2])
    const out = flipPositions(original, 'x', 100)
    expect([...original]).toEqual([10, 1, 2])
    expect(out).not.toBe(original)
  })
})

describe('mesh winding', () => {
  it('reverses each triangle, keeping the same three vertices', () => {
    expect([...reverseWinding(new Uint32Array([0, 1, 2, 3, 4, 5]))]).toEqual([2, 1, 0, 5, 4, 3])
  })

  it('is its own inverse', () => {
    const once = reverseWinding(new Uint32Array([0, 1, 2]))
    expect([...reverseWinding(once)]).toEqual([0, 1, 2])
  })

  it('is applied by a mirror, because a reflection turns a mesh inside out', () => {
    /*
     * The half that is easy to leave out: the coordinates are right, the numbers a test
     * usually checks are right, and the mesh renders lit from within with its faces culled the
     * wrong way — which reads as a broken renderer rather than a broken transform. jsdom has no
     * WebGL, so this assertion is the only thing standing in for looking at it.
     */
    const out = mirrorGeometry(meshes(), SPEC, 'FLYWIRE') as MeshesValue
    expect([...out.items[0]!.indices]).toEqual([2, 1, 0])
  })

  it('leaves winding alone for skeletons and points, which have none', () => {
    // Stated so the rule is visibly about *reflections of surfaces* rather than about mirrors:
    // a bridging warp preserves orientation, and reversing there would cause the fault.
    const skel = mirrorGeometry(skeletons(), SPEC, 'FLYWIRE') as SkeletonsValue
    expect([...skel.items[0]!.parents]).toEqual([-1, 0])
    expect([...skel.items[0]!.radii]).toEqual([5, 6])
  })
})

describe('the mirrored value', () => {
  it('moves every coordinate of a skeleton', () => {
    const out = mirrorGeometry(skeletons(), SPEC, 'FLYWIRE') as SkeletonsValue
    expect([...out.items[0]!.positions]).toEqual([90, 1, 2, 70, 3, 4])
  })

  it('moves a point cloud', () => {
    const out = mirrorGeometry(points(), SPEC, 'FLYWIRE') as PointsValue
    expect([...out.positions]).toEqual([90, 1, 2, 70, 3, 4])
  })

  it('recomputes the bounding box rather than carrying the old one', () => {
    /*
     * Bounds are a roll-up, and a mirrored set claiming the box it came from frames a 3D view
     * on empty space beside the neurons — which reads as a renderer that lost the data. Same
     * rule as `sliceElements`.
     */
    const out = mirrorGeometry(skeletons(), SPEC, 'FLYWIRE')
    expect(out.bounds.min[0]).toBe(70)
    expect(out.bounds.max[0]).toBe(90)
    // The untouched axes keep their extent, which is what says the box was recomputed rather
    // than reflected wholesale.
    expect(out.bounds.min[1]).toBe(1)
    expect(out.bounds.max[1]).toBe(3)
  })

  it('stamps the space it was mirrored in, which is the same space', () => {
    expect(mirrorGeometry(skeletons(), SPEC, 'FLYWIRE').space).toBe('FLYWIRE')
    expect(mirrorGeometry(skeletons(), SPEC, 'FLYWIRE').units).toBe('nm')
  })

  it('records the space even when the input carried none', () => {
    /*
     * The one case where stamping and carrying-through differ, and the reason the space is a
     * parameter rather than read off the value: geometry from an unregistered dataset, mirrored
     * because somebody named a space on the node. That claim is now on the value, so the
     * footer shows it and whatever runs next can act on it — where carrying through would
     * silently drop it and leave the output as unidentifiable as the input.
     */
    const { space: _dropped, ...unregistered } = skeletons()
    expect(mirrorGeometry(unregistered as SkeletonsValue, SPEC, 'MANC').space).toBe('MANC')
  })

  it('keeps the ids, because a mirrored neuron is that neuron', () => {
    // Invariant 8: an id is an identity, not a label to decorate. The cost — two items under
    // one id once original and mirror are stacked — is what the `mirrored` column pays.
    const out = mirrorGeometry(skeletons(), SPEC, 'FLYWIRE') as SkeletonsValue
    expect(out.items[0]!.id).toBe('7')
    expect(out.attributes.data['neuronId']).toEqual([7])
  })
})

describe('the mirrored column — schema half and value half', () => {
  it('adds one boolean column and keeps the rest', () => {
    const schema = mirroredSchema(SCHEMA)
    expect(schema.columns.map((c) => c.name)).toEqual(['neuronId', 'type', MIRRORED_COLUMN])
    expect(schema.columns.at(-1)!.dtype).toBe('bool')
  })

  it('agrees with the value half, which is invariant 3', () => {
    /*
     * The two are computed in different places — `inferOutputs` promises the schema and
     * `evaluate` builds the table — so a disagreement shows up only *after* a run, as a column
     * picker downstream that offers a column nothing has.
     */
    const table = mirroredTable(attributes)
    expect(table.schema).toEqual(mirroredSchema(SCHEMA))
    expect(table.data[MIRRORED_COLUMN]).toEqual([true])
    expect(table.length).toBe(attributes.length)
  })

  it('gives way to an incumbent column of the same name', () => {
    // `uniqueName`'s rule, and it matters because mirroring twice is a thing somebody will do.
    const already = mirroredSchema(SCHEMA)
    const twice = mirroredSchema(already)
    expect(twice.columns.map((c) => c.name)).toEqual([
      'neuronId',
      'type',
      MIRRORED_COLUMN,
      `${MIRRORED_COLUMN}_2`,
    ])
    expect(mirroredTable(mirroredTable(attributes)).schema).toEqual(twice)
  })

  it('handles an empty schema without inventing one', () => {
    expect(mirroredSchema(undefined).columns.map((c) => c.name)).toEqual([MIRRORED_COLUMN])
  })
})

describe('what counts as geometry', () => {
  it('accepts the three kinds and nothing else', () => {
    expect(isGeometryValue(skeletons())).toBe(true)
    expect(isGeometryValue(meshes())).toBe(true)
    expect(isGeometryValue(points())).toBe(true)
    expect(isGeometryValue(attributes)).toBe(false)
    expect(isGeometryValue(undefined)).toBe(false)
  })

  it('treats an unresolved type as possible rather than as a refusal', () => {
    // `isIterableKind`'s rule: unknown is the ordinary state before anything upstream has run,
    // and a node that warned there would warn on every freshly-wired graph.
    expect(isGeometryKind(undefined)).toBe(true)
    expect(isGeometryKind('any')).toBe(true)
    expect(isGeometryKind('skeletons')).toBe(true)
    expect(isGeometryKind('table')).toBe(false)
    expect(isGeometryKind('neurons')).toBe(false)
  })

  it('counts coordinates, which is what a transform costs', () => {
    expect(geometryPointCount(skeletons())).toBe(2)
    expect(geometryPointCount(meshes())).toBe(3)
    expect(geometryPointCount(points())).toBe(2)
  })
})

describe('against the real manifest', () => {
  it('mirrors a FlyWire coordinate about the midline navis would use', () => {
    /*
     * Ground truth from flybrains: `FLYWIRE.boundingbox` x runs 192200..853686, and
     * `navis.mirror_brain` flips about their *sum* — which it calls `mirror_axis_size` and
     * which is twice the midline. A point at the midline must not move; one at the low edge
     * must land on the high edge.
     */
    const spec = spaceById('FLYWIRE')!.mirror!
    expect(spec.flipAt).toBe(1045886)
    const midline = spec.flipAt / 2
    expect([...flipPositions(new Float32Array([midline, 0, 0]), spec.axis, spec.flipAt)]).toEqual(
      [midline, 0, 0],
    )
    expect([...flipPositions(new Float32Array([192200, 0, 0]), spec.axis, spec.flipAt)]).toEqual(
      [853686, 0, 0],
    )
  })
})
