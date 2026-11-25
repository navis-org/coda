/**
 * Whether an annotation's root ids were still current when a materialization was frozen.
 *
 * A CAVE root id is not stable: proofreading merges and splits retire an id and mint new ones.
 * An annotation base is somebody's spreadsheet, edited on its own schedule, so its ids drift out
 * of step with a *pinned* materialization — and nothing says so. The labels simply stop matching
 * neurons, the joins come back empty for those rows, and the dataset looks under-annotated.
 *
 * **This is a heads-up, not a gate.** It runs after the value has been built, never blocks a
 * run, and its absence is not an error — a check that has not come back yet, or a datastack with
 * no chunkedgraph, both say nothing. What it produces is a count and a few examples for the
 * dataset node's badge.
 *
 * The call is `caveclient.chunkedgraph.is_latest_roots`, read off caveclient 8.2.1 rather than
 * recalled: `POST {cg}/segmentation/api/v1/table/{table}/is_latest_roots?timestamp=<epoch
 * seconds>` with `{"node_ids": [...]}`, answering `{"is_latest": [bool, ...]}`. The timestamp is
 * the materialization's own `time_stamp`, which `versionsMetadata` already returns.
 */

import { cacheGet, cacheSet } from '../cache'
import type { Slots } from '../concurrency'
import { inFlight, slots } from '../concurrency'
import type { CaveRequestOptions } from './client'
import {
  CaveError,
  cavePostBinary,
  cavePostRaw,
  cavePostRawOnce,
  readAgain,
  sharedRequestOptions,
} from './client'
import type { SharedAsk } from '../memoPromise'
import { shareInFlight } from '../memoPromise'
import { datastackRecord, materializationsFor, versionFrozenAt } from './datastack'
import { deploymentKey } from './deployments'
import type { GrapheneSource } from './graphene'
import { parseGrapheneSource, tableUrl } from './graphene'
import { channel } from '../channel'
import { countStrings, distinctStrings } from '../../core/collections'
import { compareIds, isSegmentId } from '../../core/ids'
import { LruMap } from '../../core/lruMap'

/**
 * What a completed check found.
 *
 * `checked` rather than a bare fraction because the message has to be true about what was
 * actually asked: a set larger than `MAX_ROOTS_CHECKED` is checked in part, and a claim about
 * "your ids" would then be a claim about ids nobody looked at.
 */
export interface RootCheck {
  /** How many distinct ids were judged. */
  checked: number
  /** How many of those were not current at the materialization. */
  stale: number
  /** A few of them, for a message that can be acted on. */
  examples: readonly string[]
  /** Distinct ids the chain carried, which `checked` may fall short of. */
  total: number
}

/**
 * A backstop rather than a budget. At roughly 50–100 µs a root server-side this is a few seconds
 * of somebody else's service, paid once — see the cache below, which makes the second run free.
 */
const MAX_ROOTS_CHECKED = 250_000

/** Ids per request. caveclient sends one call; this splits it so no single body is enormous. */
const CHUNK = 10_000

/**
 * How many `roots_binary` requests one `rootsAtInstant` call keeps in flight — four, the
 * streams SEAM's own fetching holds at Aedes, for SEAM's invariant 8.
 *
 * **A cap per call, not the run's share of the server**: several calls run at once in Suggest
 * Merges, and what bounds them together is `CHUNKEDGRAPH_BUDGET`.
 */
const ROOT_STREAMS = 4

/**
 * The fewest ids worth a request of their own. A request costs ~145 ms however small (Aedes,
 * 2026-11-18), so splitting 900 ids four ways measured 182 ms against 222 — not worth four
 * requests at a shared server. Below twice this, a lookup stays one request.
 */
const ROOT_PIECE_MIN = 1_000

/** How many stale ids a message names. Enough to paste into a search, short enough to read. */
const EXAMPLES = 3

/**
 * Bump when what is stored changes shape. The `SHAPE_FORMAT` lesson: an entry kept indefinitely
 * outlives the code that wrote it unless something in the key says which code that was.
 */
const STORE_FORMAT = 1

/**
 * What is known about one dataset node's annotations, and which chain produced it.
 *
 * The `key` is the whole reason this is an entry rather than a bare result. A check is about a
 * *particular* set of ids, and those ids change the moment somebody drops an `Update root IDs`
 * between the base and the dataset — which is exactly the moment the answer matters most. Keyed
 * on the deployment and the dataset id, because that is all `validate` can see; carrying the
 * chain's provenance key, so a changed chain replaces the answer instead of being served the
 * previous one.
 */
interface Entry {
  /** `ctx.inputKey('annotations')`, or `''` where nothing is wired. */
  key: string
  /** Absent while a check is in flight, and where there was nothing to check. */
  check?: RootCheck
}

const entries = new Map<string, Entry>()

const learned = channel()
/**
 * Fired when a check lands *or is dropped*, so `validate` is asked again. `reportSourceLearned`'s
 * terms. The drop half matters: a run does not re-infer, so without it a warning about a chain
 * somebody has just replaced stays on the card until the next unrelated edit.
 */
export const subscribeRootCheck = learned.subscribe

/** What a finished check found for a dataset, or undefined while nothing is known. */
export function peekRootCheck(deployment: string, datasetId: string): RootCheck | undefined {
  return entries.get(deploymentKey(deployment, datasetId))?.check
}

/** Test seam, and what a Clear Cache on the dataset would reach. */
export function resetRootChecks(): void {
  entries.clear()
  recent.clear()
  remembered.clear()
}

/**
 * Start a check, unless this dataset's answer is already about this very chain.
 *
 * Deliberately returns nothing and never rejects: a caller is `evaluate`, which must not wait for
 * it and must not fail because of it. Asked **once per (dataset, chain)** — the ids arrive on
 * every run, so re-asking per run is the hammering this exists to avoid, while never re-asking at
 * all leaves the answer describing a chain that is no longer on the canvas.
 *
 * `chainKey` is the annotations port's provenance key, which changes exactly when the table would
 * (invariant 4). Undefined — nothing wired — is a real key rather than a reason to keep the last
 * one, or unplugging the annotations would leave a warning about ids the graph no longer holds.
 */
export function startRootCheck(
  datasetId: string,
  chainKey: string | undefined,
  ids: readonly string[],
  options: CaveRequestOptions,
): void {
  const key = chainKey ?? ''
  const at = deploymentKey(options.deployment, datasetId)
  if (entries.get(at)?.key === key) return

  /*
   * The previous answer goes *now*, before the new one is known. It was about a chain that is no
   * longer there, and leaving it up until the replacement lands is the bug this fixed: a warning
   * that survived the repair it asked for reads as the repair not having worked.
   */
  const had = entries.get(at)?.check !== undefined
  entries.set(at, { key })
  // Deferred, because `notify` re-runs inference and the caller is inside a node's `evaluate`.
  if (had) queueMicrotask(() => learned.notify())
  if (ids.length === 0) return

  void run(datasetId, ids, options)
    .then((result) => {
      // Undefined is a settled "nothing to say" — no chunkedgraph, or no timestamp — so the
      // entry stays claimed and nothing asks again.
      if (!result) return
      // A newer chain may have arrived while this was in flight; it owns the entry now.
      if (entries.get(at)?.key !== key) return
      entries.set(at, { key, check: result })
      learned.notify()
    })
    .catch(() => {
      /*
       * Swallowed — an advisory that could not be produced has nothing to say, and a 401 already
       * travels to the Connections panel on its own channel. The claim is released, though: a
       * dropped connection is not an answer, so the next run asks again rather than the session
       * going quiet about a base that may well be drifting.
       */
      if (entries.get(at)?.key === key) entries.delete(at)
    })
}

