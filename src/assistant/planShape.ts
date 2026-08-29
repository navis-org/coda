/**
 * What the assistant is allowed to say, as data — the shape alone.
 *
 * A plan is a *description of an edit*, not a sequence of tool calls, and that is the load-
 * bearing choice in this whole module. Tool calls would put a half-built graph on the canvas
 * — a node here, a wire there, one undo step each — and would be validated only as each one
 * landed, so a plan that turns out to be wrong on its sixth wire has already changed five
 * things. A plan is checked whole and applied in one `commit`, so the canvas only ever holds
 * a graph the type system already accepted, and ⌘Z takes the entire edit back.
 *
 * The shape is `examples/index.ts`'s `place`/`link` grown a delete and a rewire: refs rather
 * than ids, ports named rather than positional, and no coordinates.
 */

import type { NodeDefinition, ParamDef, ParamValue } from '../core/node'

/**
 * The params a plan may name.
 *
 * `internal` marks machinery a widget writes — a refresh nonce, a pager's page index — which
 * `applyPlan` refuses and the catalogue therefore must not advertise, or the model spends a
 * round trip on a contradiction between two files. Both of them read this, so there is one
 * answer rather than two filters that agree today.
 *
 * Deliberately *not* `configurableParams`: that also subtracts the params the node's current
 * values have switched off, which is the right question when validating a finished node and the
 * wrong one when describing a type. A plan has to be able to turn a mode on and set what the
 * mode reveals, so the catalogue lists both.
 */
export function plannableParams(def: NodeDefinition): ParamDef[] {
  return (def.params ?? []).filter((p) => !p.internal)
}

/** One end of a wire. `node` is a plan `ref` or an existing graph node id. */
export interface PortRef {
  node: string
  port: string
}

export interface PlannedNode {
  /**
   * Plan-local handle, not a graph id. The applier mints the real id, which is what keeps a
   * model from having to invent something collision-free — and what makes a plan re-readable
   * afterwards, since `f1` says more than `n4k_x82p`.
   */
  ref: string
  /** Registered, listable node type, e.g. `core.filterTable`. */
  type: string
  /**
   * Overrides on top of the definition's defaults. Everything unset stays default.
   *
   * A map here and a list of `{param, value}` pairs on the wire — see `planJsonSchema`, which
   * cannot express a map. `parsePlan` is the seam that converts, and it takes either form.
   */
  params?: Record<string, ParamValue>
  /** Header override, when the type's own label would not say which one this is. */
  title?: string
}

export interface PlannedParam {
  /** A plan ref or an existing node id. */
  node: string
  param: string
  value: ParamValue
}

export interface AssistantPlan {
  /** One sentence in the user's terms. Becomes the undo label and the panel's summary. */
  summary: string
  add: PlannedNode[]
  /** Existing node ids to delete. Their wires go with them. */
  remove: string[]
  setParams: PlannedParam[]
  /** Wires to make. An input port already occupied is re-pointed, matching `addEdge`. */
  connect: Array<{ from: PortRef; to: PortRef }>
  /**
   * Wires to cut, named by the *input* end. Input ports take a single connection, so one
   * `{node, port}` names exactly one wire and there is nothing to disambiguate.
   */
  disconnect: PortRef[]
}

/** A plan that asks for nothing, to spread over. */
export function emptyPlan(): AssistantPlan {
  return { summary: '', add: [], remove: [], setParams: [], connect: [], disconnect: [] }
}

/** Does this plan ask for anything at all? */
export function isEmptyPlan(plan: AssistantPlan): boolean {
  return (
    plan.add.length === 0 &&
    plan.remove.length === 0 &&
    plan.setParams.length === 0 &&
    plan.connect.length === 0 &&
    plan.disconnect.length === 0
  )
}

/**
 * Params the plan sets, however they were spelled — inline on an added node, or as a
 * `setParams` entry. Both are one edit to the user, and a tally that counted only the second
 * reports "0 settings" for a plan that configured six.
 */
export function countPlanParams(plan: AssistantPlan): number {
  const inline = plan.add.reduce((n, node) => n + Object.keys(node.params ?? {}).length, 0)
  return inline + plan.setParams.length
}
