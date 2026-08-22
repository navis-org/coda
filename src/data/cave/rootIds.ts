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
import { cavePostRaw } from './client'
import { datastackRecord, materializationsFor, versionTimestamp } from './datastack'
import { parseGrapheneSource } from './graphene'
import { channel } from '../channel'

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

const results = new Map<string, RootCheck>()
const running = new Set<string>()

const learned = channel()
/** Fired when a check lands, so `validate` is asked again. `reportSourceLearned`'s terms. */
export const subscribeRootCheck = learned.subscribe

/** What a finished check found for a dataset, or undefined while nothing is known. */
export function peekRootCheck(datasetId: string): RootCheck | undefined {
  return results.get(datasetId)
}

/** Test seam, and what a Clear Cache on the dataset would reach. */
export function resetRootChecks(): void {
  results.clear()
  running.clear()
}

/**
 * Start a check, if one is not already running or done for this dataset.
 *
 * Deliberately returns nothing and never rejects: a caller is `evaluate`, which must not wait for
 * it and must not fail because of it. Started **once per dataset per session** — the ids arrive
 * on every run, and re-asking on each would be exactly the hammering this is meant to avoid.
 */
export function startRootCheck(
  datasetId: string,
  ids: readonly string[],
  options: CaveRequestOptions = {},
): void {
  if (results.has(datasetId) || running.has(datasetId) || ids.length === 0) return
  running.add(datasetId)
  void run(datasetId, ids, options)
    .then((result) => {
      if (!result) return
      results.set(datasetId, result)
      learned.notify()
    })
    // Swallowed: an advisory that cannot be produced has nothing to say, and a 401 already
    // travels to the Connections panel on its own channel.
    .catch(() => undefined)
    .finally(() => running.delete(datasetId))
}

async function run(
  datasetId: string,
  ids: readonly string[],
  options: CaveRequestOptions,
): Promise<RootCheck | undefined> {
  const [datastack, versionText] = datasetId.split(':')
  const version = Number(versionText)
  if (!datastack || !Number.isInteger(version)) return undefined

  const info = await datastackRecord(datastack, options)
  const graphene = parseGrapheneSource(info.segmentation_source)
  // Not a chunkedgraph, so root ids do not change and there is nothing to warn about.
  if (!graphene) return undefined

  // Fills `versionTimestamp` as a side effect; the listing is memoised, so this is free after
  // the first dataset node has run.
  await materializationsFor(datastack, options)
  const stamp = versionTimestamp(datastack, version)
  if (!stamp) return undefined
  const at = Date.parse(stamp)
  if (!Number.isFinite(at)) return undefined

  // Distinct, in first-occurrence order. An annotation base carries repeats — measured at 1,089
  // neurons on FlyTable's `main.info` — and checking one twice is a request nobody needed.
  const distinct = [...new Set(ids)].filter((id) => id !== '')
  const wanted = distinct.slice(0, MAX_ROOTS_CHECKED)

  /*
   * The persistent half, and the reason this is cheap after the first time: **whether a root was
   * current at a past instant never changes**, so an answer is good forever. Keyed on the
   * chunkedgraph table and the frozen timestamp, which together are what the answer is about —
   * not on the dataset, so two datastack nodes on one segmentation share it, and not on the id
   * list, so a base that gained rows only costs the rows it gained.
   */
  const key = `cave-roots:${graphene.server}|${graphene.table}|${at}`
  const held = await cacheGet<{ latest: string[]; stale: string[] }>(key, {
    fingerprint: `v${STORE_FORMAT}`,
  })
  const latest = new Set(held?.latest ?? [])
  const stale = new Set(held?.stale ?? [])

  const unknown = wanted.filter((id) => !latest.has(id) && !stale.has(id))
  for (let i = 0; i < unknown.length; i += CHUNK) {
    // Sequential on purpose. This is an advisory against a shared production service; firing
    // every chunk at once would be the hammering it exists to avoid.
    const batch = unknown.slice(i, i + CHUNK)
    const answer = await isLatestRoots(graphene.server, graphene.table, batch, at, options)
    for (let k = 0; k < batch.length; k++) {
      ;(answer[k] === false ? stale : latest).add(batch[k]!)
    }
  }
  if (unknown.length > 0) {
    void cacheSet(key, { latest: [...latest], stale: [...stale] }, `v${STORE_FORMAT}`)
  }

  const bad = wanted.filter((id) => stale.has(id))
  return {
    checked: wanted.length,
    stale: bad.length,
    examples: bad.slice(0, EXAMPLES),
    total: distinct.length,
  }
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
  server: string,
  table: string,
  ids: readonly string[],
  at: number,
  options: CaveRequestOptions,
): Promise<boolean[]> {
  const url =
    `${server}/segmentation/api/v1/table/${encodeURIComponent(table)}` +
    `/is_latest_roots?timestamp=${at / 1000}`
  const body = `{"node_ids":[${ids.join(',')}]}`
  const answer = await cavePostRaw<{ is_latest: boolean[] }>(url, body, options)
  return answer.is_latest ?? []
}