async function run(
  datasetId: string,
  ids: readonly string[],
  options: CaveRequestOptions,
): Promise<RootCheck | undefined> {
  const [datastack, versionText] = datasetId.split(':')
  const version = Number(versionText)
  if (!datastack || !Number.isInteger(version)) return undefined

  const graphene = await grapheneFor(datastack, options)
  const at = await frozenAt(datastack, version, options)
  if (!graphene || at === undefined) return undefined

  // Distinct, in first-occurrence order. An annotation base carries repeats — measured at 1,089
  // neurons on FlyTable's `main.info` — and checking one twice is a request nobody needed.
  const distinct = [...new Set(ids)].filter((id) => id !== '')
  const wanted = distinct.slice(0, MAX_ROOTS_CHECKED)
  const { stale } = await judge(graphene, { at, keep: 'forever' }, wanted, options)

  const bad = wanted.filter((id) => stale.has(id))
  return {
    checked: wanted.length,
    stale: bad.length,
    examples: bad.slice(0, EXAMPLES),
    total: distinct.length,
  }
}

/** The chunkedgraph behind a datastack, or undefined where there is none. */
export async function grapheneFor(
  datastack: string,
  options: CaveRequestOptions,
): Promise<GrapheneSource | undefined> {
  const info = await datastackRecord(datastack, options)
  // Not a chunkedgraph at all, so root ids do not move and none of this applies.
  return parseGrapheneSource(info.segmentation_source)
}

/**
 * When a materialization was frozen, in epoch ms.
 *
 * Read from memory first: a frozen instant never changes, and the listing's memo holds only the
 * request in flight, so awaiting it each time is a fresh `/metadata` round trip per call — two
 * per repair. Only a miss awaits the listing, which fills `versionFrozenAt` as a side effect.
 */
async function frozenAt(
  datastack: string,
  version: number,
  options: CaveRequestOptions,
): Promise<number | undefined> {
  const known = versionFrozenAt(options.deployment, datastack, version)
  if (known !== undefined) return known
  await materializationsFor(datastack, options)
  return versionFrozenAt(options.deployment, datastack, version)
}

/**
 * Which of these ids the chunkedgraph still called current at that instant, asking only about the
 * ones nobody has asked about before.
 *
 * **The persistent half, and the reason this is cheap after the first time:** whether a root was
 * current at a past instant never changes, so an answer is good forever. Keyed on the
 * chunkedgraph table and the frozen timestamp, which together are what the answer is *about* —
 * not on the dataset, so two datastack nodes on one segmentation share it, and not on the id
 * list, so a base that gained rows only costs the rows it gained.
 */
async function judge(
  graphene: GrapheneSource,
  asked: AskedAt,
  wanted: readonly string[],
  options: CaveRequestOptions,
): Promise<{ latest: Set<string>; stale: Set<string> }> {
  const { at } = asked
  const key = `cave-roots:${graphene.server}|${graphene.table}|${at}`
  const held = await readKept<{ latest: string[]; stale: string[] }>(key, asked)
  const latest = new Set(held?.latest ?? [])
  const stale = new Set(held?.stale ?? [])

  const unknown = wanted.filter((id) => !latest.has(id) && !stale.has(id))
  for (let i = 0; i < unknown.length; i += CHUNK) {
    // Sequential on purpose. This is an advisory against a shared production service; firing
    // every chunk at once would be the hammering it exists to avoid.
    const batch = unknown.slice(i, i + CHUNK)
    const answer = await isLatestRoots(graphene, batch, at, options)
    for (let k = 0; k < batch.length; k++) {
      ;(answer[k] === false ? stale : latest).add(batch[k]!)
    }
  }
  if (unknown.length > 0) keep(key, { latest: [...latest], stale: [...stale] }, asked)
  return { latest, stale }
}

/**
 * The instant a repair asks the chunkedgraph about, in epoch ms, and how long its answers last.
 *
 * - `version`: a materialization's frozen instant. Its answers are good forever.
 * - `boundary`: a past instant the caller expects to ask about again — every run until the next
 *   one. Held for the session, newest only.
 * - `now`: this run's own moment, a new one every time. Held by nobody.
 * - `pinned`: a past instant the caller **stated**. Good forever, like a version's.
 *
 * **`now` and `pinned` are the same number with opposite cache rules**, which is why they are
 * two arms rather than one with a flag. What a root was at a *past* instant never changes, so a
 * stated one is as permanently cacheable as a materialization's — and a search asking about one
 * snapshot across hundreds of open ends would otherwise re-ask the chunkedgraph every time, which
 * is the hammering this file exists to avoid. A moment picked by the clock is the opposite: never
 * asked about twice, so a permanent entry per moment is a store that only grows.
 *
 * The caller picks the moment rather than each request taking the server's "now", because a repair
 * is two calls — which ids moved, then where their supervoxels (or chunks) went — and both have to be about the
 * same instant, or an edit landing between them leaves a row repointed at a root that was itself
 * already retired.
 */
export type RootsAt =
  { version: number } | { boundary: number } | { now: number } | { pinned: number }

/**
 * A resolved instant and where answers about it are kept.
 *
 * `forever` is the IndexedDB store. Nothing else may go there, because it has no eviction: a
 * caller-picked moment is a new one every time, so a permanent entry per moment is a store that
 * only grows. `session` is `recent`, which holds one moment per segmentation and lets the next
 * replace it. Decided once, in `askedAt`, and honoured only through `readKept`/`keep`, so no cache
 * user here can forget one half of it.
 */
interface AskedAt {
  at: number
  keep: 'forever' | 'session' | 'never'
}

/**
 * Answers about the newest `boundary` asked, per store and segmentation — the key without its
 * instant. A later boundary replaces the entry, so this never holds more than one per slot.
 */
const recent = new Map<string, { key: string; value: unknown }>()

/** The key with its trailing instant removed: one slot per store and segmentation. */
function slotOf(key: string): string {
  return key.slice(0, key.lastIndexOf('|'))
}

/**
 * How far in the past a stated instant must be before its answers are kept forever.
 *
 * A guard on the cache, not on the question. The permanent store has no eviction, so an entry
 * may only go in where the answer cannot change — and an instant near *now* is one the
 * chunkedgraph may still be receiving edits for. A minute is far more than the clock skew
 * between a browser and CAVE, and a caller pinning a snapshot is pinning something older than
 * that by construction.
 */
const PINNED_MIN_AGE_MS = 60_000

async function askedAt(
  datastack: string,
  when: RootsAt,
  options: CaveRequestOptions,
): Promise<AskedAt | undefined> {
  if ('now' in when) return { at: when.now, keep: 'never' }
  if ('pinned' in when) {
    // Not past enough to be settled: answered, but not written to a store that never evicts.
    const settled = when.pinned < Date.now() - PINNED_MIN_AGE_MS
    return { at: when.pinned, keep: settled ? 'forever' : 'never' }
  }
  if ('boundary' in when) return { at: when.boundary, keep: 'session' }
  const frozen = await frozenAt(datastack, when.version, options)
  return frozen === undefined ? undefined : { at: frozen, keep: 'forever' }
}

/** What is held about an instant, or nothing where its answers are not kept. */
async function readKept<T>(key: string, asked: AskedAt): Promise<T | undefined> {
  if (asked.keep === 'forever') return cacheGet<T>(key, { fingerprint: `v${STORE_FORMAT}` })
  if (asked.keep === 'session') {
    const held = recent.get(slotOf(key))
    return held?.key === key ? (held.value as T) : undefined
  }
  return undefined
}

/** Hold answers about an instant, for as long as they are worth holding. */
function keep(key: string, value: unknown, asked: AskedAt): void {
  if (asked.keep === 'forever') void cacheSet(key, value, `v${STORE_FORMAT}`)
  else if (asked.keep === 'session') recent.set(slotOf(key), { key, value })
}

