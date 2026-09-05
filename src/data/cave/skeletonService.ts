/**
 * CAVE's skeleton service — the third way a datastack's skeletons can arrive.
 *
 * It is a `neuroglancer_skeletons` endpoint that **generates on demand and caches**, which is the
 * whole of what makes it different from a bucket: the URL is stable, the answer is not. Its
 * `/info` declares `radius` and `compartment` on every vertex, so the format side is
 * `precomputed/skeletons.ts`'s decoder unchanged; what is CAVE's is everything around it.
 *
 * ## Declaring a service and having one are different facts, and the gap is most of this file
 *
 * All three specced datastacks declare `skeleton_source`. Asked whether they can answer, on the
 * same afternoon:
 *
 *   minnie65_public               50 of 50 proofread root ids cached, at every skeleton version
 *   flywire_fafb_public            0 of 5, at versions 0 through 4
 *   brain_and_nerve_cord_public    0 of 5, at versions 0 through 4
 *
 * That is not a fact about the datastacks so much as about the model: a generated skeleton exists
 * because somebody asked for it, and MICrONS asked. So the service is *offered* wherever it is
 * declared — the alternative is a build-time list that goes stale in the direction of hiding a
 * working route — and `existing` is what turns "will this answer?" into a question that can be
 * asked before anything is downloaded. It is one POST for the whole set and takes about half a
 * second at fifty ids.
 *
 * **Nothing here ever asks the service to generate.** The endpoints for that exist, and the
 * measured cost of a cold generation is 10–45 s for one neuron against 1.5 s for a cached one —
 * so a fetch that queued them would be a Skeletons node that hangs for minutes with no way to
 * tell it apart from a slow network. The honest answer is to fetch what is there and say what is
 * not, which is `readServiceSkeletons`' contract.
 *
 * ## What it is worth
 *
 * Measured on `minnie65_public` root id 864691134884807418: 7,167 vertices, 186 kB, 1.45 s, with
 * a radius on every one. The level-2 route for the same neuron is a few hundred nodes. Where both
 * exist this is the better reconstruction and `CaveSource` prefers it — but only when it covers
 * *every* neuron asked for, because a scene mixing a real reconstruction with a chunk
 * decomposition is one where cable length silently means two different things.
 */

import type { NeuronId } from '../../core/ids'
import type { SkeletonGeometry } from '../../core/values'
import { mapWithConcurrency } from '../concurrency'
import { reportSourceLearned } from '../source'
import type { CaveRequestOptions } from './client'
import { CaveError, caveGet, caveGetBytes, cavePostRaw } from './client'
import { datastackRecord } from './datastack'
import { getServer } from './credentials'
import type { RawSkeletonInfo, SkeletonSource } from '../precomputed/skeletons'
import { parseSkeleton, skeletonSourceFromInfo } from '../precomputed/skeletons'

/**
 * How many skeletons are read at once.
 *
 * Below `L2_CONCURRENCY`'s 16 rather than at it, and for the opposite reason: an L2 read is two
 * small JSON calls against a chunkedgraph, where this is a ~186 kB blob out of a service that
 * generates. It is the same shared deployment either way, and nothing here was measured past
 * eight, so eight is what it does.
 */
const SERVICE_CONCURRENCY = 8

/** How many ids go in one `exists` call. The endpoint takes a list; nothing was measured past this. */
const EXISTS_BATCH = 500

/** How many `exists` batches are in flight at once. See `existingSkeletons`. */
const EXISTS_CONCURRENCY = 4

/**
 * Where a datastack's skeleton service is and which version to ask it for.
 *
 * `format` is what `parseSkeleton` reads — the attribute list and the transform — and its `base`
 * is the **versioned** URL, `${base}/${version}`, which is where objects are actually fetched
 * from. `base` and `version` are kept beside it because `exists` hangs off the unversioned path
 * and takes the version in its body.
 */
export interface SkeletonService {
  datastack: string
  /** No `precomputed://`, no `middleauth+`, no trailing slash. */
  base: string
  /** The skeleton version this build asks for: the highest the server lists. */
  version: number
  format: SkeletonSource
}

/**
 * `precomputed://middleauth+https://host/…/` → `https://host/…`.
 *
 * Both prefixes are neuroglancer's rather than the URL's: `precomputed://` is the format and
 * `middleauth+` is "this needs a CAVE token", which is true of every call this file makes anyway.
 * MICrONS sets the second and Janelia does not, so a parser that handled only one would work
 * against two of the three datastacks and produce a confidently wrong host for the third.
 */
