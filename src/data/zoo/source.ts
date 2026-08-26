/**
 * Fetching the Zoo, and where from.
 *
 * Three URLs and one cache. `format.ts` says what an index is; this says where it lives and how
 * it gets here, which is the half that has to survive a network.
 *
 * **`raw.githubusercontent.com`, not the API and not a CDN.** Measured 2026-08-26:
 *
 * | host                          | CORS  | cache                    |
 * | ----------------------------- | ----- | ------------------------ |
 * | `raw.githubusercontent.com`   | `*`   | `max-age=300`            |
 * | `api.github.com`              | `*`   | 60 requests per hour, per IP  |
 * | `cdn.jsdelivr.net/gh`         | `*`   | 7 d browser / 12 h edge  |
 *
 * The API is out on the quota: sixty an hour is per *IP*, so a lab behind one NAT shares them,
 * and the failure mode is an empty zoo that nobody in the building can explain. jsDelivr is out
 * on freshness: a merged pull request that takes twelve hours to appear reads as a broken
 * submission process, and a contributor cannot tell that case from a rejected one. Raw's five
 * minutes is the only one of the three that is both unmetered and prompt.
 *
 * **The cache is `data/cache.ts`, deliberately** — the evictable one. A zoo entry is somebody
 * else's document that this browser happens to have seen; `store/library.ts` is for graphs the
 * user saved and must never lose, and filing a downloaded index there would make "clear caches"
 * unable to clear it. The cache doubles as the offline story: a failed fetch with a stale copy
 * in hand shows the copy and says how old it is, because a month-old list of workflows is worth
 * a great deal more than an error page.
 *
 * Nothing here parses a graph or touches the store. What comes back is text, and the caller
 * hands it to the same `deserializeGraph` a file or a share link goes through.
 */

import { cacheGetEntry, cacheSet } from '../cache'
import { fetchText } from '../fetchText'
import type { ParsedZooIndex, ZooEntry } from './format'
import { parseZooIndex } from './format'

/** Where the zoo lives. A constant, so a card's host is named in Coda's own source. */
export interface ZooSource {
  /** `owner/name`. */
  repo: string
  /** Branch or tag the index and its paths are relative to. */
  ref: string
}

export const DEFAULT_ZOO: ZooSource = { repo: 'navis-org/coda-zoo', ref: 'main' }

/** Raw's own `max-age`. Matching it means the browser cache and this one expire together. */
export const ZOO_INDEX_MAX_AGE_MS = 5 * 60 * 1000

export const ZOO_INDEX_PATH = 'index.json'

/** What a 404 from raw means here, which is not what it means anywhere else. */
const NOT_FOUND = 'The Zoo repository may have moved, or this entry may have been withdrawn.'

export function zooRawUrl(path: string, source: ZooSource = DEFAULT_ZOO): string {
  return `https://raw.githubusercontent.com/${source.repo}/${source.ref}/${path}`
}

/** The entry's directory on github.com — where its README renders and its history lives. */
export function zooEntryUrl(entry: ZooEntry, source: ZooSource = DEFAULT_ZOO): string {
  return `https://github.com/${source.repo}/tree/${source.ref}/workflows/${entry.slug}`
}

export function zooRepoUrl(source: ZooSource = DEFAULT_ZOO): string {
  return `https://github.com/${source.repo}`
}

function key(source: ZooSource, suffix: string): string {
  return `zoo:${source.repo}@${source.ref}:${suffix}`
}

/** The index, plus what the caller needs to say about how current it is. */
export interface LoadedZooIndex extends ParsedZooIndex {
  /** Epoch ms this copy was downloaded. */
  savedAt: number
  /**
   * True when the network failed and this is a cached copy served in its place. Distinct from
   * merely being older than the TTL, which is invisible and uninteresting — this one is the
   * case the UI has to disclose, because the list may be missing entries that exist.
   */
  stale: boolean
}

export interface LoadZooOptions {
  source?: ZooSource
  /** Skip the cache and go to the network. What the browser's Refresh does. */
  force?: boolean
}

