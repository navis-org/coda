/**
 * A SeaTable base as an annotation target — FlyTable, or any other deployment.
 *
 * Reads go through **SQL**, not the rows endpoint the annotation provider pages through: a
 * selection is a handful of ids, and `SELECT … WHERE root_783 IN (…)` answers 10 ids in 0.08 s and
 * 1,000 in 0.71 s with only the columns asked for, where the alternative is the whole table (~79 MB
 * for FlyWire's `main.info`). `filtered-rows` is no substitute: it takes its filters only as a body
 * on a GET, which a browser cannot send. FlyTable answers SQL to a browser since 2026-10-03
 * (`docs/flytable-cors.md`). Measured on a scratch copy, `main_test.info_test`.
 *
 * Writes are `batch-update-rows`: `{row_id, row: {column: value}}` by the row's `_id`, at most
 * 1,000 rows a request — seatable_api's and seaserpent's limit. A newer deployment that says
 * `use_api_gateway` takes both through `{host}/api-gateway/` instead.
 *
 * Three facts that each fail silently:
 *
 * - **A query with no `LIMIT` stops at 100 rows**, and says nothing. Every query here sets one and
 *   treats reaching it as an error rather than an answer.
 * - **Values are spliced into SQL text**, so ids, row keys and column names are refused unless they
 *   are plainly what they claim — `isNeuronId`, `_id`'s alphabet, a name with no backtick. There
 *   is no escaping to get subtly wrong.
 * - **A checkbox nobody ticked reads as null**, and the stale-value check would then hold a write
 *   to it as moved; it is read as `false`.
 */

import { idText, isNeuronId } from '../../../core/ids'
import { memoPromise, untilAborted } from '../../memoPromise'
import type { BaseAccess, SeaTableColumn } from '../seaTable'
import { SeaTableError, openBase, readMetadataWith, request, tableNamed } from '../seaTable'
import { normaliseHost } from '../credentials'
import type {
  AnnotationTarget,
  FieldKind,
  FieldValue,
  TargetChange,
  TargetField,
  TargetRead,
  TargetWriteResult,
} from './types'
import { checkedWrite, readOf } from './checkedWrite'
import { cellOf, wallClock } from './fieldValues'

export interface SeaTableTargetConfig {
  host: string
  /** Empty to work it out from the base's name, as the annotation provider does. */
  workspace: string
  base: string
  table: string
  /** The column holding the neuron id: `root_783` on FlyWire's `info`. */
  idColumn: string
}

/** Values per `IN (…)`. The SQL is ~25 kB at 1,000 eighteen-digit ids; well inside what it takes. */
const VALUES_PER_QUERY = 1_000
/** The most rows one query returns. dtable-db's ceiling; a query reaching it is refused. */
const ROW_LIMIT = 10_000
/** Rows per update request: seatable_api's and seaserpent's limit. */
const ROWS_PER_UPDATE = 1_000
/** A base token is good for days; re-minted well inside that so a long session never meets 401. */
const ACCESS_MAX_AGE_MS = 30 * 60_000

/** SeaTable's `_id`: base64url, 22 characters. */
const SAFE_KEY = /^[A-Za-z0-9_-]+$/

const EDITABLE: Readonly<Record<string, FieldKind>> = {
  text: 'text',
  'long-text': 'text',
  email: 'text',
  url: 'text',
  date: 'date',
  number: 'number',
  checkbox: 'bool',
  'single-select': 'choice',
  'multiple-select': 'choices',
}

/** A row as SQL answered it: its key, its id cell, and the asked columns as fields hold them. */
interface Row {
  key: string
  id: string | null
  values: Record<string, FieldValue>
}

/** What a SeaTable target is a fact about, without building one: `targets/index.ts` keys by it. */
export function seaTableKey(config: SeaTableTargetConfig): string {
  const { workspace, base, table, idColumn } = config
  return `seaTable|${normaliseHost(config.host)}|${workspace}|${base}|${table}|${idColumn}`
}

export class SeaTableTarget implements AnnotationTarget {
  readonly key: string
  readonly label: string
  private readonly config: SeaTableTargetConfig
  /**
   * The base token and the table's columns, each one shared promise. **Shared work carries
   * nobody's signal** — one caller's Cancel would otherwise reject every other caller waiting on
   * it — so each caller waits through `untilAborted` instead.
   */
  private readonly baseMemo = new Map<'base', Promise<BaseAccess>>()
  private readonly columnsMemo = new Map<'columns', Promise<SeaTableColumn[]>>()
  private baseAt = 0

