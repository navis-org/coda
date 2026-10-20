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
 * **Live is the latest state as of the last run, and the card's ⟳ is how it moves.** A live run
 * picks one instant and asks both calls about it, then reports that instant through
 * `ctx.reportFetched`, so the foot reads `cached 4m ago ⟳` and the button re-runs at a new one.
 * The instant is deliberately not a param: an update would then be an edit, an undo step and a
 * timestamp in the file somebody else opens, and the provenance key would not need it anyway,
 * since a result is replaced only by ⟳ or by an edit upstream. Live ids are newer than any
 * materialization, so a pinned Dataset fed by them matches fewer neurons than before, not more.
 * That is left to the person wiring it (this is for interactive work: Neuroglancer, meshes,
 * exports) rather than warned about.
 *
 * **The last full hour and the last half hour are live snapped back to a clock boundary**, for an
 * annotation base whose ids are themselves refreshed on that schedule — FlyTable's are, every
 * thirty minutes — so the update lands on the state that base already describes rather than on a
 * minute nobody else's ids match. Snapped in epoch time, which is UTC: the same boundaries locally
 * wherever the offset is a whole hour, and a full hour that falls at :30 in a half-hour zone.
 *
 * **Without a supervoxel, the root's own chunks vote.** `Method: majority` lists a sample of the
 * stale root's level-2 chunks — a retired root id still names what it was made of — asks which
 * root each belonged to at the instant, and takes the root holding most of them. A merge has one
 * answer; a split has several, so the winner's share goes into `idConfidence` and a share under
 * two thirds is said on the card. A choice rather than a per-row fallback, by decision: one run is
 * one route, and the card says which.
 *
 * The Dataset input is a **reference**: it names the datastack rather than consuming a dataset,
 * which is what lets this node sit between an annotation source and the dataset it feeds without
 * that being a cycle. See `PortDef.reference`.
 */

import { packNode } from '../../core/registry'
import type { TableSchema } from '../../core/types'
import { T, column, findColumn, isNumericDType, isTabular, schemaOf } from '../../core/types'
import { idText } from '../../core/ids'
import { listed, namedFew } from '../../core/prose'
import type { CellValue, ColumnData, TableValue } from '../../core/values'
import { isTableValue, makeTable } from '../../core/values'
import type { MajorityRoot, RootsAt } from '../../data/cave/rootIds'
import {
  VOTE_SAMPLE,
  rootsByMajority,
  rootsForSupervoxels,
  staleRoots,
} from '../../data/cave/rootIds'
import { caveTargetOfValue } from '../lib/caveParams'
import { foreignBackend } from '../lib/datasetParam'
import { foldColumns } from '../lib/tableOps'
import { formatNumber, plural } from '../../style/format'

/**
 * The modes that ask about a moment rather than a materialization, and what each rounds "now" down
 * to a multiple of, in ms. One table, read by the dropdown and by `rootsAt`, so a mode cannot be
 * offered without a step — two lists of names was a mode that silently repaired to the Dataset's
 * materialization. Live rounds to the millisecond, which is to say not at all.
 */
const CLOCK_MODES = [
  { value: 'hour', label: 'the last full hour', stepMs: 60 * 60_000 },
  { value: 'halfHour', label: 'the last half hour', stepMs: 30 * 60_000 },
  { value: 'live', label: 'live (as of the last run)', stepMs: 1 },
] as const

/**
 * The column a majority vote adds: the winning root's share of the old root's sampled chunks.
 *
 * Named for the id rather than plain `confidence`, which a synapse table already uses for a
 * predictor's score — a picker offered both would be offered two different measurements under
 * one word. Folded rather than appended, so a second Update root IDs in a chain writes over the
 * first's rather than beside it.
 */
const CONFIDENCE_COLUMN = 'idConfidence'

