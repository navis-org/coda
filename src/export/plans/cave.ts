/**
 * What the CAVE exports decide before either language says it: which datastack and materialization
 * a node reads, what a dataset cell builds, a CAVE table's reading, Update root IDs' method, and
 * where a synapse table keeps its ends.
 *
 * Every one of these was a decision tree written out twice — `python/emitters/cave.ts` first, then
 * `r/emitters/cave.ts` copying it branch for branch — with sentences that had already begun to
 * differ. Here once; each emitter only spells the answer (`neutral.ts`' rule). The one note that is
 * genuinely per language, a borrowed dataset's ("this cell builds its own client" against "this
 * chunk names the same datastack"), rides as the `borrowed` flag.
 */

import type { CodaType } from '../../core/types'
import { namedColumns } from '../../data/annotations/types'
import type { AnnotationTableSpec, NeuronTableSpec } from '../../data/cave/spec'
import {
  STANDARD_SYNAPSE_COLUMNS,
  endPositionColumn,
  specFor,
  splitDatasetId,
} from '../../data/cave/spec'
import { VOTE_SAMPLE } from '../../data/cave/rootIds'
import type { SynapseLocation } from '../../data/source'
import type { CaveTarget } from '../../nodes/lib/caveParams'
import { DEFAULT_CAVE_SERVER, caveServerOfSource } from '../../data/cave/deployments'
import type { DatasetFamily } from '../../nodes/lib/datasetFamilies'
import { resolveDatasetId } from '../../nodes/lib/datasetFamilies'
import { caveTarget, caveTargetOfType, customCaveServer } from '../../nodes/lib/caveParams'
import { byMajority } from '../../nodes/transform/updateRootIds'
import type { NeutralContext, Refusable } from '../neutral'

/**
 * What a CAVE document says where it departs from a neuPrint one, or refuses — `CATMAID_TEXT`'s
 * rule: one wording for both languages, since none of it is about either.
 */
export const CAVE_TEXT = {
  search:
    'A CAVE datastack has no server-side neuron query, so this reads the whole neuron ' +
    'index once and filters it here, as Coda does. Explore Dataset uses the same table.',
  explore:
    'Explore Dataset searches the whole neuron table locally. This is the datastack’s ' +
    'neuron table joined to its annotations (or to whatever is wired into the ' +
    'Dataset node’s `Annotations` port), fetched the first time anything needs it. ' +
    'On FlyWire that is 139,255 rows and takes a few seconds.',
  noRegions: (roi: string) =>
    `This node filters on region "${roi}", and a CAVE datastack publishes no regions, so ` +
    'the result is empty. Clear `In ROI` to get neurons back.',
  noScore: (floor: number) =>
    `This synapse table has no score column, so \`Min confidence\` (${floor}) is ignored ` +
    'here and on the canvas.',
  noTypes:
    'This table names the two bodies of each synapse but not their cell types, which ' +
    'the canvas fills in from the dataset. Join them from a neuron table if you need them.',
  unspecced:
    'Coda has no entry for this datastack, so the synapse table name is read from ' +
    'its info record, as the canvas does.',
  unbound: (location: string, column: string) =>
    `This datastack's synapse table names its ${location}synaptic end "${column}", which is ` +
    'not a bound point, so there is no position column to read. The canvas refuses this too.',
  chainReplaces:
    "Annotations are wired to this dataset in Coda, so they replace the datastack's own " +
    'labels entirely.',
  noNeuronTable: (datastack: string) =>
    `Coda has no table spec for "${datastack}", so this dataset can be queried by root id but ` +
    'cannot list its neurons. Pass its neuron table and id column below as `neuron_table` and ' +
    '`id_column`, or wire an Annotations source.',
  noDatasetId:
    'Coda could not work out which datastack and materialization this CAVE dataset uses. ' +
    'Set `Materialization` on the node and export again.',
  notDatasetId: (id: string) => `"${id}" is not a datastack and materialization.`,
  noDatastackParam: 'This CAVE node has no `Datastack` set.',
  latest: (datastack: string) =>
    '`Materialization` is empty, so this node uses the newest materialization of ' +
    `"${datastack}", and the exporter could not find out which one that is. Pick one in ` +
    '`Materialization`.',
  noTable: 'This CAVE table node has no `Table` set.',
  pivotWithoutValue:
    '`Pivot on` is set on this CAVE table but `Value column` is empty. Set `Value column`, or ' +
    'clear `Pivot on`.',
  tableUnresolved:
    'Coda could not yet tell which datastack and materialization the Dataset wired to this ' +
    'CAVE table uses. Pin a materialization on the Dataset node and export again.',
  notADatastack: (typed: string) =>
    `\`Datastack\` ("${typed || '(none)'}") is not a datastack and materialization. Write it ` +
    'as `flywire_fafb_public:783`, or wire a Dataset.',
  noDatastack:
    'This node has no datastack and materialization: none comes from a wired Dataset, and ' +
    '`Datastack` is empty. Enter one in `Datastack` as `flywire_fafb_public:783`, or pin a ' +
    'materialization on the Dataset node, and export again.',
  noInfoTable: 'This CAVE table info node has no table or view set in `Table`.',
  noSupervoxel:
    '`Supervoxel ID column` is not set. Pick the column that holds each row’s supervoxel id, or ' +
    'set `Method` to the majority of the root’s chunks.',
  repairVersionUnknown:
    '`Materialization` is set on this Update root IDs node, but Coda could not tell which ' +
    'datastack the wired Dataset uses, so there is no datastack to apply it to.',
  repairUnresolved:
    'Coda could not tell which datastack and materialization the Dataset wired to this Update ' +
    'root IDs node uses, so it does not know which point in time to update the ids to. Pin a ' +
    'materialization on the Dataset node and export again.',
}

