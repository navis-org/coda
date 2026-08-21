/**
 * SeaTable as an annotation source — which is FlyTable, and `cloud.seatable.io`, and any other
 * deployment of the same product.
 *
 * One provider for all of them, with the host in the ref, because they *are* one API: the nodes
 * differ only in which host they default to. Everything below was probed live against FlyTable
 * rather than read from documentation, and three of the findings would each have cost a day.
 *
 * **Reading a base takes two tokens and four calls.** The account token lists workspaces, mints a
 * per-base JWT, and that JWT reads the base:
 *
 * ```text
 * GET  {host}/api/v2.1/workspaces/                                   → bases, by workspace
 * GET  {host}/api/v2.1/workspace/{ws}/dtable/{base}/access-token/    → JWT + uuid + dtable_server
 * GET  {server}/api/v1/dtables/{uuid}/metadata/                      → tables and their columns
 * GET  {server}/api/v1/dtables/{uuid}/rows/?table_name=…&limit=…     → the rows
 * ```
 *
 * The auth scheme is **`Token`**, not `Bearer`, on every one of them — a `Bearer` JWT gets
 * `403 invalid token`, which names the token rather than the scheme and sends you looking in the
 * wrong place. All four answer a browser with `Access-Control-Allow-Origin: *`, **including the
 * 403**, which is what makes the auth-failure channel work at all.
 *
 * **The rows endpoint has no column selection, and the one that does cannot be reached from a
 * browser.** `/dtable-db/api/v1/query/` takes SQL and answers 200 — with no ACAO header, so a
 * page cannot read it. So a whole-table read is every column: FlyWire's `main.info` is 58,340
 * rows over 60 columns at **~79 MB**, in six requests of 10,000, and **SeaTable does not gzip**,
 * so that is 79 MB on the wire. The `columns` param on the node cannot change what is
 * transferred; it changes what is kept, which is what keeps the cached table and the neuron
 * index small. The download is cached in IndexedDB and paid once per base.
 *
 * **Ids are already text.** `root_id` comes back as `"720575940621522189"` — a JSON string — so
 * it round-trips exactly and meets CAVE's string ids with no conversion at all. That is the half
 * of invariant 8 that was free, and it is why these two backends can be joined.
 */

import type { DType, TableSchema } from '../../core/types'
import { column, tableSchema } from '../../core/types'
import { ID_COLUMN_NAME } from '../../core/ids'
import type { CellValue, ColumnData, TableValue } from '../../core/values'
import { makeTable } from '../../core/values'
import { errorMessage } from '../../core/errors'
import { readStorage, writeStorage } from '../localStore'
import { getToken, normaliseHost, reportAuthFailure } from './credentials'
import {
  cachedAnnotationTable,
  registerAnnotationProvider,
  reportAnnotationsLearned,
} from './registry'
import type { AnnotationFetchOptions, AnnotationProvider, AnnotationRef } from './types'
import { annotationColumn, namedColumns } from './types'

export const SEATABLE_PROVIDER = 'seaTable'

/** How many rows one request returns. The server's own maximum. */
const PAGE_SIZE = 10_000

/** A backstop against a base nobody should be reading whole. Six pages is FlyWire's `info`. */
const MAX_PAGES = 40

export class SeaTableError extends Error {
  readonly status: number
  constructor(message: string, status = 0) {
    super(message)
    this.name = 'SeaTableError'
    this.status = status
  }
}

