/**
 * Link Table — a Parquet or Feather file, local or at a URL, opened without being loaded.
 *
 * What it emits is a *handle*: the file's columns, its size and a fingerprint, as a `tableFile`
 * value that no ordinary table node accepts (`types.ts` says why). Read Rows pulls rows out of it,
 * and the Custom Dataset reads synapses and edges from it a block at a time. Opening costs the
 * file's footer — a few small reads whatever the file's size — which is why this is `cheap`: a new
 * URL shows its columns in every picker below it before anybody presses Run.
 *
 * ## A local file stays on disk
 *
 * The card hands the picked file to `data/files/registry.ts` and writes its id and name here; the
 * bytes never enter the graph. Chromium remembers the file across a reload through the handle it
 * was chosen with — at most asking for a click to read it again — and anywhere else the card asks
 * for it again by name, the state `Upload Table` meets for a graph opened on another machine. A
 * URL has none of this: it travels with the graph, and anybody who can reach it can open it.
 *
 * ## The id columns
 *
 * `Detect id columns` is the rule in `data/files/columns.ts` — a 64-bit column is read as text
 * when its name says it is an id or its statistics say no number could hold it — and unticking it
 * hands the choice to `Read as text`, exactly. Both reach the provenance key, since they change
 * the type of a column and therefore what every node below receives.
 */

import type { NodeHint } from '../../core/graph'
import { registerNode } from '../../core/registry'
import type { ParamValues } from '../../core/node'
import { refreshParam } from '../../core/node'
import type { TableSchema } from '../../core/types'
import { T } from '../../core/types'
import type { TableFileRef, TableFileValue } from '../../core/values'
import type { FileSummary } from '../../data/files/columns'
import {
  fileTableSchema,
  indexableSchema,
  int64Schema,
  textColumnsFor,
} from '../../data/files/columns'
import {
  localFileProblem,
  peekTableFile,
  readTableFileSummary,
  remembersLocalFiles,
  restoreLocalFile,
} from '../../data/files/registry'
import { rawFileUrl } from '../../data/rawFileUrl'

/** Where a node's file is, or undefined while it names none. A chosen local file wins a URL. */
export function tableFileRef(params: ParamValues): TableFileRef | undefined {
  const id = String(params.fileId).trim()
  if (id) return { kind: 'local', id, name: String(params.fileName) }
  const url = String(params.url).trim()
  return url ? { kind: 'url', url: rawFileUrl(url) } : undefined
}

/** The Firefox and Safari caveat, as a constant so asking allocates nothing. */
const FORGETS_LOCAL_FILES: readonly NodeHint[] = [
  {
    text:
      'This browser cannot keep a local file across a reload: after one, choose the file ' +
      'again. Chrome and Edge remember it, and a URL works in every browser.',
  },
]
const NO_HINTS: readonly NodeHint[] = []

/**
 * Where the node's file is and what is known of its footer, synchronously — the one peek every
 * reader of the node asks (inference, `validate`, the pickers, the card), which for a URL nobody
 * has read yet also starts the read.
 */
export function peekEntry(params: ParamValues) {
  const ref = tableFileRef(params)
  return { ref, entry: ref && peekTableFile(ref, Number(params.refresh)) }
}

/**
 * Why the node cannot read its file at all, or undefined — one sentence each for `validate` and
 * `evaluate`; the card draws the local states itself and shares `localFileProblem`'s sentence.
 */
export function refProblem(ref: TableFileRef | undefined): string | undefined {
  if (!ref) return NOTHING_CHOSEN
  return ref.kind === 'local' ? localFileProblem(ref.id, ref.name) : undefined
}

/**
 * The schema the node publishes: the file's columns, typed under its two id-column controls. One
 * statement for inference, `evaluate` and the card, which lists the same columns.
 */
export function tableFileSchema(
  summary: FileSummary,
  params: ParamValues,
  columns: (paramId: string) => string[],
): TableSchema {
  return fileTableSchema(
    summary,
    textColumnsFor(summary, params.autoText !== false, columns('textColumns')),
  )
}

const NOTHING_CHOSEN =
  'Choose a Parquet or Feather file, or paste a URL to one or to the folder of a Delta table.'

