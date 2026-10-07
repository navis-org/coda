/**
 * The 3D View's compartment colours: which label set wins, what each code is drawn as, and what
 * the key and the caption say about it.
 */

import { describe, expect, it } from 'vitest'

import { column, tableSchema } from '../core/types'
import type { SkeletonGeometry, SkeletonsValue } from '../core/values'
import { EMPTY_BOUNDS, makeTable } from '../core/values'
import type { ColorSpec } from '../nodes/lib/encodingParams'
import { CHART_INK } from '../style/colors'
import { compartmentInks, compartmentShading } from './compartmentInk'
import { compartmentNote } from './viewers/viewer3dScene'

const SPEC: ColorSpec = { mode: 'compartment', column: undefined, constant: '0' }

function arbour(id: string, extra: Partial<SkeletonGeometry> = {}): SkeletonGeometry {
  return {
    id,
    positions: new Float32Array(12),
    radii: new Float32Array(4),
    parents: new Int32Array([-1, 0, 1, 2]),
    ...extra,
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

describe('compartmentShading', () => {
  const { axon, dendrite } = compartmentInks('dark')
  const ink = CHART_INK.dark

  it('draws a computed split in the axon, dendrite and linker inks', () => {
    const shading = compartmentShading(
      set(arbour('1', { split: Uint8Array.from([1, 3, 2, 0]) })),
      SPEC,
      'dark',
    )
    expect([0, 1, 2, 3].map((node) => shading.nodeAt!(0, node))).toEqual([
      dendrite,
      ink.muted,
      axon,
      undefined,
    ])
    // An unassigned node falls back to the neuron's colour, which is the unlabelled ink.
    expect(shading.at(0)).toBe(ink.secondary)
  })

  it('reads SWC codes off the source’s labels, both dendrite codes as one', () => {
    const shading = compartmentShading(
      set(arbour('1', { compartments: Uint8Array.from([1, 2, 3, 4]) })),
      SPEC,
      'dark',
    )
    expect([0, 1, 2, 3].map((node) => shading.nodeAt!(0, node))).toEqual([
      ink.primary,
      axon,
      dendrite,
      dendrite,
    ])
  })

  it('prefers the computed split where an arbour carries both, and counts which it drew', () => {
    const shading = compartmentShading(
      set(
        arbour('1', {
          compartments: Uint8Array.from([2, 2, 2, 2]),
          split: Uint8Array.from([1, 1, 1, 1]),
        }),
        arbour('2', { compartments: Uint8Array.from([3, 3, 3, 3]) }),
        arbour('3'),
      ),
      SPEC,
      'dark',
    )
    expect(shading.nodeAt!(0, 0)).toBe(dendrite)
    expect(shading.drawn).toEqual({ split: 1, source: 1 })
  })

  it('keys only what is drawn, in a fixed order, with overrides honoured', () => {
    const shading = compartmentShading(
      set(arbour('1', { split: Uint8Array.from([2, 2, 1, 0]) }), arbour('2')),
      { ...SPEC, overrides: { axon: '#123456' } },
      'dark',
    )
    const legend = shading.legend
    if (legend?.kind !== 'categorical') throw new Error('expected a categorical key')
    expect(legend.entries).toEqual([
      { label: 'axon', color: '#123456' },
      { label: 'dendrite', color: dendrite },
      { label: 'unlabelled', color: ink.secondary },
    ])
    expect(shading.nodeAt!(0, 0)).toBe('#123456')
  })
})

describe('compartmentNote', () => {
  it('names the labels drawn, and says nothing when none were', () => {
    expect(compartmentNote({ split: 2, source: 0 })?.label).toBe('computed split')
    expect(compartmentNote({ split: 0, source: 1 })?.label).toBe('source labels')
    expect(compartmentNote({ split: 1, source: 1 })?.label).toBe(
      'computed split · source labels',
    )
    expect(compartmentNote({ split: 0, source: 0 })).toBeUndefined()
  })
})
