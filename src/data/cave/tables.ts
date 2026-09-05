/**
 * What a datastack holds, and what one of its tables is — the discovery half of CAVE.
 *
 * A CAVE datastack does not describe itself (`spec.ts` is the long form of that), so the first
 * question anybody has is *what is in here*, and until now Coda's answer was a text field with
 * `nuclei_v1` as its placeholder. These are the two reads that answer it, memoised the way
 * `datastack.ts` memoises its records and for the same reasons.
 *
 * ## Two kinds of object, and only one of them describes itself well
 *
 * `listTables` and `listViews` are separate endpoints answering separate things, and the
 * asymmetry between them shapes everything here. The tables endpoint answers **bare names**, so a
 * description costs one request per table. The views endpoint answers a **map**, so a view's
 * description arrives with the listing and costs nothing extra.
 *
 * ## A view has no metadata endpoint, no count, and cannot be sampled cheaply
 *
 * All three probed against `flywire_fafb_public` v783 rather than assumed:
 *
 * ```text
 * /table/valid_connection_v2/metadata   404  "No table named 'valid_connection_v2' found"
 * /table/valid_connection_v2/count      500  wrapping a 404 — a missing table as a server error
 * /views/valid_connection_v2/count      404  there is no such route
 * ```
 *
 * And the one that matters most: **`limit` does not push down into an aggregating view.** A
 * one-row query against the plain `proofread_neurons_view` came back in **0.77 s**; the same
 * query against `nt_summary_view` and `valid_connection_v2` had not answered after **45 s**.
 * Those two are `GROUP BY` roll-ups, so the server builds the whole result and then takes one row
 * off it — which is the same fact `docs/backends.md` records from the other side, that CAVE's
 * query API has no `GROUP BY` for *us* because the aggregation is baked into the view.
 *
 * That is why the facts and the column sample are **two memos rather than one record**. The card
 * peeks the facts, which are metadata and counts and never a query — so an edit-time look at a
 * view cannot start a request that runs for minutes at a shared production server. Only
 * `evaluate` samples columns, where there is a `ctx.signal` to cancel with and a `ctx.warn` to
 * say what is about to be waited on.
 *
 * ## Two row counts, and both are true
 *
 * `api.ts` has the measured table. The short version: the materialization engine counts the
 * frozen snapshot and the annotation service counts the table as it stands, and they disagree by
 * up to a third. Showing one without saying which it is turned into a debugging round trip once
 * already. Neither predicts truncation, which is a *third* count — `countTable`'s — and is not on
 * this card because it is a fact about one query rather than about the table.
 */

import { reportSourceLearned } from '../source'
import type { TableMetadata, ViewInfo } from './api'
import {
  annotationCount,
  listTables,
  listViews,
  materializedCount,
  optionalCount,
  queryTable,
  queryView,
  tableMetadata,
} from './api'
import type { CaveRequestOptions, CaveRow } from './client'
import type { DType } from '../../core/types'
import { caveDType } from './json'
import { getServer } from './credentials'
import { caveServerFor, datastackRecord, resetDatastackRecords } from './datastack'
import { resetFlatSources } from './flat'
import { resetSkeletonServices } from './skeletonService'

/**
 * Which of CAVE's two kinds of queryable object this is.
 *
 * Carried everywhere rather than derived where needed, because every difference between them is
 * a *route* difference — which metadata endpoint answers, whether a count exists, which query
 * segment to post to — and re-deciding it per call site is how one of those comes to disagree.
 */
export type CaveObjectKind = 'table' | 'view'

/** One entry of a datastack's listing. Deliberately just the two things a listing knows. */
export interface CaveTableEntry {
  name: string
  kind: CaveObjectKind
}

/**
 * What one table or view says about itself, flattened across the two shapes that carry it.
 *
 * A display record rather than a wire shape — `TableMetadata` and `ViewInfo` in `api.ts` are the
 * wire shapes, and they have almost nothing in common beyond a description. Flattened here so the
 * card renders one thing for both kinds; a card that branched on `kind` for every row would state
 * the table/view difference eight times over, where it is really only about which fields are
 * *absent*.
 */
