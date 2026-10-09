/**
 * A Clio dataset as an annotation target — the male CNS, MANC and the rest of Janelia's stores.
 *
 * Probed against the live store (reads only) on 2026-10-03; its CORS is open (`*`, with
 * `Authorization` and `Content-Type`), so a browser reaches it directly:
 *
 * ```text
 * GET  {store}/v2/datasets                                → each dataset's bodyAnnotationSchema
 * GET  {store}/v2/json-annotations/{ds}/neurons/fields     → every field name (153 on CNS)
 * POST {store}/v2/json-annotations/{ds}/neurons/query      → {bodyid: [...]} → records (a read)
 * POST {store}/v2/json-annotations/{ds}/neurons            → [{bodyid, field: value}, ...] (a write)
 * ```
 *
 * The write URL is what clio-py *sends* — `neurons?app=clio-py`, its `?{head_tag}` being dropped
 * by its own query-string handling — with `app=coda`. Batches of 50 bodies, clio-py's habit.
 *
 * **A body id is a JSON number on the wire**, so it is never parsed as one here (invariant 8): a
 * reply has its `bodyid` values turned to strings before `JSON.parse`, and a request spells the id
 * from its text. Only an id that is plainly digits is sent at all — `isNeuronId`.
 *
 * Clio's listing does not type its fields: it says only that a field is edited with an `input`, and
 * sometimes lists `options`, which the Clio UI offers rather than enforces — so they are
 * suggestions here. The **types** come from the JSON schema the dataset's DVID server publishes,
 * where it does (`readTypes`); a field it does not cover is text. `bodyid` and a position are
 * read-only. The stamps Clio keeps itself (`*_user`, `*_time` — who last changed a field, and when)
 * are **not fields here at all**: two thirds of the list, nothing anybody edits, and the user's call
 * (2026-10-04) after a version that hid them behind a toggle.
 *
 * Clio writes are **not** exercised live as a suite: there is no test store (clio-py's is gone for
 * good), and the live one is production. `clio.test.ts` holds the request shapes against a stub;
 * one run against three fragments the user named, on 2026-10-04, is recorded in
 * `docs/annotations.md`.
 */

import { hashString } from '../../../core/hash'
import { idText, isNeuronId } from '../../../core/ids'
import type { CellValue } from '../../../core/values'
import { parseCaveJson } from '../../cave/json'
import { bodyExcerpt } from '../../errorBody'
import { fetchText, unreachable } from '../../fetchText'
import { memoPromise, untilAborted } from '../../memoPromise'
import { getClioToken, reportClioAuthFailure } from '../clioCredentials'
import type {
  AnnotationTarget,
  TargetChange,
  TargetField,
  TargetRead,
  TargetRecord,
  TargetWriteResult,
} from './types'
import type { RowUpdates } from './checkedWrite'
import { checkedWrite, readOf } from './checkedWrite'
import { cellOf } from './fieldValues'

/** The live store, which every dataset Clio serves is under. */
const CLIO_STORE = 'https://clio-store-vwzoicitea-uk.a.run.app'

export interface ClioTargetConfig {
  dataset: string
  /** The store; the live one unless a test names another. */
  store?: string
}

/** Body ids per query. 50 answered in 0.22 s (25 kB), so 500 is a few hundred kB. */
const IDS_PER_QUERY = 500
/** Bodies per write request: clio-py's `chunksize`. */
const BODIES_PER_WRITE = 50

class ClioError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClioError'
  }
}

interface SchemaEntry {
  editElement?: { type?: string; options?: unknown[] }
}

/** What a Clio target is a fact about, without building one: `targets/index.ts` keys by it. */
/** The store a config names, its trailing slashes off. */
const storeOf = (config: ClioTargetConfig) => (config.store ?? CLIO_STORE).replace(/\/+$/, '')

export function clioKey(config: ClioTargetConfig): string {
  return `clio|${storeOf(config)}|${config.dataset}`
}

export class ClioTarget implements AnnotationTarget {
  readonly key: string
  readonly label: string
  private readonly dataset: string
  private readonly store: string
  /** The field list, shared and carrying nobody's signal; see `SeaTableTarget.memo`. */
  private readonly schema = new Map<'fields', Promise<TargetField[]>>()

