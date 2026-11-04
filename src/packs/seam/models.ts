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
