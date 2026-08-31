/**
 * Stack Neurons: what it joins, and what it refuses to join.
 *
 * The joining is array concatenation and would not be worth a test on its own. What is worth
 * one is everything around it — the two halves staying in step, the three refusals, and the
 * schema promise matching what `evaluate` builds. Each of those is a case that otherwise
 * produces a collection that *draws*, which is the failure mode this whole area keeps hitting.
 */

import { describe, expect, it } from 'vitest'

import { makeTable, boundsOf } from '../../core/values'
import type { MeshesValue, PointsValue, SkeletonsValue } from '../../core/values'
import { column, tableSchema } from '../../core/types'
import { checkStackable, stackGeometry } from '../lib/transformOps'
import { stackSchema } from '../lib/tableOps'

function skeletons(
  ids: string[],
  extra: Partial<SkeletonsValue> = {},
  columns: Record<string, unknown[]> = {},
): SkeletonsValue {
  const items = ids.map((id, i) => ({
    id,
    positions: new Float32Array([i, i, i, i + 1, i + 1, i + 1]),
    radii: new Float32Array([1, 1]),
    parents: new Int32Array([-1, 0]),
  }))
  const names = ['neuronId', ...Object.keys(columns)]
  return {
    kind: 'skeletons',
    items,
    attributes: makeTable(
      tableSchema(...names.map((n) => column(n, 'str'))),
      { neuronId: ids, ...columns },
      'neurons',
    ),
    bounds: boundsOf(items.map((item) => item.positions)),
    units: 'nm',
    ...extra,
  }
}

describe('stackGeometry', () => {
  it('keeps items and attribute rows in the same order', () => {
    /*
     * The contract every consumer leans on: `SkeletonsValue` promises one attribute row per
     * item *in the same order*, and a neuron's type is read by indexing the table with the
     * item's position. Concatenated in different orders, every neuron after the first input's
     * length wears somebody else's name — and it draws perfectly well.
     */
    const out = stackGeometry(skeletons(['1', '2']), skeletons(['3', '4', '5']))
    expect(out.kind).toBe('skeletons')
    if (out.kind !== 'skeletons') throw new Error('kind')
    expect(out.items.map((i) => i.id)).toEqual(['1', '2', '3', '4', '5'])
    expect(out.attributes.data.neuronId).toEqual(['1', '2', '3', '4', '5'])
  })

  it('recomputes the bounding box over both halves', () => {
    // A roll-up, like every other bounds in this codebase. Kept from one side, a viewer frames
    // half the scene and the other half sits outside the camera.
    const out = stackGeometry(skeletons(['1']), skeletons(['2', '3']))
    expect(out.bounds.max[0]).toBeGreaterThan(
      stackGeometry(skeletons(['1']), skeletons(['1'])).bounds.max[0] - 1,
    )
    expect(out.bounds.min).toEqual([0, 0, 0])
  })

  it('adds the source column, and promises it in the schema', () => {
    // Invariant 3: `inferOutputs` publishes what `evaluate` builds, or a downstream picker is
    // configured against a shape that never arrives.
    const options = { sourceColumn: 'origin', topLabel: 'A', bottomLabel: 'B' }
    const top = skeletons(['1'])
    const bottom = skeletons(['2'])

    const promised = stackSchema(top.attributes.schema, bottom.attributes.schema, options)
    const built = stackGeometry(top, bottom, options)

    expect(promised?.columns.map((c) => c.name)).toEqual(
      built.attributes.schema.columns.map((c) => c.name),
    )
    expect(built.attributes.data.origin).toEqual(['A', 'B'])
  })

  it('leaves colliding ids exactly as they are', () => {
    /*
     * A neuron stacked with its own mirror shares an id, because it *is* that neuron. Respelling
     * the draw key is tempting and would break the selection path: the 3D viewer hands its
     * selection back as those keys and `rowsWithIds` matches them against `neuronId`, which is
     * the identity and cannot be respelled. A suffixed key matches no row.
     */
    const out = stackGeometry(skeletons(['1', '2']), skeletons(['1', '2']), {
      sourceColumn: 'side',
      topLabel: 'Original',
      bottomLabel: 'Mirrored',
    })
    if (out.kind !== 'skeletons') throw new Error('kind')
    expect(out.items.map((i) => i.id)).toEqual(['1', '2', '1', '2'])
    // Told apart by the column instead, which is what a colour encoding reads.
    expect(out.attributes.data.side).toEqual(['Original', 'Original', 'Mirrored', 'Mirrored'])
  })

  it('carries a space that only one side knew', () => {
    // The only direction that adds information: a set that knows where it is passes that on to
    // a collection whose other half never said.
    const out = stackGeometry(skeletons(['1'], { space: 'MANC' }), skeletons(['2']))
    expect(out.space).toBe('MANC')
    expect(out.units).toBe('nm')
  })

  it('keeps the skeleton route only where both sides came down the same one', () => {
    /*
     * `MeshDetail`'s rule, on the field beside it: two routes in one collection is no route.
     * Stacking a traced reconstruction onto a chunk-graph one is what this node is *for*, but
     * the result cannot be labelled as either — a card naming one would be claiming something
     * about half its contents, and cable length is not the same measurement down both.
     *
     * Compared by **id**: these come from two fetches and are equal objects at best.
     */
    const l2 = { id: 'l2', label: 'level-2 chunk graph' }
    const routeOf = (top: SkeletonsValue, bottom: SkeletonsValue) => {
      const out = stackGeometry(top, bottom)
      if (out.kind !== 'skeletons') throw new Error('kind')
      return out.provenance
    }

    expect(
      routeOf(skeletons(['1'], { provenance: l2 }), skeletons(['2'], { provenance: { ...l2 } }))
        ?.id,
    ).toBe('l2')
    expect(
      routeOf(
        skeletons(['1'], { provenance: l2 }),
        skeletons(['2'], { provenance: { id: 'published', label: 'published skeletons' } }),
      ),
    ).toBeUndefined()
    // And one side saying nothing is not agreement either.
    expect(routeOf(skeletons(['1'], { provenance: l2 }), skeletons(['2']))).toBeUndefined()
  })
})

