/**
 * The 3D View's `by node value` colours: one scale across every skeleton carrying the value, the
 * `by value` ramp's controls honoured, and grey wherever there is no number.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../core/types'
import type { SkeletonGeometry, SkeletonsValue } from '../core/values'
import { EMPTY_BOUNDS, makeTable } from '../core/values'
import type { ColorSpec } from '../nodes/lib/encodingParams'
import { MUTED, valueRamp } from '../style/encoding'
import { nodeValueShading } from './nodeValueShading'

const SPEC: ColorSpec = {
  mode: 'nodeValue',
  column: undefined,
  constant: '0',
  nodeValue: 'flow',
}

function arbour(id: string, flow?: number[]): SkeletonGeometry {
  return {
    id,
    positions: new Float32Array(9),
    radii: new Float32Array(3),
    parents: new Int32Array([-1, 0, 1]),
    ...(flow ? { nodeValues: { flow: Float32Array.from(flow) } } : {}),
  }
}

function set(...items: SkeletonGeometry[]): SkeletonsValue {
  return {
    kind: 'skeletons',
    items,
    attributes: makeTable(tableSchema(column('neuronId', 'str')), {
      neuronId: items.map((item) => item.id),
    }),
    bounds: EMPTY_BOUNDS,
  }
}

describe('nodeValueShading', () => {
  it('colours every node on one ramp spanning all skeletons, as `by value` would', () => {
    const shading = nodeValueShading(
      set(arbour('1', [0, 0.5]), arbour('2', [1, 0.25])),
      SPEC,
      'dark',
    )
    const ramp = valueRamp({ min: 0, max: 1 }, undefined, 'dark', 'flow')!
    expect(shading.nodeAt!(0, 1)).toBe(ramp.colorOf(0.5))
    expect(shading.nodeAt!(1, 0)).toBe(ramp.colorOf(1))
    // Keyed by what the picker calls it, not the stored name.
    expect(shading.legend).toMatchObject({
      kind: 'sequential',
      column: 'synapse flow (fraction of peak)',
      domain: [0, 1],
    })
  })

  it('leaves a skeleton without the value, and a missing number, to the grey fallback', () => {
    const shading = nodeValueShading(set(arbour('1', [0, NaN, 1]), arbour('2')), SPEC, 'dark')
    expect(shading.nodeAt!(0, 1)).toBeUndefined()
    expect(shading.nodeAt!(1, 0)).toBeUndefined()
    expect(shading.at(1)).toBe(MUTED)
  })

  it('draws no key and no node colour when nothing carries the value', () => {
    const shading = nodeValueShading(set(arbour('1')), SPEC, 'dark')
    expect(shading.legend).toBeUndefined()
    expect(shading.nodeAt).toBeUndefined()
  })
})
