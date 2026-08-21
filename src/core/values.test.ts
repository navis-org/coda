/**
 * What a value says about itself in one line.
 *
 * `describeValue` is the node footer, so it is read far more often than anything else here and
 * had no coverage at all. The geometry kinds now state their **units** there, which is the
 * whole reason this file exists: nanometres is an app-wide invariant enforced at one seam, and
 * the footer is where a value that missed that seam admits it.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from './types'
import type { Bounds3, MeshesValue, PointsValue, SkeletonsValue } from './values'
import { describeValue, emptyTable, makeTable, unitsLabel } from './values'

const SCHEMA = tableSchema(column('neuronId', 'i64'))
const attributes = makeTable(SCHEMA, { neuronId: [7] })
const BOUNDS: Bounds3 = { min: [0, 0, 0], max: [1, 1, 1] }

function skeletons(units?: SkeletonsValue['units']): SkeletonsValue {
  return {
    kind: 'skeletons',
    items: [
      {
        id: '7',
        positions: new Float32Array([0, 0, 0, 1, 1, 1]),
        radii: new Float32Array([1, 1]),
        parents: new Int32Array([-1, 0]),
      },
    ],
    attributes,
    bounds: BOUNDS,
    ...(units ? { units } : {}),
  }
}

describe('describeValue — geometry', () => {
  it('names the units even when they are the expected ones', () => {
    // Printed always, not only when wrong: a line that appears only on failure is a line
    // nobody learns to look at, and the reader has to be able to tell nm from voxels here.
    expect(describeValue(skeletons('nm'))).toBe('1 skeleton · 2 pts · nm')
  })

  it('says voxels, which is a real answer rather than a failure', () => {
    // neuPrint publishes voxels and the conversion needs a voxel size it did not give. The
    // coordinates are still voxels; nobody knows how big one is. NBLAST refuses on this.
    expect(describeValue(skeletons('voxels'))).toBe('1 skeleton · 2 pts · voxels')
  })

  it('distinguishes unknown from both of them', () => {
    expect(describeValue(skeletons())).toBe('1 skeleton · 2 pts · units unknown')
    expect(unitsLabel(undefined)).toBe('units unknown')
  })

  it('says the same for meshes and for points', () => {
    const meshes: MeshesValue = {
      kind: 'meshes',
      items: [
        {
          id: '7',
          positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          indices: new Uint32Array([0, 1, 2]),
        },
      ],
      attributes,
      bounds: BOUNDS,
      units: 'nm',
    }
    const points: PointsValue = {
      kind: 'points',
      positions: new Float32Array([0, 0, 0]),
      attributes,
      bounds: BOUNDS,
      units: 'voxels',
    }
    expect(describeValue(meshes)).toBe('1 mesh · 1 tris · nm')
    expect(describeValue(points)).toBe('1 points · voxels')
  })

  it('still summarises an empty geometry set', () => {
    expect(describeValue({ ...skeletons('nm'), items: [], attributes: emptyTable(SCHEMA) })).toBe(
      '0 skeletons · 0 pts · nm',
    )
  })
})