export function skeletonServiceUrl(source: string | null | undefined): string | undefined {
  if (!source) return undefined
  const url = source
    .trim()
    .replace(/^precomputed:\/\//, '')
    .replace(/^middleauth\+/, '')
    .replace(/\/+$/, '')
  return /^https?:\/\//.test(url) ? url : undefined
}

/**
 * Which skeleton version to ask for: the highest the server offers.
 *
 * The server lists `[-1, 0, 1, 2, 3, 4]`, where `-1` means "whatever is latest" and is therefore
 * not a version anybody should pin a cache key to — a route that asked for it would key a
 * geometry cache on a number whose meaning changes under it. caveclient defaults to 4 and
 * validates membership; taking the maximum is the same answer without the constant, which is
 * what stops this build asking for a version that has been retired.
 */
function chooseVersion(versions: readonly number[]): number | undefined {
  const usable = versions.filter((v) => Number.isInteger(v) && v >= 0)
  return usable.length ? Math.max(...usable) : undefined
}

/**
 * Keyed by the **global server** as well as by the datastack, which is `tables.ts`'s answer to
 * the problem `datastack.ts` solves with a clock.
 *
 * The CAVE server is user-editable in the Connections panel. `clearLearned` drops the datastack
 * records, the materializations and the L2 sources together when it moves; a fourth memo kept
 * outside that list would go on offering a route resolved against a deployment nobody is talking
 * to — which is the incident `datastack.ts`'s own header records ("two generations could clear
 * one and keep the other, and did"). A key needs nothing remembered and no partner map: a stale
 * entry is simply never looked up again.
 */
function keyFor(datastack: string): string {
  return `${getServer()}|${datastack}`
}

const services = new Map<string, SkeletonService | null>()
const loading = new Map<string, Promise<SkeletonService | undefined>>()

/**
 * Datastacks a **peek** has already asked about, so a failure is not re-asked once per keystroke.
 *
 * `peekL2Cache`'s gate is `l2Sources.has(...)`, which a rejected resolve never fills — and this
 * chain is the more expensive of the two (a datastack record, a version list and an `info`).
 * Without this a deployment that answers 404 for `/skeletoncache` turns every graph mutation into
 * three requests against a shared production server, forever. `peekMaterializations` keeps a set
 * for exactly this and says so; `skeletonServiceFor` still retries, because its caller asked for
 * geometry and has somewhere to report to.
 */
const asked = new Set<string>()

/**
 * Datastacks whose service answered for **none** of a set it was asked about.
 *
 * Only `automatic` reads it, and only to skip a half-second `exists` call it already knows the
 * answer to: `brain_and_nerve_cord_public` declares a service with an empty cache, so every
 * Skeletons run on BANC would otherwise pay for the same refusal. An explicit choice never
 * consults this — somebody who picked the service is entitled to ask again, and a cache that
 * filled since is exactly the case where that matters.
 */
const barren = new Set<string>()

/** Test seam, and what a changed global server drops. */
export function resetSkeletonServices(): void {
  services.clear()
  loading.clear()
  asked.clear()
  barren.clear()
}

/**
 * Whether this datastack declares a skeleton service, synchronously, if that is known.
 *
 * `peekL2Cache`'s contract exactly: `undefined` means *not yet*, the first look starts the read,
 * and `reportSourceLearned` re-infers when it lands so a dropdown that offered two routes offers
 * three without a reload.
 */
export function peekSkeletonService(datastack: string): boolean | undefined {
  const key = keyFor(datastack)
  if (services.has(key)) return services.get(key) !== null
  if (!datastack || asked.has(key)) return undefined
  asked.add(key)
  // Swallowed: a peek has no caller to report to, and a 401 travels on its own channel.
  void skeletonServiceFor(datastack).catch(() => undefined)
  return undefined
}

/**
 * The service for a datastack, resolved once.
 *
 * Two requests behind it — the datastack record, which is already memoised, and the server's
 * version list — and the promise is memoised rather than the value, so two nodes asking a tick
 * apart issue one read.
 */
export function skeletonServiceFor(
  datastack: string,
  options: CaveRequestOptions = {},
): Promise<SkeletonService | undefined> {
  const key = keyFor(datastack)
  const known = services.get(key)
  if (known !== undefined) return Promise.resolve(known ?? undefined)

  let pending = loading.get(key)
  if (!pending) {
    pending = resolve(datastack, options)
      .then((service) => {
        const before = services.get(key)
        services.set(key, service ?? null)
        // Only when the answer *changed* — `l2SourceFor`'s rule, and for its reason: fired
        // unconditionally it costs a whole-graph re-inference per Run.
        if (before === undefined) reportSourceLearned('cave')
        return service
      })
      .finally(() => {
        // Not remembered as a verdict: a failed read is transient and a sticky `null` would
        // report "no service" for the life of the tab. `asked` is what stops the *peek* retrying
        // it; a caller that wants geometry is allowed to.
        loading.delete(key)
      })
    loading.set(key, pending)
  }
  return pending
}

async function resolve(
  datastack: string,
  options: CaveRequestOptions,
): Promise<SkeletonService | undefined> {
  const record = await datastackRecord(datastack, options)
  const base = skeletonServiceUrl(record.skeleton_source)
  if (!base) return undefined

  // The versions endpoint sits above the datastack in the path — one list per deployment.
  const server = base.slice(0, base.indexOf('/skeletoncache/'))
  const versions = await caveGet<number[]>(
    `${server}/skeletoncache/api/versions`,
    options,
  ).catch(() => [] as number[])
  const version = chooseVersion(versions)
  if (version === undefined) return undefined

  // Fetched here (the service needs the token) and shaped there (the format is the bucket's), so
  // whatever `precomputed/skeletons.ts` learns to honour applies to both — see
  // `skeletonSourceFromInfo`.
  const info = await caveGet<RawSkeletonInfo>(`${base}/${version}/info`, options)
  const format = skeletonSourceFromInfo(`${base}/${version}`, info)
  return format ? { datastack, base, version, format } : undefined
}

/**
 * Which of these root ids the cache already holds.
 *
 * **A POST, and the body is written as text.** The GET form of this endpoint 502s, and
 * `JSON.stringify` of an eighteen-digit root id as a number is a different neuron (invariant 8) —
 * the same splice `is_latest_roots` performs for the same reason. The reply is keyed by the id as
 * a *string*, which is the one place CAVE makes this easy.
 */
export async function existingSkeletons(
  service: SkeletonService,
  neuronIds: readonly NeuronId[],
  options: CaveRequestOptions = {},
): Promise<Set<string>> {
  const batches: Array<readonly NeuronId[]> = []
  for (let at = 0; at < neuronIds.length; at += EXISTS_BATCH) {
    batches.push(neuronIds.slice(at, at + EXISTS_BATCH))
  }

  const held = new Set<string>()
  // A few at a time rather than one after another: the Skeletons node's ceiling is ten thousand
  // neurons, which is twenty batches, and every one of them lands before a single skeleton byte
  // is downloaded. Four is `mapWithConcurrency`'s job and is well inside what one deployment
  // answered comfortably at fifty ids in half a second.
  await mapWithConcurrency(batches, EXISTS_CONCURRENCY, async (batch) => {
    const answer = await cavePostRaw<Record<string, boolean>>(
      `${service.base}/exists`,
      `{"skeleton_version":${service.version},"root_ids":[${batch.join(',')}]}`,
      options,
    )
    for (const [id, there] of Object.entries(answer ?? {})) if (there) held.add(id)
  })
  if (neuronIds.length > 0 && held.size === 0) barren.add(keyFor(service.datastack))
  return held
}

/**
 * Whether `automatic` should bother asking this datastack's service.
 *
 * False once a whole set has come back empty — see `barren`. It is a question about a *session*,
 * not about the datastack, which is why it is not persisted anywhere.
 */
export function serviceLooksEmpty(datastack: string): boolean {
  return barren.has(keyFor(datastack))
}

/**
 * Read the skeletons the cache holds, in the order asked for.
 *
 * Only the ids handed in are fetched — the caller has already asked `existingSkeletons` which
 * those are — because a GET for an id the cache does not hold routes to a *generation*, which is
 * tens of seconds per neuron and cannot be told apart from a stalled request.
 *
 * `undefined` from a body is a 404 or an empty blob: an answer, not a failure, exactly as in
 * `precomputed/skeletons.ts`.
 */
export async function readServiceSkeletons(
  service: SkeletonService,
  neuronIds: readonly NeuronId[],
  options: CaveRequestOptions = {},
  onOne?: (id: string, skeleton: SkeletonGeometry) => void,
): Promise<void> {
  await mapWithConcurrency(neuronIds, SERVICE_CONCURRENCY, async (id) => {
    const bytes = await caveGetBytes(`${service.format.base}/${id}`, options).catch(
      (error: unknown) => {
        // One body's failure must not take the batch down — `mapWithConcurrency`'s own rule, and
        // the reason it rethrows only when every item failed.
        if (error instanceof CaveError && error.status >= 500) return undefined
        throw error
      },
    )
    if (!bytes) return
    const body = parseSkeleton(bytes, service.format)
    if (body) onOne?.(id, { id, ...body })
  })
}