/**
 * Which of these root ids were **not** current at an instant.
 *
 * The same call and the same permanent cache the advisory uses, answering per id rather than as a
 * count — because the Update root IDs node needs to know *which* rows to repair, and asking twice
 * would be two passes over somebody's chunkedgraph for one question.
 */
export async function staleRoots(
  datastack: string,
  when: RootsAt,
  ids: readonly string[],
  options: CaveRequestOptions,
): Promise<Set<string>> {
  const graphene = await grapheneFor(datastack, options)
  // Not a chunkedgraph: root ids do not move there, so every one is current — a real answer.
  if (!graphene) return new Set()
  const asked = await askedAt(datastack, when, options)
  /*
   * A materialization with no frozen instant is *not* an answer, and an empty set here would read
   * as "nothing moved" — a table handed back as current, with a confidence of 1 on every row under
   * a majority vote, about ids nobody checked.
   */
  if (!asked) {
    const version = 'version' in when ? when.version : ''
    throw new Error(
      `Materialization ${version} of ${datastack} has no timestamp CAVE lists, so there is no ` +
        `instant to check the ids against. Pick a materialization the datastack lists.`,
    )
  }
  const { stale } = await judge(graphene, asked, distinctStrings(ids), options)
  return stale
}

/**
 * The root id each supervoxel belonged to at an instant.
 *
 * `caveclient.chunkedgraph.get_roots`, which is `roots_binary` — raw `uint64` in and out, so a
 * root id crosses exactly with nothing parsed or rounded (invariant 8, for once made easy).
 *
 * **Cached permanently at a materialization, like the staleness check beside it and for the same
 * reason**: which segment a supervoxel belonged to at a *past* instant never changes. Any other
 * moment is held for as long as `RootsAt` says, and no longer. A supervoxel is the atom of
 * the segmentation — proofreading regroups them, it does not split them — so this is the stable
 * handle a root id is not, which is the whole reason a repair is possible at all.
 *
 * Answers a map rather than an array, since callers ask about the rows that moved rather than
 * about every row, and a `0` — a supervoxel the graph does not know — is left out rather than
 * returned as a root nothing owns.
 */
export async function rootsForSupervoxels(
  datastack: string,
  when: RootsAt,
  supervoxels: readonly string[],
  options: CaveRequestOptions,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const graphene = await grapheneFor(datastack, options)
  const asked = await askedAt(datastack, when, options)
  if (!graphene || !asked) return out

  const key = `cave-sv-roots:${graphene.server}|${graphene.table}|${asked.at}`
  const held = await readKept<{ sv: string[]; root: string[] }>(key, asked)
  for (let i = 0; i < (held?.sv.length ?? 0); i++) out.set(held!.sv[i]!, held!.root[i]!)

  const unknown = distinctStrings(supervoxels).filter((id) => !out.has(id))
  for (const [sv, root] of await placeNodes(graphene, unknown, asked.at, options)) {
    out.set(sv, root)
  }
  if (unknown.length > 0) keep(key, { sv: [...out.keys()], root: [...out.values()] }, asked)
  return out
}

/**
 * The instant a `RootsAt` names, or `undefined` where the datastack does not name one.
 *
 * Exported for a caller that asks about **many** sets of ids at one moment and so must resolve it
 * once: `rootsAtInstant` below takes the number, not the `RootsAt`, precisely so that a
 * materialization CAVE does not list is a refusal the caller can make *before* its first request
 * rather than an empty answer repeated per call. `staleRoots` takes the same decision in prose
 * forty lines above, for the same reason.
 */
export async function instantOf(
  datastack: string,
  when: RootsAt,
  options: CaveRequestOptions,
): Promise<number | undefined> {
  return (await askedAt(datastack, when, options))?.at
}

/**
 * The root of each supervoxel at an instant, **64-bit throughout and without the shared store.**
 *
 * `rootsForSupervoxels` above keeps one entry per `(server, table, instant)` and grows it: every
 * call rebuilds the whole accumulated map and writes it back. That is right for the repair paths,
 * which ask once per run about the handles of one table. It is quadratic for a caller that asks
 * **per box** — SEAM's candidate search reads a ~14,000-supervoxel cutout per open end and a
 * neuron is hundreds of them, so by the last end each call would rebuild and re-persist a table
 * of millions before asking about anything. The store also has no eviction (`AskedAt`'s note),
 * and a run's supervoxels are not a set worth keeping forever.
 *
 * So this is the batched, rate-limited fetch with the caching left to the caller, and the caller
 * is expected to do it: a `BoxReader` (`packs/seam/rootedBox.ts`) holds one map per reader, which is what
 * makes the overlap between neighbouring ends free.
 *
 * **Parallel to its input, `0n` where the graph lists none** — the same "0 = no object" the
 * vendored `summarize_cutout` reads, so a caller writing the answer into a cutout needs no second
 * sentinel. Ids never become text on this path: a decimal string per supervoxel is what the
 * caller would then have to retain, and at a run's scale that is the larger half of its memory.
 */
export async function rootsAtInstant(
  graphene: GrapheneSource,
  at: Instant,
  supervoxels: BigUint64Array,
  options: CaveRequestOptions,
  stopLayer?: number,
): Promise<BigUint64Array> {
  /*
   * **Label 0 is answered here, as root 0, and never sent.** It is "no object" in every
   * segmentation — the background of a box, not a supervoxel — and this function's contract is
   * already `0n` for "no object". Answering it here is what lets every caller test the root alone
   * (`summarize_cutout` reads only the root; `mergeAnchors.ts` the same) instead of each guarding
   * the label too, and it keeps the background out of every box's request.
   *
   * Filtered only when there is one: after a reader's first box its memo holds `0n`, so label 0
   * almost never reaches here, and an unconditional `filter` copied every box's ids to remove
   * nothing (0.36 ms per 14,000 ids, against 0.015 ms to look; measured 2026-11-16).
   */
  const asked =
    supervoxels.indexOf(0n) < 0 ? supervoxels : supervoxels.filter((id) => id !== 0n)
  const answered = new BigUint64Array(asked.length)
  /*
   * **Split across `ROOT_STREAMS` requests in flight**, each at least `ROOT_PIECE_MIN` ids and
   * at most `CHUNK`. The time is the server's, per id: one request of 7,200 supervoxels took
   * 741 ms where the same count as four requests at once took 335 (Aedes, 2026-11-18), against
   * a floor of ~145 ms for a request of ten. So a box's lookup — which is one request, and the
   * largest single wait in a Suggest Merges end — is worth splitting, and a small one is not.
   *
   * Pieces of one answer, so `inFlight` (`l2ChunkCounts`' reason): a piece that failed must
   * fail the lookup rather than come back as ids left at `0n`, which would be remembered as
   * "no object".
   */
  const pieces = Math.max(1, Math.min(ROOT_STREAMS, Math.floor(asked.length / ROOT_PIECE_MIN)))
  const size = Math.max(1, Math.min(CHUNK, Math.ceil(asked.length / pieces)))
  const starts = Array.from({ length: Math.ceil(asked.length / size) }, (_, k) => k * size)
  await inFlight(starts, ROOT_STREAMS, async (i) => {
    /*
     * The ids go as they are, never through text, which cost four times the filter above on
     * every box (1.5 ms per 14,000 ids). A view is fine: `cavePostBinary` sends its own bytes.
     */
    const batch = asked.subarray(i, i + size)
    const answer = await rootsBinary(graphene, batch, at, options, stopLayer)
    /*
     * One root per id, or it is not an answer. Filled with `0n`, a short reply would read as
     * "no object" for every id past its end — remembered by a reader's memo, and reported by the
     * merge anchors as a neuron edited away. A server or proxy fault is said as one.
     */
    if (answer.length !== batch.length) {
      throw new CaveError(
        `The chunkedgraph answered ${answer.length} roots for ${batch.length} supervoxels, so ` +
          'which answer belongs to which is unknown. Try again; if it persists, the server is at fault.',
      )
    }
    answered.set(answer, i)
  })
  if (asked.length === supervoxels.length) return answered
  const out = new BigUint64Array(supervoxels.length)
  for (let i = 0, next = 0; i < supervoxels.length; i++) {
    if (supervoxels[i] !== 0n) out[i] = answered[next++]!
  }
  return out
}

