/**
 * CAVE's HTTP API, as Coda uses it. URLs and request bodies in one place; `client.ts` does
 * the fetching.
 *
 * **CAVE is two servers, and conflating them is the first thing to get wrong.** A *global*
 * info service knows which datastacks exist and, per datastack, which `local_server` actually
 * holds it — `flywire_fafb_public` lives on `global.daf-apis.com` but is queried at
 * `prod.flywire-daf.com`. So every function below takes the server it belongs to, and only
 * `datastackInfo` bridges the two.
 *
 * Every shape here was read off live responses (`flywire_fafb_public`, materializations 630 and
 * 783) and cross-checked against `caveclient` 8.0.1's own endpoint table, not recalled. Three
 * of them are not what a reasonable person would guess:
 *
 *  - **`tables` is a v2 path even in the v3 API.** caveclient's v3 endpoint map points `tables`
 *    at `mat_v2_api` while everything around it moved to v3; the v3 spelling 404s.
 *  - **`select_columns` and `select_column_map` are not interchangeable, and each endpoint
 *    takes exactly one.** A single-table or view query rejects the map outright —
 *    `{"schema_errors":{"select_columns":["Not a valid list."]}}` — and a *join* rejects the
 *    list just as outright: `{"schema_errors":{"select_column_map":["Field may not be null."]}}`,
 *    measured against BANC v888. See `CaveQuery.columns` and `CaveReference`.
 *  - **A reference table has no root id, and asking for one is a 500.** See `CaveReference`.
 *  - **`count=true` answers the same query as a `COUNT`, and it is the only honest tell that a
 *    result was truncated.** See `countTable`.
 *  - **`desired_resolution` is where geometry gets its units**, and it is why nothing on this
 *    source scales coordinates the way `data/units.ts` does.
 *  - **`table/{t}/metadata` is the mirror image: v3 where `tables` is v2**, and the two answer
 *    *different names*. v2 reports `table_name: "nuclei_v1__fly_v31"` — the materialized table —
 *    where v3 reports `nuclei_v1`, which is the name `tables` listed and the name a query takes.
 *    A card built from the v2 spelling shows somebody a name they cannot type back in.
 *  - **A table has two row counts and they disagree**, which is why `tableCounts` returns both.
 *    See `annotationCount` below.
 *  - **`arrow_format=false` is what makes any of this possible.** It returns
 *    `application/json`, so there is no Arrow dependency and nothing new in the main chunk.
 *    The cost is `json.ts`.
 */

import type { CaveRequestOptions, CaveRow } from './client'
import { CaveError, caveGet, cavePost, refuseIfCapped } from './client'

/**
 * A datastack's info record, as far as Coda reads it.
 *
 * Only the fields something actually reads: the record also carries the soma table name and a
 * few display hints, and declaring those would be a shape nothing checks against a server nothing
 * has asked.
 */
