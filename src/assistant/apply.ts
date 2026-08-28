/**
 * Turning a plan into a graph, or refusing to.
 *
 * Headless and pure: in a `CodaGraph`, out a `CodaGraph`. Nothing here touches the store, so
 * the store's job is one `commit` of whatever comes back — which is what makes an assistant
 * edit a single undo step, the same rule `companion.ts` and `autowire.ts` already follow.
 *
 * **All or nothing.** A plan with one bad wire is refused whole and the input graph is handed
 * back untouched. The alternative — commit the good six of seven nodes and report the rest —
 * reads as success and leaves a pipeline that looks built and computes something else, which
 * is the worst outcome available: the user did not write it, so there is nobody to notice the
 * gap. A refusal names every problem at once rather than the first, because the reply is meant
 * to go back to the model as the repair instruction, and one round trip per error is not a
 * conversation anybody wants to have.
 *
 * **Errors refuse; warnings do not.** An unknown node type or a wire the type system rejects
 * is a plan that cannot be applied. An unset column picker or an unwired required input is an
 * ordinary half-built graph, which is exactly what the canvas already shows badges for and
 * frequently the *only* thing a plan can produce — a `Group By` downstream of a Pivot cannot
 * have its column chosen before anything has run, because the pivot publishes no schema until
 * it has (`observesOutputSchema`). Refusing those would refuse most real pipelines.
 */

import { addNodeWithCompanion } from '../core/companion'
import type { CodaGraph, GraphNode } from '../core/graph'
import { addEdge, edgeInto, newId, nodePorts, removeEdges, removeNodes, updateNode } from '../core/graph'
import type { IssueSeverity } from '../core/inference'
import { checkConnection, inferGraph, nodeTypes } from '../core/inference'
import type { NodeDefinition, ParamDef, ParamValue, ParamValues } from '../core/node'
import { configurableParams, defaultParams, findParam, validateParamValue } from '../core/node'
import { getNodeDef } from '../core/registry'
import { COL_WIDTH, GRID_ORIGIN, ROW_HEIGHT, boundsOf } from '../layout/place'
import type { AssistantPlan, PortRef } from './planShape'
import { isEmptyPlan, plannableParams } from './planShape'

/** Clearance between what was already on the canvas and the block a plan adds. */
const BLOCK_GAP = 96

/**
 * Something the edit left for the user.
 *
 * Carries the severity rather than flattening both into prose, because they are not the same
 * news: a `warning` is a picker somebody should look at, an `error` is a node that will not
 * run until it is fixed. A panel wants to sort by that, and a repair round trip wants to send
 * back only the blocking ones.
 */
export interface ApplyWarning {
  nodeId: string
  /** The card's header, as the user sees it. */
  label: string
  severity: IssueSeverity
  message: string
}

export interface ApplyOk {
  ok: true
  graph: CodaGraph
  /**
   * Plan ref → the graph id it was given, so a caller can select or focus what it made.
   *
   * Only the nodes the plan named. A companion that came along with a dataset node has an id
   * and no ref, because the plan never asked for it.
   */
  created: Record<string, string>
  /**
   * Edit-time issues on the nodes this plan touched, after the edit. Not a reason to refuse
   * — see the header — but the thing to say out loud, since an unset column picker is work
   * left for the user and nothing else will point at it.
   */
  warnings: ApplyWarning[]
}

export interface ApplyFail {
  ok: false
  errors: string[]
}

export type ApplyResult = ApplyOk | ApplyFail

/** A plan ref or an existing node id, resolved to the id it names in the graph being built. */
type Resolver = (ref: string) => string | undefined

