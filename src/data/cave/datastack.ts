/**
 * A datastack's info record, fetched at most once per datastack.
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
 */

import type { DatastackInfo } from './api'
import type { VersionInfo } from './api'
import { datastackInfo, versionsMetadata } from './api'
import type { CaveRequestOptions } from './client'
import { getServer } from './credentials'
import { reportSourceLearned } from '../source'
import type { GrapheneSource } from './graphene'
import { parseGrapheneSource } from './graphene'
import { l2TableMapping, resetL2Cache } from './l2'

const records = new Map<string, Promise<DatastackInfo>>()

/**
 * Which global server everything here was filled from.
 *
 * **One clock for all four maps**, because the materializations are derived from the records —
 * `load` reads `datastackRecord` — so two generations could clear one and keep the other, and
 * did: each was checked only by its own entry point.
 */
let filledFrom: string | undefined

/**
 * Drop everything learned from a global server that is no longer the configured one, and answer
 * which server is current — so a caller cannot read `filledFrom` before it has been set.
 */
function currentServer(): string {
  const server = getServer()
  if (filledFrom !== server) {
    records.clear()
    clearLearned()
    filledFrom = server
  }
  return server
}

export function datastackRecord(
  datastack: string,
  options: CaveRequestOptions = {},
): Promise<DatastackInfo> {
  const server = currentServer()
  let record = records.get(datastack)
  if (!record) {
    record = datastackInfo(server, datastack, options).catch((error: unknown) => {
      records.delete(datastack)
      throw error
    })
    records.set(datastack, record)
  }
  return record
}

/** The server that answers queries for a datastack. */
export async function caveServerFor(
  datastack: string,
  options?: CaveRequestOptions,
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
export function peekMaterializations(datastack: string): number[] | undefined {
  currentServer()
  const known = materializations.get(datastack)
  if (known || !datastack || asked.has(datastack)) return known
  asked.add(datastack)
  // Swallowed: a peek has no caller to report to, and a 401 already travels on its own channel
  // to the Connections panel. `NeuPrintSource.peekDatasets`' trade.
  void materializationsFor(datastack).catch(() => undefined)
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
  options: CaveRequestOptions = {},
): Promise<number[]> {
  const server = currentServer()
  let pending = loading.get(datastack)
  if (!pending) {
    pending = load(datastack, options)
      .then((versions) => {
        if (server === filledFrom) {
          materializations.set(datastack, versions)
          // Not a data-changed event: nothing cached is invalidated and no run is scheduled. It
          // only tells inference that a dropdown it drew empty can be filled in.
          reportSourceLearned('cave')
        }
        return versions
      })
      .finally(() => {
        loading.delete(datastack)
      })
    loading.set(datastack, pending)
  }
  return pending
}

async function load(datastack: string, options: CaveRequestOptions): Promise<number[]> {
  const info = await datastackRecord(datastack, options)
  const usable = usableVersions(await versionsMetadata(info.local_server, datastack, options))
  // Kept whole rather than reduced to numbers: the same reply carries each version's
  // `time_stamp`, which is what a root id is judged against, and asking for it separately would
  // be a second round trip for something already in hand.
  versionInfo.set(datastack, usable)
  return usable.map((v) => v.version)
}

/**
 * When a materialization was frozen, if it is known — the moment a root id has to have been
 * current at for the annotations keyed on it to mean anything.
 *
 * `undefined` until the listing has landed, `peekMaterializations`' contract; the caller that
 * needs it can await `materializationsFor` first, which fills this as a side effect.
 */
export function versionTimestamp(datastack: string, version: number): string | undefined {
  currentServer()
  return versionInfo.get(datastack)?.find((v) => v.version === version)?.time_stamp
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

/**
 * Everything learned from one global server, dropped together.
 *
 * One list rather than two hand-kept ones: `currentServer` and the test seam both cleared these
 * and the diff that added the third fact had to edit both in lockstep, with nothing catching a
 * half-edit. That is the failure this module's header already records — "two generations could
 * clear one and keep the other, and did".
 */
function clearLearned(): void {
  records.clear()
  materializations.clear()
  versionInfo.clear()
  loading.clear()
  asked.clear()
  l2Sources.clear()
  l2Loading.clear()
  resetL2Cache()
}

/** Test seam: drop what is remembered between suites. */
export function resetDatastackRecords(): void {
  clearLearned()
  filledFrom = undefined
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
export function peekL2Cache(datastack: string): boolean | undefined {
  currentServer()
  if (l2Sources.has(datastack)) return l2Sources.get(datastack) !== null
  if (!datastack || l2Loading.has(datastack)) return undefined
  // Swallowed: a peek has no caller to report to, and a 401 travels on its own channel.
  void l2SourceFor(datastack).catch(() => undefined)
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
  options: CaveRequestOptions = {},
): Promise<GrapheneSource | undefined> {
  const server = currentServer()
  const known = l2Sources.get(datastack)
  if (known !== undefined) return Promise.resolve(known ?? undefined)

  let pending = l2Loading.get(datastack)
  if (!pending) {
    pending = resolveL2(datastack, options)
      .then((source) => {
        if (server !== filledFrom) return source
        const before = l2Sources.get(datastack)
        l2Sources.set(datastack, source ?? null)
        // Only when the answer *changed*, which for a memoised fact means only the first time.
        // Fired unconditionally it costs a whole-graph re-inference per Run of a Skeletons node.
        if (before === undefined) reportSourceLearned('cave')
        return source
      })
      .finally(() => {
        l2Loading.delete(datastack)
      })
    l2Loading.set(datastack, pending)
  }
  return pending
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