// ---------------------------------------------------------------------------
// Dataset nodes
// ---------------------------------------------------------------------------

/** The datastack a dataset cell binds, and its own tables where Coda has a spec for them. */
export type CaveDatasetPlan = Refusable<{
  target: CaveTarget
  neurons?: NeuronTableSpec
  annotations?: AnnotationTableSpec
}>

/** A family's or Custom CAVE's dataset, from its resolved id and deployment. */
export function caveDatasetPlan(
  datasetId: string | undefined,
  deployment: string,
): CaveDatasetPlan {
  if (!datasetId) return { refusal: CAVE_TEXT.noDatasetId }
  const parsed = splitDatasetId(datasetId)
  if (!parsed) return { refusal: CAVE_TEXT.notDatasetId(datasetId) }
  const spec = specFor(deployment, parsed.datastack)
  return {
    target: { deployment, datastack: parsed.datastack, version: parsed.version },
    ...(spec?.neurons ? { neurons: spec.neurons } : {}),
    ...(spec?.annotations ? { annotations: spec.annotations } : {}),
  }
}

/** A published family's dataset: its version resolved, its deployment read off its source id. */
export function caveFamilyDatasetPlan(
  family: DatasetFamily,
  params: Record<string, unknown>,
): CaveDatasetPlan {
  return caveDatasetPlan(
    resolveDatasetId(family, params.version),
    caveServerOfSource(family.sourceId) ?? DEFAULT_CAVE_SERVER,
  )
}

/**
 * Custom CAVE, which names its own datastack. "Latest" is refused: it needs a network call the
 * exporter has not made, and a materialization *expires*, so an unpinned document answers a
 * different question every few months with nothing saying so.
 */
export function caveNodeDatasetPlan(params: Record<string, unknown>): CaveDatasetPlan {
  const datastack = String(params.datastack ?? '').trim()
  if (!datastack) return { refusal: CAVE_TEXT.noDatastackParam }
  const version = String(params.version ?? '').trim()
  if (!version) return { refusal: CAVE_TEXT.latest(datastack) }
  return caveDatasetPlan(`${datastack}:${version}`, customCaveServer(params))
}

// ---------------------------------------------------------------------------
// Which datastack a node reads
// ---------------------------------------------------------------------------

/**
 * The dataset a CAVE node reads: a **bound** variable, or a **fresh** target the document names
 * itself.
 *
 * A fresh target is `borrowed` when it comes from a reference whose node is written later — the
 * wiring references exist for, where the dataset consumes the very node referencing it — which is
 * faithful because a reference names a datastack knowable from the referenced node's params alone.
 */
export type CaveTargetPlan = Refusable<
  { bound: string } | { fresh: CaveTarget; borrowed: boolean }
>

/**
 * `table` and `discovery` read the wired Dataset where there is one and the `datastack` param
 * otherwise — the wire wins, as `caveRef` applies it on the canvas. `repair` is Update root IDs,
 * which always reads its reference and whose own `Materialization` overrides the dataset's: a
 * second target rather than an argument, since the instant ids are brought to is the target's.
 */
