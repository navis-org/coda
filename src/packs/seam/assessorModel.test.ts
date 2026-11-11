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
  ASSESSOR_VARIANT,
  AssessorConfigError,
  parseAssessorConfig,
} from './assessorModel'
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

  it('carries one variant with every part', () => {
    expect(completeVariants(RAW)).toEqual([ASSESSOR_VARIANT])
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
      ASSESSOR_VARIANT,
      ASSESSOR_PART,
    )
    expect(at).toBe('https://host/x/models/a/sa2_mask_mm_s0.onnx')
  })

  /* The figure a reader approves before 133 MB is fetched. */
  it('knows what it weighs', () => {
    expect(variantBytes(RAW, ASSESSOR_VARIANT)).toBeGreaterThan(130e6)
  })

  /*
   * What decides whether WebGPU can run it at all. `MatMulInteger` here would mean a graph the
   * backend declines, and the symptom is a session that never opens rather than a wrong answer
   * — but the manifest is where that is knowable before the download.
   */
  it('emits matmuls WebGPU takes', () => {
    const emits = RAW.files[0]?.quantisation.emits ?? []
    expect(emits).toContain('MatMul')
    expect(emits).not.toContain('MatMulInteger')
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