/**
 * The root each node id belonged to at an instant, uncached — `roots_binary` takes a node at any
 * layer, a supervoxel or a level-2 chunk alike. A `0` ("no such node here") is left out.
 */
async function placeNodes(
  graphene: GrapheneSource,
  ids: readonly string[],
  at: number,
  options: CaveRequestOptions,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (let i = 0; i < ids.length; i += CHUNK) {
    // Sequential, like the staleness check: an advisory repair has no business firing every
    // chunk at a shared production service at once.
    const batch = ids.slice(i, i + CHUNK)
    const answer = await getRoots(graphene, batch, at, options)
    for (let k = 0; k < batch.length; k++) {
      const root = answer[k]
      // `0` is "no such node here" — not a root, and not something to write into a table.
      if (root !== undefined && root !== 0n) out.set(batch[k]!, String(root))
    }
  }
  return out
}

/**
 * How many of a stale root's level-2 chunks are asked where they went. Enough that a two-thirds
 * winner is far outside what sampling alone could produce (the standard error of a share at 100
 * draws is under 0.05), and small enough that a whole stale base is a handful of `roots_binary`
 * batches rather than one per neuron.
 */
export const VOTE_SAMPLE = 100

/**
 * Roots per `leaves_many` request for `l2ChunkCounts`. A reply is one count a root where the
 * server takes `counts_only` (`leavesCounts`), else the chunk ids as text, ~25 bytes an id; the
 * time is the server's either way — parsing a list reply takes 2 ms of a 525 ms request.
 *
 * **Counts did not move it** (2026-11-25, Aedes on 2.21.1, `scripts/probe-count-batches.mjs`):
 * the per-id cost is the server's lookup, not the reply — ~60 ms per thousand level-2 ids with
 * counts, ~53 with lists — so a larger request still waits on its biggest root. 160 × 2 was the
 * fastest setting cold and warm.
 *
 * **160 at two streams, because it is as fast as fifty at four with a third of the requests**
 * (2026-11-20, Aedes; `docs/seam-suggestions-plan.md`, "count batches"). An end asks ~320 new
 * roots. Replayed against the server, cold: 172 ms per 100 roots at fifty by four, 184 at 160 by
 * two, 203 for a whole end in one request. Through the node, 40-end blocks never asked before,
 * the stage's median per end was 776 and 936 ms against 783 and 951 — and the same roots warm,
 * interleaved, 210-251 ms per 100 roots against 212-216. The CAVE maintainers asked for fewer,
 * larger requests; at a tie on time that is the kinder setting at a shared server.
 *
 * **Larger does not pay**, because the server does not split a request: its time is ~175 ms
 * plus 67 per thousand level-2 ids in it, so one request for a whole end waits on its biggest
 * root alone. **Smaller did not pay either**: twenty-five at eight streams, 3.3 s an end
 * against 3.2, inside run-to-run noise.
 */
const LEAVES_CHUNK = 160

/**
 * How many `leaves_many` requests one `l2ChunkCounts` call keeps in flight. With
 * `LEAVES_CHUNK` that is an end's ~320 roots in one round.
 *
 * **Concurrency at all, because this was the largest stage in a run and the batches are a
 * queue.** Sent one after another, fifty roots a request, `Suggest Merges` measured the stage
 * at **33% of a 6.2 s end** — more than the GPU, the search box or the patch box. Four in flight
 * took it from 2.05 s to 0.83; 160 a request at two holds that with a third of the requests.
 *
 * **It is a rate limit, not the absence of one**, which is the half of SEAM's invariant 8 this
 * has to keep: the servers are shared and public. SEAM's own fetching holds four streams at
 * Aedes, `MESH_CONCURRENCY` is three and `fragmentConcurrencyFor` divides a budget rather than
 * removing it. Several ends' calls overlap in a run; `CHUNKEDGRAPH_BUDGET` caps them together.
 *
 * `inFlight` rather than `mapWithConcurrency`: the batches are **pieces of one answer**, and
 * `src/data/concurrency.ts`' header is about exactly that difference. A forgiven batch here
 * would come back as roots missing from the map, which `countsInPoolOrder` would then refuse as
 * a hole in the pool — a request failure reported as a fact about the data.
 */
const LEAVES_STREAMS = 2

/**
 * Stale roots per `leaves_many` request in `rootsByMajority`. Fifty, the size `l2ChunkCounts`
 * used before it went to `LEAVES_CHUNK`'s 160: the batch measurements were of candidate pools,
 * mostly one-chunk flakes, and a stale root here is a whole neuron of thousands, so a larger
 * batch is a larger reply nobody has timed. An advisory repair, sequential on purpose.
 */
const VOTE_BATCH = 50

/** The chunkedgraph layer a vote samples. Level 2 is a neuron's chunks; level 1 its supervoxels. */
const VOTE_LAYER = 2

/** Where a stale root went by majority: the root holding most of its sample, and that share. */
export interface MajorityRoot {
  root: string
  /** The winner's share of the sampled chunks CAVE could place, in (0, 1]. */
  share: number
}

/**
 * Where each stale root went at an instant, by a majority of its own chunks.
 *
 * The route for a table that carries no supervoxel: a root id is immutable — an edit mints a new
 * one rather than changing the old — so the chunks a retired root was made of are still listed
 * under it. Each is asked which root it belonged to at the instant, and the root holding most of
 * them wins. A merge leaves one answer; a split leaves several, and the share says how much of
 * the old neuron the winner kept. `fafbseg.flywire.update_ids` with a timestamp, sampled.
 *
 * Level-2 chunks rather than supervoxels, because a neuron is thousands of the first and millions
 * of the second, and only a hundred are asked about either way.
 *
 * **What is kept is the verdict, one pair per root**, under `RootsAt`'s lifetimes like every other
 * answer here — not the samples or the chunk lookups, which are a hundred times the size and buy
 * only a cheaper first run at a *second* instant. A root CAVE answers no chunks for, or whose every
 * chunk answers `0`, is left out of the map and asked again next time.
 */
