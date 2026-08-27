/**
 * A CAVE annotation table as an annotation source.
 *
 * The other half of the pair: where SeaTable is somebody's spreadsheet beside the connectome,
 * this is a table inside the datastack itself — `nuclei_v1`, `neuron_information_v2`, or a
 * lab's own. It reuses `cave/api.ts` wholesale, so there is no transport here at all.
 *
 * **It reads a table that carries a root id, and one that has to be joined to find one.** The
 * second kind is a CAVE *reference* table — `cell_type_reference`, keyed by `target_id` into
 * another table's `id`, with no root id of its own anywhere in it. BANC's `codex_annotations`
 * references `cell_representative_point`; FlyWire's `hierarchical_neuron_annotations` references
 * `proofread_neurons`. This used to be the line the provider drew, and it drew it in the worst
 * available place: the read did not decline, it asked the server for `pt_root_id` and got back
 * `CAVE returned 500: pt_root_id not in model or models for codex_annotations`, which names a
 * column the user typed and no reason it should be wrong.
 *
 * So the join is here now, and it is one request rather than two: the table's own metadata says
 * which table it references, and `CaveReference` turns the read into a join query. Nothing about
 * it is FlyWire-specific, which is what keeps this provider about *tables*.
 *
 * `CaveSource` still writes its own join for the built-in path, and **not** because it joins
 * different tables. It does not: `flywire_fafb_public` is the only spec with an `annotations`
 * block, and there its `neurons.table` and `hierarchical_neuron_annotations`' `reference_table`
 * are the same table, `proofread_neurons`. The real reason is that `buildIndex` has already read
 * the neuron rows — it needs them for the population list — so its `rootById` join is a Map over
 * rows it is holding, where `CaveReference` would buy a *server-side* join on each of the five
 * per-kind queries to learn what is already in hand.
 *
 * **Long form pivots, wide form does not.** A CAVE annotation table is often one row per
 * (neuron, kind, value) rather than one row per neuron — the shape `classification_system` /
 * `cell_type` makes — so `pivotOn` turns those into columns. Absent, every kept column is taken
 * as it stands. One provider covers both because the difference is two config fields, not two
 * implementations.
 */

import type { DType, TableSchema } from '../../core/types'
import { column, tableSchema } from '../../core/types'
import { ID_COLUMN_NAME } from '../../core/ids'
import type { ColumnData, TableValue } from '../../core/values'
import { makeTable } from '../../core/values'
import { caveDType } from '../cave/json'
import type { CaveRequestOptions, CaveRow } from '../cave/client'
import type { CaveReference } from '../cave/api'
import { queryTableChecked, uniqueStringValues } from '../cave/api'
import { referenceTableFor, tableColumnsFor } from '../cave/tables'
import { caveServerFor } from '../cave/datastack'
import { splitDatasetId } from '../cave/spec'
import {
  cachedAnnotationTable,
  registerAnnotationProvider,
  reportAnnotationsLearned,
} from './registry'
import type { AnnotationFetchOptions, AnnotationProvider, AnnotationRef } from './types'
import { annotationColumns, namedColumns } from './types'

/** A short annotation set reads as neurons having no labels, rather than as a truncated read. */
const INCOMPLETE = 'these annotations would be incomplete'

export const CAVE_TABLE_PROVIDER = 'caveTable'

/** What a CAVE table ref names. */
export interface CaveTableConfig extends Record<string, string> {
  /** `datastack:materialization`, the same id a Dataset node publishes. */
  dataset: string
  table: string
  /**
   * Column holding the root id. `pt_root_id` on every CAVE table Coda has seen.
   *
   * On a **reference** table it names a column of the *referenced* table, because that is the
   * only place a root id exists — the annotation table itself carries `target_id` and nothing
   * else that identifies a neuron. Nobody has to know that: it is the same field, holding the
   * same default, and the join is what makes it true.
   */
  idColumn: string
  /**
   * Column naming the *kind* of annotation, for a long-form table. Empty means wide.
   *
   * With it set, the distinct values of this column become Coda's columns and `valueColumn`
   * holds the value. Without it, `columns` are taken as they stand.
   */
  pivotOn: string
  /** With `pivotOn`, the column holding the annotation itself. */
  valueColumn: string
  /** Comma-separated columns to keep, for a wide table. Empty keeps everything but the id. */
  columns: string
}

/**
 * Distinct values of `pivotOn` for a long table, keyed by (dataset, table, column).
 *
 * `has()` means asked, the value means landed — see the twin in `seaTable.ts` for why that is
 * one Map rather than a flag beside a field.
 */
const discovery = new Map<string, string[] | undefined>()