export const updateRootIdsNode = packNode({
  type: 'cave.updateRootIds',
  label: 'Update root IDs',
  category: 'transform',
  description:
    'Repoint stale CAVE root ids at a materialization or the live segmentation, using their supervoxel ids or a majority vote of their chunks.',
  guide:
    'Brings outdated CAVE root ids in a table up to date with a materialization, or with the ' +
    'live segmentation, using each row’s supervoxel id or, for a table without one, the root ' +
    'that most of the old neuron’s chunks ended up in. Usually sits between an annotation table ' +
    'and the CAVE Dataset it annotates; wire that Dataset into its Dataset input to say which ' +
    'datastack to ask.',
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
      id: 'method',
      kind: 'enum',
      label: 'Method',
      /*
       * The default is what the node did before this control existed, so a graph saved without
       * the key loads meaning exactly what it meant — no `absentMeans` needed.
       */
      default: 'supervoxel',
      options: [
        { value: 'supervoxel', label: 'each row’s supervoxel' },
        { value: 'majority', label: 'majority of the root’s chunks' },
      ],
      help: `"each row’s supervoxel" looks up where the supervoxel each row was annotated at ended up, which is exact. "majority of the root’s chunks" needs no supervoxel: it samples ${VOTE_SAMPLE} of the old root’s level-2 chunks and picks the root most of them now belong to, adding an \`${CONFIDENCE_COLUMN}\` column with that root’s share. A neuron that was split goes to its largest piece.`,
    },
    {
      id: 'supervoxelColumn',
      kind: 'column',
      label: 'Supervoxel ID column',
      from: 'in',
      help: 'The supervoxel each row was annotated at, used to find the current root id. Rows without one are left alone.',
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
      // Not read under a majority vote, which also takes it out of the provenance key.
      visibleIf: (params) => !byMajority(params),
    },
    {
      id: 'updateTo',
      kind: 'enum',
      label: 'Update to',
      /*
       * The default is what the node did before this control existed, so a graph saved without
       * the key loads meaning exactly what it meant — no `absentMeans` needed.
       */
      default: 'materialization',
      options: [
        { value: 'materialization', label: 'a materialization' },
        ...CLOCK_MODES.map(({ value, label }) => ({ value, label })),
      ],
      help: '"live" asks for the newest root ids at the moment the node runs. "the last full hour" and "the last half hour" ask for the ids as they were at the last :00 (or :30) before the run, which matches annotation tables refreshed on that schedule, such as FlyTable’s. The ⟳ on the card runs it again. All three are newer than any materialization, so a Dataset pinned to one will not match the neurons edited since.',
      // Inspector-only, like `Materialization` beside it: the two are one decision, and a card
      // showing half of it reads as though the version were not a choice at all.
      advanced: true,
    },
    {
      id: 'version',
      kind: 'string',
      label: 'Materialization',
      placeholder: 'the dataset’s',
      help: 'Materialization to update the ids to. Leave empty to use the one the wired Dataset is pinned to.',
      default: '',
      advanced: true,
      // Hidden under every other mode, which also takes it out of the provenance key: a version
      // typed earlier and no longer read must not re-run anything when it is edited.
      visibleIf: (params) => toMaterialization(params),
    },
  ],

  /*
   * Kind straight through. The schema too under a supervoxel lookup, which rewrites values in one
   * column and touches nothing else; a majority vote adds its confidence column.
   */
  inferOutputs: (ctx) => {
    const input = ctx.inputs.in
    if (!isTabular(input)) return { out: T.table() }
    const schema = schemaOf(input)
    const out = byMajority(ctx.params) && schema ? confidenceSchema(schema) : schema
    return { out: input.kind === 'neurons' ? T.neurons(out) : T.table(out) }
  },

  validate: (ctx) => {
    /*
     * The chunkedgraph is the whole of what this node does, and it is CAVE's alone: a neuPrint
     * body id is a property on a node and a CATMAID skeleton id is a row key — neither moves, so
     * there is nothing here to repair and no service to ask. Wired to one anyway, this reached
     * `evaluate`, split `male-cns:v1.0` on the colon and refused with "Cannot read a
     * materialization out of" — a sentence about a grammar, for a mistake made on a wire.
     */
    const foreign = foreignBackend(ctx.inputs.dataset, 'cave')
    if (foreign) {
      return [
        `Root ids only change in CAVE datasets, and a ${foreign} dataset has no chunkedgraph to ` +
          `look them up in. Wire a CAVE Dataset into \`Dataset\`.`,
      ]
    }
    if (!byMajority(ctx.params) && !ctx.column('supervoxelColumn')) {
      return [
        'Pick a `Supervoxel ID column`. The ids cannot be updated without each row’s supervoxel id.',
      ]
    }
    const typed = typedVersion(ctx.params)
    if (typed && !Number.isInteger(Number(typed))) {
      return [`"${typed}" is not a materialization number. CAVE numbers them, e.g. 783.`]
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
      throw new Error('Wire a CAVE Dataset into `Dataset` so the ids can be looked up.')
    }
    // Which datastack, and which deployment's chunkedgraph answers it — whose token asks — is the
    // Dataset's, through the one reader of that rule. A version on this node overrides its own.
    const target = caveTargetOfValue(dataset, {})
    const at = rootsAt(ctx.params, target?.version)
    if (!target || !at) {
      throw new Error(
        `Cannot read a materialization from "${dataset.datasetId}". Set \`Materialization\` on this node.`,
      )
    }
    const { deployment, datastack } = target
    // What puts `cached 4m ago ⟳` on the card: the age is how old the ids' state is — since the
    // run for live, since the boundary for the clock modes.
    if (!('version' in at)) ctx.reportFetched('instant' in at ? at.instant : at.boundary)

    const majority = byMajority(ctx.params)
    const idColumn = ctx.column('idColumn')
    if (!idColumn) throw new Error('Pick an `ID column`.')
    const ids = table.data[idColumn]
    if (!ids) throw new Error(`"${idColumn}" is not in this table`)
    let svs: ColumnData | undefined
    if (!majority) {
      const svColumn = ctx.column('supervoxelColumn')
      if (!svColumn) throw new Error('Pick a `Supervoxel ID column`.')
      svs = table.data[svColumn]
      if (!svs) throw new Error(`"${svColumn}" is not in this table`)
    }

    ctx.progress(0.1, 'checking which ids moved')
    const options = { deployment, signal: ctx.signal }
    /*
     * Only the rows that actually moved are looked up. On an unedited base this is one
     * `is_latest_roots` pass and no `get_roots` at all — and both answers are cached forever,
     * since what a root or a supervoxel was at a past instant cannot change.
     */
    const present = [...new Set(textOf(ids))]
    const stale = await staleRoots(datastack, at, present, options)

    /*
     * A row's confidence under a majority vote: 1 where its id was current, the winner's share
     * where it was repaired, and null where there is no id or no repair.
     */
    const confidence = majority
      ? Array.from(ids, (cell): CellValue => (idText(cell ?? null) ? 1 : null))
      : undefined
    // Nothing to rewrite — though a majority vote still writes its column, or the schema would grow
    // one only when something was stale and disagree with `inferOutputs` on every unedited base.
    if (stale.size === 0) {
      return { out: confidence ? confidenceTable(table, table.data, confidence) : table }
    }

    ctx.progress(0.5, `${stale.size.toLocaleString()} to update`)
    // The rows that moved, each with the handle to trace it by — its supervoxel, or under a
    // majority vote its own old root. Decided once, here; the rewrite below visits these and
    // nothing else.
    const moved: { row: number; by: string }[] = []
    const missed = { noSupervoxel: 0, unplaced: 0 }
    for (let i = 0; i < table.length; i++) {
      const id = idText(ids[i] ?? null)
      if (!id || !stale.has(id)) continue
      if (confidence) confidence[i] = null
      const by = svs ? idText(svs[i] ?? null) : id
      if (by) moved.push({ row: i, by })
      else missed.noSupervoxel++
    }
    const handles = moved.map((m) => m.by)
    // One lookup per route: a supervoxel answers a root, a vote a root and its share.
    const traced: ReadonlyMap<string, string | MajorityRoot> = majority
      ? await rootsByMajority(datastack, at, handles, options)
      : await rootsForSupervoxels(datastack, at, handles, options)

    const updated: ColumnData = Array.from(ids, (cell) => cell ?? null)
    /*
     * The column's *declared* storage, not row zero's. Reading the first cell decides the whole
     * column from one value, and a table whose first row has no id — an annotation base with a
     * blank leading row, which is ordinary — writes strings into an `i64` column: schema and
     * values disagreeing, which is invariant 3 broken silently by a repair node. The schema is
     * right there and says it for every row at once.
     */
    const numeric = isNumericDType(findColumn(table.schema, idColumn)?.dtype ?? 'str')
    const weak: string[] = []
    for (const { row, by } of moved) {
      const found = traced.get(by)
      if (found === undefined) {
        missed.unplaced++
        continue
      }
      /*
       * The replacement keeps the column's own storage. A CAVE id column is `str` and stays text,
       * which is what invariant 8 requires of an eighteen-digit id; a table that happens to hold
       * them as numbers keeps doing so rather than changing dtype under everything downstream —
       * and `idText` refuses a number too wide to be exact, so nothing silently rounds.
       */
      const root = typeof found === 'string' ? found : found.root
      updated[row] = numeric ? (Number(root) as CellValue) : root
      if (typeof found !== 'string' && confidence) {
        confidence[row] = found.share
        if (found.share < WEAK_MAJORITY) weak.push(`${by} → ${root}`)
      }
    }
    const warning = unrepairedWarning(missed, majority)
    if (warning) ctx.warn(warning)
    const split = weakMajorityWarning(weak)
    if (split) ctx.warn(split)

    const data = { ...table.data, [idColumn]: updated }
    return {
      out: confidence
        ? confidenceTable(table, data, confidence)
        : makeTable(table.schema, data, table.kind),
    }
  },
})