export interface CaveTableFacts {
  name: string
  kind: CaveObjectKind
  description?: string
  /** A warning the publisher attached to the table. Rare, which is exactly why it is surfaced. */
  notice?: string
  /** The registered `emannotationschemas` type. Views have none. */
  schemaType?: string
  /** The table a reference table annotates — `target_id` here joins to that table's `id`. */
  referenceTable?: string
  created?: string
  lastModified?: string
  readPermission?: string
  writePermission?: string
  /** Nanometres per unit of this table's stored positions, where it is not already 1:1. */
  voxelResolution?: readonly [number, number, number]
  /** The annotation service's live count. Absent for a view, and where the service declined. */
  rows?: number
  /** This materialization's count. Absent for a view. See `materializedCount`. */
  materializedRows?: number
}

/** One column of a table, as a single sampled row describes it. */
export interface CaveColumnSample {
  name: string
  /**
   * `undefined` where the sample says nothing — a column whose one row is null.
   *
   * Not defaulted to `str`, which is the tempting answer and the wrong one: `superceded_id` on
   * `nuclei_v1` is null in the first row and is an integer column. A blank cell is an admission;
   * `str` would be a claim.
   */
  dtype?: DType
  /** The sampled value, verbatim. Never formatted — see the note on `sampleColumns`. */
  example: string
}

// ---------------------------------------------------------------------------
// The memos
// ---------------------------------------------------------------------------

/**
 * Everything below is keyed by the **global server** as well as by the datastack.
 *
 * `datastack.ts` solves the same problem with a clock — one `filledFrom` that clears four maps
 * when `getServer()` moves. A key is the cheaper answer here: a stale entry is simply never
 * looked up again, so there is nothing to remember to clear and no second map that can be cleared
 * without its partner. The leak is bounded by servers × datastacks and each entry is a few
 * hundred bytes.
 */
function keyFor(datastack: string, version: number): string {
  return `${getServer()}|${datastack}:${version}`
}

/**
 * The two listing endpoints, memoised **separately** and composed on read.
 *
 * The obvious shape is one memo per *answer* — a `tables+views` entry and a `tables` entry, keyed
 * on the node's Include views toggle. That is what this was, and it double-fetched `/tables`: the
 * card and `validate` always want the full listing while a node with the box unticked wants half
 * of it, so the same six names were downloaded under two keys — and flipping the checkbox, which
 * is a checkbox and will be flipped, re-fetched **both** endpoints.
 *
 * Keyed per endpoint, `includeViews` stops being a cache dimension and becomes what it actually
 * is: which of two answers already in hand to concatenate.
 *
 * The `views` map is kept whole rather than reduced to its keys, because the listing is also the
 * *only* place a view's description exists — a view has no metadata endpoint (`/table/{v}/metadata`
 * 404s). `loadFacts` used to re-request the entire map to recover one entry it had already
 * downloaded and thrown away.
 */
const tableNames = new Map<string, Promise<string[]>>()
const viewInfos = new Map<string, Promise<Record<string, ViewInfo>>>()
const listed = new Map<string, CaveTableEntry[]>()
const listingAsked = new Set<string>()

const factsLoading = new Map<string, Promise<CaveTableFacts>>()
const factsKnown = new Map<string, CaveTableFacts>()
const factsAsked = new Set<string>()

const columnsLoading = new Map<string, Promise<CaveColumnSample[]>>()
const referencesLoading = new Map<string, Promise<string | undefined>>()

/**
 * Drop everything learned. **A test seam, and only that today.**
 *
 * It is *not* wired into a recovery path, and saying so matters: `datastack.ts` clears its four
 * maps automatically when `getServer()` moves, and this module reaches the same end by folding the
 * server into every key — but neither notices a **token** being pasted, so a listing read
 * anonymously outlives the credential that would have widened it. Closing that properly means a
 * generation counter in `credentials.ts` and one `resetCaveState()` fanning out to every CAVE
 * memo, which is a change to the shared teardown rather than to this module.
 */