/** One key per (dataset, table, pivot column) — what a set of kinds is a fact about. */
function kindKey(config: CaveTableConfig): string {
  return `${config.dataset}|${config.table}|${config.pivotOn}`
}

class CaveTableProvider implements AnnotationProvider {
  readonly id = CAVE_TABLE_PROVIDER
  readonly label = 'CAVE table'

  /**
   * The columns this ref would produce.
   *
   * A **wide** table answers immediately from the ref itself — the columns are the ones somebody
   * named, and nothing has to be fetched to know that. A **long** one cannot: its columns are the
   * distinct values of `pivotOn`, which is a question for the server. So this is the one branch
   * that starts discovery, through `unique_string_values` — 52 kB, the same cheap call
   * `CaveSource` uses for exactly this.
   */
  peekColumns(ref: AnnotationRef): TableSchema | undefined {
    const config = ref.config as CaveTableConfig
    if (!config.dataset || !config.table) return undefined

    if (!config.pivotOn) {
      const named = namedColumns(config.columns, config.idColumn)
      // Empty means "everything", which for a wide table cannot be answered without reading it.
      // Unknown rather than a guess: a schema this picker cannot see is not a schema without
      // columns in it.
      if (named.length === 0) return undefined
      // Through the same `annotationColumns` the shapers use — invariant 3, and here the
      // collision it resolves would otherwise offer a picker a column no table has.
      return tableSchema(
        column(ID_COLUMN_NAME, 'str'),
        ...annotationColumns(named).map((n) => column(n, 'str')),
      )
    }

    const kinds = this.kindsFor(config)
    if (!kinds) return undefined
    return tableSchema(
      column(ID_COLUMN_NAME, 'str'),
      ...annotationColumns(kinds).map((n) => column(n, 'str')),
    )
  }

  private kindsFor(config: CaveTableConfig): string[] | undefined {
    const key = kindKey(config)
    if (discovery.has(key)) return discovery.get(key)
    discovery.set(key, undefined)
    const parsed = splitDatasetId(config.dataset)
    if (!parsed) return undefined
    // Once per ref, never once per peek: inference runs on every graph mutation. Swallowed, and
    // never retried from here — the rule `peekDatasets` follows.
    void (async () => {
      const server = await caveServerFor(parsed.datastack)
      const values = await uniqueStringValues(server, parsed.datastack, config.table)
      discovery.set(key, [...(values[config.pivotOn] ?? [])].sort())
      reportAnnotationsLearned()
    })().catch(() => undefined)
    return undefined
  }

  fetch(ref: AnnotationRef, options: AnnotationFetchOptions): Promise<TableValue> {
    return cachedAnnotationTable(ref, options, () =>
      this.read(ref.config as CaveTableConfig, options),
    )
  }

  private async read(
    config: CaveTableConfig,
    options: AnnotationFetchOptions,
  ): Promise<TableValue> {
    const parsed = splitDatasetId(config.dataset)
    if (!parsed) {
      throw new Error(
        `"${config.dataset}" does not name a CAVE dataset. Expected datastack:materialization.`,
      )
    }
    const server = await caveServerFor(parsed.datastack)
    const { datastack, version } = parsed
    const signal = options.signal ? { signal: options.signal } : {}

    if (config.pivotOn) {
      options.onProgress?.(0.1, 'reading annotation kinds')
      /*
       * Concurrent, because neither answers the other: the kinds come off this table's own
       * `pivotOn` column either way, and whether there is a reference table changes only which
       * columns the per-kind queries ask for. Serialised, it put a full round trip in front of
       * every long-form read — including every FlyWire one, which has no reference at all.
       */
      const [reference, values] = await Promise.all([
        referenceFor(datastack, version, config, signal),
        uniqueStringValues(server, datastack, config.table, signal),
      ])
      const kinds = [...(values[config.pivotOn] ?? [])].sort()
      discovery.set(kindKey(config), kinds)
      const withId = idColumns(config, reference)

      /*
       * One query per kind, which is `CaveSource.loadAnnotations`' finding applied here: a whole
       * annotation table can be over a deployment's row cap, and filtered by kind each query is
       * comfortably under. It costs no extra round trip, because the kinds had to be discovered
       * anyway. Measured on BANC's `codex_annotations`: 1,994,371 rows across 32 kinds, the
       * largest of them 158,265.
       */
      const perKind = await Promise.all(
        kinds.map(async (kind, i) => {
          const rows = await queryTableChecked(
            server,
            datastack,
            version,
            {
              table: config.table,
              filters: { equal: { [config.pivotOn]: kind } },
              columns: withId([config.valueColumn]),
              ...(reference ? { reference } : {}),
            },
            { of: `${config.table} (${kind})`, consequence: INCOMPLETE },
            signal,
          )
          options.onProgress?.(0.2 + (0.7 * (i + 1)) / Math.max(1, kinds.length), kind)
          return [kind, rows] as const
        }),
      )
      return pivotRows(perKind, config)
    }

    options.onProgress?.(0.2, 'reading annotations')
    // Serial here and not above, and the reason is the one asymmetry between the two branches:
    // a wide read cannot know which columns to name until it knows whether it is joining.
    const reference = await referenceFor(datastack, version, config, signal)
    const named = await wideColumns(datastack, version, config, Boolean(reference), signal)
    const rows = await queryTableChecked(
      server,
      datastack,
      version,
      {
        table: config.table,
        ...(named.length > 0 ? { columns: idColumns(config, reference)(named) } : {}),
        ...(reference ? { reference } : {}),
      },
      { consequence: INCOMPLETE },
      signal,
    )
    options.onProgress?.(1, `${rows.length} rows`)
    return wideRows(rows, config, named)
  }
}

