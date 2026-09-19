/**
 * NeuronBridge's precomputed matches, read straight from its public bucket.
 *
 * NeuronBridge has no query service: the bucket *is* the API. Every key is predictable, every
 * object is JSON under a published schema, and the whole thing answers `Access-Control-Allow-Origin:
 * *` with no credential — so a browser reads it exactly as it reads a precomputed volume, and there
 * is no proxy, no token and no auth failure to route anywhere. What it is not is a connectome, which
 * is why this is a data module that a node calls and **not** a `DataSource`: it answers no
 * `findNeurons` and no `fetchConnectivity`, the two methods the seam requires. `data/zapbench` is
 * the precedent.
 *
 * The layout, measured on `v3_10_0`:
 *
 *     current.txt                       → "v3_10_0"
 *     <version>/config.json             → libraries, and the URL prefix of every file kind
 *     <version>/metadata/by_body/<id>.json
 *     <version>/metadata/cdsresults/<imageId>.json      ~3 MB, ~2,000 matches
 *     <version>/metadata/pppmresults/<imageId>.json     ~250 kB, hemibrain only
 *
 * Four rules, each from something that went wrong while mapping it:
 *
 * - **The key is the bare body id**, never the qualified `publishedName`: `by_body/1734350788`
 *   answers, `by_body/hemibrain:v1.2.1:1734350788` is a 404.
 * - **A bare id is ambiguous across libraries**, so a lookup returns a *list* — `by_body/11442`
 *   is three neurons in three datasets. Choosing between them is the caller's, by library
 *   (`libraries.ts`), never by position.
 * - **File paths come off the record, prefixed by the store's prefix in `config.json`.** Built by
 *   hand they 404 on every nerve-cord library, which lives under a different alignment space.
 * - **Absent is an answer.** A neuron NeuronBridge never matched is a missing object, so a 404 on
 *   a lookup is an empty list, not an error (`NotFoundError`).
 */

import { NotFoundError, fetchText } from '../fetchText'
import { memoPromise } from '../memoPromise'
import { reportSourceLearned } from '../source'
import type { NbImage, NbMatches } from './types'
import { isObject, readFiles, readLookup, readMatches } from './types'

export const NB_BUCKET = 'https://janelia-neuronbridge-data-prod.s3.amazonaws.com'

/** NeuronBridge's own web app, for links out. */
export const NB_APP = 'https://neuronbridge.janelia.org'

/** The two matching algorithms NeuronBridge precomputes. */
export type NbMethod = 'cds' | 'pppm'

const HINT = 'NeuronBridge’s data is a public S3 bucket; check that the browser can reach it.'

/** `v3_10_0` → `v3.10.0`, the spelling the web app and the release notes use. */
export function versionLabel(version: string): string {
  return version.replace(/_/g, '.')
}

/**
 * Whether a data version has the layout this module reads.
 *
 * The bucket still holds every release back to `v2_1_0`, and the `by_body` / `cdsresults` split
 * with typed records arrived at 3.0. Older ones are real data in a shape nothing here parses, so
 * they are not offered rather than offered and refused.
 */
export function isReadableVersion(version: string): boolean {
  return /^v([3-9]|\d{2,})_\d+_\d+$/.test(version)
}

async function fetchJson(url: string): Promise<unknown> {
  const text = await fetchText(url, { hint: HINT })
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`${url} is not JSON.`)
  }
}

// ---------------------------------------------------------------------------
// The version pointer
// ---------------------------------------------------------------------------

const currentHeld = new Map<'current', Promise<string>>()
let currentPeek: string | undefined

/**
 * What `reportSourceLearned` is told when the pointer lands. Not a registered source — nothing
 * resolves it — but the listener re-infers whatever it is told, which is what fills a card's
 * `Latest (v3.10.0)` a beat after it first drew `Latest`. Invariant 2's loop, closed the way every
 * dataset node closes it.
 */
const NB_LEARNED_TAG = 'neuronbridge'

/**
 * The version `current.txt` names. Memoised for the session once it resolves, so the version a
 * card shows as "Latest" does not change under it half way through.
 */
export function currentVersion(): Promise<string> {
  return memoPromise(
    currentHeld,
    'current',
    async () => {
      const raw = (await fetchText(`${NB_BUCKET}/current.txt`, { hint: HINT })).trim()
      if (!isReadableVersion(raw)) {
        throw new Error(
          `NeuronBridge’s current data version is "${raw}", which this build cannot read.`,
        )
      }
      currentPeek = raw
      reportSourceLearned(NB_LEARNED_TAG)
      return raw
    },
    { keep: 'resolved' },
  )
}

/**
 * The current version if it has landed, starting the fetch if it has not — a peek, with the rule
 * every peek here follows: it starts the fetch it cannot answer, once, so the first look of a
 * session behaves like the second. No credential gates it, so there is nothing to wait for.
 */
export function peekCurrentVersion(): string | undefined {
  if (currentPeek) return currentPeek
  // A failure is not cached (memoPromise drops it), so the next peek asks again.
  currentVersion().catch(() => undefined)
  return undefined
}

// ---------------------------------------------------------------------------
// Config: libraries and file prefixes
// ---------------------------------------------------------------------------

/** One EM library NeuronBridge matched, as `config.json` lists it. */
export interface NbEmLibrary {
  /** `FlyEM_Hemibrain_v1.2.1` — what every image record's `libraryName` holds. */
  readonly name: string
  /** `hemibrain:v1.2.1` — the dataset and version it was built from. */
  readonly publishedNamePrefix: string
}