/** What a SeaTable ref names: a host, a base, and a table inside it. */
export interface SeaTableConfig extends Record<string, string> {
  host: string
  workspace: string
  base: string
  table: string
  /** Column holding the neuron id. Renamed to `neuronId` on the way out. */
  idColumn: string
  /** Comma-separated columns to keep. Empty keeps everything but the id. */
  columns: string
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** Path prefix of the dev proxy that relays a named SeaTable host. See `vite.config.ts`. */
const PROXY_PREFIX = '/st'

/** `direct` is the deployment itself and needs CORS; `proxy` is a same-origin relay. */
type RouteKind = 'direct' | 'proxy'

const ROUTE_KEY = 'coda.seatable.routes.v1'
let routeMemory: Map<string, RouteKind> | undefined

function memory(): Map<string, RouteKind> {
  if (routeMemory) return routeMemory
  routeMemory = new Map()
  try {
    const stored = readStorage(ROUTE_KEY)
    if (stored) {
      for (const [host, kind] of Object.entries(JSON.parse(stored) as Record<string, RouteKind>)) {
        if (kind === 'direct' || kind === 'proxy') routeMemory.set(host, kind)
      }
    }
  } catch {
    // A corrupt entry is not worth failing a fetch over; re-probing costs one request.
  }
  return routeMemory
}

/**
 * Remember how a host answered — **only on a 2xx**.
 *
 * `neuprint/client.ts`'s rule and it matters for the same reason: a 404 is what a static host
 * answers for a proxy path nobody serves, so remembering it would pin a deployment to a route
 * that can never work, and would outlive the day that deployment gains CORS.
 */
function rememberRoute(origin: string, kind: RouteKind): void {
  const map = memory()
  if (map.get(origin) === kind) return
  map.set(origin, kind)
  writeStorage(ROUTE_KEY, JSON.stringify(Object.fromEntries(map)))
}

/** Drop what is known about how to reach a host, so the next request re-probes. */
export function forgetSeaTableRoutes(origin?: string): void {
  const map = memory()
  if (origin) map.delete(new URL(normaliseHost(origin)).origin)
  else map.clear()
  writeStorage(ROUTE_KEY, map.size ? JSON.stringify(Object.fromEntries(map)) : undefined)
}

/**
 * The URLs worth trying for one request, best first.
 *
 * **Direct first, proxy as the fallback**, which is `routesForServer`'s order and for the same
 * reason: `cloud.seatable.io` answers a preflight 204 carrying
 * `Access-Control-Allow-Origin: *`, so the hosted service needs no relay at all and asking for
 * one would be slower and would fail on a static deploy. FlyTable sends no `Access-Control-*`
 * header for any origin — checked against four different `Origin` values, so it is an absence
 * rather than an allowlist — and a browser cannot tell that from a dead host, since both arrive
 * as an opaque `TypeError`. So the only way to know is to try, and the answer is remembered per
 * origin because otherwise every request in a proxied session pays a failed preflight first.
 *
 * The remembered route is *preferred*, not used exclusively: a dev server that has stopped
 * running, or a deployment that has since gained CORS, still resolves without anybody clearing
 * anything.
 */
function routesFor(url: string): Array<{ url: string; kind: RouteKind }> {
  const parsed = new URL(url)
  const routes: Array<{ url: string; kind: RouteKind }> = [
    { url, kind: 'direct' },
    {
      url: `${PROXY_PREFIX}/${encodeURIComponent(parsed.origin)}${parsed.pathname}${parsed.search}`,
      kind: 'proxy',
    },
  ]
  const preferred = memory().get(parsed.origin)
  if (!preferred) return routes
  return [...routes].sort((a, b) => Number(b.kind === preferred) - Number(a.kind === preferred))
}

async function request<T>(url: string, token: string, signal?: AbortSignal): Promise<T> {
  const origin = new URL(url).origin
  const headers = {
    // `Token`, not `Bearer` — a Bearer JWT answers 403 `invalid token`, which blames the
    // credential rather than the scheme.
    Authorization: `Token ${token}`,
    Accept: 'application/json',
  }

  /*
   * Only a *thrown* fetch moves on to the next route — `neuprint/client.ts`'s rule and
   * `transport.ts`'s before it. A response of any status means the request plainly arrived, so a
   * 404 is SeaTable saying 404 rather than this route being wrong.
   */
  let response: Response | undefined
  let lastError: unknown
  for (const route of routesFor(url)) {
    try {
      response = await fetch(route.url, { headers, ...(signal ? { signal } : {}) })
    } catch (error) {
      // An AbortError is the scheduler cancelling. It must stay an AbortError, and must never be
      // answered by issuing the request the cancellation was meant to stop.
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      lastError = error
      response = undefined
      continue
    }
    if (response.ok) rememberRoute(origin, route.kind)
    break
  }

  if (!response) {
    throw new SeaTableError(
      `Could not reach ${origin}. It could not be read cross-origin, or the host is down — a ` +
        `browser reports both the same way. FlyTable currently sends no CORS headers at all, so ` +
        `a browser blocks the request before it is sent; the relay Coda falls back to comes from ` +
        `vite.config.ts, which means \`pnpm dev\` or \`pnpm preview\` serve it and a static ` +
        `deploy serves nothing there. The real fix is one CORS header on the deployment. ` +
        `(${errorMessage(lastError)})`,
    )
  }

  if (response.status === 401 || response.status === 403) {
    const message =
      `${new URL(url).origin} rejected the token (${response.status}). It may have expired, or ` +
      `it may be a *base* API token — this needs an account token.`
    reportAuthFailure(message)
    throw new SeaTableError(message, response.status)
  }
  const text = await response.text()
  if (!response.ok) {
    throw new SeaTableError(`SeaTable returned ${response.status}: ${explain(text)}`, response.status)
  }
  return JSON.parse(text) as T
}

/** SeaTable's errors are `{error_msg}`; anything else is a served page. */
function explain(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error_msg?: string; error_message?: string }
    return parsed.error_msg ?? parsed.error_message ?? body.slice(0, 300)
  } catch {
    return body.slice(0, 300) || '(empty response)'
  }
}

