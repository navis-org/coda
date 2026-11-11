/**
 * What a model is: the one place a URL, a hash, a tensor name or a licence appears.
 *
 * A manifest is written by a conversion script and served beside its graphs. It carries two
 * kinds of fact and the split between them is the whole design:
 *
 *  - **What this module understands** — where the files are, what they hash to, which graphs the
 *    model is cut into and what each graph's tensors are called. Provenance and addressing.
 *  - **What it must not** — `config`, an opaque blob the converter copies verbatim and only the
 *    pack that owns the task reads. A point affinity model's point sampling and clustering
 *    thresholds live there, and `src/ml` neither parses nor validates them.
 *
 * The second half was learnt the hard way one level down: the converter's `VARIANTS` table
 * claimed to be keyed per part and was not. A seam that names one task's vocabulary is the same
 * mistake, and the test for it is the plan's own next model — a one-graph DeepSet head on top of
 * the encoder's latents. That must cost a manifest entry, which means **a part is a string the
 * manifest declares**, not a union this file fixes.
 *
 * Re-typing `"latents"` here rather than reading `signatures` is how a renamed output becomes a
 * runtime error nobody connects to the rename, which is why the signatures travel with the files.
 */

import { fetchText } from '../data/fetchText'

/** Bumped by a converter when this shape changes. A mismatch is refused, never coerced. */
export const MANIFEST_SCHEMA = 2

/** How one file's weights were quantised. Recorded so two recipes cannot look alike. */
export interface Quantisation {
  readonly kind: string
  readonly bits?: number
  readonly blockSize?: number
  /** Ops the recipe rewrote. Not what the graph ends up containing — see `emits`. */
  readonly quantises?: readonly string[]
  /**
   * The matmul op the exported graph actually contains, checked against it by the converter.
   *
   * This is what decides whether a browser can run the variant, and it is **not** derivable from
   * `quantises`: dynamic int8 quantises `MatMul` and emits `MatMulInteger`, which WebGPU declines.
   */
  readonly emits?: readonly string[]
  readonly io?: string
}

export interface ModelFile {
  readonly variant: string
  /** Which graph this is, from the manifest's own `parts`. */
  readonly part: string
  /** Path relative to the manifest, which is how the browser finds it. See `fileUrl`. */
  readonly file: string
  /**
   * An absolute address, when the file is not served beside its manifest.
   *
   * Normally `null`: the manifest knows where it was fetched from, so a file beside it resolves
   * against that and the same artefact directory works at any host without being rewritten. A
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

export interface ModelManifest {
  readonly id: string
  readonly manifestSchema: number
  /** Which pack owns the `config` blob. `src/ml` compares it and never interprets it. */
  readonly task: string
  /** The graphs this model is cut into, in the order they must be run. */
  readonly parts: readonly string[]
  /** Which datasets this checkpoint was trained on. A node warns outside them. */
  readonly datasets: readonly string[]
  readonly license: string
  readonly citation: string
  readonly source: string
  /** The upstream commit the architecture was exported from, or null where git could not say. */
  readonly upstreamCommit: string | null
  /** True for a shape-test export. Never run one as if it meant something. */
  readonly randomWeights: boolean
  /**
   * The task's own constants — preprocessing, thresholds, architecture. **Opaque here.**
   * The owning pack parses it and says what is wrong with it; a block in this file would make
   * every new task either edit a shared type or smuggle its config somewhere else.
   */
  readonly config: unknown
  readonly signatures: Readonly<Record<string, PartSignature>>
  readonly files: readonly ModelFile[]
}

/** A manifest and where it came from, which is what `fileUrl` resolves against. */
export interface LoadedManifest {
  readonly manifest: ModelManifest
  /**
   * The URL this manifest was requested from, which every file resolves against.
   *
   * Note it is the *requested* URL, not the final one: `fetchText` does not expose
   * `response.url`, so a manifest served through a redirect resolves its files against the
   * address asked for rather than the one answered. Host a model's files beside the manifest a
   * caller actually names, or give each file an absolute `url`.
   */
  readonly url: string
}

export class ManifestError extends Error {}

/** One file entry, with the one lookup and the one sentence for a miss. */
export function modelFile(loaded: LoadedManifest, variant: string, part: string): ModelFile {
  const entry = loaded.manifest.files.find((f) => f.variant === variant && f.part === part)
  if (!entry) throw new ManifestError(`${loaded.manifest.id} has no ${variant}/${part}`)
  return entry
}

/**
 * The absolute address of one file, resolved against the manifest's own location.
 *
 * `new URL(file, manifestUrl)` is the whole trick, and it is what lets one uploaded directory
 * work from any host, behind any path, without a converter or a human knowing where it will live.
 */
export function fileUrl(loaded: LoadedManifest, variant: string, part: string): string {
  const entry = modelFile(loaded, variant, part)
  return entry.url ?? new URL(entry.file, loaded.url).toString()
}

