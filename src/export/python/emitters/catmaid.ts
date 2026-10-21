/**
 * The CATMAID dataset nodes, in pymaid.
 *
 * A dataset cell binds a `CodaCatmaidDataset` (`catmaidHelpers.ts`) rather than a bare
 * `CatmaidInstance`, for `CodaCaveDataset`'s reason: a Coda dataset value is a connection **and**
 * a neuron table, and on CATMAID the table is derived rather than read. The query nodes then call
 * methods on it — `labels`, `connectivity`, `synapses` — the same names `CodaCustomDataset`
 * answers, so a branch written for one serves both (`isLabelledHelper` in `common.ts`).
 *
 * The two published families are VFB's public instances, which answer anonymously: pymaid sets
 * the `Referer` and replays the CSRF cookie that a browser cannot, so the notebook needs none of
 * the published token the canvas uses (`docs/catmaid_vfb.md`). A Custom CATMAID is usually a lab
 * server, so its cell reads a token from the environment and is anonymous where none is set.
 */

import { DATASET_FAMILIES } from '../../../nodes/lib/datasetFamilies'
import type { CatmaidDatasetPlan } from '../../plans/query'
import {
  CATMAID_TEXT,
  catmaidFamilyPlan,
  catmaidNodePlan,
  catmaidProjectLiteral,
} from '../../plans/query'
import { pyStr } from '../py'
import { registerEmitter } from '../registry'
import type { EmitContext } from '../types'

function datasetCell(ctx: EmitContext, plan: CatmaidDatasetPlan): string[] {
  if (plan.refusal !== undefined) return ctx.todo(plan.refusal)
  ctx.helper('CodaCatmaidDataset')
  const out = ctx.output('dataset')
  const project = catmaidProjectLiteral(plan.projectId, pyStr)
  if (!plan.token) return [`${out} = CodaCatmaidDataset(${pyStr(plan.server)}, ${project})`]
  ctx.require('os')
  return [
    ...ctx.note(CATMAID_TEXT.token),
    `${out} = CodaCatmaidDataset(`,
    `    ${pyStr(plan.server)},`,
    `    ${project},`,
    `    api_token=os.environ.get('CATMAID_API_TOKEN'),`,
    `)`,
  ]
}

for (const family of DATASET_FAMILIES) {
  if (family.notebook?.python !== 'pymaid') continue
  registerEmitter(`dataset.${family.key}`, (ctx) =>
    datasetCell(ctx, catmaidFamilyPlan(family.key)),
  )
}

registerEmitter('dataset.catmaid', (ctx) => datasetCell(ctx, catmaidNodePlan(ctx.params)))