  constructor(config: SeaTableTargetConfig) {
    this.config = { ...config, host: normaliseHost(config.host) }
    this.key = seaTableKey(config)
    this.label = `${new URL(this.config.host).host} · ${config.base} / ${config.table}`
  }

  async fields(signal?: AbortSignal): Promise<TargetField[]> {
    return (await this.tableColumns(signal)).map((column) =>
      fieldOf(column, this.config.idColumn),
    )
  }

  async read(
    ids: readonly string[],
    fields: readonly string[],
    signal?: AbortSignal,
  ): Promise<TargetRead> {
    const unique = [...new Set(ids)]
    const unsafe = unique.filter((id) => !isNeuronId(id))
    if (unsafe.length > 0) {
      throw new SeaTableError(
        `${unsafe.length} id${unsafe.length === 1 ? '' : 's'} cannot be looked up as they are ` +
          `(${unsafe.slice(0, 3).join(', ')}). Ids must be given without a dataset prefix.`,
      )
    }
    const rows = await this.rowsWhere(this.config.idColumn, unique, fields, signal)
    return readOf(
      unique,
      rows.flatMap(({ key, id, values }) => (id === null ? [] : [{ key, id, values }])),
    )
  }

  async write(
    changes: readonly TargetChange[],
    signal?: AbortSignal,
  ): Promise<TargetWriteResult> {
    return checkedWrite(
      changes,
      await this.fields(signal),
      {
        batch: ROWS_PER_UPDATE,
        reread: async (keys, names, s) => {
          const unsafe = keys.filter((key) => !SAFE_KEY.test(key))
          if (unsafe.length > 0) throw new SeaTableError(`Not a row key: ${unsafe[0]}`)
          const rows = await this.rowsWhere('_id', keys, names, s)
          return new Map(rows.map((row) => [row.key, row.values]))
        },
        send: (rows, s) =>
          this.updateRows(
            [...rows].map(([row_id, row]) => ({ row_id, row })),
            s,
          ),
      },
      signal,
    )
  }

  // -------------------------------------------------------------------------

  private base(signal?: AbortSignal): Promise<BaseAccess> {
    if (Date.now() - this.baseAt > ACCESS_MAX_AGE_MS) {
      this.baseMemo.delete('base')
      this.baseAt = Date.now()
    }
    const { host, workspace, base } = this.config
    const shared = memoPromise(this.baseMemo, 'base', () => openBase(host, workspace, base), {
      keep: 'resolved',
    })
    return untilAborted(shared, signal)
  }

  private tableColumns(signal?: AbortSignal): Promise<SeaTableColumn[]> {
    const { base, table, idColumn } = this.config
    const shared = memoPromise(
      this.columnsMemo,
      'columns',
      async () => {
        const tables = await readMetadataWith(await this.base())
        const found = tableNamed(tables, base, table)
        if (!found.columns.some((c) => c.name === idColumn)) {
          throw new SeaTableError(`"${table}" has no column "${idColumn}".`)
        }
        return found.columns
      },
      { keep: 'resolved' },
    )
    return untilAborted(shared, signal)
  }

  /**
   * Every row whose `column` holds one of `values`, with the named fields — the one query both a
   * read (by id) and the check before a write (by `_id`) make. Values must already be safe to
   * splice; the caller says what safe means for its column.
   */
  private async rowsWhere(
    column: string,
    values: readonly string[],
    fields: readonly string[],
    signal?: AbortSignal,
  ): Promise<Row[]> {
    const all = await this.tableColumns(signal)
    const byName = new Map(all.map((c) => [c.name, c]))
    const unknown = fields.filter((name) => !byName.has(name))
    if (unknown.length > 0) {
      throw new SeaTableError(
        `"${this.config.table}" has no column ${unknown.map((n) => `"${n}"`).join(', ')}.`,
      )
    }
    const columns = fields.map((name) => byName.get(name)!)
    const { idColumn } = this.config
    const rows: Row[] = []
    for (let at = 0; at < values.length; at += VALUES_PER_QUERY) {
      const chunk = values.slice(at, at + VALUES_PER_QUERY)
      const answered = await this.select(
        ['_id', idColumn, ...fields],
        `${quoteName(column)} IN (${chunk.map((v) => `'${v}'`).join(', ')})`,
        signal,
      )
      for (const row of answered) {
        rows.push({
          key: String(row._id),
          id: idText(row[idColumn] as string | number | null | undefined),
          values: Object.fromEntries(columns.map((c) => [c.name, valueOf(row[c.name], c)])),
        })
      }
    }
    return rows
  }

