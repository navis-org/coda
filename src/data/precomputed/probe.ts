/**
 * What is at the end of a precomputed URL, read once and remembered.
 *
 * `openMeshSource` already resolves a volume down to its mesh directory, and that is the right
 * shape for a *fetch*: a caller with neuron ids does not care what else the source publishes.
 * A **card** does. Somebody typing a URL wants to know, before pressing Run, whether this is a
 * segmentation or an image stack, whether it has meshes at all, and whether those meshes are
 * multi-resolution or the flat kind that sends several megabytes per neuron. So this reads the
 * same `info` documents and keeps the whole answer instead of the one branch a fetch needs.
 *
 * ## Memoised, failures included
 *
 * The node above is `cheap`, which means it re-runs on an edit rather than on Run — and the one
 * thing anybody edits on it is a URL. Caching the *failure* is what stops a half-typed bucket
 * name from being re-requested by every surface that asks about it afterwards (invariant 6);
 * caching the success is what makes `capabilitiesFor` synchronous, which is what lets the Meshes
 * node refuse before a run rather than after one (invariant 2).
 *
 * The cost that remains is one request per committed edit, because each distinct URL is its own
 * key. That is the same trade `Custom CAVE` makes for a hand-typed datastack, and the string
 * param's debounce is what keeps it to one request per pause rather than one per keystroke.
 * `retry` is the way back from a *transient* failure — the node passes it from `evaluate`, which
 * runs on an explicit Run, and never from a peek.
 */

import type { MeshSource } from './index'
import { openMeshSource } from './index'
import type { SkeletonSource } from './skeletons'
import { openSkeletonSource } from './skeletons'
import { fetchInfo } from './transport'

/** What a precomputed directory turned out to be. */
export type PrecomputedKind =
  | 'volume'
  | 'meshes'
  | 'skeletons'
  | 'annotations'
  | 'segment-properties'
  | 'unknown'

export interface PrecomputedDescription {
  kind: PrecomputedKind
  /** For a volume, what its `info` says it holds. */
  volumeType?: 'image' | 'segmentation' | string
  /** Mesh directory, whether this URL *is* one or names one. */
  meshUrl?: string
  /**
   * The mesh directory **opened** — format, sharding spec and level table.
   *
   * Separate from `meshUrl`, which is only what the volume *named*: the pair present-and-absent
   * is a real state (a volume naming a mesh directory nobody can read), and it must not read as
   * "no meshes here". It is also what makes the first Run cost no requests — `openMeshSource`
   * would otherwise re-read the same `info` this probe already fetched.
   */
  mesh?: MeshSource
  /** Skeleton directory, whether this URL *is* one or names one. */
  skeletonUrl?: string
  /** The skeleton directory **opened** — its sharding, transform and attribute list. */
  skeletons?: SkeletonSource
  /** Segment-property directory, when the volume names one. */
  segmentPropertiesUrl?: string
  /** One line for the card: `segmentation · multi-resolution meshes`. */
  summary: string
}

export type PrecomputedProbe =
  | { readonly ok: true; readonly source: PrecomputedDescription }
  | { readonly ok: false; readonly error: string }

/** The shape of an `info`, as far as anything here reads it. */
interface RawInfo {
  '@type'?: string
  type?: string
  mesh?: string
  skeletons?: string
  segment_properties?: string
}

interface Entry {
  promise: Promise<PrecomputedProbe>
  /** Set when the promise settles, which is what makes the peek synchronous. */
  settled?: PrecomputedProbe
}

const probes = new Map<string, Entry>()

export interface ProbeOptions {
  signal?: AbortSignal | undefined
  /**
   * Read again even if a previous attempt **failed**.
   *
   * Successes are never re-read: a published `info` does not change under a fixed URL, and
   * re-reading one would put a request behind every edit-time peek. A failure is the opposite —
   * an unreachable host, a proxy that was not running yet — so an explicit Run is allowed to ask
   * again. Deliberately not a general cache-buster.
   */
  retry?: boolean | undefined
}

