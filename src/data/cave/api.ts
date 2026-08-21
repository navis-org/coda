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
