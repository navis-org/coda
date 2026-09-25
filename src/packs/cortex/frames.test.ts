/**
 * Cortical frames, against the package they transcribe.
 *
 * The expected numbers are `standard_transform` 2.0.0's `minnie_transform_nm().apply(...)`, run on
 * these four points and written out — not re-derived here, which would test the formula against
 * itself. The first point is the pia point, so its depth is 0 by construction and its lateral
 * position is the check that the rotation's sign is the package's.
 */

import { describe, expect, it } from 'vitest'

import { DEFAULT_CAVE_SERVER } from '../../data/cave/deployments'
import { specFor } from '../../data/cave/spec'
import { DATASET_FAMILIES } from '../../nodes/lib/datasetFamilies'
import { CORTICAL_FRAMES, frameFor, layerOf, projector } from './frames'

const MINNIE = frameFor('cave', 'minnie65_public:1822')!

const PACKAGE: ReadonlyArray<[[number, number, number], number, number, number]> = [
  // position (nm)                 lateral µm  depth µm   z µm
  [[732052, 334140, 966600], 700.1441, 0, 966.6],
  [[700000, 500000, 900000], 653.7584, 162.4353, 900],
  [[900000, 800000, 800000], 826.8506, 478.7249, 800],
  [[500000, 1000000, 1000000], 410.9416, 643.1015, 1000],
]

describe('the minnie65 frame', () => {
  it.each(PACKAGE)('puts %j where standard_transform does', (position, lateral, depth, z) => {
    const frame = projector(MINNIE)
    const [px, py] = position
    expect(frame.lateral(px, py)).toBeCloseTo(lateral, 3)
    expect(frame.depth(px, py)).toBeCloseTo(depth, 3)
    // The buffer form, which is what a skeleton goes through, agrees point for point.
    const [bl, bd, bz] = frame.project(position)
    expect([bl!, bd!, bz!].map((v) => Math.round(v * 10) / 10)).toEqual(
      [lateral, depth, z].map((v) => Math.round(v * 10) / 10),
    )
  })

  it.each([
    [0, 'L1'],
    [57.6, 'L2/3'],
    [690, 'L6b'],
    [900, 'WM'],
    // Above the pia by as much as the flattening puts real somata: still in cortex.
    [-31, 'L1'],
    // Hundreds of µm above is voxels, or another volume — no layer rather than a plausible L1.
    [-300, undefined],
  ])('reads a depth of %s µm as %s', (depth, layer) => {
    expect(layerOf(MINNIE, depth)).toBe(layer)
  })

  it('is found from a Dataset value, whatever the materialization, and nowhere else', () => {
    expect(frameFor('cave', 'minnie65_public:943')).toBe(MINNIE)
    expect(frameFor('neuprint', 'minnie65_public:1822')).toBeUndefined()
    expect(frameFor('cave', 'flywire_fafb_public:783')).toBeUndefined()
  })
})

describe('every frame', () => {
  it.each(CORTICAL_FRAMES.map((frame) => [frame.dataset, frame] as const))(
    '%s starts at the pia, rises, and binds a dataset a family names',
    (_, frame) => {
      expect(frame.layers[0]!.top).toBe(0)
      for (let i = 1; i < frame.layers.length; i++) {
        expect(frame.layers[i]!.top, frame.layers[i]!.name).toBeGreaterThan(
          frame.layers[i - 1]!.top,
        )
      }
      expect(DATASET_FAMILIES.some((family) => family.family === frame.dataset)).toBe(true)
      // A frame places a cell by its soma, so a CAVE frame's datastack must declare its nuclei —
      // or the gallery fails only at run time.
      if (frame.scope === 'cave') {
        expect(specFor(DEFAULT_CAVE_SERVER, frame.dataset)?.nuclei, frame.dataset).toBeDefined()
      }
      // Every typing table named once, and the proofreading table among the ones read.
      expect(frame.cellTypes.length, frame.dataset).toBeGreaterThan(0)
      expect(new Set(frame.cellTypes.map((c) => c.table)).size).toBe(frame.cellTypes.length)
    },
  )
})
