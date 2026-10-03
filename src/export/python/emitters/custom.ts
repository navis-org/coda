/**
 * The Custom Dataset and the parts it is assembled from: a table file, a precomputed bucket, and
 * the dataset itself.
 *
 * Each binds an object from `customHelpers.ts` rather than reading anything, which is the canvas'
 * own arrangement: Link Table reads a footer and Custom Dataset reads nothing, so the questions
 * below them are what pay — a `CodaTableFile` is read by the columns and ids a lookup names, and a
 * `CodaCustomDataset` answers each question from the part wired for it. The query emitters branch
 * onto those objects where the dataset is custom (`isCustomDataset`), so a Find Neurons or a
 * Connectivity cell below one reads like the neuPrint cell it replaces.
 */

import { parseNgSource, PRECOMPUTED } from '../../../data/neuroglancer/sourceUrl'
import { objectStoreUrl } from '../../../data/precomputed/transport'
import { peekEntry, tableFileRef, tableFileSchema } from '../../../nodes/table/linkTable'
import { formatByName } from '../../../data/files/registry'
import { parseIdList } from '../../../nodes/lib/idList'
import { pickIdColumn } from '../../../nodes/table/readRows'
import {
  NOTHING_WIRED,
  PICK_ID_COLUMN,
  edgeColumnsOf,
  synapseColumnsOf,
} from '../../../packs/connectome/customDataset'
import { pyList, pyStr } from '../py'
import { registerEmitter } from '../registry'
import { datasetBackend, pySelection } from './common'
import { CUSTOM_SOURCE_ID } from '../../../data/custom/layout'
import { geometryCall } from './query'
import { backendName } from '../../../nodes/lib/datasetFamilies'

// ---------------------------------------------------------------------------
// Link Table and Read Rows
// ---------------------------------------------------------------------------

/**
 * Link Table: a `CodaTableFile` naming the file, its format and the columns read as text.
 *
 * The format and the text columns come from the footer — or a Delta table's log — the canvas
 * already read (`peekEntry`, which inference has asked on this same export), so a Feather file is
 * opened as Feather and an id column Coda reads as text is text here too — invariant 8 at a seam
 * the notebook would otherwise hand pyarrow's `int64`. A Delta table carries the `version` that
 * read saw, so the notebook reads the table the workflow was built on (through delta-rs, required
 * only here). Before anything has landed the name decides the format (`formatByName`), nothing is
 * cast and no version is pinned, which the cell says.
 */
registerEmitter('core.linkTable', (ctx) => {
  const ref = tableFileRef(ctx.params)
  if (!ref) return ctx.todo('This Link Table names no file.')
  ctx.helper('CodaTableFile')
  const out = ctx.output('file')
  const summary = peekEntry(ctx.params).entry?.summary
  // What the canvas read it as, and what its name says before a footer or a log has landed.
  const format = summary?.format ?? formatByName(ref)
  // A Delta table by the URI delta-rs takes (`gs://`, `s3://`); a file by one pyarrow can open.
  const location =
    ref.kind === 'local'
      ? ref.name
      : format === 'delta'
        ? ref.url.trim().replace(/\/+$/, '')
        : (objectStoreUrl(ref.url) ?? ref.url)
  if (format === 'delta') ctx.require('deltalake', 'DeltaTable', 'QueryBuilder')
  const text = summary
    ? tableFileSchema(summary, ctx.params, ctx.columns)
        .columns.filter((c) => c.dtype === 'str')
        .map((c) => c.name)
    : []
  return [
    ...(ref.kind === 'local'
      ? ctx.note(
          `This file was on the computer of whoever built this workflow. ` +
            `Set the path to your own copy of ${ref.name || 'it'}.`,
        )
      : []),
    ...(summary
      ? []
      : ctx.note(
          `The canvas had not read this ${format === 'delta' ? 'table’s log' : 'file’s footer'} at ` +
            'export, so only integer columns whose names say they hold ids are read as text, ' +
            'as Coda does. Add any other id column to text_columns, because an eighteen-digit ' +
            'id read as a number becomes a different neuron.' +
            (format === 'delta'
              ? ' No version is pinned either, so this reads the table as it is when the cell runs.'
              : ''),
        )),
    ...(format === 'feather'
      ? ctx.note(
          'Feather keeps no statistics, so every id lookup reads the whole file. Save the ' +
            'file as Parquet sorted by the id column so a lookup reads only part of it.',
        )
      : []),
    `${out} = CodaTableFile(`,
    `    ${pyStr(location)},`,
    `    format=${pyStr(format)},`,
    // Whenever the footer was read, even empty: an empty list is the canvas' answer, where no list
    // at all hands the choice to the name rule — reading as text an id column somebody declined.
    ...(summary ? [`    text_columns=${pyList(text)},`] : []),
    // The version the canvas read, so the notebook reads the table the workflow was built on.
    ...(summary?.version === undefined ? [] : [`    version=${summary.version},`]),
    `)`,
  ]
})

/**
 * Read Rows: `CodaTableFile.read` with the node's columns, match and cap. A match column with no
 * ids reads nothing, the node's rule, which the helper keeps (an empty id list is an empty frame).
 */
