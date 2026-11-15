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

import { GPU_ASSESSOR_VARIANT, openGpuAssessor } from './gpuAssessor/open'
import type { SeamRuntime } from './openWindowModel'
import { PATCH_NM, PATCH_VOXELS } from './patchBox'
import type { PipelineFits } from './pipelineFits'
import { pipelineFitsFrom } from './pipelineFits'

/**
 * The graph, and the two builds of it — one per runtime, not one per quantisation.
 *
 * `assess` is the only part: one network, one input, one output. What the manifest carries twice
 * is the *same weights* in two shapes, because two runtimes read them differently:
 *
 * - **`conv`**, the plain export, is what Coda runs. `gpuAssessor/` implements the architecture
 *   in WGSL and reads this file: **26.5 ms a patch** (`docs/seam-assessor-speed.md` §14).
 * - **`matmul`** is the same weights cut into per-offset pieces so ONNX Runtime can avoid its
 *   own 3D `Conv`, whose WebGPU backend is a per-element shader. 136 ms a patch, and
 *   `segclrPlan.ts` refuses it rather than reassemble it. **It is not a fallback** — nothing in
 *   `src/` opens it, and a run whose WGSL path refuses says so rather than quietly taking five
 *   times as long. It is published because `pnpm probe:gpu-assessor` measures the pair, and
 *   because a reader comparing against SEAM's own numbers needs the graph SEAM timed.
 *
 * **Neither is chosen by `preferredVariant`**, and that is the trap worth naming: it takes the
 * smallest runnable variant, the two files are 0.2 MB apart, so left to it ONNX Runtime would
 * silently move to the graph it is eight times slower on. Every opening site names its build.
 * `ORT_ASSESSOR_VARIANT` is read only by the manifest test, which holds each build's `emits` to
 * the runtime that reads it — the one place the two files are told apart before 133 MB is
 * fetched. The one Coda opens with is `GPU_ASSESSOR_VARIANT`, beside the runtime that reads it.
 */
export const ASSESSOR_PART = 'assess'
export const ORT_ASSESSOR_VARIANT = 'matmul'

/**
 * The runtime Coda opens the assessor with, and the build it reads — **one object**.
 *
 * Paired here rather than named twice at the call site, because the two halves have to agree:
 * `openSeamModel` prices the variant for the download-consent sentence and the opener fetches
 * it, so two fields side by side could ask a reader to approve one 133 MB file and then fetch
 * the other.
 */
export const ASSESSOR_RUNTIME: SeamRuntime = {
  variant: GPU_ASSESSOR_VARIANT,
  open: openGpuAssessor,
}

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
  /**
   * The stages after this one, as the configuration this checkpoint belongs to fitted them.
   *
   * **Carried with the weights, for the reason the ranker's constants are** (`rankerConfig.ts`):
   * ref's three weights, `p_tip`'s three, the cutoff and the `r` staircase were refitted *for*
   * one assessor in one configuration — one seed, masks only, no split — and SEAM says so in as
   * many words ("These weights are new… This cutoff is new too"). A build that scored this
   * checkpoint against production's three-seed fits would publish a probability for every tip and
   * the right one for none.
   *
   * It is also what makes the search node self-contained. The numbers used to come from whichever
   * published suggestion set the reader happened to point at, which made Coda's pipeline a
   * property of somebody else's run.
   */
  readonly fits: PipelineFits
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
    fits: assessorFits(config, modelId),
  }
}

/**
 * The configuration's own stages 7–9, and the two things that would otherwise run anyway.
 *
 * `pipelineFitsFrom` reads the block — the same reader a published set goes through, because it
 * is the same block (`pipelineFits.ts`). What is asked **here** is whether this build can run
 * what it describes, and both refusals are for shapes that would otherwise produce numbers:
 *
 * - **More than one seed.** An ensemble is several checkpoints, and a manifest is one. Fed one
 *   score column, `scoreList` refuses — but only after the box has been read and the patches cut,
 *   which is a tip's whole cost paid to learn something the manifest said on the first line.
 * - **A split block.** Split's head reads EM, which this route never fetches: `probe:scene-em`
 *   measured a window's EM at 14 MB and 14 seconds against a fraction of a second for the
 *   segmentation, and dropping it is most of why this configuration is the cheap one. A tip
 *   scored against a split configuration reaches `q_ref` and gets no verdict, so the review queue
 *   would show nothing at all and say nothing about why.
 */
function assessorFits(config: Record<string, unknown>, modelId: string): PipelineFits {
  if (config.pipeline === undefined) {
    throw new AssessorConfigError(
      `${modelId} carries no \`config.pipeline\`, so there is nothing to turn its logits into ` +
        'a ranking or a probability. Repackage it with `pnpm make:assessor-manifest`, which ' +
        'takes the block from the fixture of the configuration the checkpoint was fitted in.',
    )
  }
  const fits = pipelineFitsFrom(config.pipeline, modelId)
  if (fits.ref.length !== 1) {
    throw new AssessorConfigError(
      `${modelId}'s pipeline fits ${fits.ref.length} assessor seeds, and a manifest is one ` +
        'checkpoint. An ensemble is several models, so its fits belong to whichever of them a ' +
        'build can run all of — not to this one.',
    )
  }
  if (fits.split) {
    throw new AssessorConfigError(
      `${modelId}'s pipeline states a \`split\` block, whose head scores a window of EM. This ` +
        'route reads segmentation only, so every tip would reach `q_ref` and none would get a ' +
        'verdict. It needs the fits of a configuration without split.',
    )
  }
  return fits
}
