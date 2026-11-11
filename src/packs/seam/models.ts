/**
 * The point affinity models this build knows how to fetch.
 *
 * **In the pack, not in `src/ml`.** `manifest.ts` and `docs/ml.md` both state the rule: the shared
 * half holds addressing and provenance and knows nothing about which pack draws on it. A table
 * keyed by task, naming one lab's checkpoints, is the pack's own knowledge — and `src/ml` already
 * refuses a manifest whose `task` differs from the one a caller asked for, so the check happens
 * here and nothing in the shared half needs a task vocabulary at all.
 *
 * A second affinity checkpoint — a retrained one, a smaller one — is a row here. A second *task*
 * is another pack with its own list, and if a third ever wants one, `packs.md` describes the
 * file-found seam to promote this into. Not before.
 *
 * **No size is declared here.** The obvious field to add is "how big is the download", for the
 * question asked before one starts — and that is exactly the number that must not be a hand-kept
 * copy: a reconverted checkpoint changes `ModelFile.bytes` in the manifest and leaves the
 * declaration stale, so the reader approves one number and fetches another. The manifest is small
 * JSON; fetch it and sum the chosen variant.
 */

/**
 * One row of a list by its id, or undefined — a saved graph may name an id this build no longer
 * carries, and that is an ordinary thing rather than an error.
 *
 * One function for four lists: each `*Model` lookup below was the same `find`, and a fifth task
 * would have written it again. Module-private, so the four named lookups stay the only way in —
 * a caller reaching for this would be choosing its own list, which is the thing those four
 * exist to decide.
 */
function modelById(models: readonly AffinityModel[], id: string): AffinityModel | undefined {
  return models.find((model) => model.id === id)
}

/** What a reader picks between, before any network. */
export interface AffinityModel {
  readonly id: string
  /** The `Model` param's row. */
  readonly label: string
  readonly manifestUrl: string
  /** One sentence: what it is and what it was trained on. Shown under the param. */
  readonly detail: string
}

/** Every point affinity model's `task`, checked against the manifest's own on open. */
export const AFFINITY_TASK = 'point-affinity'

export const AFFINITY_MODELS: readonly AffinityModel[] = [
  {
    id: 'affinity-flywire',
    label: 'Point affinity (FlyWire)',
    // A lab host, deliberately: these weights are not on a CDN and the URL is the deployment
    // fact, so it lives beside the model it addresses rather than in a shared constants file.
    manifestUrl:
      'https://flyemdev.mrc-lmb.cam.ac.uk/flyconnectome/coda/models/affinity-flywire-mixed/manifest.json',
    detail:
      'Troidl et al.’s point affinity transformer, trained on FlyWire optic-lobe neurons. ' +
      'Predicts whether two points of a segment belong to the same neuron.',
  },
]

/** One model by id, or undefined — a saved graph may name an id this build no longer carries. */
export function affinityModel(id: string): AffinityModel | undefined {
  return modelById(AFFINITY_MODELS, id)
}

/**
 * Every merge-window model's `task`. A different task from the affinity one, and deliberately:
 * the two answer different questions from different inputs, so a URL pointing at the wrong one
 * is refused by `src/ml` with a sentence rather than cast to a config it is not.
 */
export const MERGE_WINDOW_TASK = 'merge-window'

/**
 * The models that score a window for a false merge.
 *
 * The same shape as `AffinityModel` and deliberately not the same list: a node's `Model` param
 * offers the models whose task it can read, and mixing the two would put a checkpoint in a
 * picker whose node cannot run it.
 */
export const MERGE_WINDOW_MODELS: readonly AffinityModel[] = [
  {
    id: 'A_d256_e80',
    label: 'SEAM Model A (FlyWire)',
    manifestUrl:
      'https://flyemdev.mrc-lmb.cam.ac.uk/flyconnectome/coda/models/seam-a-d256-e80/manifest.json',
    detail:
      'Trained on real FlyWire merges from the v783 edit history. Scores a 15 µm window of a ' +
      'neuron’s surface for whether it contains a false merge, and says which points fall on ' +
      'either side of it.',
  },
]

/** One merge-window model by id, or undefined. */
export function mergeWindowModel(id: string): AffinityModel | undefined {
  return modelById(MERGE_WINDOW_MODELS, id)
}

/**
 * Every open-end model's `task`, checked against the manifest's own on open.
 *
 * A third task, not a variant of the merge one. Model A and Model E are the *same* `SeamModel`
 * class on the same inputs and differ only in what they were trained to answer — which is
 * exactly why they need separate tasks: a manifest pointing at the other one would load, run and
 * return perfectly shaped numbers about a different question. `src/ml` refuses the mismatch with
 * a sentence; nothing downstream could.
 */
export const OPEN_END_TASK = 'open-ends'

/**
 * The models that score a surface for open ends — stage 3 of SEAM's merge-candidate pipeline.
 *
 * The pipeline reads **`point_logits`** from these and ignores `window_logit`, which is trained
 * but unused: the open-end answer is per point, not per window.
 */
export const OPEN_END_MODELS: readonly AffinityModel[] = [
  {
    id: 'E_oe3_all_s0',
    label: 'SEAM Model E (FlyWire)',
    manifestUrl:
      'https://flyemdev.mrc-lmb.cam.ac.uk/flyconnectome/coda/models/seam-e-oe3-all-s0/manifest.json',
    detail:
      'Trained on real FlyWire open ends from the v783 edit history, and run zero-shot on other ' +
      'datasets. Scores every point of a 15 µm window of a neuron’s surface for whether it sits ' +
      'at a place the reconstruction stops short.',
  },
]

/** One open-end model by id, or undefined. */
export function openEndModel(id: string): AffinityModel | undefined {
  return modelById(OPEN_END_MODELS, id)
}

/**
 * Every mask assessor's `task` — the fourth, and a fourth for the reason the third was one: a
 * manifest pointing at another of them would load, run and hand back perfectly shaped numbers
 * about a different question. `src/ml` refuses the mismatch with a sentence.
 */
export const MERGE_ASSESSOR_TASK = 'merge-assessor'

/**
 * The checkpoints that judge whether a candidate piece continues the neuron — stage 6 of SEAM's
 * merge-candidate pipeline, one row per seed.
 *
 * **One row per seed, not one model with three parts.** `parts` means graphs that must all run,
 * in order; the seeds are an ensemble, three independent answers to the same question. SEAM's
 * published fits average them, so a single seed is not the pipeline SEAM calibrated — see
 * `docs/seam-suggestions-plan.md`. Seed 0 alone is what this build offers, deliberately: a
 * third of the work, for an answer the refit will say how to read.
 */
export const MERGE_ASSESSOR_MODELS: readonly AffinityModel[] = [
  {
    id: 'sa2_mask_s0',
    label: 'SEAM mask assessor, seed 0 (Aedes)',
    manifestUrl:
      'https://flyemdev.mrc-lmb.cam.ac.uk/flyconnectome/coda/models/seam-sa2-mask-s0/manifest.json',
    detail:
      'Judges whether a candidate piece continues the neuron, from a 4 µm window of the ' +
      'segmentation around the place they touch. Trained on the Aedes reconstruction’s own ' +
      'edit history.',
  },
]

/** One assessor by id, or undefined. */
export function mergeAssessorModel(id: string): AffinityModel | undefined {
  return modelById(MERGE_ASSESSOR_MODELS, id)
}
