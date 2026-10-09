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
 * The Dataset input is a **reference**: it names the datastack rather than consuming a dataset,
 * which is what lets this node sit between an annotation source and the dataset it feeds without
 * that being a cycle. See `PortDef.reference`.
 */

import { packNode } from '../../core/registry'
import { T, findColumn, isNumericDType, isTabular, schemaOf } from '../../core/types'
import { idText } from '../../core/ids'
import { listed } from '../../core/prose'
import type { CellValue, ColumnData } from '../../core/values'
import { isTableValue, makeTable } from '../../core/values'
import type { RootsAt } from '../../data/cave/rootIds'
import { rootsForSupervoxels, staleRoots } from '../../data/cave/rootIds'
import { caveTargetOfValue } from '../lib/caveParams'
import { foreignBackend } from '../lib/datasetParam'
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

export const updateRootIdsNode = packNode({
  type: 'cave.updateRootIds',
  label: 'Update root IDs',
  category: 'transform',
  description:
    'Repoint stale CAVE root ids at a materialization or the live segmentation, using their supervoxel ids.',
  guide:
    'Brings outdated CAVE root ids in a table up to date with a materialization, or with the ' +
    'live segmentation, using each row’s supervoxel id. Usually sits between an annotation table ' +
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

  // Schema and kind straight through: this rewrites values in one column and touches nothing else.
  inferOutputs: (ctx) => {
    const input = ctx.inputs.in
    if (!isTabular(input)) return { out: T.table() }
    return {
      out: input.kind === 'neurons' ? T.neurons(schemaOf(input)) : T.table(schemaOf(input)),
    }
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
    if (!ctx.column('supervoxelColumn')) {
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

    const idColumn = ctx.column('idColumn')
    const svColumn = ctx.column('supervoxelColumn')
    if (!idColumn || !svColumn)
      throw new Error('Pick an `ID column` and a `Supervoxel ID column`.')
    const ids = table.data[idColumn]
    const svs = table.data[svColumn]
    if (!ids || !svs) throw new Error(`"${idColumn}" or "${svColumn}" is not in this table`)

    ctx.progress(0.1, 'checking which ids moved')
    const options = { deployment, signal: ctx.signal }
    /*
     * Only the rows that actually moved are looked up. On an unedited base this is one
     * `is_latest_roots` pass and no `get_roots` at all — and both answers are cached forever,
     * since what a root or a supervoxel was at a past instant cannot change.
     */
    const present = [...new Set(textOf(ids))]
    const stale = await staleRoots(datastack, at, present, options)
    if (stale.size === 0) return { out: table }

    ctx.progress(0.5, `${stale.size.toLocaleString()} to update`)
    // The rows that moved, each with the supervoxel to trace it by. Decided once, here; the
    // rewrite below visits these and nothing else.
    const moved: { row: number; sv: string }[] = []
    const missed = { noSupervoxel: 0, unknownSupervoxel: 0 }
    for (let i = 0; i < table.length; i++) {
      const id = idText(ids[i] ?? null)
      if (!id || !stale.has(id)) continue
      const sv = idText(svs[i] ?? null)
      if (sv) moved.push({ row: i, sv })
      else missed.noSupervoxel++
    }
    const roots = await rootsForSupervoxels(
      datastack,
      at,
      moved.map((m) => m.sv),
      options,
    )

    const updated: ColumnData = Array.from(ids, (cell) => cell ?? null)
    /*
     * The column's *declared* storage, not row zero's. Reading the first cell decides the whole
     * column from one value, and a table whose first row has no id — an annotation base with a
     * blank leading row, which is ordinary — writes strings into an `i64` column: schema and
     * values disagreeing, which is invariant 3 broken silently by a repair node. The schema is
     * right there and says it for every row at once.
     */
    const numeric = isNumericDType(findColumn(table.schema, idColumn)?.dtype ?? 'str')
    for (const { row, sv } of moved) {
      const root = roots.get(sv)
      if (root === undefined) {
        missed.unknownSupervoxel++
        continue
      }
      /*
       * The replacement keeps the column's own storage. A CAVE id column is `str` and stays text,
       * which is what invariant 8 requires of an eighteen-digit id; a table that happens to hold
       * them as numbers keeps doing so rather than changing dtype under everything downstream —
       * and `idText` refuses a number too wide to be exact, so nothing silently rounds.
       */
      updated[row] = numeric ? (Number(root) as CellValue) : root
    }
    const warning = unrepairedWarning(missed)
    if (warning) ctx.warn(warning)
    return { out: makeTable(table.schema, { ...table.data, [idColumn]: updated }, table.kind) }
  },
})

type Params = Readonly<Record<string, unknown>>

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
function unrepairedWarning(missed: {
  noSupervoxel: number
  unknownSupervoxel: number
}): string | undefined {
  const { noSupervoxel, unknownSupervoxel } = missed
  const total = noSupervoxel + unknownSupervoxel
  if (total === 0) return undefined
  const reasons = [
    noSupervoxel > 0 ? `${formatNumber(noSupervoxel)} without a supervoxel ID` : '',
    unknownSupervoxel > 0
      ? `${formatNumber(unknownSupervoxel)} whose supervoxel CAVE does not know`
      : '',
  ].filter(Boolean)
  const one = total === 1
  return (
    `${plural(total, 'row')} ${one ? 'has' : 'have'} an out-of-date ID that could not be ` +
    `updated: ${listed(reasons)}. ${one ? 'It is' : 'They are'} left as they were.`
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