export function resetCaveTables(): void {
  tableNames.clear()
  viewInfos.clear()
  listed.clear()
  listingAsked.clear()
  factsLoading.clear()
  factsKnown.clear()
  factsAsked.clear()
  columnsLoading.clear()
  referencesLoading.clear()
}

/**
 * Every CAVE memo, dropped together.
 *
 * The fan-out `resetCaveTables` names above, as far as a test teardown needs it. Four suites had
 * hand-copied the same two calls into their own `beforeEach`, so every new memo meant editing
 * four blocks and the file that missed one got cross-test bleed reading as a routing bug.
 */
export function resetCaveState(): void {
  resetCaveTables()
  resetDatastackRecords()
  resetFlatSources()
  resetSkeletonServices()
}

/**
 * Code-unit order, not `localeCompare`.
 *
 * A module constant rather than a closure per call, and deliberately **not** locale-aware: this
 * sort exists so that two Runs of one node produce the same table (invariant 4), and a collator
 * makes that answer depend on the machine. Table names are ASCII identifiers, where the two
 * orders agree anyway — so the locale can only ever be a source of disagreement here, never of
 * correctness.
 */
const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function namesFor(
  datastack: string,
  version: number,
  options: CaveRequestOptions,
): Promise<string[]> {
  const key = keyFor(datastack, version)
  let pending = tableNames.get(key)
  if (!pending) {
    pending = caveServerFor(datastack, options)
      .then((server) => listTables(server, datastack, version, options))
      .catch((error: unknown) => {
        tableNames.delete(key)
        throw error
      })
    tableNames.set(key, pending)
  }
  return pending
}

/**
 * Every view in a materialization, whole — names *and* descriptions, in one request.
 *
 * Exported because `loadFacts` reads it for a single view's description, which is the asymmetry
 * `listViews` gives us for free and `listTables` does not: a table costs a metadata request
 * apiece, a view costs nothing once the listing is in hand.
 */
function viewsFor(
  datastack: string,
  version: number,
  options: CaveRequestOptions,
): Promise<Record<string, ViewInfo>> {
  const key = keyFor(datastack, version)
  let pending = viewInfos.get(key)
  if (!pending) {
    pending = caveServerFor(datastack, options)
      .then((server) => listViews(server, datastack, version, options))
      .catch((error: unknown) => {
        viewInfos.delete(key)
        throw error
      })
    viewInfos.set(key, pending)
  }
  return pending
}

// ---------------------------------------------------------------------------
// The listing
// ---------------------------------------------------------------------------

/**
 * Every table and view in a materialization, tables first and each half sorted by name.
 *
 * **Sorted rather than passed through**, which is not cosmetic: a node's result is cached by
 * provenance (invariant 4), so `evaluate` has to be deterministic for fixed params. CAVE returns
 * the tables in whatever order its query planner produced and answers views as a JSON object,
 * whose key order is an implementation detail of both the server and the parser. Sorting is what
 * makes the same Run twice the same table twice.
 *
 * The two endpoints are issued **together**. Neither depends on the other and `includeViews` is
 * known before either starts, so awaiting them in sequence added a full round trip to a shared
 * production server on the path of both the card's first fill and this node's Run.
 */
export function tableListFor(
  datastack: string,
  version: number,
  options: CaveRequestOptions = {},
  includeViews = true,
): Promise<CaveTableEntry[]> {
  const key = `${keyFor(datastack, version)}|${includeViews ? 'v' : 't'}`
  return Promise.all([
    namesFor(datastack, version, options),
    includeViews ? viewsFor(datastack, version, options) : Promise.resolve({}),
  ]).then(([names, views]) => {
    const entries = [
      ...[...names].sort(byName).map((name): CaveTableEntry => ({ name, kind: 'table' })),
      // Tables before views rather than one alphabetical run: the two are different kinds of
      // object and the tables are what a datastack is normally asked about, so they belong on top.
      ...Object.keys(views)
        .sort(byName)
        .map((name): CaveTableEntry => ({ name, kind: 'view' })),
    ]
    const before = listed.get(key)
    listed.set(key, entries)
    // A table name that could not be checked a moment ago now can, and `validate` reads the
    // settled listing. The same channel a landed materialization list uses — and only when the
    // answer actually changed, since the underlying requests are memoised and every later caller
    // resolves from them.
    if (!before) reportSourceLearned('cave')
    return entries
  })
}