export function applyPlan(graph: CodaGraph, plan: AssistantPlan): ApplyResult {
  /*
   * A plan that asks for nothing hands the *same* graph object back, not an equal one.
   *
   * "I cannot do that" is a real and common answer — the model returns an empty plan whose
   * summary says so — and every graph operation here rebuilds the object, so without this an
   * empty plan would produce a distinct-but-identical graph. The store commits on identity, so
   * that would push an undo step for an edit nobody made.
   */
  if (isEmptyPlan(plan)) return { ok: true, graph, created: {}, warnings: [] }

  const errors: string[] = []
  const existingIds = new Set(graph.nodes.map((n) => n.id))

  /*
   * Refs that could not be created. Everything downstream of one is skipped in silence: a
   * plan naming a node type that does not exist would otherwise report the bad type once and
   * then every wire touching it, burying the one line that says what to fix. Same distinction
   * the notebook exporter draws between "unwired" and "blocked".
   */
  const failedRefs = new Set<string>()
  const created: Record<string, string> = {}
  const pending: Array<{ ref: string; node: GraphNode }> = []

  // --- 1. the nodes to add -------------------------------------------------
  for (const [index, planned] of plan.add.entries()) {
    const where = `add[${index}]`
    if (!planned.ref) {
      errors.push(`${where}: every added node needs a \`ref\`.`)
      continue
    }
    // `created` and `failedRefs` between them already hold every ref seen so far.
    if (planned.ref in created || failedRefs.has(planned.ref)) {
      errors.push(`${where}: ref "${planned.ref}" is used twice.`)
      failedRefs.add(planned.ref)
      continue
    }

    /*
     * A ref that is also an id on the canvas would make every later mention ambiguous, and the
     * ambiguity is not resolvable from the plan — "wire n3 to the chart" could mean either
     * node. Refusing is the only answer that cannot silently pick the wrong one.
     */
    if (existingIds.has(planned.ref)) {
      errors.push(
        `${where}: ref "${planned.ref}" is already the id of a node on the canvas — pick another.`,
      )
      failedRefs.add(planned.ref)
      continue
    }

    const def = getNodeDef(planned.type)
    if (!def) {
      errors.push(`${where}: there is no node type "${planned.type}".`)
      failedRefs.add(planned.ref)
      continue
    }
    if (def.hidden) {
      errors.push(
        `${where}: "${planned.type}" is superseded and not offered for new work — it is not in the catalogue.`,
      )
      failedRefs.add(planned.ref)
      continue
    }

    const named = Object.keys(planned.params ?? {}).map((id) => ({ id, at: `${where}.params` }))
    const params = { ...defaultParams(def), ...planned.params }
    coerceNamed(def, params, named)
    const problems = checkParams(def, params, named)
    if (problems.length) {
      errors.push(...problems)
      failedRefs.add(planned.ref)
      continue
    }

    const node: GraphNode = {
      id: newId('n'),
      type: planned.type,
      // Replaced below, once the block's shape is known. See `positionsFor`.
      position: { ...GRID_ORIGIN },
      params,
      ...(planned.title ? { title: planned.title } : {}),
    }
    pending.push({ ref: planned.ref, node })
    created[planned.ref] = node.id
  }

  const resolve: Resolver = (ref) => created[ref] ?? (existingIds.has(ref) ? ref : undefined)

  // --- 2. removals ---------------------------------------------------------
  const removed = new Set<string>()
  for (const [index, id] of plan.remove.entries()) {
    if (!existingIds.has(id)) {
      errors.push(`remove[${index}]: there is no node "${id}" on the canvas.`)
      continue
    }
    removed.add(id)
  }

  // --- 3. build the next graph --------------------------------------------
  let next = removeNodes(graph, [...removed])

  /*
   * Placed before they are added, not moved afterwards, so that `addNodeWithCompanion` can do
   * its own placement relative to a host that is already where it belongs — a companion sits
   * at `host.position + offset`, so adding first and moving the host second would leave a
   * dataset's credit card behind at the origin.
   */
  const positions = positionsFor(pending, plan, created, boundsOf(next.nodes))
  for (const { node } of pending) {
    /*
     * The same composition the store and the starters use, rather than the bare `addNode`
     * underneath it. A published dataset node arrives with the Description card its publisher
     * asks to be cited by, and a plan is an *add* — so an assistant that skipped this would be
     * the one route into the editor that silently drops the attribution.
     *
     * **`autoWireDataset` is deliberately not applied**, which is the one place this departs
     * from the store's `addNode`. That helper guesses a Dataset wire when exactly one dataset is
     * on the canvas — useful when a human drops a node and has to wire it next, and wrong here,
     * because a plan states every wire it wants. Adding one it did not ask for would put an edge
     * in the graph that appears in no `connect` entry and in no summary.
     */
    next = addNodeWithCompanion(next, {
      ...node,
      position: positions.get(node.id) ?? node.position,
    })
  }

  // --- 4. param changes ----------------------------------------------------
  /*
   * Grouped by node before anything is checked, because whether a param applies can depend on
   * another param in the same plan: `core.stack`'s labels are `visibleIf` its source column is
   * named. Validating in arrival order would refuse a plan that set the label before the
   * column and accept the same plan written the other way round.
   */
  for (const [id, changes] of groupChanges(
    plan.setParams,
    resolve,
    failedRefs,
    removed,
    errors,
  )) {
    const node = next.nodes.find((n) => n.id === id)
    const def = node && getNodeDef(node.type)
    if (!node || !def) continue

    const named = changes.map((c) => ({ id: c.change.param, at: `setParams[${c.index}]` }))
    const merged: ParamValues = { ...node.params }
    for (const { change } of changes) merged[change.param] = change.value
    coerceNamed(def, merged, named)

    const problems = checkParams(def, merged, named)
    if (problems.length) {
      errors.push(...problems)
      continue
    }
    next = updateNode(next, id, { params: merged })
  }

  // --- 5. wires to cut -----------------------------------------------------
  for (const [index, port] of plan.disconnect.entries()) {
    const where = `disconnect[${index}]`
    if (failedRefs.has(port.node)) continue
    const found = lookup(next, resolve, port.node, where)
    if (typeof found === 'string') {
      errors.push(found)
      continue
    }
    const edge = edgeInto(next, found.node.id, port.port)
    /*
     * A missing wire is not an error. A plan that says "unplug the Filter" when nothing is
     * plugged in has described the state it wants and that state already holds; refusing would
     * send the model back to repair a wire nobody has.
     */
    if (edge) next = removeEdges(next, [edge.id])
  }

  // --- 6. wires to make ----------------------------------------------------
  for (const [index, wire] of plan.connect.entries()) {
    const where = `connect[${index}]`
    if (failedRefs.has(wire.from.node) || failedRefs.has(wire.to.node)) continue

    const from = resolvePort(next, resolve, wire.from, 'output', `${where}.from`)
    const to = resolvePort(next, resolve, wire.to, 'input', `${where}.to`)
    if (typeof from === 'string') errors.push(from)
    if (typeof to === 'string') errors.push(to)
    if (typeof from === 'string' || typeof to === 'string') continue

    /*
     * Checked against the graph as it stands *now*, one wire at a time, because a port's type
     * depends on what is already feeding the node — `Filter`'s output is its input's type, so
     * a chain only validates in order. This is the same call the canvas makes on a drag, so a
     * plan is refused in the same words a person would have been.
     */
    const check = checkConnection(next, inferGraph(next), from, to)
    if (!check.ok) {
      errors.push(
        `${where}: ${describePort(next, wire.from, from)} → ${describePort(next, wire.to, to)} — ${check.reason}.`,
      )
      continue
    }
    next = addEdge(next, {
      source: from.nodeId,
      sourceHandle: from.portId,
      target: to.nodeId,
      targetHandle: to.portId,
    })
  }

  if (errors.length) return { ok: false, errors }

  // --- 7. what is left for the user ---------------------------------------
  const touched = new Set(pending.map((p) => p.node.id))
  const mark = (ref: string): void => {
    const id = resolve(ref)
    if (id) touched.add(id)
  }
  for (const change of plan.setParams) mark(change.node)
  for (const wire of plan.connect) {
    mark(wire.from.node)
    mark(wire.to.node)
  }

  return { ok: true, graph: next, created, warnings: collectWarnings(next, touched) }
}

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