/** The schema half of a majority vote's output: the input's, with the confidence column folded in. */
function confidenceSchema(schema: TableSchema): TableSchema {
  return foldColumns(schema, [column(CONFIDENCE_COLUMN, 'f64')])
}

/** The value half, beside it: the rewritten data with the confidence column folded in. */
function confidenceTable(
  table: TableValue,
  data: Readonly<Record<string, ColumnData>>,
  confidence: ColumnData,
): TableValue {
  return makeTable(
    confidenceSchema(table.schema),
    { ...data, [CONFIDENCE_COLUMN]: confidence },
    table.kind,
  )
}

/**
 * Below this share the winner is said on the card. A neuron split in two roughly equal halves
 * still has a winner, and the id now names half the cells it used to — which is a different claim
 * from the one the row's label was making, and nothing downstream could tell.
 */
const WEAK_MAJORITY = 2 / 3

type Params = Readonly<Record<string, unknown>>

/**
 * Whether the stale rows are traced by a majority of their old root's chunks — the one spelling of
 * that test, read by `visibleIf`, `validate`, `inferOutputs`, `evaluate` and the Python emitter.
 * Anything but `majority` is the supervoxel lookup, so a value nobody offers means the default
 * everywhere.
 */
export function byMajority(params: Params): boolean {
  return params.method === 'majority'
}

