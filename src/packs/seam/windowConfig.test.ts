/**
 * What a merge-window model says about itself, and what this build refuses rather than
 * approximates.
 *
 * The refusals are the point. A window built at the wrong radius or scale still scores, and the
 * score still looks like a score — so a substitution here is a confidently wrong answer nothing
 * downstream can detect, which is why `parseWindowConfig` is the only place `config` is read.
 */

import { describe, expect, it } from 'vitest'

import { MESH_SURFACE_SAMPLER, WindowConfigError, parseWindowConfig } from './windowConfig'

const config = (over: Record<string, unknown> = {}) => ({
  preprocessing: {
    sampler: MESH_SURFACE_SAMPLER,
    units: 'um',
    scaleUm: 50.2864,
    windowRadiusUm: 15,
    spacingUm: 0.2,
    nPoints: 4096,
    features: 'normals',
    minPerPart: 16,
    ...over,
  },
  heads: { window: 'p(false merge)', point: 'bipartition' },
  calibration: null,
  validation: { auc: 0.94 },
})

describe('parseWindowConfig', () => {
  it('reads the preprocessing a window is built from', () => {
    const got = parseWindowConfig(config(), 'A_d256_e80')
    expect(got.preprocessing.windowRadiusUm).toBe(15)
    expect(got.preprocessing.scaleUm).toBeCloseTo(50.2864)
    expect(got.preprocessing.nPoints).toBe(4096)
  })

  it('keeps calibration as null rather than inventing one', () => {
    expect(parseWindowConfig(config(), 'A_d256_e80').calibration).toBeNull()
  })

  it('names the model in every message, since two can be open at once', () => {
    expect(() => parseWindowConfig(config({ sampler: 'voxels' }), 'A_d256_e80')).toThrow(
      /A_d256_e80/,
    )
  })

  it('refuses a sampler this build does not implement', () => {
    expect(() => parseWindowConfig(config({ sampler: 'skeleton-nodes' }), 'm')).toThrow(
      WindowConfigError,
    )
  })

  it('refuses units it cannot prepare', () => {
    expect(() => parseWindowConfig(config({ units: 'nm' }), 'm')).toThrow(/micrometres/)
  })

  it('refuses a feature set it cannot build', () => {
    expect(() => parseWindowConfig(config({ features: 'curvature' }), 'm')).toThrow(/curvature/)
  })

  /**
   * Zero passes every finite check and then divides every coordinate by nothing, or tiles a
   * neuron into no windows at all. Both would be answered confidently.
   */
  it.each(['scaleUm', 'windowRadiusUm', 'spacingUm', 'nPoints', 'minPerPart'])(
    'refuses a %s of zero as firmly as a missing one',
    (key) => {
      expect(() => parseWindowConfig(config({ [key]: 0 }), 'm')).toThrow(/above zero/)
      expect(() => parseWindowConfig(config({ [key]: undefined }), 'm')).toThrow(/above zero/)
    },
  )

  it('says which block is missing rather than throwing a TypeError', () => {
    expect(() => parseWindowConfig({}, 'm')).toThrow(/preprocessing block/)
    expect(() => parseWindowConfig(null, 'm')).toThrow(/preprocessing block/)
  })
})
