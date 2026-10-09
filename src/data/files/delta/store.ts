/**
 * A Delta table's log, read over HTTP — the `DeltaStore` the app's snapshots come from.
 *
 * Reads go through the precomputed transport, so a public bucket that allows no cross-origin reads
 * at its direct address — CAVE's exports are one — is read through GCS's JSON API as its data
 * files are. The log is fetched past the HTTP cache: a new commit is exactly what a refresh is for.
 *
 * **Listing is GCS's, where the table is on GCS.** A plain web server cannot say what is in a
 * folder, so elsewhere the commits after the checkpoint are asked for a batch at a time
 * (`log.ts`); on GCS one request lists them all, and the newest checkpoint with them.
 */

import {
  fetchBytes,
  fetchJson,
  gcsListUrl,
  gcsObject,
  isNotFound,
} from '../../precomputed/transport'
import type { DeltaStore } from './log'

export function httpDeltaStore(root: string): DeltaStore {
  const list = gcsListing(root)
  return {
    root,
    read: async (path, maxBytes) => {
      try {
        const options = { cache: 'no-store', ...(maxBytes ? { maxBytes } : {}) } as const
        return new Uint8Array(await fetchBytes(`${root}/${path}`, options))
      } catch (error) {
        if (isNotFound(error)) return undefined
        throw error
      }
    },
    ...(list ? { listLog: list } : {}),
  }
}

/** A GCS table's log listed through the JSON API, or undefined for a table elsewhere. */
function gcsListing(root: string): DeltaStore['listLog'] {
  const table = gcsObject(root)
  if (!table) return undefined
  const folder = { bucket: table.bucket, key: `${table.key}/_delta_log` }
  return async (from) => {
    const names: string[] = []
    let page: string | undefined
    try {
      do {
        const body = await fetchJson<{ items?: { name: string }[]; nextPageToken?: string }>(
          gcsListUrl(folder, `${table.key}/${from}`, page),
          { cache: 'no-store' },
        )
        for (const item of body.items ?? []) names.push(item.name.slice(folder.key.length + 1))
        page = body.nextPageToken
      } while (page)
    } catch {
      // A bucket that will not list: the commits are asked for a batch at a time instead.
      return undefined
    }
    return names.sort()
  }
}
