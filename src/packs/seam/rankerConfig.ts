/**
 * What stages 4 and 5 are run with, and where it comes from.
 *
 * The box, the pool, the cut, the own-tip radius and the forest's **feature order** are one
 * decision: every number here was fixed when the forest was fitted, and a forest scored with any
 * other set of them is a plausible ranking of a different question. So they ride in the model
 * manifest's `config`, beside the weights, and are read back here.
 *
 * ## Why not in Coda, as constants
 *
 * Because of the feature order. `parseTreeRanker` refuses a model whose feature *count* is not
 * the list's, which catches a refit that adds a column — SEAM appended three on 2026-11-11 — but
 * the model file cannot check the order: LightGBM wrote its own names as `Column_0 … Column_10`.
 * A list declared in Coda is therefore a hand-kept copy that a reordering refit would silently
 * invalidate, with every candidate scored against the wrong eleven numbers and still ranked.
 * Carried with the weights, the two versions move together or not at all.
 *
 * ## Why not in the suggestion set, as it was
 *
 * That made Coda's pipeline a property of whichever published run the reader happened to point
 * at, and tied a node that *computes* an answer to a node that *reads* one. `docs/ml.md`'s seam
 * is the right one: `src/ml` owns addressing and provenance and hands `config` over opaque; the
 * pack says what is in it.
 *
 * ## Nothing has a default
 *
 * Every refusal below names the field, because a plausible fallback does not fail — a box half
 * the size still ranks, a pool twice as wide still ranks, a `top_k` of 50 still ranks. A
 * manifest that does not state one is a manifest this build cannot search with, and says so.
 *
 * ## The manifest to publish
 *
 * `pnpm make:ranker-manifest` writes it from a `model.txt` and SEAM's own pipeline block, so the
 * hashes, the sizes and the feature order are taken rather than typed. In outline:
 *
 * ```json
 * {
 *   "id": "trees_sizes_tip", "manifestSchema": 2, "task": "merge-ranker",
 *   "parts": ["ranker"], "datasets": ["aedes_h1"],
 *   "signatures": { "ranker": { "inputs": ["features"], "outputs": ["geo_score"] } },
 *   "config": {
 *     "features": ["min_dist_um", "touching", … ],
 *     "cutout_half_width_um": 3, "cutout_xy_nm": 64,
 *     "pool_max_dist_um": 0.5, "top_k": 100, "own_um": 2.0
 *   },
 *   "files": [{ "variant": "text", "part": "ranker", "file": "model.txt", … }]
 * }
 * ```
 */

import { completeVariants } from '../../ml/manifest'
import { loadSeamManifest } from './openWindowModel'
import { loadWeights } from '../../ml/weights'
import type { AffinityModel } from './models'
import { MERGE_RANKER_TASK } from './models'
import type { TreeRanker } from './treeRanker'
import { treeRankerFor } from './treeRanker'

/** The one part a ranker manifest declares. */
const PART = 'ranker'

/**
 * The pool radius the **vendored** `candidates.py` applies, in µm — its `POOL_MAX_DIST_UM`.
 *
 * SEAM's pool is "every object within `pool_max_dist_um` of Q", and that number is a module
 * constant on the far side of the bridge, not a parameter of the call. So the manifest's copy of
 * it is read and *checked* rather than passed: a model refitted with a wider pool would otherwise
 * be searched with this one, and the only sign would be lists that are slightly short.
 *
 * The bargain `patchBox.ts` and `ownTip.ts` make — declare it, and hold the declaration to the
 * vendored Python in a test (`rankerConfig.test.ts`), because a hand-kept copy with nothing
 * checking it is the trade none of the three made. It is checked **here** rather than on the
 * node, for the reason `assessorModel.ts` gives about the geometry it checks: the model module is
 * what knows both halves, and this way a model this build cannot search with costs no download.
 */
export const VENDORED_POOL_MAX_DIST_UM = 0.5

/** What the search is run with — the manifest's `config`, read. */
export interface RankerConfig {
  /** Half the cutout's edge, in µm. SEAM's is 3, so a 6 µm box. */
  readonly halfWidthUm: number
  /** The resolution to ask the volume for, in nm. `scaleNear` takes the nearest it has. */
  readonly xyNm: number
  /** How near an object must come to the neuron to be in the pool at all, in µm. */
  readonly poolMaxDistUm: number
  /** How many of the ranked pool are kept. SEAM keeps 100. */
  readonly topK: number
  /** How near another of the neuron's own ends sends a candidate away, in µm. */
  readonly ownUm: number
  /** The features, **in the order the forest numbers its columns**. See the header. */
  readonly features: readonly string[]
}