  constructor(config: ClioTargetConfig) {
    this.dataset = config.dataset
    this.store = storeOf(config)
    this.key = clioKey(config)
    this.label = `Clio · ${this.dataset}`
  }

  fields(signal?: AbortSignal): Promise<TargetField[]> {
    const shared = memoPromise(this.schema, 'fields', () => this.readFields(), {
      keep: 'resolved',
    })
    return untilAborted(shared, signal)
  }

  async read(
    ids: readonly string[],
    fields: readonly string[],
    signal?: AbortSignal,
  ): Promise<TargetRead> {
    // An id Clio cannot be asked about is missing from it as surely as one it does not hold.
    return readOf(ids, (await this.query(ids, fields, signal)).values())
  }

  blank(id: string, fields: readonly string[]): TargetRecord | undefined {
    return isNeuronId(id) ? blankRecord(id, fields) : undefined
  }

  async write(
    changes: readonly TargetChange[],
    signal?: AbortSignal,
  ): Promise<TargetWriteResult> {
    return checkedWrite(
      changes,
      await this.fields(signal),
      {
        batch: BODIES_PER_WRITE,
        reread: async (keys, names, s) => {
          // A body Clio holds nothing for is still a body it takes a write for: empty, not gone.
          const found = await this.query(keys, names, s)
          return new Map(
            keys.map((key) => [key, (found.get(key) ?? blankRecord(key, names)).values]),
          )
        },
        send: async (bodies, s) => {
          await clioCall(
            this.store,
            `/v2/json-annotations/${encodeURIComponent(this.dataset)}/neurons?app=coda`,
            { body: writeBody(bodies), write: true, signal: s },
          )
        },
      },
      signal,
    )
  }

  // -------------------------------------------------------------------------

  private async readFields(): Promise<TargetField[]> {
    const ds = encodeURIComponent(this.dataset)
    // The two Clio calls one after the other: a rejected token then fails once, and reaches the
    // Connections panel once. The schema read carries no Clio token, so it overlaps the second.
    const listing = await datasetListing(this.store, false)
    const entry = listing[this.dataset]
    if (!entry) {
      throw new ClioError(
        `Clio has no dataset "${this.dataset}". It has: ${Object.keys(listing).join(', ')}.`,
      )
    }
    const [names, types] = await Promise.all([
      clioCall(this.store, `/v2/json-annotations/${ds}/neurons/fields?app=coda`),
      entry.dvid ? readTypes(entry.dvid) : ({} as Record<string, FieldType>),
    ])
    const schema = entry.bodyAnnotationSchema?.collection ?? {}
    const all = JSON.parse(names) as string[]
    const named = new Set(all)
    // A stamp is a companion: `type_user` beside a listed `type`. A field merely ending in `_time`
    // with nothing beside it is a field of its own.
    const listed = all.filter((name) => {
      const stamp = STAMP.exec(name)
      return !stamp || !named.has(name.slice(0, stamp.index))
    })
    return listed.map((name): TargetField => {
      const suggestions = schema[name]?.editElement?.options?.filter(
        (o): o is string => typeof o === 'string',
      )
      const typed = types[name]
      const readOnly = readOnlyReason(name, typed)
      return {
        name,
        ...(typed && typed !== POSITION ? typed : { kind: 'text' as const }),
        ...(suggestions?.length ? { suggestions } : {}),
        ...(readOnly ? { readOnly } : {}),
      }
    })
  }