/**
 * `"1"` where the param wants `1`, and `"true"` where it wants `true`.
 *
 * **The single failure mode a live model was actually refused for.** Across thirty questions
 * against `qwen3.8:latest` exactly one plan was rejected, and this was all of it: `hops` and
 * `minWeight` as `"1"`, `descending` and `sortBars` as `"true"` — five params over three nodes.
 * The repair round was handed `"hops" wants a whole number, got a string` and sent a string
 * again, which is what makes this Coda's to fix rather than the model's: the plan schema offers
 * `anyOf: [string, number, boolean, …]` and a small model reaches for the first branch, then
 * cannot be talked out of it.
 *
 * **It has to run in both directions, and the second one was found the hard way.** Adding the
 * rule to the prompt that a number param takes `3` and not `"3"` bought a *new* refusal on the
 * next run — `"pageSize" wants one of its options, got a number` — because `out.table`'s
 * `pageSize` is an `enum` whose options are `'25' | '50' | '100' | '500'`, strings that happen
 * to look like numbers. Told to prefer real numbers, the model obliged where it should not
 * have. Whether the prompt caused that or it was always possible cannot be settled at one
 * occurrence each, and it does not need to be: a conversion that only went one way was going
 * to leave the other open whichever way the prompt leaned.
 *
 * **The bar is that something else still gets to refuse.** A number keeps its finite/integer
 * check and its `min`/`max`; a boolean converts only from the two words that can mean it; an
 * `enum` and a `multiEnum` are checked against their options. So a conversion here can turn a
 * spelling into a value but cannot turn a *mistake* into one — `pageSize` as `37` still fails,
 * naming what is on offer.
 *
 * That bar is why `string` and `column` are left out, though they are the easiest conversions
 * of the lot. Nothing downstream checks them: a `string` param takes any text, so writing `50`
 * into `typePattern` — a model putting a limit in the wrong field — would become the pattern
 * `"50"` and apply cleanly. Refusing it is the only thing that ever says so. `assistant.test.ts`
 * has asserted that refusal since before this function existed, and it was right to.
 *
 * Anything that does not convert is returned untouched, so `validateParamValue` still gets to
 * say what is wrong in its own words. `"1.5"` for an `int` converts to `1.5` and is then refused
 * as a non-integer, which is the honest answer; rounding it would be inventing a value.
 *
 * Here rather than beside `validateParamValue`, deliberately. That function is the check a
 * `.coda.json` from another build and a future non-browser executor are *meant* to go through
 * — `deserializeGraph` does not call it today, which is a gap rather than a reason — and a
 * saved file holding `"1"` for a number is corruption worth hearing about, not a spelling to
 * absorb. Teaching it to convert would make `"1"` a second legal spelling of a number
 * everywhere, which is what invariant 8 means by a shim. This is about untrusted text from a
 * model, which is this module's whole subject.
 */
