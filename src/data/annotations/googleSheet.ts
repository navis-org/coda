/**
 * A Google Sheet as an annotation source, read through the plain export URL.
 *
 * The third provider, and the first with **no credential at all**. A sheet shared as "anyone
 * with the link can view" answers an ordinary cross-origin `GET`, so this is a fetch and a
 * parse and nothing else — no token to store, no auth-failure channel, and nothing for the
 * Connections panel to offer. That is the whole reason it earns a node: a lab's cell typing
 * very often lives in a Google Sheet rather than in a SeaTable base or a CAVE table, and until
 * now the only route was `Table from URL` pointed at a hand-built export address.
 *
 * Everything below was probed live against a public sheet rather than read off documentation.
 *
 * **Both hops of the redirect carry CORS, which is what makes this work in the browser at
 * all.** `docs.google.com/.../export` answers `307` with `access-control-allow-origin` echoing
 * the requesting origin, and the `doc-XX-XX-sheets.googleusercontent.com` target it names
 * answers `200` with `access-control-allow-origin: *`. A browser CORS-checks *every* hop of a
 * chain, so one link missing a usable header would block the fetch before it reached the
 * data — which is exactly the trap `core.tableFromUrl`'s guide records about GitHub's
 * `/raw/refs/heads/` redirect, whose first hop sends an **empty** ACAO. Here both are open, so
 * there is no relay and no `routeMemory`: the one route that exists is known to work.
 *
 * **The tab is chosen by `gid`, and that is not a preference.** Measured, on the same sheet:
 *
 * ```text
 * export?format=csv&gid=999999   → 400        loud
 * export?format=csv&sheet=Nope   → 200 …      the FIRST tab, silently
 * gviz/tq?tqx=out:json&sheet=Nope → status ok  the FIRST tab, silently
 * ```
 *
 * A tab name typed wrong does not fail, it hands back different data under a green node — the
 * quiet wrong answer this codebase keeps being caught by. A `gid` typed wrong is a 400. Nobody
 * has to type one either: it is in the URL people copy out of the address bar
 * (`…/edit#gid=123456`), so `parseSheetLocation` lifts it and the field is only ever an
 * override.
 *
 * **`gviz/tq?tqx=out:csv` is not used, for a second reason.** It pads every row out to the
 * sheet's full column range — a six-column table came back as twenty-two, sixteen of them
 * `""` — so a Coda table read from it carries sixteen blank columns in every picker
 * downstream. `export?format=csv` returns the used range and nothing else.
 *
 * **A missing document is a `404` and a Restricted one is a blocked redirect**, which are two
 * different failures and are told apart rather than conflated — see `explainFailure`, which also
 * records why `curl` answers this endpoint differently from a browser and how that got the first
 * version of the message exactly backwards.
 */

import { ID_COLUMN_NAME } from '../../core/ids'
import type { TableSchema } from '../../core/types'
import { column, columnNames, findColumn, tableSchema } from '../../core/types'
import type { ColumnData, TableValue } from '../../core/values'
import { makeTable } from '../../core/values'
import { readDelimitedResponse } from '../csv'
import {
  cachedAnnotationTable,
  registerAnnotationProvider,
  reportAnnotationsLearned,
} from './registry'
import type { AnnotationFetchOptions, AnnotationProvider, AnnotationRef } from './types'
import { annotationColumns, namedColumns, refKey } from './types'

export const GOOGLE_SHEET_PROVIDER = 'googleSheet'

export class GoogleSheetError extends Error {
  readonly status: number
  constructor(message: string, status = 0) {
    super(message)
    this.name = 'GoogleSheetError'
    this.status = status
  }
}

/**
 * What a Google Sheet ref names.
 *
 * `documentId` and `gid` are the **parsed** location rather than whatever somebody typed, and
 * that is `seaTable.ts`'s rule about resolving before the cache key is taken: a bare id, an
 * edit URL and an export URL all name one tab, and keying on the spelling would download it
 * once per spelling. `parseSheetLocation` is the single grammar and the node calls it.
 */
