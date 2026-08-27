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
 *    `{"schema_errors":{"select_columns":["Not a valid list."]}}` — and a *join* accepts the
 *    list while silently taking the wrong column. See `CaveQuery.columns`.
 *  - **`desired_resolution` is where geometry gets its units**, and it is why nothing on this
 *    source scales coordinates the way `neuprint/units.ts` does.
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
import { caveGet, cavePost } from './client'

/**
 * A datastack's info record, as far as Coda reads it.
 *
 * Two fields, and deliberately not the rest: the record also carries `skeleton_source`,
 * `viewer_site` and the soma/synapse table names, which the skeleton and viewer-scene work will
 * want — declaring them now would be a shape nothing checks against a server nothing has asked.
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
   * silently wrong column rather than an error. Coda issues no join query today; when it does,
   * it needs its own builder rather than a flag on this one.
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
   * It does **not** interact with `CAVE_MAX_ROWS`: a limit below the cap means the answer is
   * short because it was asked to be, so a caller passing one must not also `refuseIfCapped`.
   */
  limit?: number
}

/**
 * The two endpoints differ in one path segment and nothing else.
 *
 * A table and a view take the same body and the same query args, so they share a builder — which
 * is what stops the paging `refuseIfCapped` promises from being added to one and silently not the
 * other. The named wrappers stay because a call site should say which kind of thing it is asking
 * about, and because a view is not a table in any other respect.
 */
function runQuery(
  server: string,
  datastack: string,
  version: number,
  segment: 'table' | 'views',
  name: string,
  query: CaveQuery,
  options?: CaveRequestOptions,
): Promise<CaveRow[]> {
  return cavePost<CaveRow[]>(
    `${server}/materialize/api/v3/datastack/${enc(datastack)}/version/${version}/${segment}/${enc(name)}/query?${QUERY_ARGS}`,
    {
      ...filterBody(name, query.filters),
      ...(query.columns ? { select_columns: query.columns } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.resolution ? { desired_resolution: [...query.resolution] } : {}),
    },
    options,
  )
}

export function queryTable(
  server: string,
  datastack: string,
  version: number,
  query: CaveQuery & { table: string },
  options?: CaveRequestOptions,
): Promise<CaveRow[]> {
  return runQuery(server, datastack, version, 'table', query.table, query, options)
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
 * thing. `flywire_fafb_public` lists six tables and ten views, and the one Connectivity Graph
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
 * So the *annotation* count is the one that predicts whether a query will be truncated, and this
 * one is the one that describes the frozen snapshot being queried. Neither is wrong; showing
 * only one of them is, which is why `tableCounts` reports both side by side and labels which is
 * which.
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