function coerceParamValue(param: ParamDef, value: ParamValue): ParamValue {
  switch (param.kind) {
    case 'int':
    case 'number': {
      if (typeof value !== 'string' || !value.trim()) return value
      const parsed = Number(value.trim())
      return Number.isFinite(parsed) ? parsed : value
    }
    case 'boolean': {
      if (typeof value !== 'string') return value
      if (/^true$/i.test(value.trim())) return true
      if (/^false$/i.test(value.trim())) return false
      return value
    }
    /*
     * The other direction. An enum option is a string by construction, so a number arriving in
     * one can only be its own spelling — `50` for `pageSize` means the option `"50"`. Whether
     * it is an option at all stays `validateParamValue`'s to say, which is what keeps this a
     * conversion rather than an acceptance.
     */
    case 'enum':
      return typeof value === 'number' || typeof value === 'boolean' ? String(value) : value
    case 'multiEnum':
      return Array.isArray(value) ? value.map((entry) => String(entry)) : value
    /*
     * Left out on purpose, per the bar above: nothing downstream checks any of these, so a
     * conversion here could not be refused if it were wrong. Spelled out rather than left to a
     * `default`, because `validateParamValue` mirrors this same union and says why — an arm
     * that assigns to `never` is what makes a new param kind fail to compile instead of falling
     * silently through a switch nobody remembered.
     */
    case 'string':
    case 'column':
    case 'columns':
    case 'ids':
      return value
    default: {
      const unhandled: never = param
      return unhandled
    }
  }
}

/**
 * Convert the named params in place, into the kinds their definitions declare.
 *
 * Only the ones the plan *named*: a default is already the right type, and touching one would
 * be this function having an opinion about the node definition.
 *
 * In place, and both halves of that are deliberate. The callers each hand over an object they
 * spread into existence a line earlier and nobody else holds, so copying would guard against no
 * aliasing that exists — and the copy-on-write this replaced could not even skip reliably,
 * since a `multiEnum` returns a fresh array whether or not an entry changed. More to the point,
 * mutating is what removes the trap: the object the caller already has *is* the coerced one, so
 * checking one value and storing another stops being something a comment has to ask for.
 */
function coerceNamed(
  def: NodeDefinition,
  params: ParamValues,
  named: ReadonlyArray<{ id: string; at: string }>,
): void {
  for (const { id } of named) {
    const param = findParam(def, id)
    if (param) params[id] = coerceParamValue(param, params[id]!)
  }
}