function requireToken(host: string): string {
  const token = getToken(host)
  if (!token) {
    const message = `No token for ${host}. Add one in Connections — the branch icon in the toolbar.`
    reportAuthFailure(message)
    throw new SeaTableError(message, 401)
  }
  return token
}

// ---------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------

export interface SeaTableBase {
  workspaceId: string
  workspaceName: string
  name: string
}

interface WorkspaceListing {
  workspace_list?: Array<{
    id?: number | string
    name?: string
    table_list?: Array<{ name?: string }>
  }>
}

/**
 * The account's bases, fetched at most once per host.
 *
 * The promise is memoised rather than the value, so two nodes resolving a workspace a tick apart
 * issue one listing — `datastackRecord`'s idiom, and it matters more here because every ref that
 * leaves `Workspace` empty needs this before it can open anything. A rejection is not kept, so
 * the next caller retries rather than inheriting a failure forever.
 */
const listings = new Map<string, Promise<SeaTableBase[]>>()

/** The settled value, for the edit-time check. Never starts a fetch — see `peekBases`. */
const listed = new Map<string, SeaTableBase[]>()

function basesFor(host: string, signal?: AbortSignal): Promise<SeaTableBase[]> {
  const root = normaliseHost(host)
  let pending = listings.get(root)
  if (!pending) {
    pending = listBases(root, signal)
      .then((bases) => {
        listed.set(root, bases)
        // A workspace that could not be resolved a moment ago now can, and `validate` reads the
        // settled listing — the same channel a landed column list uses.
        reportAnnotationsLearned()
        return bases
      })
      .catch((error: unknown) => {
        listings.delete(root)
        throw error
      })
    listings.set(root, pending)
  }
  return pending
}

/**
 * The listing if it has already landed, without asking for one.
 *
 * Deliberately does **not** start a fetch, unlike every other peek here. `validate` runs on every
 * graph mutation and this one would fire a listing — and, with no token, an auth-failure popup —
 * for a node somebody is still typing into. It has nothing to say until something else has asked,
 * which in practice is the moment `peekColumns` resolves the same base.
 */
export function peekBases(host: string): SeaTableBase[] | undefined {
  return listed.get(normaliseHost(host))
}

/**
 * Which workspace a base lives in.
 *
 * **Empty means "work it out"**, which is the ordinary case: a base is addressed by workspace and
 * name, but a name is very nearly always unique across an account, and making somebody look up a
 * numeric workspace id to read a table they can see is asking them to do the API's bookkeeping.
 * The id is still there to be set — it is the only thing that can disambiguate — and the failure
 * when it is needed says so rather than picking one.
 *
 * Exact match first, then case-insensitively, because a base name is something people retype.
 * Ambiguity is reported the same way in either pass, so the second is a convenience that cannot
 * quietly choose between two bases.
 */
export function resolveWorkspace(bases: readonly SeaTableBase[], base: string): string[] {
  const exact = bases.filter((b) => b.name === base)
  if (exact.length > 0) return [...new Set(exact.map((b) => b.workspaceId))]
  const folded = base.toLowerCase()
  return [...new Set(bases.filter((b) => b.name.toLowerCase() === folded).map((b) => b.workspaceId))]
}