/**
 * Prepend the id column, unless the join is supplying it.
 *
 * The one rule both branches need and each used to spell for itself: on a reference table the id
 * comes off the *referenced* table, so naming it here would ask this table for a column it has
 * not got — which is the 500 this whole path exists to avoid.
 */
function idColumns(
  config: CaveTableConfig,
  reference: CaveReference | undefined,
): (own: readonly string[]) => string[] {
  return (own) => (reference ? [...own] : [config.idColumn, ...own])
}

/**
 * The other half of a reference table, or undefined for a table that carries its own root id.
 *
 * Through `tables.ts`, which is the module that owns "what one CAVE table says about itself" and
 * memoises it per (datastack, version, table) — so this is free after the first read and shared
 * with the CAVE Table Info card, which fetches the identical document. Reading `reference_table`
 * off `tableMetadata` here instead gave that one field two independent readers normalising a
 * blank, a `null` and an omission each in their own way.
 *
 * Asked unconditionally rather than only after a 500, because "did that fail because it is a
 * reference table" is not a question an error message answers reliably.
 */
async function referenceFor(
  datastack: string,
  version: number,
  config: CaveTableConfig,
  options: CaveRequestOptions,
): Promise<CaveReference | undefined> {
  const table = await referenceTableFor(datastack, version, config.table, options)
  if (!table) return undefined
  // Only the id: everything else the referenced table holds is its own bookkeeping and geometry,
  // which is not an annotation about anything.
  return { table, columns: [config.idColumn] }
}

/**
 * Which columns a wide read asks for.
 *
 * Empty means "everything but the id" and normally stays empty — a single-table query with no
 * `select_columns` answers every column, and `wideRows` reads the set off row zero.
 *
 * A **reference** table cannot leave it empty, and that is the join endpoint's rule rather than
 * a choice: `select_column_map` has to name both sides or neither, and neither means the whole
 * join comes back — the target's `id_ref`, `created_ref`, `pt_position_x` and the rest, offered
 * to somebody as annotations. So the table's own column set is sampled first, with the one
 * `limit: 1` query `tables.ts` already caches for exactly this, and named explicitly.
 */
async function wideColumns(
  datastack: string,
  version: number,
  config: CaveTableConfig,
  joining: boolean,
  options: CaveRequestOptions,
): Promise<string[]> {
  const named = namedColumns(config.columns, config.idColumn)
  if (named.length > 0 || !joining) return named
  const sampled = await tableColumnsFor(datastack, version, config.table, 'table', options)
  return sampled.map((c) => c.name).filter((name) => name !== config.idColumn)
}

/** Long form to one row per neuron, a column per kind. */
export function pivotRows(
  perKind: ReadonlyArray<readonly [string, CaveRow[]]>,
  config: CaveTableConfig,
): TableValue {
  const byId = new Map<string, Record<string, string>>()
  for (const [kind, rows] of perKind) {
    for (const row of rows) {
      const raw = row[config.idColumn]
      const value = row[config.valueColumn]
      if (raw === null || raw === undefined || value === null || value === undefined) continue
      const id = String(raw)
      let record = byId.get(id)
      if (!record) {
        record = {}
        byId.set(id, record)
      }
      record[kind] = String(value)
    }
  }

  const kinds = perKind.map(([kind]) => kind)
  // Coda's names, deduplicated: a table carrying both a `cell_type` kind and a `type` one maps
  // two of them onto a single column. See `annotationColumns`.
  const codaNames = annotationColumns(kinds)
  const schema = tableSchema(
    column(ID_COLUMN_NAME, 'str'),
    ...codaNames.map((name) => column(name, 'str')),
  )
  const data: Record<string, ColumnData> = {}
  for (const col of schema.columns) data[col.name] = []
  const ids = data[ID_COLUMN_NAME]!
  const targets = kinds.map((kind, i) => ({ kind, into: data[codaNames[i]!]! }))
  // The Map's own insertion order *is* the order — an `order` array beside it was a second copy
  // of it, and re-looking-up each record by id recovered something the iteration already yields.
  for (const [id, record] of byId) {
    ids.push(id)
    for (const { kind, into } of targets) into.push(record[kind] ?? null)
  }
  return makeTable(schema, data)
}

