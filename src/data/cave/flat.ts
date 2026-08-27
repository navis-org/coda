/**
 * The flat segmentation published beside a materialization, where there is one.
 *
 * A datastack's own `segmentation_source` is `graphene://` and has to be — a root id is a
 * dynamic agglomeration of supervoxels, which is what CAVE needs for lookups and edits. The cost
 * is that graphene has **no level of detail**: a mesh manifest lists supervoxel fragments at full
 * resolution, so one FlyWire neuron is 492 range requests and ~1.2 MB, and there is nothing
 * cheap to draw a list from.
 *
 * A *released* materialization is frozen, though, and its publishers usually also flatten it
 * into an ordinary precomputed bucket with a mesh pyramid — and, sometimes, skeletons. Nothing
 * in CAVE's metadata mentions one, so `DatastackSpec.flat` names them by hand; see that field
 * for what qualifies and why BANC's is deliberately not listed.
 *
 * ## Everything here is `precomputed/probe.ts`
 *
 * There is no transport in this file. `probePrecomputed` already reads the bucket's `info`,
 * follows it to the mesh and skeleton directories, opens both, memoises the lot and offers a
 * synchronous peek — which is the whole of what a CAVE dataset needs from a bucket. What is
 * genuinely CAVE's is the two lines above it: which URL belongs to `(datastack, version)`, and
 * `reportSourceLearned` when the answer lands, because `capabilitiesFor` is read from `validate`
 * on every graph mutation and may not await one (invariant 2).
 */

import { reportSourceLearned } from '../source'
import type { PrecomputedDescription } from '../precomputed/probe'
import { peekPrecomputed, probePrecomputed } from '../precomputed/probe'
import type { FetchOptions } from '../precomputed/transport'
import { parseNgSource } from '../neuroglancer/sourceUrl'
import type { DatastackSpec } from './spec'

/**
 * Where a materialization's flat bucket is, as something a browser can `fetch`.
 *
 * Through `parseNgSource` rather than by string surgery on `precomputed://gs://…`, so the spec
 * may spell a source the way a neuroglancer layer does and one function knows how a `gs://`
 * bucket becomes a host. Undefined for a version with no entry, which is the ordinary case.
 */
export function flatUrlFor(spec: DatastackSpec, version: number): string | undefined {
  const source = spec.flat?.[version]
  return source ? parseNgSource(source)?.url : undefined
}

/** Buckets a peek has already asked about, so the answer landing is announced exactly once. */
const announced = new Set<string>()

/** Test seam, cleared by `resetCaveState` alongside `precomputed/probe.ts`'s own memo. */
export function resetFlatSources(): void {
  announced.clear()
}

/**
 * What the flat bucket publishes, if that is known right now.
 *
 * `peekL2Cache`'s contract exactly: `undefined` means *not yet* rather than *nothing*, the first
 * look starts the read, and `reportSourceLearned` re-infers when it lands so a node that refused
 * stops refusing on its own. A bucket that turned out to be unreadable is also `undefined` —
 * from a capability's point of view those are the same answer, and the difference is reported
 * where somebody asked for geometry.
 */
export function peekFlat(
  spec: DatastackSpec,
  version: number,
): PrecomputedDescription | undefined {
  const url = flatUrlFor(spec, version)
  if (!url) return undefined
  const settled = peekPrecomputed(url)
  if (settled) return settled.ok ? settled.source : undefined
  if (!announced.has(url)) {
    announced.add(url)
    // Swallowed: a peek has no caller to report to, and the failure is a verdict `probeFlat`
    // will hand to whoever does ask.
    void probePrecomputed(url)
      .then(() => reportSourceLearned('cave'))
      .catch(() => undefined)
  }
  return undefined
}

/** The same answer, awaited. Undefined for a version with no bucket or a bucket that failed. */
export async function probeFlat(
  spec: DatastackSpec,
  version: number,
  options: FetchOptions = {},
): Promise<PrecomputedDescription | undefined> {
  const url = flatUrlFor(spec, version)
  if (!url) return undefined
  const probe = await probePrecomputed(url, options.signal ? { signal: options.signal } : {})
  return probe.ok ? probe.source : undefined
}

/**
 * Where a flat skeleton read starts saying how long it will be.
 *
 * The same hundred as `L2_SKELETON_WARN` and for a different reason, which is why it is its own
 * number rather than that one reused. An L2 skeleton is one node per chunk — a few hundred, tens
 * of kilobytes. These are skeletonised at mip 1 and are **about seventy times heavier**:
 * measured across ten FlyWire v783 neurons, 14,559 to 338,087 nodes, mean 1.8 MB, all ten in
 * 2.0 s at concurrency 8. So a hundred is ~180 MB and ~20 s, which is worth a sentence; the
 * thing the sentence has to carry is the memory, not the wait.
 *
 * It warns rather than refusing, like everything else in `core/limits.ts` — and it is not a
 * `refuseIfOverCrashFloor`, because the per-neuron size varies twentyfold and a refusal computed
 * from a mean would be a guess wearing a floor's authority.
 */
export const FLAT_SKELETON_WARN = 100

/** Mean bytes per flat skeleton, measured over ten FlyWire v783 neurons. Only for the warning. */
export const FLAT_SKELETON_MB = 1.8