/** The one workspace holding `base`, or an error explaining which half of that failed. */
async function workspaceFor(
  host: string,
  base: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const bases = await basesFor(host, signal)
  const found = resolveWorkspace(bases, base)
  if (found.length === 1) return found[0]!
  if (found.length === 0) {
    const names = [...new Set(bases.map((b) => b.name))]
    throw new SeaTableError(
      `No base called "${base}" on ${normaliseHost(host)}. The account can see: ` +
        `${names.slice(0, 12).join(', ')}${names.length > 12 ? `, and ${names.length - 12} more` : ''}.`,
    )
  }
  const where = bases
    .filter((b) => resolveWorkspace([b], base).length === 1)
    .map((b) => `${b.workspaceName} (${b.workspaceId})`)
  throw new SeaTableError(
    `${found.length} bases are called "${base}" on ${normaliseHost(host)} — in ${where.join(', ')}. ` +
      `Set Workspace to the one you mean.`,
  )
}

/**
 * Every base the account can see, flattened.
 *
 * Flattened because a base is addressed by `(workspace, name)` and the workspace is bookkeeping
 * — the picker wants one list, with the workspace shown for the several bases that share a name
 * across groups.
 */
export async function listBases(host: string, signal?: AbortSignal): Promise<SeaTableBase[]> {
  const root = normaliseHost(host)
  const listing = await request<WorkspaceListing>(
    `${root}/api/v2.1/workspaces/`,
    requireToken(root),
    signal,
  )
  const bases: SeaTableBase[] = []
  for (const workspace of listing.workspace_list ?? []) {
    // `starred` and `shared` are pseudo-workspaces with no id; their bases appear again under a
    // real one, and a ref pointing at them cannot mint a token.
    if (workspace.id === undefined || workspace.id === null) continue
    for (const base of workspace.table_list ?? []) {
      if (!base.name) continue
      bases.push({
        workspaceId: String(workspace.id),
        workspaceName: workspace.name ?? String(workspace.id),
        name: base.name,
      })
    }
  }
  return bases
}

interface BaseAccess {
  access_token: string
  dtable_uuid: string
  dtable_server: string
}

async function openBase(
  host: string,
  workspace: string,
  base: string,
  signal?: AbortSignal,
): Promise<BaseAccess> {
  const root = normaliseHost(host)
  const ws = workspace || (await workspaceFor(root, base, signal))
  const access = await request<BaseAccess>(
    `${root}/api/v2.1/workspace/${encodeURIComponent(ws)}/dtable/${encodeURIComponent(base)}/access-token/`,
    requireToken(root),
    signal,
  )
  return { ...access, dtable_server: access.dtable_server.replace(/\/+$/, '') }
}

interface Metadata {
  metadata?: {
    tables?: Array<{ name?: string; columns?: Array<{ name?: string; type?: string }> }>
  }
}

export interface SeaTableTable {
  name: string
  columns: Array<{ name: string; type: string }>
}

/** The base's tables and their columns — the cheap half of discovery. */
export async function readMetadata(
  host: string,
  workspace: string,
  base: string,
  signal?: AbortSignal,
): Promise<SeaTableTable[]> {
  return readMetadataWith(await openBase(host, workspace, base, signal), signal)
}

/** The same, given a base already opened — so one read does not mint two tokens. */
async function readMetadataWith(
  access: BaseAccess,
  signal?: AbortSignal,
): Promise<SeaTableTable[]> {
  const meta = await request<Metadata>(
    `${access.dtable_server}/api/v1/dtables/${access.dtable_uuid}/metadata/`,
    access.access_token,
    signal,
  )
  return (meta.metadata?.tables ?? []).map((table) => ({
    name: table.name ?? '',
    columns: (table.columns ?? []).map((c) => ({ name: c.name ?? '', type: c.type ?? 'text' })),
  }))
}

interface RowsPage {
  rows?: Array<Record<string, unknown>>
}

/**
 * Every row of one table, paged.
 *
 * There is no filter and no column selection to be had — see the module note — so this is the
 * whole table or nothing. Pages are sequential rather than concurrent on purpose: `start` is an
 * offset into a live base, and firing six of them at once against a server that is also being
 * edited is how a page gets read twice and another missed.
 */