export interface DatastackInfo {
  /** Which server answers queries for this datastack. Not the global one. */
  local_server: string
  /**
   * `graphene://…` — where the segmentation lives, and the only route to neuron meshes.
   *
   * Not a bucket you can read by id: a root id is a dynamic agglomeration, so the fragment list
   * has to be asked for. See `meshes.ts`.
   */
  segmentation_source?: string
  /**
   * The datastack's own synapse table, where it declares one.
   *
   * **7 of the 13 datastacks the info service lists set this**, including `wclee_aedes_brain`,
   * `brain_and_nerve_cord_public` and `minnie65_public` — and `flywire_fafb_public` does *not*,
   * which is why `spec.synapses` exists and takes precedence. Reading it is what lets a datastack
   * with nothing but a synapse table answer connectivity with no configuration at all.
   *
   * Null rather than absent on a datastack that has none, so the type admits both.
   */
  synapse_table?: string | null
  /**
   * The EM volume, which lives on the aligned volume rather than on the datastack.
   *
   * `caveclient`'s `info.image_source()` reads it from exactly here. Every datastack probed
   * publishes it as an already-prefixed `precomputed://gs://…`.
   *
   * `name` is read for a different reason and by exactly one caller: the **annotation** service
   * is addressed by aligned volume rather than by datastack, so `annotationCount` cannot be
   * called without this document first. See `tableCounts` in `tables.ts`.
   */
  aligned_volume?: { image_source?: string; name?: string }
  /**
   * The datastack's skeleton service, as a `precomputed://` endpoint.
   *
   * Every datastack probed declares one — `flywire_fafb_public`, `brain_and_nerve_cord_public`
   * and `minnie65_public` all do — and declaring one says nothing about whether it can answer:
   * it is a cache that generates on demand, and two of those three are empty. See
   * `skeletonService.ts`, which is where that difference is measured rather than assumed.
   *
   * MICrONS spells it `precomputed://middleauth+https://…`, which is neuroglancer's way of
   * saying "this needs a CAVE token" and is not part of the URL.
   */
  skeleton_source?: string | null
  /** Which neuroglancer deployment this datastack is meant to be opened in. */
  viewer_site?: string
  /** Nanometres per voxel, as the viewer should show them. See `scene.ts`. */
  viewer_resolution_x?: number
  viewer_resolution_y?: number
  viewer_resolution_z?: number
}

/** One materialization's metadata. `expires_on` is why a CAVE version dropdown ages. */
export interface VersionInfo {
  version: number
  status?: string
  time_stamp?: string
  expires_on?: string
  valid?: boolean
}

const enc = encodeURIComponent

export function listDatastacks(
  globalServer: string,
  options?: CaveRequestOptions,
): Promise<string[]> {
  return caveGet<string[]>(`${globalServer}/info/api/v2/datastacks`, options)
}

export function datastackInfo(
  globalServer: string,
  datastack: string,
  options?: CaveRequestOptions,
): Promise<DatastackInfo> {
  return caveGet<DatastackInfo>(
    `${globalServer}/info/api/v2/datastack/full/${enc(datastack)}`,
    options,
  )
}

/**
 * Every materialization of a datastack, with its timestamps, in one request.
 *
 * Deliberately this rather than `versions` plus a `version/{n}` call apiece: the list endpoint
 * returns bare integers, so a dropdown built from it could say "783" and nothing else, and the
 * per-version calls turn a listing into a request per entry. `expires_on` is the field worth
 * having — CAVE materializations expire, which is the most confusing thing about the model, and
 * the existing "a pinned version the server no longer lists" path is what reports it.
 */
export function versionsMetadata(
  server: string,
  datastack: string,
  options?: CaveRequestOptions,
): Promise<VersionInfo[]> {
  return caveGet<VersionInfo[]>(
    `${server}/materialize/api/v3/datastack/${enc(datastack)}/metadata`,
    options,
  )
}

/**
 * Every distinct value of each string column of a table, version-independent.
 *
 * The cheap half of schema discovery: 52 kB and about a second on
 * `hierarchical_neuron_annotations`, against tens of megabytes for the table itself. It is how
 * the neuron schema learns its column names without downloading the annotations first — see
 * `schema.ts`.
 */
export function uniqueStringValues(
  server: string,
  datastack: string,
  table: string,
  options?: CaveRequestOptions,
): Promise<Record<string, string[]>> {
  return caveGet<Record<string, string[]>>(
    `${server}/materialize/api/v3/datastack/${enc(datastack)}/table/${enc(table)}/unique_string_values`,
    options,
  )
}

/**
 * The filters one query applies, in CAVE's own vocabulary.
 *
 * Each is keyed by table name and then by column, because a join query filters per table. The
 * single-table builders below wrap a caller's plain column map in the table key so no call site
 * has to know that.
 */
export interface CaveFilters {
  in?: Record<string, Array<string | number>>
  equal?: Record<string, string | number>
  atLeast?: Record<string, number>
}