/**
 * The index, from cache or network.
 *
 * The ordering is what makes a reopened browser instant and a broken network survivable: a
 * fresh cached copy short-circuits, a fetch failure falls back to *any* cached copy however
 * old, and only a failure with nothing in hand throws.
 *
 * A parse failure is **not** cached over. If the repository publishes a malformed index, the
 * copy already here is the better answer and the error is reported against the download rather
 * than replacing a working list with an empty one.
 */
export async function loadZooIndex(options: LoadZooOptions = {}): Promise<LoadedZooIndex> {
  const source = options.source ?? DEFAULT_ZOO
  const cacheKey = key(source, ZOO_INDEX_PATH)

  /*
   * One read, not two. Asking with `maxAgeMs` and then asking again without it on the failure
   * path is two round trips to IndexedDB for the same record — the age is a number this side can
   * compare perfectly well once it has `savedAt`.
   */
  const held = await cacheGetEntry<string>(cacheKey)
  /*
   * `force` suppresses the *short-circuit*, not the copy. Refresh means "go and ask again", not
   * "forget what you have" — a forced refresh that then fails offline must still be able to put
   * the cached list back, which is exactly the case the button is pressed in.
   */
  const fresh =
    !options.force && held !== undefined && Date.now() - held.savedAt <= ZOO_INDEX_MAX_AGE_MS

  /** A cached copy that no longer parses is a Coda that has moved past it: not an answer. */
  const parsedHeld = () => {
    if (!held) return undefined
    try {
      return parseZooIndex(held.value)
    } catch {
      return undefined
    }
  }

  if (fresh) {
    const parsed = parsedHeld()
    if (parsed) return { ...parsed, savedAt: held!.savedAt, stale: false }
  }

  let text: string
  try {
    text = await fetchText(zooRawUrl(ZOO_INDEX_PATH, source), { notFound: NOT_FOUND })
  } catch (err) {
    const parsed = parsedHeld()
    if (parsed) return { ...parsed, savedAt: held!.savedAt, stale: true }
    throw err
  }

  const parsed = parseZooIndex(text)
  await cacheSet(cacheKey, text)
  return { ...parsed, savedAt: Date.now(), stale: false }
}

/**
 * One file belonging to an entry, cached by the revision the index named.
 *
 * Fingerprinted on `updatedAt` rather than expiring on a clock: a workflow that has not been
 * touched since it was cached is byte-identical, and a workflow that *has* been touched must
 * miss immediately rather than after five minutes. The index is the thing that goes stale here;
 * a file keyed by the revision the index named cannot.
 *
 * One function for both files because the two differ in nothing but a path and a cache-key
 * prefix — and a caching rule stated twice is a caching rule that can be changed once.
 */
async function loadEntryFile(
  entry: ZooEntry,
  path: string,
  kind: string,
  source: ZooSource,
): Promise<string> {
  const cacheKey = key(source, `${kind}:${entry.slug}`)
  const hit = await cacheGetEntry<string>(cacheKey, { fingerprint: entry.updatedAt })
  if (hit) return hit.value

  const text = await fetchText(zooRawUrl(path, source), { notFound: NOT_FOUND })
  await cacheSet(cacheKey, text, entry.updatedAt)
  return text
}

export function loadZooGraph(
  entry: ZooEntry,
  options: { source?: ZooSource } = {},
): Promise<string> {
  return loadEntryFile(entry, entry.graph, 'graph', options.source ?? DEFAULT_ZOO)
}

/**
 * The entry's long description, as markdown.
 *
 * Resolves to undefined where the entry declares no README — an absent description is a thinner
 * panel, not a failure. A *fetch* failure is thrown, because that one the reader can act on by
 * pressing the thing again.
 */
export async function loadZooReadme(
  entry: ZooEntry,
  options: { source?: ZooSource } = {},
): Promise<string | undefined> {
  if (!entry.readme) return undefined
  return loadEntryFile(entry, entry.readme, 'readme', options.source ?? DEFAULT_ZOO)
}
