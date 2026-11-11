/**
 * The mask assessor: which checkpoints this build can fetch, and what their `config` says.
 *
 * Stage 6's second half. The patches are cut by `src/pyodide/assessorPatches.ts`; this is the
 * model that scores them — "does candidate C continue neuron Q", one logit per patch.
 *
 * ## `config` is parsed here because `src/ml` refuses to
 *
 * `docs/ml.md` states the split: the shared half carries addressing and provenance and knows
 * nothing about any task's vocabulary, and `config` is an opaque blob the converter copies and
 * the owning pack reads. So the parsing, and every sentence about what is wrong with it, is
 * this file's. The blob itself is **SEAM's own manifest text, copied** by
 * `scripts/make-assessor-manifest.py` — the patch contract a browser cuts against and the one
 * the checkpoint was trained on are one piece of text rather than two that can drift.
 *
 * ## Why the geometry is checked rather than read
 *
 * `patchBox.ts` has to know the patch's size and resolution *before* a manifest is fetched —
 * it sizes the volume read, which happens first. So the numbers are declared there, held to the
 * vendored Python by `patchBox.test.ts`, and checked against the manifest here. Three places,
 * one of them a test and one a refusal, because the alternative is a browser cutting 129³ at
 * 32 nm for a network trained on something else: every patch a plausible patch, every logit a
 * plausible logit.
 */

import { PATCH_NM, PATCH_VOXELS } from './patchBox'

/**
 * The graph, and the one form of it worth fetching.
 *
 * `assess` is the only part — one network, one input, one output. The variant is `matmul`
 * because `src/ml` is WebGPU or nothing and that form is **8.4x** the convolution one there
 * (1,122 ms a patch against 133, `docs/seam-assessor-speed.md`). On a CPU the ranking reverses,
 * which is why SEAM exports both; it is not why Coda hosts both, and it does not.
 *
 * `ASSESSOR_VARIANT` is a **fixture pin, not a runtime choice**: production picks with
 * `preferredVariant` (`src/ml/support.ts`), which asks the browser what it can run. It is here
 * so the manifest test can name the variant it expects to find, and naming it twice at runtime
 * would be a second answer to "which build do we run".
 */
export const ASSESSOR_PART = 'assess'
export const ASSESSOR_VARIANT = 'matmul'

/** What the pack reads out of a `merge-assessor` manifest's `config`. */
export interface AssessorConfig {
  /** Which of SEAM's three checkpoints this is. */
  readonly seed: number
  /** The patch's extent in voxels, and the resolution it is cut at. Checked, not trusted. */
  readonly patchVoxels: number
  readonly patchNm: number
  /** How many patches one `run` takes. The matmul export pins this to 1. */
  readonly batch: number
  /**
   * The score a candidate takes when no patch could be cut for it.
   *
   * SEAM's per-seed constant — its lowest on the calibration list — and **not** something to
   * compute or to substitute with a minimum over whatever this run happened to score: a browser
   * does one tip at a time and has no batch to take a minimum over. A candidate scored at its
   * floor still ranks; one dropped silently ranks nowhere.
   */
  readonly missingPatchScore: number
  /** What one patch costs the GPU, for a caller pricing a tip before it starts. */
  readonly gflopPerPatch: number
}

export class AssessorConfigError extends Error {}

/**
 * One nested block, refused by name when it is absent.
 *
 * `(config['input'] ?? {})` reads more simply and is worse: a manifest with no `input` block
 * then reaches whichever field refusal happens to come first, and the reader is told a field is
 * missing from a block that is not there.
 *
 * **This is the fourth copy in the pack** — `windowConfig.ts`, `affinityConfig.ts` and
 * `suggestionSet.ts` each carry their own — and they have already diverged: only this one
 * refuses an *array*, which `typeof` happily calls an object. A shared `configFields.ts` taking
 * the error constructor is the right move, and it is not done here because the three differ in
 * the sentences they refuse with and those sentences are pinned by their own tests; unifying
 * them is a change to three working features rather than a cleanup of this one. Recorded in
 * `docs/seam-suggestions-plan.md`. Whoever does it should keep **this** array check, not theirs.
 */
function blockAt(
  blob: Record<string, unknown>,
  key: string,
  at = 'config',
): Record<string, unknown> {
  const value = blob[key]
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AssessorConfigError(
      `The assessor manifest has no \`${key}\` block (${at}.${key}).`,
    )
  }
  return value as Record<string, unknown>
}

/*
 * `at` is the path the field is actually at, not just its key. Built from the key alone, a
 * missing `config.input.patch.voxels` reads as `(config.voxels)` — which sends the reader to
 * the top of the blob to look for something that was never there, the same misdirection
 * `blockAt` above exists to avoid.
 */
function numberAt(
  blob: Record<string, unknown>,
  key: string,
  what: string,
  at = 'config',
): number {
  const value = blob[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AssessorConfigError(`The assessor manifest does not say ${what} (${at}.${key}).`)
  }
  return value
}

/**
 * Read a `merge-assessor` manifest's config, refusing anything this build cannot score with.
 *
 * Every refusal names what would go wrong rather than what is missing, because all of these
 * produce a *working* run otherwise: a patch of the wrong size is refused by onnxruntime, which
 * is loud, but a patch of the right size at the wrong resolution is a different 4 µm of the
 * volume and nothing downstream can tell.
 */
export function parseAssessorConfig(blob: unknown, modelId: string): AssessorConfig {
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) {
    throw new AssessorConfigError(`${modelId} carries no assessor config.`)
  }
  const config = blob as Record<string, unknown>
  const patch = blockAt(blockAt(config, 'input'), 'patch', 'config.input')

  const where = 'config.input.patch'
  const patchVoxels = numberAt(patch, 'voxels', 'how big a patch is', where)
  const patchNm = numberAt(patch, 'nm', 'what resolution a patch is cut at', where)
  if (patchVoxels !== PATCH_VOXELS || patchNm !== PATCH_NM) {
    throw new AssessorConfigError(
      `${modelId} was trained on ${patchVoxels}³ patches at ${patchNm} nm, and this build ` +
        `cuts ${PATCH_VOXELS}³ at ${PATCH_NM} nm. The patches would be a different piece of the ` +
        'volume, and every score would still look like a score.',
    )
  }

  const batch = numberAt(config, 'batch', 'how many patches it takes at once')
  if (batch !== 1) {
    throw new AssessorConfigError(
      `${modelId} takes ${batch} patches at once, and this build feeds one. ` +
        'A graph with a free batch axis is fine; one pinned above 1 is not.',
    )
  }

  return {
    seed: numberAt(config, 'seed', 'which checkpoint it is'),
    patchVoxels,
    patchNm,
    batch,
    missingPatchScore: numberAt(
      config,
      'missingPatchScore',
      'what a candidate scores when its patch cannot be cut',
    ),
    gflopPerPatch: numberAt(config, 'gflopPerPatch', 'what a patch costs'),
  }
}