registerNode({
  type: 'core.linkTable',
  label: 'Link Table',
  category: 'utility',
  cardWidth: 300,
  description:
    'Link a large Parquet, Feather or Delta table, on disk or at a URL, without loading it. Read Rows pulls out the rows you need.',
  guide:
    'Links a large Parquet, Feather or Delta table, on disk or at a URL, without loading it: ' +
    'only the footer is read, so its columns show up downstream straight away. Wire it into ' +
    'Read Rows to pull out the rows you need, e.g. the synapses of a few neurons.',
  cost: 'cheap',
  inputs: [],
  outputs: [{ id: 'file', label: 'Table file', type: T.tableFile() }],
  params: [
    // Written by the card, never typed; in the inspector because it is the only place the file
    // behind a card can be seen.
    { id: 'fileId', kind: 'string', label: 'File', default: '', advanced: true },
    {
      id: 'fileName',
      kind: 'string',
      label: 'File name',
      default: '',
      advanced: true,
      // `fileId` decides what is read; the name is for saying which file to pick again.
      presentational: true,
      browserStored: 'a local table file',
    },
    {
      id: 'url',
      kind: 'string',
      label: 'URL',
      placeholder: 'https://… or gs://…/table.parquet',
      help: 'A Parquet or Feather file, or a Delta table folder, on a server that allows cross-origin range requests (public gs:// buckets do). Ignored while a local file is chosen.',
      default: '',
    },
    {
      id: 'autoText',
      kind: 'boolean',
      label: 'Detect id columns',
      help: 'Read a 64-bit column as text when its name says it is an id (root_id, bodyId, pre_pt_root_id) or its values are too large for a number. Untick to choose them yourself.',
      default: true,
      advanced: true,
    },
    {
      id: 'textColumns',
      kind: 'columns',
      label: 'Read as text',
      help: 'The 64-bit columns to read as text. Ids must be text, or eighteen-digit ones are rounded into different neurons.',
      // No input port: the choices are the file's own 64-bit columns, out of its footer.
      from: '',
      schemaFrom: (_inputs, params) => {
        const summary = peekEntry(params).entry?.summary
        return summary && int64Schema(summary)
      },
      default: [],
      advanced: true,
      visibleIf: (params) => params.autoText === false,
    },
    /*
     * Not presentational, though it changes no answer: it has to reach the readers below on the
     * value, and it is on the value, so it is in the key. Ticking one re-runs the lookups below
     * once — which is exactly when the index is built.
     */
    {
      id: 'indexColumns',
      kind: 'columns',
      label: 'Index columns',
      help: 'Columns you look ids up in. The first lookup records each block’s id range so later lookups can skip blocks. Only helps if the file is sorted or grouped by the column.',
      from: '',
      schemaFrom: (_inputs, params) => {
        const summary = peekEntry(params).entry?.summary
        return summary && indexableSchema(summary)
      },
      default: [],
      advanced: true,
    },
    refreshParam(
      'Reads the file’s footer again. A file rewritten since it was opened is refused by every reader until then.',
    ),
  ],

  // Only for a local file: a URL survives a reload in every browser.
  readerHints: (params) =>
    tableFileRef(params)?.kind === 'local' && !remembersLocalFiles()
      ? FORGETS_LOCAL_FILES
      : NO_HINTS,

  inferOutputs: (ctx) => {
    const summary = peekEntry(ctx.params).entry?.summary
    return { file: T.tableFile(summary && tableFileSchema(summary, ctx.params, ctx.columns)) }
  },

  validate: (ctx) => {
    const { ref, entry } = peekEntry(ctx.params)
    const problem = refProblem(ref)
    if (problem) return [problem]
    if (entry?.error) return [entry.error]
    const summary = entry?.summary
    if (!summary) return []
    const issues: string[] = []
    if (summary.format === 'feather' && ctx.columns('indexColumns').length === 0) {
      issues.push(
        'Feather keeps no statistics, so every id lookup reads the whole file. Pick the id ' +
          'column in `Index columns` so the first lookup records where each id is, or save the ' +
          'file as Parquet sorted by that column.',
      )
    }
    if (summary.skipped.length) {
      issues.push(
        `Left out ${summary.skipped.length === 1 ? 'a column' : `${summary.skipped.length} columns`} ` +
          `whose type Coda cannot read (lists, structs, maps): ${summary.skipped.join(', ')}.`,
      )
    }
    return issues
  },

  evaluate: async (ctx) => {
    const ref = tableFileRef(ctx.params)
    // A remembered file still being looked for is waited on, not reported missing.
    if (ref?.kind === 'local') await restoreLocalFile(ref.id)
    const problem = refProblem(ref)
    if (!ref || problem) throw new Error(problem)
    ctx.progress(0.1, 'reading the footer')
    // The footer already read under this refresh nonce, where there is one: a change to how the
    // columns are typed re-keys this node without the file having changed.
    const summary = await readTableFileSummary(ref, {
      refresh: Number(ctx.params.refresh),
      signal: ctx.signal,
    })
    const file: TableFileValue = {
      kind: 'tableFile',
      ref,
      format: summary.format,
      ...(summary.version === undefined ? {} : { version: summary.version }),
      schema: tableFileSchema(summary, ctx.params, ctx.columns),
      columns: summary.columns,
      rows: summary.rows,
      blocks: summary.blocks,
      bytes: summary.bytes,
      fingerprint: summary.fingerprint,
      indexColumns: ctx.columns('indexColumns'),
    }
    return { file }
  },
})
