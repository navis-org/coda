/**
 * What a value says about itself in one line.
 *
 * `describeValue` is the node footer, so it is read far more often than anything else here and
 * had no coverage at all. The geometry kinds state their **units** and their **template space**
 * there, which is the whole reason this file exists: both are facts a value can only get right
 * at the seam it was built at, and the footer is where one that missed that seam admits it.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from './types'
import type { Bounds3, MeshesValue, PointsValue, SkeletonsValue } from './values'
import { describeValue, emptyTable, makeTable, spaceLabel, unitsLabel } from './values'

const SCHEMA = tableSchema(column('neuronId', 'i64'))
const attributes = makeTable(SCHEMA, { neuronId: [7] })
const BOUNDS: Bounds3 = { min: [0, 0, 0], max: [1, 1, 1] }

function skeletons(
  units?: SkeletonsValue['units'],
  space?: SkeletonsValue['space'],
): SkeletonsValue {
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
    ...(space ? { space } : {}),
  }
}

describe('describeValue — geometry', () => {
  it('names the route the skeletons came from, ahead of the space and the units', () => {
    /*
     * The one thing about a skeleton set that a count cannot imply. A dataset often has more
     * than one route — male-CNS publishes a precomputed layer as well as serving neuPrint's SWC
     * — and they are different products: tens of nodes against tens of thousands, radii or
     * none, and a different cable length for the same neuron. Space and units are the same
     * whichever route answered, which is why this goes in front of them.
     */
    expect(
      describeValue({
        ...skeletons('nm', 'FLYWIRE'),
        provenance: { id: 'l2', label: 'level-2 chunk graph' },
      }),
    ).toBe('1 skeleton · 2 pts · level-2 chunk graph · FLYWIRE · nm')
  })

  it('leaves the route out rather than guessing one', () => {
    // Absent is a real state: a source that names no routes, and every value built before they
    // existed. A footer that made one up would be the only place claiming to know.
    expect(describeValue(skeletons('nm', 'FLYWIRE'))).not.toContain('·  ·')
  })

  it('names the units even when they are the expected ones', () => {
    // Printed always, not only when wrong: a line that appears only on failure is a line
    // nobody learns to look at, and the reader has to be able to tell nm from voxels here.
    expect(describeValue(skeletons('nm', 'FLYWIRE'))).toBe('1 skeleton · 2 pts · FLYWIRE · nm')
  })

  it('says voxels, which is a real answer rather than a failure', () => {
    // neuPrint publishes voxels and the conversion needs a voxel size it did not give. The
    // coordinates are still voxels; nobody knows how big one is. NBLAST refuses on this.
    // A space cannot be claimed without the scale either — see `geometryFrame` — so the two
    // unknowns arrive together, which is what this pairing is here to keep visible.
    expect(describeValue(skeletons('voxels'))).toBe(
      '1 skeleton · 2 pts · space unknown · voxels',
    )
  })

  it('distinguishes unknown from both of them', () => {
    expect(describeValue(skeletons())).toBe(
      '1 skeleton · 2 pts · space unknown · units unknown',
    )
    expect(unitsLabel(undefined)).toBe('units unknown')
    expect(spaceLabel(undefined)).toBe('space unknown')
  })

  it('names the space by its template id rather than by a dataset', () => {
    /*
     * `JRCFIB2018F` rather than "Hemibrain", and the difference is a factor of eight: the raw
     * hemibrain is `JRCFIB2018Fraw`, also "the hemibrain", and a footer that could not tell
     * them apart would answer a question nobody asked. The prose name lives on the manifest
     * entry, for dropdowns.
     */
    expect(describeValue(skeletons('nm', 'JRCFIB2018F'))).toContain('JRCFIB2018F')
    expect(spaceLabel('JRCFIB2018F')).toBe('JRCFIB2018F')
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
      space: 'MANC',
    }
    const points: PointsValue = {
      kind: 'points',
      positions: new Float32Array([0, 0, 0]),
      attributes,
      bounds: BOUNDS,
      units: 'voxels',
    }
    expect(describeValue(meshes)).toBe('1 mesh · 1 tris · MANC · nm')
    expect(describeValue(points)).toBe('1 points · space unknown · voxels')
  })

  it('still summarises an empty geometry set', () => {
    expect(
      describeValue({
        ...skeletons('nm', 'FLYWIRE'),
        items: [],
        attributes: emptyTable(SCHEMA),
      }),
    ).toBe('0 skeletons · 0 pts · FLYWIRE · nm')
  })
})
