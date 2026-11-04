import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { parseAffinityConfig } from './affinityConfig'

/** The real checkpoint table, so the parse is checked against what a converter actually writes. */
const checkpoints = JSON.parse(readFileSync('scripts/affinity-checkpoints.json', 'utf8')) as {
  checkpoints: Record<string, { config: unknown }>
}
const real = checkpoints.checkpoints['affinity-flywire']!.config

interface Mutable {
  preprocessing: { units: string; centre: string; globalScale?: number }
  clustering: { linkage: string }
}
/** A deep copy, so one test's edit cannot reach another's. */
const config = () => JSON.parse(JSON.stringify(real)) as Mutable

describe('parseAffinityConfig', () => {
  it('reads the shipped checkpoint’s config', () => {
    const got = parseAffinityConfig(real, 'affinity-flywire')
    expect(got.preprocessing.globalScale).toBeCloseTo(659.88367, 5)
    expect(got.preprocessing.samplesPerNeuron).toBe(1024)
    expect(got.clustering.threshold).toBe(0.8)
    expect(got.clustering.minClusterSize).toBe(30)
  })

  /**
   * The refusals matter more than the reads. A manifest asking for something this build does not
   * do must say so: running ward's merges through average linkage answers confidently and wrongly,
   * and nothing downstream can tell.
   */
  /**
   * The sampler is the one preprocessing fact `pointCloud.ts` implements, and exactly what a
   * retrain on real merges would change. Unchecked it is a confidently wrong answer with no
   * error anywhere.
   */
  it('refuses a sampler it does not implement', () => {
    const broken = config() as unknown as { preprocessing: { sampler: string } }
    broken.preprocessing.sampler = 'farthest-point'
    expect(() => parseAffinityConfig(broken, 'retrained')).toThrow(
      /draws its points by farthest-point/,
    )
  })

  /** A manifest written before the field existed is read as the sampler those checkpoints used. */
  it('reads a missing sampler as the one the shipped checkpoints used', () => {
    const older = config() as unknown as { preprocessing: { sampler?: string } }
    delete older.preprocessing.sampler
    expect(parseAffinityConfig(older, 'older').preprocessing.sampler).toBe(
      'uniform-nodes-with-replacement',
    )
  })

  it('refuses a linkage it does not implement', () => {
    const broken = config()
    broken.clustering.linkage = 'ward'
    expect(() => parseAffinityConfig(broken, 'retrained')).toThrow(
      /retrained clusters with ward/,
    )
  })

  it('refuses units it cannot prepare', () => {
    const broken = config()
    broken.preprocessing.units = 'nm'
    expect(() => parseAffinityConfig(broken, 'retrained')).toThrow(/expects its points in nm/)
  })

  it('refuses a centring it does not do', () => {
    const broken = config()
    broken.preprocessing.centre = 'soma'
    expect(() => parseAffinityConfig(broken, 'retrained')).toThrow(/centres its points on soma/)
  })

  it('names the missing block rather than throwing a TypeError', () => {
    expect(() => parseAffinityConfig({}, 'empty')).toThrow(/has no preprocessing block/)
    expect(() => parseAffinityConfig(null, 'nothing')).toThrow(/has no preprocessing block/)
    expect(() => parseAffinityConfig({ preprocessing: {} }, 'partial')).toThrow(
      /has no clustering block/,
    )
  })

  it('names a missing number rather than reading NaN', () => {
    const broken = config()
    delete broken.preprocessing.globalScale
    expect(() => parseAffinityConfig(broken, 'retrained')).toThrow(/no numeric globalScale/)
  })
})
