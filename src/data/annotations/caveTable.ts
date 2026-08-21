/**
 * A CAVE annotation table as an annotation source.
 *
 * The other half of the pair: where SeaTable is somebody's spreadsheet beside the connectome,
 * this is a table inside the datastack itself — `nuclei_v1`, `neuron_information_v2`, or a
 * lab's own. It reuses `cave/api.ts` wholesale, so there is no transport here at all.
 *
 * **It reads a table that carries a root id directly**, wide or long, and that is where the line
 * falls. FlyWire's `hierarchical_neuron_annotations` does *not*: it is a `cell_type_reference`
 * keyed by `target_id` into `proofread_neurons`, so reading it means a second query and a join
 * that only the datastack's own spec knows how to write. That stays in `CaveSource` as the
 * built-in, which is what a dataset uses when nothing is wired — and keeping it there is what
 * lets this provider be about *tables* rather than about FlyWire.
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
import { refuseIfCapped } from '../cave/client'
import type { CaveRow } from '../cave/client'
import { queryTable, uniqueStringValues } from '../cave/api'
import { caveServerFor } from '../cave/datastack'
import { splitDatasetId } from '../cave/spec'
import {
  cachedAnnotationTable,
  registerAnnotationProvider,
  reportAnnotationsLearned,
} from './registry'
import type { AnnotationFetchOptions, AnnotationProvider, AnnotationRef } from './types'
import { annotationColumn, namedColumns } from './types'

/** A short annotation set reads as neurons having no labels, rather than as a truncated read. */
const INCOMPLETE = 'these annotations would be incomplete'

export const CAVE_TABLE_PROVIDER = 'caveTable'

/** What a CAVE table ref names. */
export interface CaveTableConfig extends Record<string, string> {
  /** `datastack:materialization`, the same id a Dataset node publishes. */
  dataset: string
  table: string
  /** Column holding the root id. `pt_root_id` on every CAVE table Coda has seen. */
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
      return tableSchema(
        column(ID_COLUMN_NAME, 'str'),
        ...named.map((n) => column(annotationColumn(n), 'str')),
      )
    }

    const kinds = this.kindsFor(config)
    if (!kinds) return undefined
    return tableSchema(
      column(ID_COLUMN_NAME, 'str'),
      ...kinds.map((kind) => column(annotationColumn(kind), 'str')),
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
    const signal = options.signal ? { signal: options.signal } : {}

    if (config.pivotOn) {
      options.onProgress?.(0.1, 'reading annotation kinds')
      const values = await uniqueStringValues(server, parsed.datastack, config.table, signal)
      const kinds = [...(values[config.pivotOn] ?? [])].sort()
      discovery.set(kindKey(config), kinds)

      /*
       * One query per kind, which is `CaveSource.loadAnnotations`' finding applied here: a whole
       * annotation table is routinely over CAVE's 500,000-row cap, and filtered by kind each
       * query is comfortably under. It costs no extra round trip, because the kinds had to be
       * discovered anyway.
       */
      const perKind = await Promise.all(
        kinds.map(async (kind, i) => {
          const rows = await queryTable(
            server,
            parsed.datastack,
            parsed.version,
            {
              table: config.table,
              filters: { equal: { [config.pivotOn]: kind } },
              columns: [config.idColumn, config.valueColumn],
            },
            signal,
          )
          refuseIfCapped(rows.length, `${config.table} (${kind})`, INCOMPLETE)
          options.onProgress?.(0.2 + (0.7 * (i + 1)) / Math.max(1, kinds.length), kind)
          return [kind, rows] as const
        }),
      )
      return pivotRows(perKind, config)
    }

    options.onProgress?.(0.2, 'reading annotations')
    const named = namedColumns(config.columns, config.idColumn)
    const rows = await queryTable(
      server,
      parsed.datastack,
      parsed.version,
      {
        table: config.table,
        ...(named.length > 0 ? { columns: [config.idColumn, ...named] } : {}),
      },
      signal,
    )
    refuseIfCapped(rows.length, config.table, INCOMPLETE)
    options.onProgress?.(1, `${rows.length} rows`)
    return wideRows(rows, config, named)
  }
}


/** Long form to one row per neuron, a column per kind. */
function pivotRows(
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
  const schema = tableSchema(
    column(ID_COLUMN_NAME, 'str'),
    ...kinds.map((kind) => column(annotationColumn(kind), 'str')),
  )
  const data: Record<string, ColumnData> = {}
  for (const col of schema.columns) data[col.name] = []
  const ids = data[ID_COLUMN_NAME]!
  const targets = kinds.map((kind) => ({ kind, into: data[annotationColumn(kind)]! }))
  // The Map's own insertion order *is* the order — an `order` array beside it was a second copy
  // of it, and re-looking-up each record by id recovered something the iteration already yields.
  for (const [id, record] of byId) {
    ids.push(id)
    for (const { kind, into } of targets) into.push(record[kind] ?? null)
  }
  return makeTable(schema, data)
}

/** Wide form, taken as it stands. */
function wideRows(
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
  const schema = tableSchema(
    column(ID_COLUMN_NAME, 'str'),
    ...columns.map((name) => column(annotationColumn(name), dtypes.get(name) ?? 'str')),
  )
  const data: Record<string, ColumnData> = {}
  for (const col of schema.columns) data[col.name] = []

  const ids = data[ID_COLUMN_NAME]!
  const targets = columns.map((name) => ({ name, into: data[annotationColumn(name)]! }))
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
      dtypes.set(
        name,
        typeof value === 'number'
          ? Number.isInteger(value)
            ? 'i64'
            : 'f64'
          : typeof value === 'boolean'
            ? 'bool'
            : 'str',
      )
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