/**
 * The listing if it has landed, starting the fetch if nobody has.
 *
 * `peekMaterializations`' contract exactly: **`undefined` means "not yet", not "none"**, because
 * this is read from a card that renders on every graph mutation and may not await. Started once
 * per datastack, never once per peek — the `asked` set is what stops a request per keystroke, and
 * it is deliberately not cleared on failure, for the reason `runDiscovery`'s is not.
 *
 * Always the full listing including views, whatever the asking node's own toggle says: this feeds
 * `validate`, and a table name being refused because a *checkbox* is off would be a message about
 * the wrong thing entirely.
 */
export function peekTableList(
  datastack: string,
  version: number,
): CaveTableEntry[] | undefined {
  const key = `${keyFor(datastack, version)}|v`
  const known = listed.get(key)
  if (known || !datastack || listingAsked.has(key)) return known
  listingAsked.add(key)
  // Swallowed: a peek has no caller to report to, and a 401 already travels on its own channel
  // to the Connections panel. `peekMaterializations`' trade.
  void tableListFor(datastack, version).catch(() => undefined)
  return undefined
}

/** Which kind of object this name is, according to a listing that has landed. */
export function kindOf(
  entries: readonly CaveTableEntry[] | undefined,
  name: string,
): CaveObjectKind | undefined {
  return entries?.find((e) => e.name === name)?.kind
}

// ---------------------------------------------------------------------------
// One table's facts
// ---------------------------------------------------------------------------

/**
 * What one table or view says about itself, and how many rows it holds.
 *
 * Never a query — see the module header. For a table that is a metadata read plus two counts; for
 * a view it is one entry of a listing that is very likely already in hand.
 */
export function tableFactsFor(
  datastack: string,
  version: number,
  name: string,
  options: CaveRequestOptions = {},
): Promise<CaveTableFacts> {
  const key = `${keyFor(datastack, version)}|${name}`
  let pending = factsLoading.get(key)
  if (!pending) {
    pending = loadFacts(datastack, version, name, options)
      .then((facts) => {
        factsKnown.set(key, facts)
        // The promise is kept on success, so this runs once per key however many callers there
        // are — no "only the first time" guard, unlike `l2SourceFor`, which drops its promise in
        // a `finally` and so really can load twice.
        reportSourceLearned('cave')
        return facts
      })
      .catch((error: unknown) => {
        factsLoading.delete(key)
        throw error
      })
    factsLoading.set(key, pending)
  }
  return pending
}

async function loadFacts(
  datastack: string,
  version: number,
  name: string,
  options: CaveRequestOptions,
): Promise<CaveTableFacts> {
  const entries = await tableListFor(datastack, version, options)
  const kind = kindOf(entries, name)
  if (!kind) {
    throw new Error(
      `"${name}" is not a table or view in ${datastack}:${version}. ` +
        `Available: ${entries.map((e) => e.name).join(', ')}`,
    )
  }
  // The listing above already downloaded every view's description, so a view's facts are a map
  // lookup rather than a request. Reaching for `listViews` again here is what the module header
  // means by "one entry of a listing that is very likely already in hand".
  if (kind === 'view')
    return viewFacts(name, (await viewsFor(datastack, version, options))[name] ?? {})
  const server = await caveServerFor(datastack, options)
  /*
   * The aligned volume is only needed for the annotation service's count, and the datastack
   * record it comes from is memoised and almost certainly already in hand. Resolved before the
   * counts rather than inside them so the two counts can be issued together.
   */
  const record = await datastackRecord(datastack, options)
  const alignedVolume = record.aligned_volume?.name
  const [metadata, rows, materializedRows] = await Promise.all([
    tableMetadata(server, datastack, version, name, options),
    alignedVolume
      ? optionalCount(annotationCount(server, alignedVolume, name, options))
      : Promise.resolve(undefined),
    optionalCount(materializedCount(server, datastack, version, name, options)),
  ])
  return tableFacts(name, metadata, rows, materializedRows)
}

