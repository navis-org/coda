/**
 * Read Rows — the rows of a table file somebody actually wants, as an ordinary table.
 *
 * The one place a `tableFile` becomes a `table`, and it is a step taken on purpose: whatever this
 * keeps is in memory from here on, and every table op below can have it. Three things narrow it,
 * in the order they cost: which **columns** (only those are decoded, and in Parquet only those are
 * read), a **match** on one column against a set of ids (in a Parquet file sorted by that column,
 * whole row groups are skipped without being read), and a **row cap**.
 *
 * `expensive`, because it reads data where the file node reads a footer — a lookup in a
 * multi-gigabyte file is a real wait, spent in a worker with Cancel working throughout.
 *
 * ## Empty is empty
 *
 * A match column with no ids reads nothing, never everything — Input IDs' rule, for Input IDs'
 * reason: an unconfigured card that pulled a five-gigabyte table into the tab would be the worst
 * default available. With no match column at all, `Row cap` is what bounds the read — a million
 * rows from the file's start, said on the card when it stopped short.
 */

import { registerNode } from '../../core/registry'
import type { TableSchema } from '../../core/types'
import { T, attributeSchema, findColumn } from '../../core/types'
import type { TableFileValue } from '../../core/values'
import { isTableFileValue, isTableValue, makeTable, tableFileBlocks } from '../../core/values'
import { fileColumn } from '../../data/files/columns'
import { readFileRows } from '../../data/files/fileReads'
import type { OutputColumn, ReadRowsRequest } from '../../data/files/read'
import { collectIds, parseIdList } from '../lib/idList'
import { isIdentifierColumn } from '../../core/ids'
import { selectSchema } from '../lib/tableOps'

/** Row groups past which a lookup that skipped none of them is worth a sentence. */
const UNSORTED_WARN_BLOCKS = 4

const DEFAULT_ROW_CAP = 1_000_000

