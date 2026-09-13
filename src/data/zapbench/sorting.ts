/**
 * The rastermap ordering, which is what makes the transposed copy of the traces readable.
 *
 * `traces_rastermap_sorted` holds the same numbers as `traces` with its neurons permuted into a
 * 1-D activity embedding, and — the part that matters — with a `transpose` codec, so a neuron's
 * timesteps are **contiguous** instead of 2,048 bytes apart. `sorting.json` is the permutation
 * that connects the two. Without it the sorted copy is unaddressable; with it, reading one
 * neuron's whole trace costs 2 kB a chunk instead of a megabyte.
 *
 * ## What was measured
 *
 * `sorting.json` is 491 kB, a JSON array of 71,721 integers, and a clean permutation of
 * 0…71,720 — checked, not assumed. It reads **sorted position → original column**, so what every
 * caller here wants is its inverse, which is what this module hands back.
 *
 * Verified against the real arrays at five columns including the last: `s0` read through the
 * transpose is **bit-identical** to `traces` at the permuted position. On a scattered selection
 * of 36 neurons over the whole recording the two routes cost 1.1 MiB against 576 MiB, at the
 * same request count — 512× fewer bytes, 3.3× faster.
 *
 * ## Why it is checked at run time rather than trusted
 *
 * `traces` is the published contract: zapbench's own `constants.SPECS` names it as
 * `timeseries`. `traces_rastermap_sorted` is a **derived visualisation product** — its group
 * metadata literally calls itself `"example"`, and it sits beside the fluoroglancer copy. A
 * re-release could re-sort it, or drop it, without that being a breaking change to anything
 * zapbench publishes.
 *
 * A stale permutation would not fail. It would return *a real neuron's real trace* under
 * another neuron's name, which is the same failure mode as the id off-by-one one directory over
 * and gets the same treatment: `verifiedSorting` (in `traces.ts`) reads one cell both ways and compares, once per
 * session, and the reader falls back to `traces` when it disagrees. The fallback is a slower
 * route to the identical answer, so the cost of being wrong about this is latency rather than
 * correctness.
 */

/*
 * **Nothing is imported from `traces.ts`.** The two modules reference each other, and a cycle is
 * only safe while every read happens inside a function: a module-scope one gets an uninitialised
 * binding. That is not theoretical — building the sorted path here as
 * `` `${ZAPBENCH_RELEASE}/traces_rastermap_sorted` `` produced the literal string
 * `"undefined/traces_rastermap_sorted"` under the ordinary import order, silently, because
 * vite-node hands a half-evaluated module's namespace back as an object rather than throwing;
 * a real browser ESM build would have thrown a TDZ `ReferenceError` instead. Every test passed,
 * because none of them asserted the base. So the release path and the shape come in as
 * arguments, and this module knows nothing about where the array lives.
 */

import { cacheDelete, cacheGet, cacheSet } from '../cache'
import { fetchText } from '../fetchText'

/**
 * The cache key carries the **caller's** release id.
 *
 * Hand-typing the date here would put `20240930` in two files — this one and the release path in
 * `traces.ts` — so a re-release would edit one and go on serving the old permutation out of
 * IndexedDB from the other, silently. The module header's claim to know nothing about where the
 * array lives has to include *when* it lives.
 */
function cacheKeyFor(release: string): string {
  return `zapbench-sorting:${release}`
}

/** A released file at a dated path — this is about noticing a re-release, not staying current. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Original trace column → its position in the sorted copy, or `undefined` if unavailable.
 *
 * **Undefined rather than throwing**: every caller has a working slower route, so failing to
 * reach an optional optimisation must not fail the read. A malformed or wrong-length file is
 * the same answer as a network failure for the same reason.
 */
export async function loadTraceSorting(options: {
  /** Full URL of `sorting.json`; the caller owns where the release lives. */
  url: string
  /** Identifies the release, so a re-release cannot be answered from the old cached copy. */
  release: string
  /** How many columns the array has, so a file of the wrong length is refused. */
  columns: number
  signal?: AbortSignal | undefined
  refresh?: boolean | undefined
}): Promise<Int32Array | undefined> {
  /*
   * **No `memoPromise` here.** The only caller is `verifiedSorting`, which memoises with
   * `keep: 'resolved'` — so a second memo in front of it could never be hit, and it cost a second
   * `refresh` branch and a third thing for the reset to clear. What stays is the persistent
   * layer, which is cross-session and does real work.
   */
  const key = cacheKeyFor(options.release)
  if (!options.refresh) {
    const hit = await cacheGet<Int32Array>(key, { maxAgeMs: MAX_AGE_MS })
    // A structured clone round-trips a typed array as itself, but a stored value from an older
    // build could be anything, so the shape is re-checked rather than assumed.
    if (hit instanceof Int32Array && hit.length === options.columns) return hit
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(
      await fetchText(options.url, {
        ...(options.signal ? { signal: options.signal } : {}),
      }),
    )
  } catch {
    return undefined
  }
  const inverse = invertSorting(parsed, options.columns)
  if (inverse) void cacheSet(key, inverse)
  return inverse
}

/**
 * The parsed file as an original→sorted lookup, or `undefined` if it is not a permutation.
 *
 * Checked in full rather than sampled: a file that is *nearly* a permutation — one duplicate,
 * one missing — would silently give two neurons the same trace and lose a third, and the check
 * costs one pass over 71,721 integers. The `seen` pass is what catches a duplicate, which a
 * length-and-range check alone would not.
 */
export function invertSorting(parsed: unknown, columns: number): Int32Array | undefined {
  if (!Array.isArray(parsed) || parsed.length !== columns) return undefined
  const inverse = new Int32Array(columns).fill(-1)
  for (let position = 0; position < parsed.length; position++) {
    const original = parsed[position]
    if (!Number.isInteger(original) || original < 0 || original >= columns) return undefined
    if (inverse[original] !== -1) return undefined
    inverse[original] = position
  }
  return inverse
}

/**
 * Forget the permutation entirely — `resetTraceCache`'s sibling, for tests.
 *
 * **Both layers, and the persistent one is the half that matters.** Clearing only the session
 * memo left the `cacheSet` copy in place, so a test that had served a sorted store poisoned every
 * later test in the file: `loadTraceSorting` answered from the cache without fetching, the
 * verification probe then read a sorted chunk the current stub does not serve, and the extra
 * requests landed in an assertion counting reads. `cacheDelete` drops the in-memory layer
 * synchronously — before its own await — which is what makes this usable from a `beforeEach`.
 */
export function resetTraceSorting(release: string): void {
  void cacheDelete(cacheKeyFor(release))
}