/**
 * The other half of a **reference** table, which is a table with no root id in it at all.
 *
 * A CAVE table whose `schema_type` ends in `_reference` — `cell_type_reference` is the one Coda
 * meets — annotates *another* table rather than the segmentation: its rows carry `target_id`
 * into the target's `id`, and the root id lives over there. BANC's `codex_annotations` references
 * `cell_representative_point`; FlyWire's `hierarchical_neuron_annotations` references
 * `proofread_neurons`. Reading one without the join is not merely incomplete, it is a **500**:
 * `select_columns` is validated against the table's own model, so asking a reference table for
 * `pt_root_id` answers `pt_root_id not in model or models for codex_annotations`.
 *
 * So a reference query goes to the *join* endpoint — one path segment shorter, no table name in
 * the URL — and that endpoint differs in three ways that are each a silent wrong answer rather
 * than an error:
 *
 *  1. It takes `select_column_map` and **only** the map, where a single-table query takes
 *     `select_columns` and only the list. Naming one side of the map drops the other side's
 *     columns entirely rather than defaulting them, so `runQuery` sends the map only when both
 *     halves are known and otherwise asks for the whole join.
 *  2. `suffix_map` decides what collides. With `''` on the reference table and `_ref` on the
 *     target, a name only one side has arrives **bare** — `pt_root_id`, not `pt_root_id_ref` —
 *     which is what lets `pivotRows` read the same key either way.
 *  3. **`count=true` is not honoured on it**: it answers rows. `countTable` therefore counts the
 *     base table, which is exact — the join is many-to-one on a foreign key the annotation
 *     service maintains, and all five BANC kinds probed returned join rows equal to the base
 *     count to the row.
 */
export interface CaveReference {
  /** The table this one annotates. Its `id` is what `target_id` points at. */
  table: string
  /**
   * Columns wanted from it — in practice the root id alone, which is the whole reason to join.
   *
   * The server sends more than asked: selecting any `*_root_id` returns the whole bound point,
   * so `pt_supervoxel_id` comes along. A caller that names its columns is what drops it again.
   */
  columns?: string[]
}

/**
 * How a reference table points at its target, and how the join is spelled.
 *
 * `target_id` is the convention rather than a per-table fact — every `*_reference` schema uses
 * it, and `caveclient` hardcodes the same pair — so it is here rather than on `CaveReference`,
 * where it would be a knob nothing turns.
 */
const REFERENCE_KEY = 'target_id'
const TARGET_KEY = 'id'
/** Empty on the reference table, so its own columns keep the names its schema gave them. */
const REFERENCE_SUFFIX = ''
const TARGET_SUFFIX = '_ref'

/** Query args that never vary. JSON rather than Arrow; positions left as arrays. */
const QUERY_ARGS = 'return_pyarrow=false&arrow_format=false&split_positions=false'

function filterBody(table: string, filters: CaveFilters | undefined): Record<string, unknown> {
  if (!filters) return {}
  return {
    ...(filters.in ? { filter_in_dict: { [table]: filters.in } } : {}),
    ...(filters.equal ? { filter_equal_dict: { [table]: filters.equal } } : {}),
    ...(filters.atLeast ? { filter_greater_equal_dict: { [table]: filters.atLeast } } : {}),
  }
}

