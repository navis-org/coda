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
    materializations.clear()
    loading.clear()
    asked.clear()
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
  return usableVersions(await versionsMetadata(info.local_server, datastack, options)).map(
    (v) => v.version,
  )
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
const loading = new Map<string, Promise<number[]>>()
const asked = new Set<string>()

/** Test seam: drop what is remembered between suites. */
export function resetDatastackRecords(): void {
  records.clear()
  materializations.clear()
  loading.clear()
  asked.clear()
  filledFrom = undefined
}
