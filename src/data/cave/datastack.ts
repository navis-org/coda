/**
 * A datastack's info record, fetched at most once per datastack **per deployment**.
 *
 * CAVE is two servers — a *global* info service that knows which datastacks exist and where each
 * is served from, and a per-datastack `local_server` that answers the queries — so almost every
 * call anywhere needs this document first, and each caller wants a different field of it. It
 * used to be a private memo on `CaveSource`, which was right until the annotation providers
 * became a second consumer: `caveTable.ts` needs the same `local_server` and has no source
 * instance to ask.
 *
 * The **promise** is memoised rather than the value, which is what stops two callers a tick
 * apart issuing the same document twice — the idiom `loadCachedTable` and `state.discovering`
 * already use. A rejection is not kept, so the next caller retries rather than inheriting a
 * failure forever.
 *
 * **Every key carries the deployment** (`deploymentKey`), so there is nothing to clear when a
 * second deployment is used: FlyWire on `global.daf-apis.com` and H01 on
 * `global.brain-wire-test.org` share one session, and a key naming its deployment cannot be read
 * by a request for another. The deployment arrives on `CaveRequestOptions` for anything that
 * fetches, and as the first argument of each peek, which has no request to read it off.
 */

import type { DatastackInfo } from './api'
import type { VersionInfo } from './api'
import { datastackInfo, listDatastacks, versionsMetadata } from './api'
import type { CaveRequestOptions } from './client'
import { getToken } from './credentials'
import { caveSourceId, deploymentKey, normaliseCaveServer } from './deployments'
import { memoPromise } from '../memoPromise'
import { reportSourceLearned } from '../source'
import type { GrapheneSource } from './graphene'
import { parseGrapheneSource } from './graphene'
import { l2TableMapping, resetL2Cache } from './l2'

const records = new Map<string, Promise<DatastackInfo>>()

export function datastackRecord(
  datastack: string,
  options: CaveRequestOptions,
): Promise<DatastackInfo> {
  const deployment = normaliseCaveServer(options.deployment)
  return memoPromise(
    records,
    deploymentKey(deployment, datastack),
    () => datastackInfo(datastack, { ...options, deployment }),
    { keep: 'resolved' },
  )
}

/** The server that answers queries for a datastack. */
export async function caveServerFor(
  datastack: string,
  options: CaveRequestOptions,
): Promise<string> {
  return (await datastackRecord(datastack, options)).local_server
}

/**
 * A datastack's usable materializations, newest first — synchronously, if they are known.
 *
 * **`undefined` means "not yet", not "none".** The contract `schemasFor` and `peekColumns` both
 * have, and for the same reason: this is read from `inferOutputs`, which may not await
 * (invariant 2), so the first look at a datastack cannot answer. It starts the fetch and
 * `reportSourceLearned` re-infers when it lands.
 *
 * **Started once per datastack, never once per peek** — inference runs on every graph mutation,
 * so a retry from here would be a request per keystroke. The flag is not cleared on failure, for
 * the reason `runDiscovery`'s is not; recovery is an explicit listing from the Connections panel.
 *
 * This exists because `CaveSource.listDatasets` deliberately lists only datastacks with a *spec*
 * in the static table, so a datastack somebody has just typed into a Custom CAVE node is not in
 * it and never will be. Its materializations are a fact about that one datastack, which is what
 * this module is for.
 */
export function peekMaterializations(
  deployment: string,
  datastack: string,
): number[] | undefined {
  const key = deploymentKey(deployment, datastack)
  const known = materializations.get(key)
  if (known || !datastack || asked.has(key)) return known
  asked.add(key)
  /*
   * Swallowed *and* `quiet`. The swallow is `NeuPrintSource.peekDatasets`' trade — a peek has no
   * caller to report to. The quiet is the other half, and it was missing: this reaches
   * `datastackRecord`, so a card naming a datastack the account may not read raised the alarm
   * that opens the Connections panel **from a render**, which is the reported bug arriving by a
   * shorter route than the Run that first showed it. The Datastack field now offers every
   * datastack the listing names, refusable ones included, so picking a suggestion led straight
   * here. A credential-level refusal is still loud, on `datastacksFor` below.
   */
  void materializationsFor(datastack, { deployment, quiet: true }).catch(() => undefined)
  return undefined
}