/** What one query asks for, whatever endpoint answers it. */
export interface CaveQuery {
  filters?: CaveFilters
  /**
   * Units to return position columns in. `[1, 1, 1]` is nanometres.
   *
   * Passed explicitly wherever geometry is read rather than relying on the server's default,
   * which happens to be nanometres for FlyWire's synapse table today. The table stores 4x4x40 nm
   * voxels — asking for both and watching the values divide by exactly 4, 4 and 40 is how that
   * was established — so a default that moved would put every synapse a factor out of the scene
   * with nothing failing.
   */
  resolution?: readonly [number, number, number]
  /**
   * Columns to return, as a **list**.
   *
   * Both endpoints below reject the table-keyed `select_column_map` outright. That map is the
   * *join* endpoint's spelling, and the difference is not cosmetic — a join accepts a plain list
   * while warning that it "will attempt to select the first column it finds of this name in any
   * table, but if there are more than one such column it will not select both", which is a
   * silently wrong column rather than an error. A **reference** query is the one exception and
   * it is not a flag on this field: `reference` below switches the whole request to the join
   * endpoint, where this list is re-spelled as one half of a `select_column_map`.
   */
  columns?: string[]
  /**
   * Cap the number of rows the server returns.
   *
   * The one thing here that is *not* about correctness: a query with no `limit` is a whole-table
   * download, and `CAVE table info` wants a single row to read the materialized column set off.
   * Verified against v783 rather than assumed — the v3 query endpoint accepts it on the same
   * body as everything else, which `caveclient.query_table(..., limit=1)` also relies on.
   *
   * It does **not** interact with the truncation check: an answer short because it was *asked* to
   * be is not a truncated one. `queryTableChecked` takes a query with this field removed, so that
   * is a type error rather than a rule in a comment — its count ignores a limit and would
   * therefore refuse every deliberately short read.
   */
  limit?: number
}

/**
 * A query against a *table*, which is the only thing that can be a reference table.
 *
 * Separate from `CaveQuery` so a view cannot express one. `runQuery` tests `reference` before it
 * consults `segment`, so a `reference` reaching `queryView` would post a join body naming the
 * view as a table and drop the `/views/` segment entirely — a silently wrong request that
 * typechecked, back when this field sat on the shared type and a comment did the enforcing.
 */
export interface CaveTableQuery extends CaveQuery {
  table: string
  /** Set to read a reference table, which cannot be read any other way. See `CaveReference`. */
  reference?: CaveReference
}

/**
 * Where a query goes. One spelling of the v3 path, because the module header records that
 * CAVE's do move — `tables` is still on v2 inside the v3 API — and a count pointing at a
 * different version than the query it is checking would agree with nothing and say so.
 */
function queryUrl(
  server: string,
  datastack: string,
  version: number,
  // `join` has no name in the path at all: which tables is what `tables` in the body says.
  segment: 'table' | 'views' | 'join',
  name: string,
  extra = '',
): string {
  const base = `${server}/materialize/api/v3/datastack/${enc(datastack)}/version/${version}`
  const path = segment === 'join' ? `${base}/query` : `${base}/${segment}/${enc(name)}/query`
  return `${path}?${QUERY_ARGS}${extra}`
}

/**
 * Three endpoints, one builder — and the third is not a variant of the other two.
 *
 * A table and a view differ in one path segment and nothing else: same body, same query args, so
 * they share this. That is what stops the paging `refuseIfCapped` promises from being added to
 * one and silently not the other. The named wrappers stay because a call site should say which
 * kind of thing it is asking about, and because a view is not a table in any other respect.
 *
 * A **reference** query is the third, and it shares only the filters, the limit and the
 * resolution — the path loses its table, `tables` and `suffix_map` appear, and `select_columns`
 * becomes `select_column_map`. It is here rather than in a function of its own because those
 * three shared fields are exactly the ones a caller sets identically either way, and two builders
 * is how one of them comes to be spelled differently on the path nobody exercises. Only
 * `CaveTableQuery` carries a `reference`, so the `views` segment cannot reach the branch.
 */