/**
 * Read (or reuse) the description of a precomputed directory.
 *
 * Resolves a *verdict* rather than throwing one — a URL that 404s is an answer a card shows — with
 * one exception: **an abort rejects and is not remembered.** Cancelling a run says nothing about
 * the bytes, and a memoised `This operation was aborted` would sit on a card with a perfectly good
 * URL until the next explicit Run. It is also the scheduler's own rule that an aborted run
 * rejects rather than resolving with something partial.
 */
export function probePrecomputed(url: string, options: ProbeOptions = {}): Promise<PrecomputedProbe> {
  const base = url.replace(/\/+$/, '')
  const existing = probes.get(base)
  if (existing && !(options.retry && existing.settled?.ok === false)) return existing.promise

  const entry: Entry = {
    promise: read(base, options.signal)
      .then((result) => {
        entry.settled = result
        return result
      })
      .catch((error: unknown) => {
        if (probes.get(base) === entry) probes.delete(base)
        throw error
      }),
  }
  probes.set(base, entry)
  return entry.promise
}

/**
 * What is known about a URL right now, without awaiting.
 *
 * Undefined until a probe has settled, which is the ordinary state on a fresh session and is a
 * different answer from "there is nothing there" — every caller is expected to treat it as
 * "not yet" and degrade rather than refuse. It does **not** start a probe: the callers that want
 * one started are the ones that can also announce the answer arriving (see
 * `reportSourceLearned`), and a peek that fired one silently would leave inference permanently
 * out of date instead.
 */
export function peekPrecomputed(url: string): PrecomputedProbe | undefined {
  return probes.get(url.replace(/\/+$/, ''))?.settled
}

/** Drop everything remembered. Tests only. */
export function resetPrecomputedProbes(): void {
  probes.clear()
}