function tableFacts(
  name: string,
  metadata: TableMetadata,
  rows: number | undefined,
  materializedRows: number | undefined,
): CaveTableFacts {
  return {
    name,
    kind: 'table',
    description: text(metadata.description),
    notice: text(metadata.notice_text),
    schemaType: text(metadata.schema_type),
    referenceTable: text(metadata.reference_table),
    readPermission: text(metadata.read_permission),
    writePermission: text(metadata.write_permission),
    created: text(metadata.created),
    lastModified: text(metadata.last_modified),
    voxelResolution: resolution(metadata),
    rows,
    materializedRows,
  }
}

function viewFacts(name: string, info: ViewInfo): CaveTableFacts {
  return {
    name,
    kind: 'view',
    description: text(info.description),
    notice: text(info.notice_text),
    voxelResolution: resolution(info),
  }
}

/**
 * A field that is present, non-null and not blank — the three absences CAVE spells differently.
 *
 * `notice_text` comes back as `null` on every table that has none, `segmentation_source` as the
 * empty string, and a reference table simply omits `pcg_table_name`. All three mean "there is
 * nothing here", and a card that rendered `null` for one of them would be reporting the encoding.
 */
function text(value: string | null | undefined): string | undefined {
  return value?.trim() || undefined
}

/**
 * The stored resolution, left off entirely when it is 1:1.
 *
 * Every table probed on `flywire_fafb_public` reports `1, 1, 1` — positions already in
 * nanometres — so showing it would put a row saying nothing on every card. It is kept for the
 * datastack where it is not, which is the case `desired_resolution` exists for.
 */
function resolution(
  info: Pick<ViewInfo, 'voxel_resolution_x' | 'voxel_resolution_y' | 'voxel_resolution_z'>,
): readonly [number, number, number] | undefined {
  const { voxel_resolution_x: x, voxel_resolution_y: y, voxel_resolution_z: z } = info
  if (x === undefined || y === undefined || z === undefined) return undefined
  if (x === 1 && y === 1 && z === 1) return undefined
  return [x, y, z]
}

/**
 * The facts if they have landed, starting the fetch if nobody has.
 *
 * **Gated on the listing already knowing the name**, which is what makes this safe to call from a
 * card sitting under a text field. Without the gate, typing `nuclei_v1` one character at a time
 * would fire a metadata read and two counts for `n`, `nu`, `nuc` and so on — nine sets of 404s
 * against a shared production server for one table anybody wanted. With it, nothing is requested
 * until the name is one the datastack actually published.
 *
 * The listing itself is the first thing this starts, so the first look answers `undefined` twice:
 * once while the listing lands, once while the facts do. `reportSourceLearned` drives both.
 */
export function peekTableFacts(
  datastack: string,
  version: number,
  name: string,
): CaveTableFacts | undefined {
  if (!datastack || !name) return undefined
  const key = `${keyFor(datastack, version)}|${name}`
  const known = factsKnown.get(key)
  if (known || factsAsked.has(key)) return known
  if (!kindOf(peekTableList(datastack, version), name)) return undefined
  factsAsked.add(key)
  void tableFactsFor(datastack, version, name).catch(() => undefined)
  return undefined
}

// ---------------------------------------------------------------------------
// One table's columns
// ---------------------------------------------------------------------------

/**
 * How many rows the column sample asks for.
 *
 * One, which is `caveclient.query_table(..., limit=1)` and is all it takes to read the
 * *materialized* column set — which is the thing that cannot be got any other way. A table's
 * registered schema describes a row before materialization (`pt` as a bound spatial point), where
 * a query answers with what a query answers with: `pt_position_x`, `pt_position_y`,
 * `pt_position_z`, `pt_supervoxel_id`, `pt_root_id`.
 *
 * The cost of one rather than twenty-five is a column whose single row is null reporting no
 * dtype. That is a real hole — `superceded_id` on `nuclei_v1` is exactly it — and it is left as
 * an admission rather than papered over, because the request is against a shared production
 * server and this one is issued from a node people will click repeatedly.
 */
