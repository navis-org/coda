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
import type { CaveRequestOptions } from './client'
import { CaveError, cavePostBinary, cavePostRaw } from './client'
import { datastackRecord, materializationsFor, versionFrozenAt } from './datastack'
import { deploymentKey } from './deployments'
import type { GrapheneSource } from './graphene'
import { parseGrapheneSource, tableUrl } from './graphene'
import { channel } from '../channel'
import { countStrings, distinctStrings } from '../../core/collections'
import { compareIds } from '../../core/ids'

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
async function grapheneFor(
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
 * - `instant`: a moment asked about once. Held by nobody.
 *
 * The caller picks the moment rather than each request taking the server's "now", because a repair
 * is two calls — which ids moved, then where their supervoxels (or chunks) went — and both have to be about the
 * same instant, or an edit landing between them leaves a row repointed at a root that was itself
 * already retired.
 */
export type RootsAt = { version: number } | { boundary: number } | { instant: number }

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

async function askedAt(
  datastack: string,
  when: RootsAt,
  options: CaveRequestOptions,
): Promise<AskedAt | undefined> {
  if ('instant' in when) return { at: when.instant, keep: 'never' }
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

/** Roots per `leaves_many` request: a few thousand chunk ids each, so a few MB a reply. */
const LEAVES_CHUNK = 50

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
  for (let i = 0; i < unknown.length; i += LEAVES_CHUNK) {
    // Sequential, like every other pass here against a shared production chunkedgraph.
    const samples = await leavesMany(graphene, unknown.slice(i, i + LEAVES_CHUNK), options)
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
 * `VOTE_SAMPLE` ids evenly strided over the sorted list, or all of them where there are fewer —
 * sorting in place, the caller handing over a fresh array.
 *
 * **Strided, not random**: a provenance key promises the same answer for the same input
 * (invariant 4), and a chunk id's high bits are its position in the volume, so sorted order
 * spreads the stride across the neuron rather than bunching it in one arbour.
 */
function strided(ids: string[]): string[] {
  const sorted = ids.sort(compareIds)
  if (sorted.length <= VOTE_SAMPLE) return sorted
  return Array.from(
    { length: VOTE_SAMPLE },
    (_, k) => sorted[Math.floor((k * sorted.length) / VOTE_SAMPLE)]!,
  )
}

/**
 * A sample of each root's level-2 chunks, from `leaves_many`. Only roots with chunks listed are in
 * the answer.
 *
 * `caveclient.chunkedgraph.get_leaves_many`: `POST …/node/leaves_many?stop_layer=2` with
 * `{"node_ids": [...]}`, answering `{"<root>": [chunk ids]}`. The body is spliced as text, as
 * `isLatestRoots`' is, and the reply's ids come back as text through `parseCaveJson`.
 *
 * **A failure fails the run; it is never a root "not placed".** A batch holding an id the graph
 * does not know answers 200 with that id simply absent (FlyWire, 2026-10-20), so a refusal is about
 * the request or the server — a 429, a 5xx, a missing endpoint — and counting it as an answer about
 * the data is the "a lookup that failed has not answered none" bug. A 404 is named, being the one a
 * deployment without the endpoint gives on every request.
 */
async function leavesMany(
  graphene: GrapheneSource,
  roots: readonly string[],
  options: CaveRequestOptions,
): Promise<Map<string, string[]>> {
  const url = tableUrl(graphene, `node/leaves_many?stop_layer=${VOTE_LAYER}`)
  const answer = await cavePostRaw<Record<string, (string | number)[]>>(
    url,
    `{"node_ids":[${roots.join(',')}]}`,
    options,
  ).catch((error: unknown) => {
    if (error instanceof CaveError && error.status === 404) {
      throw new CaveError(
        `${graphene.server} has no \`leaves_many\` endpoint, so this datastack cannot be updated ` +
          `by a majority of chunks. Use each row’s supervoxel instead.`,
        404,
      )
    }
    throw error
  })
  const out = new Map<string, string[]>()
  for (const root of roots) {
    const listed = answer[root]
    if (listed?.length) out.set(root, strided(listed.map(String)))
  }
  return out
}

async function getRoots(
  graphene: GrapheneSource,
  supervoxels: readonly string[],
  at: number,
  options: CaveRequestOptions,
): Promise<BigUint64Array> {
  const url = tableUrl(graphene, `roots_binary?timestamp=${at / 1000}`)
  // `BigInt` from a decimal string is exact where `Number` is not — the conversion
  // `precomputed/index.ts` already relies on for the same reason.
  const body = BigUint64Array.from(supervoxels, (id) => BigInt(id))
  return cavePostBinary(url, body, options)
}

/**
 * One `is_latest_roots` call.
 *
 * The body is built as **text**, so no id is ever a JavaScript number: `node_ids` is a list of
 * integers on the wire, and an eighteen-digit root id through `JSON.stringify` of a `number` is a
 * different neuron (invariant 8). The same splice `idList` performs for Cypher and
 * `pyLongIntList` for the notebook.
 */
async function isLatestRoots(
  graphene: GrapheneSource,
  ids: readonly string[],
  at: number,
  options: CaveRequestOptions,
): Promise<boolean[]> {
  const url = tableUrl(graphene, `is_latest_roots?timestamp=${at / 1000}`)
  const body = `{"node_ids":[${ids.join(',')}]}`
  const answer = await cavePostRaw<{ is_latest: boolean[] }>(url, body, options)
  return answer.is_latest ?? []
}