export function caveTargetPlan(
  ctx: Pick<NeutralContext, 'input' | 'inputType' | 'params'>,
  use: 'table' | 'discovery' | 'repair',
): CaveTargetPlan {
  if (use === 'repair') {
    const version = String(ctx.params.version ?? '').trim()
    if (!version) return reference(ctx, CAVE_TEXT.repairUnresolved)
    const target = caveTargetOfType(ctx.inputType('dataset'), {})
    if (!target) return { refusal: CAVE_TEXT.repairVersionUnknown }
    return { fresh: { ...target, version: Number(version) }, borrowed: false }
  }
  if (ctx.inputType('dataset')) {
    return reference(ctx, use === 'table' ? CAVE_TEXT.tableUnresolved : CAVE_TEXT.noDatastack)
  }
  const typed = caveTarget(undefined, ctx.params)
  if (typed) return { fresh: typed, borrowed: false }
  return {
    refusal:
      use === 'table'
        ? CAVE_TEXT.notADatastack(String(ctx.params.datastack ?? '').trim())
        : CAVE_TEXT.noDatastack,
  }
}

function reference(
  ctx: Pick<NeutralContext, 'input' | 'inputType'>,
  refusal: string,
): CaveTargetPlan {
  const bound = ctx.input('dataset')
  if (bound) return { bound }
  const target = caveTargetOfType(ctx.inputType('dataset'), {})
  return target ? { fresh: target, borrowed: true } : { refusal }
}

// ---------------------------------------------------------------------------
// CAVE table, Update root IDs, CAVE table info
// ---------------------------------------------------------------------------

/** A CAVE table's reading: which table, keyed by which column, wide by which kind. */
type CaveTablePlan = Refusable<{
  table: string
  idColumn: string
  columns: string[]
  pivot?: { on: string; value: string }
}>

export function caveTablePlan(params: Record<string, unknown>): CaveTablePlan {
  const table = String(params.table ?? '').trim()
  if (!table) return { refusal: CAVE_TEXT.noTable }
  const idColumn = String(params.idColumn ?? '').trim() || 'pt_root_id'
  const on = String(params.pivotOn ?? '').trim()
  const value = String(params.valueColumn ?? '').trim()
  if (on && !value) return { refusal: CAVE_TEXT.pivotWithoutValue }
  return {
    table,
    idColumn,
    columns: namedColumns(String(params.columns ?? ''), idColumn),
    ...(on ? { pivot: { on, value } } : {}),
  }
}

/** Update root IDs' method: a majority vote over `sample` chunks, or each row's supervoxel. */
type RootIdsMethodPlan = Refusable<
  { sample: number; supervoxelColumn?: undefined } | { supervoxelColumn: string }
>

export function rootIdsMethodPlan(
  ctx: Pick<NeutralContext, 'params' | 'column'>,
): RootIdsMethodPlan {
  if (byMajority(ctx.params)) return { sample: VOTE_SAMPLE }
  const supervoxelColumn = ctx.column('supervoxelColumn')
  return supervoxelColumn ? { supervoxelColumn } : { refusal: CAVE_TEXT.noSupervoxel }
}

/** CAVE table info's table or view. */
export function caveInfoTable(params: Record<string, unknown>): Refusable<{ table: string }> {
  const table = String(params.table ?? '').trim()
  return table ? { table } : { refusal: CAVE_TEXT.noInfoTable }
}

// ---------------------------------------------------------------------------
// Synapses Between
// ---------------------------------------------------------------------------

/**
 * Where a datastack keeps a synapse's two ends: the table or view (absent where Coda has no spec,
 * so the document reads it off the info record), the two id columns, the drawn end's position
 * columns as a `{axis}` template, and the score column a confidence floor applies to.
 */
type CaveSynapsePlan = Refusable<{
  table?: { name: string; view: boolean }
  preColumn: string
  postColumn: string
  position: string
  score?: string
}>

export function caveSynapsePlan(
  datasetType: CodaType | undefined,
  location: SynapseLocation,
): CaveSynapsePlan {
  const target = caveTargetOfType(datasetType, {})
  const spec = target ? specFor(target.deployment, target.datastack)?.synapses : undefined
  const columns = spec ?? STANDARD_SYNAPSE_COLUMNS
  const position = endPositionColumn(columns, location)
  if (!position) {
    return {
      refusal: CAVE_TEXT.unbound(
        location,
        location === 'pre' ? columns.preColumn : columns.postColumn,
      ),
    }
  }
  return {
    ...(spec ? { table: { name: spec.table, view: spec.kind === 'view' } } : {}),
    preColumn: columns.preColumn,
    postColumn: columns.postColumn,
    position: `${position}_{axis}`,
    ...(spec?.scoreColumn ? { score: spec.scoreColumn } : {}),
  }
}