export async function rootsByMajority(
  datastack: string,
  when: RootsAt,
  roots: readonly string[],
  options: CaveRequestOptions,
): Promise<Map<string, MajorityRoot>> {
  const out = new Map<string, MajorityRoot>()
  const graphene = await grapheneFor(datastack, options)
  const asked = await askedAt(datastack, when, options)
  if (!graphene || !asked) return out

  const key = `cave-votes:${graphene.server}|${graphene.table}|${VOTE_SAMPLE}|${asked.at}`
  const held = await readKept<Record<string, MajorityRoot>>(key, asked)
  for (const root of roots) {
    const verdict = held?.[root]
    if (verdict) out.set(root, verdict)
  }
  const unknown = distinctStrings(roots).filter((root) => !out.has(root))
  for (let i = 0; i < unknown.length; i += VOTE_BATCH) {
    /*
     * Sequential on purpose. This is the advisory repair, not a path anybody is waiting on —
     * `l2ChunkCounts` is the one loop here that goes concurrent, because it is a third of the
     * wait in an interactive run and this is not.
     */
    const lists = await leavesMany(graphene, unknown.slice(i, i + VOTE_BATCH), options)
    const samples = new Map([...lists].map(([root, ids]) => [root, strided(ids)]))
    // Distinct: a stale root and its stale descendant in one batch share chunks.
    const chunks = distinctStrings([...samples.values()].flat())
    const placed = await placeNodes(graphene, chunks, asked.at, options)
    /*
     * A chunk an edit touched is itself retired, and placing a retired chunk can answer a root
     * that is not current at the instant — the stale root, or one from mid-history. That is never
     * the right answer to write, so such a vote abstains; the check is `judge`'s own, cached.
     */
    const { stale } = await judge(
      graphene,
      asked,
      distinctStrings([...placed.values()]),
      options,
    )
    for (const [old, sample] of samples) {
      const current = sample.map((chunk) => placed.get(chunk))
      const verdict = majorityOf(
        current.map((root) => (root && stale.has(root) ? undefined : root)),
      )
      if (verdict) out.set(old, verdict)
    }
  }
  if (unknown.some((root) => out.has(root))) {
    keep(key, { ...held, ...Object.fromEntries(out) }, asked)
  }
  return out
}

/** The root most of these chunks were placed in, a tie going to the lower id; unplaced ones abstain. */
function majorityOf(placed: readonly (string | undefined)[]): MajorityRoot | undefined {
  let best: string | undefined
  let most = 0
  let counted = 0
  for (const [root, n] of countStrings(placed)) {
    counted += n
    // The tie-break makes a rerun answer the same thing whatever order CAVE sent.
    if (n > most || (n === most && compareIds(root, best!) < 0)) {
      best = root
      most = n
    }
  }
  return best === undefined ? undefined : { root: best, share: most / counted }
}

/**
 * `VOTE_SAMPLE` ids evenly strided over the sorted list, or all of them where there are fewer.
 *
 * **Strided, not random**: a provenance key promises the same answer for the same input
 * (invariant 4), and a chunk id's high bits are its position in the volume, so sorted order
 * spreads the stride across the neuron rather than bunching it in one arbour.
 *
 * **It copies before sorting**, and the copy is not ceremony. This used to sort in place and
 * say so — "the caller handing over a fresh array" — which held while the only call site was
 * `strided(listed.map(String))` on the next line. `leavesMany` returns arrays other callers keep
 * (`levelTwoChunks`, `chunkSupervoxels`), and a sort in place would reorder what they hold.
 */
function strided(ids: readonly string[]): string[] {
  const sorted = [...ids].sort(compareIds)
  if (sorted.length <= VOTE_SAMPLE) return sorted
  return Array.from(
    { length: VOTE_SAMPLE },
    (_, k) => sorted[Math.floor((k * sorted.length) / VOTE_SAMPLE)]!,
  )
}

/**
 * Each root's level-2 chunks, from `leaves_many`. Only roots with chunks listed are in the answer.
 *
 * **Whole lists, not a sample.** The majority vote wants `VOTE_SAMPLE` strided ids and applies
 * `strided` itself; a count wants the length, which a sample of a fixed size has thrown away.
 * Striding here served one caller and silently answered the other with 100.
 *
 * `caveclient.chunkedgraph.get_leaves_many`: `POST …/node/leaves_many?stop_layer=2` with
 * `{"node_ids": [...]}`, answering `{"<root>": [chunk ids]}`. The body is spliced as text, as
 * `isLatestRoots`' is, and the reply's ids come back as text through `parseCaveJson`. An id the
 * graph does not know comes back absent (FlyWire, 2026-10-20) or as an empty list (Aedes on
 * 2.20.0, 2026-11-25); both are "not listed".
 */
async function leavesMany(
  graphene: GrapheneSource,
  roots: readonly string[],
  options: CaveRequestOptions,
  stopLayer: number = VOTE_LAYER,
): Promise<Map<string, string[]>> {
  const answer = await leavesManyReply(graphene, roots, options, `stop_layer=${stopLayer}`)
  const out = new Map<string, string[]>()
  for (const root of roots) {
    const listed = answer[root]
    if (Array.isArray(listed) && listed.length) out.set(root, listed.map(String))
  }
  return out
}

/**
 * Each root's level-2 chunk *count*, from `leaves_many` with `counts_only=true`. Only roots with
 * at least one chunk are in the answer, as in `leavesMany`.
 *
 * **The flag is a request, not a promise.** pychunkedgraph answers `{"<root>": count}` under it
 * from 2.21.1 (Aedes, `cave.fanc-fly.com`, 2026-11-25); an older server ignores it without a word
 * and sends the whole lists (FlyWire on 1.27.0, the same day). So each value is read as whatever
 * it turned out to be — a number is the count, a list's length is — and no deployment needs to be
 * known in advance. Not every deployment will take the change, so the list arm is the fallback
 * for good, not a migration to remove later.
 *
 * Measured on Aedes, three roots: 80,342 bytes against 94, and about a third less time (most of
 * it is the server's lookup, not the reply).
 *
 * **A count of 0 is a root the graph does not know** (Aedes on 2.21.1 answered a FlyWire id so,
 * 2026-11-25), as an empty or absent list is in the list form — every real root holds a chunk. It
 * is left out, never kept as zero, which would read as the smallest possible object
 * (`l2ChunkCounts`' "absent, not zero").
 *
 * **Any other value is refused, not read as "not listed"**: a count sent as text, or a reply
 * shaped some new way, is a reply this cannot read, and `l2ChunkCounts` would otherwise remember
 * every root in it as absent for the session.
 */
async function leavesCounts(
  graphene: GrapheneSource,
  roots: readonly string[],
  options: CaveRequestOptions,
): Promise<Map<string, number>> {
  const answer = await leavesManyReply(
    graphene,
    roots,
    options,
    'stop_layer=2&counts_only=true',
  )
  const out = new Map<string, number>()
  for (const root of roots) {
    const value = answer[root]
    if (value === undefined) continue
    const count = typeof value === 'number' ? value : Array.isArray(value) ? value.length : NaN
    if (!Number.isInteger(count) || count < 0) {
      throw new CaveError(
        `${graphene.server} answered \`leaves_many\`'s count for root ${root} as ` +
          `${JSON.stringify(value)}, which is neither a count nor a list.`,
      )
    }
    if (count > 0) out.set(root, count)
  }
  return out
}

/**
 * `leaves_many`'s reply, raw: the request and its one named refusal, shared by both readers.
 *
 * **A failure fails the run; it is never a root "not placed".** A batch holding an id the graph
 * does not know still answers 200, so a refusal is about the request or the server — a 429, a
 * 5xx, a missing endpoint — and counting it as an answer about the data is the "a lookup that
 * failed has not answered none" bug. A 404 is named, being the one a deployment without the
 * endpoint gives on every request.
 */
async function leavesManyReply(
  graphene: GrapheneSource,
  roots: readonly string[],
  options: CaveRequestOptions,
  query: string,
): Promise<Record<string, unknown>> {
  const url = tableUrl(graphene, `node/leaves_many?${query}`)
  return chunkedgraphRead(graphene, options.signal, () =>
    cavePostRawOnce<Record<string, unknown>>(url, `{"node_ids":[${roots.join(',')}]}`, options),
  ).catch((error: unknown) => {
    if (error instanceof CaveError && error.status === 404) {
      /*
       * The fact, not one caller's remedy. This used to end "Use each row's supervoxel instead",
       * which is the majority vote's way out and means nothing to `l2ChunkCounts` — a reader of
       * a wrong size feature would have been sent to a fix that does not exist on their path,
       * and away from the cause.
       */
      throw new CaveError(
        `${graphene.server} has no \`leaves_many\` endpoint, so this datastack cannot be asked ` +
          `what a root or chunk is made of.`,
        404,
      )
    }
    throw error
  })
}

