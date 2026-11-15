/**
 * The assessor manifest, read by the code that will read it — against one the converter wrote.
 *
 * `__fixtures__/assessorManifest.json` is **the real output** of
 * `scripts/make-assessor-manifest.py` over SEAM's exported directory, with only the 133 MB graph
 * left behind. That is the point of it: a converter and a parser on two sides of an upload are
 * exactly the pair that drift, and neither repository's other tests can see it — a manifest that
 * loads and a config that parses to the wrong numbers both look like success.
 *
 * So this runs `src/ml`'s own `checkManifest` over it, not a hand-written imitation, and then
 * the pack's `parseAssessorConfig`. Re-run the converter and this fixture is what changes.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { checkManifest, completeVariants, fileUrl, variantBytes } from '../../ml/manifest'
import type { ModelManifest } from '../../ml/manifest'
import {
  ASSESSOR_PART,
  ORT_ASSESSOR_VARIANT,
  AssessorConfigError,
  parseAssessorConfig,
} from './assessorModel'
import { GPU_ASSESSOR_VARIANT } from './gpuAssessor/open'
import { MERGE_ASSESSOR_MODELS, MERGE_ASSESSOR_TASK, mergeAssessorModel } from './models'
import { PATCH_NM, PATCH_VOXELS } from './patchBox'

const RAW = JSON.parse(
  readFileSync(new URL('./__fixtures__/assessorManifest.json', import.meta.url), 'utf8'),
) as ModelManifest

/** A copy with one part of the config replaced, for the refusals. */
function withConfig(changes: Record<string, unknown>): ModelManifest {
  const config = RAW.config as Record<string, unknown>
  return { ...RAW, config: { ...config, ...changes } }
}

describe('the manifest the converter writes', () => {
  it('passes src/ml’s own check', () => {
    expect(() => checkManifest(RAW)).not.toThrow()
  })

  it('declares the task the pack asks for', () => {
    expect(RAW.task).toBe(MERGE_ASSESSOR_TASK)
  })

  /**
   * **Two complete variants, one part** — the same weights for two runtimes, not two
   * quantisations of one graph. A reader downloads exactly one of them; which one is named at
   * the opening site, never left to `preferredVariant`, because the two are 0.2 MB apart and it
   * takes the smaller.
   */
  it('carries both builds, each complete, for the one part', () => {
    expect(completeVariants(RAW).sort()).toEqual([GPU_ASSESSOR_VARIANT, ORT_ASSESSOR_VARIANT])
    expect(RAW.parts).toEqual([ASSESSOR_PART])
  })

  /*
   * The graph pins its batch axis to 1, so there is nothing free. Asserted because an empty
   * `dynamic` is easy to read as "the converter forgot" — it is the fact.
   */
  it('declares no dynamic axes', () => {
    expect(RAW.signatures[ASSESSOR_PART]?.dynamic).toEqual({})
  })

  it('resolves its file against wherever the manifest was fetched from', () => {
    const at = fileUrl(
      { manifest: RAW, url: 'https://host/x/models/a/manifest.json' },
      ORT_ASSESSOR_VARIANT,
      ASSESSOR_PART,
    )
    expect(at).toBe('https://host/x/models/a/n3_mal_mask_mm_s0.onnx')
  })

  /* The figure a reader approves before 133 MB is fetched. */
  it('knows what it weighs', () => {
    expect(variantBytes(RAW, GPU_ASSESSOR_VARIANT)).toBeGreaterThan(130e6)
    expect(variantBytes(RAW, ORT_ASSESSOR_VARIANT)).toBeGreaterThan(130e6)
  })

  /*
   * What decides whether WebGPU can run it at all. `MatMulInteger` here would mean a graph the
   * backend declines, and the symptom is a session that never opens rather than a wrong answer
   * — but the manifest is where that is knowable before the download.
   */
  /**
   * **Each build has to be the build it is listed as**, and `emits` is where that is knowable
   * before 133 MB is fetched. The two files are the same size and the same weights, so a swap
   * is not visible anywhere else: ONNX Runtime handed the plain export runs 3D `Conv` through a
   * per-element shader and is eight times slower in silence, and `segclrPlan.ts` handed the
   * matmul one refuses — loudly, but only after the download.
   */
  it('lists each build with the operators its runtime reads', () => {
    const fileOf = (variant: string) => RAW.files.find((one) => one.variant === variant)
    expect(fileOf(ORT_ASSESSOR_VARIANT)?.quantisation.emits).toContain('MatMul')
    expect(fileOf(GPU_ASSESSOR_VARIANT)?.quantisation.emits).not.toContain('MatMul')
    for (const file of RAW.files) {
      expect(file.quantisation.emits, file.variant).not.toContain('MatMulInteger')
    }
  })
})