/**
 * The same list, awaited — what `evaluate` uses.
 *
 * `evaluate` may fetch where inference may not, so it resolves a "latest" properly rather than
 * failing because a peek had not landed yet. Both halves read one memo, so the materialization
 * the dropdown *shows* and the one a run *uses* cannot disagree.
 *
 * The promise is memoised, not the value, so two dataset nodes on one datastack issue one
 * request. A rejection is not kept — the next caller retries — which is why `asked` is a
 * separate set: the *peek* must not retry, or inference would issue a request per keystroke.
 */
export function materializationsFor(
  datastack: string,
  options: CaveRequestOptions,
): Promise<number[]> {
  const key = deploymentKey(options.deployment, datastack)
  return memoPromise(
    loading,
    key,
    () =>
      load(key, datastack, options).then((versions) => {
        materializations.set(key, versions)
        // Not a data-changed event: nothing cached is invalidated and no run is scheduled. It
        // only tells inference that a dropdown it drew empty can be filled in.
        reportSourceLearned(caveSourceId(options.deployment))
        return versions
      }),
    { keep: 'inflight' },
  )
}

async function load(
  key: string,
  datastack: string,
  options: CaveRequestOptions,
): Promise<number[]> {
  const info = await datastackRecord(datastack, options)
  const usable = usableVersions(await versionsMetadata(info.local_server, datastack, options))
  // Kept whole rather than reduced to numbers: the same reply carries each version's
  // `time_stamp`, which is what a root id is judged against, and asking for it separately would
  // be a second round trip for something already in hand.
  versionInfo.set(key, usable)
  return usable.map((v) => v.version)
}

/**
 * CAVE writes an instant with no zone on it and means **UTC**, which `Date.parse` does not.
 *
 * `"2023-08-29T00:00:00.000000"` is a date-*time* string with no offset, and ECMA-262 reads that
 * as **local time** — so the same reply becomes a different instant on every machine, seven hours
 * out in `America/Los_Angeles` and an hour out in London for half the year. That it is UTC is not
 * a guess: caveclient parses the same field with
 * `datetime.strptime(ts, "%Y-%m-%dT%H:%M:%S.%f").replace(tzinfo=timezone.utc)`.
 *
 * The damage is silent and it is not confined to a display. This instant is what
 * `is_latest_roots` and `roots_binary` are asked *at*, so a skewed one asks the chunkedgraph
 * about a moment the materialization was never frozen at — and it is folded into the permanent
 * cache key beside it, so the wrong answer is then kept forever. On a proofread datastack that
 * makes `Update root IDs` write root ids that do not exist in the pinned materialization, which
 * is the exact drift it exists to repair.
 *
 * An offset already on the string is honoured, so a deployment that starts sending one is not
 * shifted twice; extra fractional digits are truncated by the parser, which is what CAVE's six
 * of them need.
 */
export function parseCaveTimestamp(stamp: string): number | undefined {
  const naive = !/(?:Z|[+-]\d{2}:?\d{2})$/.test(stamp)
  const at = Date.parse(naive ? `${stamp}Z` : stamp)
  return Number.isFinite(at) ? at : undefined
}

/**
 * When a materialization was frozen, in epoch ms, if it is known — the moment a root id has to
 * have been current at for the annotations keyed on it to mean anything.
 *
 * Answers the *instant* rather than the string it arrived as, which is the whole of why the
 * parse above cannot be got wrong twice: nothing outside this file sees the raw field except
 * `datasetInfoFor`, which only slices a date out of it for prose.
 *
 * `undefined` until the listing has landed, `peekMaterializations`' contract; the caller that
 * needs it can await `materializationsFor` first, which fills this as a side effect.
 */
export function versionFrozenAt(
  deployment: string,
  datastack: string,
  version: number,
): number | undefined {
  const stamp = versionInfo
    .get(deploymentKey(deployment, datastack))
    ?.find((v) => v.version === version)?.time_stamp
  return stamp ? parseCaveTimestamp(stamp) : undefined
}