export interface GoogleSheetConfig extends Record<string, string> {
  /** The 40-odd character id out of `/spreadsheets/d/<id>/`. */
  documentId: string
  /** Numeric tab id. Empty is the first tab, which is what `export` returns with no `gid`. */
  gid: string
  /** Column holding the neuron id. Renamed to `neuronId` on the way out. */
  idColumn: string
  /** Comma-separated columns to keep. Empty keeps everything but the id. */
  columns: string
}

// ---------------------------------------------------------------------------
// The URL grammar
// ---------------------------------------------------------------------------

/**
 * A document id is `[A-Za-z0-9_-]`, and long. The length floor is load-bearing rather than
 * cosmetic: `peekColumns` starts a fetch for any ref it can build, so without one every prefix
 * of an id somebody is typing character by character would be a ref, and each would fire a
 * request that 404s.
 */
const ID_PATTERN = /^[A-Za-z0-9_-]{20,}$/

export interface SheetLocation {
  documentId?: string
  gid?: string
  /**
   * Why the text could not be read, if it could not.
   *
   * A returned message rather than a throw, the shape `parseIdList` uses and for its reason:
   * `validate` runs at edit time and returns strings while `evaluate` raises a sentence, and
   * the badge and the error have to agree word for word.
   */
  error?: string
}

/**
 * The document and tab a pasted string names.
 *
 * Accepts the address bar (`…/spreadsheets/d/<id>/edit?gid=1#gid=1`), a ready-made export URL,
 * and a bare id. The `gid` is taken from the fragment or the query, which is what lets somebody
 * paste one link and have the right tab selected with nothing else typed.
 *
 * **A published-to-web link is refused rather than mangled.** `File ▸ Share ▸ Publish to web`
 * produces `/spreadsheets/d/e/2PACX-…/pub`, a *different* id space that only `…/pub?output=csv`
 * serves — `/export` does not know those ids at all. The `/d/` in it means a naive match reads
 * the id as the literal `e`, so this has to be caught explicitly or it becomes a 404 blaming
 * the sheet. The message names the link to use instead, which is the one somebody already has.
 */
export function parseSheetLocation(input: string): SheetLocation {
  const text = input.trim()
  if (!text) return {}

  if (!/^https?:\/\//i.test(text)) {
    if (ID_PATTERN.test(text)) return { documentId: text }
    return {
      error:
        `"${text}" is not a Google Sheet link or id. Paste the address bar of the sheet — ` +
        `https://docs.google.com/spreadsheets/d/…/edit — or just the id out of it.`,
    }
  }

  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { error: `"${text}" is not a URL` }
  }
  if (!/(^|\.)google\.com$/i.test(url.hostname)) {
    return { error: `${url.hostname} is not docs.google.com — this node reads Google Sheets` }
  }
  if (/\/spreadsheets\/d\/e\//.test(url.pathname)) {
    return {
      error:
        'That is a "publish to web" link, which uses a different id that the export URL cannot ' +
        'open. Use the ordinary Share link instead — Share ▸ Anyone with the link ▸ Viewer, ' +
        'then Copy link.',
    }
  }
  const match = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(url.pathname)
  if (!match) {
    return { error: `${text} has no /spreadsheets/d/<id>/ in it` }
  }
  const documentId = match[1]!
  if (!ID_PATTERN.test(documentId)) {
    return { error: `"${documentId}" is too short to be a Google Sheet id` }
  }
  // The fragment first: a link copied out of the address bar carries the tab there, and the new
  // Sheets UI writes it into the query as well. Either is the same number.
  const gid = /[#&?]gid=(\d+)/.exec(url.hash)?.[1] ?? url.searchParams.get('gid') ?? undefined
  return { documentId, ...(gid ? { gid } : {}) }
}

