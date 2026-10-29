/**
 * What a model is: the one place a URL, a hash, a threshold or a dataset list appears.
 *
 * A manifest is written by `scripts/convert-affinity-model.py` and served beside its graphs. It
 * carries three kinds of fact, and keeping them in one document is the point:
 *
 *  - **what the checkpoint is** — architecture, which connectomes it was trained on, licence and
 *    citation, and the training constants (`preprocessing`, `clustering`) a caller must reproduce
 *    to feed it. These come from `scripts/affinity-checkpoints.json` and are copied verbatim.
 *  - **what was built from it** — one `files` entry per variant and part, with its size, its
 *    sha256 and the quantisation recipe that produced it.
 *  - **how to drive the graphs** — `signatures`, the tensor names and dynamic axes per part.
 *
 * The third is why this file exists rather than a few constants. Re-typing `"latents"` or
 * `"point_emb"` here is how a renamed output becomes a runtime `KeyError` nobody connects to the
 * rename, and `scripts/probe-affinity.py` already reads them from the manifest for that reason.
 *
 * **A node names a model id; it never names a URL.** That is what makes a second model — the
 * retrained, smaller checkpoint in the plan — an entry rather than a rewrite.
 */

/** Bumped by the converter when this shape changes. A mismatch is refused, never coerced. */
export const MANIFEST_SCHEMA = 1

/** The two graphs a point affinity model is cut into. */
export type ModelPart = 'encoder' | 'decoder'

export const MODEL_PARTS: readonly ModelPart[] = ['encoder', 'decoder']

/** How one file's weights were quantised. Recorded so two recipes cannot look alike. */
export interface Quantisation {
  readonly kind: 'none' | 'fp16' | 'dynamic-int8' | 'nbits'
  readonly bits?: number
  readonly blockSize?: number
  readonly ops?: readonly string[]
  readonly io?: string
}

export interface ModelFile {
  readonly variant: string
  readonly part: ModelPart
  /** Path relative to the manifest, which is how the browser finds it. See `fileUrl`. */
  readonly file: string
  /**
   * An absolute address, when the file is not served beside its manifest.
   *
   * Normally `null`: the manifest knows where it was fetched from, so a file beside it resolves
   * against that and the same artefact directory works at any host without being rewritten. The
   * converter cannot know the address, and a hand-edited one is a second source of truth.
   */
  readonly url: string | null
  readonly bytes: number
  readonly sha256: string
  readonly quantisation: Quantisation
}

/** One graph's inputs and outputs, in the order the exporter declared them. */
export interface PartSignature {
  readonly inputs: readonly string[]
  readonly outputs: readonly string[]
  /** Input/output name to {axis index: symbolic name}, for the axes that are not fixed. */
  readonly dynamic: Readonly<Record<string, Readonly<Record<string, string>>>>
}

/**
 * How to turn a neuron into this model's input.
 *
 * Reproduced by `src/packs/proofread/pointCloud.ts` and checked against the Python reference by
 * `pnpm probe:affinity-parity`. Note `jitter` and `translate` are *training* augmentations and a
 * caller must not apply them: they describe how the benchmark's synthetic merges were built, not
 * how a real segment is fed in.
 */
export interface Preprocessing {
  readonly units: string
  readonly globalScale: number
  readonly centre: string
  readonly samplesPerNeuron: number
  readonly jitter: number
  readonly translate: number
  readonly padValue: number
}

/**
 * How affinities become labels.
 *
 * `threshold` is a **distance** threshold applied to `1 - affinity`, not an affinity cut — the
 * paper's 0.8 links points whose average affinity exceeds 0.2. Reading it the other way round
 * silently over-fragments every answer.
 */
export interface Clustering {
  readonly linkage: string
  readonly threshold: number
  readonly minClusterSize: number
}

export interface ModelManifest {
  readonly id: string
  readonly manifestSchema: number
  readonly model: string
  readonly depth: number
  /** Which connectomes this checkpoint was trained on. A node warns outside them. */
  readonly datasets: readonly string[]
  readonly license: string
  readonly citation: string
  readonly source: string
  readonly parameters: number
  readonly opset: number
  /** The upstream commit the architecture was exported from, or null where git could not say. */
  readonly upstreamCommit: string | null
  /** True for a shape-test export. Never run one as if it meant something. */
  readonly randomWeights: boolean
  readonly preprocessing: Preprocessing
  readonly clustering: Clustering
  readonly signatures: Readonly<Record<ModelPart, PartSignature>>
  readonly files: readonly ModelFile[]
}

/** A manifest and where it came from, which is what `fileUrl` resolves against. */
export interface LoadedManifest {
  readonly manifest: ModelManifest
  readonly url: string
}

export class ManifestError extends Error {}

/**
 * The absolute address of one file, resolved against the manifest's own location.
 *
 * `new URL(file, manifestUrl)` is the whole trick, and it is what lets the same uploaded
 * directory work from any host, behind any path, without the converter or a human knowing where
 * it will live.
 */
export function fileUrl(loaded: LoadedManifest, variant: string, part: ModelPart): string {
  const entry = loaded.manifest.files.find((f) => f.variant === variant && f.part === part)
  if (!entry) throw new ManifestError(`${loaded.manifest.id} has no ${variant}/${part}`)
  return entry.url ?? new URL(entry.file, loaded.url).toString()
}

/** The variants this manifest actually carries both halves of. */
export function completeVariants(manifest: ModelManifest): string[] {
  const seen = new Map<string, Set<string>>()
  for (const file of manifest.files) {
    const parts = seen.get(file.variant) ?? new Set<string>()
    parts.add(file.part)
    seen.set(file.variant, parts)
  }
  return [...seen]
    .filter(([, parts]) => MODEL_PARTS.every((p) => parts.has(p)))
    .map(([variant]) => variant)
    .sort()
}

/**
 * Check a parsed manifest enough that every later reader can trust it.
 *
 * Deliberately not a schema validator: what is checked is what a *caller* would otherwise find
 * out by crashing — the schema version, a shape-test export, the per-part signatures, and that at
 * least one variant has both halves. A manifest is fetched from a server, so this is a trust
 * boundary and not only a typo check.
 */
export function checkManifest(manifest: ModelManifest): ModelManifest {
  if (manifest.manifestSchema !== MANIFEST_SCHEMA) {
    throw new ManifestError(
      `${manifest.id ?? 'manifest'} is schema ${manifest.manifestSchema}, this build reads ` +
        `${MANIFEST_SCHEMA}`,
    )
  }
  if (manifest.randomWeights) {
    throw new ManifestError(`${manifest.id} is a random-weights export and means nothing`)
  }
  for (const part of MODEL_PARTS) {
    const signature = manifest.signatures?.[part]
    if (!signature?.inputs?.length || !signature.outputs?.length) {
      throw new ManifestError(`${manifest.id} has no ${part} signature`)
    }
  }
  if (completeVariants(manifest).length === 0) {
    throw new ManifestError(`${manifest.id} has no variant with both an encoder and a decoder`)
  }
  return manifest
}

/** Fetch and check a manifest, keeping the URL it came from so its files can be resolved. */
export async function loadManifest(url: string, init?: RequestInit): Promise<LoadedManifest> {
  const response = await fetch(url, init)
  if (!response.ok) {
    throw new ManifestError(`${url} answered ${response.status}`)
  }
  return {
    manifest: checkManifest((await response.json()) as ModelManifest),
    url: response.url,
  }
}