function runQuery(
  server: string,
  datastack: string,
  version: number,
  segment: 'table' | 'views',
  name: string,
  query: CaveQuery & { reference?: CaveReference },
  options?: CaveRequestOptions,
): Promise<CaveRow[]> {
  const shared = {
    ...filterBody(name, query.filters),
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
    ...(query.resolution ? { desired_resolution: [...query.resolution] } : {}),
  }
  if (!query.reference) {
    return cavePost<CaveRow[]>(
      queryUrl(server, datastack, version, segment, name),
      { ...shared, ...(query.columns ? { select_columns: query.columns } : {}) },
      options,
    )
  }
  const { table: target, columns: targetColumns } = query.reference
  return cavePost<CaveRow[]>(
    queryUrl(server, datastack, version, 'join', name),
    {
      tables: [
        [name, REFERENCE_KEY],
        [target, TARGET_KEY],
      ],
      suffix_map: { [name]: REFERENCE_SUFFIX, [target]: TARGET_SUFFIX },
      ...shared,
      /*
       * Both halves or neither. `select_column_map` naming only the target answers *only* the
       * target's columns — measured, and it reads as an annotation table that lost its
       * annotations — so a caller that cannot name its own columns asks for the whole join and
       * narrows afterwards.
       */
      ...(query.columns && targetColumns
        ? { select_column_map: { [name]: query.columns, [target]: targetColumns } }
        : {}),
    },
    options,
  )
}

export function queryTable(
  server: string,
  datastack: string,
  version: number,
  query: CaveTableQuery,
  options?: CaveRequestOptions,
): Promise<CaveRow[]> {
  return runQuery(server, datastack, version, 'table', query.table, query, options)
}

/**
 * How many rows this query *should* return, from the server's own `COUNT`.
 *
 * The honest half of truncation detection, and the reason `CAVE_MAX_ROWS` is now a fallback
 * rather than the test. The row cap is a **per-deployment config value**, not a property of
 * CAVE: `prod.flywire-daf.com` truncates `hierarchical_neuron_annotations` at exactly 500,000
 * and says so in a header CORS will not expose, while `cave.fanc-fly.com` returned all
 * 1,994,371 rows of BANC's `codex_annotations` in one reply with no warning at all. Counting
 * rows against a constant therefore refuses a whole answer on one deployment and misses a
 * truncated one on any deployment configured below the constant — the materialization engine's
 * own default is 200,000.
 *
 * **This is a third count on a table and it is the only one that answers this question**, which
 * is worth stating because the other two are documented side by side on the info card:
 * `materializedCount` counts the frozen snapshot and `annotationCount` counts the live table,
 * and *neither* equals what a query returns. Measured the same day —
 *
 * ```text
 * table                            materialized      count=true
 * proofread_neurons                     127,978         139,255
 * hierarchical_neuron_annotations       377,699         512,957
 * codex_annotations                   1,841,078       1,994,371
 * ```
 *
 * — so reaching for `materializedCount` here, which is the cheap precomputed GET and the
 * obvious saving, would *undercount* every table and make `rows >= total` true for a read that
 * was truncated. That is the original bug with a new cause.
 *
 * **Only the filters go in the body.** Columns and resolutions describe the shape of an answer
 * this one does not return, and `CaveTableQuery`'s `limit` is excluded by the signature of
 * `queryTableChecked` rather than by this comment.
 *
 * **Cheap only where the query is.** Measured: 0.6 s for a filtered synapse query and 0.7 s for
 * an unfiltered 2M-row annotation table, but over 180 s unfiltered on FlyWire's 130M-row
 * `synapses_nt_v1` and over 5 minutes on an aggregating *view* — which is why nothing counts a
 * view, and why every caller here is either filtered or reading a table of a size a browser was
 * going to download anyway.
 */
export async function countTable(
  server: string,
  datastack: string,
  version: number,
  query: CaveTableQuery,
  options?: CaveRequestOptions,
): Promise<number> {
  const rows = await cavePost<CaveRow[]>(
    // The base table, even for a reference query: the join endpoint answers rows to `count=true`
    // rather than a count. See `CaveReference`.
    queryUrl(server, datastack, version, 'table', query.table, '&count=true'),
    filterBody(query.table, query.filters),
    options,
  )
  const count = rows[0]?.count
  if (typeof count !== 'number') {
    throw new CaveError(`CAVE answered no count for "${query.table}"`)
  }
  return count
}