registerNode({
  type: 'core.readRows',
  label: 'Read Rows',
  category: 'utility',
  description:
    'Read rows from a Link Table file: the chosen columns, the rows matching a set of ids, up to a cap.',
  guide:
    'Reads rows from a Link Table file into an ordinary table you can filter, join and plot. ' +
    'Pick the columns to keep and, to look up specific neurons, a match column plus the ids, ' +
    'typed in or wired from a table. With a match column but no ids, nothing is read.',
  cost: 'expensive',
  inputs: [
    { id: 'file', label: 'Table file', type: T.tableFile() },
    { id: 'ids', label: 'IDs', type: T.table(), required: false },
  ],
  outputs: [{ id: 'out', label: 'Table', type: T.table() }],
  params: [
    {
      id: 'columns',
      kind: 'columns',
      label: 'Columns',
      help: 'The columns to keep, in this order. None chosen keeps every column.',
      from: 'file',
      default: [],
    },
    {
      id: 'matchColumn',
      kind: 'column',
      label: 'Match column',
      help: 'Keep only rows whose value here is one of the ids. None keeps every row, up to the cap.',
      from: 'file',
      optional: true,
      default: '',
    },
    {
      id: 'ids',
      kind: 'string',
      label: 'IDs',
      multiline: true,
      placeholder: '720575940621039145\n720575940613052200',
      help: 'The ids to look for, separated by spaces, commas or newlines. Added to any wired ids.',
      default: '',
    },
    {
      id: 'idColumn',
      kind: 'column',
      label: 'ID column',
      help: 'Which column of the wired IDs table holds the ids.',
      from: 'ids',
      optional: true,
      default: 'neuronId',
      whenWired: true,
    },
    {
      id: 'limit',
      kind: 'int',
      label: 'Row cap',
      help: 'Stop after this many rows. The card says when it stopped early.',
      default: DEFAULT_ROW_CAP,
      min: 1,
      advanced: true,
    },
  ],

  inferOutputs: (ctx) => ({
    out: T.table(selectSchema(attributeSchema(ctx.inputs.file), ctx.columns('columns'))),
  }),

  validate: (ctx) => {
    const matching = ctx.column('matchColumn')
    const typed = parseIdList(ctx.params.ids)
    if (typed.error) return [typed.error]
    const anyIds = typed.ids.length > 0 || Boolean(ctx.inputs.ids)
    if (matching && !anyIds) {
      return [
        `There are no ids to look for in "${matching}", so nothing will be read. Type ids into ` +
          `\`IDs\`, or wire a table of them into the \`IDs\` port.`,
      ]
    }
    if (!matching && anyIds) {
      return [
        'IDs are given but `Match column` is empty, so they are not used. Pick the column to match them against.',
      ]
    }
    // Silent while the wired table's columns are unknown: a Pivot upstream publishes none yet.
    const wiredColumns = ctx.schema('ids')?.columns ?? []
    if (matching && wiredColumns.length > 0 && !ctx.column('idColumn'))
      return [pickIdColumn(wiredColumns)]
    return []
  },

  evaluate: async (ctx) => {
    const file = ctx.input('file')
    if (!isTableFileValue(file)) throw new Error('Table file input is not a table file')
    const wired = ctx.input('ids')
    if (wired !== undefined && !isTableValue(wired)) throw new Error('IDs input is not a table')

    const matching = ctx.column('matchColumn')
    let key: ReadRowsRequest['key']
    if (matching) {
      const idColumn = ctx.column('idColumn')
      // A wired table read through no column is no ids at all: an empty answer nobody asked for.
      // Asked of the value, not only of the picker, which keeps its default while the IDs table's
      // columns are unknown — as they are when its upstream reads a file's footer in this same run.
      if (wired && !(idColumn && findColumn(wired.schema, idColumn))) {
        throw new Error(pickIdColumn(wired.schema.columns, idColumn))
      }
      const collected = collectIds({ typed: ctx.params.ids, table: wired, column: idColumn })
      if (collected.error) throw new Error(collected.error)
      if (collected.dropped > 0) {
        ctx.warn(
          `${collected.dropped.toLocaleString()} cells in the IDs table's "${idColumn}" column ` +
            `are not valid ids and were skipped.`,
        )
      }
      key = {
        names: [matching],
        ids: collected.ids,
        // Built by this lookup the first time, and skipped by every time after.
        indexed: file.indexColumns.includes(matching),
      }
    }

    const schema = selectSchema(file.schema, ctx.columns('columns')) ?? file.schema
    const limit = Number(ctx.params.limit)

    // A Filter Table between the Link Table and this node rides on `file`, and is applied to the
    // rows this read fetches (`data/files/filters.ts`).
    const result = await readFileRows(
      file,
      { columns: outputColumns(file, schema), key, limit },
      { signal: ctx.signal, onProgress: ctx.progress },
    )

    if (result.truncated) {
      ctx.warn(
        `Stopped at the row cap of ${limit.toLocaleString()} with more rows left to read. Raise ` +
          `\`Row cap\`, match fewer ids, or filter the table upstream.`,
      )
    }
    /*
     * A lookup that could have skipped blocks and skipped none: the table is not sorted by the
     * column, which no statistics and no index can help. Parquet and a Delta table can always
     * skip; Feather only by its index, and not on the run that builds it — that run reads
     * everything by definition.
     */
    const couldSkip = file.format !== 'feather' || result.index === 'used'
    // Not after the cap stopped it: "Read all" would be false, and beside the cap's own warning
    // the two contradicted each other.
    if (
      matching &&
      couldSkip &&
      !result.truncated &&
      file.blocks >= UNSORTED_WARN_BLOCKS &&
      result.blocksSkipped === 0 &&
      result.blocksRead > 0
    ) {
      const blocks = tableFileBlocks(file.format, file.blocks)
      const what = file.format === 'delta' ? 'table' : 'file'
      ctx.warn(
        `All ${file.blocks.toLocaleString()} ${blocks} were read because none could be skipped, so ` +
          `the ${what} is probably not sorted by "${matching}". Sort it by that column once, and ` +
          `lookups like this one will read only the ${blocks} that hold the ids.`,
      )
    }
    return { out: makeTable(schema, result.data) }
  },
})

/**
 * The sentence asking for the IDs table's column, naming one whose name says it holds ids — the
 * card's and, with no columns in hand, the notebook's.
 */
export function pickIdColumn(columns: readonly { name: string }[], missing?: string): string {
  const guess = columns.find((c) => isIdentifierColumn(c.name))?.name
  return (
    (missing ? `The IDs table has no column "${missing}". ` : '') +
    'Pick the IDs table’s column that holds the ids in `ID column`.' +
    (guess ? ` "${guess}" looks like the right one.` : '')
  )
}

/**
 * Each kept column as the file stores it and as the node reads it — the pair `decoderFor` needs.
 * The storage facts ride on the value, so nothing here goes back to the file to ask.
 */
function outputColumns(file: TableFileValue, schema: TableSchema): OutputColumn[] {
  return schema.columns.map((col) => ({
    column: fileColumn(file.columns, col.name),
    dtype: col.dtype,
  }))
}
