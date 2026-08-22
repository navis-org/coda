/**
 * Bring an annotation table's root ids up to a materialization.
 *
 * A CAVE root id is retired by any proofreading edit that touches its segment, so an annotation
 * base — somebody's spreadsheet, edited on its own schedule — drifts out of step with a pinned
 * materialization on its own. Nothing fails when it does: the labels stop matching, those rows
 * join to nothing, and the dataset reads as under-annotated. The Dataset node warns about it;
 * this is the repair.
 *
 * **A supervoxel is what makes the repair possible.** It is the atom of the segmentation —
 * proofreading regroups supervoxels, it does not split them — so a supervoxel id is the stable
 * handle a root id is not. Given one, the chunkedgraph can say which segment it belonged to at
 * any instant, which is exactly the question a stale row asks.
 *
 * **The staleness check runs first, and that is the whole of the cost control.** Only rows whose
 * root is *not* current at the materialization are looked up, so an unedited base costs one
 * `is_latest_roots` pass and no `get_roots` at all — and both answers are cached permanently,
 * because what a root or a supervoxel was at a *past* instant never changes.
 *
 * The Dataset input is a **reference**: it names the datastack rather than consuming a dataset,
 * which is what lets this node sit between an annotation source and the dataset it feeds without
 * that being a cycle. See `PortDef.reference`.
 */

import { registerNode } from '../../core/registry'
import { T, isTabular, schemaOf } from '../../core/types'
import { idText } from '../../core/ids'
import type { CellValue, ColumnData } from '../../core/values'
import { isTableValue, makeTable } from '../../core/values'
import { rootsForSupervoxels, staleRoots } from '../../data/cave/rootIds'