/**
 * A count that could not be had is an absent count, not a failed read.
 *
 * Both count paths need the same rule and it used to be written twice, one directory apart. The
 * caller always has something to fall back on — a row count against `CAVE_MAX_ROWS` here, a card
 * with one row missing in `tables.ts` — so a supplementary request must not take down a read
 * that has its answer. A 401 is unaffected: `client.ts` reports it on the auth channel before
 * this sees it. An `AbortError` is re-thrown, because swallowing it would answer a run the user
 * cancelled.
 */
export async function optionalCount(count: Promise<number>): Promise<number | undefined> {
  try {
    const value = await count
    // Anything non-finite is a service saying something this does not understand — an object
    // with a `message` in it, most likely. Absent beats treating it as a row count.
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    return undefined
  }
}

/**
 * A table query, refused if the server says it came back short. **The only way to read a table
 * that could be truncated.**
 *
 * The rows and the count are one call rather than two because they are one question: every
 * caller paired them by hand before, and nothing stopped a seventh site checking one query's
 * rows against another's count, or calling the counted read and skipping the check that is its
 * whole reason to exist.
 *
 * They run **concurrently**, which is what keeps the check free: on every call site here the
 * count is the faster of the two by an order of magnitude, so it lands inside the data query's
 * own wait. A failed count degrades to `undefined` and `refuseIfCapped` falls back to counting
 * rows against `CAVE_MAX_ROWS`, which is exactly as good as this was before.
 *
 * `limit` is excluded from the query type: an answer short because it was *asked* to be is not a
 * truncated one, and this would refuse every one of them.
 */
export async function queryTableChecked(
  server: string,
  datastack: string,
  version: number,
  query: Omit<CaveTableQuery, 'limit'>,
  /** What a truncated read would cost, and what to call the thing that was read. */
  refusal: { of?: string; consequence: string },
  options?: CaveRequestOptions,
): Promise<CaveRow[]> {
  const [rows, total] = await Promise.all([
    queryTable(server, datastack, version, query, options),
    optionalCount(countTable(server, datastack, version, query, options)),
  ])
  refuseIfCapped(rows.length, total, refusal.of ?? query.table, refusal.consequence)
  return rows
}

export function queryView(
  server: string,
  datastack: string,
  version: number,
  query: CaveQuery & { view: string },
  options?: CaveRequestOptions,
): Promise<CaveRow[]> {
  return runQuery(server, datastack, version, 'views', query.view, query, options)
}

// ---------------------------------------------------------------------------
// What a datastack holds, and what one table of it is
// ---------------------------------------------------------------------------

/**
 * The annotation tables in one materialization, by name.
 *
 * `caveclient.CAVEclient.materialize.get_tables`. **A v2 path inside the v3 API** — the header
 * above says why, and the v3 spelling 404s, checked again against v783 rather than inherited.
 *
 * Views are *not* in here; they are a separate endpoint (`listViews`) and a separate kind of
 * thing. `flywire_fafb_public` lists six tables and ten views, and the one Connectivity
 * prefers — `valid_connection_v2` — is a view, so a listing that showed only this would omit the
 * most useful object in the datastack.
 */
export function listTables(
  server: string,
  datastack: string,
  version: number,
  options?: CaveRequestOptions,
): Promise<string[]> {
  return caveGet<string[]>(
    `${server}/materialize/api/v2/datastack/${enc(datastack)}/version/${version}/tables`,
    options,
  )
}

/** One view's metadata, as the listing publishes it. A view carries no `schema_type`. */
export interface ViewInfo {
  description?: string | null
  notice_text?: string | null
  live_compatible?: boolean
  datastack_name?: string
  voxel_resolution_x?: number
  voxel_resolution_y?: number
  voxel_resolution_z?: number
}

/**
 * Every view in one materialization, keyed by name — the whole listing in one request.
 *
 * Unlike `listTables` this answers a *map*, so a view's description is in hand from the listing
 * and needs no per-view call. That asymmetry is the server's, not ours.
 */
