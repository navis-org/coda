/**
 * The CATMAID dataset nodes, in rcatmaid.
 *
 * A dataset chunk binds a `coda_catmaid_dataset` (`catmaidHelpers.ts`) — a connection, a project
 * and the neuron table built on first use — and the query chunks call `coda_catmaid_*` functions
 * on it. The notebook's arrangement (`python/emitters/catmaid.ts`), one language over.
 *
 * The VFB families answer anonymously from R as from Python: rcatmaid's `catmaid_login` with a
 * server and nothing else is what `vfbcatmaid()` does. A Custom CATMAID reads a token from the
 * environment and is anonymous where none is set.
 */

import { DATASET_FAMILIES } from '../../../nodes/lib/datasetFamilies'
import type { CatmaidDatasetPlan } from '../../plans/query'
import {
  CATMAID_TEXT,
  catmaidFamilyPlan,
  catmaidNodePlan,
  catmaidProjectLiteral,
} from '../../plans/query'
import { rStr } from '../r'
import { registerEmitter } from '../registry'
import type { EmitContext } from '../types'

function datasetChunk(ctx: EmitContext, plan: CatmaidDatasetPlan): string[] {
  if (plan.refusal !== undefined) return ctx.todo(plan.refusal)
  ctx.helper('coda_catmaid_dataset')
  const out = ctx.output('dataset')
  const project = catmaidProjectLiteral(plan.projectId, rStr)
  if (!plan.token) return [`${out} <- coda_catmaid_dataset(${rStr(plan.server)}, ${project})`]
  return [
    ...ctx.note(CATMAID_TEXT.token),
    `${out} <- coda_catmaid_dataset(`,
    `  ${rStr(plan.server)},`,
    `  ${project},`,
    `  token = Sys.getenv("CATMAID_API_TOKEN")`,
    `)`,
  ]
}

for (const family of DATASET_FAMILIES) {
  if (family.notebook?.r !== 'rcatmaid') continue
  registerEmitter(`dataset.${family.key}`, (ctx) =>
    datasetChunk(ctx, catmaidFamilyPlan(family.key)),
  )
}

registerEmitter('dataset.catmaid', (ctx) => datasetChunk(ctx, catmaidNodePlan(ctx.params)))
