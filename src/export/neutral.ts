/**
 * What both emitters share that is not a plan: the context a plan reads, how a plan says it
 * refuses, and the two small decisions an emitter asks directly.
 *
 * A *plan* — one node's export, decided once and spelled by each language — lives in `plans/`,
 * one file per group of nodes; `plans/profile.ts` states that rule. What stays here is what more
 * than one plan or emitter needs, and nothing node-specific: the comparison table both
 * `tableFilters.ts` read, and the read of a column's dtype that half the table emitters make.
 * Two spellings of a decision with no language in it is how a fix reaches one document and not
 * the other, which is what every file in `plans/` was written against too.
 *
 * **How a plan carries a note** (`docs/export.md` has the rule in full): text both documents share
 * rides as text; text that differs rides as a key, with a complete `Record` per renderer.
 */

import type { GraphNode } from '../core/graph'
import type { NodeDefinition, ParamValues } from '../core/node'
import type { AttributePart, CodaType, TableSchema } from '../core/types'
import { findColumn } from '../core/types'

/**
 * The part of an emit context with no language in it. Both `EmitContext`s satisfy it.
 *
 * A plan declares the members it reads as a `Pick` of this, so a test hands it only those and a
 * plan cannot start reading something else without its signature saying so.
 */
export interface NeutralContext {
  node: GraphNode
  def: NodeDefinition
  params: ParamValues
  wired(portId: string): string
  input(portId: string): string | undefined
  inputType(portId: string): CodaType | undefined
  schema(portId: string): TableSchema | undefined
  attributes(portId: string, part?: AttributePart): TableSchema | undefined
  column(paramId: string): string | undefined
  columns(paramId: string): string[]
}

/**
 * A plan, or why it cannot be written — as the TODO text both documents share.
 *
 * One spelling for every plan that can refuse, so a renderer's first line is always
 * `if (plan.refusal !== undefined) return ctx.todo(plan.refusal)` and never a per-plan field.
 */
export type Refusable<T> = { refusal: string } | ({ refusal?: undefined } & T)

/** A value, or the note written in its place — an empty selection, a chart that draws nothing. */
export type Noted<T> = { note: string } | ({ note?: undefined } & T)

/**
 * Coda's comparison operators, which Python and R happen to spell alike.
 *
 * Shared with each emitter's `tableFilters.ts`, whose `FieldTerm['op']` overlaps `FilterOp` on
 * exactly these six names — two copies is how the Filter node and the Table's header cells come
 * to render the same comparison differently in one document. Shared *only* because the six
 * spellings coincide in both languages: an operator either language spells differently belongs
 * back in that language's emitter, not here with a per-language branch.
 */
export const COMPARISON: Record<string, string> = {
  eq: '==',
  ne: '!=',
  gt: '>',
  ge: '>=',
  lt: '<',
  le: '<=',
}

/** The dtype of a named column on a port, when both are known. */
export function dtypeOf(
  ctx: Pick<NeutralContext, 'schema'>,
  portId: string,
  name: string | undefined,
) {
  return name ? findColumn(ctx.schema(portId), name)?.dtype : undefined
}