async function readAllRows(
  access: BaseAccess,
  config: SeaTableConfig,
  options: AnnotationFetchOptions,
): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const url =
      `${access.dtable_server}/api/v1/dtables/${access.dtable_uuid}/rows/` +
      `?table_name=${encodeURIComponent(config.table)}&limit=${PAGE_SIZE}&start=${page * PAGE_SIZE}`
    const body = await request<RowsPage>(url, access.access_token, options.signal)
    const batch = body.rows ?? []
    rows.push(...batch)
    options.onProgress?.(Math.min(0.95, (page + 1) / 8), `${rows.length} rows`)
    if (batch.length < PAGE_SIZE) return rows
  }
  throw new SeaTableError(
    `"${config.table}" is longer than ${(MAX_PAGES * PAGE_SIZE).toLocaleString()} rows, which ` +
      `is more than Coda will read into one annotation table.`,
  )
}

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

/**
 * SeaTable's column types, narrowed to what a Coda table can hold.
 *
 * Everything not obviously numeric or boolean is text, deliberately: a `single-select` is a
 * string, a `date` is a string nobody here does arithmetic on, and a `link` is an array of row
 * ids that has no cell representation at all. Widening on the way in is the safe direction —
 * `csv.ts` makes the same call for the same reason.
 */
function dtypeFor(type: string): DType {
  switch (type) {
    case 'number':
      return 'f64'
    case 'checkbox':
      return 'bool'
    default:
      return 'str'
  }
}

/** A cell, refusing anything a column cannot hold rather than stringifying it into noise. */
function cellFor(value: unknown, dtype: DType): CellValue {
  if (value === null || value === undefined) return null
  if (dtype === 'bool') return value === true
  if (dtype === 'f64') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  // An array is a `link` or a `multiple-select`; joined rather than dropped, because the values
  // are what somebody would filter on.
  if (Array.isArray(value)) return value.map(String).join(', ')
  if (typeof value === 'object') return null
  return String(value)
}