describe('parseAssessorConfig', () => {
  it('reads what the pack needs', () => {
    const config = parseAssessorConfig(RAW.config, RAW.id)
    expect(config.seed).toBe(0)
    expect(config.batch).toBe(1)
    expect(config.patchVoxels).toBe(PATCH_VOXELS)
    expect(config.patchNm).toBe(PATCH_NM)
  })

  /*
   * SEAM's own per-seed constant, and a negative number. Pinned against the fixture rather than
   * against a literal: it is the checkpoint's lowest score on its calibration list, so a new
   * export moves it and the test should follow the manifest, not argue with it.
   */
  it('carries the score a candidate takes when no patch could be cut', () => {
    const config = parseAssessorConfig(RAW.config, RAW.id)
    const written = (RAW.config as { missingPatchScore: number }).missingPatchScore
    expect(config.missingPatchScore).toBe(written)
    expect(config.missingPatchScore).toBeLessThan(0)
  })

  it('prices a patch', () => {
    expect(parseAssessorConfig(RAW.config, RAW.id).gflopPerPatch).toBeGreaterThan(1)
  })

  /**
   * The half that moved here this round: the manifest carries the configuration this checkpoint
   * is scored in, not just the graph. These are SEAM's `single_seed` numbers, and they are
   * pinned against the fixture rather than against literals for the reason `missingPatchScore`
   * is — a refit moves them, and the test should follow the manifest rather than argue with it.
   */
  it('carries the stages the checkpoint was fitted with', () => {
    const { fits } = parseAssessorConfig(RAW.config, RAW.id)
    const written = (RAW.config as { pipeline: Record<string, Record<string, unknown>> })
      .pipeline
    expect(fits.ref).toHaveLength(1)
    expect(fits.ref[0]!.w).toEqual(written.ref!.w)
    expect(fits.scoreClip).toBe(written.ref!.score_clip)
    expect(fits.cutoff).toBe(written.show!.cutoff)
    expect(fits.pTip).toEqual(written.p_tip!.weights)
    expect(fits.steps.q).toHaveLength(fits.steps.r.length)
  })

  /**
   * **No split**, which is the whole reason this configuration is the cheap one — split's head
   * reads EM, and EM is the expensive read in a browser. `decideTip` reads the absence as "this
   * configuration's cutoff is about `q_ref`", so an accidental split block would silently leave
   * every tip undecided rather than refuse.
   */
  it('states no split, so the route reads segmentation only', () => {
    expect(parseAssessorConfig(RAW.config, RAW.id).fits.split).toBeUndefined()
  })

  it('refuses a manifest with no pipeline at all', () => {
    expect(() =>
      parseAssessorConfig(withConfig({ pipeline: undefined }).config, RAW.id),
    ).toThrow(/no `config.pipeline`/)
  })

  /**
   * An ensemble's fits on one checkpoint's manifest. `scoreList` would refuse it too — but only
   * after the box had been read and every patch cut, which is a tip's whole cost paid to learn
   * something the manifest said on its first line.
   */
  it('refuses fits for more seeds than a manifest can run', () => {
    const pipeline = (RAW.config as { pipeline: Record<string, unknown> }).pipeline
    const ref = pipeline.ref as Record<string, unknown>
    const changed = withConfig({
      pipeline: {
        ...pipeline,
        ref: {
          score_clip: ref.score_clip,
          seeds: [0, 1, 2].map((k) => ({ k, mu: ref.mu, sd: ref.sd, w: ref.w })),
        },
      },
    })
    expect(() => parseAssessorConfig(changed.config, RAW.id)).toThrow(/a manifest is one/)
  })

  it('refuses a pipeline whose confidence model reads EM', () => {
    const pipeline = (RAW.config as { pipeline: Record<string, unknown> }).pipeline
    const ref = pipeline.ref as Record<string, number[]>
    const fold = [{ k: 0, mu: [...ref.mu!, 0], sd: [...ref.sd!, 1], w: [...ref.w!, 0] }]
    const changed = withConfig({ pipeline: { ...pipeline, split: { folds: [fold] } } })
    expect(() => parseAssessorConfig(changed.config, RAW.id)).toThrow(/segmentation only/)
  })

  /*
   * The refusal that matters most: the same 129³ at a different resolution is a different piece
   * of the volume, and every logit from it would still look like a logit.
   */
  it('refuses a patch cut at another resolution', () => {
    const input = (RAW.config as { input: { patch: Record<string, unknown> } }).input
    const changed = withConfig({ input: { ...input, patch: { ...input.patch, nm: 16 } } })
    expect(() => parseAssessorConfig(changed.config, changed.id)).toThrow(AssessorConfigError)
    expect(() => parseAssessorConfig(changed.config, changed.id)).toThrow(
      /different piece of the volume/,
    )
  })

  it('refuses a patch of another size', () => {
    const input = (RAW.config as { input: { patch: Record<string, unknown> } }).input
    const changed = withConfig({ input: { ...input, patch: { ...input.patch, voxels: 65 } } })
    expect(() => parseAssessorConfig(changed.config, changed.id)).toThrow(AssessorConfigError)
  })

  it('refuses a batch pinned above one', () => {
    expect(() => parseAssessorConfig(withConfig({ batch: 8 }).config, RAW.id)).toThrow(
      /feeds one/,
    )
  })

  /*
   * By name, rather than by whichever field refusal happened to come first. Substituting an
   * empty object for a missing block tells the reader a field is absent from a block that is
   * not there — which sends them looking in the wrong place.
   */
  it('refuses a config with no input block, by name', () => {
    expect(() => parseAssessorConfig(withConfig({ input: null }).config, RAW.id)).toThrow(
      /no `input` block/,
    )
  })

  it('refuses a config with no patch block, by name', () => {
    expect(() =>
      parseAssessorConfig(withConfig({ input: { name: 'lab' } }).config, RAW.id),
    ).toThrow(/no `patch` block/)
  })

  it('refuses a manifest with no config at all', () => {
    expect(() => parseAssessorConfig(null, RAW.id)).toThrow(/no assessor config/)
  })

  it('refuses a config that is an array', () => {
    expect(() => parseAssessorConfig([], RAW.id)).toThrow(/no assessor config/)
  })
})

describe('the models this build offers', () => {
  it('finds seed 0 by the id the manifest declares', () => {
    expect(mergeAssessorModel(RAW.id)).toBeDefined()
    expect(MERGE_ASSESSOR_MODELS[0]?.id).toBe(RAW.id)
  })

  it('answers undefined for an id this build no longer carries', () => {
    expect(mergeAssessorModel('sa2_mask_s7')).toBeUndefined()
  })

  /* Every row is a manifest address, and a typo is a download that 404s at the worst moment. */
  it('names a manifest for every row', () => {
    for (const model of MERGE_ASSESSOR_MODELS) {
      expect(model.manifestUrl).toMatch(/^https:\/\/.+\/manifest\.json$/)
      expect(model.detail.length).toBeGreaterThan(40)
    }
  })
})