describe('checkStackable', () => {
  it('refuses two different kinds, pointing at the viewer that takes both', () => {
    const meshes: MeshesValue = {
      kind: 'meshes',
      items: [
        { id: '1', positions: new Float32Array([0, 0, 0]), indices: new Uint32Array([0]) },
      ],
      attributes: makeTable(
        tableSchema(column('neuronId', 'str')),
        { neuronId: ['1'] },
        'neurons',
      ),
      bounds: boundsOf([new Float32Array([0, 0, 0])]),
      units: 'nm',
    }
    expect(() => checkStackable(skeletons(['1']), meshes)).toThrow(/separate ports/)
  })

  it('refuses a scale mismatch', () => {
    // Half the collection eight times too small, in one scene, with a box framing neither.
    expect(() =>
      checkStackable(skeletons(['1']), skeletons(['2'], { units: 'voxels' })),
    ).toThrow(/nm.*voxels|voxels.*nm/)
  })

  it('refuses two template spaces, naming the node that fixes it', () => {
    /*
     * The refusal this whole feature was built to make possible. Two datasets' coordinates are
     * hundreds of micrometres apart, so combining them un-transformed draws two clouds in
     * opposite corners of an empty scene — which reads as a broken viewer, not a missing step.
     */
    const error = (() => {
      try {
        checkStackable(
          skeletons(['1'], { space: 'FLYWIRE' }),
          skeletons(['2'], { space: 'JRCFIB2018F' }),
        )
        return ''
      } catch (e) {
        return String(e)
      }
    })()
    expect(error).toMatch(/FLYWIRE/)
    expect(error).toMatch(/JRCFIB2018F/)
    expect(error).toMatch(/Transform Neurons/)
  })

  it('lets an unstated space through', () => {
    // Absent means unknown, not wrong — `checkNblastUnits`' rule. The mock connectome and every
    // Custom dataset produce spaceless geometry, and refusing on a fact nobody stated would
    // break every bundled example.
    expect(() =>
      checkStackable(skeletons(['1'], { space: 'FLYWIRE' }), skeletons(['2'])),
    ).not.toThrow()
    expect(() => checkStackable(skeletons(['1']), skeletons(['2']))).not.toThrow()
  })

  it('drops a level of detail the two sides disagree on', () => {
    // Two levels in one collection is no level, and a caption claiming one is worse than a
    // caption claiming none.
    const mesh = (lod: number): MeshesValue => ({
      kind: 'meshes',
      items: [
        {
          id: String(lod),
          positions: new Float32Array([0, 0, 0]),
          indices: new Uint32Array([0]),
        },
      ],
      attributes: makeTable(
        tableSchema(column('neuronId', 'str')),
        { neuronId: [String(lod)] },
        'neurons',
      ),
      bounds: boundsOf([new Float32Array([0, 0, 0])]),
      units: 'nm',
      detail: { lod, levels: 3, triangles: 10 },
    })
    expect((stackGeometry(mesh(0), mesh(2)) as MeshesValue).detail).toBeUndefined()
    expect((stackGeometry(mesh(1), mesh(1)) as MeshesValue).detail).toEqual({
      lod: 1,
      levels: 3,
      triangles: 10,
    })
  })

  it('concatenates a point cloud and its rows together', () => {
    const points = (n: number): PointsValue => ({
      kind: 'points',
      positions: new Float32Array(n * 3).fill(n),
      attributes: makeTable(
        tableSchema(column('neuronId', 'str')),
        { neuronId: Array.from({ length: n }, () => String(n)) },
        'neurons',
      ),
      bounds: boundsOf([new Float32Array(n * 3).fill(n)]),
      units: 'nm',
    })
    const out = stackGeometry(points(2), points(3)) as PointsValue
    expect(out.positions.length).toBe(15)
    expect(out.attributes.length).toBe(5)
  })
})