async function getRoots(
  graphene: GrapheneSource,
  supervoxels: readonly string[],
  at: number,
  options: CaveRequestOptions,
): Promise<BigUint64Array> {
  // `BigInt` from a decimal string is exact where `Number` is not — the conversion
  // `precomputed/index.ts` already relies on for the same reason.
  return rootsBinary(
    graphene,
    BigUint64Array.from(supervoxels, (id) => BigInt(id)),
    at,
    options,
  )
}

/**
 * A moment to ask a chunkedgraph about: epoch ms, or `'server'` — **the server's own now**, sent
 * as no timestamp at all.
 *
 * `'server'` is for the one question a client clock cannot ask: what is true **after our own
 * write**. The merge's timestamp is the server's; a browser clock even a second behind it asks
 * about a moment before the merge and sees the old roots, which reads as a merge that did not
 * happen. Everything else picks its moment (`RootsAt`) and keeps it.
 */
export type Instant = number | 'server'

/** The query string for a read at `at`, optionally stopping at a layer below the root. */
function timestampQuery(at: Instant, stopLayer?: number): string {
  const params = [
    ...(stopLayer === undefined ? [] : [`stop_layer=${stopLayer}`]),
    ...(at === 'server' ? [] : [`timestamp=${at / 1000}`]),
  ]
  return params.length ? `?${params.join('&')}` : ''
}

/**
 * How many `roots_binary` and `leaves_many` requests may be in flight at one chunkedgraph, from
 * every caller in the tab together — the user's figure (2026-11-19), above the ~12 a Suggest
 * Merges run reached once its reads overlapped. **Those two endpoints only**, the search's hot
 * path: this file's other chunkedgraph reads (`is_latest_roots`, `root_timestamps`) and other
 * files' (`l2.ts`, the mesh manifests) go around it, and are not counted. `ROOT_STREAMS` and
 * `LEAVES_STREAMS` still cap a single call; this is the total those calls share, so a run that
 * reads several ends at once stays within it however many it reads.
 *
 * Measured before it was chosen: with three or four ends' lookups and counts in flight at once,
 * the Aedes chunkedgraph did each end's work in 0.4-0.7 s against 1.0-1.7 one at a time, its
 * median request slowing from ~430 ms to ~600-880 (`docs/seam-suggestions-plan.md`).
 */
const CHUNKEDGRAPH_BUDGET = 16

const budgets = new Map<string, Slots>()

/** The tab's budget at one chunkedgraph server. */
function budgetAt(graphene: GrapheneSource): Slots {
  let budget = budgets.get(graphene.server)
  if (!budget) {
    budget = slots(CHUNKEDGRAPH_BUDGET)
    budgets.set(graphene.server, budget)
  }
  return budget
}

/**
 * A chunkedgraph read, inside the server's budget, **asked again if the connection dropped under
 * it** — the client's rule (`readAgain`), applied around the slot rather than inside it, so a
 * read waiting to be asked again holds none. `read` makes its request once.
 *
 * The server closes its HTTP/2 connections from time to time with a `GOAWAY` (code 0, "no
 * error"), and every request still open on that connection fails at once — twelve to fifteen
 * lookups in one measurement (2026-11-19). These reads are `POST`s, which no browser retries on
 * its own, so one such close failed a whole Suggest Merges run. Only a request that got no
 * answer (`CaveError.noAnswer`) or lost it mid-read is asked again; an HTTP error or a bad body
 * is the server's answer, and a Cancel is an `AbortError`.
 */
function chunkedgraphRead<T>(
  graphene: GrapheneSource,
  signal: AbortSignal | undefined,
  read: () => Promise<T>,
): Promise<T> {
  return readAgain({ signal }, () => budgetAt(graphene).run(read, signal))
}

/** One `roots_binary` call. */
function rootsBinary(
  graphene: GrapheneSource,
  ids: BigUint64Array,
  at: Instant,
  options: CaveRequestOptions,
  stopLayer?: number,
): Promise<BigUint64Array> {
  return chunkedgraphRead(graphene, options.signal, () =>
    cavePostBinary(
      tableUrl(graphene, `roots_binary${timestampQuery(at, stopLayer)}`),
      ids,
      options,
    ),
  )
}

/**
 * One `is_latest_roots` call.
 *
 * The body is built as **text**, so no id is ever a JavaScript number: `node_ids` is a list of
 * integers on the wire, and an eighteen-digit root id through `JSON.stringify` of a `number` is a
 * different neuron (invariant 8). The same splice `idList` performs for Cypher and
 * `pyLongIntList` for the notebook.
 *
 * Exported for a check at `'server'` (`Instant`): one call, no batching, no cache — `staleRoots`
 * is the batched and cached question at a chosen moment.
 */
export async function isLatestRoots(
  graphene: GrapheneSource,
  ids: readonly string[],
  at: Instant,
  options: CaveRequestOptions,
): Promise<boolean[]> {
  const url = tableUrl(graphene, `is_latest_roots${timestampQuery(at)}`)
  const body = `{"node_ids":[${ids.join(',')}]}`
  const answer = await cavePostRaw<{ is_latest?: unknown }>(url, body, options)
  /*
   * One verdict per id, or it is not an answer. Read short, every id past the end came back
   * `undefined` — which `staleRoots` counted as current and kept, and which a pre-flight's
   * `every(Boolean)` passed outright on an empty list.
   */
  const verdicts = answer.is_latest
  if (
    !Array.isArray(verdicts) ||
    verdicts.length !== ids.length ||
    !verdicts.every((v) => typeof v === 'boolean')
  ) {
    throw new CaveError(
      `The chunkedgraph's is_latest_roots answer does not hold one true/false for each of the ` +
        `${ids.length} roots asked, so whether they are current is unknown.`,
    )
  }
  return verdicts
}

/**
 * Each supervoxel's root at `at`, as text — `rootsAtInstant` for a handful of ids that are already
 * text (a merge's two ends), one per id or a throw. For the merge path (`mergeBatch.ts`,
 * `mergePlan.ts`), which reads both ends at the server's now before and after every write.
 */
export async function supervoxelRoots(
  graphene: GrapheneSource,
  supervoxels: readonly string[],
  at: Instant,
  options: CaveRequestOptions,
): Promise<string[]> {
  // `BigInt` from decimal text is exact where `Number` is not (invariant 8).
  const ids = BigUint64Array.from(supervoxels, (id) => BigInt(id))
  return [...(await rootsAtInstant(graphene, at, ids, options))].map(String)
}

/**
 * Each supervoxel's level-2 parent at `at`, as text: `roots_binary` with `stop_layer=2`
 * (pychunkedgraph's `handle_roots` reads it as a query parameter), batched as `rootsAtInstant`
 * batches. `0` where the server knows no parent. A past root's chunks are its parents at the root's own time: a later
 * edit in the chunk renumbers them.
 */
export async function levelTwoParents(
  graphene: GrapheneSource,
  supervoxels: readonly string[],
  at: Instant,
  options: CaveRequestOptions,
): Promise<string[]> {
  if (supervoxels.length === 0) return []
  // `rootsAtInstant`'s pieces and streams, stopping at layer 2: a point's box or a scan's cut ends
  // can be tens of thousands of ids, past what one request should carry.
  const ids = BigUint64Array.from(supervoxels, (id) => BigInt(id))
  return [...(await rootsAtInstant(graphene, at, ids, options, 2))].map(String)
}

/** Each root's level-2 chunks, in one `leaves_many` request (`stop_layer=2`). */
export function levelTwoChunks(
  graphene: GrapheneSource,
  roots: readonly string[],
  options: CaveRequestOptions,
): Promise<Map<string, string[]>> {
  return roots.length ? leavesMany(graphene, roots, options, 2) : Promise.resolve(new Map())
}