/**
 * What one variant weighs: the summed `bytes` of its files.
 *
 * One definition, because two numbers derived from it are read side by side — the sentence that
 * asks a reader to approve a download, and the denominator its progress bar fills against. If
 * the manifest ever grows a file kind one side counts and the other does not, the bar stalls
 * short and the refusal quotes a size that is not what gets fetched, and neither throws.
 */
export function variantBytes(manifest: ModelManifest, variant: string): number {
  return manifest.files
    .filter((file) => file.variant === variant)
    .reduce((total, file) => total + file.bytes, 0)
}

/** The variants carrying every part the manifest declares. */
export function completeVariants(manifest: ModelManifest): string[] {
  const parts = new Map<string, Set<string>>()
  for (const file of manifest.files) {
    const held = parts.get(file.variant) ?? new Set<string>()
    held.add(file.part)
    parts.set(file.variant, held)
  }
  return [...parts]
    .filter(([, held]) => manifest.parts.every((part) => held.has(part)))
    .map(([variant]) => variant)
    .sort()
}

/**
 * Check a parsed manifest enough that every later reader can trust it.
 *
 * Deliberately not a schema validator: what is checked is what a *caller* would otherwise find
 * out by crashing — the schema version, a shape-test export, a signature per declared part, and
 * one variant that is actually complete. A manifest comes off a server, so this is a trust
 * boundary and not only a typo check. What it does **not** check is `config`: that belongs to
 * whoever declared the task.
 */
export function checkManifest(manifest: ModelManifest): ModelManifest {
  // The body came off a server, so it may be anything at all. Checked before any field is read,
  // or a null or an array surfaces as a raw TypeError from whichever line touched it first.
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new ManifestError('That is not a model manifest')
  }
  if (!Array.isArray(manifest.files)) throw new ManifestError('The manifest lists no files')
  if (manifest.manifestSchema !== MANIFEST_SCHEMA) {
    throw new ManifestError(
      `${manifest.id ?? 'manifest'} is schema ${manifest.manifestSchema}, this build reads ` +
        `${MANIFEST_SCHEMA}`,
    )
  }
  if (manifest.randomWeights) {
    throw new ManifestError(`${manifest.id} is a random-weights export and means nothing`)
  }
  if (!manifest.parts?.length) throw new ManifestError(`${manifest.id} declares no parts`)
  for (const part of manifest.parts) {
    const signature = manifest.signatures?.[part]
    if (!signature?.inputs?.length || !signature.outputs?.length) {
      throw new ManifestError(`${manifest.id} has no ${part} signature`)
    }
  }
  // Every file's size, before anything sums them. `bytes` is read by `variantBytes` — whose
  // answer is the figure a reader approves, the denominator of the download bar, and
  // `preferredVariant`'s sort key — and an absent one makes all three `NaN`: a refusal quoting
  // "NaN bytes", a bar that never moves, and a comparator that silently keeps the file order.
  // Nothing throws, so the gate is the only place to catch it.
  for (const file of manifest.files) {
    if (typeof file?.bytes !== 'number' || !Number.isFinite(file.bytes) || file.bytes < 0) {
      throw new ManifestError(
        `${manifest.id} lists ${file?.variant ?? 'a file'}/${file?.part ?? '?'} with no size`,
      )
    }
  }
  if (completeVariants(manifest).length === 0) {
    throw new ManifestError(`${manifest.id} has no variant carrying every part`)
  }
  return manifest
}

/**
 * The one graph a single-part model declares, with the part's name beside its signature.
 *
 * Every SEAM-shaped checkpoint here is one graph — the affinity model's encoder/decoder split is
 * the exception, not the rule — and each runner opened with `parts[0]`, looked the signature up,
 * and threw the same sentence. Two copies of that had already gone character for character
 * identical, which is what a third task would have made three.
 *
 * It returns the pair rather than the signature alone because the caller needs the **name** for
 * `session.run({ part })` as well, and deriving it twice is how the two come to disagree about
 * which graph is being described.
 */
export function soleGraph(manifest: ModelManifest): { part: string; signature: PartSignature } {
  const part = manifest.parts[0]
  const signature = part ? manifest.signatures[part] : undefined
  if (!part || !signature) throw new ManifestError(`${manifest.id} declares no graph to run`)
  return { part, signature }
}

/**
 * Fetch and check a manifest, keeping the URL it came from so its files can be resolved.
 *
 * Through `fetchText` rather than a bare `fetch`, which is the house rule for any credential-less
 * cross-origin read: it omits credentials and tells an unreachable host from a CORS refusal,
 * where `fetch` alone gives an unqualified `TypeError` for both.
 */
export async function loadManifest(url: string, signal?: AbortSignal): Promise<LoadedManifest> {
  const text = await fetchText(url, {
    ...(signal ? { signal } : {}),
    notFound: 'There is no model manifest at that address.',
    hint: 'A model is served from wherever its manifest is.',
  })
  let parsed: ModelManifest
  try {
    parsed = JSON.parse(text) as ModelManifest
  } catch {
    throw new ManifestError(`${url} did not answer with JSON`)
  }
  return { manifest: checkManifest(parsed), url }
}
