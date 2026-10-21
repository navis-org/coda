/**
 * `FlyTable` and `SeaTable`, in seatabler.
 *
 * Two registrations over one emitter, as the nodes are two registrations over one implementation:
 * the same API at two hosts. What either reads is `seaTablePlan`'s, shared with the notebook's
 * cell; the read itself is `coda_seatable` (`helpers.ts`).
 *
 * Two things differ from the notebook. `Workspace` is passed where the card names one, since
 * seatabler's connection takes the workspace id the param holds and sea-serpent has nowhere to put
 * it; and the token's variable follows the host (docs/export.md, "SeaTable and FlyTable in R").
 */

import { SEATABLE_HOSTS } from '../../../data/annotations/credentials'
import { seaTablePlan } from '../../plans/query'
import { rArgs, rStr, rVector } from '../r'
import { chainAnnotations } from './common'
import { registerEmitter } from '../registry'
import type { EmitContext } from '../types'

/** A host without its scheme, in lower case: what makes two spellings of one deployment one. */
const bareHost = (host: string): string => host.replace(/^https?:\/\//i, '').toLowerCase()

/** The environment variable holding the account token for a SeaTable deployment. */
function tokenVariable(host: string): string {
  return bareHost(host) === bareHost(SEATABLE_HOSTS.flytable)
    ? 'FLYTABLE_TOKEN'
    : 'SEATABLE_TOKEN'
}

function seaTableChunk(ctx: EmitContext, defaultHost: string): string[] {
  const plan = seaTablePlan(ctx.params, defaultHost)
  if (plan.refusal !== undefined) return ctx.todo(plan.refusal)
  // seatabler finds the table in the SQL text with `FROM\s+'?([^, ']+)`, so a name with a space,
  // a comma or a quote in it reads as another table. The canvas reads it through the rows endpoint.
  if (!/^[^\s,']+$/.test(plan.table)) {
    return ctx.todo(
      `seatabler cannot read a table whose name holds a space, comma or quote ("${plan.table}"). ` +
        'Rename the table, or export the Jupyter notebook, whose sea-serpent reads it.',
    )
  }

  ctx.helper('coda_seatable')
  const args = [
    rStr(plan.host),
    rStr(plan.base),
    rStr(plan.table),
    `id_column = ${rStr(plan.idColumn)}`,
  ]
  if (plan.columns.length > 0) args.push(`columns = ${rVector(plan.columns)}`)
  args.push(`token_envvar = ${rStr(tokenVariable(plan.host))}`)
  if (plan.workspace) args.push(`workspace = ${rStr(plan.workspace)}`)

  const out = ctx.output('annotations')
  return [`${out} <- coda_seatable(`, ...rArgs(args), `)`, ...chainAnnotations(ctx, out)]
}

for (const [type, host] of [
  ['annotation.flyTable', SEATABLE_HOSTS.flytable],
  ['annotation.seaTable', SEATABLE_HOSTS.seatable],
] as const) {
  registerEmitter(type, (ctx) => seaTableChunk(ctx, host))
}