/**
 * The materializations worth offering, newest first.
 *
 * One statement because two surfaces read it and they must not part company: this feeds the
 * Custom CAVE dropdown and `evaluate`'s "latest", while `CaveSource.listOne` feeds every family
 * dataset node's dropdown and *its* "latest". An expired or invalid materialization is one a
 * query against it would fail on, so offering it is offering a broken choice — and two nodes on
 * one datastack disagreeing about which versions exist is the shape nothing type-checks.
 */
export function usableVersions(versions: readonly VersionInfo[]): VersionInfo[] {
  return [...versions]
    .filter((v) => v.valid !== false && (v.status ?? 'AVAILABLE') === 'AVAILABLE')
    .sort((a, b) => b.version - a.version)
}

const materializations = new Map<string, number[]>()
const versionInfo = new Map<string, VersionInfo[]>()
const loading = new Map<string, Promise<number[]>>()
const asked = new Set<string>()

// ---------------------------------------------------------------------------
// Which datastacks a token can see
// ---------------------------------------------------------------------------

/**
 * Every datastack a deployment's token can see — the listing the Custom CAVE card's Datastack
 * field completes from, and the one `runListing` narrows to the specced datastacks.
 *
 * **One memo for one request**, which is this module's whole reason for existing: `CaveSource`
 * asked the same URL for its own listing, so the fact was fetched twice per session and cached
 * twice with different invalidation rules — the arrangement the module header records being
 * dissolved when the annotation providers became a second consumer.
 *
 * Keyed on the credential as well as the deployment, because the listing is filtered per account:
 * a list fetched for one is not an answer for the next. That doubles as `asked`'s rule — a
 * *failing* token keeps its spelling, so a 401 costs one request rather than one per keystroke,
 * and signing in is what re-asks.
 *
 * Deliberately **not** `quiet`: this is the credential-level question, so a refusal here really
 * does mean the token, and that is the one thing the Connections panel must still be told. The
 * per-datastack calls it leads to are the quiet ones.
 */
export function datastacksFor(options: CaveRequestOptions): Promise<string[]> {
  const deployment = normaliseCaveServer(options.deployment)
  const token = getToken(deployment)
  const held = listings.get(deployment)
  const current = held?.token === token ? held : undefined
  if (current?.names) return Promise.resolve(current.names)
  if (current?.pending) return current.pending
  const entry: Listing = { token }
  listings.set(deployment, entry)
  entry.pending = listDatastacks({ ...options, deployment })
    .then((names) => {
      // Still the question that was asked? A sign-in replaces it and cannot cancel a request
      // already in flight.
      if (listings.get(deployment) !== entry) return names
      entry.names = [...names].sort()
      // Not a data-changed event, `materializationsFor`'s rule: nothing cached is invalidated and
      // no run is scheduled. It only tells inference that a field it drew bare can be filled in.
      reportSourceLearned(caveSourceId(deployment))
      return entry.names
    })
    .finally(() => {
      // A rejection is not kept, so the next *awaited* caller retries; the peek does not, since
      // it re-asks only on a new token.
      entry.pending = undefined
    })
  return entry.pending
}

/**
 * The same list, synchronously, if it is known.
 *
 * `peekMaterializations`' contract: read from a card that renders on every graph mutation and may
 * not await, so the first look answers `undefined`, starts the fetch, and `reportSourceLearned`
 * re-infers when it lands.
 *
 * **No token, no request, and that is not an optimisation.** `client.ts` refuses without one *and
 * fires `reportAuthFailure` as it goes*, so an ungated peek would raise "No CAVE token" at
 * somebody who has only dragged a node onto the canvas. The endpoint needs the token anyway: with
 * no `Authorization` header the info service answers `302` into `sticky_auth` and on to Google's
 * sign-in — measured against `global.daf-apis.com` and `global.brain-wire-test.org` alike — which
 * from a browser `fetch` is a CORS failure rather than a status anything could read or report on.
 * Gated on *this deployment's* token: holding one for another deployment is not holding one here.
 */
