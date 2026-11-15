/**
 * The ranker manifest: what `pnpm make:ranker-manifest` writes, read back.
 *
 * The fixture is that script's own output for the published Aedes forest, so this is the one
 * check that the generator and the reader agree — and that `src/ml` accepts what the generator
 * produces, which is a separate question from whether the pack can read its `config`.
 *
 * Opening the model itself is not here: it fetches, and the forest it parses is already checked
 * tree for tree against LightGBM's own predictions (`treeRanker.test.ts`) and end to end against
 * SEAM's published ranks (`pnpm probe:candidate-search`).
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import type { ModelManifest } from '../../ml/manifest'
import { checkManifest, completeVariants } from '../../ml/manifest'
import { MERGE_RANKER_TASK } from './models'
import { VENDORED_POOL_MAX_DIST_UM, parseRankerConfig } from './rankerConfig'

/*
 * Cast, because that is what a manifest off a server is: `checkManifest` is typed for the shape
 * it returns and is defensive about what it is handed, which is the gate being tested here.
 */
const RAW = JSON.parse(
  readFileSync('src/packs/seam/__fixtures__/rankerManifest.json', 'utf8'),
) as ModelManifest

describe('the generated manifest', () => {
  /** `src/ml`'s own gate: schema, parts, a signature per part, every file's size, a variant. */
  it('is a manifest this build will open', () => {
    expect(() => checkManifest(structuredClone(RAW))).not.toThrow()
    expect(RAW.task).toBe(MERGE_RANKER_TASK)
  })

  /**
   * One variant, because a text file has no quantisation to choose between — `openTreeRanker`
   * refuses a manifest offering several, having nothing to pick by.
   */
  it('offers exactly one variant carrying the forest', () => {
    expect(completeVariants(checkManifest(structuredClone(RAW)))).toEqual(['text'])
  })

  /**
   * The point of moving the pipeline into Coda: the numbers and the weights are one version.
   * These are SEAM's own, taken from the set that fitted the forest rather than transcribed.
   */
  it('carries the whole pipeline, as the search reads it', () => {
    const config = parseRankerConfig(RAW.config, 'trees_sizes_tip')
    expect(config.halfWidthUm).toBe(3)
    expect(config.xyNm).toBe(64)
    expect(config.poolMaxDistUm).toBe(0.5)
    expect(config.topK).toBe(100)
    expect(config.ownUm).toBe(2)
  })

  /**
   * The eleven, **in order**. Nothing downstream can check this — LightGBM wrote the forest's
   * own names as `Column_0 … Column_10` — so the generator reads them out of the set that fitted
   * it and this pins what arrived. A reordering here is a silently different ranking.
   */
  it('names the features in the order the forest numbers its columns', () => {
    expect(parseRankerConfig(RAW.config, 'x').features).toEqual([
      'min_dist_um',
      'touching',
      'log_vol',
      'has_shape',
      'align',
      'caliber_ratio',
      'elongation',
      'ahead',
      'l2c',
      'l2x',
      'end_dist_um',
    ])
  })

  /**
   * The forest's own column count against the list's, which `make-ranker-manifest.mjs` checks
   * when it writes the pair. Repeated here against the vendored dump, because the generator runs
   * once by hand and this runs on every commit.
   */
  it('names as many features as the forest reads', () => {
    const dump = readFileSync('src/packs/seam/__fixtures__/rankerModel.txt', 'utf8')
    const maxIdx = /^max_feature_idx=(\d+)/m.exec(dump)
    expect(maxIdx).toBeTruthy()
    expect(Number(maxIdx![1]) + 1).toBe(parseRankerConfig(RAW.config, 'x').features.length)
  })
})

describe('the config a manifest carries', () => {
  it.each([
    ['cutout_half_width_um', /cutout_half_width_um/],
    ['top_k', /top_k/],
    ['own_um', /own_um/],
  ])('refuses a config with no `%s`', (field, named) => {
    const config: Record<string, unknown> = {
      features: ['min_dist_um'],
      cutout_half_width_um: 3,
      cutout_xy_nm: 64,
      pool_max_dist_um: 0.5,
      top_k: 100,
      own_um: 2,
    }
    delete config[field]
    expect(() => parseRankerConfig(config, 'trees_sizes_tip')).toThrow(named)
  })

  /**
   * The one thing nothing else can state: LightGBM wrote the model's own feature names as
   * `Column_0 … Column_10`, so a list in the wrong order would score every candidate against
   * the wrong eleven numbers and still rank.
   */
  it('refuses a config with no feature order', () => {
    expect(() => parseRankerConfig({ cutout_half_width_um: 3 }, 'x')).toThrow(/features/)
  })
})

describe('the pool radius', () => {
  /**
   * SEAM applies it as a module constant on the far side of the bridge, so Coda's copy is a
   * declaration and this is what keeps it honest — `patchBox.test.ts`' bargain, for the same
   * reason: a hand-kept copy of a vendored number with nothing checking it is the trade neither
   * file made. The node refuses a set whose manifest states a different radius, because the
   * vendored code would search this one and say nothing.
   */
  it('is the one the vendored `candidates.py` applies', () => {
    const source = readFileSync(
      new URL('../../pyodide/seam/candidates.py', import.meta.url),
      'utf8',
    )
    const found = /^POOL_MAX_DIST_UM = ([0-9.]+)/m.exec(source)
    expect(
      found,
      'POOL_MAX_DIST_UM is no longer a module-level constant of candidates.py',
    ).toBeTruthy()
    expect(Number(found![1])).toBe(VENDORED_POOL_MAX_DIST_UM)
  })
})
