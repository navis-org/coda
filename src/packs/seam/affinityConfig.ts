/**
 * What a point affinity model says about itself, read once.
 *
 * A manifest's `config` is `unknown` to `src/ml` by design — only the pack that owns the task can
 * say what is in it. This is that one place. **Nothing else may cast it**: `config as
 * AffinityConfig` is one keystroke, passes lint and typecheck, and turns a retrained checkpoint
 * with a different `globalScale` or `samplesPerNeuron` into a confidently wrong answer with no
 * error anywhere — the model's own input distribution silently violated, which is the one failure
 * nothing downstream can detect.
 *
 * **The field names are the manifest's**, not nicer local ones. A rename here is a translation
 * layer, and a translation layer is a second place for `samplesPerNeuron` to mean something
 * slightly different.
 *
 * **It refuses what it cannot do rather than approximating it.** `affinityOps.ts` implements
 * average linkage over a centroid-centred cloud in µm; a manifest asking for anything else gets a
 * sentence naming the model, not a silent substitution.
 */

export interface AffinityPreprocessing {
  /**
   * How points are drawn from a skeleton. `pointCloud.ts` implements exactly one of these.
   *
   * Absent in a manifest written before this field existed, which is read as the sampler those
   * checkpoints used.
   */
  readonly sampler: string
  readonly units: string
  readonly globalScale: number
  readonly centre: string
  readonly samplesPerNeuron: number
  /** Training augmentations. Present in the manifest, and deliberately never applied. */
  readonly jitter: number
  readonly translate: number
  readonly padValue: number
}

export interface AffinityClustering {
  readonly linkage: string
  /** A **distance** threshold on `1 - affinity`. See `affinityOps.ts`. */
  readonly threshold: number
  readonly minClusterSize: number
}

export interface AffinityConfig {
  readonly preprocessing: AffinityPreprocessing
  readonly clustering: AffinityClustering
}

/**
 * The one sampler `pointCloud.ts` implements: uniform node indices, with replacement, sorted.
 *
 * The value a converter writes for the checkpoints that exist; a manifest without the field is
 * read as this, because those were all drawn this way.
 */
export const UNIFORM_WITH_REPLACEMENT = 'uniform-nodes-with-replacement'

export class AffinityConfigError extends Error {}

function num(source: Record<string, unknown>, key: string, where: string): number {
  const value = source[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AffinityConfigError(`${where} has no numeric ${key}`)
  }
  return value
}

/**
 * A number that is used as a divisor or a count, so zero is as wrong as a missing one.
 *
 * `globalScale: 0` passes every finite check and then makes `pointCloud`'s divisor zero, feeding
 * the encoder Infinity and NaN coordinates with nothing to say so.
 */
function positive(source: Record<string, unknown>, key: string, where: string): number {
  const value = num(source, key, where)
  if (value <= 0)
    throw new AffinityConfigError(`${where}'s ${key} must be above zero, not ${value}`)
  return value
}

function text(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key]
  if (typeof value !== 'string') throw new AffinityConfigError(`${where} has no ${key}`)
  return value
}

function block(source: unknown, key: string, where: string): Record<string, unknown> {
  const parent = source as Record<string, unknown> | null
  const value = parent?.[key]
  if (!value || typeof value !== 'object') {
    throw new AffinityConfigError(`${where} has no ${key} block`)
  }
  return value as Record<string, unknown>
}

/**
 * Read a manifest's `config`, or say why this build cannot run that model.
 *
 * `modelId` is in every message because a reader with two models open needs to know which one
 * the sentence is about.
 */
export function parseAffinityConfig(config: unknown, modelId: string): AffinityConfig {
  const where = `${modelId}'s config`
  const pre = block(config, 'preprocessing', where)
  const clustering = block(config, 'clustering', where)

  // The one preprocessing fact `pointCloud.ts` actually implements, and the one a retrain is
  // most likely to change. Unchecked, a different sampler is a confidently wrong answer with no
  // error anywhere -- which is the failure this whole file exists to prevent.
  const sampler =
    typeof (pre as { sampler?: unknown }).sampler === 'string'
      ? (pre as { sampler: string }).sampler
      : UNIFORM_WITH_REPLACEMENT
  if (sampler !== UNIFORM_WITH_REPLACEMENT) {
    throw new AffinityConfigError(
      `${modelId} draws its points by ${sampler}; this build only draws ` +
        `${UNIFORM_WITH_REPLACEMENT}.`,
    )
  }
  const units = text(pre, 'units', `${where}.preprocessing`)
  if (units !== 'um') {
    throw new AffinityConfigError(
      `${modelId} expects its points in ${units}; this build only prepares micrometres.`,
    )
  }
  const centre = text(pre, 'centre', `${where}.preprocessing`)
  if (centre !== 'centroid') {
    throw new AffinityConfigError(
      `${modelId} centres its points on ${centre}; this build only centres on the centroid.`,
    )
  }
  const linkage = text(clustering, 'linkage', `${where}.clustering`)
  if (linkage !== 'average') {
    // Not a substitution: average linkage is what `affinityOps.ts` implements, and running
    // ward's merges through it would answer confidently with the wrong clustering.
    throw new AffinityConfigError(
      `${modelId} clusters with ${linkage} linkage; this build only does average linkage.`,
    )
  }

  return {
    preprocessing: {
      sampler,
      units,
      centre,
      globalScale: positive(pre, 'globalScale', `${where}.preprocessing`),
      samplesPerNeuron: positive(pre, 'samplesPerNeuron', `${where}.preprocessing`),
      jitter: num(pre, 'jitter', `${where}.preprocessing`),
      translate: num(pre, 'translate', `${where}.preprocessing`),
      padValue: num(pre, 'padValue', `${where}.preprocessing`),
    },
    clustering: {
      linkage,
      threshold: num(clustering, 'threshold', `${where}.clustering`),
      minClusterSize: positive(clustering, 'minClusterSize', `${where}.clustering`),
    },
  }
}