/**
 * The config a node's params name — the whole resolution, in one place.
 *
 * `parseSheetLocation` and `sheetExportUrl` were shared across the three consumers for a stated
 * reason: *a second copy of the grammar is how the notebook comes to read a different tab from
 * the card it was exported from*. The layer immediately above them decides that grammar's
 * **arguments** — which gid wins, what the id column falls back to — and was written out three
 * times anyway, which leaves the failure the sharing was for still reachable.
 *
 * The gid precedence is the part that matters and the part that is not obvious: the field is an
 * **override**, so an empty one takes whatever the pasted link named, and an empty link means
 * the first tab. That is what lets the ordinary gesture — copy the address bar, paste — select
 * the right tab with nothing else typed.
 *
 * Returns the parse error too, so `validate` gets the sentence and the config from one call
 * rather than parsing the same string twice on every keystroke.
 */
export function sheetConfigFrom(params: Record<string, unknown>): {
  config?: GoogleSheetConfig
  error?: string
} {
  const { documentId, gid, error } = parseSheetLocation(String(params.sheet ?? ''))
  if (!documentId) return error ? { error } : {}
  return {
    config: {
      documentId,
      gid: String(params.gid ?? '').trim() || gid || '',
      idColumn: String(params.idColumn ?? 'root_id').trim() || 'root_id',
      columns: String(params.columns ?? '').trim(),
    },
  }
}

/**
 * The CSV export address for one tab.
 *
 * `format=csv` rather than `tsv`: `parseDelimited` detects the delimiter either way, and a
 * comma is what a reader recognises when the URL turns up in an exported notebook.
 *
 * Exported, because three consumers must build the same string and a second copy is how one of
 * them comes to fetch a different tab: this provider, and the Python and R emitters — which is
 * the `neuprintProperty` precedent for an `src/export → src/data` import.
 */