async function read(base: string, signal: AbortSignal | undefined): Promise<PrecomputedProbe> {
  let info: RawInfo
  try {
    info = await fetchInfo<RawInfo>(base, signal ? { signal } : {})
  } catch (error) {
    // Rethrown rather than reported: see `probePrecomputed`. Everything else is a verdict.
    if (error instanceof Error && error.name === 'AbortError') throw error
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  const source = await classify(base, info, signal)
  return { ok: true, source: { ...source, summary: summarise(source, info) } }
}

/**
 * What the `info` says this is, minus the summary.
 *
 * Returned without `summary` so the one place that writes it is the caller: every branch used to
 * build a description with a placeholder `summary: ''` and then re-spread itself to fill it in,
 * which is a field whose declared type is briefly a lie in six places.
 */
async function classify(
  base: string,
  info: RawInfo,
  signal: AbortSignal | undefined,
): Promise<Omit<PrecomputedDescription, 'summary'>> {
  switch (info['@type']) {
    case 'neuroglancer_multiscale_volume': {
      const meshUrl = info.mesh ? `${base}/${info.mesh}` : undefined
      const skeletonUrl = info.skeletons ? `${base}/${info.skeletons}` : undefined
      /*
       * Both together: they are independent reads against the same bucket, and awaiting them in
       * sequence put a whole extra round trip in front of a card that is waiting to say what it
       * found. This runs from an edit-time peek, so that latency is visible.
       */
      const [mesh, skeletons] = await Promise.all([
        tryOpen(meshUrl, openMeshSource, signal),
        tryOpen(skeletonUrl, openSkeletonSource, signal),
      ])
      return {
        kind: 'volume',
        ...(info.type ? { volumeType: info.type } : {}),
        ...(meshUrl ? { meshUrl } : {}),
        ...(mesh ? { mesh } : {}),
        ...(skeletonUrl ? { skeletonUrl } : {}),
        ...(skeletons ? { skeletons } : {}),
        ...(info.segment_properties
          ? { segmentPropertiesUrl: `${base}/${info.segment_properties}` }
          : {}),
      }
    }
    case 'neuroglancer_skeletons':
      return { kind: 'skeletons', skeletonUrl: base, ...spread('skeletons', await tryOpen(base, openSkeletonSource, signal)) }
    case 'neuroglancer_annotations_v1':
      return { kind: 'annotations' }
    case 'neuroglancer_segment_properties':
      return { kind: 'segment-properties', segmentPropertiesUrl: base }
    case 'neuroglancer_multilod_draco':
    case 'neuroglancer_legacy_mesh':
    case undefined:
      /*
       * An `info` with no `@type` at all is a legacy mesh directory. That rule is
       * `openMeshSource`'s — banc's bucket needs it — and asking that function rather than
       * restating the three `@type` spellings is what keeps the card's verdict and the fetch's
       * from disagreeing about one URL.
       */
      return { kind: 'meshes', meshUrl: base, ...spread('mesh', await tryOpen(base, openMeshSource, signal)) }
    default:
      return { kind: 'unknown' }
  }
}

/**
 * Open a directory, or say nothing about it.
 *
 * Absent rather than a throw when it cannot be read: a volume that names a mesh or skeleton
 * directory nobody can reach is still a volume, and reporting the whole URL as unreadable because
 * of a subdirectory would hide the part that did work.
 *
 * **What comes back is an optimisation, not a verdict.** A swallowed failure here is
 * indistinguishable from a directory that is genuinely unreadable, and the probe is then cached as
 * a *success* — so a caller that read `mesh === undefined` as "there are no meshes" would say so
 * permanently after one CORS blip. `meshUrl`/`skeletonUrl` are what say whether a source *names*
 * geometry; this only says whether the Run can skip a request. `PrecomputedSource.meshDir` opens
 * it again when it is absent, and lets that attempt report its own failure.
 *
 * One function for both, because the two were the same eight lines differing only in the opener —
 * which is how the mesh half comes to swallow a failure the skeleton half reports, or the reverse.
 */
async function tryOpen<T>(
  url: string | undefined,
  open: (url: string, options: { signal?: AbortSignal }) => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T | undefined> {
  if (!url) return undefined
  try {
    return await open(url, signal ? { signal } : {})
  } catch {
    return undefined
  }
}

/** Spread an optional under a key, or nothing. Keeps the branch out of the object literals. */
function spread<K extends string, T>(key: K, value: T | undefined): Partial<Record<K, T>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, T>)
}

/**
 * The card's one line. Says what it is, then what geometry can be got out of it.
 *
 * The fallback is the raw `@type` rather than the kind, because the case that reaches it is a
 * format this build has never met — and naming it is the whole of what a reader can act on.
 */
function summarise(source: Omit<PrecomputedDescription, 'summary'>, info: RawInfo): string {
  const parts: string[] = []
  if (source.kind === 'volume') parts.push(source.volumeType ?? 'volume')
  if (source.meshUrl) {
    parts.push(
      source.mesh?.format === 'multilod-draco'
        ? 'multi-resolution meshes'
        : source.mesh?.format === 'legacy'
          ? 'full-resolution meshes'
          : 'meshes',
    )
  }
  if (source.skeletonUrl) parts.push('skeletons')
  if (parts.length > 0) return parts.join(' · ')
  // Only an unrecognised format falls back to the raw `@type` — naming it is the whole of what a
  // reader can act on there, and it is the wrong thing to print for a kind that has a name.
  if (source.kind === 'unknown') return info['@type'] ?? 'unknown'
  return KIND_LABELS[source.kind] ?? source.kind
}

/** Kinds whose id is not what a card should print. Everything else reads fine as itself. */
const KIND_LABELS: Readonly<Partial<Record<PrecomputedKind, string>>> = {
  'segment-properties': 'segment properties',
}