registerEmitter('core.readRows', (ctx) => {
  const file = ctx.wired('file')
  const out = ctx.output('out')
  const columns = ctx.columns('columns')
  const matching = ctx.column('matchColumn')
  const lines: string[] = []
  const args = [`columns=${columns.length > 0 ? pyList(columns) : 'None'}`]
  if (matching) {
    const typed = parseIdList(ctx.params.ids)
    if (typed.error) return ctx.todo(`The typed id list is not valid: ${typed.error}`)
    const wired = ctx.input('ids')
    const idColumn = ctx.column('idColumn')
    // The card refuses a wired table it cannot read ids from, rather than looking up none.
    if (wired && !idColumn) return ctx.todo(pickIdColumn([]))
    lines.push(`_ids = ${pySelection(typed.ids)}`)
    if (wired && idColumn) lines.push(`_ids += ${wired}[${pyStr(idColumn)}].dropna().tolist()`)
    args.push(`where={${pyStr(matching)}: _ids}`)
  }
  // One row past the cap, so the cell can say what the card says: that rows were left unread.
  const limit = Math.max(1, Number(ctx.params.limit))
  args.push(`limit=${limit + 1}`)
  return [
    ...lines,
    `${out} = ${file}.read(`,
    ...args.map((a) => `    ${a},`),
    `)`,
    `if len(${out}) > ${limit}:`,
    `    print('Stopped at the row cap of ${limit.toLocaleString('en-US')} with more rows left to read. '`,
    `          'Raise the cap, match fewer ids, or filter the table upstream.')`,
    `    ${out} = ${out}.head(${limit})`,
  ]
})

// ---------------------------------------------------------------------------
// Neuroglancer Source
// ---------------------------------------------------------------------------

/**
 * A precomputed bucket, as a `CodaPrecomputed` — the Datasource port. The Layers port is a
 * neuroglancer layer, which has no notebook form; it is bound to `None` so that the rest of the
 * cell binds at all, and the viewer below it says what it cannot do.
 */
registerEmitter('dataset.ngsource', (ctx) => {
  const text = String(ctx.params.url).trim()
  const ref = parseNgSource(text)
  if (!ref) return ctx.todo('This Neuroglancer Source names no source URL.')
  if (ref.scheme !== PRECOMPUTED) {
    return ctx.todo(`Coda reads precomputed sources; this one is ${ref.scheme}.`)
  }
  ctx.helper('CodaPrecomputed')
  return [
    `${ctx.output('dataset')} = CodaPrecomputed(${pyStr(ref.canonical)})`,
    ...ctx.note('Neuroglancer layers cannot be exported to a notebook, so `Layers` is None.'),
    `${ctx.output('layers')} = None`,
  ]
})

// ---------------------------------------------------------------------------
// Custom Dataset
// ---------------------------------------------------------------------------

/**
 * The dataset: its parts, each with the columns the card was told to read. Every refusal is the
 * node's own sentence, through the node's own readers (`edgeColumnsOf`, `synapseColumnsOf`), so
 * a cell is written only for a card that would run.
 */
registerEmitter(
  'connectome:customDataset',
  (ctx) => {
    const neurons = ctx.input('neurons')
    const edges = ctx.input('edges')
    const synapses = ctx.input('synapses')
    const meshes = ctx.input('meshes')
    const skeletons = ctx.input('skeletons')
    if (!neurons && !edges && !synapses && !meshes && !skeletons) return ctx.todo(NOTHING_WIRED)

    const args: string[] = []
    if (neurons) {
      const idColumn = ctx.column('idColumn')
      if (!idColumn) return ctx.todo(PICK_ID_COLUMN)
      args.push(`neurons=${neurons},`, `id_column=${pyStr(idColumn)},`)
    }
    if (edges) {
      const { columns, problems, refusal } = edgeColumnsOf(ctx)
      if (!columns) return ctx.todo(refusal ?? problems[0]!)
      args.push(
        `edges={`,
        `    'source': ${edges},`,
        `    'pre': ${pyStr(columns.pre)},`,
        `    'post': ${pyStr(columns.post)},`,
        // No weight column counts rows, as on the canvas.
        `    'weight': ${columns.weight ? pyStr(columns.weight) : 'None'},`,
        `},`,
      )
    }
    if (synapses) {
      const { columns, problems } = synapseColumnsOf(ctx)
      if (!columns) return ctx.todo(problems[0]!)
      args.push(
        `synapses={`,
        `    'source': ${synapses},`,
        `    'pre': ${pyStr(columns.pre)},`,
        `    'post': ${pyStr(columns.post)},`,
        `    'position': ${pyList([columns.x, columns.y, columns.z])},`,
        `    'voxel': [${columns.voxel.join(', ')}],`,
        `    'carry': ${pyList(columns.carry)},`,
        `},`,
      )
    }
    const notes: string[] = []
    for (const kind of ['meshes', 'skeletons'] as const) {
      const lender = ctx.input(kind)
      if (!lender) continue
      const call = geometryCall(ctx, kind, 'ids', lender, kind)
      if (call) args.push(`${kind}=lambda ids: ${call},`)
      else {
        notes.push(
          ...ctx.note(
            `The notebook has no way to fetch ${kind} from the ` +
              `${backendName(datasetBackend(ctx, kind))} dataset wired into ` +
              `\`${kind === 'meshes' ? 'Meshes' : 'Skeletons'}\`, so this dataset holds none. ` +
              `Fetch them with that dataset's own client.`,
          ),
        )
      }
    }

    ctx.helper('CodaCustomDataset')
    const out = ctx.output('dataset')
    return [...notes, `${out} = CodaCustomDataset(`, ...args.map((a) => `    ${a}`), `)`]
  },
  // Any dataset may lend it geometry: which ones have a route is `geometryCall`'s, per socket, so
  // a lender without one costs a note on that socket rather than the whole dataset.
  { backends: ['neuprint', 'cave', 'precomputed', CUSTOM_SOURCE_ID] },
)
