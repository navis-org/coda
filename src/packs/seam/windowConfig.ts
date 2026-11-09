/**
 * What a merge-window model says about itself, read once.
 *
 * `affinityConfig.ts`' argument, for the other task: a manifest's `config` is `unknown` to
 * `src/ml` by design, and this is the one place that says what is in it for this one. **Nothing
 * else may cast it** — `config as WindowConfig` passes lint and typecheck and turns a retrained
 * checkpoint with a different window radius or scale into a confidently wrong answer, because a
 * window built at the wrong size still scores plausibly and nothing downstream can tell.
 *
 * **The field names are the manifest's**, which are SEAM's exporter's. A rename here would be a
 * translation layer, and a translation layer is a second place for `windowRadiusUm` to mean
 * something slightly different.
 */

export interface WindowPreprocessing {
  /** How surface points are drawn. `seam/scan.py` implements exactly one of these. */
  readonly sampler: string
  readonly units: string
  /** Model coordinates are µm over this. */
  readonly scaleUm: number
  /** Half-width of a window, in µm. */
  readonly windowRadiusUm: number
  /** One surface point per this much area, squared, in µm. */
  readonly spacingUm: number
  /** Points per window, after the resample. */
  readonly nPoints: number
  /** `normals` or `none`. */
  readonly features: string
  readonly minPerPart: number
}

export interface WindowConfig {
  readonly preprocessing: WindowPreprocessing
  /** What each head answers, in the exporter's words. Shown, never parsed. */
  readonly heads: Readonly<Record<string, string>>
  /**
   * The precision/recall curve a cutoff is read off, or **null where none exists**.
   *
   * Null is the shipped state for `A_d256_e80` and is not a gap to paper over: SEAM's
   * invariant 14 is that a candidate list is cut by an absolute *calibrated* score, and the only
   * scores this checkpoint has are its test fold's — which is exactly what a cutoff may not be
   * chosen on. A node seeing null must leave its cutoff unset rather than inventing one.
   */
  readonly calibration: unknown
  /** What the checkpoint scored on its validation fold. Provenance, never a cutoff. */
  readonly validation: Readonly<Record<string, number>> | null
}

/** The one sampler `seam/scan.py` implements. */
export const MESH_SURFACE_SAMPLER = 'mesh-surface-area-uniform'

export class WindowConfigError extends Error {}

function block(source: unknown, key: string, where: string): Record<string, unknown> {
  const parent = source as Record<string, unknown> | null
  const value = parent?.[key]
  if (!value || typeof value !== 'object') {
    throw new WindowConfigError(`${where} has no ${key} block`)
  }
  return value as Record<string, unknown>
}

function text(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key]
  if (typeof value !== 'string') throw new WindowConfigError(`${where} has no ${key}`)
  return value
}

/**
 * A number used as a divisor, a radius or a count, so zero is as wrong as a missing one.
 *
 * `scaleUm: 0` passes every finite check and then divides every coordinate by zero; a
 * `windowRadiusUm` of 0 tiles a neuron into nothing. Both would be answered confidently.
 */
function positive(source: Record<string, unknown>, key: string, where: string): number {
  const value = source[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new WindowConfigError(`${where}'s ${key} must be a number above zero, not ${value}`)
  }
  return value
}

/** Read a manifest's `config`, or say why this build cannot run that model. */
export function parseWindowConfig(config: unknown, modelId: string): WindowConfig {
  const where = `${modelId}'s config`
  const pre = block(config, 'preprocessing', where)

  const sampler = text(pre, 'sampler', `${where}.preprocessing`)
  if (sampler !== MESH_SURFACE_SAMPLER) {
    throw new WindowConfigError(
      `${modelId} draws its points by ${sampler}; this build only draws ${MESH_SURFACE_SAMPLER}.`,
    )
  }
  const units = text(pre, 'units', `${where}.preprocessing`)
  if (units !== 'um') {
    throw new WindowConfigError(
      `${modelId} expects its points in ${units}; this build only prepares micrometres.`,
    )
  }
  const features = text(pre, 'features', `${where}.preprocessing`)
  if (features !== 'normals' && features !== 'none') {
    throw new WindowConfigError(
      `${modelId} wants ${features} as its point features; this build offers normals or none.`,
    )
  }

  const raw = config as { heads?: unknown; calibration?: unknown; validation?: unknown }
  return {
    preprocessing: {
      sampler,
      units,
      features,
      scaleUm: positive(pre, 'scaleUm', `${where}.preprocessing`),
      windowRadiusUm: positive(pre, 'windowRadiusUm', `${where}.preprocessing`),
      spacingUm: positive(pre, 'spacingUm', `${where}.preprocessing`),
      nPoints: positive(pre, 'nPoints', `${where}.preprocessing`),
      minPerPart: positive(pre, 'minPerPart', `${where}.preprocessing`),
    },
    heads: (raw.heads ?? {}) as Readonly<Record<string, string>>,
    calibration: raw.calibration ?? null,
    validation: (raw.validation ?? null) as Readonly<Record<string, number>> | null,
  }
}