export function listViews(
  server: string,
  datastack: string,
  version: number,
  options?: CaveRequestOptions,
): Promise<Record<string, ViewInfo>> {
  return caveGet<Record<string, ViewInfo>>(
    `${server}/materialize/api/v3/datastack/${enc(datastack)}/version/${version}/views`,
    options,
  )
}

/**
 * One annotation table's metadata record.
 *
 * `caveclient.CAVEclient.materialize.get_table_metadata`. Every field is optional because a
 * *reference* table genuinely omits several: `hierarchical_neuron_annotations` has no
 * `pcg_table_name`, no `segmentation_source` and no `flat_segmentation_source`, where
 * `nuclei_v1` has all three. Read off v783, both shapes.
 */
export interface TableMetadata {
  table_name?: string
  schema_type?: string
  description?: string | null
  /** A warning the table's publisher attached to it. Rare, and the reason it is surfaced. */
  notice_text?: string | null
  /** The table this one annotates, for a reference table. `target_id` joins back to its `id`. */
  reference_table?: string | null
  aligned_volume?: string
  valid?: boolean
  created?: string
  last_modified?: string
  read_permission?: string
  write_permission?: string
  voxel_resolution_x?: number
  voxel_resolution_y?: number
  voxel_resolution_z?: number
  flat_segmentation_source?: string | null
  pcg_table_name?: string | null
}

export function tableMetadata(
  server: string,
  datastack: string,
  version: number,
  table: string,
  options?: CaveRequestOptions,
): Promise<TableMetadata> {
  return caveGet<TableMetadata>(
    `${server}/materialize/api/v3/datastack/${enc(datastack)}/version/${version}/table/${enc(table)}/metadata`,
    options,
  )
}

/**
 * How many rows this materialization holds for a table. **Not how many the table has.**
 *
 * This is the count `docs/backends.md` records as pointing the wrong way, and the reason is now
 * measured rather than guessed at: it is the *materialized* count, and the annotation service
 * keeps its own. Against v783 —
 *
 * ```text
 * table                            materialize   annotation   what a query yields
 * nuclei_v1                            143,140      143,140
 * proofread_neurons                    127,978      139,540    139,255 distinct root ids
 * hierarchical_neuron_annotations      377,699      512,957    over the 500,000-row cap
 * ```
 *
 * Neither is wrong; showing only one of them is, which is why `tableCounts` reports both side by
 * side and labels which is which.
 *
 * **And neither predicts truncation, which this comment used to claim of the annotation count.**
 * A `count=true` query is a third number and the only one that answers that question — see
 * `countTable`, which measures all three side by side. The annotation count merely happens to be
 * the closest of the two here.
 */
export function materializedCount(
  server: string,
  datastack: string,
  version: number,
  table: string,
  options?: CaveRequestOptions,
): Promise<number> {
  return caveGet<number>(
    `${server}/materialize/api/v3/datastack/${enc(datastack)}/version/${version}/table/${enc(table)}/count`,
    options,
  )
}

/**
 * How many annotations the table holds, live — `caveclient.CAVEclient.annotation.
 * get_annotation_count`.
 *
 * The **annotation** service rather than the materialization engine, which is why it is addressed
 * by aligned volume and carries no version: it counts the table as it stands now, across every
 * materialization. See `materializedCount` for the measured gap between the two.
 *
 * It answers `201` rather than `200` on success. That is the service's own quirk and needs no
 * handling here — `client.ts` gates on `response.ok`, which covers the whole 2xx range — but it
 * is worth knowing before somebody tightens that check.
 */
export function annotationCount(
  server: string,
  alignedVolume: string,
  table: string,
  options?: CaveRequestOptions,
): Promise<number> {
  return caveGet<number>(
    `${server}/annotation/api/v2/aligned_volume/${enc(alignedVolume)}/table/${enc(table)}/count`,
    options,
  )
}