  /**
   * Records by body id for the named fields. Only ids that are plainly digits are asked about.
   * **Clio answers nothing for a body nobody has annotated yet**, so such a body comes back missing
   * here; a tab showing it anyway (`Unannotated`) asks `blank` for an empty record, and a write
   * takes it as empty rather than gone.
   */
  private async query(
    ids: readonly string[],
    fields: readonly string[],
    signal?: AbortSignal,
  ): Promise<Map<string, TargetRecord>> {
    const usable = ids.filter(isNeuronId)
    const found = new Map<string, TargetRecord>()
    const path = `/v2/json-annotations/${encodeURIComponent(this.dataset)}/neurons/query?app=coda`
    for (let at = 0; at < usable.length; at += IDS_PER_QUERY) {
      const chunk = usable.slice(at, at + IDS_PER_QUERY)
      // Spelled from the text, never `JSON.stringify` of numbers (invariant 8).
      const body = `{"bodyid":[${chunk.join(',')}]}`
      for (const row of parseRecords(await clioCall(this.store, path, { body, signal }))) {
        const key = idText(row.bodyid as CellValue | undefined)
        if (key === null) continue
        found.set(key, {
          key,
          id: key,
          values: Object.fromEntries(fields.map((name) => [name, cellOf(row[name])])),
        })
      }
    }
    return found
  }
}

/**
 * A body with every field empty — how clio-py and Clio's own UI treat one nobody has annotated. The
 * price of offering it: a body id the segmentation never had is editable too, and Clio takes the
 * write, as it does from clio-py.
 */
function blankRecord(id: string, fields: readonly string[]): TargetRecord {
  return { key: id, id, values: Object.fromEntries(fields.map((name) => [name, null])) }
}

/** How each JSON-schema type is edited, as `seaTable.ts`' `EDITABLE` maps SeaTable's. */
const KIND: Readonly<Record<string, Pick<TargetField, 'kind' | 'integer'>>> = {
  string: { kind: 'text' },
  integer: { kind: 'number', integer: true },
  number: { kind: 'number' },
  boolean: { kind: 'bool' },
  array: { kind: 'choices' },
}
/** Who last changed a field and when, which Clio keeps beside it — a stamp when the field is listed. */
const STAMP = /_(user|time)$/

/** A `oneOf`: a position (`[x, y, z]` or a point), which clio-py does not check either. */
const POSITION = 'position'

/** Why a Clio field is not edited here, or undefined where it is. */
function readOnlyReason(name: string, typed: FieldType | undefined): string | undefined {
  if (name === 'bodyid') return 'the id'
  if (typed === POSITION) return 'a position, not edited here'
  return undefined
}

type FieldType = Pick<TargetField, 'kind' | 'integer'> | typeof POSITION

/**
 * The dataset's field types, from the JSON schema its DVID server publishes — what clio-py
 * validates a write against before sending (`_validate_schema`). Clio's own listing says only
 * that a field is edited with an input, so without this every field is text.
 *
 * **Best effort**, and empty where it cannot be read: CNS's answers (12 fields typed, measured
 * 2026-10-03, CORS open to `coda.science`), the male CNS's server answers 403 and MANC's 404. A
 * field it does not cover stays text. Fetched without the Clio token, which is Clio's and not
 * DVID's.
 */
async function readTypes(dvid: string): Promise<Record<string, FieldType>> {
  try {
    const json = JSON.parse(
      await fetchText(
        `${dvid.replace(/\/+$/, '')}/api/node/:master/segmentation_annotations/json_schema`,
      ),
    ) as { properties?: Record<string, { type?: string | string[]; oneOf?: unknown }> }
    const types: Record<string, FieldType> = {}
    for (const [name, spec] of Object.entries(json.properties ?? {})) {
      const listed = [spec.type].flat().filter((t) => t !== 'null' && t !== undefined)
      if (spec.oneOf) types[name] = POSITION
      else if (listed.length === 1 && KIND[listed[0]!]) types[name] = KIND[listed[0]!]!
    }
    return types
  } catch {
    return {}
  }
}

/**
 * Every refusal goes through here — a 401/403 and a missing token alike — so `quiet` cannot be
 * honoured by one and forgotten by the other (`cave/client.ts`' `refuse`).
 */
function refuse(message: string, quiet: boolean | undefined): never {
  if (!quiet) reportClioAuthFailure(message)
  throw new ClioError(message)
}

/**
 * A GET, or a POST of `body`; the reply as text. `quiet` and `write` mean what they mean on
 * SeaTable's `request`: keep a refusal off the auth channel, and — for a write — say it as a
 * dataset this account may read and not annotate, which no new token fixes.
 */