/** Which columns a ref keeps: the named ones, or everything but the id. */
function keptColumns(config: SeaTableConfig, available: SeaTableTable | undefined): string[] {
  const named = namedColumns(config.columns, config.idColumn)
  if (named.length > 0) return named
  return (available?.columns ?? [])
    .map((c) => c.name)
    .filter((name) => name && name !== config.idColumn)
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

/**
 * Base metadata, keyed by base.
 *
 * `has()` means asked, the value means landed — one Map rather than a record with a `requested`
 * flag beside a `tables` field, which was a boolean that had to agree with the map's own
 * membership and was written in four places.
 */
const discovery = new Map<string, SeaTableTable[] | undefined>()

function baseKey(config: SeaTableConfig): string {
  return `${normaliseHost(config.host)}|${config.workspace}|${config.base}`
}

class SeaTableProvider implements AnnotationProvider {
  readonly id = SEATABLE_PROVIDER
  readonly label = 'SeaTable'

  peekColumns(ref: AnnotationRef): TableSchema | undefined {
    const config = ref.config as SeaTableConfig
    if (!config.host || !config.base || !config.table) return undefined
    const tables = this.tablesFor(config)
    if (!tables) return undefined
    const table = tables.find((t) => t.name === config.table)
    if (!table) return tableSchema(column(ID_COLUMN_NAME, 'str'))
    const kept = keptColumns(config, table)
    const byName = new Map(table.columns.map((c) => [c.name, c.type]))
    return tableSchema(
      column(ID_COLUMN_NAME, 'str'),
      ...kept.map((name) => column(annotationColumn(name), dtypeFor(byName.get(name) ?? 'text'))),
    )
  }

  /** The base's metadata, asked for once per base per instance. See invariant 2's corollary. */
  private tablesFor(config: SeaTableConfig): SeaTableTable[] | undefined {
    const key = baseKey(config)
    if (discovery.has(key)) return discovery.get(key)
    discovery.set(key, undefined)
    // Swallowed: a peek has no caller to report to, and a 401 already travels on its own
    // channel. Never retried from here — inference runs on every graph mutation.
    void readMetadata(config.host, config.workspace, config.base)
      .then((tables) => {
        discovery.set(key, tables)
        reportAnnotationsLearned()
      })
      .catch(() => undefined)
    return undefined
  }

  async fetch(ref: AnnotationRef, options: AnnotationFetchOptions): Promise<TableValue> {
    const config = ref.config as SeaTableConfig
    /*
     * Resolved **before** the cache key is taken, so `main` and `5 / main` are one entry rather
     * than two. That is not tidiness: FlyWire's `main.info` is 58,340 rows over 60 columns at
     * ~79 MB ungzipped, so two spellings of one base is a second 20-second download and a second
     * copy in IndexedDB. The key is what the ref *means*, not what somebody typed.
     */
    // A ref that names its workspace never lists at all: that is a whole round trip, and an
    // account whose `/workspaces/` is slow or forbidden can still open a base it has the id for.
    const workspace =
      config.workspace || (await workspaceFor(config.host, config.base, options.signal))
    const resolved: AnnotationRef = { ...ref, config: { ...config, workspace } }
    return cachedAnnotationTable(resolved, options, () =>
      this.read(resolved.config as SeaTableConfig, options),
    )
  }

  private async read(
    config: SeaTableConfig,
    options: AnnotationFetchOptions,
  ): Promise<TableValue> {
    options.onProgress?.(0.05, 'opening base')
    /*
     * One base token for the whole read. Metadata first, because it names the columns and their
     * types and `keptColumns` needs it when the ref asks for everything — but through the same
     * `access`, or reading a table mints two JWTs back to back for no reason.
     */
    const access = await openBase(config.host, config.workspace, config.base, options.signal)
    const tables = await readMetadataWith(access, options.signal)
    const meta = tables.find((t) => t.name === config.table)
    if (!meta) {
      throw new SeaTableError(
        `"${config.base}" has no table called "${config.table}". It has: ` +
          `${tables.map((t) => t.name).join(', ')}`,
      )
    }
    discovery.set(baseKey(config), tables)

    const rows = await readAllRows(access, config, options)
    const table = shapeRows(rows, config, meta)
    options.onProgress?.(1, `${table.length} rows`)
    return table
  }
}

/**
 * Rows to a table, keyed by `neuronId`.
 *
 * Column-wise rather than through `tableFromRows`, because a base runs to tens of thousands of
 * rows and this is the shape the loop already has. Rows whose id cell is empty are dropped and
 * not counted — an annotation with no neuron attached is a row somebody has not finished, and
 * there is nothing to join it to.
 */
export function shapeRows(
  rows: ReadonlyArray<Record<string, unknown>>,
  config: SeaTableConfig,
  meta: SeaTableTable,
): TableValue {
  const kept = keptColumns(config, meta)
  const types = new Map(meta.columns.map((c) => [c.name, c.type]))
  const schema = tableSchema(
    column(ID_COLUMN_NAME, 'str'),
    ...kept.map((name) => column(annotationColumn(name), dtypeFor(types.get(name) ?? 'text'))),
  )

  const data: Record<string, ColumnData> = {}
  for (const col of schema.columns) data[col.name] = []

  const ids = data[ID_COLUMN_NAME]!
  // Column array and dtype resolved once. Per cell it was a Map lookup, a `dtypeFor` switch and a
  // string-keyed load — over 58,340 rows and 60 columns, to recompute what `schema.columns`
  // twelve lines above already decided.
  const targets = kept.map((name) => ({
    name,
    into: data[annotationColumn(name)]!,
    dtype: dtypeFor(types.get(name) ?? 'text'),
  }))
  const seen = new Set<string>()
  for (const row of rows) {
    const raw = row[config.idColumn]
    if (raw === null || raw === undefined || raw === '') continue
    const id = String(raw)
    // One row per neuron: a base edited by many people carries duplicates, and a repeated id
    // would put a neuron in the index twice.
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
    for (const { name, into, dtype } of targets) into.push(cellFor(row[name], dtype))
  }
  return makeTable(schema, data)
}

registerAnnotationProvider(new SeaTableProvider())

/** Test seam: drop discovered metadata between suites. In-flight reads are `resetIndexLoads`'. */
export function resetSeaTableState(): void {
  discovery.clear()
  listings.clear()
  listed.clear()
}