/** The clock mode chosen, or undefined for a materialization — including a value nobody offers. */
function clockMode(params: Params) {
  return CLOCK_MODES.find((mode) => mode.value === params.updateTo)
}

/**
 * Whether the node updates to a materialization — the one spelling of that test.
 *
 * Derived as "no clock mode" rather than compared with `'materialization'`, so a stored value the
 * dropdown does not offer means the default everywhere at once: `visibleIf`, `validate` and
 * `evaluate` cannot read it three ways.
 */
function toMaterialization(params: Params): boolean {
  return clockMode(params) === undefined
}

/** The materialization typed on this node, trimmed; empty when none is, or the mode reads none. */
function typedVersion(params: Params): string {
  return toMaterialization(params) ? String(params.version).trim() : ''
}

/**
 * The instant to update to, or undefined when no materialization can be read.
 *
 * A clock mode is one instant for the whole run, taken here and handed to both lookups — see
 * `RootsAt`. Live is a new instant every run; a boundary is the same one for every run until the
 * next, which is what lets its answers be held. Otherwise a version typed on this node overrides
 * the Dataset's own.
 */
function rootsAt(params: Params, pinned: number | undefined): RootsAt | undefined {
  const mode = clockMode(params)
  if (mode) {
    const at = Math.floor(Date.now() / mode.stepMs) * mode.stepMs
    return mode.value === 'live' ? { instant: at } : { boundary: at }
  }
  const typed = typedVersion(params)
  const version = typed ? Number(typed) : pinned
  return version !== undefined && Number.isInteger(version) ? { version } : undefined
}

/**
 * What a run left stale, counted by reason, or nothing when every stale row was repaired.
 *
 * A row is left as it was when it cannot be traced — the stale id beats a null or a dropped row —
 * and without this the card is green either way, so a run repairing 900 of 1,000 stale rows looks
 * exactly like one repairing all of them. The drift check on a pinned Dataset would count them
 * eventually, but a live run has nothing downstream to say so. Rows, not distinct ids, since a
 * row is what somebody fixes in the base.
 */
function unrepairedWarning(
  missed: { noSupervoxel: number; unplaced: number },
  majority: boolean,
): string | undefined {
  const { noSupervoxel, unplaced } = missed
  const total = noSupervoxel + unplaced
  if (total === 0) return undefined
  const reasons = [
    noSupervoxel > 0 ? `${formatNumber(noSupervoxel)} without a supervoxel ID` : '',
    unplaced > 0
      ? `${formatNumber(unplaced)} whose ${majority ? 'old root CAVE could not place' : 'supervoxel CAVE does not know'}`
      : '',
  ].filter(Boolean)
  const one = total === 1
  return (
    `${plural(total, 'row')} ${one ? 'has' : 'have'} an out-of-date ID that could not be ` +
    `updated: ${listed(reasons)}. ${one ? 'It is left as it was' : 'They are left as they were'}.`
  )
}

/**
 * What a majority vote repaired on a thin margin, or nothing when every winner was clear.
 *
 * In rows, like the unrepaired count, with a few old → new pairs to look at. The confidence column
 * carries the same fact per row; this is the half somebody sees without opening the table.
 */
function weakMajorityWarning(weak: readonly string[]): string | undefined {
  if (weak.length === 0) return undefined
  const one = weak.length === 1
  return (
    `${plural(weak.length, 'row')} ${one ? 'was' : 'were'} updated to a root holding less than ` +
    `two thirds of the old neuron’s chunks, so the old neuron was split and the new ID may name ` +
    `only part of it (e.g. ${namedFew([...new Set(weak)])}). See \`${CONFIDENCE_COLUMN}\`.`
  )
}

/** Every cell of an id column as text, skipping what is not an id. */
function textOf(column: ColumnData): string[] {
  const out: string[] = []
  for (const cell of column) {
    const id = idText(cell ?? null)
    if (id) out.push(id)
  }
  return out
}
