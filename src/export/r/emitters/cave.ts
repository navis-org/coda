/**
 * The CAVE nodes, in fafbseg — the notebook's `python/emitters/cave.ts`, one language over.
 *
 * Every decision is `plans/cave.ts`', shared with the notebook: which datastack a node reads, what
 * a dataset binds, a CAVE table's reading, Update root IDs' method, and every refusal. This file
 * only spells the answers. A dataset chunk binds a `coda_cave_dataset` (`caveHelpers.ts`): a
 * datastack, a materialization and the neuron table built on first use. Where the notebook's cells
 * call methods on a `CAVEclient`, these call `coda_cave_*` functions on the dataset, which read
 * rows through fafbseg and everything else through a client pinned to the same materialization.
 *
 * **fafbseg reaches CAVE's global server only**: its client takes a datastack name and no server.
 * So a graph reading a datastack on another deployment — H01 on `global.brain-wire-test.org` — is
 * refused whole by `canExportNotebook` (`unreachableDatasetNodes`), and every target this file
 * spells is on the global server. A typed `datastack` param always is. The notebook passes
 * `server_address`.
 */

import type { CaveTarget } from '../../../nodes/lib/caveParams'
import { DATASET_FAMILIES } from '../../../nodes/lib/datasetFamilies'
import type { CaveDatasetPlan, CaveTargetPlan } from '../../plans/cave'
import {
  CAVE_TEXT,
  caveFamilyDatasetPlan,
  caveInfoTable,
  caveNodeDatasetPlan,
  caveTablePlan,
  caveTargetPlan,
  rootIdsMethodPlan,
} from '../../plans/cave'
import { rArgs, rStr, rValue, rVector } from '../r'
import { chainAnnotations } from './common'
import { registerEmitter } from '../registry'
import type { EmitContext } from '../types'

const CAVE_ONLY = { backends: ['cave'] }

/** `coda_cave_dataset(...)` for a target, declaring the helper it calls. */
function bareDataset(ctx: EmitContext, target: CaveTarget): string {
  ctx.helper('coda_cave_dataset')
  return `coda_cave_dataset(${rStr(target.datastack)}, ${target.version})`
}

/**
 * The dataset a planned target spells: the bound variable, or a fresh `coda_cave_dataset` under
 * `local` — with a note where it is borrowed from a reference whose chunk comes later. A refusal
 * comes back as the TODO lines.
 */
function datasetLines(
  ctx: EmitContext,
  plan: CaveTargetPlan,
  local: string,
): { expr: string; setup: string[] } | string[] {
  if (plan.refusal !== undefined) return ctx.todo(plan.refusal)
  if ('bound' in plan) return { expr: plan.bound, setup: [] }
  return {
    expr: local,
    setup: [
      ...(plan.borrowed
        ? ctx.note(
            'The Dataset wired here only names a datastack, and its chunk comes after this one, ' +
              'so this chunk names the same datastack and materialization itself.',
          )
        : []),
      `${local} <- ${bareDataset(ctx, plan.fresh)}`,
    ],
  }
}

// ---------------------------------------------------------------------------
// Dataset
// ---------------------------------------------------------------------------

function datasetChunk(ctx: EmitContext, plan: CaveDatasetPlan): string[] {
  if (plan.refusal !== undefined) return ctx.todo(plan.refusal)
  const out = ctx.output('dataset')
  const chain = ctx.input('annotations')
  if (!chain && !plan.neurons) {
    return [
      ...ctx.note(CAVE_TEXT.noNeuronTable(plan.target.datastack)),
      `${out} <- ${bareDataset(ctx, plan.target)}`,
    ]
  }

  ctx.helper('coda_cave_dataset')
  const args = [rStr(plan.target.datastack), String(plan.target.version)]
  if (chain) {
    // A wired chain replaces the datastack's own labels, as the socket does on the canvas.
    args.push(`labels = ${chain}`)
  } else {
    args.push(
      `neuron_table = ${rStr(plan.neurons!.table)}`,
      `id_column = ${rStr(plan.neurons!.idColumn)}`,
    )
    if (plan.annotations) {
      args.push(
        `annotation_table = ${rStr(plan.annotations.table)}`,
        `ref_column = ${rStr(plan.annotations.refColumn)}`,
        `system_column = ${rStr(plan.annotations.systemColumn)}`,
        `value_column = ${rStr(plan.annotations.valueColumn)}`,
      )
    }
  }
  return [
    ...(chain ? ctx.note(CAVE_TEXT.chainReplaces) : []),
    `${out} <- coda_cave_dataset(`,
    ...rArgs(args),
    `)`,
  ]
}