export function sheetExportUrl(documentId: string, gid: string): string {
  const base = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(documentId)}/export?format=csv`
  return gid ? `${base}&gid=${encodeURIComponent(gid)}` : base
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * The tab, parsed, before any column is renamed or dropped.
 *
 * **This is what gets cached, and the shaping happens after it** — the one place this provider
 * departs from its two siblings, which cache the finished annotation table. It is worth the
 * divergence because the two halves have completely different costs here: the download is the
 * whole expense and the shaping is a projection, and unlike a SeaTable or CAVE ref there is
 * nothing about `columns`/`idColumn` that changes what the *server* sends. Cached per ref, an
 * edit to the ID column would re-download a spreadsheet to rename a column that was already in
 * hand.
 *
 * `SHAPE_FORMAT` still guards what is stored, and still means what it says: the parse *is* the
 * shaping at this layer — delimiter, header, and the dtype rules that keep an eighteen-digit id
 * as text — so a change to `csv.ts` is exactly the change that must invalidate these entries.
 */
function tabRef(config: GoogleSheetConfig): AnnotationRef {
  return {
    provider: GOOGLE_SHEET_PROVIDER,
    config: { documentId: config.documentId, gid: config.gid },
  }
}

async function readTab(
  config: GoogleSheetConfig,
  options: AnnotationFetchOptions,
): Promise<TableValue> {
  const url = sheetExportUrl(config.documentId, config.gid)
  options.onProgress?.(0.05, 'fetching')

  let response: Response
  try {
    response = await fetch(url, {
      redirect: 'follow',
      ...(options.signal ? { signal: options.signal } : {}),
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw await explainFailure(url, options.signal)
  }

  if (!response.ok) throw refusal(response.status, config, url)

  const parsed = await readDelimitedResponse(
    response,
    'That tab',
    (message) => new GoogleSheetError(message),
    options.onProgress,
  )
  return parsed.table
}

/**
 * What Coda tells somebody whose sheet is not shared.
 *
 * No `reportAuthFailure`, deliberately — that channel opens the Connections panel so somebody
 * can fix a credential, and this provider has none. The fix is in Google's own share dialog, so
 * the message names the setting rather than sending anybody to a tab with nothing on it for
 * them.
 */
function notShared(detail: string): GoogleSheetError {
  return new GoogleSheetError(
    `That sheet is not readable without signing in. Open it in Google Sheets and set ` +
      `Share ▸ General access to "Anyone with the link" (Viewer). Coda sends no credentials, so ` +
      `a Restricted sheet cannot be read here whoever is signed in to the browser. (${detail})`,
    401,
  )
}

/** What a status means here. Google's own body is an HTML page, so none of it is quoted. */
function refusal(status: number, config: GoogleSheetConfig, url: string): GoogleSheetError {
  if (status === 400 && config.gid) {
    return new GoogleSheetError(
      `That sheet has no tab with gid ${config.gid}. The gid is the number after "#gid=" in ` +
        `the address bar when that tab is open; clear the field for the first tab.`,
      status,
    )
  }
  if (status === 401 || status === 403) return notShared(`Google answered ${status}`)
  if (status === 404) {
    /*
     * Measured in a browser: a document that does not exist answers **404**, where a Restricted
     * one answers a 302 to the sign-in page — so unlike every earlier guess at this, the two are
     * genuinely distinguishable and the message can name one rather than offering both. The
     * sharing case is still mentioned second, because Google is entitled to hide a document's
     * existence behind a 404 and sometimes does.
     */
    return new GoogleSheetError(
      `No sheet with that id — Google answered 404. Check the link is the one from the ` +
        `address bar, and that the sheet has not been deleted. (A sheet shared with named ` +
        `people only can also answer 404 rather than admitting it exists.)`,
      status,
    )
  }
  return new GoogleSheetError(`${url} returned ${status}`, status)
}

/**
 * Why a `fetch` threw, which the browser will not say.
 *
 * A cross-origin failure arrives as an opaque `TypeError` with no detail, and the *overwhelmingly*
 * common cause here is a sheet somebody forgot to share — so the message this used to produce,
 * "the export URL is readable cross-origin, so this is a network failure", was confidently wrong
 * in exactly the case people hit first. It sent them to check their wifi.
 *
 * **The redirect is what is blocked, not the request.** Measured in a real browser against a
 * Restricted sheet:
 *
 * ```text
 * GET docs.google.com/…/export   → 302  access-control-allow-origin: http://localhost:5174
 *   → accounts.google.com/ServiceLogin  → 401  no access-control-* at all
 *   → net::ERR_FAILED, corsError: MissingAllowOriginHeader
 * ```
 *
 * A browser CORS-checks every hop, so the sign-in page Google sends a signed-out visitor to is
 * what kills the fetch. Nothing about the first hop is wrong.
 *
 * **`curl` gets a different answer from this endpoint and led the first version of this astray.**
 * The same request from curl comes back a bare `401` with CORS headers on it, no redirect — so
 * the code was written against a response a browser never sees. Probing with curl alone is not
 * enough here; the browser's own `Network.loadingFailed` is what settled it.
 *
 * So the two causes are told apart with one extra request, on the failure path only.
 * `redirect: 'manual'` does not follow — and therefore does not CORS-check — the second hop, so
 * a sheet Google wants a login for comes back as an **opaque redirect** rather than throwing.
 * That is decisive here precisely because the ordinary path already threw: a *public* sheet also
 * redirects, but it redirects somewhere readable and never reaches this function.
 *
 * A probe that throws too means `docs.google.com` itself could not be reached. There is no third
 * possibility to confuse it with, because this provider only ever talks to that one host and that
 * host demonstrably sends CORS headers.
 */
async function explainFailure(url: string, signal?: AbortSignal): Promise<GoogleSheetError> {
  try {
    const probe = await fetch(url, {
      redirect: 'manual',
      ...(signal ? { signal } : {}),
    })
    if (probe.type === 'opaqueredirect') {
      return notShared('Google redirected the request to a sign-in page')
    }
  } catch (error) {
    // A cancelled run must stay cancelled rather than being reported as an unreachable host.
    if (error instanceof DOMException && error.name === 'AbortError') throw error
  }
  return new GoogleSheetError(
    `Could not reach docs.google.com. The sheet may be fine — check the connection, and that ` +
      `nothing on this network blocks Google: ${url}`,
  )
}

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

/** Which columns a ref keeps: the named ones that exist, or everything but the id. */
function keptColumns(schema: TableSchema, config: GoogleSheetConfig): string[] {
  const present = columnNames(schema).filter((name) => name !== config.idColumn)
  const named = namedColumns(config.columns, config.idColumn)
  // Named-but-absent is **dropped rather than emitted as nulls**, which is where this parts
  // company with `wideRows` and `shapeRows` — those cannot see the server's column list without
  // a round trip, and this one has already parsed it. A column of nulls is the quiet wrong
  // answer; `validate` names the missing one out loud instead.
  if (named.length > 0) return named.filter((name) => present.includes(name))
  return present
}

/**
 * The schema `shapeSheet` will produce, from the parsed tab's schema alone.
 *
 * Split out so **`peekColumns` can answer without walking a single row.** It used to derive the
 * shaped schema by running the whole pipeline and reading `.schema` off the result, throwing the
 * table away — and because the peek's guard was keyed on the shaping params too, every keystroke
 * in `ID column` or `Columns` paid a full O(rows × columns) copy on the main thread. Measured at
 * FlyWire scale that is about 70 ms and a multi-MB allocation per keystroke, discarded.
 *
 * The two halves cannot disagree, because `shapeSheet` calls this rather than restating it —
 * invariant 3 by construction rather than by assertion.
 */
export function sheetSchema(parsed: TableSchema, config: GoogleSheetConfig): TableSchema {
  if (!findColumn(parsed, config.idColumn)) {
    throw new GoogleSheetError(
      `That tab has no column called "${config.idColumn}". It has: ` +
        `${columnNames(parsed).join(', ')}`,
    )
  }
  const kept = keptColumns(parsed, config)
  // Coda's names, deduplicated: a sheet carrying both `cell_type` and `type` maps two of its
  // columns onto one, and two columns sharing one array is a ragged table. See
  // `annotationColumns`.
  const codaNames = annotationColumns(kept)
  return tableSchema(
    column(ID_COLUMN_NAME, 'str'),
    ...kept.map((name, i) => column(codaNames[i]!, findColumn(parsed, name)!.dtype)),
  )
}

/**
 * A parsed tab as a Coda annotation table: `neuronId` first, as text, then the kept columns.
 *
 * The id is `String`-ed **and** the column declared `str`, which is invariant 8 at this seam.
 * `inferDType` already keeps an eighteen-digit id as text — a value that would not survive a
 * round trip through a double refuses the numeric reading — so on FlyWire root ids this is a
 * no-op. It is not a no-op on neuPrint's nine-digit ids, which parse as `i64`: those still have
 * to leave here as text, because every consumer of an annotation table keys on `neuronId` as a
 * string and one provider handing back numbers would join to nothing.
 *
 * **A row with no id is dropped and a repeated id is kept.** An annotation with no neuron
 * attached has nothing to join to, and a base with two rows for one neuron is a fact about
 * somebody's spreadsheet that they are the only person who can act on — `dedupedIds` and
 * `joinAnnotations` collapse it downstream, where a Sort can decide which row wins.
 *
 * A blank cell counts as no id, which is `shapeRows`' rule in `seaTable.ts` and is the one that
 * matters for a spreadsheet: an empty cell is how a sheet spells an unfilled row. Note the three
 * shapers do **not** agree on this — `wideRows` in `caveTable.ts` drops only null and undefined,
 * because a CAVE root id column has no empty-string state. Worth knowing before assuming the
 * rule is shared; `annotationColumns` is the part that genuinely is.
 */
export function shapeSheet(parsed: TableValue, config: GoogleSheetConfig): TableValue {
  const schema = sheetSchema(parsed.schema, config)
  const kept = keptColumns(parsed.schema, config)

  const source = parsed.data[config.idColumn]!
  const data: Record<string, ColumnData> = {}
  for (const col of schema.columns) data[col.name] = []
  const ids = data[ID_COLUMN_NAME]!
  // Paired through the schema rather than through a second `annotationColumns` call, so the
  // column a cell is written into is by construction the one the schema declared for it.
  const targets = kept.map((name, i) => ({
    from: parsed.data[name]!,
    into: data[schema.columns[i + 1]!.name]!,
  }))
  for (let row = 0; row < parsed.length; row++) {
    const raw = source[row]
    if (raw === null || raw === undefined || raw === '') continue
    ids.push(String(raw))
    for (const { from, into } of targets) into.push(from[row] ?? null)
  }
  return makeTable(schema, data)
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

/**
 * The **parsed tab's** schema, keyed by tab.
 *
 * `has()` means asked, the value means landed — one Map rather than a flag beside a field, the
 * twin of the one in `seaTable.ts`.
 *
 * Two things about the key, and both were wrong first. It is the *tab* rather than the whole
 * ref, so it matches the unit `tabRef` caches: keyed on the shaping params as well, a sheet that
 * could not be read was re-fetched once per keystroke in `Columns` — `loadCachedTable` does not
 * retain failures — which is the opposite of the once-per-ref guard this exists to be. And it is
 * `refKey` rather than a hand-written field list, which cannot fall behind `GoogleSheetConfig`
 * gaining a field. `seaTable.ts`'s `baseKey` is hand-written because it deliberately keys on a
 * *subset* and says why; there is no such reason here.
 *
 * What is stored is the schema `parseDelimited` produced, not the shaped one — `sheetSchema`
 * derives that per config, synchronously and without touching a row.
 */
const discovery = new Map<string, TableSchema | undefined>()

class GoogleSheetProvider implements AnnotationProvider {
  readonly id = GOOGLE_SHEET_PROVIDER
  readonly label = 'Google Sheet'

  /**
   * The columns this ref would produce, once something has read the tab.
   *
   * There is no metadata endpoint to ask — a sheet publishes its shape only by handing over its
   * contents — so **discovery here is the download**, which is the one thing that would make
   * this expensive if it were paid twice. It is not: the read goes through
   * `cachedAnnotationTable`, so the peek fills IndexedDB and the first Run finds it there, or
   * shares the in-flight promise if it lands first. The bytes move earlier rather than being
   * spent again.
   *
   * Once per **tab** per instance and never retried on failure, which is invariant 2's corollary
   * — inference runs on every graph mutation and a retry from here is a request per keystroke.
   * Editing `ID column` or `Columns` re-derives the schema and fetches nothing, because neither
   * changes what the server sends.
   *
   * A tab whose id column is missing throws from `sheetSchema` rather than answering; caught
   * here, so a peek stays a peek. `validate` says nothing in that state and the run refuses with
   * the message, naming the columns the tab does have.
   */
  peekColumns(ref: AnnotationRef): TableSchema | undefined {
    const config = ref.config as GoogleSheetConfig
    if (!config.documentId || !config.idColumn) return undefined
    const parsed = this.tabSchemaFor(config)
    if (!parsed) return undefined
    try {
      return sheetSchema(parsed, config)
    } catch {
      return undefined
    }
  }

  /** The parsed tab's schema, asked for once per tab per instance. */
  private tabSchemaFor(config: GoogleSheetConfig): TableSchema | undefined {
    const key = refKey(tabRef(config))
    if (discovery.has(key)) return discovery.get(key)
    discovery.set(key, undefined)
    // Swallowed: a peek has no caller to report to. A real refusal reaches somebody on the
    // first Run, with the message this would have thrown.
    void cachedAnnotationTable(tabRef(config), {}, () => readTab(config, {}))
      .then((table) => {
        discovery.set(key, table.schema)
        reportAnnotationsLearned()
      })
      .catch(() => undefined)
    return undefined
  }

  async fetch(ref: AnnotationRef, options: AnnotationFetchOptions): Promise<TableValue> {
    const config = ref.config as GoogleSheetConfig
    if (!config.documentId) throw new GoogleSheetError('No Google Sheet named')
    // Cached on the *tab*, shaped after — see `tabRef`.
    const parsed = await cachedAnnotationTable(tabRef(config), options, () =>
      readTab(config, options),
    )
    const table = shapeSheet(parsed, config)
    options.onProgress?.(1, `${table.length} rows`)
    return table
  }
}

registerAnnotationProvider(new GoogleSheetProvider())

/** Test seam: drop discovered schemas between suites. In-flight reads are `resetIndexLoads`'. */
export function resetGoogleSheetState(): void {
  discovery.clear()
}
