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
import { datastackInfo } from './api'
import type { CaveRequestOptions } from './client'
import { getServer } from './credentials'

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

/** Test seam: drop what is remembered between suites. */
export function resetDatastackRecords(): void {
  records.clear()
  filledFrom = undefined
}