  private async select(
    columns: readonly string[],
    where: string,
    signal?: AbortSignal,
  ): Promise<Array<Record<string, unknown>>> {
    const access = await this.base(signal)
    const sql =
      `SELECT ${[...new Set(columns)].map(quoteName).join(', ')} ` +
      `FROM ${quoteName(this.config.table)} WHERE ${where} LIMIT ${ROW_LIMIT}`
    const url = access.use_api_gateway
      ? `${this.config.host}/api-gateway/api/v2/dtables/${access.dtable_uuid}/sql`
      : `${access.dtable_db ?? `${this.config.host}/dtable-db`}/api/v1/query/${access.dtable_uuid}/`
    const reply = await request<{
      success?: boolean
      error_message?: string
      results?: unknown
    }>(url, access.access_token, {
      signal,
      body: { method: 'POST', json: { sql, convert_keys: true } },
    })
    if (reply.success === false || !Array.isArray(reply.results)) {
      throw new SeaTableError(
        `SeaTable refused the query: ${reply.error_message ?? 'no reason given'}`,
      )
    }
    if (reply.results.length >= ROW_LIMIT) {
      throw new SeaTableError(
        `More than ${ROW_LIMIT.toLocaleString()} rows matched one lookup, which is more than ` +
          `Coda reads at once. Check that the id column is the one you mean.`,
      )
    }
    return reply.results as Array<Record<string, unknown>>
  }

  private async updateRows(
    updates: ReadonlyArray<{ row_id: string; row: Readonly<Record<string, FieldValue>> }>,
    signal?: AbortSignal,
  ): Promise<void> {
    const access = await this.base(signal)
    const url = access.use_api_gateway
      ? `${this.config.host}/api-gateway/api/v2/dtables/${access.dtable_uuid}/rows/`
      : `${access.dtable_server}/api/v1/dtables/${access.dtable_uuid}/batch-update-rows/`
    const reply = await request<{ success?: boolean; error_message?: string }>(
      url,
      access.access_token,
      {
        signal,
        body: { method: 'PUT', json: { table_name: this.config.table, updates } },
        write: true,
      },
    )
    if (reply.success === false) {
      throw new SeaTableError(
        `SeaTable refused the update: ${reply.error_message ?? 'no reason given'}`,
      )
    }
  }
}

/** A column name as SQL names it; one with a backtick in it is refused rather than escaped. */
function quoteName(name: string): string {
  if (name.includes('`'))
    throw new SeaTableError(`A column name cannot contain a backtick: ${name}`)
  return `\`${name}\``
}

/** Why a column is not edited here, or undefined where it is. */
function readOnlyReason(column: SeaTableColumn, idColumn: string): string | undefined {
  if (column.name === idColumn) return 'the id column'
  if (column.name.startsWith('_')) return 'kept by SeaTable'
  if (!EDITABLE[column.type]) return `a ${column.type} column`
  if (column.editable === false) return 'locked in the base'
  return undefined
}

function fieldOf(column: SeaTableColumn, idColumn: string): TargetField {
  const readOnly = readOnlyReason(column, idColumn)
  return {
    name: column.name,
    kind: EDITABLE[column.type] ?? 'text',
    ...(column.options ? { options: column.options } : {}),
    ...(withTime(column) ? { withTime: true } : {}),
    ...(readOnly ? { readOnly } : {}),
  }
}

/** Whether a date column keeps a time, by its display format. */
function withTime(column: SeaTableColumn): boolean {
  return column.type === 'date' && /H/.test(column.format ?? '')
}

/** A cell as SQL returned it, in the shape the field edits. */
function valueOf(value: unknown, column: SeaTableColumn): FieldValue {
  switch (EDITABLE[column.type]) {
    case 'date':
      return typeof value === 'string' && value ? wallClock(value, withTime(column)) : null
    case 'bool':
      return value === true
    case 'number': {
      if (value === null || value === undefined || value === '') return null
      const n = Number(value)
      return Number.isFinite(n) ? n : null
    }
    case 'choices':
      return Array.isArray(value) ? value.map(String) : value == null ? null : [String(value)]
    default: {
      // A text column's cell is text, whatever SQL typed it.
      const cell = cellOf(value)
      return cell === null || Array.isArray(cell) ? cell : String(cell)
    }
  }
}