/**
 * The supervoxels of each level-2 chunk, in one `leaves_many` request (`stop_layer=1`) — a
 * split's seeds (`splitSitesRun.ts`). Only chunks with supervoxels listed are in the answer.
 */
export function chunkSupervoxels(
  graphene: GrapheneSource,
  chunks: readonly string[],
  options: CaveRequestOptions,
): Promise<Map<string, string[]>> {
  return chunks.length ? leavesMany(graphene, chunks, options, 1) : Promise.resolve(new Map())
}

/**
 * When each root was made, epoch ms: `POST …/root_timestamps` with `{"node_ids": […]}`, answered
 * `{"timestamp": [epoch seconds]}` — the time of the root's own `Child` column, i.e. of the edit
 * that made it (pychunkedgraph v2.20.0 `handle_root_timestamps`, `get_node_timestamps`). The ids
 * are spliced in as text, as `isLatestRoots` does. One finite time per root, or a throw.
 */
export async function rootTimestamps(
  graphene: GrapheneSource,
  roots: readonly string[],
  options: CaveRequestOptions,
): Promise<number[]> {
  return oneEach(roots, await timestampsOf(graphene, roots, options))
}

/** `ms`, where it holds one time per root; a throw otherwise. */
function oneEach(roots: readonly string[], ms: number[]): number[] {
  if (ms.length !== roots.length) throw notOneTimeEach(roots.length)
  return ms
}

/**
 * One `root_timestamps` call, as epoch ms — **however many times came back.**
 *
 * The length is the caller's to judge, because of how an id the chunkedgraph never made is
 * answered — measured on `wclee_aedes_brain` (2026-11-17), and different on every path:
 *
 * - asked **alone**, without `latest`: a 200 with an **empty list**. The same for `0` and for a
 *   supervoxel id;
 * - asked **among known roots**, without `latest`: a 500 whose message is the unknown id;
 * - with `latest=true`, alone or not: a 500, "pop from an empty deque".
 *
 * `madeOrUnknown` reads the first two.
 */
async function timestampsOf(
  graphene: GrapheneSource,
  roots: readonly string[],
  options: CaveRequestOptions,
  { latest = false } = {},
): Promise<number[]> {
  const url = tableUrl(graphene, `root_timestamps${latest ? '?latest=true' : ''}`)
  const answer = await cavePostRaw<{ timestamp?: unknown }>(
    url,
    `{"node_ids":[${roots.join(',')}]}`,
    options,
  )
  const seconds = answer.timestamp
  if (
    !Array.isArray(seconds) ||
    !seconds.every((t) => typeof t === 'number' && Number.isFinite(t))
  ) {
    throw notOneTimeEach(roots.length)
  }
  return seconds.map((t: number) => t * 1000)
}

function notOneTimeEach(count: number): CaveError {
  return new CaveError(
    `The chunkedgraph's root_timestamps answer does not hold one time for each of the ` +
      `${count} roots asked.`,
  )
}

/**
 * When a root was current: made at `made`, current until `last`, and whether `last` is now.
 *
 * Epoch ms throughout. For a root still current, `last` is the server's own now when it was
 * asked, not the browser's clock — which may be behind, and ask about a moment before a root
 * made seconds ago existed.
 */
export interface RootLife {
  readonly made: number
  /**
   * The last moment the root was current, **less 1 ms**: just before the edit that replaced it,
   * or the server's now for a root nothing has replaced.
   *
   * Less a millisecond because caveclient 8.2.1 takes one off (`get_root_timestamps`), and a
   * moment exactly at the replacing edit is a boundary a server may place on either side. Aedes
   * answered "current" at the edit's own time and 1 ms before (2026-11-17); the earlier moment is
   * the one both readings agree on.
   *
   * `last` and `current` are two requests, so a root replaced between them reads
   * `current: false` with `last` the moment of the first request rather than of the edit. That
   * is still a moment it was current, which is all a reader at `last` needs.
   */
  readonly last: number
  readonly current: boolean
}

/**
 * The moment nearest `at` at which the root was current: `at` itself where the root was current
 * then, the root's first current moment where it was made after `at`, and `last` where it was
 * replaced before.
 *
 * **First current is `made + 1 ms`, not `made`**: Aedes answered "not latest" at a root's own
 * creation time and "latest" a millisecond after, for both roots asked (2026-11-17) — the edit's
 * timestamp belongs to the moment before it. The other end is already safe (`RootLife.last`).
 */
export function momentWithin(life: RootLife, at: number): number {
  return Math.min(Math.max(at, life.made + 1), life.last)
}

/**
 * When each root was current — for a node that reads the segmentation at its query neuron's own
 * moment rather than at a materialization (`docs/seam-live-plan.md`).
 *
 * Three calls, each one answer per root: `root_timestamps` for when it was made, the same with
 * `latest=true` for the last moment it was current, and `is_latest_roots` at the server's now
 * for whether that moment is now. The third is needed because the second cannot say: for a
 * current root it answers the moment of the request, which is indistinguishable from a root
 * replaced in that same second.
 *
 * **An id the chunkedgraph never made is in `unknown`, never in `lives`** — and is the one thing
 * that needs care, because the server says so differently on each call (`timestampsOf`), and
 * `is_latest_roots` answers `false` for it, which reads as "replaced". The first call is the
 * check (`madeOrUnknown`), and only known roots go on to the other two.
 *
 * A string that is not a 64-bit id at all is refused before anything is sent: it would be spliced
 * into the body as a bare number.
 */
export async function rootLives(
  graphene: GrapheneSource,
  roots: readonly string[],
  options: CaveRequestOptions,
): Promise<{ lives: Map<string, RootLife>; unknown: string[] }> {
  const asked = distinctStrings(roots)
  const bad = asked.find((root) => !isSegmentId(root))
  if (bad !== undefined) throw new CaveError(`"${bad}" is not a root id.`)
  const memoKey = (root: string) => `${graphene.server}|${graphene.table}|${root}`
  const made = new Map<string, number>()
  const found = new Map<string, RootLife>()
  for (const root of asked) {
    const held = remembered.get(memoKey(root))
    if (held?.life) found.set(root, held.life)
    else if (held) made.set(root, held.made)
  }
  const unknown: string[] = []
  const toAsk = asked.filter((root) => !made.has(root) && !found.has(root))
  for (let i = 0; i < toAsk.length; i += CHUNK) {
    await madeOrUnknown(graphene, toAsk.slice(i, i + CHUNK), options, made, unknown)
  }
  const known = [...made.keys()]
  for (let i = 0; i < known.length; i += CHUNK) {
    const batch = known.slice(i, i + CHUNK)
    // Two at once, never more: the one place this file does not ask in turn, and bounded.
    const [lasts, current] = await Promise.all([
      timestampsOf(graphene, batch, options, { latest: true }).then((ms) => oneEach(batch, ms)),
      isLatestRoots(graphene, batch, 'server', options),
    ])
    batch.forEach((root, k) => {
      const life = { made: made.get(root)!, last: lasts[k]! - 1, current: current[k]! }
      found.set(root, life)
      // A replaced root is replaced for good; a current one is asked again next time.
      remembered.set(
        memoKey(root),
        life.current ? { made: life.made } : { made: life.made, life },
      )
    })
  }
  // In the order asked, whatever the memory answered first.
  const lives = new Map<string, RootLife>()
  for (const root of asked) if (found.has(root)) lives.set(root, found.get(root)!)
  return { lives, unknown }
}