async function clioCall(
  store: string,
  path: string,
  options: {
    body?: string
    quiet?: boolean
    write?: boolean
    signal?: AbortSignal | undefined
  } = {},
): Promise<string> {
  const { body, write, signal } = options
  const quiet = options.quiet || write
  const token = getClioToken()
  if (!token)
    return refuse('No Clio token. Add one in Connections ▸ Annotations ▸ Clio.', quiet)
  const url = `${store}${path}`
  let response: Response
  try {
    response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body }),
      ...(signal ? { signal } : {}),
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw unreachable(url)
  }
  const text = await response.text()
  if (response.status === 401 || response.status === 403) {
    refuse(
      write
        ? `Clio refused this (${response.status}): ${bodyExcerpt(text)}. The account may be ` +
            `allowed to read this dataset but not to annotate it.`
        : `Clio refused the token (${response.status}). It may have expired; get a new one ` +
            `from clio.janelia.org/settings.`,
      quiet,
    )
  }
  if (!response.ok) {
    throw new ClioError(`Clio answered ${response.status}: ${bodyExcerpt(text)}`)
  }
  return text
}

/**
 * The store's datasets, fresh, for the Connections panel's Test — through the same request every
 * read takes, so a token that tests well is one the card can use.
 */
export async function listClioDatasets(store = CLIO_STORE): Promise<string[]> {
  return Object.keys(JSON.parse(await clioCall(store, '/v2/datasets')) as object)
}

type Listing = Record<
  string,
  { dvid?: string; bodyAnnotationSchema?: { collection?: Record<string, SchemaEntry> } }
>

/**
 * The store's dataset listing, once per store and token: every tab's field read and the card's
 * Dataset list share it, and a new token is a new key. Kept once it resolves, never after a
 * failure, so a refusal is asked again. A loud asker arriving while a quiet one's request is in
 * flight inherits the silence, which heals itself — `CaveRequestOptions.quiet`'s rule.
 */
const listings = new Map<string, Promise<Listing>>()

/**
 * What a listing is a fact about — the store and the token — or `undefined` without a token, when
 * the card's list has nothing to ask. The card keys its fetch on this, so the two cannot disagree on
 * when a listing is a new one.
 */
export function clioListingKey(store = CLIO_STORE): string | undefined {
  const token = getClioToken()
  return token ? `${store}|${hashString(token)}` : undefined
}

function datasetListing(store: string, quiet: boolean): Promise<Listing> {
  return memoPromise(
    listings,
    // Without a token the request is refused before it is sent; the key only has to be one.
    clioListingKey(store) ?? store,
    async () => JSON.parse(await clioCall(store, '/v2/datasets', { quiet })) as Listing,
    { keep: 'resolved' },
  )
}

/**
 * The datasets the store lists, for the Annotate card's Dataset list — quietly, being a peek, and
 * shared with the field reads. `listClioDatasets` is its deliberate twin: fresh and loud, for the
 * Connections panel's Test.
 */
export async function clioDatasets(store = CLIO_STORE): Promise<string[]> {
  return Object.keys(await datasetListing(store, true))
}

/** Test seam: forget every listing. */
export function resetClioListings(): void {
  listings.clear()
}

/**
 * A reply's records, any integer too wide for a double quoted before parsing — `parseCaveJson`,
 * whose scan is string-aware: a free-text field reading `"bodyid":123` is left alone, where a
 * one-line regex would splice quotes into it and stop the whole reply parsing.
 */
export function parseRecords(text: string): Array<Record<string, unknown>> {
  const parsed = parseCaveJson<unknown>(text)
  return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : []
}

/**
 * The write body: each body's id spelled from its text, every other value as JSON. The id check
 * is defence rather than a path the target reaches — `query` asks only about digits, so a key
 * that is not is reported gone before it gets here.
 */
export function writeBody(bodies: RowUpdates): string {
  const items = [...bodies].map(([id, fields]) => {
    if (!isNeuronId(id)) throw new ClioError(`Not a body id: ${id}`)
    const rest = Object.entries(fields).map(
      ([k, v]) => `,${JSON.stringify(k)}:${JSON.stringify(v)}`,
    )
    return `{"bodyid":${id}${rest.join('')}}`
  })
  return `[${items.join(',')}]`
}