export const updateRootIdsNode = registerNode({
  type: 'cave.updateRootIds',
  label: 'Update root IDs',
  category: 'transform',
  description: 'Repoint stale CAVE root ids at a materialization, using their supervoxel ids.',
  guide:
    'A CAVE root id changes whenever proofreading touches its segment, so an annotation base ' +
    'drifts out of step with a pinned materialization and its rows quietly stop matching any ' +
    'neuron. Given a supervoxel id — the stable handle a root id is not — this looks up what ' +
    'each stale row’s segment became and rewrites the id. Rows that were already current are ' +
    'left alone and cost nothing, and every answer is cached permanently, because what a ' +
    'supervoxel belonged to at a past instant never changes.',
  cost: 'expensive',
  dataCache: true,
  inputs: [
    { id: 'in', label: 'Table', type: T.table() },
    /*
     * A reference: it names the datastack whose chunkedgraph answers, and takes no value. That is
     * what lets this node sit between an annotation source and the dataset it feeds — wired as an
     * ordinary input, `Dataset → Update → Dataset` is two edges between one pair in opposite
     * directions and `topoSort` reads it as a cycle.
     */
    { id: 'dataset', label: 'Dataset', type: T.dataset(), reference: true },
  ],
  outputs: [{ id: 'out', label: 'Table', type: T.table() }],
  params: [
    {
      id: 'idColumn',
      kind: 'column',
      label: 'ID column',
      from: 'in',
      help: 'The root id column to bring up to date.',
      default: 'neuronId',
    },
    {
      id: 'supervoxelColumn',
      kind: 'column',
      label: 'Supervoxel ID column',
      from: 'in',
      help: 'The supervoxel each row was annotated at. This is what a stale root id is recovered from, so a row without one is left alone.',
      /*
       * A named default rather than `''`, and the difference is whether this node can run on the
       * first press of a fresh session.
       *
       * An empty default means "the first compatible column", which is an answer computed from
       * the schema — so before one has arrived there is none, and `evaluate` refused over a
       * picker the card was drawing as filled in. It also means the fallback is *literally the
       * table's first column*, which happened to be right on FlyWire's published annotations and
       * is a guess with nothing behind it anywhere else.
       *
       * `supervoxel_id` is what that file and CAVE's own annotation tables call it (CAVE spells
       * a bound point's as `pt_supervoxel_id`, which the fallback still reaches). Being a
       * declared default it stays a suggestion: a table without the column falls back exactly as
       * before, and `validateColumnParams` reports no drift for it.
       */
      default: 'supervoxel_id',
    },
    {
      id: 'version',
      kind: 'string',
      label: 'Materialization',
      placeholder: 'the dataset’s',
      help: 'Which materialization to bring the ids up to. Empty uses the one the wired Dataset is pinned to, which is nearly always what you want.',
      default: '',
      advanced: true,
    },
  ],

  // Schema and kind straight through: this rewrites values in one column and touches nothing else.
  inferOutputs: (ctx) => {
    const input = ctx.inputs.in
    if (!isTabular(input)) return { out: T.table() }
    return {
      out: input.kind === 'neurons' ? T.neurons(schemaOf(input)) : T.table(schemaOf(input)),
    }
  },

  validate: (ctx) => {
    if (!ctx.column('supervoxelColumn')) {
      return [
        'Pick the column holding each row’s supervoxel id — the ids cannot be updated without it',
      ]
    }
    const version = String(ctx.params.version ?? '').trim()
    if (version && !Number.isInteger(Number(version))) {
      return [`"${version}" is not a materialization number — CAVE numbers them, e.g. 783`]
    }
    return []
  },

  evaluate: async (ctx) => {
    const table = ctx.input('in')
    if (!isTableValue(table)) throw new Error('Input is not a table')

    // The reference hands over a `DatasetValue` built from the type — an identity and nothing
    // else, which is all this needs. See `PortDef.reference`.
    const dataset = ctx.input('dataset')
    if (dataset?.kind !== 'dataset') {
      throw new Error('Wire a CAVE Dataset, so the ids can be looked up somewhere')
    }
    const [datastack, pinned] = dataset.datasetId.split(':')
    const chosen = String(ctx.params.version ?? '').trim() || pinned
    const version = Number(chosen)
    if (!datastack || !Number.isInteger(version)) {
      throw new Error(`Cannot read a materialization out of "${dataset.datasetId}"`)
    }

    const idColumn = ctx.column('idColumn')
    const svColumn = ctx.column('supervoxelColumn')
    if (!idColumn || !svColumn) throw new Error('Pick an ID column and a supervoxel ID column')
    const ids = table.data[idColumn]
    const svs = table.data[svColumn]
    if (!ids || !svs) throw new Error(`"${idColumn}" or "${svColumn}" is not in this table`)

    ctx.progress(0.1, 'checking which ids moved')
    const options = ctx.signal ? { signal: ctx.signal } : {}
    /*
     * Only the rows that actually moved are looked up. On an unedited base this is one
     * `is_latest_roots` pass and no `get_roots` at all — and both answers are cached forever,
     * since what a root or a supervoxel was at a past instant cannot change.
     */
    const present = [...new Set(textOf(ids))]
    const stale = await staleRoots(datastack, version, present, options)
    if (stale.size === 0) return { out: table }

    ctx.progress(0.5, `${stale.size.toLocaleString()} to update`)
    const needed: string[] = []
    for (let i = 0; i < table.length; i++) {
      const id = idText(ids[i] ?? null)
      const sv = idText(svs[i] ?? null)
      if (id && sv && stale.has(id)) needed.push(sv)
    }
    const roots = await rootsForSupervoxels(datastack, version, needed, options)

    const updated: ColumnData = new Array(table.length)
    const numeric = typeof ids[0] === 'number'
    for (let i = 0; i < table.length; i++) {
      const original = ids[i] ?? null
      const id = idText(original)
      const sv = idText(svs[i] ?? null)
      const root = id && sv && stale.has(id) ? roots.get(sv) : undefined
      /*
       * The replacement keeps the column's own storage. A CAVE id column is `str` and stays text,
       * which is what invariant 8 requires of an eighteen-digit id; a table that happens to hold
       * them as numbers keeps doing so rather than changing dtype under everything downstream —
       * and `idText` refuses a number too wide to be exact, so nothing silently rounds.
       */
      updated[i] = root === undefined ? original : numeric ? (Number(root) as CellValue) : root
    }
    return { out: makeTable(table.schema, { ...table.data, [idColumn]: updated }, table.kind) }
  },
})

/** Every cell of an id column as text, skipping what is not an id. */
function textOf(column: ColumnData): string[] {
  const out: string[] = []
  for (const cell of column) {
    const id = idText(cell ?? null)
    if (id) out.push(id)
  }
  return out
}
