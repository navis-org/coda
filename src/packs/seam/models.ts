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
  /**
   * Why it is no longer offered, where it is not: `EnumOption.retired`, so a card that holds it
   * loads and runs exactly as before and nothing new can pick it.
   */
  readonly retired?: string
}

/*
 * **No node offers the next two lists** (2026-11-26): Affinity Clusters and Find Split Candidates
 * were dropped before the pack's first release, because neither checkpoint worked on real merges
 * (`docs/seam-plan.md`, "Why both nodes are retired"). The models, their tasks and everything
 * that runs them are kept for a retrained checkpoint, and the probes still read them
 * (`probe:affinity-parity`, `probe:seam-merge`). In `knip-baseline.txt` for that reason.
 */

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
 * merge-candidate pipeline, one row per configuration.
 *
 * **One row per seed, not one model with three parts.** `parts` means graphs that must all run,
 * in order; the seeds are an ensemble, three independent answers to the same question.
 *
 * **And a seed alone is a configuration, not a cheaper production.** Production averages the
 * three and then applies a confidence model whose head reads EM; ref's weights, `p_tip`'s, the
 * cutoff and the `r` staircase were all fitted against that. SEAM refitted every one of them for
 * the single-seed, masks-only route (2026-11-15) and they ride in this manifest's `config`
 * (`assessorModel.ts`), so the weights and the numbers they are read with are one version. What
 * it costs against production, on SEAM's own calibration lists: first place unchanged (tiny 0.661
 * against 0.670, ordinary 0.816 against 0.816), about 15% fewer suggestions clearing the cutoff,
 * and precision where a proofreader judged unchanged. Two thirds of that loss is dropping split,
 * a third the single seed.
 *
 * Dropping split is also why this route reads **segmentation only**, which is what makes it the
 * cheap one in a browser: `probe:scene-em` measured a window's EM at ~14 MB and 14 s against a
 * fraction of a second for the segmentation of the same window.
 */
export const MERGE_ASSESSOR_MODELS: readonly AffinityModel[] = [
  /*
   * **Student 1 in seed 0's place** (SEAM's `coda-student1.md`, user, 2026-11-20): the same
   * network, trained to copy the averaged score of the three seeds rather than the plain yes/no
   * label, with ref, `p_tip`, the cutoff and `r` refitted for it. On a test set no fit had seen
   * (Aedes h2, 634 lists) more right first candidates clear the cutoff — tiny pieces 0.321
   * against 0.243, ordinary 0.697 against 0.657 — with first place unchanged; on real tips the
   * gain is small (rv2: 133 shown against 145, 31 right against 30 on the test neuron), and
   * precision at the cutoff on rv4 is 0.976.
   */
  {
    id: 'n3d_mal_mask_s1',
    label: 'SEAM mask assessor, student 1 (Aedes)',
    manifestUrl:
      'https://flyemdev.mrc-lmb.cam.ac.uk/flyconnectome/coda/models/seam-n3d-mal-mask-s1/manifest.json',
    detail:
      'Judges whether a candidate piece continues the neuron, from a 4 µm window of the ' +
      'segmentation around the place they touch. One network trained to copy the averaged score ' +
      'of SEAM’s three checkpoints, with the stages after it refitted for it — the cheapest ' +
      'configuration that reaches a calibrated answer.',
  },
  {
    id: 'n3_mal_mask_s0',
    label: 'SEAM mask assessor, one seed (Aedes)',
    manifestUrl:
      'https://flyemdev.mrc-lmb.cam.ac.uk/flyconnectome/coda/models/seam-n3-mal-mask-s0/manifest.json',
    detail:
      'Judges whether a candidate piece continues the neuron, from a 4 µm window of the ' +
      'segmentation around the place they touch. One of SEAM’s three checkpoints, with the ' +
      'stages after it refitted for running alone.',
    retired: 'replaced by student 1',
  },
]

/**
 * The assessor a new Find Merge Candidates card starts on: the first not retired. Derived rather
 * than named, so a refit that retires this one moves the default with it.
 */
export const CURRENT_ASSESSOR: string = MERGE_ASSESSOR_MODELS.find(
  (model) => model.retired === undefined,
)!.id

/** One assessor by id, or undefined. */
export function mergeAssessorModel(id: string): AffinityModel | undefined {
  return modelById(MERGE_ASSESSOR_MODELS, id)
}

/**
 * The `Assessor` value that runs none.
 *
 * Here rather than on the node because it is the one string that must never be a model id, and
 * this is the file that decides what the ids are. A row called `none` would otherwise be
 * unreachable, and nothing on the node could see why.
 */
export const NO_ASSESSOR = 'none'

/** The forest that ranks a candidate list — stage 5 of the merge-candidate pipeline. */
export const MERGE_RANKER_TASK = 'merge-ranker'

/**
 * The rankers that order an open end's candidate pool.
 *
 * **A model row rather than a suggestion set's manifest.** The node used to read the forest, the
 * box size, the pool radius and the feature order out of whichever published set it was pointed
 * at, which made the pipeline a property of somebody else's run. It is Coda's now: a row here
 * names a manifest, and the manifest carries the weights **and** the constants they were fitted
 * with (`rankerConfig.ts`), so the two can never be taken from different versions.
 *
 * It is not a GPU model and not tens of megabytes — a LightGBM forest is about 1.3 MB of text,
 * scored in TypeScript (`treeRanker.ts`). So it is opened by `openTreeRanker`, which shares the
 * manifest and the verified weight cache with the other four tasks but neither the WebGPU gate
 * nor the download consent: a megabyte fetched once and kept is not a thing to ask about.
 */
export const MERGE_RANKER_MODELS: readonly AffinityModel[] = [
  {
    id: 'trees_sizes_tip',
    label: 'SEAM geometric ranker (Aedes)',
    manifestUrl:
      'https://flyemdev.mrc-lmb.cam.ac.uk/flyconnectome/coda/models/seam-ranker-trees-sizes-tip/manifest.json',
    detail:
      'Orders the pieces of segmentation near an open end by how likely each is to be its ' +
      'continuation, from eleven geometric and size features. A LightGBM ranking forest ' +
      'fitted on the Aedes reconstruction’s own edit history.',
  },
]

/** One ranker by id, or undefined. */
export function mergeRankerModel(id: string): AffinityModel | undefined {
  return modelById(MERGE_RANKER_MODELS, id)
}