for (const family of DATASET_FAMILIES) {
  if (family.notebook?.r !== 'fafbseg') continue
  registerEmitter(
    `dataset.${family.key}`,
    (ctx) => datasetChunk(ctx, caveFamilyDatasetPlan(family, ctx.params)),
    CAVE_ONLY,
  )
}

registerEmitter(
  'dataset.cave',
  (ctx) => datasetChunk(ctx, caveNodeDatasetPlan(ctx.params)),
  CAVE_ONLY,
)

// ---------------------------------------------------------------------------
// CAVE table — an annotation source
// ---------------------------------------------------------------------------

registerEmitter(
  'annotation.caveTable',
  (ctx) => {
    const reading = caveTablePlan(ctx.params)
    if (reading.refusal !== undefined) return ctx.todo(reading.refusal)
    const dataset = datasetLines(ctx, caveTargetPlan(ctx, 'table'), '.cave')
    if (Array.isArray(dataset)) return dataset

    ctx.helper('coda_cave_table')
    const args = [dataset.expr, rStr(reading.table), `id_column = ${rStr(reading.idColumn)}`]
    if (reading.columns.length > 0) args.push(`columns = ${rVector(reading.columns)}`)
    if (reading.pivot) {
      args.push(
        `pivot_on = ${rStr(reading.pivot.on)}`,
        `value_column = ${rStr(reading.pivot.value)}`,
      )
    }
    const out = ctx.output('annotations')
    return [
      ...dataset.setup,
      `${out} <- coda_cave_table(`,
      ...rArgs(args),
      `)`,
      ...chainAnnotations(ctx, out),
    ]
  },
  CAVE_ONLY,
)

// ---------------------------------------------------------------------------
// Update root IDs
// ---------------------------------------------------------------------------

registerEmitter(
  'cave.updateRootIds',
  (ctx) => {
    const method = rootIdsMethodPlan(ctx)
    if (method.refusal !== undefined) return ctx.todo(method.refusal)
    const dataset = datasetLines(ctx, caveTargetPlan(ctx, 'repair'), '.repair_at')
    if (Array.isArray(dataset)) return dataset

    ctx.helper('coda_update_root_ids')
    return [
      ...dataset.setup,
      `${ctx.output('out')} <- coda_update_root_ids(`,
      ...rArgs([
        dataset.expr,
        ctx.wired('in'),
        `id_column = ${rStr(ctx.column('idColumn') ?? 'neuronId')}`,
        method.supervoxelColumn === undefined
          ? `sample = ${method.sample}`
          : `supervoxel_column = ${rStr(method.supervoxelColumn)}`,
      ]),
      `)`,
    ]
  },
  CAVE_ONLY,
)

// ---------------------------------------------------------------------------
// The two discovery nodes
// ---------------------------------------------------------------------------

registerEmitter(
  'cave.tables',
  (ctx) => {
    const dataset = datasetLines(ctx, caveTargetPlan(ctx, 'discovery'), '.cave')
    if (Array.isArray(dataset)) return dataset
    ctx.helper('coda_cave_tables')
    const includeViews = rValue(Boolean(ctx.params.includeViews))
    return [
      ...dataset.setup,
      `${ctx.output('out')} <- coda_cave_tables(${dataset.expr}, include_views = ${includeViews})`,
    ]
  },
  CAVE_ONLY,
)

registerEmitter(
  'cave.tableInfo',
  (ctx) => {
    const info = caveInfoTable(ctx.params)
    if (info.refusal !== undefined) return ctx.todo(info.refusal)
    const dataset = datasetLines(ctx, caveTargetPlan(ctx, 'discovery'), '.cave')
    if (Array.isArray(dataset)) return dataset
    ctx.helper('coda_cave_table_info')
    return [
      ...ctx.note(
        'In Coda the card shows this table’s description and row counts. Here they are ' +
          'printed, and the chunk’s output is the list of columns.',
      ),
      ...dataset.setup,
      `${ctx.output('columns')} <- coda_cave_table_info(${dataset.expr}, ${rStr(info.table)})`,
    ]
  },
  CAVE_ONLY,
)