/**
 * What `rootLives` need never ask again, for the session: when a root was made, and the whole
 * life of a replaced one. Neither changes — a root id is made once, and a root replaced stays
 * replaced. A current root's `last` and `current` are asked every time, which is one round trip
 * where there were two (`root_timestamps` first, then the other two together). An id the
 * chunkedgraph never made is not kept. Bounded, as entries are a few dozen bytes each.
 */
const remembered = new LruMap<string, { made: number; life?: RootLife }>(20_000)

/**
 * When each root of `batch` was made, into `made` — or into `unknown`, where the chunkedgraph
 * never made it.
 *
 * **Read off the server's own words** (`timestampsOf`): among known roots, the 500 for an unknown
 * id says that id and nothing else, so it is set aside and the rest asked again — one more
 * request per unknown id. A 500 that names none of the ids sent is the server failing, and is
 * thrown at once: halving on any 500 would answer a loaded server with a dozen more requests, and
 * a run that came through would say nothing of the outage. A root alone answers an empty list.
 *
 * A short answer that names nothing was never measured; it is halved, each half asked, down to a
 * root alone — about 2·log₂*n* requests for one such id in *n*, where asking every root alone was
 * *n*: ten thousand at `CHUNK`.
 */
async function madeOrUnknown(
  graphene: GrapheneSource,
  batch: readonly string[],
  options: CaveRequestOptions,
  made: Map<string, number>,
  unknown: string[],
): Promise<void> {
  let asking = batch
  for (;;) {
    const sent = asking
    const answer = await timestampsOf(graphene, sent, options).catch((error: unknown) => {
      const named =
        error instanceof CaveError && error.status === 500 ? error.detail : undefined
      if (named !== undefined && sent.length > 1 && sent.includes(named)) return named
      throw error
    })
    if (typeof answer === 'string') {
      unknown.push(answer)
      asking = sent.filter((root) => root !== answer)
      continue
    }
    if (answer.length === sent.length) {
      sent.forEach((root, k) => made.set(root, answer[k]!))
      return
    }
    if (sent.length === 1) {
      if (answer.length !== 0) throw notOneTimeEach(1)
      unknown.push(sent[0]!)
      return
    }
    const half = Math.ceil(sent.length / 2)
    await madeOrUnknown(graphene, sent.slice(0, half), options, made, unknown)
    await madeOrUnknown(graphene, sent.slice(half), options, made, unknown)
    return
  }
}

/**
 * Counts read so far, keyed by segmentation and root.
 *
 * **Keyed like every other cache in this file** (`cave-sv-roots:${server}|${table}|…`,
 * `cave-votes:…`): a chunkedgraph id is unique within its own table, not across tables, and a
 * review against a production chunkedgraph beside a dataset node on the public snapshot is two
 * tables in one session. The first table's count served for the second's root is a believable
 * number with nothing to notice it.
 *
 * **Session-lifetime, not the permanent store, and the reason is eviction rather than staleness.**
 * A count really is right forever — a root id names one fixed state of the graph — so `keep`'s
 * `forever` slot would be sound on correctness. What rules it out is that the slot has no
 * eviction (`AskedAt`), and this is per *candidate*: a search touches thousands of roots a
 * neuron. SEAM can hold the same thing forever because its cache is a parquet file per dataset;
 * a browser's is not that. So the session is the boundary, and a reload re-asks.
 */
const l2Counts = new Map<string, number>()

/** Roots whose count is being asked for right now, each to the batch that will answer it. */
const l2Asking = new Map<string, SharedAsk>()

/** A root the graph does not list. Distinct from 0, which is a count nobody took. */
const ABSENT = -1

/** Test-only: forget the counts so a suite can re-observe the requests. */
export function resetL2ChunkCounts(): void {
  l2Counts.clear()
  l2Asking.clear()
  // And the budgets, so one test's stuck requests cannot hold slots for the next.
  budgets.clear()
}

/**
 * How many level-2 chunks each root holds — SEAM's `l2c`/`l2x` features, in one batched pass.
 *
 * SEAM's `l2c`/`l2x`, fetched the way `seam.sizes` does — `get_leaves_many(stop_layer=2)`, the
 * length of each answer — asked as counts (`counts_only`) where the server takes that, and read
 * from the whole lists where it does not (`leavesCounts`). A count is a cheap proxy for an
 * object's total size, which the geometric features cannot see because they are measured inside
 * a 6 µm box around the open end; the rest is in `docs/seam-suggestions-plan.md`.
 *
 * Batched `LEAVES_CHUNK` (160) to a request against a shared public chunkedgraph (SEAM's
 * invariant 8), which keeps an end's ~320 new roots to two requests rather than one per
 * candidate, and `LEAVES_STREAMS` of those in flight at a time.
 *
 * **A root the graph does not list comes back absent, not zero** — zero is the smallest possible
 * size and would read as a speck. Note that nothing here *refuses* a short answer: SEAM's own
 * fetching layer does, by name (`sizes.fetch` raises on a root `get_leaves_many` left out),
 * because at that layer an absent root means the request was wrong rather than that there is no
 * data. `countsInPoolOrder` in `packs/seam/searchRun.ts` pays that debt: it is where a count missing from this answer becomes a hole in a positional array, and it refuses there, by name.
 *
 * **The memo fills per batch, as each lands.** Within one call that is all it needs to be: the
 * batches are disjoint slices of the roots this call found missing, so no two of them can ask
 * for the same root however they interleave, and a call that fails partway still keeps what the
 * batches that landed bought.
 *
 * **Across calls, a request in flight is shared** (`l2Asking`, `shareInFlight`): the search counts
 * several ends at once (2026-11-19), and neighbouring ends' pools are largely the same roots, so
 * two callers would otherwise each find the memo empty and each ask. Shared per caller's set,
 * never per root — a promise per root would destroy the batching that is the point of
 * this function. A joiner waits for the whole of the request it joined, a few batches at most,
 * which is off the critical path now the search runs ahead of the GPU.
 */
export async function l2ChunkCounts(
  graphene: GrapheneSource,
  roots: readonly string[],
  options: CaveRequestOptions,
): Promise<Map<string, number>> {
  const at = (root: string) => `${graphene.server}|${graphene.table}|${root}`
  const distinct = distinctStrings(roots)
  const keyed = new Map(distinct.map((root) => [at(root), root]))
  const shared = sharedRequestOptions(options)
  // Inside the shared request the batching is as before: `LEAVES_CHUNK` roots a request,
  // `LEAVES_STREAMS` at a time, the memo filling as each batch lands.
  await shareInFlight(
    keyed.keys(),
    (key) => l2Counts.has(key),
    l2Asking,
    async (mine, signal) => {
      const wanted = mine.map((key) => keyed.get(key)!)
      const batches = Array.from({ length: Math.ceil(wanted.length / LEAVES_CHUNK) }, (_, i) =>
        wanted.slice(i * LEAVES_CHUNK, (i + 1) * LEAVES_CHUNK),
      )
      await inFlight(batches, LEAVES_STREAMS, async (batch) => {
        const counts = await leavesCounts(graphene, batch, { ...shared, signal })
        for (const root of batch) {
          /*
           * **Absence is remembered too, as its own state.** A root the graph does not list is
           * not going to start appearing — a chunkedgraph id either exists or never did — so
           * leaving it out of the memo means every later pool holding it pays another round trip
           * that can only answer "still absent". The search's premise is that roots recur across
           * neighbouring tips, so that is one unremovable request per open end.
           *
           * `ABSENT` rather than 0: zero is a count this never took, and the smallest possible.
           */
          l2Counts.set(at(root), counts.get(root) ?? ABSENT)
        }
      })
    },
    options.signal,
  )
  const out = new Map<string, number>()
  for (const root of distinct) {
    const held = l2Counts.get(at(root))
    if (held !== undefined && held !== ABSENT) out.set(root, held)
  }
  return out
}
