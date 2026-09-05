/**
 * Node registry. Node packs register themselves at import time; the editor reads the
 * registry to build the add-node palette and to resolve types when loading a file.
 */

import type { NodeCategory, NodeDefinition, ParamValues } from './node'
import { findParam } from './node'
import { allInputPorts, allOutputPorts, isPortGroup } from './ports'

const definitions = new Map<string, NodeDefinition>()

export function registerNode<P extends ParamValues>(def: NodeDefinition<P>): NodeDefinition<P> {
  if (definitions.has(def.type)) {
    throw new Error(`Duplicate node type "${def.type}"`)
  }
  /*
   * The `loop: 'begin'` / `loopPlan` pairing, enforced rather than documented.
   *
   * Without it a node declaring one half fails *silently and asymmetrically*: the scheduler
   * falls through to running it once, while `loopsIn` still derives a region for it and the
   * canvas still draws a frame captioned "for each" around nodes that will run exactly once. A
   * loop node that quietly is not one, with the canvas asserting that it is. Thrown at
   * registration for the duplicate-type reason — this is a fact about the node pack, so it
   * should fail the moment the pack is imported rather than the first time somebody runs.
   */
  if ((def.loop === 'begin') !== (def.loopPlan !== undefined)) {
    throw new Error(
      `"${def.type}" declares ${def.loop === 'begin' ? "`loop: 'begin'` without `loopPlan`" : "`loopPlan` without `loop: 'begin'`"}. ` +
        'A loop needs both: the flag is what derives its region, the plan is what says how many passes to make.',
    )
  }
  checkPortGroups(def as unknown as NodeDefinition)
  definitions.set(def.type, def as unknown as NodeDefinition)
  referenceTypes = undefined
  loopTypes = undefined
  return def
}

/**
 * Structural checks on a definition's port groups, thrown at registration.
 *
 * For the reason the `loop`/`loopPlan` pairing above is checked here: every one of these fails
 * *silently* at runtime and produces a node that looks wired. A `repeat` naming a param that
 * does not exist resolves to the group's `min` forever, so the count field the author added is
 * simply inert. A default outside `[min, max]` means a fresh node opens at a different arity
 * than the number shown in its own param field. And two ports that collide at some arity give
 * one card two sockets with one id, where `inbound` keeps whichever edge it saw first and the
 * other silently carries nothing.
 *
 * Expanded at `max` rather than at the default, because a collision that only appears at arity
 * five is still a collision, and it would otherwise ship and be found by a user.
 */
function checkPortGroups(def: NodeDefinition): void {
  for (const side of ['inputs', 'outputs'] as const) {
    const slots = def[side]
    if (!slots) continue
    for (const slot of slots) {
      if (!isPortGroup(slot)) continue
      const where = `"${def.type}" port group "${slot.repeat}" (${side})`
      if (slot.ports.length === 0) throw new Error(`${where} repeats no ports.`)
      const param = findParam(def, slot.repeat)
      if (!param) {
        throw new Error(
          `${where} names no param. The repeat count must be a real \`int\` param, or it is not saved, not undoable and not in the provenance key.`,
        )
      }
      if (param.kind !== 'int') {
        throw new Error(
          `${where} names a "${param.kind}" param; the repeat count must be \`int\`.`,
        )
      }
      /*
       * Both of these silently break invariant 4. `normalizeParams` drops presentational params
       * and params hidden by `visibleIf` from the provenance key — correctly, for colour scales
       * and switched-off branches. A *repeat* count excluded from that key means changing a
       * node's arity does not re-key it: the scheduler finds the cached entry fresh and serves a
       * result that is missing the outputs the new ports were added for, with nothing stale on
       * the canvas to say so. The port set is the one thing a param can change that the cache
       * cannot see any other way.
       */
      if (param.presentational) {
        throw new Error(
          `${where} names a presentational param. A repeat count changes what \`evaluate\` returns — it is excluded from the provenance key, so a changed arity would serve a stale result (invariant 4).`,
        )
      }
      if (param.visibleIf) {
        throw new Error(
          `${where} names a param with \`visibleIf\`. A hidden param is excluded from the provenance key, so hiding the count would freeze the arity a cached result was computed at (invariant 4).`,
        )
      }
      /*
       * The range lives on the param and nowhere else, so the inspector's spinner and the
       * expansion in `core/ports.ts` cannot disagree about how far a group goes. Undeclared, the
       * spinner would run to infinity while `allInputPorts` expanded to one.
       */
      if (typeof param.min !== 'number' || typeof param.max !== 'number') {
        throw new Error(
          `${where} names a param with no \`min\`/\`max\`; that pair is the group's arity.`,
        )
      }
      if (param.min < 1) {
        throw new Error(`${where} has min ${param.min}; a group repeats at least once.`)
      }
      if (param.max < param.min) {
        throw new Error(`${where} has max ${param.max} below min ${param.min}.`)
      }
      if (param.default < param.min || param.default > param.max) {
        throw new Error(
          `${where} has default ${param.default} outside [${param.min}, ${param.max}], so a fresh node would not open at the arity its own field reports.`,
        )
      }
    }
    const seen = new Set<string>()
    for (const port of side === 'inputs' ? allInputPorts(def) : allOutputPorts(def)) {
      if (seen.has(port.id)) {
        throw new Error(
          `"${def.type}" has two ${side} called "${port.id}" at some arity. Port ids must be unique when every group is expanded at its max.`,
        )
      }
      seen.add(port.id)
    }
  }
}