/**
 * Check the params a plan actually named, against the node's finished values.
 *
 * The finished values matter twice over: `configurableParams` asks whether a param applies at
 * all, which depends on the *other* params, and a plan routinely sets a mode and the params
 * that mode reveals in the same breath.
 *
 * Each named param carries its own label, because they arrive from two shapes: all at once on
 * one `add` entry, or one per numbered `setParams` entry. Two parallel arrays coupled by index
 * said the same thing and needed a fallback for the case the compiler could not rule out.
 */
function checkParams(
  def: NodeDefinition,
  params: ParamValues,
  named: ReadonlyArray<{ id: string; at: string }>,
): string[] {
  const problems: string[] = []
  const applicable = new Set(configurableParams(def, params).map((p) => p.id))

  for (const { id: paramId, at } of named) {
    const param = findParam(def, paramId)

    if (!param) {
      const known = plannableParams(def).map((p) => p.id)
      problems.push(
        `${at}: "${def.type}" has no param "${paramId}". It has: ${known.join(', ') || 'none'}.`,
      )
      continue
    }
    /*
     * `internal` marks machinery a widget writes — a refresh nonce, a pager's page index. They
     * are real params and they are in the saved file, but nothing *advertises* them, and a plan
     * that set one would be bumping a cache key or turning a page as though it were a setting.
     */
    if (param.internal) {
      problems.push(`${at}: "${paramId}" is internal to the node and cannot be set by a plan.`)
      continue
    }
    /*
     * A param the node's own values have switched off is not a param it has right now, and
     * `normalizeParams` leaves it out of the provenance key — so setting one changes nothing,
     * marks nothing stale and would be reported as applied. Silent success is the outcome this
     * whole module is arranged to avoid.
     */
    if (!applicable.has(paramId)) {
      problems.push(
        `${at}: "${paramId}" does not apply with the node's other settings, so setting it would do nothing.`,
      )
      continue
    }

    const problem = validateParamValue(param, params[paramId]!)
    if (problem) problems.push(`${at}: ${problem}`)
  }
  return problems
}

/** Param changes per node id, with the refs that could not be resolved already reported. */
function groupChanges(
  changes: AssistantPlan['setParams'],
  resolve: Resolver,
  failedRefs: ReadonlySet<string>,
  removed: ReadonlySet<string>,
  errors: string[],
): Map<string, Array<{ index: number; change: AssistantPlan['setParams'][number] }>> {
  const grouped = new Map<
    string,
    Array<{ index: number; change: AssistantPlan['setParams'][number] }>
  >()

  for (const [index, change] of changes.entries()) {
    const where = `setParams[${index}]`
    if (failedRefs.has(change.node)) continue

    const id = resolve(change.node)
    if (!id) {
      errors.push(`${where}: there is no node "${change.node}".`)
      continue
    }
    if (removed.has(id)) {
      errors.push(`${where}: this plan removes "${change.node}", so its params cannot be set.`)
      continue
    }
    const list = grouped.get(id)
    if (list) list.push({ index, change })
    else grouped.set(id, [{ index, change }])
  }
  return grouped
}

// ---------------------------------------------------------------------------
// Nodes and ports
// ---------------------------------------------------------------------------

/** The node a ref names and its definition, or the sentence explaining why there isn't one. */
function lookup(
  graph: CodaGraph,
  resolve: Resolver,
  ref: string,
  where: string,
): { node: GraphNode; def: NodeDefinition } | string {
  const id = resolve(ref)
  const node = id ? graph.nodes.find((n) => n.id === id) : undefined
  if (!node) return `${where}: there is no node "${ref}".`
  const def = getNodeDef(node.type)
  if (!def) return `${where}: node "${ref}" has an unknown type "${node.type}".`
  return { node, def }
}

/** Resolved endpoint, or the sentence explaining why there isn't one. */
function resolvePort(
  graph: CodaGraph,
  resolve: Resolver,
  ref: PortRef,
  side: 'input' | 'output',
  where: string,
): { nodeId: string; portId: string } | string {
  const found = lookup(graph, resolve, ref.node, where)
  if (typeof found === 'string') return found

  const ports = nodePorts(found.node, side)
  if (!ports.some((p) => p.id === ref.port)) {
    const names = ports.map((p) => p.id)
    return (
      `${where}: "${found.def.label}" has no ${side} "${ref.port}". ` +
      (names.length ? `It has: ${names.join(', ')}.` : 'It has none.')
    )
  }
  return { nodeId: found.node.id, portId: ref.port }
}