/** Wide form, taken as it stands. */
export function wideRows(
  rows: readonly CaveRow[],
  config: CaveTableConfig,
  named: readonly string[],
): TableValue {
  // With no `columns` named, everything the server sent but the id — which is how a wide table
  // says "all of it" without a round trip to find out what "all" is.
  let columns: string[]
  if (named.length > 0) {
    columns = [...named]
  } else {
    /*
     * Row zero decides it. `CaveRow[]` comes out of one `parseCaveJson` of a records array, so
     * every row carries every key — nulls included — and walking all of them was a full
     * row-by-column pass plus a transient array per row: 48 ms at the 500,000-row cap, to learn
     * what the first row already said.
     */
    columns = Object.keys(rows[0] ?? {}).filter((name) => name !== config.idColumn)
  }

  const dtypes = dtypesOf(rows, columns)
  // Coda's names, deduplicated: a table carrying both `cell_type` and `type` maps two of its
  // columns onto one. See `annotationColumns`.
  const codaNames = annotationColumns(columns)
  const schema = tableSchema(
    column(ID_COLUMN_NAME, 'str'),
    ...columns.map((name, i) => column(codaNames[i]!, dtypes.get(name) ?? 'str')),
  )
  const data: Record<string, ColumnData> = {}
  for (const col of schema.columns) data[col.name] = []

  const ids = data[ID_COLUMN_NAME]!
  const targets = columns.map((name, i) => ({ name, into: data[codaNames[i]!]! }))
  for (const row of rows) {
    const raw = row[config.idColumn]
    if (raw === null || raw === undefined) continue
    /*
     * A repeated root id is kept — a table keyed by a point carries one where a segment holds
     * two nuclei, and that is a fact about the data worth seeing. `shapeRows` in `seaTable.ts`
     * records why collapsing it here was redundant rather than protective.
     */
    ids.push(String(raw))
    for (const { name, into } of targets) {
      const value = row[name]
      into.push(value === undefined ? null : value)
    }
  }
  return makeTable(schema, data)
}

/**
 * Each column's dtype, from the first row that has a value for it.
 *
 * **One pass for every column**, stopping once each is decided — it was a pass *per column*,
 * restarting from row zero, so a sparse table (which CAVE annotation tables routinely are) cost
 * a full scan for every column that was null near the top.
 *
 * Read from the data rather than a declared schema, because CAVE's per-table metadata does not
 * publish column types in a form this can read — and because `parseCaveJson` has already turned
 * every id too wide for a double into a string, so a root id arrives typed correctly by having
 * been handled correctly one layer down.
 */
function dtypesOf(rows: readonly CaveRow[], columns: readonly string[]): Map<string, DType> {
  const dtypes = new Map<string, DType>()
  // A shrinking list, not a scan of every column per row. The first rewrite iterated all of them
  // until the last one resolved, which on a sparse table — the case this is written for — is the
  // full row-by-column product: measured at 500,000 x 15 with one all-null column, 37 ms against
  // the 10 ms of the per-column version it replaced. Swap-popping matches that and keeps the
  // single pass.
  const pending = [...columns]
  for (const row of rows) {
    if (pending.length === 0) break
    for (let i = pending.length - 1; i >= 0; i--) {
      const name = pending[i]!
      const value = row[name]
      if (value === null || value === undefined) continue
      // `caveDType` never answers undefined for a non-null, which the `continue` above has
      // already excluded — so the `?? 'str'` is unreachable and exists only to satisfy the type.
      dtypes.set(name, caveDType(value) ?? 'str')
      pending[i] = pending[pending.length - 1]!
      pending.pop()
    }
  }
  // Null in every row: text, which is what an unknown widens to everywhere here.
  for (const name of pending) dtypes.set(name, 'str')
  return dtypes
}

registerAnnotationProvider(new CaveTableProvider())

/** Test seam: drop discovered kinds between suites. In-flight reads are `resetIndexLoads`'. */
export function resetCaveTableState(): void {
  discovery.clear()
}