/** Memo for `typesWithReferenceInputs`, dropped whenever the registry gains a type. */
let referenceTypes: Set<string> | undefined

/**
 * The node types that declare a `reference` input.
 *
 * So the graph walks can answer "could this graph contain a reference edge at all?" without
 * touching a single edge. Exactly one type does today, so on every other graph the reference
 * machinery in `topoSort` and `wouldCreateCycle` short-circuits to nothing — and those run twice
 * per keystroke and once per pointer move of a link drag respectively.
 *
 * Memoised because the registry is fixed after module load, and **cleared by `registerNode`**
 * rather than assumed fixed: a test registers types long after this file is imported, and a memo
 * that outlived one of those would answer about a registry that no longer exists.
 */
export function typesWithReferenceInputs(): Set<string> {
  referenceTypes ??= new Set(
    [...definitions.values()]
      .filter((def) => allInputPorts(def).some((port) => port.reference === true))
      .map((def) => def.type),
  )
  return referenceTypes
}

/** Memo for `typesWithLoops`, dropped whenever the registry gains a type. */
let loopTypes: Set<string> | undefined

/**
 * The node types that begin or end a loop — see `NodeDefinition.loop`.
 *
 * `typesWithReferenceInputs`' twin, and for the same measured reason: the scheduler asks "could
 * this graph contain a loop at all?" once per run and the canvas asks it once per edge memo, and
 * on the overwhelming majority of graphs the answer is no. A `Set` lookup per node beats deriving
 * a region, and the loop machinery below it then allocates nothing.
 *
 * Cleared by `registerNode` rather than assumed fixed, because tests register types long after
 * this module is imported — the bug `typesWithReferenceInputs` already had to be pinned against.
 */
export function typesWithLoops(): Set<string> {
  loopTypes ??= new Set(
    [...definitions.values()].filter((def) => def.loop !== undefined).map((def) => def.type),
  )
  return loopTypes
}

export function getNodeDef(type: string): NodeDefinition | undefined {
  return definitions.get(type)
}

/** Throwing variant for code paths where a missing type is a bug, not user input. */
export function requireNodeDef(type: string): NodeDefinition {
  const def = definitions.get(type)
  if (!def) throw new Error(`Unknown node type "${type}"`)
  return def
}

/**
 * Does this type annotate the canvas rather than compute on it? See `NodeDefinition.annotation`.
 *
 * A helper rather than `getNodeDef(t)?.annotation === true` spelled out at each call site,
 * because the answer decides whether a node is evaluated at all — the scheduler, the store's
 * "needs run" and the canvas all have to agree on it, and three copies of an optional-chained
 * comparison is how they stop agreeing. An unregistered type is not an annotation: it is an
 * error the caller already handles.
 */
export function isAnnotation(type: string): boolean {
  return definitions.get(type)?.annotation === true
}

export function allNodeDefs(): NodeDefinition[] {
  return [...definitions.values()]
}

/**
 * Everything a user may add, i.e. minus superseded types.
 *
 * `allNodeDefs` stays complete because lookups and deserialisation need it; this is the list the
 * add-node surfaces show. Separating the two is what lets a retired node keep loading old files
 * without also being offered for new work.
 */
export function listableNodeDefs(): NodeDefinition[] {
  return allNodeDefs().filter((d) => !d.hidden)
}

export function nodeDefsByCategory(): Array<{
  category: NodeCategory
  defs: NodeDefinition[]
}> {
  const order: NodeCategory[] = [
    'dataset',
    'query',
    'transform',
    'analysis',
    'visualisation',
    'utility',
  ]
  const listable = listableNodeDefs()
  return order
    .map((category) => ({
      category,
      defs: listable
        .filter((d) => d.category === category)
        .sort((a, b) => a.label.localeCompare(b.label)),
    }))
    .filter((group) => group.defs.length > 0)
}