/** `Find Neurons ▸ neurons`, in the idiom the edge menu's header already uses. */
function describePort(
  graph: CodaGraph,
  ref: PortRef,
  resolved: { nodeId: string; portId: string },
): string {
  const node = graph.nodes.find((n) => n.id === resolved.nodeId)
  const label = node?.title ?? getNodeDef(node?.type ?? '')?.label ?? ref.node
  return `${label} ▸ ${ref.port}`
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/**
 * Lay the new nodes out in topological columns, to the right of whatever was already there.
 *
 * Deliberately a grid rather than an ELK pass. ELK is async and lazily loaded, so an applier
 * that used it could not stay synchronous or headless; and this runs *before* the graph is
 * committed, where waiting on a worker would put the whole edit behind a chunk download. The
 * arrangement is only a starting point either way — Arrange is one button and produces a
 * better one.
 *
 * Existing nodes never move, on the rule `dodge` already states: a position somebody chose
 * outranks one that was computed. So the block goes clear to the right, which is also where a
 * plan's nodes usually belong, since the thing they extend is normally the rightmost.
 */
function positionsFor(
  pending: ReadonlyArray<{ ref: string; node: GraphNode }>,
  plan: AssistantPlan,
  created: Readonly<Record<string, string>>,
  bounds: { x: number; y: number; width: number; height: number } | undefined,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>()
  if (pending.length === 0) return positions

  const origin = bounds
    ? { x: bounds.x + bounds.width + BLOCK_GAP, y: bounds.y }
    : { ...GRID_ORIGIN }

  /*
   * Depth *within the plan's own nodes*, not within the whole graph. Measuring against the
   * whole graph would push a node appended to a five-deep chain out to a sixth column, so a
   * one-node plan would land a screen away from the node it was wired to.
   *
   * Read off the plan rather than the graph's edges, because this runs before the wires are
   * made — which is also why the cycle guard below is load-bearing rather than defensive: the
   * plan has not been checked for cycles yet, and a cyclic one must be refused, not hang.
   */
  const feeders = new Map<string, string[]>()
  for (const wire of plan.connect) {
    if (!(wire.from.node in created) || !(wire.to.node in created)) continue
    const list = feeders.get(wire.to.node)
    if (list) list.push(wire.from.node)
    else feeders.set(wire.to.node, [wire.from.node])
  }

  const depth = new Map<string, number>()
  const visiting = new Set<string>()
  const depthOf = (ref: string): number => {
    const known = depth.get(ref)
    if (known !== undefined) return known
    if (visiting.has(ref)) return 0
    visiting.add(ref)
    let best = 0
    for (const feeder of feeders.get(ref) ?? []) best = Math.max(best, depthOf(feeder) + 1)
    visiting.delete(ref)
    depth.set(ref, best)
    return best
  }

  const rows = new Map<number, number>()
  for (const { ref, node } of pending) {
    const column = depthOf(ref)
    const row = rows.get(column) ?? 0
    rows.set(column, row + 1)
    positions.set(node.id, {
      x: origin.x + column * COL_WIDTH,
      y: origin.y + row * ROW_HEIGHT,
    })
  }
  return positions
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

/**
 * Edit-time issues on the nodes this plan touched.
 *
 * Scoped to what was touched on purpose: a graph that already had an unset picker three nodes
 * away did not acquire it here, and reporting it alongside the edit reads as the assistant
 * having broken something.
 */
function collectWarnings(graph: CodaGraph, touched: ReadonlySet<string>): ApplyWarning[] {
  const inference = inferGraph(graph)
  const warnings: ApplyWarning[] = []
  for (const node of graph.nodes) {
    if (!touched.has(node.id)) continue
    const label = node.title ?? getNodeDef(node.type)?.label ?? node.type
    for (const issue of nodeTypes(inference, node.id).issues) {
      warnings.push({
        nodeId: node.id,
        label,
        severity: issue.severity,
        message: issue.message,
      })
    }
  }
  return warnings
}