export function peekDatastacks(deployment: string): string[] | undefined {
  if (!getToken(deployment)) return undefined
  // Swallowed: a peek has no caller to report to, and a refusal here already travels on its own
  // channel to the Connections panel. `peekMaterializations`' trade.
  void datastacksFor({ deployment }).catch(() => undefined)
  return listings.get(normaliseCaveServer(deployment))?.names
}

/** The listing, the credential it was asked for, and the request if one is in flight. */
interface Listing {
  token: string | undefined
  names?: string[]
  pending?: Promise<string[]>
}

const listings = new Map<string, Listing>()

/** Test seam: drop what is remembered between suites. */
export function resetDatastackRecords(): void {
  records.clear()
  materializations.clear()
  versionInfo.clear()
  loading.clear()
  asked.clear()
  listings.clear()
  l2Sources.clear()
  l2Loading.clear()
  resetL2Cache()
}

// ---------------------------------------------------------------------------
// Whether a datastack's chunkedgraph has an L2 cache
// ---------------------------------------------------------------------------

/**
 * Whether a datastack's chunkedgraph has an L2 cache, and the source it was resolved from.
 *
 * `null` for "checked, and it has none" — so the map's own membership answers "has this been
 * asked?" and no second `asked` set is needed. Holding the resolved `GrapheneSource` rather than
 * a boolean is what stops `fetchSkeletons` deriving it a second time: the gate has already read
 * the datastack record and parsed the segmentation URL, and throwing that away only to re-derive
 * it one line later is the duplication `graphene.ts` was extracted to prevent.
 */
const l2Sources = new Map<string, GrapheneSource | null>()
const l2Loading = new Map<string, Promise<GrapheneSource | undefined>>()

/**
 * Whether skeletons can be built for this datastack — synchronously, if it is known.
 *
 * `peekMaterializations`' contract again: `validate` asks on every graph mutation and may not
 * await, so the first look answers `undefined` and `reportSourceLearned` re-infers when the
 * answer lands. Six of the thirteen datastacks the info service lists have a cache, which is why
 * a per-source answer was wrong for somebody whichever way it was set.
 */
export function peekL2Cache(deployment: string, datastack: string): boolean | undefined {
  const key = deploymentKey(deployment, datastack)
  if (l2Sources.has(key)) return l2Sources.get(key) !== null
  if (!datastack || l2Loading.has(key)) return undefined
  // Swallowed and `quiet`, for `peekMaterializations`' reason exactly: this asks the same
  // datastack record, from a card that renders on every graph mutation.
  void l2SourceFor(datastack, { deployment, quiet: true }).catch(() => undefined)
  return undefined
}

/**
 * The graphene source to build skeletons from, or undefined where there is no cache.
 *
 * The promise is memoised, not the value — the rule this module's header states — so two nodes
 * asking a tick apart issue one table-mapping read rather than two.
 */
export function l2SourceFor(
  datastack: string,
  options: CaveRequestOptions,
): Promise<GrapheneSource | undefined> {
  const key = deploymentKey(options.deployment, datastack)
  const known = l2Sources.get(key)
  if (known !== undefined) return Promise.resolve(known ?? undefined)

  return memoPromise(
    l2Loading,
    key,
    () =>
      resolveL2(datastack, options).then((source) => {
        const before = l2Sources.get(key)
        l2Sources.set(key, source ?? null)
        // Only when the answer *changed*, which for a memoised fact means only the first time.
        // Fired unconditionally it costs a whole-graph re-inference per Run of a Skeletons node.
        if (before === undefined) reportSourceLearned(caveSourceId(options.deployment))
        return source
      }),
    { keep: 'inflight' },
  )
}

async function resolveL2(
  datastack: string,
  options: CaveRequestOptions,
): Promise<GrapheneSource | undefined> {
  const info = await datastackRecord(datastack, options)
  const graphene = parseGrapheneSource(info.segmentation_source)
  // Not a chunkedgraph at all — `caveclient.has_cache` refuses on the same test, first.
  if (!graphene) return undefined
  const mapping = await l2TableMapping(graphene.server, options)
  return graphene.table in mapping ? graphene : undefined
}