const SAMPLE_ROWS = 1

/**
 * The table this one references, or undefined for a table that stands on its own.
 *
 * `reference_table` off the same metadata document `tableFactsFor` reads, memoised the same way
 * and normalised through the same `text()` — because the alternative was two readers of one
 * field deciding independently what a blank, a `null` and an omission each mean. It is a
 * separate call rather than `tableFactsFor` because that one also issues the listing and both
 * row counts, and a read needs none of those.
 *
 * A materialization is *frozen*, so this answer can never change for a key: the first read pays
 * for it and the CAVE Table Info card, which fetches the identical document for the identical
 * table, gets it for nothing.
 */
export function referenceTableFor(
  datastack: string,
  version: number,
  name: string,
  options: CaveRequestOptions = {},
): Promise<string | undefined> {
  const key = `${keyFor(datastack, version)}|${name}`
  const known = factsKnown.get(`${keyFor(datastack, version)}|table|${name}`)
  if (known) return Promise.resolve(known.referenceTable)
  let pending = referencesLoading.get(key)
  if (!pending) {
    pending = loadReferenceTable(datastack, version, name, options).catch((error: unknown) => {
      referencesLoading.delete(key)
      throw error
    })
    referencesLoading.set(key, pending)
  }
  return pending
}

async function loadReferenceTable(
  datastack: string,
  version: number,
  name: string,
  options: CaveRequestOptions,
): Promise<string | undefined> {
  const server = await caveServerFor(datastack, options)
  const metadata = await tableMetadata(server, datastack, version, name, options)
  return text(metadata.reference_table)
}

/**
 * One sampled row, read as a column listing.
 *
 * Never a request the peek makes — see the module header on views and `limit`.
 */
export function tableColumnsFor(
  datastack: string,
  version: number,
  name: string,
  kind: CaveObjectKind,
  options: CaveRequestOptions = {},
): Promise<CaveColumnSample[]> {
  const key = `${keyFor(datastack, version)}|${kind}|${name}`
  let pending = columnsLoading.get(key)
  if (!pending) {
    pending = loadColumns(datastack, version, name, kind, options).catch((error: unknown) => {
      columnsLoading.delete(key)
      throw error
    })
    columnsLoading.set(key, pending)
  }
  return pending
}

async function loadColumns(
  datastack: string,
  version: number,
  name: string,
  kind: CaveObjectKind,
  options: CaveRequestOptions,
): Promise<CaveColumnSample[]> {
  const server = await caveServerFor(datastack, options)
  const query = { limit: SAMPLE_ROWS }
  /*
   * No `refuseIfCapped` here, and that is the one place in this module where the 500,000-row rule
   * is deliberately not applied: a limited answer is short because it was asked to be. See
   * `CaveQuery.limit`.
   */
  const rows =
    kind === 'view'
      ? await queryView(server, datastack, version, { ...query, view: name }, options)
      : await queryTable(server, datastack, version, { ...query, table: name }, options)
  return sampleColumns(rows)
}

/**
 * A row of JSON as a column listing.
 *
 * **The example is the value verbatim, never formatted**, and that is invariant 8 rather than
 * laziness. `pt_root_id` arrives from `json.ts` as the string `"720575940626838909"` because a
 * float64 cannot hold it; putting it through the number formatter that groups a count would
 * print an id with separators in it, and putting it through anything that parses would print a
 * different neuron. What the wire said is what the cell says.
 *
 * That is also why `pt_root_id` reports `str`: it *is* text by the time anything in Coda can see
 * it, and a column listing that claimed `i64` would be advertising a type no consumer will get.
 */
export function sampleColumns(rows: readonly CaveRow[]): CaveColumnSample[] {
  const row = rows[0]
  if (!row) return []
  return Object.entries(row).map(([name, value]) => ({
    name,
    dtype: caveDType(value),
    example: value === null || value === undefined ? '' : String(value),
  }))
}