export interface NbConfig {
  readonly version: string
  /** Store id (`fl:open_data:brain`) → file kind (`CDMThumbnail`) → URL prefix. */
  readonly prefixes: ReadonlyMap<string, Readonly<Record<string, string>>>
  readonly emLibraries: readonly NbEmLibrary[]
}

const configHeld = new Map<string, Promise<NbConfig>>()

function readConfig(version: string, raw: unknown, url: string): NbConfig {
  const stores = isObject(raw) ? raw.stores : undefined
  if (!isObject(stores)) {
    throw new Error(`${url} has no "stores"; it is not a NeuronBridge data config.`)
  }
  const prefixes = new Map<string, Readonly<Record<string, string>>>()
  // By name: BANC and male CNS are listed once per store (brain, VNC) under one name.
  const libraries = new Map<string, NbEmLibrary>()
  for (const [storeId, store] of Object.entries(stores)) {
    if (!isObject(store)) continue
    // A store's prefixes are a map of file kind to URL — `readFiles`' shape exactly.
    prefixes.set(storeId, readFiles(store.prefixes))
    const em = isObject(store.customSearch) ? store.customSearch.emLibraries : undefined
    if (!Array.isArray(em)) continue
    for (const entry of em as unknown[]) {
      if (!isObject(entry)) continue
      const { name, publishedNamePrefix } = entry
      if (typeof name !== 'string' || typeof publishedNamePrefix !== 'string') continue
      libraries.set(name, { name, publishedNamePrefix })
    }
  }
  return { version, prefixes, emLibraries: [...libraries.values()] }
}

export function fetchConfig(version: string): Promise<NbConfig> {
  return memoPromise(
    configHeld,
    version,
    async () => {
      const url = `${NB_BUCKET}/${version}/config.json`
      return readConfig(version, await fetchJson(url), url)
    },
    { keep: 'resolved' },
  )
}

/**
 * The absolute URL of one of a record's files, or undefined where it names none.
 *
 * The prefix is the one the record's own `store` names for that file kind — the only way to build
 * a path that works on both halves of the fly. `http(s)` only: the result becomes an `<img src>`
 * and a link a reader clicks, and a relative path resolved against a prefix cannot become anything
 * else, but the schema also allows an absolute URL, and that is where a `javascript:` would come in.
 */
export function fileUrl(
  config: NbConfig,
  files: Readonly<Record<string, string>>,
  kind: string,
): string | undefined {
  const path = files[kind]
  if (!path) return undefined
  const prefix = config.prefixes.get(files.store ?? '')?.[kind]
  try {
    const url = prefix ? new URL(path, prefix) : new URL(path)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Lookups and match files
// ---------------------------------------------------------------------------

/**
 * Every image record NeuronBridge holds for a body id, across all its libraries.
 *
 * Empty — not an error — when there is none, which is the ordinary answer for most of a
 * connectome: NeuronBridge indexes the neurons it could render, not every segment.
 */
export async function lookupBody(version: string, bodyId: string): Promise<NbImage[]> {
  if (!/^\d+$/.test(bodyId)) return []
  const url = `${NB_BUCKET}/${version}/metadata/by_body/${bodyId}.json`
  try {
    return readLookup(await fetchJson(url), url)
  } catch (error) {
    if (error instanceof NotFoundError) return []
    throw error
  }
}

/** Which record file holds a method's matches, and the directory it lives in. */
const MATCH_FILES: Record<NbMethod, { file: string; dir: string }> = {
  cds: { file: 'CDSResults', dir: 'cdsresults' },
  pppm: { file: 'PPPMResults', dir: 'pppmresults' },
}

/** Whether a record has matches under a method at all. PPPM is hemibrain-only among EM sets. */
export function hasMatches(image: NbImage, method: NbMethod): boolean {
  return Boolean(image.files[MATCH_FILES[method].file])
}

/** A record's match file under a method. Refuses a record that has none — ask `hasMatches`. */
export function fetchMatches(
  version: string,
  image: NbImage,
  method: NbMethod,
): Promise<NbMatches> {
  const { file, dir } = MATCH_FILES[method]
  const name = image.files[file]
  if (!name || !/^[\w.-]+$/.test(name)) {
    return Promise.reject(
      new Error(
        `${image.publishedName} has no ${method.toUpperCase()} matches in NeuronBridge.`,
      ),
    )
  }
  const url = `${NB_BUCKET}/${version}/metadata/${dir}/${name}`
  return fetchJson(url).then((raw) => readMatches(raw, url))
}

/** NeuronBridge's own page for a record's matches under a method. */
export function matchesPageUrl(image: NbImage, method: NbMethod): string | undefined {
  const name = image.files[MATCH_FILES[method].file]
  if (!name) return undefined
  return `${NB_APP}/matches/${method === 'cds' ? 'cdm' : 'pppm'}/${encodeURIComponent(
    name.replace(/\.json$/, ''),
  )}`
}

/** NeuronBridge's search page for a line or a body. */
export function searchPageUrl(query: string): string {
  return `${NB_APP}/search?q=${encodeURIComponent(query)}`
}

/** Forget everything memoised here. For tests, and for nothing else yet. */
export function resetNeuronBridgeClient(): void {
  currentHeld.clear()
  configHeld.clear()
  currentPeek = undefined
}
