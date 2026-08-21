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
import { datastackInfo, versionsMetadata } from './api'
import type { CaveRequestOptions } from './client'
import { getServer } from './credentials'
import { reportSourceLearned } from '../source'

const records = new Map<string, Promise<DatastackInfo>>()

/** Which global server the memo was filled from, so a changed setting drops it. */
let filledFrom: string | undefined

export function datastackRecord(
  datastack: string,
  options: CaveRequestOptions = {},
): Promise<DatastackInfo> {
  const server = getServer()
  if (filledFrom !== server) {
    records.clear()
    filledFrom = server
  }
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
  forgetOnServerChange()
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
  forgetOnServerChange()
  const server = materializationsFrom
  let pending = loading.get(datastack)
  if (!pending) {
    pending = load(datastack, options)
      .then((versions) => {
        if (server === materializationsFrom) {
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
  const versions = await versionsMetadata(info.local_server, datastack, options)
  return (
    versions
      // The same filter `CaveSource.listOne` applies: an expired or invalid materialization is
      // one a query against it would fail on, so offering it is offering a broken choice.
      .filter((v) => v.valid !== false && (v.status ?? 'AVAILABLE') === 'AVAILABLE')
      .map((v) => v.version)
      .sort((a, b) => b - a)
  )
}

/** A changed global server invalidates every datastack fact, this one included. */
function forgetOnServerChange(): void {
  const server = getServer()
  if (materializationsFrom === server) return
  materializations.clear()
  loading.clear()
  asked.clear()
  materializationsFrom = server
}

const materializations = new Map<string, number[]>()
const loading = new Map<string, Promise<number[]>>()
const asked = new Set<string>()
let materializationsFrom: string | undefined

/** Test seam: drop what is remembered between suites. */
export function resetDatastackRecords(): void {
  records.clear()
  materializations.clear()
  loading.clear()
  asked.clear()
  filledFrom = undefined
  materializationsFrom = undefined
}
