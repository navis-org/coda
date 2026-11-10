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
  return AFFINITY_MODELS.find((model) => model.id === id)
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
  return MERGE_WINDOW_MODELS.find((model) => model.id === id)
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
  return OPEN_END_MODELS.find((model) => model.id === id)
}
