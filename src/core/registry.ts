/**
 * Node registry. Node packs register themselves at import time; the editor reads the
 * registry to build the add-node palette and to resolve types when loading a file.
 */

import type { NodeCategory, NodeDefinition, ParamValues } from './node'

const definitions = new Map<string, NodeDefinition>()

export function registerNode<P extends ParamValues>(def: NodeDefinition<P>): NodeDefinition<P> {
  if (definitions.has(def.type)) {
    throw new Error(`Duplicate node type "${def.type}"`)
  }
  definitions.set(def.type, def as unknown as NodeDefinition)
  referenceTypes = undefined
  return def
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
      .filter((def) => (def.inputs ?? []).some((port) => port.reference === true))
      .map((def) => def.type),
  )
  return referenceTypes
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