export function parseRankerConfig(config: unknown, modelId: string): RankerConfig {
  const block = asRecord(config, modelId)
  const features = block.features
  if (
    !Array.isArray(features) ||
    features.length === 0 ||
    features.some((name) => !name || typeof name !== 'string')
  ) {
    throw new Error(
      `${modelId}'s config has no \`features\` list. It is the order the forest numbers its ` +
        'columns in, and nothing else can state it — the model file calls them `Column_0` up.',
    )
  }
  return {
    halfWidthUm: asNumber(block.cutout_half_width_um, 'cutout_half_width_um', modelId),
    xyNm: asNumber(block.cutout_xy_nm, 'cutout_xy_nm', modelId),
    poolMaxDistUm: asNumber(block.pool_max_dist_um, 'pool_max_dist_um', modelId),
    topK: asNumber(block.top_k, 'top_k', modelId),
    ownUm: asNumber(block.own_um, 'own_um', modelId),
    features: features as string[],
  }
}

function asRecord(value: unknown, modelId: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `${modelId} publishes no \`config\`, so there is no pipeline to search with.`,
    )
  }
  return value as Record<string, unknown>
}

function asNumber(value: unknown, field: string, modelId: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(
      `${modelId}'s config has no \`${field}\`. Every number the search is run with is read, ` +
        'never assumed: a plausible default would search a different box and still rank.',
    )
  }
  return value
}

/**
 * The forest and the pipeline it was fitted with.
 *
 * **No GPU gate and no download consent**, unlike `openSeamModel`. The forest is scored in
 * TypeScript, so a browser without WebGPU runs it perfectly well, and 1.3 MB fetched once and
 * kept is not a thing to stop and ask about — the consent rule exists for the assessors' tens of
 * megabytes. Everything else is shared: the manifest, the task check and the verified,
 * deduplicated weight cache.
 *
 * The config is parsed **before** the weights are fetched, as `openSeamModel` does and for the
 * same reason: a manifest this build cannot read should cost nothing. `refusePoolRadius` runs
 * there too, so a model whose pool this build cannot reproduce costs no download either.
 *
 * It reports a **raw** fraction and lets the caller scale it, where `openSeamModel` takes a
 * `downloadShare` and scales inside. Deliberate: that one owns the whole of its share because an
 * ONNX session opens inside it, and this returns as soon as 1.3 MB of text has arrived.
 */
export async function openTreeRanker(
  model: AffinityModel,
  options: { signal?: AbortSignal; progress?: (fraction: number, note?: string) => void } = {},
): Promise<{ ranker: TreeRanker; config: RankerConfig }> {
  options.progress?.(0, 'reading the ranker')
  const { loaded, config } = await loadSeamManifest({
    model,
    task: MERGE_RANKER_TASK,
    parse: parseRankerConfig,
    signal: options.signal,
  })
  refusePoolRadius(config, model.label)
  /*
   * One variant, picked by name rather than through `preferredVariant` — that one chooses
   * between quantisations by which operators a WebGPU build can run, which is a question a text
   * file does not have. `completeVariants` is the same question `checkManifest` already answered
   * non-empty, so this is "is there exactly one" rather than a second notion of what a variant is.
   */
  const variants = completeVariants(loaded.manifest)
  if (variants.length !== 1) {
    throw new Error(
      `${model.label} publishes ${variants.length} variants of its forest, and a ranker has ` +
        'nothing to choose between them by.',
    )
  }
  const variant = variants[0]!
  const weights = await loadWeights(loaded, variant, PART, {
    signal: options.signal,
    onProgress: (progress) => {
      options.progress?.(
        progress.total > 0 ? progress.received / progress.total : 0,
        progress.cached ? 'opening the ranker' : `fetching ${model.label}`,
      )
    },
  })
  const text = new TextDecoder().decode(weights.bytes)
  weights.remember()
  /*
   * `treeRankerFor` memoises on the address **and** the feature list, so a refit that appends a
   * feature is a different key rather than the old forest handed back under new columns. The
   * 1.3 MB of text is dropped as soon as it returns.
   */
  return { ranker: treeRankerFor(model.manifestUrl, text, config.features), config }
}

/** Refuse a model whose pool radius is not the one the vendored code will actually apply. */
function refusePoolRadius(config: RankerConfig, label: string): void {
  if (config.poolMaxDistUm === VENDORED_POOL_MAX_DIST_UM) return
  throw new Error(
    `${label} pools every object within ${config.poolMaxDistUm} µm of the neuron, and the ` +
      `search Coda vendored applies ${VENDORED_POOL_MAX_DIST_UM} µm. The radius is baked into ` +
      "SEAM's own `candidates.py`, so running anyway would search a different pool and say " +
      'nothing. This build needs a Coda whose vendored search matches the model.',
  )
}
