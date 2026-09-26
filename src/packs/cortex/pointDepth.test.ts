/**
 * Cortical Depth's two halves agree (invariant 3), place a point as the gallery places a soma, and
 * type each end of a synapse by lookup — a partner the typing does not mention stays untyped.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../../core/types'
import type { PointsValue } from '../../core/values'
import { EMPTY_BOUNDS, makeTable } from '../../core/values'
import { cellsTable } from './cells'
import { frameFor } from './frames'
import { displayLabels } from '../../nodes/lib/displayLabels'
import { pointDepthSchema, pointDepthValue } from './pointDepth'

const MINNIE = frameFor('cave', 'minnie65_public:1822')!

/** A position `depth` µm below the pia, at the pia point's own x. */
function at(depth: number): [number, number, number] {
  const angle = (5 * Math.PI) / 180
  return [183013 * 4, 83535 * 4 + (depth * 1000) / Math.cos(angle), 0]
}

function cloud(rows: { id: string; partner: string; depth: number }[]): PointsValue {
  return {
    kind: 'points',
    positions: new Float32Array(rows.flatMap((r) => at(r.depth))),
    attributes: makeTable(
      tableSchema(
        column('neuronId', 'str'),
        column('partnerId', 'str'),
        column('polarity', 'str'),
        column('layer', 'f64'),
      ),
      {
        neuronId: rows.map((r) => r.id),
        partnerId: rows.map((r) => r.partner),
        polarity: rows.map(() => 'post'),
        // A column already named `layer` is written over in its slot, never duplicated.
        layer: rows.map(() => 0),
      },
    ),
    bounds: EMPTY_BOUNDS,
    units: 'nm',
  }
}

const TYPES = displayLabels(
  makeTable(tableSchema(column('neuronId', 'str'), column('type', 'str')), {
    neuronId: ['a', 'b', 'c'],
    type: ['23P', 'BC', null],
  }),
  'neuronId',
  'type',
)!

describe('placing a point cloud', () => {
  const points = cloud([
    { id: 'a', partner: 'b', depth: 150 },
    { id: 'a', partner: 'frag', depth: 420 },
    { id: 'a', partner: 'c', depth: -300 },
  ])

  it('agrees with its schema, typed or not', () => {
    for (const types of [TYPES, undefined]) {
      const placed = pointDepthValue(points, MINNIE, types).points
      expect(placed.attributes.schema).toEqual(
        pointDepthSchema(points.attributes.schema, !!types),
      )
      for (const c of placed.attributes.schema.columns) {
        expect(placed.attributes.data[c.name]).toHaveLength(3)
      }
    }
  })

  it('folds its columns over same-named ones, keeping their slots', () => {
    const names = pointDepthSchema(points.attributes.schema, true).columns.map((c) => c.name)
    expect(names).toEqual([
      'neuronId',
      'partnerId',
      'polarity',
      'layer',
      'depth',
      'lateral',
      'type',
      'partnerType',
    ])
  })

  it('places a point where the gallery places a soma there', () => {
    const { points: placedPoints, outside } = pointDepthValue(points, MINNIE, undefined)
    const placed = placedPoints.attributes
    expect(outside).toBe(1)
    expect(placed.data['depth']![0]).toBeCloseTo(150, 1)
    expect(placed.data['layer']).toEqual(['L2/3', 'L5', null])
    // Far above the pia is a position from elsewhere: a depth, and no layer.
    expect(placed.data['depth']![2]).toBeCloseTo(-300, 1)
    const soma = cellsTable(
      makeTable(tableSchema(column('neuronId', 'str')), { neuronId: ['a'] }, 'neurons'),
      new Map([['a', at(150)]]),
      MINNIE,
    )
    // To a nanometre: the cloud's positions are float32, the soma's doubles.
    expect(soma.data['soma_depth']![0]).toBeCloseTo(placed.data['depth']![0] as number, 3)
  })

  it('types both ends by lookup, leaving what the typing does not name untyped', () => {
    const placed = pointDepthValue(points, MINNIE, TYPES).points.attributes
    expect(placed.data['type']).toEqual(['23P', '23P', '23P'])
    // A fragment is not in the typing, and a typed-as-null cell is not a type either.
    expect(placed.data['partnerType']).toEqual(['BC', null, null])
  })

  it('mints no partner type on a cloud with no partner', () => {
    const somata = tableSchema(column('neuronId', 'str'))
    expect(pointDepthSchema(somata, true).columns.map((c) => c.name)).not.toContain(
      'partnerType',
    )
    // Unknown attributes promise only what is certain.
    expect(pointDepthSchema(undefined, true).columns.map((c) => c.name)).toEqual([
      'depth',
      'lateral',
      'layer',
      'type',
    ])
  })
})
